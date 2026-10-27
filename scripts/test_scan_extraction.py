import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from scripts.extract_scan_source import extract_source


class ExtractionTests(unittest.TestCase):
    def make_archive(self, directory, members):
        archive = Path(directory) / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for name, data, kind in members:
                entry = tarfile.TarInfo(name)
                if kind == "link":
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = "../../outside.py"
                    bundle.addfile(entry)
                else:
                    entry.size = len(data)
                    bundle.addfile(entry, io.BytesIO(data))
        return archive

    def test_copies_source_without_executing_it_and_excludes_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.make_archive(directory, [("repo/src/file.py", b"raise RuntimeError('must not execute')", "file"), ("repo/node_modules/package/index.js", b"ignored", "file")])
            target = Path(directory) / "out"
            self.assertEqual(extract_source(archive, target), 1)
            self.assertIn("must not execute", (target / "src/file.py").read_text())
            self.assertFalse((target / "node_modules").exists())

    def test_rejects_traversal_and_windows_paths(self):
        for name in ["repo/../../outside.py", "/absolute/file.py", "repo/C:/outside.py", "repo/..\\outside.py"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                archive = self.make_archive(directory, [(name, b"invalid", "file")])
                with self.assertRaises(ValueError):
                    extract_source(archive, Path(directory) / "out")

    def test_rejects_links(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.make_archive(directory, [("repo/src/file.py", b"", "link")])
            with self.assertRaises(ValueError):
                extract_source(archive, Path(directory) / "out")

    def test_rejects_duplicate_case_insensitive_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.make_archive(directory, [("repo/File.py", b"a", "file"), ("repo/file.py", b"b", "file")])
            with self.assertRaises(ValueError):
                extract_source(archive, Path(directory) / "out")

    def test_rejects_oversized_source_and_empty_scan(self):
        for members in [[("repo/large.py", b"x" * (1024 * 1024 + 1), "file")], [("repo/README.md", b"documentation", "file")]]:
            with tempfile.TemporaryDirectory() as directory:
                archive = self.make_archive(directory, members)
                with self.assertRaises(ValueError):
                    extract_source(archive, Path(directory) / "out")


if __name__ == "__main__":
    unittest.main()
