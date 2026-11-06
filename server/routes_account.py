"""Register, login, logout, profile, password change and account deletion."""
import sqlite3

from .errors import ApiError
from .security import (clean_password, clean_username, ip_key, login_key, login_password,
                       new_token, token_hash)
from .store import iso_time

SESSION_TTL = 4 * 3600         # shared big-screen devices
REMEMBER_TTL = 30 * 86400      # personal devices
MAX_TOKENS_PER_USER = 20


class AccountRoutes:
    def health(self, request):
        try:
            self.store.ping()
        except sqlite3.Error:
            raise ApiError(503, "server", "服务暂时不可用") from None
        return 200, {"ok": True}

    def register(self, request):
        now, ip = request.now, ip_key(request.ip)
        wait = self.register_ip.blocked(ip, now)
        if wait:
            raise ApiError(429, "rate", "注册太频繁，请稍后再试", wait)
        self.register_ip.hit(ip, now)
        data = request.data
        name, key = clean_username(data.get("username"))
        password = clean_password(data.get("password"))
        if self.store.one("SELECT 1 FROM users WHERE name_key = ?", (key,)):
            raise ApiError(409, "taken", "这个用户名已经有人用了")
        digest = self.hasher.hash(password)  # slow; outside the database lock
        try:
            with self.store.transaction() as db:
                user_id = db.execute(
                    "INSERT INTO users (username, name_key, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (name, key, digest, int(now))).lastrowid
                session = self._issue(db, user_id, data.get("remember") is True, now)
        except sqlite3.IntegrityError:
            raise ApiError(409, "taken", "这个用户名已经有人用了") from None
        return 201, dict(session, user={"id": user_id, "username": name})

    def _issue(self, db, user_id, remember, now):
        token = new_token()
        expires = int(now) + (REMEMBER_TTL if remember else SESSION_TTL)
        db.execute("DELETE FROM tokens WHERE expires_at <= ?", (int(now),))
        db.execute("INSERT INTO tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                   (token_hash(token), user_id, int(now), expires))
        db.execute("DELETE FROM tokens WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM tokens "
                   "WHERE user_id = ? ORDER BY rowid DESC LIMIT ?)", (user_id, user_id, MAX_TOKENS_PER_USER))
        return {"token": token, "expiresAt": iso_time(expires)}

    def _check_password(self, key, password, stored, now, ip):
        """Shared by login and by actions that ask for the password again."""
        ip = ip_key(ip)
        if password and stored and self.hasher.verify(password, stored):
            self.lockout.succeed(key)
            return True
        self.login_ip.hit(ip, now)
        locked = self.lockout.fail(key, now) if key else 0
        if locked:
            raise ApiError(429, "locked", f"密码错误次数太多，账号已锁定 {locked // 60} 分钟", locked)
        return False

    def _guard(self, key, now, ip):
        wait = self.lockout.wait(key, now) if key else 0
        if wait:
            raise ApiError(429, "locked", f"账号已锁定，请 {-(-wait // 60)} 分钟后再试", wait)
        wait = self.login_ip.blocked(ip_key(ip), now)
        if wait:
            raise ApiError(429, "rate", "尝试太频繁，请稍后再试", wait)

    def login(self, request):
        now, data = request.now, request.data
        key, password = login_key(data.get("username")), login_password(data.get("password"))
        if not isinstance(data.get("username"), str) or not isinstance(data.get("password"), str):
            raise ApiError(400, "invalid", "请输入用户名和密码")
        self._guard(key, now, request.ip)
        row = self.store.one("SELECT id, username, password_hash FROM users WHERE name_key = ?", (key,)) if key else None
        if not self._check_password(key, password, row["password_hash"] if row else None, now, request.ip):
            raise ApiError(401, "credentials", "用户名或密码不对")
        upgraded = self.hasher.hash(password) if self.hasher.outdated(row["password_hash"]) else None
        with self.store.transaction() as db:
            if upgraded:
                db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (upgraded, row["id"]))
            session = self._issue(db, row["id"], data.get("remember") is True, now)
        return 200, dict(session, user={"id": row["id"], "username": row["username"]})

    def logout(self, request):
        user = self.user_for(request, required=False)
        if user:
            with self.store.transaction() as db:
                db.execute("DELETE FROM tokens WHERE token_hash = ?", (user["token_hash"],))
        return 200, {"ok": True}

    def me(self, request):
        user = self.user_for(request)
        return 200, {"user": {"id": user["id"], "username": user["username"]},
                     "expiresAt": iso_time(user["expires_at"])}

    def _confirm(self, request, user, field):
        """Re-checks the password for sensitive actions; wrong password is 403, never 401."""
        password = login_password(request.data.get(field))
        self._guard(user["name_key"], request.now, request.ip)
        if not self._check_password(user["name_key"], password, user["password_hash"], request.now, request.ip):
            raise ApiError(403, "credentials", "密码不对")

    def change_password(self, request):
        user = self.user_for(request)
        if not isinstance(request.data.get("oldPassword"), str) or not request.data.get("oldPassword"):
            raise ApiError(400, "invalid", "请输入现在的密码")
        new = clean_password(request.data.get("newPassword"), "新密码")
        self._confirm(request, user, "oldPassword")
        digest = self.hasher.hash(new)
        with self.store.transaction() as db:
            db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (digest, user["id"]))
            db.execute("DELETE FROM tokens WHERE user_id = ? AND token_hash != ?", (user["id"], user["token_hash"]))
        return 200, {"ok": True}

    def delete_me(self, request):
        user = self.user_for(request)
        if not isinstance(request.data.get("password"), str) or not request.data.get("password"):
            raise ApiError(400, "invalid", "请输入密码")
        self._confirm(request, user, "password")
        with self.store.transaction() as db:
            db.execute("DELETE FROM users WHERE id = ?", (user["id"],))  # cascades to tokens, saves, rounds
        return 200, {"ok": True}
