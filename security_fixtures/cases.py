"""Intentional security patterns with pure, in-memory sinks.

There are no real SQL, shell, filesystem, network, or HTTP operations here.
Importing this module creates only functions and a pure in-memory sink. Each
case returns a description of an operation instead of executing that operation.
"""

from html import escape


class InMemorySinks:
    """These names imitate dangerous APIs without using those APIs."""

    def execute(self, query, parameters=()):
        return {"kind": "sql", "query": query, "parameters": parameters}

    def run(self, command, *, shell=False):
        return {"kind": "command", "command": command, "shell": shell}

    def read(self, path):
        return {"kind": "path", "path": path}

    def render(self, markup):
        return {"kind": "html", "markup": markup}

    def redirect(self, target):
        return {"kind": "redirect", "target": target}


fixture_sink = InMemorySinks()


def fixture_input(value):
    """A labeled taint source, supplied only by the local fixture caller."""
    return value


def allow_filename(value):
    return value if value in {"report.txt", "summary.json"} else "report.txt"


def allow_redirect(value):
    return value if value in {"/dashboard", "/account"} else "/dashboard"


def sql_unsafe(value):
    username = fixture_input(value)
    # ruleid: gitaegis-fixture-sql-injection
    return fixture_sink.execute(f"SELECT id FROM fixture_users WHERE name = '{username}'")


def sql_safe(value):
    username = fixture_input(value)
    # ok: gitaegis-fixture-sql-injection
    return fixture_sink.execute("SELECT id FROM fixture_users WHERE name = ?", (username,))


def command_unsafe(value):
    filename = fixture_input(value)
    # ruleid: gitaegis-fixture-command-injection
    return fixture_sink.run(f"fixture-viewer {filename}", shell=True)


def command_safe(value):
    filename = fixture_input(value)
    # ok: gitaegis-fixture-command-injection
    return fixture_sink.run(["fixture-viewer", "--", filename], shell=False)


def path_unsafe(value):
    filename = fixture_input(value)
    # ruleid: gitaegis-fixture-path-traversal
    return fixture_sink.read("/virtual-fixtures/" + filename)


def path_safe(value):
    filename = allow_filename(fixture_input(value))
    # ok: gitaegis-fixture-path-traversal
    return fixture_sink.read("/virtual-fixtures/" + filename)


def html_unsafe(value):
    name = fixture_input(value)
    # ruleid: gitaegis-fixture-html-injection
    return fixture_sink.render(f"<p>{name}</p>")


def html_safe(value):
    name = escape(fixture_input(value), quote=True)
    # ok: gitaegis-fixture-html-injection
    return fixture_sink.render(f"<p>{name}</p>")


def redirect_unsafe(value):
    target = fixture_input(value)
    # ruleid: gitaegis-fixture-open-redirect
    return fixture_sink.redirect(target)


def redirect_safe(value):
    target = allow_redirect(fixture_input(value))
    # ok: gitaegis-fixture-open-redirect
    return fixture_sink.redirect(target)
