import contextlib
import io
import json
import logging
import sqlite3
import unittest

from server import admin
from server.app import App, client_ip_of
from server.tests.support import ServerCase

ORIGIN = "https://pose.example.org"


class CorsTest(ServerCase):
    options = {"allowed_origins": [ORIGIN + "/"]}

    def preflight(self, origin, method="POST"):
        return self.call("OPTIONS", "auth/login", headers={
            "Origin": origin, "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization, content-type"})

    def test_allowed_origin(self):
        status, _ = self.preflight(ORIGIN)
        self.assertEqual(status, 204)
        self.assertEqual(self.last_headers["access-control-allow-origin"], ORIGIN)
        self.assertIn("Authorization", self.last_headers["access-control-allow-headers"])
        self.assertNotIn("access-control-allow-credentials", self.last_headers)
        self.call("GET", "health", headers={"Origin": ORIGIN})
        self.assertEqual(self.last_headers["access-control-allow-origin"], ORIGIN)
        self.assertEqual(self.last_headers["vary"], "Origin")

    def test_other_origins_get_no_cors_headers(self):
        for origin in ("https://evil.example", "null", "*", ORIGIN + ".evil.example"):
            status, _ = self.preflight(origin)
            self.assertEqual(status, 403, origin)
            self.assertNotIn("access-control-allow-origin", self.last_headers)
            self.call("GET", "health", headers={"Origin": origin})
            self.assertNotIn("access-control-allow-origin", self.last_headers)
        self.assertEqual(self.preflight(ORIGIN, method="PATCH")[0], 403)


class RequestShapeTest(ServerCase):
    def test_body_too_large(self):
        raw = json.dumps({"username": "lin", "password": "x" * (301 * 1024)}).encode()
        status, body = self.call("POST", "auth/login", raw=raw, headers={"Content-Type": "application/json"})
        self.assertEqual((status, body["error"]["code"]), (413, "too_large"))

    def test_only_json(self):
        status, body = self.call("POST", "auth/login", raw=b"username=lin&password=secret1",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual((status, body["error"]["code"]), (415, "invalid"))
        for raw in (b"{bad", b"[1, 2]", b'{"a": NaN}', b"\xff\xfe"):
            status, _ = self.call("POST", "auth/login", raw=raw, headers={"Content-Type": "application/json"})
            self.assertEqual(status, 400, raw)

    def test_security_headers_and_errors(self):
        for path in ("health", "nope", "me"):
            self.call("GET", path)
            self.assertEqual(self.last_headers["x-content-type-options"], "nosniff")
            self.assertEqual(self.last_headers["cache-control"], "no-store")
            self.assertEqual(self.last_headers["referrer-policy"], "no-referrer")
            self.assertNotIn("python", self.last_headers.get("server", "").lower())
        self.assertEqual(self.call("GET", "health"), (200, {"ok": True}))
        status, body = self.call("GET", "nope")
        self.assertEqual((status, set(body["error"])), (404, {"code", "message"}))
        self.assertEqual(self.call("DELETE", "health")[0], 405)


class ProxyTest(ServerCase):
    options = {"trust_proxy": True, "register_per_hour": 2}

    def test_rightmost_forwarded_for_is_the_client(self):
        def register(name, chain):
            return self.call("POST", "auth/register", {"username": name, "password": "secret1"},
                             headers={"X-Forwarded-For": chain})[0]
        # A client cannot dodge the per-IP limit by forging entries on the left.
        self.assertEqual(register("aa1", "1.1.1.1, 203.0.113.9"), 201)
        self.assertEqual(register("aa2", "2.2.2.2, 203.0.113.9"), 201)
        self.assertEqual(register("aa3", "3.3.3.3, 203.0.113.9"), 429)
        self.assertEqual(register("aa4", "203.0.113.9, 198.51.100.7"), 201)

    def test_client_ip_rules(self):
        xff = {"x-forwarded-for": "6.6.6.6, 10.0.0.1, 203.0.113.9"}
        self.assertEqual(client_ip_of(xff, "127.0.0.1", True), "203.0.113.9")
        self.assertEqual(client_ip_of(xff, "127.0.0.1", False), "127.0.0.1")
        self.assertEqual(client_ip_of({"x-forwarded-for": "garbage"}, "127.0.0.1", True), "127.0.0.1")
        self.assertEqual(client_ip_of({}, "127.0.0.1", True), "127.0.0.1")


class LogTest(ServerCase):
    def test_no_passwords_or_tokens_in_logs(self):
        password, new = "S3cret-Pass-Word", "Brand-New-Pass-99"
        with self.assertLogs("movecraft", level="DEBUG") as logs:
            token = self.register("loguser", password)
            self.login("loguser", "Wrong-Pass-123")
            self.call("POST", "me/password", {"oldPassword": password, "newPassword": new}, token=token)
            self.call("GET", "me?token=" + token, token=token)
        text = "\n".join(logs.output)
        self.assertIn("/auth/register 201", text)
        for secret in (password, new, "Wrong-Pass-123", token, token[:12]):
            self.assertNotIn(secret, text)


class EmbedTest(unittest.TestCase):
    def test_handle_without_http_server(self):
        app = App(":memory:", scrypt_n=16)
        try:
            for path in ("/api/v1/health", "/v1/health", "/api/v1/health?x=1"):
                status, headers, body = app.handle("GET", path, {}, b"", "127.0.0.1")
                self.assertEqual((status, json.loads(body)), (200, {"ok": True}), path)
                self.assertIn(("Content-Type", "application/json; charset=utf-8"), headers)
            status, _, body = app.handle("POST", "/api/v1/auth/register", [("Content-Type", "application/json")],
                                         b'{"username":"embed","password":"secret1"}', "127.0.0.1")
            self.assertEqual(status, 201)
            self.assertEqual(app.handle("GET", "/other", {}, b"", "")[0], 404)
        finally:
            app.close()


class AdminTest(ServerCase):
    def run_admin(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            admin.main(["--db", str(self.db_path), *args])
        return out.getvalue()

    def test_hide_unhide_reset_backup_delete(self):
        token = self.register("cheater", remember=True)
        self.submit(token)
        self.run_admin("hide", "CHEATER")
        self.assertEqual(self.call("GET", "leaderboard?period=all")[1]["entries"], [])
        self.assertIn("cheater\t1\t1\t40", self.run_admin("list-users"))
        self.run_admin("unhide", "cheater")
        self.assertEqual(len(self.call("GET", "leaderboard?period=all")[1]["entries"]), 1)
        target = self.dir / "snap.sqlite3"
        self.assertEqual(self.run_admin("backup", str(target)).strip(), str(target))
        copy = sqlite3.connect(str(target))
        self.assertEqual(copy.execute("SELECT COUNT(*) FROM rounds").fetchone()[0], 1)
        copy.close()
        with self.assertRaises(SystemExit):
            self.run_admin("backup", str(target))  # no silent overwrite
        new_password = self.run_admin("reset-password", "cheater").rsplit("：", 1)[1].strip()
        self.assertEqual(self.call("GET", "me", token=token)[0], 401)
        self.assertEqual(self.login("cheater", new_password)[0], 200)
        with self.assertRaises(SystemExit):
            self.run_admin("delete-user", "cheater")  # needs --yes
        self.run_admin("delete-user", "cheater", "--yes")
        self.assertEqual(self.app.store.one("SELECT COUNT(*) FROM rounds")[0], 0)


if __name__ == "__main__":
    unittest.main()
