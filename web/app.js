import {STAGES, SHELTERS, PROTECTION, today, fresh, sanitize, age, required, settle, login, record, nextRound, exchange, canExchange, roundSummary} from './core.js';
import {Narrator} from './voice.js';
import {Detector} from './detector.js';
import {drawWorld, drawPostcard, mirror} from './scene.js';

const $ = id => document.getElementById(id);
const KEYS = {camera: 'movecraft.island.v1.camera', demo: 'movecraft.island.v1.demo', device: 'movecraft.island.v1.device', voice: 'movecraft.island.v1.voice'};
const ui = {page: 'rules', mode: 'camera', island: null, transitioning: false, transition: null, storageError: '', clockError: '', corrupt: false};
const devicePreference = readDevicePreference();
const camera = {stream: null, worker: null, abort: null, running: false, starting: false, revision: 0, inFlight: false, sent: 0, timer: null, lastVideoTime: -1, landmarks: null, lastPose: 0, fpsAt: 0, frames: 0, devices: [], deviceId: devicePreference.id, activeDeviceId: '', activeLabel: ''};
// Virtual webcams (phone-as-webcam, OBS, 虚拟摄像头) still need their companion app
// running; marking them in the list keeps people from picking a device that is
// registered with Windows but cannot deliver frames.
const VIRTUAL_CAMERA = /(iriun|droidcam|epoccam|\bcamo\b|obs\s*virtual|virtual\s*cam|manycam|ndi|e2esoft|ivcam|虚拟摄像头)/i;
let detector = new Detector('wave');
let rulesDeadline = performance.now() + 10000;
let transitionTimer = null;
const narrator = new Narrator({onStateChange: updateVoiceStatus});
let speechRevision = 0, storageRevision = 0, lastCountAt = 0, hintSince = 0, lastHint = '';
const clip = text => ({text, key: text});
function chineseInteger(value, useTwo = true) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (!Number.isInteger(value) || value < 0 || value > 99) throw new RangeError('语音数字超出录音库范围');
  if (value < 10) return value === 2 && useTwo ? '两' : digits[value];
  if (value < 20) return value === 10 ? '十' : '十' + digits[value % 10];
  return digits[Math.floor(value / 10)] + '十' + (value % 10 ? digits[value % 10] : '');
}
function numberParts(value, {decimal = false} = {}) {
  if (!Number.isFinite(value) || value < 0 || value > 99) throw new RangeError('语音数字超出录音库范围');
  const whole = Math.floor(value), fraction = value - whole;
  if (fraction < 1e-9) return [clip(chineseInteger(whole))];
  if (Math.abs(fraction - 0.5) > 1e-9) throw new RangeError('语音数字只支持整数或半数');
  return [clip(chineseInteger(whole, false)), clip('点五')];
}
function rulesParts() {
  return [clip('欢迎来到体感荒岛。通过竖直跳、开合跳、手臂平举和深蹲，采集水、木材和食物，建造庇护所。每项从'),
    ...numberParts(10), clip('次开始，每'), ...numberParts(2), clip('天增加一次，最多'), ...numberParts(25),
    clip('次。每天需要水和食物，生命归零挑战结束。请留出活动空间，量力运动。规则介绍完毕，准备挥手登岛。')];
}
function speakStage() {
  const config = STAGES[ui.island?.stage];
  lastCountAt = performance.now(); hintSince = lastCountAt; lastHint = '';
  if (ui.page === 'game' && config && !ui.island.failed && !ui.corrupt && !ui.clockError && !document.hidden && !hasDialog()) {
    narrator.speakParts([clip(`${config.name}。完成`), ...numberParts(required(ui.island)), clip(`个${config.move}。${config.guide}`)], {key: `stage.${config.action}`});
  }
}
function hasDialog() { return !!document.querySelector('dialog[open]'); }
function updateVoiceStatus(state) {
  const labels = {disabled: '语音朗读已关闭', starting: '正在准备朗读…', speaking: state.key === 'rules' ? '正在朗读规则，结束后自动进入登岛页' : '正在朗读…', idle: '语音朗读已开启'};
  const failures = {unavailable: '设备暂无可用语音，可按文字提示继续', blocked: '语音未能播放，可点击「重新朗读」重试', timeout: '语音播放超时，可点击「重新朗读」重试'};
  const message = state.status === 'idle' && failures[state.lastResult?.status] || labels[state.status];
  if ($('voiceStatus').textContent !== message) $('voiceStatus').textContent = message;
}
function speakCorrection(result) {
  if (ui.page !== 'game' || ui.mode !== 'camera' || ui.transitioning || ui.island?.failed || ui.corrupt || ui.clockError || narrator.busy || !STAGES[ui.island?.stage]) return;
  const now = performance.now();
  if (result.hint !== lastHint) { lastHint = result.hint; hintSince = now; }
  if (now - lastCountAt < 7000 || now - hintSince < 2500 || document.hidden || hasDialog()) return;
  narrator.speak(result.hint, {key: result.hint, correction: true});
}
function showSettlement() {
  if (!ui.island || ui.island.stage !== 4 || ui.island.failed) return;
  clearTransition(); stopCamera(); page('settlement');
  const summary = roundSummary(ui.island);
  $('settlementRows').replaceChildren(...summary.items.map(item => {
    const row = document.createElement('p');
    row.textContent = `完成 ${item.count} 个${item.move}，消耗 ${item.calories} 卡`;
    return row;
  }));
  $('settlementTotal').textContent = `共消耗 ${summary.totalCalories} 卡`;
  $('settlementRank').textContent = `已击败全国 ${summary.percentile}% 的人！`;
  $('settlementNote').textContent = summary.percentileNote + ' ' + summary.calorieNote;
  $('settlementEncouragement').textContent = summary.encouragement;
  $('settlementMode').textContent = ui.mode === 'demo' ? '键鼠试玩结算 · 非实际运动记录' : '本轮运动结算';
  const speechParts = [clip(ui.mode === 'demo' ? '键鼠试玩结算，非实际运动记录。' : '本轮运动结算。')];
  for (const item of summary.items) speechParts.push(clip('完成'), ...numberParts(item.count),
    clip(`个${item.move}，消耗`), ...numberParts(item.calories, {decimal: true}), clip('卡。'));
  speechParts.push(clip('共消耗'), ...numberParts(summary.totalCalories, {decimal: true}), clip('卡。'),
    clip('已击败全国百分之'), ...numberParts(summary.percentile), clip('的人！'),
    clip(summary.percentileNote + summary.calorieNote), clip(summary.encouragement));
  narrator.speakParts(speechParts, {key: 'settlement'});
}

function status(message) { for (const id of ['poseHint', 'loginStatus']) if ($(id).textContent !== message) $(id).textContent = message; }
function notice(message) { $('storageWarning').textContent = message; $('storageWarning').hidden = !message; }
function readDevicePreference() {
  try {
    const raw = localStorage.getItem(KEYS.device);
    if (!raw) return {id: '', label: ''};
    const value = JSON.parse(raw);
    return {id: typeof value?.id === 'string' ? value.id : '', label: typeof value?.label === 'string' ? value.label : ''};
  } catch { return {id: '', label: ''}; }
}
function rememberDevice(id, label) {
  try { localStorage.setItem(KEYS.device, JSON.stringify({id, label})); } catch { /* storage full: selection just won't persist */ }
}
// Fall back to the default device when the remembered one was unplugged.
// Before permission is granted the browser hides device ids and labels, so the
// remembered id has to be trusted until a real list disproves it.
function selectedDeviceId() {
  const id = camera.deviceId;
  if (!id) return '';
  const known = camera.devices.filter(device => device.deviceId);
  return known.length && !known.some(device => device.deviceId === id) ? '' : id;
}
function fillDeviceSelect(select, chosen) {
  const auto = document.createElement('option');
  auto.value = ''; auto.textContent = '自动选择（系统默认）';
  select.replaceChildren(auto, ...camera.devices.filter(device => device.deviceId).map((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = (device.label || '摄像头 ' + (index + 1)) + (VIRTUAL_CAMERA.test(device.label) ? ' · 虚拟设备' : '');
    return option;
  }));
  select.value = camera.devices.some(device => device.deviceId === chosen) ? chosen : '';
}
function deviceFields() { return ['cameraSelect', 'gameCameraSelect'].map($).filter(Boolean); }
function describeDevice(label) { return label ? '当前设备：' + label + '。' : ''; }
// Device labels are empty until permission is granted, so the list is refreshed
// both before the first request (to restore a remembered choice) and after it.
async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return camera.devices;
  try {
    camera.devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
  } catch { camera.devices = []; }
  // A remembered camera that is no longer plugged in must not keep steering the
  // next request at a dead device id; drop the preference as soon as we can see
  // the real list.
  const known = camera.devices.filter(device => device.deviceId);
  if (camera.deviceId && known.length && !known.some(device => device.deviceId === camera.deviceId)) {
    camera.deviceId = ''; rememberDevice('', '');
  }
  const chosen = selectedDeviceId();
  for (const select of deviceFields()) fillDeviceSelect(select, chosen);
  return camera.devices;
}
function describeCameraError(error) {
  const hints = {
    NotAllowedError: '未获得摄像头权限。请点击地址栏旁的摄像头图标允许访问，再重试。',
    NotFoundError: '未找到摄像头，请连接摄像头后重试。',
    NotReadableError: '摄像头无法读取：可能被其他应用占用，或该设备是尚未连接的虚拟摄像头。请在上方切换到其他摄像头后重试。',
    OverconstrainedError: '所选摄像头不支持需要的分辨率或帧率，请切换到其他摄像头后重试。',
    SecurityError: '浏览器阻止了摄像头访问，请用近期版本的 Chrome 或 Edge 打开本地地址。',
    AbortError: '摄像头启动被中断，请重试。',
  };
  return hints[error.name] || '无法开启本机识别：' + (error.message || error.name);
}
function save() {
  if (!ui.island || ui.corrupt || ui.clockError) return;
  ui.island.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(KEYS[ui.mode], JSON.stringify(ui.island));
    $('saveStatus').textContent = '已自动保存 · ' + new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    ui.storageError = ''; notice('');
  } catch {
    ui.storageError = '浏览器未能保存进度。请点击「导出存档」备份，并检查浏览器存储权限或可用空间。';
    notice(ui.storageError); $('saveStatus').textContent = '自动保存失败 · 请导出存档';
  }
}
function load(mode) {
  ui.storageError = ''; ui.clockError = ''; ui.corrupt = false;
  try {
    const value = localStorage.getItem(KEYS[mode]);
    return value ? sanitize(JSON.parse(value)) : fresh();
  } catch (error) {
    // Keep the original bytes intact; importing a known backup or resetting is explicit.
    ui.corrupt = true;
    ui.storageError = '现有存档无法读取（可能损坏，或电脑时间早于存档）。原存档已保留；请导出备份，校准时间后重新登岛，或手动导入存档。';
    return fresh();
  }
}
function page(name) {
  speechRevision++; narrator.cancel();
  ui.page = name;
  window.scrollTo(0, 0);
  updateVoiceStatus(narrator.state);
  for (const p of ['rules', 'login', 'game', 'settlement']) $(p + 'Page').hidden = p !== name;
  $('backLogin').hidden = !['game', 'settlement'].includes(name);
  const heading = $(name + 'Page').querySelector('h1');
  if (heading) { heading.tabIndex = -1; heading.focus({preventScroll: true}); }
}
function setDetector(action) { detector = new Detector(action); }
function activeAction() { return ui.page === 'login' ? 'wave' : STAGES[ui.island?.stage]?.action || 'none'; }
function enterGame(mode) {
  if (mode === 'demo') stopCamera();
  clearTransition();
  ui.mode = mode; ui.island = load(mode);
  if (!ui.corrupt) ui.clockError = login(ui.island).error || '';
  if (ui.corrupt || ui.clockError || ui.island.failed) stopCamera();
  page('game'); setDetector(activeAction());
  $('modeNotice').hidden = mode !== 'demo'; $('demoControls').hidden = mode !== 'demo';
  document.querySelector('.camera-card').hidden = mode === 'demo';
  $('sceneMode').textContent = mode === 'demo' ? 'LOCAL DEMO / 键鼠体验' : 'LOCAL POSE / 体感模式';
  $('startCamera').hidden = mode === 'demo' || camera.running;
  $('stopCamera').hidden = !camera.running;
  if (mode === 'demo') status('键鼠体验使用独立存档。点击模拟动作，或按空格键。');
  if (ui.storageError || ui.clockError) notice(ui.storageError || ui.clockError);
  save(); render();
  if (ui.island.stage === 4 && !ui.island.failed && !ui.corrupt) showSettlement();
  else speakStage();
}
function showLogin() {
  save(); ui.island = null; stopCamera(); clearTransition(); page('login'); setDetector('wave');
  $('loginCamera').disabled = false; $('loginCamera').textContent = '开启摄像头，挥手登岛';
  status('请留出足够活动空间，让上半身和髋部进入画面。');
  startCamera();
}
function clearTransition() {
  clearTimeout(transitionTimer); transitionTimer = null;
  ui.transitioning = false; ui.transition = null; $('toast').hidden = true;
}
function completeTransition() {
  if (ui.page !== 'game' || !ui.transition?.ready || document.hidden || hasDialog()) return false;
  const daily = syncDay();
  if (daily.days || daily.error) return false;
  clearTransition(); setDetector(activeAction()); render();
  if (ui.island.stage === 4) showSettlement(); else speakStage();
  return true;
}
// Every resource action and resume settles the same calendar boundary first.
function syncDay() {
  if (!ui.island || ui.corrupt) return {days: 0};
  const result = settle(ui.island);
  if (result.error) {
    ui.clockError = result.error; narrator.cancel(); notice(result.error); render();
    return result;
  }
  if (ui.clockError) { ui.clockError = ''; notice(ui.storageError); render(); }
  if (result.days) {
    clearTransition(); narrator.cancel(); login(ui.island);
    if (ui.page === 'settlement') page('game');
    setDetector(activeAction()); save(); render();
    notice(`新的一天已结算：经过 ${result.days} 天，生命减少 ${result.loss} 点。${ui.island.failed ? '休息好了，可以重新开岛。' : '今日动作目标已更新，按自己的节奏开始吧。'}`);
    if (ui.island.failed) { stopCamera(); narrator.speak('生命值归零，挑战结束。休息好了，可以重新开始荒岛。', {key: 'island.failed'}); }
    else speakStage();
  }
  return result;
}
function render() {
  const s = ui.island; if (!s) return;
  const target = required(s), stage = Math.min(s.stage, 3), config = STAGES[stage];
  const count = s.counts[stage];
  const values = {hpValue: s.hp, staminaValue: s.stamina, waterValue: s.water, foodValue: s.food, woodValue: s.wood, repValue: count};
  for (const [id, value] of Object.entries(values)) $(id).textContent = String(value);
  $('hpBar').style.width = s.hp + '%'; $('hpBar').style.background = s.hp <= 25 ? '#bc775a' : '#608e64';
  $('dayValue').textContent = String(age(s) + 1).padStart(2, '0');
  $('daySummary').textContent = `第 ${age(s) + 1} 天 · 已完成 ${s.moves} 次动作，守住了 ${s.rounds} 次日出。`;
  $('gameEyebrow').textContent = ui.mode === 'demo' ? 'DEMO ISLAND / 独立试玩存档' : 'A NEW DAY ON YOUR ISLAND';
  $('taskTitle').textContent = s.stage >= 4 ? '本轮运动已完成' : config.name + ' · ' + config.move;
  $('taskGuide').textContent = s.stage >= 4 ? '水、粮食与一个更好的家，都是今天努力的形状。休息一下，也可以再运动一轮。' : config.guide;
  $('taskReward').textContent = s.stage >= 4 ? `本轮奖励已领取 · ${SHELTERS[s.shelter]} · 淡水 ${s.water} · 食物 ${s.food}` : s.stage === 3 && s.shelter === 6 ? '完成本关 · 加固营地，淡水 +1 · 食物 +1' : '完成本关 · ' + config.reward;
  $('targetValue').textContent = ' / ' + target;
  $('repDots').replaceChildren(...Array.from({length: target}, (_, i) => { const node = document.createElement('span'); node.className = i < count ? 'done' : ''; return node; }));
  $('targetHint').textContent = `每关 ${target} 次 · 每两天 +1 · 最多 25 次`;
  $('campLevel').textContent = 'Lv. ' + s.shelter; $('campName').textContent = SHELTERS[s.shelter];
  $('campBenefit').textContent = s.shelter ? `减少 ${Math.round(PROTECTION[s.shelter] * 100)}% 每日生命损耗 · 每日登岛赠 ${1 + Math.floor(s.shelter / 2)} 体力` : '每一次建造，都会让明天轻松一点。';
  $('shelterSteps').replaceChildren(...Array.from({length: 6}, (_, i) => { const node = document.createElement('span'); node.className = i < s.shelter ? 'done' : ''; node.title = SHELTERS[i + 1]; return node; }));
  $('dailyDrain').textContent = '每天各消耗 1 份水与食物；补给不足会加速掉血。兑换时会预留本关通关所需体力。';
  const names = ['海风椰林', '林间空地', '海岸麦田', '你的营地', '你的营地'];
  const captions = ['第 1 站 · 在椰林寻找淡水', '第 2 站 · 给庇护所备些木材', '第 3 站 · 为明天种下希望', '第 4 站 · 把努力建成一个家', '歇一歇，下一场冒险随时出发'];
  $('sceneName').textContent = names[s.stage]; $('sceneCaption').textContent = captions[s.stage];
  $('route').replaceChildren(...STAGES.map((x, i) => {
    const li = document.createElement('li'); li.className = i < s.stage ? 'done' : i === s.stage ? 'active' : '';
    const num = document.createElement('span'); num.className = 'route-num'; num.textContent = i < s.stage ? '✓' : '0' + (i + 1);
    const label = document.createElement('span'); label.textContent = x.name;
    const small = document.createElement('small'); small.textContent = x.move + ' · ' + target + ' 次'; label.append(small); li.append(num, label); return li;
  }));
  $('journalList').replaceChildren(...s.history.slice(-4).reverse().map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  $('journalEmpty').hidden = !!s.history.length;
  $('failed').hidden = !s.failed;
  $('finished').hidden = s.stage !== 4 || s.failed || ui.transitioning;
  $('viewSettlement').hidden = s.stage !== 4 || s.failed || ui.transitioning || ui.corrupt;
  $('finishedText').textContent = `本轮运动完成 · ${SHELTERS[s.shelter]} · 生命 ${s.hp} / 100`;
  $('demoMove').disabled = s.failed || s.stage >= 4 || ui.transitioning || ui.corrupt || !!ui.clockError;
  for (const [id, kind] of [['buyWater', 'water'], ['buyFood', 'food']]) $(id).disabled = ui.corrupt || !!ui.clockError || !canExchange(s, kind);
  if (ui.corrupt) notice(ui.storageError);
}
function doMove(action) {
  if (ui.page !== 'game' || ui.transitioning || ui.corrupt || hasDialog()) return;
  const daily = syncDay();
  if (daily.error || daily.days) return;
  const s = ui.island, previousStage = s.stage, previousShelter = s.shelter;
  const result = record(s, action);
  if (!result.accepted) { render(); return; }
  lastCountAt = performance.now();
  const praise = ['做得好，继续加油！', '很棒，保持自己的节奏！', '每一次努力都算数！'];
  const completed = s.counts[previousStage];
  const countSpeech = narrator.speakParts([clip(`已完成${STAGES[previousStage].move}`), ...numberParts(completed), clip('个。'), clip(praise[(completed - 1) % praise.length])],
    {key: `count.${action}.${completed}`, replace: false, group: 'count'});
  save();
  if (result.completed) {
    ui.transitioning = true;
    ui.transition = {stage: previousStage, progress: 1, shelter: previousStage === 3 ? previousShelter + (previousShelter < 6 ? 1 : 0) : s.shelter};
    $('toastTitle').textContent = result.message;
    $('toastDetail').textContent = previousStage === 3 ? SHELTERS[s.shelter] + ' · 本轮运动完成' : STAGES[previousStage].reward + ' · 即将进入下一关';
    $('toast').hidden = false;
    const transition = ui.transition;
    transitionTimer = setTimeout(async () => {
      await countSpeech;
      if (ui.page !== 'game' || !ui.transitioning || ui.transition !== transition) return;
      transition.ready = true; completeTransition();
    }, 3600);
    setDetector('none');
  }
  render();
}

function stopCamera() {
  camera.revision++; camera.running = false; camera.starting = false; camera.inFlight = false;
  camera.abort?.abort(); camera.abort = null;
  clearTimeout(camera.timer); camera.timer = null;
  camera.worker?.terminate(); camera.worker = null;
  camera.stream?.getTracks().forEach(track => track.stop()); camera.stream = null;
  $('video').srcObject = null; camera.landmarks = null;
  $('cameraBadge').textContent = '已暂停'; $('cameraBadge').className = 'camera-badge';
  $('cameraPlaceholder').hidden = false; $('stopCamera').hidden = true;
  $('startCamera').hidden = ui.mode === 'demo' && ui.page === 'game'; $('startCamera').disabled = false;
  $('loginPreview').hidden = true; $('loginCamera').disabled = false; $('loginCamera').textContent = '开启摄像头，挥手登岛';
  for (const select of deviceFields()) select.disabled = false;
  $('cameraBadge').title = ''; camera.activeDeviceId = ''; camera.activeLabel = '';
  $('fps').hidden = true; setDetector(activeAction());
}
function frameLoop(revision) {
  if (!camera.running || camera.revision !== revision) return;
  const video = $('video');
  if (!camera.inFlight && video.readyState >= 2 && !video.paused && video.currentTime !== camera.lastVideoTime && !document.hidden) {
    camera.inFlight = true; camera.lastVideoTime = video.currentTime;
    createImageBitmap(video).then(frame => {
      if (camera.revision !== revision || !camera.worker) { frame.close(); return; }
      camera.sent = performance.now();
      camera.worker.postMessage({type: 'frame', frame, timestamp: camera.sent}, [frame]);
    }).catch(() => {
      if (camera.revision === revision) { camera.inFlight = false; status('暂时无法读取摄像头画面，请暂停后重试。'); }
    });
  }
  camera.timer = setTimeout(() => frameLoop(revision), 70);
}
async function openCameraStream(deviceId) {
  const video = {width: {ideal: 640}, height: {ideal: 480}, frameRate: {ideal: 24, max: 30}};
  // facingMode is only a hint for phone cameras; it must not fight an explicit choice.
  const constraints = deviceId ? {audio: false, video: {...video, deviceId: {exact: deviceId}}} : {audio: false, video: {...video, facingMode: 'user'}};
  return navigator.mediaDevices.getUserMedia(constraints);
}
function cameraWait(operation, signal, timeout, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error(message)), timeout);
    const abort = () => finish(reject, new DOMException('Camera stopped', 'AbortError'));
    function finish(callback, value) { clearTimeout(timer); signal.removeEventListener('abort', abort); callback(value); }
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function startCamera() {
  if (camera.starting || camera.running) return;
  if (ui.page === 'game' && (ui.corrupt || ui.island?.failed || ui.island?.stage === 4)) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof Worker === 'undefined') { status('浏览器无法启用摄像头。请用本地启动程序打开，并使用较新的 Chrome 或 Edge。'); return; }
  camera.starting = true; const revision = ++camera.revision;
  camera.abort = new AbortController(); const signal = camera.abort.signal;
  $('loginCamera').disabled = true; $('startCamera').disabled = true;
  for (const select of deviceFields()) select.disabled = true;
  status('正在请求摄像头权限…');
  try {
    const wanted = selectedDeviceId();
    let stream;
    try {
      stream = await openCameraStream(wanted);
    } catch (error) {
      // A remembered or user-picked device can be unplugged or busy; retrying the
      // system default turns a dead end into a one-click recovery.
      if (!wanted || !['NotReadableError', 'OverconstrainedError', 'NotFoundError', 'AbortError'].includes(error.name)) throw error;
      if (revision !== camera.revision) return;
      stream = await openCameraStream('');
      if (revision !== camera.revision) { stream.getTracks().forEach(track => track.stop()); return; }
      camera.deviceId = ''; rememberDevice('', '');
      status('所选摄像头无法打开，已改用系统默认摄像头。');
    }
    if (revision !== camera.revision) { stream.getTracks().forEach(t => t.stop()); return; }
    camera.stream = stream; $('video').srcObject = stream;
    const [track] = stream.getVideoTracks();
    camera.activeDeviceId = track.getSettings().deviceId || ''; camera.activeLabel = track.label || '';
    track.addEventListener('ended', () => { if (revision === camera.revision) { stopCamera(); status('摄像头连接已断开，请检查设备后重新开启。'); } });
    await cameraWait($('video').play(), signal, 10000, '摄像头没有送来画面，请检查设备是否正常连接后重试。');
    if (revision !== camera.revision) return;
    await listCameras();
    if (revision !== camera.revision) return;
    for (const select of deviceFields()) { select.value = camera.devices.some(d => d.deviceId === camera.activeDeviceId) ? camera.activeDeviceId : ''; select.disabled = false; }
    status('正在加载本机姿态模型，首次开启可能需要几秒…');
    const worker = new Worker(new URL('./pose-worker.js', import.meta.url), {type: 'module'}); camera.worker = worker;
    await cameraWait(new Promise((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message || '识别模块无法启动。'));
      worker.onmessage = ({data}) => {
        if (data.type === 'ready') resolve();
        else if (data.type === 'error') reject(new Error(data.message));
      };
      worker.postMessage({type: 'init'});
    }), signal, 45000, '模型加载超时，请关闭占用资源的程序后重试。');
    if (revision !== camera.revision) return;
    camera.running = true; camera.starting = false; camera.inFlight = false; camera.lastVideoTime = -1;
    camera.fpsAt = performance.now(); camera.frames = 0; camera.lastPose = performance.now();
    setDetector(activeAction());
    worker.onerror = () => { if (revision === camera.revision) { stopCamera(); status('本机识别模块已停止，请重新开启体感。'); } };
    worker.onmessage = ({data}) => {
      if (revision !== camera.revision) return;
      if (data.type === 'error') { stopCamera(); status('本机识别失败。请用最新版 Chrome / Edge 重试。详情：' + data.message.slice(0, 120)); return; }
      if (data.type !== 'pose') return;
      camera.inFlight = false; camera.landmarks = data.landmarks; camera.lastPose = performance.now(); camera.frames++;
      const elapsed = performance.now() - camera.fpsAt;
      if (elapsed > 1000) { $('fps').textContent = Math.round(camera.frames * 1000 / elapsed) + ' FPS · ' + Math.round(data.latency) + ' ms'; camera.frames = 0; camera.fpsAt = performance.now(); }
      if (document.hidden || hasDialog()) { setDetector(activeAction()); return; }
      const result = detector.update(data.landmarks, data.timestamp, $('video').videoWidth / $('video').videoHeight);
      if (!ui.transitioning) status(result.hint);
      if (!result.count) speakCorrection(result);
      if (result.count) {
        if (ui.page === 'login') enterGame('camera');
        else if (ui.page === 'game' && ui.mode === 'camera') doMove(detector.action);
      }
    };
    $('cameraBadge').textContent = '本机识别中';
    $('cameraBadge').className = 'camera-badge live';
    $('cameraBadge').title = camera.activeLabel;
    $('cameraPlaceholder').hidden = true; $('stopCamera').hidden = false; $('startCamera').hidden = true;
    $('loginPreview').hidden = false; $('loginCamera').disabled = false; $('loginCamera').textContent = '摄像头已开启 · 点击暂停';
    $('fps').hidden = false;
    status('摄像头已就绪，请站稳后完成动作。' + describeDevice(camera.activeLabel));
    if (ui.page === 'login' && !document.hidden && !hasDialog()) narrator.speak('平举右手向左挥动完成确认', {key: 'login.confirm'});
    frameLoop(revision);
  } catch (error) {
    if (revision !== camera.revision) return;
    stopCamera();
    const message = describeCameraError(error);
    status(message);
    if (ui.page === 'login' && !document.hidden && !hasDialog()) narrator.speak(message, {key: message});
    $('loginCamera').textContent = '重试开启摄像头';
  }
}

let lastPaint = 0;
function paint(t) {
  requestAnimationFrame(paint);
  if (t - lastPaint < 32 || document.hidden) return;
  lastPaint = t;
  if (camera.running && performance.now() - camera.lastPose > 5000) {
    stopCamera(); status('识别暂时没有响应，请重新开启摄像头。进度已经保存。');
  }
  if (ui.page === 'rules') drawPostcard($('introCanvas'), t);
  else if (ui.page === 'login') {
    drawPostcard($('loginCanvas'), t);
    if (camera.running) mirror($('loginMirror'), $('video'), camera.lastPose + 500 > performance.now() ? camera.landmarks : null);
  } else if (ui.page === 'game' && ui.island) {
    const s = ui.island;
    const stage = ui.transition?.stage ?? s.stage;
    const progress = ui.transition?.progress ?? (s.stage < 4 ? s.counts[s.stage] / required(s) : 1);
    const landmarks = camera.lastPose + 500 > performance.now() ? camera.landmarks : null;
    drawWorld($('scene'), {stage, progress, target: required(s), shelter: ui.transition?.shelter ?? s.shelter, video: camera.running ? $('video') : null, landmarks, t, demo: ui.mode === 'demo', transitioning: ui.transitioning});
    if (camera.running) mirror($('cameraMirror'), $('video'), landmarks);
  }
}
requestAnimationFrame(paint);
const ruleTimer = setInterval(() => {
  const remaining = Math.max(0, Math.ceil((rulesDeadline - performance.now()) / 1000));
  $('enterIsland').textContent = remaining ? `阅读规则 · ${remaining} 秒` : '开始我的荒岛生活 →';
  $('enterIsland').disabled = remaining > 0;
  if (!remaining) clearInterval(ruleTimer);
}, 150);
async function speakRules() {
  const revision = ++speechRevision;
  if (!narrator.enabled) { updateVoiceStatus(narrator.state); return; }
  $('voiceStatus').textContent = '正在朗读规则，结束后自动进入登岛页';
  const result = await narrator.speakParts(rulesParts(), {key: 'rules'});
  if (revision !== speechRevision || ui.page !== 'rules' || !narrator.enabled || document.hidden || hasDialog()) return;
  if (result?.status === 'ended') showLogin();
  else $('voiceStatus').textContent = '点击「重新朗读」启用语音，或点击开始继续';
}
$('enterIsland').onclick = () => { if (performance.now() >= rulesDeadline) showLogin(); };
$('voiceEnabled').onchange = () => {
  speechRevision++;
  narrator.setEnabled($('voiceEnabled').checked);
  try { localStorage.setItem(KEYS.voice, String($('voiceEnabled').checked)); } catch { /* voice remains usable without persistence */ }
  updateVoiceStatus(narrator.state);
  if ($('voiceEnabled').checked) replayVoice();
};
function replayVoice() {
  if (document.hidden || hasDialog()) return;
  if (!$('voiceEnabled').checked) {
    $('voiceEnabled').checked = true; narrator.setEnabled(true);
    try { localStorage.setItem(KEYS.voice, 'true'); } catch { /* optional preference */ }
  }
  if (ui.page === 'rules') speakRules();
  else if (ui.page === 'login') {
    const text = camera.running ? '平举右手向左挥动完成确认' : $('loginStatus').textContent;
    narrator.speak(text, {key: text});
  }
  else if (ui.page === 'settlement') showSettlement();
  else speakStage();
}
$('replayVoice').onclick = replayVoice;
$('loginCamera').onclick = () => camera.running || camera.starting ? (stopCamera(), $('loginCamera').textContent = '开启摄像头，挥手登岛') : startCamera();
$('demoLogin').onclick = () => enterGame('demo');
// Changing the device while running restarts the pipeline so the new camera is
// used without a second click.
async function chooseDevice(event) {
  const select = event.currentTarget;
  camera.deviceId = select.value;
  const device = camera.devices.find(item => item.deviceId === select.value);
  rememberDevice(camera.deviceId, device?.label || '');
  for (const other of deviceFields()) if (other !== select) other.value = select.value;
  const wasRunning = camera.running || camera.starting;
  if (wasRunning) stopCamera();
  $('loginCamera').textContent = '开启摄像头，挥手登岛';
  if (wasRunning) await startCamera();
  else status(select.value ? '已选择摄像头，点击「' + (ui.page === 'game' ? '开启体感' : '开启摄像头') + '」开始。' : '将使用系统默认摄像头。');
}
for (const select of deviceFields()) select.onchange = chooseDevice;
if (navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => { listCameras(); });
$('startCamera').onclick = startCamera; $('stopCamera').onclick = () => { stopCamera(); status('体感已暂停，运动进度已保存。'); };
$('calibrate').onclick = () => { setDetector(activeAction()); status('已清除旧动作基线，请重新站稳。'); };
$('demoMove').onclick = () => { if (ui.mode === 'demo') doMove(activeAction()); };
$('anotherRound').onclick = () => {
  if (ui.corrupt) return;
  const daily = syncDay();
  if (daily.error) return;
  if (!daily.days && !nextRound(ui.island)) return;
  clearTransition(); page('game'); setDetector(activeAction()); save(); render(); speakStage();
  if (ui.mode === 'camera' && !ui.island.failed) startCamera();
};
$('settlementNext').onclick = () => $('anotherRound').onclick();
$('viewSettlement').onclick = () => { const daily = syncDay(); if (!daily.error && !daily.days) showSettlement(); };
$('settlementCamp').onclick = () => { const daily = syncDay(); if (!daily.error) { page('game'); render(); } };
for (const [id, kind] of [['buyWater', 'water'], ['buyFood', 'food']]) $(id).onclick = () => {
  if (ui.corrupt || syncDay().error) return;
  if (exchange(ui.island, kind)) { save(); render(); }
};
$('help').onclick = () => { speechRevision++; narrator.cancel(); setDetector(activeAction()); $('helpDialog').showModal(); };
$('helpDialog').addEventListener('close', () => {
  const daily = ['game', 'settlement'].includes(ui.page) ? syncDay() : {days: 0};
  if (daily.days || daily.error) return;
  setDetector(activeAction());
  if (!completeTransition() && narrator.enabled && !ui.transitioning) replayVoice();
});
for (const id of ['exitDemo', 'backLogin']) $(id).onclick = showLogin;
function confirmAction(title, text, action) {
  $('confirmTitle').textContent = title; $('confirmText').textContent = text;
  speechRevision++; narrator.cancel(); setDetector(activeAction());
  const openedAtRevision = storageRevision;
  const dialog = $('confirmDialog'); dialog.returnValue = ''; dialog.showModal();
  dialog.addEventListener('close', () => {
    setDetector(activeAction());
    if (dialog.returnValue === 'confirm') {
      if (openedAtRevision === storageRevision) action();
      else notice('存档已在另一个标签页更新，本次操作已取消。请返回登岛页重新载入。');
      return;
    }
    const daily = ['game', 'settlement'].includes(ui.page) ? syncDay() : {days: 0};
    if (!daily.days && !daily.error && !completeTransition() && !ui.transitioning) speakStage();
  }, {once: true});
}
function resetIsland() {
  confirmAction('重新开始荒岛？', `将替换当前${ui.mode === 'demo' ? '试玩' : '体感'}存档。建议先导出存档备份。`, () => {
    clearTransition(); narrator.cancel(); ui.island = fresh(); ui.corrupt = false; ui.storageError = ''; ui.clockError = ''; setDetector(activeAction()); save(); render(); speakStage();
    if (ui.mode === 'camera') startCamera();
  });
}
$('newIsland').onclick = resetIsland; $('restartFailed').onclick = resetIsland;
function downloadJSON(value, name) {
  const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('exportSave').onclick = () => {
  if (ui.corrupt) {
    try { downloadJSON(localStorage.getItem(KEYS[ui.mode]) || '{}', `movecraft-original-${ui.mode}-${today()}.json`); } catch { notice('无法读取浏览器存储，暂时无法导出原存档。'); }
  } else downloadJSON({format: 'movecraft-island', mode: ui.mode, island: ui.island}, `movecraft-${ui.mode}-${today()}.json`);
};
$('importSave').onclick = () => { $('saveFile').value = ''; $('saveFile').click(); };
$('saveFile').onchange = async () => {
  const file = $('saveFile').files[0]; if (!file) return;
  if (file.size > 256 * 1024) { notice('存档文件过大，请选择本游戏导出的 JSON 存档。'); return; }
  try {
    const raw = JSON.parse(await file.text());
    if (raw.format !== 'movecraft-island' || !['camera', 'demo'].includes(raw.mode)) throw new Error('请选择本游戏导出的存档');
    if (raw.mode !== ui.mode) throw new Error('存档模式不一致，请先切换到相应的体感或试玩模式');
    const imported = sanitize(raw.island);
    confirmAction('导入这份存档？', `将替换当前${ui.mode === 'demo' ? '试玩' : '体感'}存档。存档内未登录的天数会照常结算。`, () => {
      const result = login(imported);
      if (result.error) { notice('无法导入：' + result.error); return; }
      clearTransition(); narrator.cancel(); ui.island = imported; ui.corrupt = false; ui.storageError = ''; ui.clockError = ''; setDetector(activeAction()); save(); render();
      if (ui.island.failed) stopCamera();
      if (ui.island.stage === 4 && !ui.island.failed) showSettlement(); else speakStage();
    });
  } catch (error) { notice('无法导入：' + error.message); }
};
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && !event.repeat && ui.page === 'game' && ui.mode === 'demo' && !document.querySelector('dialog[open]') && !['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault(); doMove(activeAction());
  }
});
document.addEventListener('visibilitychange', () => {
  setDetector(activeAction());
  if (document.hidden) { speechRevision++; narrator.cancel(); save(); }
  else {
    // A suspended tab must get time to receive its first fresh inference.
    if (camera.running) camera.lastPose = performance.now();
    const daily = ['game', 'settlement'].includes(ui.page) ? syncDay() : {days: 0};
    if (!daily.error && !daily.days && !completeTransition() && narrator.enabled && !ui.transitioning && !hasDialog()) replayVoice();
  }
});
window.addEventListener('pagehide', () => { narrator.cancel(); save(); stopCamera(); });
// Stop stale tabs from overwriting a newer game session's save.
window.addEventListener('storage', event => {
  if ((event.key === KEYS[ui.mode] || event.key === null) && ['game', 'settlement'].includes(ui.page)) {
    storageRevision++;
    narrator.cancel(); stopCamera(); clearTransition(); ui.corrupt = true;
    ui.storageError = '存档已在另一个标签页更新。本页已暂停写入，请返回登岛页重新载入，避免覆盖新进度。';
    if (ui.page === 'settlement') page('game');
    notice(ui.storageError); render();
  }
});
setInterval(() => {
  if (!['game', 'settlement'].includes(ui.page) || ui.corrupt || document.hidden || hasDialog()) return;
  const daily = syncDay();
  if (!daily.days && !daily.error) completeTransition();
}, 15000);
// Populate the pickers up front: permission may already be granted, which means
// labels are available before the first start, and a remembered camera can be
// highlighted immediately. Without permission this just lists one blank entry.
listCameras();
try { $('voiceEnabled').checked = localStorage.getItem(KEYS.voice) !== 'false'; } catch { /* default enabled */ }
narrator.setEnabled($('voiceEnabled').checked);
speakRules();
