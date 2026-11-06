"""Voiceover generator logic; no network calls."""
import base64
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("generate_voice", ROOT / "scripts/generate_voice.py")
gv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gv)


def line(text, group="stage"):
    return {"text": text, "group": group, "style": "s"}


class PlanTest(unittest.TestCase):
    def test_counts_stay_in_order_and_similar_lines_are_spread(self):
        counts = [line(f"{gv.chinese(n)}！", "count") for n in range(1, 26)]
        intros = [line(f"第一站，摘椰子！来{gv.chinese(n)}个竖直跳。") for n in range(10, 14)]
        intros += [line(f"第二站，砍树！来{gv.chinese(n)}个开合跳。") for n in range(10, 14)]
        singles = [line("登岛成功！", "cheer"), line("双脚稳稳落地。", "correction")]
        batches = gv.plan_batches(counts + intros + singles, 14, 420)
        self.assertEqual(batches[0], counts)
        rest = [item for batch in batches[1:] for item in batch]
        self.assertCountEqual(rest, intros + singles)
        self.assertTrue(all(len(batch) <= 14 for batch in batches[1:]))
        self.assertFalse(any(a["text"][:4] == b["text"][:4] for a, b in zip(rest, rest[1:])))

    def test_first_round_lines_are_recorded_first(self):
        self.assertTrue(gv.first_round(line("第一站，摘椰子！来十个竖直跳，换点淡水。")))
        self.assertTrue(gv.first_round(line("还差九个。")))
        self.assertTrue(gv.first_round(line("继续砍树！")))
        self.assertTrue(gv.first_round(line("这一轮全部完成，辛苦啦！", "settlement")))
        self.assertTrue(gv.first_round(line("每一个动作都算数。好好休息，明天岛上见！", "settlement")))
        self.assertTrue(gv.first_round(line("十八！", "count")))
        self.assertFalse(gv.first_round(line("第一站，摘椰子！来十一个竖直跳，换点淡水。")))
        self.assertFalse(gv.first_round(line("还差二十个。")))
        self.assertFalse(gv.first_round(line("竖直跳、开合跳、手臂平举和深蹲各做了十一个，一共消耗三十八点五卡。", "settlement")))
        batches = gv.plan([line("第一站，摘椰子！来十一个竖直跳。"), line("第一站，摘椰子！来十个竖直跳。")], 1, 420)
        self.assertEqual(batches[0][0]["text"], "第一站，摘椰子！来十个竖直跳。")

    def test_small_retry_rounds_split_the_counts(self):
        counts = [line(f"{gv.chinese(n)}！", "count") for n in range(1, 8)]
        self.assertEqual([len(batch) for batch in gv.plan_batches(counts, 4, 420)], [4, 3])

    def test_character_budget_closes_a_batch(self):
        batches = gv.plan_batches([line("长" * 150 + str(i)) for i in range(3)], 14, 420)
        self.assertEqual([len(batch) for batch in batches], [2, 1])


class CutTest(unittest.TestCase):
    def test_a_long_comma_pause_is_not_taken_for_a_line_boundary(self):
        # Lines of 20, 30 and 10 characters; the middle line has a 1.1 s comma pause.
        gaps = [(2.0, 2.9), (4.4, 5.5), (7.0, 7.9)]
        self.assertEqual(gv.pick_cuts(gaps, [20, 30, 10], 0.0, 8.9), [(2.0, 2.9), (7.0, 7.9)])

    def test_too_few_pauses_and_single_lines(self):
        self.assertIsNone(gv.pick_cuts([(1.0, 1.5)], [5, 5, 5], 0.0, 4.0))
        self.assertEqual(gv.pick_cuts([], [5], 0.0, 2.0), [])


class CheckTest(unittest.TestCase):
    def test_numbers_must_match_and_wording_may_differ(self):
        self.assertEqual(gv.classify("过半了，保持节奏！", "过半了。保持节奏。"), "ok")
        self.assertEqual(gv.classify("一共消耗三十五卡。", "一共消耗35卡"), "ok")
        self.assertEqual(gv.classify("你击败了全国百分之九十八的人！", "你击败了全国98%的人"), "ok")
        self.assertEqual(gv.classify("椰子摘够了，淡水加两份！", "椰子摘够了，淡水加2份"), "ok")
        self.assertEqual(gv.classify("第一站，摘椰子！来十个竖直跳，换点淡水。", "第一站摘叶子，来十个数字跳，换点淡水。"), "review")
        self.assertEqual(gv.classify("第一站，摘椰子！来十个竖直跳，换点淡水。", "第一站，摘椰子！来十一个竖直跳，换点淡水。"), "redo")
        self.assertEqual(gv.classify("五！", ""), "redo")
        self.assertEqual(gv.classify("每一个动作都算数。", "明天岛上见"), "redo")

    def test_parse_numbered_lines(self):
        text = "1. 第一站\n2、五\n3．过半了\n5: 好好休息"
        self.assertEqual(gv.parse_numbered(text, 5), ["第一站", "五", "过半了", "", "好好休息"])

    def test_duration_must_fit_the_text(self):
        self.assertTrue(gv.plausible("五！", 0.4))
        self.assertTrue(gv.plausible("二十三！", 0.33))
        self.assertTrue(gv.plausible("第一站，摘椰子！来十个竖直跳，换点淡水。", 4.05))
        self.assertFalse(gv.plausible("第一站，摘椰子！来十个竖直跳，换点淡水。", 0.8))
        self.assertFalse(gv.plausible("五！", 6.0))


class AssetsTest(unittest.TestCase):
    def test_only_recorded_lines_are_mapped(self):
        with tempfile.TemporaryDirectory() as tmp:
            clips, target = Path(tmp) / "voice", Path(tmp) / "voice-assets.js"
            clips.mkdir()
            (clips / "aaa.mp3").write_bytes(b"x")
            lines = [{"text": "登岛成功！", "id": "aaa"}, {"text": "最后一个！", "id": "bbb"}]
            self.assertEqual(gv.write_assets(lines, clips, target), 1)
            source = target.read_text(encoding="utf-8")
            self.assertIn('"登岛成功！": "audio/voice/aaa.mp3"', source)
            self.assertNotIn("最后一个", source)
            self.assertTrue(source.rstrip().endswith("};"))

    @unittest.skipUnless(shutil.which("node"), "needs Node.js to read web/narration.js")
    def test_script_lines_load_from_narration(self):
        lines = gv.load_lines()
        self.assertEqual(len({item["text"] for item in lines}), len(lines))
        self.assertTrue(all(item["style"] and item["group"] for item in lines))
        self.assertIn("五！", {item["text"] for item in lines})


class EndpointTest(unittest.TestCase):
    def test_vertex_urls_for_global_and_regional_locations(self):
        path = "/v1/projects/p1/locations/{}/publishers/google/models/gemini-3.8-flash-tts:generateContent"
        self.assertEqual(gv.Endpoint("vertex", "t", "p1").url("gemini-3.8-flash-tts"),
                         "https://aiplatform.googleapis.com" + path.format("global"))
        self.assertEqual(gv.Endpoint("vertex", "t", "p1", "us-central1").url("gemini-3.8-flash-tts"),
                         "https://us-central1-aiplatform.googleapis.com" + path.format("us-central1"))
        with self.assertRaises(ValueError):
            gv.Endpoint("vertex", "t", None)

    def test_gemini_url_and_auth_headers(self):
        gemini, vertex = gv.Endpoint("gemini", "k"), gv.Endpoint("vertex", "tok", "p")
        self.assertEqual(gemini.url("gemini-3.8-flash-tts"),
                         "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent")
        self.assertEqual(gemini.headers()["x-goog-api-key"], "k")
        self.assertNotIn("Authorization", gemini.headers())
        self.assertEqual(vertex.headers()["Authorization"], "Bearer tok")
        self.assertNotIn("x-goog-api-key", vertex.headers())

    def test_request_bodies_follow_each_backend(self):
        batch = [line("五！", "count"), line("六！", "count")]
        gemini, vertex = gv.tts_body(batch, "Puck", "gemini"), gv.tts_body(batch, "Puck", "vertex")
        self.assertEqual(gemini["generationConfig"]["speechConfig"]["voiceConfig"],
                         {"prebuiltVoiceConfig": {"voiceName": "Puck"}})
        self.assertEqual(vertex["generationConfig"]["speechConfig"]["voiceConfig"], {"voice": "Puck"})
        self.assertEqual(vertex["contents"][0]["parts"][0], {"text": "五！" + gv.PAUSE, "speechMetadata": {"style": "s"}})
        self.assertEqual(gemini["contents"][0]["parts"][1], {"text": "六！", "speech_metadata": {"style": "s"}})

    def test_redact(self):
        self.assertEqual(gv.redact("token abc in abc", "abc", None, ""), "token [redacted] in [redacted]")

    def test_missing_tts_model_stops_the_run(self):
        with patch.object(gv, "post", side_effect=gv.ModelMissing("m: HTTP 404")):
            with self.assertRaises(gv.Fatal):
                gv.synthesize([line("五！")], "Puck", "m", gv.Endpoint("vertex", "t", "p"), None, Path("unused.wav"))

class RouteTest(unittest.TestCase):
    def setUp(self):
        self.vertex, self.gemini = gv.Endpoint("vertex", "t", "p"), gv.Endpoint("gemini", "k")

    def fake_post(self, calls, vertex_error):
        def post(endpoint, model, body, limiter, attempts=6, timeout=240):
            calls.append((endpoint.backend, model))
            if endpoint.backend == "vertex":
                raise vertex_error(f"{model}: HTTP 404")
            return {"candidates": [{"content": {"parts": [{"text": "1. 五"}]}}]}
        return post

    def test_falls_back_to_ai_studio_when_no_check_model_exists(self):
        route, calls, errors = gv.Route(self.vertex, self.gemini), [], []
        with patch.object(gv, "post", self.fake_post(calls, gv.ModelMissing)), contextlib.redirect_stdout(io.StringIO()):
            first = next(route.attempts(["a", "b"], {}, None, errors))
            self.assertEqual(first[0], "a")
            self.assertEqual(calls, [("vertex", "a"), ("vertex", "b"), ("gemini", "a")])
            self.assertTrue(route.use_fallback)
            calls.clear()
            next(route.attempts(["a", "b"], {}, None, errors))  # later batches skip the primary
            self.assertEqual(calls, [("gemini", "a")])

    def test_no_fallback_without_a_key_or_for_other_errors(self):
        for route, error in ((gv.Route(self.vertex), gv.ModelMissing), (gv.Route(self.vertex, self.gemini), RuntimeError)):
            calls, errors = [], []
            with patch.object(gv, "post", self.fake_post(calls, error)):
                self.assertEqual(list(route.attempts(["a", "b"], {}, None, errors)), [])
            self.assertEqual(calls, [("vertex", "a"), ("vertex", "b")])
            self.assertFalse(route.use_fallback)
            self.assertEqual(len(errors), 2)

class FakeServer(http.server.ThreadingHTTPServer):
    """Local stand-in for generateContent: answers each request with the next (status, body)."""

    def __init__(self, replies):
        self.replies, self.requests = list(replies), []
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                server.requests.append((self.path, dict(self.headers)))
                status, body = server.replies.pop(0) if len(server.replies) > 1 else server.replies[0]
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        super().__init__(("127.0.0.1", 0), Handler)


class HttpTest(unittest.TestCase):
    TOKEN = "ya29.SECRET-TOKEN-VALUE"

    def setUp(self):
        proxies = patch.dict(os.environ, {"no_proxy": "*", "NO_PROXY": "*"})
        proxies.start()
        self.addCleanup(proxies.stop)

    def serve(self, *replies):
        server = FakeServer(replies)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def vertex(self, server):
        return gv.Endpoint("vertex", self.TOKEN, "proj", base=f"http://127.0.0.1:{server.server_port}/v1/")

    def test_401_stops_at_once_with_the_token_hint(self):
        server = self.serve((401, {"error": {"code": 401, "message": f"bad credentials {self.TOKEN}"}}))
        with self.assertRaises(gv.Fatal) as caught:
            gv.post(self.vertex(server), "gemini-3.8-flash-tts", {}, gv.RateLimiter(60))
        self.assertEqual(len(server.requests), 1)
        self.assertEqual(str(caught.exception), gv.VERTEX_EXPIRED)
        path, headers = server.requests[0]
        self.assertEqual(path, "/v1/projects/proj/locations/global/publishers/google/models/gemini-3.8-flash-tts:generateContent")
        self.assertEqual(headers["Authorization"], f"Bearer {self.TOKEN}")
        self.assertNotIn("x-goog-api-key", {name.lower() for name in headers})

    def test_403_stops_with_the_redacted_error(self):
        server = self.serve((403, {"error": {"code": 403, "message": f"Permission denied for {self.TOKEN}"}}))
        with self.assertRaises(gv.Fatal) as caught:
            gv.post(self.vertex(server), "m", {}, gv.RateLimiter(60))
        self.assertEqual((len(server.requests), caught.exception.code), (1, 403))
        self.assertIn("Permission denied", str(caught.exception))
        self.assertNotIn(self.TOKEN, str(caught.exception))

    def test_retry_logs_and_errors_never_show_the_token(self):
        server = self.serve((503, {"error": {"message": f"overloaded {self.TOKEN}"}}))
        out = io.StringIO()
        with patch.object(gv.time, "sleep"), contextlib.redirect_stdout(out), self.assertRaises(RuntimeError) as caught:
            gv.post(self.vertex(server), "m", {}, gv.RateLimiter(60), attempts=2)
        self.assertEqual(len(server.requests), 2)
        self.assertIn("retry m", out.getvalue())
        self.assertNotIn(self.TOKEN, out.getvalue() + str(caught.exception))

    def test_404_means_the_model_is_missing(self):
        server = self.serve((404, {"error": {"message": "Publisher model not found"}}))
        with self.assertRaises(gv.ModelMissing):
            gv.post(self.vertex(server), "m", {}, gv.RateLimiter(60))

    def test_probe_reports_status_type_and_length(self):
        raw = io.BytesIO()
        with wave.open(raw, "wb") as clip:
            clip.setnchannels(1), clip.setsampwidth(2), clip.setframerate(24000)
            clip.writeframes(b"\0\0" * 12000)
        audio = {"inlineData": {"mimeType": "audio/wav", "data": base64.b64encode(raw.getvalue()).decode()}}
        server = self.serve((200, {"candidates": [{"content": {"parts": [audio]}}]}))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(gv.probe("Puck", "gemini-3.8-flash-tts", self.vertex(server)), 0)
        self.assertIn("HTTP 200, audio/wav, 0.50 s at 24000 Hz", out.getvalue())
        self.assertNotIn(self.TOKEN, out.getvalue())


if __name__ == "__main__":
    unittest.main()
