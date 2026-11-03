"""Verify fixtures remain inert and positive/negative examples stay distinct."""

import ast
from pathlib import Path
import unittest

from security_fixtures import cases


class FixtureSafetyTests(unittest.TestCase):
    def test_fixture_source_has_no_real_side_effect_apis(self):
        source = Path(cases.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                self.fail("Fixture must not import real system or database clients")
            if isinstance(node, ast.ImportFrom):
                self.assertEqual(node.module, "html")
                self.assertEqual([name.name for name in node.names], ["escape"])
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertIn(node.func.id, {"InMemorySinks", "fixture_input", "allow_redirect", "clean_log"})
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertIsInstance(node.func.value, ast.Name)
                self.assertEqual(node.func.value.id, "fixture_sink")
                self.assertIn(node.func.attr, {"run", "redirect", "log", "deserialize", "template", "digest", "connection"})

    def test_hashing_only_describes_algorithm(self):
        self.assertEqual(cases.digest_unsafe("fixture")["algorithm"], "md5")
        self.assertEqual(cases.digest_safe("fixture")["algorithm"], "sha256")

    def test_tls_does_not_open_a_connection(self):
        self.assertEqual(cases.tls_unsafe()["protocol"], "TLSv1")
        self.assertEqual(cases.tls_safe()["protocol"], "TLSv1_2")

    def test_command_is_only_an_in_memory_description(self):
        value = "report.txt; echo fixture-only"
        self.assertTrue(cases.command_unsafe(value)["shell"])
        safe = cases.command_safe(value)
        self.assertFalse(safe["shell"])
        self.assertEqual(safe["command"], ["fixture-viewer", "--", value])

    def test_log_does_not_write_and_safe_control_removes_input(self):
        value = "fixture\nforged-event"
        self.assertIn(value, cases.log_unsafe(value)["message"])
        self.assertNotIn(value, cases.log_safe(value)["message"])

    def test_deserialization_only_describes_format(self):
        self.assertEqual(cases.deserialize_unsafe("fixture")["format"], "pickle")
        self.assertEqual(cases.deserialize_safe("fixture")["format"], "json")

    def test_template_separates_source_from_data(self):
        value = "{{fixture}}"
        self.assertIn(value, cases.template_unsafe(value)["source"])
        self.assertNotIn(value, cases.template_safe(value)["source"])
        self.assertEqual(cases.template_safe(value)["parameters"], {"name": value})

    def test_redirect_never_sends_an_http_response(self):
        value = "https://outside.example/fixture"
        self.assertEqual(cases.redirect_unsafe(value)["target"], value)
        self.assertEqual(cases.redirect_safe(value)["target"], "/dashboard")
        self.assertEqual(cases.redirect_safe("/account")["target"], "/account")


if __name__ == "__main__":
    unittest.main()
