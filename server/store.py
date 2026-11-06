"""SQLite storage, Beijing-time calendar helpers and leaderboard maths."""
import os
from pathlib import Path
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

BEIJING_OFFSET = 8 * 3600  # China has no DST, so a fixed offset is exact.
DAY = 86400

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
CREATE INDEX IF NOT EXISTS tokens_expiry ON tokens(expires_at);
CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL,
  c_jump INTEGER NOT NULL,
  c_jack INTEGER NOT NULL,
  c_raise INTEGER NOT NULL,
  c_squat INTEGER NOT NULL,
  total INTEGER NOT NULL,
  duration_sec REAL NOT NULL,
  finished_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  day INTEGER NOT NULL,
  UNIQUE (user_id, round_id)
);
CREATE INDEX IF NOT EXISTS rounds_day ON rounds(day);
CREATE INDEX IF NOT EXISTS rounds_user_day ON rounds(user_id, day);
"""


def beijing_day(ts):
    """Days since 1970-01-01 on the Beijing calendar."""
    return int((ts + BEIJING_OFFSET) // DAY)


def week_start_day(day):
    """The Monday of the week containing day. 1970-01-01 was a Thursday."""
    return day - (day + 3) % 7


def iso_date(day):
    return datetime.fromtimestamp(day * DAY, timezone.utc).strftime("%Y-%m-%d")


def iso_time(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    """One shared connection guarded by a lock. Queries are tiny; hashing happens outside the lock."""

    def __init__(self, path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        self.db.execute("PRAGMA user_version=1")

    def all(self, sql, params=()):
        with self.lock:
            return self.db.execute(sql, params).fetchall()

    def one(self, sql, params=()):
        with self.lock:
            return self.db.execute(sql, params).fetchone()

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield self.db
                self.db.execute("COMMIT")
            except BaseException:
                if self.db.in_transaction:
                    self.db.execute("ROLLBACK")
                raise

    def ping(self):
        return self.one("SELECT 1")[0] == 1

    def close(self):
        with self.lock:
            try:
                self.db.execute("PRAGMA optimize")
            except sqlite3.Error:
                pass
            self.db.close()


def standings(store, since_day=None):
    """Every visible player with points, best first, with competition ranks (1, 1, 3)."""
    where, params = "", ()
    if since_day is not None:
        where, params = "AND r.day >= ?", (since_day,)
    rows = store.all(
        "SELECT u.id, u.username, SUM(r.total) AS total, COUNT(*) AS rounds "
        "FROM rounds r JOIN users u ON u.id = r.user_id "
        f"WHERE u.hidden = 0 {where} GROUP BY u.id HAVING SUM(r.total) > 0 "
        "ORDER BY total DESC, u.id ASC", params)
    board, rank, previous = [], 0, None
    for i, row in enumerate(rows, 1):
        if row["total"] != previous:
            rank, previous = i, row["total"]
        board.append({"rank": rank, "userId": row["id"], "username": row["username"],
                      "total": row["total"], "rounds": row["rounds"]})
    return board


def percentile(board, user_id):
    """Integer 0-100: share of the OTHER players on this board with a strictly lower total.
    None when the player is not on the board or is the only one."""
    me = next((e for e in board if e["userId"] == user_id), None)
    if me is None or len(board) < 2:
        return None
    beaten = sum(1 for e in board if e["total"] < me["total"])
    return beaten * 100 // (len(board) - 1)


def streak(store, user_id, today):
    """Consecutive Beijing days with at least one accepted round, ending today or yesterday."""
    days = {row[0] for row in store.all(
        "SELECT DISTINCT day FROM rounds WHERE user_id = ? AND day >= ?", (user_id, today - 400))}
    day = today if today in days else today - 1
    count = 0
    while day in days:
        count += 1
        day -= 1
    return count
