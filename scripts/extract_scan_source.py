"""Copy bounded regular source files from a GitHub tarball without executing them."""

import json
from pathlib import Path, PurePosixPath
import sys
import tarfile

EXTENSIONS = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"}
EXCLUDED = {".git", ".tools", ".next", "node_modules", "vendor", "venv", ".venv", "__pycache__", "dist", "build", "coverage"}


def extract_source(archive, destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    total = 0
    entries = 0
    copied = 0
    root = None
    seen = set()
    with tarfile.open(archive, "r|gz") as bundle:
        for member in bundle:
            entries += 1
            if entries > 15000:
                raise ValueError("Too many archive entries")
            parts = PurePosixPath(member.name).parts
            if not parts or member.name.startswith("/") or "\\" in member.name or any(part in {"..", "."} or ":" in part for part in parts):
                raise ValueError("Unsafe archive path")
            root = root or parts[0]
            if parts[0] != root:
                raise ValueError("Archive must have one repository root")
            if member.issym() or member.islnk() or member.isdev():
                raise ValueError("Archive links and devices are not accepted")
            if not member.isfile():
                continue
            total += member.size
            if total > 100 * 1024 * 1024:
                raise ValueError("Archive exceeds expanded size limit")
            relative = Path(*parts[1:])
            if not parts[1:] or any(part in EXCLUDED for part in parts[1:-1]) or relative.suffix.lower() not in EXTENSIONS:
                continue
            if member.size > 1024 * 1024 or copied >= 3000:
                raise ValueError("Source exceeds scan limits")
            target = (destination / relative).resolve()
            if not target.is_relative_to(destination) or target == destination:
                raise ValueError("Source escapes destination")
            key = str(target).casefold()
            if key in seen:
                raise ValueError("Duplicate source path")
            seen.add(key)
            target.parent.mkdir(parents=True, exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                raise ValueError("Missing archive file data")
            data = source.read(1024 * 1024 + 1)
            if len(data) != member.size:
                raise ValueError("Invalid source size")
            target.write_bytes(data)
            copied += 1
    if not copied:
        raise ValueError("No supported source files")
    return copied


if __name__ == "__main__":
    try:
        print(json.dumps({"files": extract_source(sys.argv[1], sys.argv[2])}))
    except (ValueError, OSError, tarfile.TarError):
        print("Archive cannot be safely scanned", file=sys.stderr)
        sys.exit(1)
