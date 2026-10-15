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
                self.assertIn(node.func.id, {"InMemorySinks", "fixture_input", "allow_filename", "allow_redirect", "escape"})
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertIsInstance(node.func.value, ast.Name)
                self.assertEqual(node.func.value.id, "fixture_sink")
                self.assertIn(node.func.attr, {"execute", "run", "read", "render", "redirect"})

    def test_sql_uses_parameters_in_safe_control(self):
        value = "fixture' OR '1'='1"
        self.assertIn(value, cases.sql_unsafe(value)["query"])
        safe = cases.sql_safe(value)
        self.assertNotIn(value, safe["query"])
        self.assertEqual(safe["parameters"], (value,))

    def test_command_is_only_an_in_memory_description(self):
        value = "report.txt; echo fixture-only"
        self.assertTrue(cases.command_unsafe(value)["shell"])
        safe = cases.command_safe(value)
        self.assertFalse(safe["shell"])
        self.assertEqual(safe["command"], ["fixture-viewer", "--", value])

    def test_path_never_opens_a_file(self):
        value = "../outside-fixture.txt"
        self.assertIn("..", cases.path_unsafe(value)["path"])
        self.assertEqual(cases.path_safe(value)["path"], "/virtual-fixtures/report.txt")
        self.assertEqual(cases.path_safe("summary.json")["path"], "/virtual-fixtures/summary.json")

    def test_html_is_returned_as_text_and_safe_control_escapes_it(self):
        value = "<b>fixture-only</b>"
        self.assertIn(value, cases.html_unsafe(value)["markup"])
        self.assertEqual(cases.html_safe(value)["markup"], "<p>&lt;b&gt;fixture-only&lt;/b&gt;</p>")

    def test_redirect_never_sends_an_http_response(self):
        value = "https://outside.example/fixture"
        self.assertEqual(cases.redirect_unsafe(value)["target"], value)
        self.assertEqual(cases.redirect_safe(value)["target"], "/dashboard")
        self.assertEqual(cases.redirect_safe("/account")["target"], "/account")


if __name__ == "__main__":
    unittest.main()
