#!/usr/bin/env python3
"""Record the island guide's voiceover with Gemini TTS.

Lines come from allVoiceLines() in web/narration.js. Several lines share one request,
separated by pauses; the audio is cut at the pauses that best fit each line's length,
and every clip is transcribed back and compared with the script before it is kept.
Verified clips go to web/audio/voice/ and web/voice-assets.js maps text to them; lines
that fail stay unmapped and the game reads them with device TTS. Reruns only record
lines without a clip, so a run stopped by the daily quota resumes where it left off.

    GEMINI_API_KEY=... python3 scripts/generate_voice.py --voice Puck
    VERTEX_ACCESS_TOKEN=$(gcloud auth print-access-token) \\
        python3 scripts/generate_voice.py --backend vertex --project PROJECT_ID --probe

The vertex backend calls Agent Platform (formerly Vertex AI) with a short-lived OAuth
token. Transcription checks use the same backend; when none of the check models exist
there and GEMINI_API_KEY is set, they fall back to the AI Studio API.
"""
import argparse
import base64
import concurrent.futures as futures
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
CLIPS = ROOT / "web/audio/voice"
ASSETS = ROOT / "web/voice-assets.js"
REPORT = ROOT / "reports/voice-report.json"
STAGE = ROOT / "reports/voice-staged"  # audio whose transcription check failed, kept to save TTS quota
API = "https://generativelanguage.googleapis.com/v1beta/models/"
CHECK_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"]
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("FFPROBE") or shutil.which("ffprobe") or "ffprobe"
PAUSE = " <short pause>"
POST_VERSION = "1"  # bump when cutting or encoding changes so every clip is re-recorded
TARGET_LUFS, PEAK_DB = -16.0, -1.5
NUMERALS = set("零一二两三四五六七八九十百点")


class DailyQuota(Exception):
    """The daily request quota is used up; rerun later to resume."""

class Stopped(Exception):
    """Another batch hit the daily quota; this one was not started."""


class Fatal(Exception):
    """Credentials or project setup are wrong; retrying cannot help, so the run stops."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


class ModelMissing(RuntimeError):
    """HTTP 404: the model is not offered on this backend or location."""


VERTEX_EXPIRED = "令牌过期，请在 Cloud Shell 重新运行 gcloud auth print-access-token"
VERTEX_DENIED = "Agent Platform 拒绝了请求，可能是赠金不覆盖该模型，或项目未启用 Agent Platform（Vertex AI）API"


def load_lines():
    """Every recordable line, exactly as the game builds it."""
    module = (ROOT / "web/narration.js").as_uri()
    code = f"const m = await import({json.dumps(module)}); console.log(JSON.stringify(m.allVoiceLines()));"
    out = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def clip_id(line, voice, model):
    raw = "\n".join([POST_VERSION, model, voice, line["style"], line["text"]])
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def plan_batches(lines, size, max_chars):
    """Counts stay in order (they sound like one set); similar sentences are spread apart."""
    counts = [line for line in lines if line["group"] == "count"]
    others = [line for line in lines if line["group"] != "count"]
    buckets = {}
    for line in others:
        buckets.setdefault(line["text"][:4], []).append(line)
    singles = [items[0] for items in buckets.values() if len(items) == 1]
    families = [items for items in buckets.values() if len(items) > 1] + ([singles] if singles else [])
    placed = []
    for f, items in enumerate(families):
        for i, line in enumerate(items):
            placed.append(((i + 0.5 + f / len(families)) / len(items), line))
    order = [line for _, line in sorted(placed, key=lambda item: item[0])]
    step = 25 if size >= 10 else size  # all counts fit one request until retries shrink the batches
    batches = [counts[i:i + step] for i in range(0, len(counts), step)]
    current, chars = [], 0
    for line in order:
        if current and (len(current) >= size or chars + len(line["text"]) > max_chars):
            batches.append(current)
            current, chars = [], 0
        current.append(line)
        chars += len(line["text"])
    if current:
        batches.append(current)
    return [batch for batch in batches if batch]


FIRST_ROUND = re.compile(r"来十个|各做了十个|^还差[一两三四五六七八九]个")
ROUND_FRAME = {"这一轮全部完成，辛苦啦！", "键鼠试玩结算，不计入真实运动。", "每项的次数和热量都在屏幕上。",
               "每一个动作都算数。好好休息，明天岛上见！"}


def first_round(line):
    """Lines a new island's first day can say (targets start at ten); recorded first."""
    if line["group"] == "stage":
        return line["text"].startswith("继续") or bool(FIRST_ROUND.search(line["text"]))
    if line["group"] == "settlement":
        return line["text"] in ROUND_FRAME or bool(FIRST_ROUND.search(line["text"]))
    return True


def plan(lines, size, max_chars):
    early = [line for line in lines if first_round(line)]
    later = [line for line in lines if not first_round(line)]
    return plan_batches(early, size, max_chars) + plan_batches(later, size, max_chars)


class RateLimiter:
    """At most `per_minute` request starts in any 60-second window."""

    def __init__(self, per_minute):
        self.per_minute, self.starts, self.lock = per_minute, [], threading.Lock()

    def wait(self):
        while True:
            with self.lock:
                now = time.monotonic()
                self.starts = [t for t in self.starts if now - t < 60]
                if len(self.starts) < self.per_minute:
                    self.starts.append(now)
                    return
                delay = 60.5 - (now - self.starts[0])
            time.sleep(max(delay, 0.5))


def redact(text, *secrets):
    """Credentials never reach logs, even if a server or library echoes them back."""
    text = str(text)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    return text


def vertex_host(location):
    # global uses the location-free host; regions such as us-central1 use their regional host.
    return "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"


class Endpoint:
    """Where generateContent requests for one backend go, and how they authenticate."""

    def __init__(self, backend, secret, project=None, location="global", base=None):
        if backend == "vertex" and not project:
            raise ValueError("the vertex backend needs a project ID")
        self.backend, self.secret, self.project, self.location = backend, secret, project, location
        self.base = base or (API if backend == "gemini" else f"https://{vertex_host(location)}/v1/")

    def url(self, model):
        if self.backend == "gemini":
            return f"{self.base}{model}:generateContent"
        return (f"{self.base}projects/{self.project}/locations/{self.location}"
                f"/publishers/google/models/{model}:generateContent")

    def headers(self):
        auth = {"x-goog-api-key": self.secret} if self.backend == "gemini" else {"Authorization": f"Bearer {self.secret}"}
        return {"Content-Type": "application/json", **auth}


class Route:
    """Transcription checks: the TTS backend first, then AI Studio if no check model exists there."""

    def __init__(self, primary, fallback=None):
        self.primary, self.fallback, self.use_fallback = primary, fallback, False

    def attempts(self, models, body, limiter, errors):
        endpoints = [self.fallback] if self.use_fallback else [self.primary]
        while endpoints:
            endpoint, missing = endpoints.pop(0), 0
            for model in models:
                try:
                    yield model, post(endpoint, model, body, limiter, attempts=2, timeout=90)
                except ModelMissing as error:
                    missing += 1
                    errors.append(str(error)[:160])
                except (DailyQuota, RuntimeError) as error:
                    errors.append(str(error)[:160])
            if missing == len(models) and endpoint is self.primary and self.fallback:
                print(f"  check models are not on {endpoint.backend}; checking with AI Studio instead", flush=True)
                self.use_fallback = True
                endpoints.append(self.fallback)


def post(endpoint, model, body, limiter, attempts=6, timeout=240):
    """generateContent with retries. Credentials travel only in headers and never reach logs."""
    request = json.dumps(body).encode()
    vertex = endpoint.backend == "vertex"
    for attempt in range(attempts):
        limiter.wait()
        req = urllib.request.Request(endpoint.url(model), data=request, method="POST", headers=endpoint.headers())
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read() or b"{}").get("error", {})
            except ValueError:
                detail = {}
            finally:
                error.close()
            text = redact(json.dumps(detail, ensure_ascii=False), endpoint.secret)
            message = redact(detail.get("message", ""), endpoint.secret)[:400]
            if error.code == 401:
                raise Fatal(VERTEX_EXPIRED if vertex else "API 密钥无效，请检查 GEMINI_API_KEY", 401) from None
            if error.code == 404:
                raise ModelMissing(f"{model}: HTTP 404 {message[:200]}") from None
            if vertex and error.code in (400, 403):
                raise Fatal(f"{VERTEX_DENIED}。HTTP {error.code}: {message}", error.code) from None
            if error.code == 429:
                quotas = re.findall(r'"quotaId": "([^"]+)"', text)
                if any("PerDay" in quota for quota in quotas):
                    raise DailyQuota(f"{model}: {', '.join(quotas)}") from None
                delay = re.search(r'"retryDelay": "(\d+(?:\.\d+)?)s"', text)
                wait = float(delay.group(1)) + 1 if delay else 15 * (attempt + 1)
            elif error.code in (500, 502, 503, 504):
                wait = 10 * (attempt + 1)
            else:
                raise RuntimeError(f"{model}: HTTP {error.code} {message[:300]}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            wait = 10 * (attempt + 1)
            text = redact(error, endpoint.secret)
        if attempt + 1 < attempts:
            print(f"  retry {model} in {wait:.0f}s ({text[:120]})", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"{model}: gave up after {attempts} attempts")


def tts_body(batch, voice, backend):
    """Gemini API keeps the request shape verified on AI Studio; Agent Platform uses its documented REST form."""
    vertex = backend == "vertex"
    style_key = "speechMetadata" if vertex else "speech_metadata"
    parts = [{"text": line["text"] + (PAUSE if i + 1 < len(batch) else ""), style_key: {"style": line["style"]}}
             for i, line in enumerate(batch)]
    voice_config = {"voice": voice} if vertex else {"prebuiltVoiceConfig": {"voiceName": voice}}
    return {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {"voiceConfig": voice_config}}}


def decode_audio(data, model):
    """Returns (16-bit mono PCM frames, sample rate, mime type) from a generateContent response."""
    chunks = [part["inlineData"] for candidate in data.get("candidates", [])
              for part in candidate.get("content", {}).get("parts", []) if "inlineData" in part]
    if not chunks:
        raise RuntimeError(f"{model}: no audio in response ({json.dumps(data)[:200]})")
    frames, rate = b"", 24000
    for chunk in chunks:
        raw = base64.b64decode(chunk["data"])
        if raw[:4] == b"RIFF":
            with wave.open(io.BytesIO(raw)) as source:
                if source.getnchannels() != 1 or source.getsampwidth() != 2:
                    raise RuntimeError("unexpected WAV format from TTS")
                rate, raw = source.getframerate(), source.readframes(source.getnframes())
        else:  # headerless 16-bit PCM from older models
            match = re.search(r"rate=(\d+)", chunk.get("mimeType", ""))
            rate = int(match.group(1)) if match else rate
        frames += raw
    return frames, rate, chunks[0].get("mimeType", "")


def synthesize(batch, voice, model, endpoint, limiter, target):
    try:
        data = post(endpoint, model, tts_body(batch, voice, endpoint.backend), limiter)
    except ModelMissing as error:  # every batch would fail the same way
        raise Fatal(f"{error}；检查 --model 和 --location", 404) from None
    frames, rate, _ = decode_audio(data, model)
    with wave.open(str(target), "wb") as out:
        out.setnchannels(1), out.setsampwidth(2), out.setframerate(rate)
        out.writeframes(frames)


def probe(voice, model, endpoint):
    """One TTS request for 「五！」: prints status, audio type and length, saves nothing."""
    line = {"text": "五！", "style": "短促有力的报数，像教练喊口令，节奏感强"}
    where = f"{endpoint.backend} {endpoint.location if endpoint.backend == 'vertex' else ''}".strip()
    started = time.monotonic()
    try:
        data = post(endpoint, model, tts_body([line], voice, endpoint.backend), RateLimiter(60), attempts=3)
        frames, rate, mime = decode_audio(data, model)
    except (Fatal, RuntimeError) as error:
        code = getattr(error, "code", None) or (404 if isinstance(error, ModelMissing) else "error")
        print(f"probe {where} {model}: HTTP {code} — {redact(error, endpoint.secret)}")
        return 1
    print(f"probe {where} {model} {voice}: HTTP 200, {mime or 'unknown mime'}, {len(frames) / 2 / rate:.2f} s "
          f"at {rate} Hz, {time.monotonic() - started:.1f} s round trip")
    return 0

def ffmpeg(*args):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def analyze(path, filters):
    out = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-af", filters, "-f", "null", "-"],
                         capture_output=True, text=True, check=True)
    return out.stderr


def duration(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def silences(path, total):
    """Pauses quieter than -38 dB for at least 0.1 s; near-touching pauses are merged."""
    log = analyze(path, "silencedetect=noise=-38dB:d=0.1")
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", log)]
    gaps = [[max(start, 0.0), ends[i] if i < len(ends) else total] for i, start in enumerate(starts)]
    merged = []
    for gap in gaps:
        if merged and gap[0] - merged[-1][1] < 0.08:
            merged[-1][1] = gap[1]
        else:
            merged.append(gap)
    return [tuple(gap) for gap in merged]


def pick_cuts(gaps, weights, start, end, cost=0.25):
    """Choose one pause per line boundary: long pauses win, and each line's span should match
    its share of the speech (by characters), so a long comma pause is not mistaken for a boundary."""
    need = len(weights) - 1
    if need == 0:
        return []
    if len(gaps) < need:
        return None
    longest = sorted((b - a for a, b in gaps), reverse=True)[:need]
    rate = max(end - start - sum(longest), 0.1) / sum(weights)

    def miss(index, begin, finish):
        return cost * abs((finish - begin) - weights[index] * rate)

    best = [[None] * len(gaps) for _ in range(need)]
    back = [[None] * len(gaps) for _ in range(need)]
    for g, (a, b) in enumerate(gaps):
        best[0][g] = (b - a) - miss(0, start, a)
    for k in range(1, need):
        for g, (a, b) in enumerate(gaps):
            options = [(best[k - 1][h] - miss(k, gaps[h][1], a), h)
                       for h in range(g) if best[k - 1][h] is not None]
            if options:
                score, h = max(options)
                best[k][g], back[k][g] = score + (b - a), h
    final = [(best[need - 1][g] - miss(need, gaps[g][1], end), g)
             for g in range(len(gaps)) if best[need - 1][g] is not None]
    if not final:
        return None
    g = max(final)[1]
    chosen = [g]
    for k in range(need - 1, 0, -1):
        g = back[k][g]
        chosen.append(g)
    return [gaps[g] for g in reversed(chosen)]

def batch_gain(path):
    """One linear gain per request toward -16 LUFS, capped so the true peak stays under -1.5 dBTP."""
    log = analyze(path, "loudnorm=I=-16:TP=-1.5:print_format=json")
    stats = json.loads(log[log.rindex("{"):log.rindex("}") + 1])
    loudness, peak = float(stats["input_i"]), float(stats["input_tp"])
    if not -70 < loudness < 0:
        return 0.0
    return max(-20.0, min(TARGET_LUFS - loudness, PEAK_DB - peak, 20.0))


def cut(wav, batch, workdir, gain):
    """Split one request's audio into a clip per line, or None if the pauses do not fit."""
    total = duration(wav)
    gaps = silences(wav, total)
    lead = gaps[0] if gaps and gaps[0][0] <= 0.05 else None
    tail = gaps[-1] if gaps and gaps[-1][1] >= total - 0.05 and gaps[-1] is not lead else None
    inner = [gap for gap in gaps if gap is not lead and gap is not tail]
    start, end = (lead[1] if lead else 0.0), (tail[0] if tail else total)
    cuts = pick_cuts(inner, [max(len(line["text"]), 1) for line in batch], start, end)
    if cuts is None:
        return None
    bounds = [start] + [x for gap in cuts for x in gap] + [end]
    paths = []
    for i, line in enumerate(batch):
        before = min(0.06, (cuts[i - 1][1] - cuts[i - 1][0]) / 2) if i > 0 else 0.06
        after = min(0.08, (cuts[i][1] - cuts[i][0]) / 2) if i < len(cuts) else 0.08
        a, b = max(bounds[2 * i] - before, 0.0), min(bounds[2 * i + 1] + after, total)
        out, length = workdir / f"{i:02d}.mp3", b - a
        ffmpeg("-ss", f"{a:.3f}", "-t", f"{length:.3f}", "-i", str(wav), "-af",
               f"volume={gain:.2f}dB,afade=t=in:d=0.02,afade=t=out:st={max(length - 0.04, 0):.3f}:d=0.04",
               "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", str(out))
        paths.append(out)
    return paths


def verify(paths, lines, route, limiter, workdir):
    """Stitch the clips with long pauses, transcribe once, and classify each line.
    A stronger model re-checks only when a line looks like it needs re-recording."""
    inputs, chain = [], ""
    for i, path in enumerate(paths):
        inputs += ["-i", str(path)]
        chain += f"[{i}:a]apad=pad_dur=1.5[a{i}];"
    chain += "".join(f"[a{i}]" for i in range(len(paths))) + f"concat=n={len(paths)}:v=0:a=1[o]"
    stitched = workdir / "stitched.mp3"
    ffmpeg(*inputs, "-filter_complex", chain, "-map", "[o]", "-ar", "24000", "-ac", "1", "-b:a", "64k", str(stitched))
    prompt = (f"这段普通话音频由 {len(paths)} 句话组成，句与句之间有较长停顿。逐字转写，不要纠正、补全或润色，"
              f"数字写成汉字。每句一行，格式「序号. 文字」，从 1 到 {len(paths)}，不要输出其他内容。")
    body = {"contents": [{"role": "user", "parts": [
        {"inlineData": {"mimeType": "audio/mp3", "data": base64.b64encode(stitched.read_bytes()).decode()}},
        {"text": prompt}]}]}
    rank = {"ok": 2, "review": 1, "redo": 0}
    best = [("redo", "")] * len(paths)
    errors = []
    for model, data in route.attempts(CHECK_MODELS, body, limiter, errors):
        try:
            text = "".join(part.get("text", "") for part in data["candidates"][0]["content"]["parts"])
        except (KeyError, IndexError) as error:
            errors.append(f"{model}: unexpected response ({error})")
            continue
        for i, heard in enumerate(parse_numbered(text, len(paths))):
            status = classify(lines[i]["text"], heard)
            if rank[status] > rank[best[i][0]]:
                best[i] = (status, heard)
        if all(status != "redo" for status, _ in best):
            return best
    if not any(heard for _, heard in best):
        raise RuntimeError("transcription failed: " + "; ".join(errors))
    return best


def parse_numbered(text, n):
    heard = [""] * n
    for match in re.finditer(r"^\s*(\d+)\s*[.、．:：)）]\s*(.*)$", text, re.M):
        index = int(match.group(1)) - 1
        if 0 <= index < n and not heard[index]:
            heard[index] = match.group(2).strip()
    return heard

def chinese(number):
    digits = "零一二三四五六七八九"
    if number < 10:
        return digits[number]
    if number < 100:
        tens = "十" if number < 20 else digits[number // 10] + "十"
        return tens + (digits[number % 10] if number % 10 else "")
    return str(number)


def normalize(text):
    """Compare by spoken content: digits become Chinese numerals, punctuation and spaces drop."""
    text = re.sub(r"(\d+)\s*%", lambda m: "百分之" + chinese(int(m.group(1))), text)
    text = re.sub(r"(\d+)\.5", lambda m: chinese(int(m.group(1))) + "点五", text)
    text = re.sub(r"\d+", lambda m: chinese(int(m.group())), text)
    return re.sub(r"[\W_]+", "", text)


def classify(expected, heard):
    """ok: the transcript agrees. review: numbers agree but some words were heard differently
    (transcribers often mishear 摘椰子 and similar), so keep the clip and list it for a listen.
    redo: numbers differ, the line is missing, or most of it does not match."""
    a, b = (normalize(text).replace("两", "二") for text in (expected, heard))
    if a == b:
        return "ok"
    if not b or [c for c in a if c in NUMERALS] != [c for c in b if c in NUMERALS]:
        return "redo"
    ratio = difflib.SequenceMatcher(None, a, b).ratio()
    return "ok" if ratio >= 0.85 else "review" if ratio >= 0.5 else "redo"


def plausible(text, seconds):
    """Catches clips cut in the wrong place even when the transcript looks right."""
    chars = len(normalize(text))
    return 0.12 + chars * 0.06 <= seconds <= 2.5 + chars * 0.5


def record(batch, voice, model, tts, route, limits, stop):
    """One TTS request → per-line clips; clips not marked redo are saved. Returns (status, heard, seconds)."""
    if stop.is_set():
        raise Stopped()
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        wav = workdir / "batch.wav"
        try:
            synthesize(batch, voice, model, tts, limits["tts"], wav)
        except (DailyQuota, Fatal):
            stop.set()
            raise
        paths = cut(wav, batch, workdir, batch_gain(wav))
        if paths is None:
            return [("redo", "pauses did not match the lines", 0.0)] * len(batch)
        try:
            checked = verify(paths, batch, route, limits["check"], workdir)
        except (RuntimeError, Fatal) as error:
            # Keep the audio when only the check failed; the next run verifies it without a TTS request.
            STAGE.mkdir(parents=True, exist_ok=True)
            for line, path in zip(batch, paths):
                shutil.copyfile(path, STAGE / (line["id"] + ".mp3"))
            if isinstance(error, Fatal):
                stop.set()
            raise
        results = []
        for line, path, (status, heard) in zip(batch, paths, checked):
            seconds = duration(path)
            if not plausible(line["text"], seconds):
                status = "redo"
            if status != "redo":
                part = CLIPS / (line["id"] + ".part")
                shutil.copyfile(path, part)
                part.replace(CLIPS / (line["id"] + ".mp3"))
            results.append((status, heard, round(seconds, 2)))
        return results

def write_assets(lines, clips=CLIPS, target=ASSETS):
    """Map exact spoken text to the recorded clip; lines without one are left to device TTS."""
    entries = [(line["text"], f"audio/voice/{line['id']}.mp3") for line in lines if (clips / f"{line['id']}.mp3").is_file()]
    body = "".join(f"  {json.dumps(text, ensure_ascii=False)}: {json.dumps(path)},\n" for text, path in entries)
    target.write_text("// Generated by scripts/generate_voice.py. Maps exact spoken text to recorded clips.\n"
                      "// Lines without a clip fall back to device TTS.\n"
                      "export const VOICE_ASSETS = {" + ("\n" + body if body else "") + "};\n", encoding="utf-8")
    return len(entries)


def rescue_staged(lines, route, limits):
    """Check audio kept from runs where only the transcriber failed, without new TTS requests."""
    staged = [line for line in lines if (STAGE / f"{line['id']}.mp3").is_file()
              and not (CLIPS / f"{line['id']}.mp3").is_file()]
    for i in range(0, len(staged), 14):
        batch = staged[i:i + 14]
        paths = [STAGE / f"{line['id']}.mp3" for line in batch]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                checked = verify(paths, batch, route, limits["check"], Path(tmp))
        except RuntimeError as error:
            print(f"  staged audio still unchecked: {str(error)[:160]}", flush=True)
            continue
        for line, path, (status, heard) in zip(batch, paths, checked):
            if status != "redo" and plausible(line["text"], duration(path)):
                shutil.copyfile(path, CLIPS / (line["id"] + ".part"))
                (CLIPS / (line["id"] + ".part")).replace(CLIPS / (line["id"] + ".mp3"))
                line.update(heard=heard, status=status)
            path.unlink()
        print(f"  staged audio checked: {sum((CLIPS / (x['id'] + '.mp3')).is_file() for x in batch)}/{len(batch)} kept", flush=True)


def run(args, tts=None, route=None):
    lines = load_lines()
    for line in lines:
        line["id"] = clip_id(line, args.voice, args.model)
    CLIPS.mkdir(parents=True, exist_ok=True)
    pending = [line for line in lines if not (CLIPS / f"{line['id']}.mp3").is_file()]
    print(f"{len(lines)} lines, {len(lines) - len(pending)} already recorded, {len(pending)} to record", flush=True)
    if args.dry_run:
        for i, batch in enumerate(plan(pending, args.batch, args.max_chars), 1):
            print(f"batch {i}: {len(batch)} lines, {sum(len(x['text']) for x in batch)} chars")
        return 0
    limits = {"tts": RateLimiter(args.rpm), "check": RateLimiter(args.rpm)}
    stop, fatal = threading.Event(), None
    try:
        rescue_staged(lines, route, limits)
    except Fatal as error:
        stop.set()
        fatal = error
        print(f"stopped: {redact(error, tts.secret, route.fallback and route.fallback.secret)}", flush=True)
    pending = [line for line in lines if not (CLIPS / f"{line['id']}.mp3").is_file()]
    for size in sorted({args.batch, max(args.batch // 3, 2), 1}, reverse=True):
        if not pending or stop.is_set():
            break
        batches, pending = plan(pending, size, args.max_chars), []
        print(f"round: {len(batches)} requests of up to {size} lines", flush=True)
        with futures.ThreadPoolExecutor(args.workers) as pool:
            jobs = {pool.submit(record, batch, args.voice, args.model, tts, route, limits, stop): batch
                    for batch in batches}
            for job in futures.as_completed(jobs):
                batch = jobs[job]
                try:
                    results = job.result()
                except (DailyQuota, Stopped) as error:
                    if isinstance(error, DailyQuota):
                        print(f"daily quota reached: {error}", flush=True)
                    pending += batch
                    continue
                except Fatal as error:
                    if fatal is None:
                        print(f"stopped: {redact(error, tts.secret, route.fallback and route.fallback.secret)}", flush=True)
                    fatal = error
                    pending += batch
                    continue
                except Exception as error:  # one bad batch must not stop the others
                    print(f"  batch failed: {str(error)[:200]}", flush=True)
                    for line in batch:
                        line["note"] = str(error)[:200]
                    pending += batch
                    continue
                for line, (status, heard, seconds) in zip(batch, results):
                    line.update(heard=heard, seconds=seconds, status=status)
                    line.pop("note", None)
                    if status == "redo":
                        line["note"] = f"heard {heard!r} in {seconds}s"
                        pending.append(line)
                saved = sum(status != "redo" for status, _, _ in results)
                print(f"  {saved}/{len(batch)} saved; {sum((CLIPS / (x['id'] + '.mp3')).is_file() for x in lines)}/{len(lines)} recorded",
                      flush=True)
    mapped = write_assets(lines)
    ids = {line["id"] for line in lines}
    if args.prune:
        for path in CLIPS.glob("*"):
            if path.stem not in ids or path.suffix != ".mp3":
                path.unlink()
    missing = [line for line in lines if not (CLIPS / f"{line['id']}.mp3").is_file()]
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    review = [line["text"] for line in lines if line.get("status") == "review"]
    REPORT.write_text(json.dumps({"voice": args.voice, "model": args.model, "mapped": mapped, "missing": len(missing),
                                  "review": review, "lines": lines}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"voice-assets.js: {mapped}/{len(lines)} lines recorded; {len(missing)} use device TTS; "
          f"{len(review)} to listen to (transcript differed). Report: {REPORT}")
    return 3 if fatal else 0 if not missing else 2

def api_key(key_file, required=True):
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key and key_file:
        key = Path(key_file).read_text().strip()
    if not key and required:
        sys.exit("Set GEMINI_API_KEY or pass --key-file (an AI Studio API key).")
    return key


def vertex_token(token_file):
    token = os.environ.get("VERTEX_ACCESS_TOKEN", "").strip()
    if not token and token_file:
        token = Path(token_file).read_text().strip()
    if not token:
        sys.exit("Set VERTEX_ACCESS_TOKEN or pass --token-file; in Cloud Shell run: gcloud auth print-access-token")
    return token


def endpoints(args):
    """TTS endpoint plus the check route. On vertex, an AI Studio key (optional) is the check fallback."""
    if args.backend == "gemini":
        tts = Endpoint("gemini", api_key(args.key_file))
        return tts, Route(tts)
    project = args.project or os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    if not project:
        sys.exit("The vertex backend needs --project (or GOOGLE_CLOUD_PROJECT).")
    tts = Endpoint("vertex", vertex_token(args.token_file), project, args.location)
    key = api_key(args.key_file, required=False)
    return tts, Route(tts, Endpoint("gemini", key) if key else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--voice", default="Puck", help="prebuilt Gemini voice")
    parser.add_argument("--model", default="gemini-3.8-flash-tts")
    parser.add_argument("--backend", choices=["gemini", "vertex"], default="gemini",
                        help="gemini: AI Studio API key; vertex: Agent Platform with an OAuth access token")
    parser.add_argument("--project", help="Google Cloud project ID for --backend vertex")
    parser.add_argument("--location", default="global", help="Agent Platform location for --backend vertex")
    parser.add_argument("--token-file", help="file holding the OAuth token, used when VERTEX_ACCESS_TOKEN is unset")
    parser.add_argument("--key-file", help="file holding the API key, used when GEMINI_API_KEY is unset")
    parser.add_argument("--probe", action="store_true", help="send one short TTS request and report the result")
    parser.add_argument("--batch", type=int, default=14, help="lines per request in the first round")
    parser.add_argument("--max-chars", type=int, default=420, help="characters per request")
    parser.add_argument("--rpm", type=int, default=4, help="request starts per minute for each model")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--dry-run", action="store_true", help="show the plan without calling the API")
    parser.add_argument("--prune", action="store_true", help="delete clips no longer in the script")
    args = parser.parse_args()
    if args.dry_run:
        return run(args)
    tts, route = endpoints(args)
    if args.probe:
        return probe(args.voice, args.model, tts)
    return run(args, tts, route)


if __name__ == "__main__":
    sys.exit(main())
