"""Username and password rules, scrypt hashing, tokens and in-memory rate limits."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import ipaddress
import math
import re
import secrets
import threading
import unicodedata

from .errors import ApiError, Busy

# Same rule as web/stage/ui/logic.js: Han characters, ASCII letters, digits, underscore,
# 2-16 code points after NFKC and trimming. Python's re has no \p{Script=Han}, so list the blocks.
_HAN = ("⺀-⿟々〇〡-〩〸-〻㐀-䶿一-鿿"
        "豈-﫿\U00020000-\U0003134f")
USERNAME_RE = re.compile(f"[{_HAN}A-Za-z0-9_]{{2,16}}")
NAME_CHARS_RE = re.compile(f"[{_HAN}A-Za-z0-9_]+")
RESERVED = {"admin", "administrator", "root", "system", "guest", "movecraft",
            "管理员", "系统", "游客", "官方", "客服"}
PASSWORD_MIN, PASSWORD_MAX = 6, 128


def clean_username(value):
    """NFKC + trim; returns (display name, lookup key) or raises ApiError(invalid)."""
    if not isinstance(value, str) or not value.strip():
        raise ApiError(400, "invalid", "请输入用户名")
    if len(value) > 64:
        raise ApiError(400, "invalid", "用户名要 2 到 16 个字符")
    name = unicodedata.normalize("NFKC", value).strip()
    if not NAME_CHARS_RE.fullmatch(name):
        raise ApiError(400, "invalid", "用户名只能用中文、字母、数字和下划线")
    if not USERNAME_RE.fullmatch(name):
        raise ApiError(400, "invalid", "用户名要 2 到 16 个字符")
    key = name.casefold()
    if key in RESERVED:
        raise ApiError(400, "invalid", "这个用户名不能用，请换一个")
    return name, key


def login_key(value):
    """Lookup key for login; None when the value cannot be a username (then it is just wrong)."""
    if not isinstance(value, str) or len(value) > 64:
        return None
    name = unicodedata.normalize("NFKC", value).strip()
    return name.casefold() if USERNAME_RE.fullmatch(name) else None


def clean_password(value, label="密码"):
    if not isinstance(value, str) or not value:
        raise ApiError(400, "invalid", f"请输入{label}")
    if len(value) > PASSWORD_MAX * 2:
        raise ApiError(400, "invalid", f"{label}最多 {PASSWORD_MAX} 位")
    text = unicodedata.normalize("NFKC", value)
    if len(text) < PASSWORD_MIN:
        raise ApiError(400, "invalid", f"{label}至少 {PASSWORD_MIN} 位")
    if len(text) > PASSWORD_MAX:
        raise ApiError(400, "invalid", f"{label}最多 {PASSWORD_MAX} 位")
    return text


def login_password(value):
    """Password as typed at login/confirmation; None means it cannot match."""
    if not isinstance(value, str) or not value or len(value) > PASSWORD_MAX * 2:
        return None
    return unicodedata.normalize("NFKC", value)


class Hasher:
    """scrypt with parameters and salt stored next to the hash.

    Hashes run on `slots` fixed worker threads. Each call needs ~16 MB; running it on whichever
    request thread arrived let glibc keep a freed 16 MB block per thread arena (RSS > 500 MB under
    load). Fixed workers bound that to `slots` blocks on any libc."""

    def __init__(self, n=2 ** 14, r=8, p=1, slots=2, wait=10.0):
        if n < 2 or n & (n - 1):
            raise ValueError("scrypt n must be a power of two")
        self.n, self.r, self.p, self.wait = n, r, p, wait
        self.slots = threading.BoundedSemaphore(slots)
        self.pool = ThreadPoolExecutor(max_workers=slots, thread_name_prefix="scrypt")

    def _derive(self, password, salt, n, r, p, length):
        if not self.slots.acquire(timeout=self.wait):
            raise Busy()
        try:
            job = self.pool.submit(hashlib.scrypt, password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
                                   maxmem=128 * r * (n + p + 2) + (1 << 20), dklen=length)
            return job.result()
        finally:
            self.slots.release()

    def hash(self, password):
        salt = secrets.token_bytes(16)
        digest = self._derive(password, salt, self.n, self.r, self.p, 32)
        b64 = lambda raw: base64.b64encode(raw).decode("ascii")
        return f"scrypt${self.n}${self.r}${self.p}${b64(salt)}${b64(digest)}"

    def verify(self, password, stored):
        try:
            kind, n, r, p, salt, digest = stored.split("$")
            n, r, p = int(n), int(r), int(p)
            salt, digest = base64.b64decode(salt), base64.b64decode(digest)
        except (ValueError, AttributeError):
            return False
        if kind != "scrypt":
            return False
        return hmac.compare_digest(self._derive(password, salt, n, r, p, len(digest)), digest)

    def outdated(self, stored):
        return not stored.startswith(f"scrypt${self.n}${self.r}${self.p}$")


def new_token():
    return secrets.token_urlsafe(32)


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Window:
    """Fixed-window counter per key (an IP, usually). Memory stays bounded by pruning."""

    def __init__(self, limit, seconds, max_keys=20000):
        self.limit, self.seconds, self.max_keys = limit, seconds, max_keys
        self.hits, self.lock = {}, threading.Lock()

    def _prune(self, now):
        if len(self.hits) > self.max_keys:
            self.hits = {k: v for k, v in self.hits.items() if v[0] > now}

    def blocked(self, key, now):
        """Seconds to wait, or 0."""
        with self.lock:
            until, count = self.hits.get(key, (0, 0))
            return math.ceil(until - now) if until > now and count >= self.limit else 0

    def hit(self, key, now):
        with self.lock:
            self._prune(now)
            until, count = self.hits.get(key, (0, 0))
            if until <= now:
                until, count = now + self.seconds, 0
            self.hits[key] = (until, count + 1)


class Lockout:
    """Consecutive login failures per username: `limit` failures lock it for `seconds`."""

    def __init__(self, limit=5, seconds=900, max_keys=50000):
        self.limit, self.seconds, self.max_keys = limit, seconds, max_keys
        self.state, self.lock = {}, threading.Lock()  # key -> (failures, last_failure, locked_until)

    def wait(self, key, now):
        with self.lock:
            _, _, until = self.state.get(key, (0, 0, 0))
            return math.ceil(until - now) if until > now else 0

    def fail(self, key, now):
        """Records a failure; returns seconds locked (0 if not locked yet)."""
        with self.lock:
            if len(self.state) > self.max_keys:
                self.state = {k: v for k, v in self.state.items()
                              if max(v[1] + self.seconds, v[2]) > now}
            count, last, until = self.state.get(key, (0, 0, 0))
            if until and until <= now or last + self.seconds <= now:
                count = 0  # an old streak or a served lock starts over
            count += 1
            until = now + self.seconds if count >= self.limit else 0
            self.state[key] = (count, now, until)
            return self.seconds if until else 0

    def succeed(self, key):
        with self.lock:
            self.state.pop(key, None)


def ip_key(ip):
    """Rate-limit key: one IPv4 address, or one IPv6 /64 (a single home or phone)."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return str(ip)
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped:
        return str(mapped)
    if address.version == 6:
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)
