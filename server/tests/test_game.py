import unittest
import uuid

from server.store import beijing_day, iso_date, week_start_day
from server.tests.support import T0, ServerCase

# Sunday 2026-11-08 23:59:59 Beijing = 15:59:59 UTC; Monday 00:00 Beijing = 16:00 UTC.
SUNDAY_LAST_SECOND = T0 + 2 * 86400 + 12 * 3600 - 1


class SaveTest(ServerCase):
    def test_empty_then_versioned_writes_and_conflict(self):
        token = self.register()
        self.assertEqual(self.call("GET", "save", token=token), (200, {"data": None, "version": 0, "updatedAt": None}))
        status, body = self.call("PUT", "save", {"data": {"hp": 90}, "version": 0}, token=token)
        self.assertEqual((status, body["version"]), (200, 1))
        status, body = self.call("PUT", "save", {"data": {"hp": 80}, "version": 0}, token=token)
        self.assertEqual((status, body["error"]["code"]), (409, "conflict"))
        self.assertEqual(body["error"]["latest"]["version"], 1)
        self.assertEqual(body["error"]["latest"]["data"], {"hp": 90})
        self.assertEqual(self.call("PUT", "save", {"data": {"hp": 80}, "version": 1}, token=token)[1]["version"], 2)
        self.assertEqual(self.call("GET", "save", token=token)[1]["data"], {"hp": 80})

    def test_save_limits_and_auth(self):
        token = self.register()
        status, body = self.call("PUT", "save", {"data": "x" * (256 * 1024), "version": 0}, token=token)
        self.assertEqual((status, body["error"]["code"]), (413, "too_large"))
        for bad in ({"data": {}}, {"data": {}, "version": "1"}, {"data": {}, "version": -1}, {"version": 0}):
            self.assertEqual(self.call("PUT", "save", bad, token=token)[0], 400, bad)
        self.assertEqual(self.call("GET", "save")[0], 401)


class RoundTest(ServerCase):
    def test_accept_and_idempotent(self):
        token = self.register()
        rid = str(uuid.uuid4())
        status, body = self.submit(token, round_id=rid)
        self.assertEqual(status, 201)
        self.assertEqual(body, {"accepted": True, "duplicate": False, "weekTotal": 40, "weekRank": 1, "weekPercentile": None})
        status, body = self.submit(token, counts=(40, 40, 40, 40), duration=200, round_id=rid)
        self.assertEqual((status, body["duplicate"], body["weekTotal"]), (200, True, 40))
        self.assertEqual(self.app.store.one("SELECT COUNT(*) FROM rounds")[0], 1)

    def test_plausibility_is_422(self):
        token = self.register()
        cases = [dict(counts=(41, 0, 0, 0)), dict(counts=(-1, 5, 5, 5)), dict(counts=(0, 0, 0, 0)),
                 dict(mode="keyboard"), dict(mode=None), dict(duration=40 * 0.6 - 0.1),
                 dict(duration=0), dict(finished=T0 - 601), dict(finished=T0 + 601)]
        for case in cases:
            status, body = self.submit(token, **case)
            self.assertEqual((status, body["error"]["code"]), (422, "rejected"), case)
        self.assertEqual(self.submit(token, duration=24, finished=T0 - 600)[0], 201)

    def test_malformed_is_400(self):
        token = self.register()
        good = {"roundId": str(uuid.uuid4()), "counts": [1, 1, 1, 1], "durationSec": 10, "mode": "camera",
                "finishedAt": "2026-11-06T04:00:00Z"}
        self.assertEqual(self.call("POST", "rounds", good, token=token)[0], 201)
        for key, value in (("roundId", "abc"), ("counts", [1, 1, 1]), ("counts", [1, 1, 1, True]),
                           ("counts", [1.5, 1, 1, 1]), ("durationSec", "10"), ("finishedAt", "2026-11-06T04:00:00"),
                           ("finishedAt", None)):
            body = dict(good, roundId=str(uuid.uuid4()))
            body[key] = value
            status, out = self.call("POST", "rounds", body, token=token)
            self.assertEqual((status, out["error"]["code"]), (400, "invalid"), (key, value))
        self.assertEqual(self.call("POST", "rounds", good)[0], 401)

    def test_daily_cap_resets_at_beijing_midnight(self):
        token = self.register(remember=True)
        self.clock.now = T0 + 11 * 3600  # 23:00 Beijing
        for _ in range(30):
            self.assertEqual(self.submit(token, counts=(1, 1, 1, 1), duration=10)[0], 201)
        status, body = self.submit(token, counts=(1, 1, 1, 1), duration=10)
        self.assertEqual((status, body["error"]["code"]), (422, "rejected"))
        self.clock.now = T0 + 12 * 3600  # 00:00 Beijing, still Friday in UTC
        self.assertEqual(self.submit(token, counts=(1, 1, 1, 1), duration=10)[0], 201)


class BoardTest(ServerCase):
    def setUp(self):
        super().setUp()
        self.tokens = {name: self.register(name, remember=True) for name in ("ann", "bob", "cat", "dan")}

    def test_ties_hidden_and_percentile(self):
        t = self.tokens
        self.submit(t["ann"], counts=(10, 10, 10, 10))       # 40
        self.submit(t["bob"], counts=(10, 10, 10, 10))       # 40
        self.submit(t["cat"], counts=(5, 5, 5, 5))           # 20
        _, last = self.submit(t["dan"], counts=(1, 1, 1, 1), duration=10)  # 4
        self.assertEqual((last["weekRank"], last["weekPercentile"]), (4, 0))
        status, board = self.call("GET", "leaderboard?period=week&limit=10", token=t["cat"])
        self.assertEqual(status, 200)
        self.assertEqual([(e["rank"], e["username"], e["total"]) for e in board["entries"]],
                         [(1, "ann", 40), (1, "bob", 40), (3, "cat", 20), (4, "dan", 4)])
        self.assertEqual(board["me"], {"rank": 3, "username": "cat", "total": 20, "rounds": 1})
        self.assertEqual(board["weekStart"], "2026-11-02")
        _, stats = self.call("GET", "me/stats", token=t["ann"])
        self.assertEqual(stats["week"]["percentile"], 66)    # beat 2 of the 3 others; floor(66.7)
        self.assertEqual(self.submit(t["ann"], counts=(1, 0, 0, 0), duration=5)[1]["weekPercentile"], 100)
        self.app.store.db.execute("UPDATE users SET hidden = 1 WHERE username = 'bob'")
        _, board = self.call("GET", "leaderboard?period=all&limit=10")
        self.assertEqual([e["username"] for e in board["entries"]], ["ann", "cat", "dan"])
        self.assertIsNone(board["me"])
        _, stats = self.call("GET", "me/stats", token=t["bob"])
        self.assertEqual((stats["week"]["rank"], stats["week"]["total"]), (None, 40))

    def test_limit_and_period_validation(self):
        for query in ("period=day", "limit=0", "limit=101", "limit=abc", "limit=%EF%BC%91%EF%BC%90"):
            self.assertEqual(self.call("GET", "leaderboard?" + query)[0], 400, query)
        self.assertEqual(self.call("GET", "leaderboard?limit=100")[0], 200)

    def test_beijing_week_boundary(self):
        self.assertEqual(iso_date(week_start_day(beijing_day(SUNDAY_LAST_SECOND))), "2026-11-02")
        self.assertEqual(iso_date(week_start_day(beijing_day(SUNDAY_LAST_SECOND + 1))), "2026-11-09")
        self.clock.now = SUNDAY_LAST_SECOND
        self.submit(self.tokens["ann"], counts=(10, 10, 10, 10))
        self.clock.now = SUNDAY_LAST_SECOND + 1
        _, body = self.submit(self.tokens["bob"], counts=(1, 1, 1, 1), duration=10)
        self.assertEqual((body["weekRank"], body["weekPercentile"], body["weekTotal"]), (1, None, 4))
        _, week = self.call("GET", "leaderboard?period=week")
        self.assertEqual((week["weekStart"], [e["username"] for e in week["entries"]]), ("2026-11-09", ["bob"]))
        _, every = self.call("GET", "leaderboard?period=all")
        self.assertEqual([e["username"] for e in every["entries"]], ["ann", "bob"])

    def test_streak_days(self):
        token = self.tokens["ann"]
        for day in range(3):
            self.clock.now = T0 + day * 86400
            self.submit(token, counts=(1, 1, 1, 1), duration=10)
        self.assertEqual(self.call("GET", "me/stats", token=token)[1]["streakDays"], 3)
        self.clock.advance(86400)  # no round today yet: the streak still counts until tomorrow
        self.assertEqual(self.call("GET", "me/stats", token=token)[1]["streakDays"], 3)
        self.clock.advance(86400)
        self.assertEqual(self.call("GET", "me/stats", token=token)[1]["streakDays"], 0)


if __name__ == "__main__":
    unittest.main()
