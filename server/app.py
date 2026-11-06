"""MoveCraft account and leaderboard API, independent of any HTTP server.

    from server.app import App
    app = App(db_path)                      # or create_app() to read settings from env
    status, headers, body = app.handle(method, path, headers, body, client_ip)

headers in: a dict (any case) or a list of (name, value); body in: bytes.
headers out: a list of (name, value); body out: bytes. Thread-safe.
"""
import ipaddress
import json
import logging
import os
from pathlib import Path
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit

from .errors import ApiError, Busy
from .routes_account import AccountRoutes
from .routes_game import GameRoutes
from .security import Hasher, Lockout, Window, token_hash
from .store import Store

log = logging.getLogger("movecraft")
MAX_BODY = 300 * 1024
PREFIXES = ("/api/v1/", "/v1/")  # the second one is what remains if a proxy strips "/api"
METHODS = ("GET", "POST", "PUT", "DELETE")
BASE_HEADERS = [("X-Content-Type-Options", "nosniff"), ("Cache-Control", "no-store"),
                ("Referrer-Policy", "no-referrer"), ("Vary", "Origin")]


class Request:
    __slots__ = ("method", "route", "query", "headers", "data", "ip", "now")

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class App(AccountRoutes, GameRoutes):
    def __init__(self, db_path, *, allowed_origins=(), trust_proxy=False, clock=time.time,
                 scrypt_n=2 ** 14, hash_slots=2, register_per_hour=120,
                 login_failures_per_ip=300, lockout_failures=5, lockout_seconds=900):
        self.store = Store(db_path)
        self.clock = clock
        self.trust_proxy = bool(trust_proxy)
        self.origins = {o for o in (normalize_origin(x) for x in allowed_origins) if o}
        self.hasher = Hasher(n=scrypt_n, slots=hash_slots)
        self.register_ip = Window(register_per_hour, 3600)
        self.login_ip = Window(login_failures_per_ip, 900)
        self.lockout = Lockout(lockout_failures, lockout_seconds)
        self.routes = {
            "health": {"GET": self.health},
            "auth/register": {"POST": self.register},
            "auth/login": {"POST": self.login},
            "auth/logout": {"POST": self.logout},
            "me": {"GET": self.me, "DELETE": self.delete_me},
            "me/password": {"POST": self.change_password},
            "me/stats": {"GET": self.me_stats},
            "save": {"GET": self.get_save, "PUT": self.put_save},
            "rounds": {"POST": self.post_round},
            "leaderboard": {"GET": self.leaderboard},
        }

    def close(self):
        self.store.close()

    # -- entry point -------------------------------------------------------
    def handle(self, method, path, headers=None, body=b"", client_ip=""):
        started = time.monotonic()
        method = str(method).upper()
        headers = header_map(headers)
        route = route_of(path)
        origin = normalize_origin(headers.get("origin", ""))
        allowed = origin in self.origins
        extra = []
        try:
            if method == "OPTIONS":
                return self._preflight(route, headers, allowed, origin, started)
            status, payload = self._dispatch(method, route, path, headers, body or b"", client_ip)
        except ApiError as error:
            status, payload = error.status, error_body(error)
            if error.retry_after:
                extra.append(("Retry-After", str(int(error.retry_after))))
        except Busy:
            status, payload = 503, error_body(ApiError(503, "server", "服务器正忙，请稍后再试", 5))
            extra.append(("Retry-After", "5"))
        except sqlite3.OperationalError as error:
            log.warning("database busy: %s", type(error).__name__)
            status, payload = 503, error_body(ApiError(503, "server", "服务器正忙，请稍后再试"))
        except Exception:
            log.exception("unhandled error on %s %s", method, safe(route))
            status, payload = 500, error_body(ApiError(500, "server", "服务器出错了，请稍后再试"))
        if allowed:
            extra.append(("Access-Control-Allow-Origin", origin))
        return self._finish(method, route, status, payload, extra, started)

    def _preflight(self, route, headers, allowed, origin, started):
        wanted = headers.get("access-control-request-method", "").upper()
        if route in self.routes and allowed and wanted in self.routes[route]:
            extra = [("Access-Control-Allow-Origin", origin),
                     ("Access-Control-Allow-Methods", ", ".join(METHODS)),
                     ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
                     ("Access-Control-Max-Age", "600")]
            return self._finish("OPTIONS", route, 204, None, extra, started)
        if not origin and not wanted and route in self.routes:
            return self._finish("OPTIONS", route, 204, None, [], started)
        error = ApiError(403, "forbidden", "不允许的跨域请求")
        return self._finish("OPTIONS", route, 403, error_body(error), [], started)

    def _dispatch(self, method, route, path, headers, body, client_ip):
        handlers = self.routes.get(route)
        if handlers is None:
            raise ApiError(404, "not_found", "接口不存在")
        handler = handlers.get(method)
        if handler is None:
            raise ApiError(405, "not_allowed", "不支持这种请求方式")
        try:
            query = parse_qs(urlsplit(str(path)).query, max_num_fields=20)
        except ValueError:
            raise ApiError(400, "invalid", "请求参数太多") from None
        data = parse_body(headers, body) if method in ("POST", "PUT", "DELETE") else {}
        ip = client_ip_of(headers, client_ip, self.trust_proxy)
        request = Request(method=method, route=route, query=query, headers=headers,
                          data=data, ip=ip, now=self.clock())
        return handler(request)

    def _finish(self, method, route, status, payload, extra, started):
        headers = list(BASE_HEADERS)
        body = b""
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers.append(("Content-Type", "application/json; charset=utf-8"))
        headers.append(("Content-Length", str(len(body))))
        headers.extend(extra)
        # Only method, route and status: never bodies, tokens, query strings or passwords.
        log.info("%s /%s %d %.0fms", method, safe(route), status, (time.monotonic() - started) * 1000)
        return status, headers, body

    def reply_error(self, status, code, message):
        """For HTTP glue code that must refuse a request before handle() can read it."""
        return self._finish("-", "-", status, error_body(ApiError(status, code, message)), [], time.monotonic())

    # -- shared helpers for the route mixins --------------------------------
    def user_for(self, request, required=True):
        value = request.headers.get("authorization", "")
        scheme, _, token = value.partition(" ")
        user = None
        if scheme.lower() == "bearer" and token.strip() and len(token) < 200:
            row = self.store.one(
                "SELECT u.id, u.username, u.name_key, u.password_hash, t.token_hash, t.expires_at "
                "FROM tokens t JOIN users u ON u.id = t.user_id "
                "WHERE t.token_hash = ? AND t.expires_at > ?",
                (token_hash(token.strip()), int(request.now)))
            user = dict(row) if row else None
        if user is None and required:
            raise ApiError(401, "auth", "登录已过期，请重新登录")
        return user


def header_map(headers):
    items = headers.items() if hasattr(headers, "items") else (headers or [])
    out = {}
    for name, value in items:
        key = str(name).lower()
        out[key] = f"{out[key]}, {value}" if key in out else str(value)
    return out


def route_of(path):
    path = urlsplit(str(path)).path
    for prefix in PREFIXES:
        if path.startswith(prefix):
            return path[len(prefix):].strip("/")
    return None


def normalize_origin(value):
    value = str(value or "").strip().lower().rstrip("/")
    return "" if value in ("", "null", "*") else value


def error_body(error):
    body = {"code": error.code, "message": error.message}
    if error.retry_after:
        body["retryAfter"] = int(error.retry_after)
    body.update(error.extra)
    return {"error": body}


def safe(text):
    return "".join(c if c.isprintable() else "?" for c in str(text))[:80]


def parse_body(headers, body):
    if len(body) > MAX_BODY:
        raise ApiError(413, "too_large", "请求内容太大")
    if not body:
        return {}
    kind = headers.get("content-type", "").split(";")[0].strip().lower()
    if kind != "application/json":
        raise ApiError(415, "invalid", "只接受 JSON 格式的请求")
    try:
        data = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ApiError(400, "invalid", "请求格式不对") from None
    if not isinstance(data, dict):
        raise ApiError(400, "invalid", "请求格式不对")
    return data


def _reject_constant(name):
    raise ValueError(name)


def client_ip_of(headers, peer, trust_proxy):
    """With TRUST_PROXY, only the RIGHTMOST X-Forwarded-For entry, which our own Caddy wrote.
    Anything to its left came from the client and can be forged."""
    if trust_proxy:
        candidate = headers.get("x-forwarded-for", "").split(",")[-1].strip()
        try:
            return str(ipaddress.ip_address(candidate))
        except ValueError:
            pass
    return str(peer or "")


def env_flag(value):
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def create_app(db_path=None, env=None, **overrides):
    """App configured from environment variables; keyword arguments win."""
    env = os.environ if env is None else env
    options = {
        "allowed_origins": [o for o in env.get("ALLOWED_ORIGINS", "").split(",") if o.strip()],
        "trust_proxy": env_flag(env.get("TRUST_PROXY")),
        "scrypt_n": int(env.get("SCRYPT_N", 2 ** 14)),
        "register_per_hour": int(env.get("REGISTER_PER_HOUR", 120)),
        "login_failures_per_ip": int(env.get("LOGIN_FAILURES_PER_IP", 300)),
    }
    options.update(overrides)
    path = db_path or env.get("DB_PATH") or Path(__file__).resolve().parent / ".data" / "movecraft.sqlite3"
    return App(path, **options)
