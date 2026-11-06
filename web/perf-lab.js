import * as THREE from 'three';
import {createWorld} from './stage/world.js';
import * as poseModule from './stage/pose-stream.js';
import * as qualityModule from './stage/quality.js';
import * as islandModule from './world/island.js';
import * as avatarModule from './world/avatar.js';

const $ = id => document.getElementById(id);
const TIERS = ['low', 'medium', 'high'];
const TIER_NAMES = {low: '低', medium: '中', high: '高'};
const smokeMode = new URLSearchParams(location.search).get('smoke') === '1';
const TIER_MS = smokeMode ? 500 : 20_000;
const SETTLE_MS = smokeMode ? 100 : 2_000;
const CAMERA_WARM_MS = smokeMode ? 200 : 5_000;
const ui = {
  cameraField: $('cameraField'), camera: $('cameraSelect'), start: $('startButton'), stop: $('stopButton'), copy: $('copyButton'),
  modes: [...document.querySelectorAll('input[name="testMode"]')], state: $('stateLabel'), detail: $('detailStatus'), phase: $('phaseLabel'), mode: $('modeBadge'),
  fps: $('fpsValue'), frame: $('frameValue'), pose: $('poseValue'), latency: $('latencyValue'), quality: $('qualityValue'), renderMode: $('renderMode'),
  progress: $('progressBar'), capture: $('captureValue'), environment: $('environmentValue'), browser: $('browserValue'), gpu: $('gpuValue'),
  tiers: Object.fromEntries(TIERS.map(tier => [tier, {root: document.querySelector(`[data-tier="${tier}"]`), fps: $(`${tier}Fps`), pose: $(`${tier}Pose`), frame: $(`${tier}Frame`)}])),
};

let state = 'idle';
let stream = null;
let run = null;
let runToken = 0;
let lastFrame = performance.now();
let lastStatsAt = 0;
let cachedPoseFps = 0;
let last2dCheck = 0;
let last2dChange = 0;
let last2dPixels = null;
const thumb = document.createElement('canvas');
thumb.width = 48; thumb.height = 27;
const thumbContext = thumb.getContext('2d', {willReadFrequently: true});

const world = createWorld({canvas: $('world'), canvas2d: $('world2d'), THREE, islandModule, avatarModule, qualityModule,
  onFallback: error => {
    const detail = `3D 渲染已停止：${error?.message || '渲染错误'}`;
    if (['starting', 'warming', 'measuring'].includes(state)) finishTest('error', detail);
    else setStatus('error', detail);
  }});
world.focus(0);
world.demo('wave');
world.attract(true);

function selectedMode() { return ui.modes.find(input => input.checked)?.value || 'render'; }
function modeName() { return world.mode === '3d' ? 'WebGL 3D' : '2D 回退'; }
function browserInfo() {
  const ua = navigator.userAgent;
  let browser = '未知浏览器';
  let match;
  if ((match = ua.match(/Edg\/([\d.]+)/))) browser = `Microsoft Edge ${match[1]}`;
  else if ((match = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/))) browser = `Chrome ${match[1]}`;
  else if ((match = ua.match(/Firefox\/([\d.]+)/))) browser = `Firefox ${match[1]}`;
  else if ((match = ua.match(/Version\/([\d.]+).*Safari/))) browser = `Safari ${match[1]}`;
  return {name: browser, userAgent: ua, platform: navigator.userAgentData?.platform || navigator.platform || 'unknown'};
}
function gpuInfo() {
  if (world.mode !== '3d') return {vendor: null, renderer: '2D canvas（WebGL 不可用或已回退）'};
  try {
    const gl = $('world').getContext('webgl2');
    if (!gl) return {vendor: null, renderer: 'WebGL 2 renderer unavailable'};
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: gl.getParameter(extension?.UNMASKED_VENDOR_WEBGL || gl.VENDOR) || 'unknown',
      renderer: gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) || 'unknown',
    };
  } catch { return {vendor: null, renderer: 'WebGL renderer unavailable'}; }
}
const browser = browserInfo();
const gpu = gpuInfo();
function updateEnvironment() {
  const label = `${screen.width} × ${screen.height} · ${innerWidth} × ${innerHeight} · DPR ${globalThis.devicePixelRatio || 1}`;
  ui.mode.textContent = modeName();
  ui.environment.textContent = `屏幕 ${label}`;
  ui.environment.title = label;
  ui.browser.textContent = `${browser.name} · ${browser.platform}`;
  ui.browser.title = browser.userAgent;
  ui.gpu.textContent = gpu.renderer;
  ui.gpu.title = `${gpu.vendor || '无 WebGL vendor'} · ${gpu.renderer}`;
  ui.renderMode.textContent = world.mode === '3d' ? '渲染路径 WebGL 2' : '渲染路径 2D 画面变化采样';
}
updateEnvironment();
window.addEventListener('resize', updateEnvironment);

function updateModeUi() {
  const cameraMode = selectedMode() === 'camera';
  ui.cameraField.hidden = !cameraMode;
  ui.camera.disabled = !cameraMode || !stream || ui.camera.options.length <= 1 || isBusy();
}
function isBusy() { return ['starting', 'warming', 'measuring'].includes(state); }
function setStatus(next, detail = '') {
  state = next;
  document.body.dataset.state = next;
  const stateNames = {idle: '准备就绪', starting: '正在启动', warming: '切换画质', measuring: '正在测试', done: '测试完成', stopped: '已停止', error: '需要处理'};
  ui.state.textContent = stateNames[next] || stateNames.idle;
  ui.detail.textContent = detail || stateNames[next] || '';
  ui.phase.textContent = run && next !== 'done' ? `${TIER_NAMES[TIERS[run.tierIndex]]} · ${run.tierIndex + 1}/3` : (next === 'done' ? '3/3 完成' : '未开始');
  ui.start.disabled = isBusy();
  ui.stop.disabled = !isBusy();
  ui.modes.forEach(input => { input.disabled = isBusy(); });
  updateModeUi();
  if (next === 'done') ui.copy.disabled = false;
  else ui.copy.disabled = true;
}
function errorText(error) {
  const names = {
    NotAllowedError: '摄像头权限被拒绝', SecurityError: '当前来源不能使用摄像头', NotFoundError: '没有找到摄像头',
    NotReadableError: '摄像头正被其他程序占用', OverconstrainedError: '所选摄像头不可用', NotSupportedError: '浏览器不支持摄像头识别',
    ModelTimeout: '识别模型加载超时', ModelError: '识别模型启动失败', CameraTimeout: '摄像头没有画面',
  };
  return names[error?.name] || error?.message || '启动失败，请重试';
}

function clearTierRows() {
  for (const tier of TIERS) {
    const row = ui.tiers[tier];
    row.root.dataset.active = 'false';
    row.fps.textContent = '--'; row.pose.textContent = '--'; row.frame.textContent = '-- / --';
  }
}
function updateCameraOptions(cameras) {
  const selected = stream?.stats().deviceId || '';
  ui.camera.replaceChildren(new Option('系统默认', ''));
  for (const camera of cameras) {
    const option = new Option(`${camera.label}${camera.virtual ? ' · 虚拟' : ''}`, camera.deviceId);
    option.selected = camera.deviceId === selected;
    ui.camera.add(option);
  }
  if (!cameras.some(camera => camera.deviceId === selected)) ui.camera.value = '';
  updateModeUi();
}
function makeStream() {
  stream = poseModule.createPoseStream({
    deviceId: ui.camera.value,
    width: 640,
    height: 480,
    onPose: ({landmarks, worldLandmarks, timestamp}) => world.pose(landmarks, worldLandmarks, timestamp),
    onStatus: ({state: streamState, error, retrying}) => {
      if (streamState === 'error' && error && isBusy()) ui.detail.textContent = `${errorText(error)}${retrying ? ' · 正在重试' : ''}`;
    },
  });
  return stream;
}

function queueTier(index, now, warmMs = SETTLE_MS) {
  run.tierIndex = index;
  run.tierFrames = [];
  run.poseFps = [];
  run.latency = [];
  run.warmUntil = now + warmMs;
  run.startedAt = 0;
  last2dCheck = last2dChange = 0;
  last2dPixels = null;
  world.setQuality(TIERS[index]);
  ui.tiers[TIERS[index]].root.dataset.active = 'true';
  ui.quality.textContent = TIER_NAMES[TIERS[index]];
  updateEnvironment();
  ui.progress.style.width = `${index / TIERS.length * 100}%`;
  setStatus('warming', `${TIER_NAMES[TIERS[index]]}画质准备中`);
}

async function startTest(token) {
  const mode = selectedMode();
  window.__perfReport = null;
  ui.copy.disabled = true;
  ui.progress.style.width = '0%';
  clearTierRows();
  for (const element of [ui.fps, ui.frame, ui.pose, ui.latency]) element.textContent = '--';
  ui.capture.textContent = mode === 'camera' ? '采集尺寸 --' : '无摄像头';
  world.attract(false);
  world.focus(0);
  world.demo('wave');
  run = {mode, tierIndex: 0, tiers: [], durationMs: TIER_MS, cameraResolution: null};
  if (mode === 'camera') {
    setStatus('starting', '正在开启摄像头与识别模型');
    const active = stream || makeStream();
    const ready = await active.start();
    if (token !== runToken) return;
    if (!ready) {
      run = null;
      setStatus('error', errorText(active.stats().lastError));
      return;
    }
    updateCameraOptions(await poseModule.listCameras());
    queueTier(0, performance.now(), CAMERA_WARM_MS + SETTLE_MS);
  } else {
    cachedPoseFps = 0;
    if (stream) { stream.stop(); stream = null; }
    setStatus('warming', '低画质准备中');
    queueTier(0, performance.now());
  }
}

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function summarizeTier(frames, poseFps, latency) {
  const duration = frames.reduce((sum, frame) => sum + frame, 0);
  const averageFps = frames.length && duration ? frames.length * 1000 / duration : 0;
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    averageFps: Number(averageFps.toFixed(1)),
    p50FrameMs: quantile(frames, 0.5) == null ? null : Number(quantile(frames, 0.5).toFixed(1)),
    p95FrameMs: quantile(frames, 0.95) == null ? null : Number(quantile(frames, 0.95).toFixed(1)),
    poseFps: mean(poseFps) == null ? null : Number(mean(poseFps).toFixed(1)),
    inferenceLatencyMs: mean(latency) == null ? null : Math.round(mean(latency)),
  };
}
function showTier(tier, data) {
  const row = ui.tiers[tier];
  row.fps.textContent = data.averageFps ? data.averageFps.toFixed(1) : '--';
  row.pose.textContent = data.poseFps == null ? (run?.mode === 'render' ? '无摄像头' : '--') : data.poseFps.toFixed(1);
  row.frame.textContent = data.p50FrameMs == null ? '-- / --' : `${data.p50FrameMs} / ${data.p95FrameMs}`;
}
function sample2dFrame(now) {
  if (now - last2dCheck < 30) return;
  last2dCheck = now;
  const canvas = $('world2d');
  thumbContext.clearRect(0, 0, thumb.width, thumb.height);
  thumbContext.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  const pixels = thumbContext.getImageData(0, 0, thumb.width, thumb.height).data;
  if (last2dPixels) {
    let changed = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const delta = Math.abs(pixels[i] - last2dPixels[i]) + Math.abs(pixels[i + 1] - last2dPixels[i + 1]) + Math.abs(pixels[i + 2] - last2dPixels[i + 2]);
      if (delta > 12) changed++;
    }
    if (changed >= 4 && last2dChange) {
      const interval = now - last2dChange;
      if (interval > 0 && interval < 1000) run.tierFrames.push(interval);
      last2dChange = now;
    }
  } else last2dChange = now;
  last2dPixels = new Uint8ClampedArray(pixels);
}
function recordTier(now, dt) {
  if (world.mode === '3d') {
    if (dt > 0 && dt < 1000) run.tierFrames.push(dt);
  } else sample2dFrame(now);
}
function refreshStats(now) {
  const stats = stream?.stats() || null;
  cachedPoseFps = stats?.fps || 0;
  if (state !== 'measuring' || !run) return;
  if (stats) {
    if (cachedPoseFps > 0) run.poseFps.push(cachedPoseFps);
    if (stats.latency > 0) run.latency.push(stats.latency);
    if (stats.width && stats.height) run.cameraResolution = {width: stats.width, height: stats.height};
    ui.pose.textContent = cachedPoseFps ? cachedPoseFps.toFixed(1) : '--';
    ui.latency.textContent = stats.latency ? String(stats.latency) : '--';
    ui.capture.textContent = stats.width && stats.height ? `采集 ${stats.width} × ${stats.height}` : '采集尺寸 --';
  }
  const tier = TIERS[run.tierIndex];
  showTier(tier, summarizeTier(run.tierFrames, run.poseFps, run.latency));
  const recent = run.tierFrames.slice(-120);
  const recentMs = recent.reduce((sum, value) => sum + value, 0);
  ui.fps.textContent = recentMs ? (recent.length * 1000 / recentMs).toFixed(1) : '--';
  const p50 = quantile(recent, 0.5), p95 = quantile(recent, 0.95);
  ui.frame.textContent = p50 == null ? '帧时 p50 / p95 --' : `${p50.toFixed(1)} / ${p95.toFixed(1)} 毫秒`;
  void now;
}

function finishTest(nextState, detail = '') {
  runToken++;
  if (nextState === 'done' && run) {
    const results = TIERS.map((tier, index) => run.tiers[index] || {tier, ...summarizeTier([], [], [])});
    const report = {
      schema: 'movecraft-perf-v2',
      completedAt: new Date().toISOString(),
      test: {mode: run.mode === 'camera' ? 'camera+render' : 'render-only', secondsPerTier: TIER_MS / 1000, smokeMode},
      environment: {
        browser,
        screen: {width: screen.width, height: screen.height, viewportWidth: innerWidth, viewportHeight: innerHeight, pixelRatio: globalThis.devicePixelRatio || 1},
        gpu,
      },
      render: {mode: world.mode, sampling: world.mode === '3d' ? 'requestAnimationFrame' : '2d-canvas-pixel-change'},
      camera: run.mode === 'camera' ? {enabled: true, resolution: run.cameraResolution} : {enabled: false, status: 'not-tested-no-camera'},
      tiers: results,
    };
    window.__perfReport = report;
    const high = results.at(-1);
    ui.fps.textContent = high.averageFps ? high.averageFps.toFixed(1) : '--';
    ui.frame.textContent = high.p50FrameMs == null ? '帧时 p50 / p95 --' : `${high.p50FrameMs} / ${high.p95FrameMs} 毫秒`;
    ui.pose.textContent = high.poseFps == null ? '--' : high.poseFps.toFixed(1);
    ui.latency.textContent = high.inferenceLatencyMs == null ? '--' : String(high.inferenceLatencyMs);
  }
  if (['stopped', 'done', 'error'].includes(nextState)) {
    stream?.stop();
    if (nextState === 'done' && run?.mode === 'render') stream = null;
    world.noPose();
    world.demo('wave');
    if (nextState !== 'done') run = null;
  }
  ui.progress.style.width = nextState === 'done' ? '100%' : '0%';
  setStatus(nextState, detail || (nextState === 'done' ? '三档测试完成' : nextState === 'stopped' ? '测试已结束' : ''));
}

for (const input of ui.modes) input.addEventListener('change', updateModeUi);
ui.start.addEventListener('click', () => {
  const token = ++runToken;
  startTest(token).catch(error => { if (token === runToken) setStatus('error', errorText(error)); });
});
ui.stop.addEventListener('click', () => finishTest('stopped'));
ui.camera.addEventListener('change', async () => {
  if (!stream) return;
  setStatus('starting', '正在切换摄像头');
  const ready = await stream.switchCamera(ui.camera.value);
  if (ready) setStatus('idle', '摄像头已切换');
  else setStatus('error', errorText(stream.stats().lastError));
});
ui.copy.addEventListener('click', async () => {
  const report = window.__perfReport;
  if (!report) return;
  const value = JSON.stringify(report, null, 2);
  try { await navigator.clipboard.writeText(value); }
  catch {
    const input = document.createElement('textarea');
    input.value = value; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select(); document.execCommand('copy'); input.remove();
  }
  ui.detail.textContent = '报告已复制';
});

function frame(now) {
  const dt = Math.min(1000, Math.max(0, now - lastFrame));
  lastFrame = now;
  world.frame(dt || 16.67, now, {poseFps: cachedPoseFps});
  if (now - lastStatsAt >= 500) { lastStatsAt = now; refreshStats(now); }
  if (run && state === 'warming' && now >= run.warmUntil) {
    run.startedAt = now;
    run.endsAt = now + run.durationMs;
    setStatus('measuring');
  }
  if (run && state === 'measuring') {
    recordTier(now, dt);
    const elapsed = now - run.startedAt;
    const totalProgress = (run.tierIndex * run.durationMs + Math.min(elapsed, run.durationMs)) / (run.durationMs * TIERS.length);
    ui.progress.style.width = `${Math.min(100, totalProgress * 100)}%`;
    if (now >= run.endsAt) {
      const tier = TIERS[run.tierIndex];
      const result = {tier, ...summarizeTier(run.tierFrames, run.poseFps, run.latency)};
      run.tiers[run.tierIndex] = result;
      showTier(tier, result);
      if (run.tierIndex === TIERS.length - 1) finishTest('done');
      else queueTier(run.tierIndex + 1, now);
    }
  }
  requestAnimationFrame(frame);
}

updateModeUi();
setStatus('idle', `低 · 中 · 高 / 每档 ${TIER_MS / 1000} 秒`);
requestAnimationFrame(frame);
