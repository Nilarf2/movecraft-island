// Camera → pose worker pipeline shared by the big-screen stage and the perf lab.
// Ported from the personal page (web/app.js) and hardened for a kiosk that runs
// unattended: one frame in flight, strictly increasing timestamps, a watchdog that
// restarts whichever part got stuck, and recovery from cameras that are unplugged
// or replugged (track ended, devicechange). Errors are passed through raw; the
// caller turns them into Chinese text with narration.js cameraError().
import {CAMERA_TIMEOUTS} from '../narration.js';

const WORKER_URL = new URL('../pose-worker.js', import.meta.url);
const SEND_INTERVAL = 70;      // ms; at most ≈14 recognitions per second, same pacing as app.js
const VIDEO_TIMEOUT = 10000;   // permission granted but the camera sends no picture
const MODEL_TIMEOUT = 45000;   // first model load on a slow machine
const STALL_MS = 5000;         // no fresh pose for this long: restart the stuck part
const FIRST_POSE_MS = 15000;   // the first inference after a (re)load includes WASM warm-up
const FPS_WINDOW = 2000;
const RETRY_MS = [500, 1000, 2000, 4000, 8000, 15000];
// A remembered or picked camera can be unplugged or busy: fall back to the system default.
const FALLBACK_ERRORS = new Set(['NotReadableError', 'OverconstrainedError', 'NotFoundError', 'AbortError']);
// Before the first success only camera problems that a replug can fix are retried;
// a denied permission or a broken model needs a person, so it stops instead.
const DEVICE_ERRORS = new Set([...FALLBACK_ERRORS, 'CameraTimeout']);
const BLOCKED_ERRORS = new Set(['NotAllowedError', 'SecurityError', 'NotSupportedError']);
const VIRTUAL_CAMERA = /(iriun|droidcam|epoccam|\bcamo\b|obs\s*virtual|virtual\s*cam|manycam|ndi|e2esoft|ivcam|虚拟摄像头)/i;

class StreamError extends Error {
  constructor(name, message) { super(message); this.name = name; }
}
// Our own cancellation (stop, camera switch, restart). Never reported.
class Superseded extends Error {
  constructor() { super('superseded'); this.name = 'Superseded'; }
}

// [{deviceId, label, virtual}]. Before camera permission is granted the browser hides
// ids and labels, so the list is empty then; that does not mean there is no camera.
export async function listCameras() {
  if (!globalThis.navigator?.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'videoinput' && device.deviceId).map((device, index) => (
      {deviceId: device.deviceId, label: device.label || `摄像头 ${index + 1}`, virtual: VIRTUAL_CAMERA.test(device.label)}));
  } catch { return []; }
}

export function createPoseStream({deviceId = '', width = 640, height = 480, onPose, onStatus} = {}) {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
  const s = {
    want: false, generation: 0, ensuring: null, everReady: false, ready: false, attempts: 0, retryTimer: 0, sendTimer: 0, watchTimer: 0,
    state: 'stopped', statusKey: 'stopped|', preferred: deviceId || '', requested: '', fallback: false, activeDeviceId: '', activeLabel: '',
    stream: null, camGen: 0, camAbort: null, camJob: null, camReady: false,
    worker: null, workerGen: 0, workerAbort: null, workerJob: null, workerReady: false,
    inFlight: false, posted: false, flight: 0, inFlightSince: 0, sentAt: 0, lastTs: 0, lastVideoTime: -1, seenVideoTime: -1,
    lastAdvance: 0, lastPose: 0, readyAt: 0, firstPoseAt: 0,
    poseTimes: [], latency: 0, latencyAvg: 0, sent: 0, received: 0, restarts: 0, errors: 0, frameErrors: 0, lastError: null,
  };

  function emit(state, error = null, extra = {}) {
    const key = state + '|' + (error ? `${error.name}:${error.message}` : extra.reason || '');
    if (key === s.statusKey) return;
    s.statusKey = key; s.state = state;
    call(onStatus, {state, error, deviceId: s.activeDeviceId, label: s.activeLabel, fallback: s.fallback, ...extra});
  }

  // ---- camera ----
  function getStream(id) {
    const base = {width: {ideal: width}, height: {ideal: height}, frameRate: {ideal: 24, max: 30}};
    // facingMode is only a hint for phone cameras; it must not fight an explicit choice.
    const constraints = {audio: false, video: id ? {...base, deviceId: {exact: id}} : {...base, facingMode: 'user'}};
    return Promise.resolve().then(() => navigator.mediaDevices.getUserMedia(constraints));
  }
  async function openCamera() {
    closeCamera();
    const gen = s.camGen, abort = s.camAbort = new AbortController();
    const wanted = s.preferred;
    let stream, fallback = false;
    try {
      stream = await guard(getStream(wanted), abort.signal, 0, null, stopTracks);
    } catch (error) {
      if (error instanceof Superseded || !wanted || !FALLBACK_ERRORS.has(error.name)) throw error;
      stream = await guard(getStream(''), abort.signal, 0, null, stopTracks);
      fallback = true;
    }
    if (gen !== s.camGen) { stopTracks(stream); throw new Superseded(); }
    const [track] = stream.getVideoTracks();
    s.stream = stream; s.requested = wanted; s.fallback = fallback;
    s.activeDeviceId = track?.getSettings?.().deviceId || ''; s.activeLabel = track?.label || '';
    track?.addEventListener('ended', () => { if (gen === s.camGen) fault('camera', 'camera-ended'); });
    video.srcObject = stream;
    await guard(video.play(), abort.signal, VIDEO_TIMEOUT, () => new StreamError('CameraTimeout', CAMERA_TIMEOUTS.noVideo.screen));
    if (gen !== s.camGen) throw new Superseded();
    s.camReady = true;
  }
  function closeCamera() {
    s.camGen++; s.camAbort?.abort(); s.camAbort = null;
    s.ready = false; s.camReady = false; s.lastVideoTime = s.seenVideoTime = -1;
    // A grab from this camera is dropped; a frame already in the worker still counts as in flight.
    if (!s.posted) { s.flight++; s.inFlight = false; }
    stopTracks(s.stream); s.stream = null;
    video.srcObject = null;
    s.activeDeviceId = ''; s.activeLabel = '';
  }
  // ---- worker ----
  async function openWorker() {
    closeWorker();
    const gen = s.workerGen, abort = s.workerAbort = new AbortController();
    const worker = s.worker = new Worker(WORKER_URL, {type: 'module'});
    await guard(new Promise((resolve, reject) => {
      worker.onerror = event => { event.preventDefault?.(); reject(new StreamError('ModelError', event.message || '识别模块无法启动。')); };
      worker.onmessage = ({data}) => {
        if (data?.type === 'ready') resolve();
        else if (data?.type === 'error') reject(new StreamError('ModelError', String(data.message || '识别模型加载失败。')));
      };
      worker.postMessage({type: 'init'});
    }), abort.signal, MODEL_TIMEOUT, () => new StreamError('ModelTimeout', CAMERA_TIMEOUTS.model.screen));
    if (gen !== s.workerGen) throw new Superseded();
    worker.onerror = event => { event.preventDefault?.(); if (gen === s.workerGen) fault('model', 'model-crashed'); };
    worker.onmessage = ({data}) => { if (gen === s.workerGen) onResult(data); };
    s.workerReady = true;
  }
  function closeWorker() {
    s.workerGen++; s.workerAbort?.abort(); s.workerAbort = null;
    s.ready = false; s.workerReady = false; s.frameErrors = 0;
    s.flight++; s.inFlight = false; s.posted = false;
    s.worker?.terminate(); s.worker = null;
  }

  // ---- supervisor: bring both parts up, retry with backoff while wanted ----
  // A pending open is reused, so a camera switch during the first model load does not load the model twice.
  function job(key, part, open) {
    if (!s[key]) {
      const promise = s[key] = open().catch(error => { throw {part, error}; }).finally(() => { if (s[key] === promise) s[key] = null; });
    }
    return s[key];
  }
  async function ensure(gen) {
    while (s.want && gen === s.generation && !(s.camReady && s.workerReady)) {
      const jobs = [];
      if (!s.camReady) jobs.push(job('camJob', 'camera', openCamera));
      if (!s.workerReady) jobs.push(job('workerJob', 'model', openWorker));
      try { await Promise.all(jobs); } catch (failure) {
        if (failure?.error instanceof Superseded) continue;
        if (gen !== s.generation || !s.want) return false;
        failed(failure?.part || 'camera', failure?.error ?? failure);
        return false;
      }
    }
    if (!s.want || gen !== s.generation) return false;
    if (!s.ready) becomeReady();
    return true;
  }
  function failed(part, error) {
    s.errors++; s.lastError = error;
    if (part === 'camera') closeCamera(); else closeWorker();
    const retry = !BLOCKED_ERRORS.has(error?.name) && (s.everReady || DEVICE_ERRORS.has(error?.name));
    if (!retry) { teardown(); emit('error', error, {retrying: false}); return; }
    emit('error', error, {retrying: true});
    scheduleRetry();
  }
  function becomeReady() {
    const now = performance.now();
    s.ready = true; s.everReady = true;
    s.readyAt = now; s.lastPose = now; s.lastAdvance = now; s.firstPoseAt = 0; s.poseTimes = [];
    emit('ready');
    tick();
  }
  // Something broke while running: restart only the broken part, keep the rest warm.
  function fault(part, reason) {
    if (!s.want) return;
    s.restarts++;
    if (part === 'camera' || part === 'both') closeCamera();
    if (part === 'model' || part === 'both') closeWorker();
    emit('stalled', null, {reason});
    scheduleRetry();
  }
  function scheduleRetry() {
    clearTimeout(s.retryTimer);
    const delay = RETRY_MS[Math.min(s.attempts++, RETRY_MS.length - 1)];
    s.retryTimer = setTimeout(kick, delay);
  }
  function kick() {
    clearTimeout(s.retryTimer); s.retryTimer = 0;
    if (!s.want) return Promise.resolve(false);
    if (s.ready) return Promise.resolve(true);
    if (!s.ensuring) {
      const gen = s.generation;
      const run = s.ensuring = ensure(gen).finally(() => { if (s.ensuring === run) s.ensuring = null; });
    }
    return s.ensuring;
  }
  function teardown() {
    s.want = false; s.generation++; s.ensuring = null;
    clearTimeout(s.retryTimer); clearTimeout(s.sendTimer); clearInterval(s.watchTimer);
    s.retryTimer = s.sendTimer = s.watchTimer = 0;
    closeCamera(); closeWorker();
    navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  // ---- frames: one in flight, strictly increasing timestamps ----
  function tick() {
    clearTimeout(s.sendTimer); s.sendTimer = 0;
    if (!s.want) return;
    pump();
    s.sendTimer = setTimeout(tick, SEND_INTERVAL);
  }
  function pump() {
    if (!s.ready || document.hidden || video.readyState < 2 || video.paused) return;
    const now = performance.now(), time = video.currentTime;
    if (time !== s.seenVideoTime) { s.seenVideoTime = time; s.lastAdvance = now; }
    if (s.inFlight || time === s.lastVideoTime) return;
    s.lastVideoTime = time;
    const token = ++s.flight, worker = s.worker;
    s.inFlight = true; s.posted = false; s.inFlightSince = now;
    createImageBitmap(video).then(frame => {
      if (token !== s.flight || !s.ready) { frame.close(); if (token === s.flight) s.inFlight = false; return; }
      const sentAt = performance.now();
      // MediaPipe VIDEO mode rejects a timestamp that does not increase.
      const timestamp = s.lastTs = Math.max(sentAt, s.lastTs + 1);
      s.sentAt = sentAt; s.sent++; s.posted = true;
      worker.postMessage({type: 'frame', frame, timestamp}, [frame]);
    }).catch(() => {
      // Grabbing failed (camera switching or gone); the watchdog restarts it if this keeps happening.
      if (token === s.flight) s.inFlight = false;
    });
  }
  function onResult(data) {
    if (data?.type === 'error') {
      s.inFlight = false; s.errors++; s.lastError = new StreamError('ModelError', String(data.message || '识别失败。'));
      // One bad frame is skipped; a crashed WASM instance fails every frame, so restart it.
      if (++s.frameErrors >= 3) fault('model', 'model-error');
      return;
    }
    if (data?.type !== 'pose') return;
    s.inFlight = false; s.frameErrors = 0;
    if (!s.ready) return;
    const now = performance.now();
    s.received++; s.lastPose = now; s.attempts = 0;
    if (!s.firstPoseAt) s.firstPoseAt = now;
    s.poseTimes.push(now);
    s.latency = Number(data.latency) || 0;
    s.latencyAvg = s.latencyAvg ? s.latencyAvg * 0.8 + s.latency * 0.2 : s.latency;
    if (s.state !== 'running') emit('running');
    call(onPose, {landmarks: data.landmarks || [], worldLandmarks: data.worldLandmarks || [], timestamp: data.timestamp, latency: s.latency, fps: fps(now)});
    // A slow result already missed its send slot: send the next frame right away.
    if (s.want && now - s.sentAt >= SEND_INTERVAL) tick();
  }
  // ---- watchdog ----
  function watch() {
    if (!s.want || !s.ready || document.hidden) return;
    const now = performance.now();
    if (s.inFlight && !s.posted && now - s.inFlightSince > STALL_MS) fault('camera', 'grab-stuck');
    else if (s.inFlight && s.posted && now - s.sentAt > (s.firstPoseAt ? STALL_MS : FIRST_POSE_MS)) fault('model', 'model-stuck');
    else if (now - s.lastAdvance > STALL_MS) fault('camera', 'camera-frozen');
    else if (now - s.lastPose > (s.firstPoseAt ? STALL_MS : FIRST_POSE_MS)) fault('both', 'no-pose');
  }
  // Recognitions per second over the last 2 s; 0 until a full window has passed (unknown, not slow).
  function fps(now = performance.now()) {
    while (s.poseTimes.length && now - s.poseTimes[0] > FPS_WINDOW) s.poseTimes.shift();
    if (!s.firstPoseAt || now - s.firstPoseAt < FPS_WINDOW) return 0;
    return Math.round(s.poseTimes.length * 10000 / FPS_WINDOW) / 10;
  }
  async function onDeviceChange() {
    if (!s.want) return;
    const ids = (await listCameras()).map(camera => camera.deviceId);
    if (!s.want) return;
    if (s.camReady && s.activeDeviceId && ids.length && !ids.includes(s.activeDeviceId)) fault('camera', 'camera-lost');
    else if (s.camReady && s.fallback && s.preferred && ids.includes(s.preferred)) switchCamera(s.preferred);
    else if (!s.ready && !s.ensuring) { s.attempts = 0; kick(); }   // a camera was plugged in: retry now
  }
  function onVisibility() {
    if (document.hidden || !s.want) return;
    // Timers are throttled in a hidden tab; give the first fresh frame time to arrive.
    const now = performance.now();
    s.lastPose = s.lastAdvance = s.inFlightSince = s.sentAt = now;
    tick();
  }

  function switchCamera(id = '') {
    s.preferred = id || '';
    if (!s.want) return Promise.resolve(false);
    if (s.camReady && !s.fallback && s.requested === s.preferred) return Promise.resolve(s.ready);
    closeCamera();
    s.attempts = 0;
    emit('starting');
    return kick();
  }
  function stats() {
    return {
      state: s.state, fps: fps(), latency: Math.round(s.latencyAvg), sent: s.sent, received: s.received,
      restarts: s.restarts, errors: s.errors, lastError: s.lastError, inFlight: s.inFlight,
      deviceId: s.activeDeviceId, label: s.activeLabel, fallback: s.fallback, width: video.videoWidth, height: video.videoHeight,
    };
  }
  // Resolves true once camera and model are up, false otherwise. Never rejects; details go to onStatus.
  function start() {
    if (s.want && (s.ready || s.ensuring)) return kick();
    s.statusKey = '';
    if (s.want) { s.attempts = 0; emit('starting'); return kick(); }   // waiting on a retry: try now
    const problem = unsupported();
    if (problem) { s.lastError = problem; emit('error', problem, {retrying: false}); return Promise.resolve(false); }
    s.want = true; s.generation++; s.everReady = false; s.attempts = 0;
    navigator.mediaDevices.addEventListener?.('devicechange', onDeviceChange);
    document.addEventListener('visibilitychange', onVisibility);
    s.watchTimer = setInterval(watch, 1000);
    emit('starting');
    return kick();
  }
  function stop() {
    const active = s.want || s.state !== 'stopped';
    teardown();
    if (active) emit('stopped');
  }
  return {start, stop, switchCamera, video, stats};
}

function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }
// Settle with the operation, a timeout error or Superseded on abort. A value that arrives
// too late is handed to `late` so a camera stream opened after a stop gets closed.
function guard(operation, signal, timeout, makeTimeoutError, late) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => {
      if (done) return false;
      done = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); callback(value); return true;
    };
    const onAbort = () => finish(reject, new Superseded());
    const timer = timeout ? setTimeout(() => finish(reject, makeTimeoutError()), timeout) : 0;
    Promise.resolve(operation).then(value => { if (!finish(resolve, value)) late?.(value); }, error => finish(reject, error));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, {once: true});
  });
}
// A throwing callback must not break the pipeline; report it without swallowing it.
function call(callback, value) {
  if (!callback) return;
  try { callback(value); } catch (error) { setTimeout(() => { throw error; }); }
}
function unsupported() {
  if (globalThis.isSecureContext === false) return new StreamError('SecurityError', '页面不是安全来源，浏览器不允许使用摄像头。');
  if (!navigator.mediaDevices?.getUserMedia || typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') {
    return new StreamError('NotSupportedError', '浏览器无法启用摄像头。请用本地启动程序打开，并使用较新的 Chrome 或 Edge。');
  }
  return null;
}
