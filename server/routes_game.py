"""Island save, round results, leaderboard and personal stats."""
import json
import math
import uuid
from datetime import datetime

from .errors import ApiError
from .store import beijing_day, iso_date, iso_time, percentile, standings, streak, week_start_day

MAX_SAVE = 256 * 1024
MAX_PER_ACTION = 40
MIN_SECONDS_PER_MOVE = 0.6
MAX_DURATION = 3600
MAX_SKEW = 600
ROUNDS_PER_DAY = 30


def parse_time(value):
    """Epoch milliseconds or an ISO 8601 string with a timezone; returns epoch seconds or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value / 1000 if math.isfinite(value) else None
    if isinstance(value, str) and len(value) <= 40:
        text = value.strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed.timestamp() if parsed.tzinfo else None
    return None


class GameRoutes:
    # -- save --------------------------------------------------------------
    def get_save(self, request):
        user = self.user_for(request)
        row = self.store.one("SELECT version, data, updated_at FROM saves WHERE user_id = ?", (user["id"],))
        return 200, save_view(row)

    def put_save(self, request):
        user = self.user_for(request)
        data, version = request.data.get("data"), request.data.get("version")
        if "data" not in request.data or not isinstance(version, int) or isinstance(version, bool) or version < 0:
            raise ApiError(400, "invalid", "存档格式不对")
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(text.encode("utf-8")) > MAX_SAVE:
            raise ApiError(413, "too_large", "存档太大，不能超过 256 KB")
        with self.store.transaction() as db:
            row = db.execute("SELECT version, data, updated_at FROM saves WHERE user_id = ?", (user["id"],)).fetchone()
            current = row["version"] if row else 0
            if version != current:
                raise ApiError(409, "conflict", "存档已在别处更新", latest=save_view(row))
            db.execute("INSERT INTO saves (user_id, version, data, updated_at) VALUES (?, ?, ?, ?) "
                       "ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, data = excluded.data, "
                       "updated_at = excluded.updated_at", (user["id"], current + 1, text, int(request.now)))
        return 200, {"version": current + 1, "updatedAt": iso_time(request.now)}

    # -- rounds ------------------------------------------------------------
    def post_round(self, request):
        user, data, now = self.user_for(request), request.data, request.now
        try:
            round_id = str(uuid.UUID(str(data.get("roundId"))[:64]))
        except ValueError:
            raise ApiError(400, "invalid", "roundId 必须是 UUID") from None
        counts, duration = data.get("counts"), data.get("durationSec")
        finished = parse_time(data.get("finishedAt"))
        if (not isinstance(counts, list) or len(counts) != 4
                or not all(isinstance(c, int) and not isinstance(c, bool) for c in counts)):
            raise ApiError(400, "invalid", "counts 必须是 4 个整数")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration):
            raise ApiError(400, "invalid", "durationSec 必须是数字")
        if finished is None:
            raise ApiError(400, "invalid", "finishedAt 必须是带时区的时间")
        duplicate = self.store.one("SELECT 1 FROM rounds WHERE user_id = ? AND round_id = ?", (user["id"], round_id))
        if duplicate:
            return 200, dict(self._week_result(user["id"], now), accepted=True, duplicate=True)
        total = sum(counts)
        problem = None
        if data.get("mode") != "camera":
            problem = "只有摄像头模式的成绩计入排行"
        elif any(c < 0 or c > MAX_PER_ACTION for c in counts):
            problem = f"每个动作的次数要在 0 到 {MAX_PER_ACTION} 之间"
        elif total == 0:
            problem = "这一轮没有有效动作"
        elif duration <= 0 or duration > MAX_DURATION or duration < total * MIN_SECONDS_PER_MOVE:
            problem = "用时和动作次数对不上"
        elif abs(finished - now) > MAX_SKEW:
            problem = "完成时间和服务器时间相差太多"
        today = beijing_day(now)
        with self.store.transaction() as db:
            if problem is None:
                played = db.execute("SELECT COUNT(*) FROM rounds WHERE user_id = ? AND day = ?",
                                    (user["id"], today)).fetchone()[0]
                if played >= ROUNDS_PER_DAY:
                    problem = f"每天最多计入 {ROUNDS_PER_DAY} 轮，明天再来吧"
            if problem is None:
                inserted = db.execute(
                    "INSERT INTO rounds (user_id, round_id, c_jump, c_jack, c_raise, c_squat, total, duration_sec, "
                    "finished_at, received_at, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(user_id, round_id) DO NOTHING",
                    (user["id"], round_id, *counts, total, float(duration), int(finished), int(now), today)).rowcount
        if problem:
            raise ApiError(422, "rejected", problem)
        result = self._week_result(user["id"], now)
        return (201 if inserted else 200), dict(result, accepted=True, duplicate=not inserted)

    def _week_result(self, user_id, now):
        board = standings(self.store, week_start_day(beijing_day(now)))
        mine = next((e for e in board if e["userId"] == user_id), None)
        total = self.store.one("SELECT COALESCE(SUM(total), 0) FROM rounds WHERE user_id = ? AND day >= ?",
                               (user_id, week_start_day(beijing_day(now))))[0]
        return {"weekTotal": total, "weekRank": mine["rank"] if mine else None,
                "weekPercentile": percentile(board, user_id)}

    # -- leaderboard and stats ---------------------------------------------
    def leaderboard(self, request):
        period = (request.query.get("period") or ["week"])[0]
        if period not in ("week", "all"):
            raise ApiError(400, "invalid", "period 只能是 week 或 all")
        raw = (request.query.get("limit") or ["10"])[0]
        if not (raw.isascii() and raw.isdigit()) or not 1 <= int(raw) <= 100:
            raise ApiError(400, "invalid", "limit 要在 1 到 100 之间")
        week = week_start_day(beijing_day(request.now))
        board = standings(self.store, week if period == "week" else None)
        user = self.user_for(request, required=False)
        mine = next((e for e in board if user and e["userId"] == user["id"]), None)
        return 200, {"period": period, "weekStart": iso_date(week),
                     "entries": [public(e) for e in board[:int(raw)]],
                     "me": public(mine) if mine else None}

    def me_stats(self, request):
        user, now = self.user_for(request), request.now
        today = beijing_day(now)
        week = week_start_day(today)
        out = {"weekStart": iso_date(week), "streakDays": streak(self.store, user["id"], today)}
        for period, since in (("week", week), ("all", None)):
            board = standings(self.store, since)
            mine = next((e for e in board if e["userId"] == user["id"]), None)
            row = self.store.one("SELECT COALESCE(SUM(total), 0), COUNT(*) FROM rounds WHERE user_id = ? AND day >= ?",
                                 (user["id"], since if since is not None else -10 ** 9))
            out[period] = {"total": row[0], "rounds": row[1], "rank": mine["rank"] if mine else None,
                           "percentile": percentile(board, user["id"]), "players": len(board)}
        return 200, out


def public(entry):
    return {"rank": entry["rank"], "username": entry["username"], "total": entry["total"], "rounds": entry["rounds"]}


def save_view(row):
    if row is None:
        return {"data": None, "version": 0, "updatedAt": None}
    return {"data": json.loads(row["data"]), "version": row["version"], "updatedAt": iso_time(row["updated_at"])}
