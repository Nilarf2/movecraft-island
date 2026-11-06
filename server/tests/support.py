"""Real HTTP server on a random port, a temporary database and a hand-driven clock."""
import http.client
import json
import shutil
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

from server.app import App
from server.serve import make_server

T0 = 1793937600  # 2026-11-06 12:00 Beijing time, a Friday


class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class ServerCase(unittest.TestCase):
    options = {}

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="movecraft-test-"))
        self.db_path = self.dir / "test.sqlite3"
        self.clock = Clock()
        self.app = App(self.db_path, clock=self.clock, scrypt_n=16, **self.options)
        self.server = make_server(self.app, "127.0.0.1", 0)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def call(self, method, path, body=None, token=None, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        sent = dict(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            sent.setdefault("Content-Type", "application/json")
        if token:
            sent["Authorization"] = f"Bearer {token}"
        try:
            conn.request(method, "/api/v1/" + path.lstrip("/"), body=data, headers=sent)
            response = conn.getresponse()
            payload = response.read()
            self.last_headers = {k.lower(): v for k, v in response.getheaders()}
            return response.status, (json.loads(payload) if payload else None)
        finally:
            conn.close()

    def register(self, name="lin", password="secret1", remember=False, expect=201):
        status, body = self.call("POST", "auth/register", {"username": name, "password": password, "remember": remember})
        self.assertEqual(status, expect, body)
        return body.get("token") if expect == 201 else body

    def login(self, name="lin", password="secret1", remember=False):
        return self.call("POST", "auth/login", {"username": name, "password": password, "remember": remember})

    def submit(self, token, counts=(10, 10, 10, 10), duration=120, mode="camera", finished=None, round_id=None):
        body = {"roundId": round_id or str(uuid.uuid4()), "counts": list(counts), "durationSec": duration,
                "mode": mode, "finishedAt": int((self.clock.now if finished is None else finished) * 1000)}
        return self.call("POST", "rounds", body, token=token)
