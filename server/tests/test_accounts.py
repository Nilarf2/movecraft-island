import unittest

from server.tests.support import ServerCase


class RegisterLoginTest(ServerCase):
    def test_register_login_me(self):
        token = self.register("小明", "secret1")
        status, body = self.call("GET", "me", token=token)
        self.assertEqual((status, body["user"]["username"]), (200, "小明"))
        status, body = self.login("小明", "secret1")
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"token", "expiresAt", "user"})
        self.assertTrue(body["expiresAt"].endswith("Z"))

    def test_username_is_nfkc_and_case_insensitive(self):
        self.register("Ｌｉｎ_01")
        status, body = self.call("GET", "me", token=self.login("lin_01")[1]["token"])
        self.assertEqual(body["user"]["username"], "Lin_01")
        body = self.register("LIN_01", expect=409)
        self.assertEqual(body["error"]["code"], "taken")

    def test_username_and_password_rules(self):
        for bad in ["a", "a" * 17, "a b", "a-b", "😀😀", "", "admin", "游客", 42]:
            status, body = self.call("POST", "auth/register", {"username": bad, "password": "secret1"})
            self.assertEqual((status, body["error"]["code"]), (400, "invalid"), bad)
            self.assertTrue(body["error"]["message"])
        for bad in ["12345", "x" * 129, None]:
            status, body = self.call("POST", "auth/register", {"username": "okname", "password": bad})
            self.assertEqual((status, body["error"]["code"]), (400, "invalid"), bad)
        for good in ["王小二", "ab", "a_1", "x" * 16]:
            self.register(good, "x" * 128)

    def test_wrong_password_locks_username_for_15_minutes(self):
        self.register("lin")
        for _ in range(4):
            status, body = self.login("lin", "wrongpw")
            self.assertEqual((status, body["error"]["code"]), (401, "credentials"))
        status, body = self.login("lin", "wrongpw")
        self.assertEqual((status, body["error"]["code"]), (429, "locked"))
        status, body = self.login("lin", "secret1")  # even the right password waits
        self.assertEqual((status, body["error"]["code"]), (429, "locked"))
        self.assertEqual(body["error"]["retryAfter"], 900)
        self.assertEqual(self.last_headers["retry-after"], "900")
        self.clock.advance(901)
        self.assertEqual(self.login("lin", "secret1")[0], 200)

    def test_success_resets_failure_streak(self):
        self.register("lin")
        for _ in range(4):
            self.login("lin", "wrongpw")
        self.assertEqual(self.login("lin")[0], 200)
        for _ in range(4):
            self.assertEqual(self.login("lin", "wrongpw")[0], 401)

    def test_unknown_username_is_plain_credentials_error(self):
        status, body = self.login("nobody", "secret1")
        self.assertEqual((status, body["error"]["code"]), (401, "credentials"))


class IpLimitTest(ServerCase):
    options = {"register_per_hour": 3, "login_failures_per_ip": 4}

    def test_register_limited_per_ip_per_hour(self):
        for name in ("aa1", "aa2", "aa3"):
            self.register(name)
        status, body = self.call("POST", "auth/register", {"username": "aa4", "password": "secret1"})
        self.assertEqual((status, body["error"]["code"]), (429, "rate"))
        self.clock.advance(3601)
        self.register("aa4")

    def test_login_failures_limited_per_ip(self):
        self.register("aa1")
        for name in ("u1", "u2", "u3", "u4"):  # different usernames, same IP
            self.assertEqual(self.login(name, "wrongpw")[0], 401)
        status, body = self.login("aa1", "secret1")
        self.assertEqual((status, body["error"]["code"]), (429, "rate"))
        self.clock.advance(901)
        self.assertEqual(self.login("aa1", "secret1")[0], 200)


class TokenTest(ServerCase):
    def test_short_and_remembered_expiry(self):
        short = self.register("lin")
        long = self.login("lin", remember=True)[1]["token"]
        self.clock.advance(4 * 3600 - 1)
        self.assertEqual(self.call("GET", "me", token=short)[0], 200)
        self.clock.advance(1)
        status, body = self.call("GET", "me", token=short)
        self.assertEqual((status, body["error"]["code"]), (401, "auth"))
        self.clock.advance(30 * 86400 - 4 * 3600 - 1)
        self.assertEqual(self.call("GET", "me", token=long)[0], 200)
        self.clock.advance(1)
        self.assertEqual(self.call("GET", "me", token=long)[0], 401)

    def test_bad_tokens(self):
        for header in ("Bearer nope", "Basic abc", "Bearer ", "x" * 300):
            status, body = self.call("GET", "me", headers={"Authorization": header})
            self.assertEqual((status, body["error"]["code"]), (401, "auth"), header)

    def test_logout_revokes_only_that_token(self):
        a = self.register("lin")
        b = self.login("lin")[1]["token"]
        self.assertEqual(self.call("POST", "auth/logout", token=a), (200, {"ok": True}))
        self.assertEqual(self.call("GET", "me", token=a)[0], 401)
        self.assertEqual(self.call("GET", "me", token=b)[0], 200)
        self.assertEqual(self.call("POST", "auth/logout")[0], 200)  # no token: still fine

    def test_password_change_revokes_other_tokens(self):
        current = self.register("lin")
        other = self.login("lin", remember=True)[1]["token"]
        status, body = self.call("POST", "me/password", {"oldPassword": "wrongpw", "newPassword": "newpass1"}, token=current)
        self.assertEqual((status, body["error"]["code"]), (403, "credentials"))
        status, body = self.call("POST", "me/password", {"oldPassword": "secret1", "newPassword": "123"}, token=current)
        self.assertEqual((status, body["error"]["code"]), (400, "invalid"))
        status, _ = self.call("POST", "me/password", {"oldPassword": "secret1", "newPassword": "newpass1"}, token=current)
        self.assertEqual(status, 200)
        self.assertEqual(self.call("GET", "me", token=current)[0], 200)
        self.assertEqual(self.call("GET", "me", token=other)[0], 401)
        self.assertEqual(self.login("lin", "secret1")[0], 401)
        self.assertEqual(self.login("lin", "newpass1")[0], 200)


class DeleteAccountTest(ServerCase):
    def test_delete_cascades(self):
        token = self.register("lin")
        self.call("PUT", "save", {"data": {"hp": 100}, "version": 0}, token=token)
        self.assertEqual(self.submit(token)[0], 201)
        status, body = self.call("DELETE", "me", {"password": "wrongpw"}, token=token)
        self.assertEqual((status, body["error"]["code"]), (403, "credentials"))
        self.assertEqual(self.call("DELETE", "me", {"password": "secret1"}, token=token)[0], 200)
        db = self.app.store
        for table in ("users", "tokens", "saves", "rounds"):
            self.assertEqual(db.one(f"SELECT COUNT(*) FROM {table}")[0], 0, table)
        self.assertEqual(self.call("GET", "leaderboard?period=all")[1]["entries"], [])
        self.register("lin")  # the name is free again


if __name__ == "__main__":
    unittest.main()
