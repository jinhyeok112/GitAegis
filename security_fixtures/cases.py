"""Intentional security patterns with pure, in-memory sinks.

There are no real SQL, shell, filesystem, network, or HTTP operations here.
Importing this module creates only functions and a pure in-memory sink. Each
case returns a description of an operation instead of executing that operation.
"""

class InMemorySinks:
    """These names imitate dangerous APIs without using those APIs."""

    def run(self, command, *, shell=False):
        return {"kind": "command", "command": command, "shell": shell}

    def redirect(self, target):
        return {"kind": "redirect", "target": target}

    def log(self, message):
        return {"kind": "log", "message": message}

    def deserialize(self, payload, *, format="pickle"):
        return {"kind": "deserialize", "payload": payload, "format": format}

    def template(self, source, parameters=None):
        return {"kind": "template", "source": source, "parameters": parameters}

    def digest(self, data, *, algorithm):
        return {"kind": "digest", "data": data, "algorithm": algorithm}

    def connection(self, *, protocol):
        return {"kind": "connection", "protocol": protocol}


fixture_sink = InMemorySinks()


def fixture_input(value):
    """A labeled taint source, supplied only by the local fixture caller."""
    return value


def clean_log(value):
    return "fixture-event"


def allow_redirect(value):
    return value if value in {"/dashboard", "/account"} else "/dashboard"


def command_unsafe(value):
    filename = fixture_input(value)
    # ruleid: gitaegis-fixture-command-injection
    return fixture_sink.run(f"fixture-viewer {filename}", shell=True)


def command_safe(value):
    filename = fixture_input(value)
    # ok: gitaegis-fixture-command-injection
    return fixture_sink.run(["fixture-viewer", "--", filename], shell=False)


def redirect_unsafe(value):
    target = fixture_input(value)
    # ruleid: gitaegis-fixture-open-redirect
    return fixture_sink.redirect(target)


def redirect_safe(value):
    target = allow_redirect(fixture_input(value))
    # ok: gitaegis-fixture-open-redirect
    return fixture_sink.redirect(target)


def log_unsafe(value):
    event = fixture_input(value)
    # ruleid: gitaegis-fixture-log-injection
    return fixture_sink.log("event=" + event)


def log_safe(value):
    event = clean_log(fixture_input(value))
    # ok: gitaegis-fixture-log-injection
    return fixture_sink.log("event=" + event)


def deserialize_unsafe(value):
    payload = fixture_input(value)
    # ruleid: gitaegis-fixture-unsafe-deserialization
    return fixture_sink.deserialize(payload, format="pickle")


def deserialize_safe(value):
    payload = fixture_input(value)
    # ok: gitaegis-fixture-unsafe-deserialization
    return fixture_sink.deserialize(payload, format="json")


def template_unsafe(value):
    name = fixture_input(value)
    # ruleid: gitaegis-fixture-template-injection
    return fixture_sink.template("Hello " + name)


def template_safe(value):
    name = fixture_input(value)
    # ok: gitaegis-fixture-template-injection
    return fixture_sink.template("Hello {{name}}", {"name": name})


def digest_unsafe(value):
    data = fixture_input(value)
    # ruleid: gitaegis-fixture-md5
    return fixture_sink.digest(data, algorithm="md5")


def digest_safe(value):
    data = fixture_input(value)
    # ok: gitaegis-fixture-md5
    return fixture_sink.digest(data, algorithm="sha256")


def tls_unsafe():
    # ruleid: gitaegis-fixture-weak-tls
    return fixture_sink.connection(protocol="TLSv1")


def tls_safe():
    # ok: gitaegis-fixture-weak-tls
    return fixture_sink.connection(protocol="TLSv1_2")
