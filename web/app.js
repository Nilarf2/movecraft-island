import {STAGES, SHELTERS, PROTECTION, today, fresh, sanitize, age, required, settle, login, record, nextRound, exchange} from './core.js';
import {Detector} from './detector.js';
import {drawWorld, drawPostcard, mirror} from './scene.js';

const $ = id => document.getElementById(id);
const KEYS = {camera: 'movecraft.island.v1.camera', demo: 'movecraft.island.v1.demo'};
const ui = {page: 'rules', mode: 'camera', island: null, transitioning: false, transition: null, storageError: '', corrupt: false};
const camera = {stream: null, worker: null, running: false, starting: false, revision: 0, inFlight: false, sent: 0, timer: null, lastVideoTime: -1, landmarks: null, lastPose: 0, fpsAt: 0, frames: 0};
let detector = new Detector('wave');
let rulesDeadline = performance.now() + 10000;
let transitionTimer = null;

function status(message) { $('poseHint').textContent = message; $('loginStatus').textContent = message; }
function notice(message) { $('storageWarning').textContent = message; $('storageWarning').hidden = !message; }
function save() {
  if (!ui.island || ui.corrupt) return;
  ui.island.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(KEYS[ui.mode], JSON.stringify(ui.island));
    $('saveStatus').textContent = '已自动保存 · ' + new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    if (!ui.storageError) notice('');
  } catch {
    ui.storageError = '浏览器未能保存进度。请点击「导出存档」备份，并检查浏览器存储权限或可用空间。';
    notice(ui.storageError); $('saveStatus').textContent = '自动保存失败 · 请导出存档';
  }
}
function load(mode) {
  ui.storageError = ''; ui.corrupt = false;
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
  ui.page = name;
  for (const p of ['rules', 'login', 'game']) $(p + 'Page').hidden = p !== name;
  $('backLogin').hidden = name !== 'game';
}
function setDetector(action) { detector = new Detector(action); }
function activeAction() { return ui.page === 'login' ? 'wave' : STAGES[ui.island?.stage]?.action || 'none'; }
function enterGame(mode) {
  if (mode === 'demo') stopCamera();
  clearTransition();
  ui.mode = mode; ui.island = load(mode);
  if (!ui.corrupt) login(ui.island);
  page('game'); setDetector(activeAction());
  $('modeNotice').hidden = mode !== 'demo'; $('demoControls').hidden = mode !== 'demo';
  document.querySelector('.camera-card').hidden = mode === 'demo';
  $('sceneMode').textContent = mode === 'demo' ? 'LOCAL DEMO / 键鼠体验' : 'LOCAL POSE / 体感模式';
  $('startCamera').hidden = mode === 'demo' || camera.running;
  $('stopCamera').hidden = !camera.running;
  if (mode === 'demo') status('键鼠体验使用独立存档。点击模拟动作，或按空格键。');
  if (ui.storageError) notice(ui.storageError);
  save(); render();
}
function showLogin() {
  save(); stopCamera(); clearTransition(); page('login'); setDetector('wave');
  $('loginCamera').disabled = false; $('loginCamera').textContent = '开启摄像头，挥手登岛';
  status('请留出足够活动空间，让上半身和髋部进入画面。');
}
function clearTransition() {
  clearTimeout(transitionTimer); transitionTimer = null;
  ui.transitioning = false; ui.transition = null; $('toast').hidden = true;
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
  $('targetHint').textContent = `每关 ${target} 次 · 每两天 +1 · 最多 15 次`;
  $('campLevel').textContent = 'Lv. ' + s.shelter; $('campName').textContent = SHELTERS[s.shelter];
  $('campBenefit').textContent = s.shelter ? `减少 ${Math.round(PROTECTION[s.shelter] * 100)}% 每日生命损耗 · 每日登岛赠 ${1 + Math.floor(s.shelter / 2)} 体力` : '每一次建造，都会让明天轻松一点。';
  $('shelterSteps').replaceChildren(...Array.from({length: 6}, (_, i) => { const node = document.createElement('span'); node.className = i < s.shelter ? 'done' : ''; node.title = SHELTERS[i + 1]; return node; }));
  $('dailyDrain').textContent = '每天各消耗 1 份水与食物；补给不足会加速掉血。';
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
  $('finishedText').textContent = `本轮运动完成 · ${SHELTERS[s.shelter]} · 生命 ${s.hp} / 100`;
  $('demoMove').disabled = s.failed || s.stage >= 4 || ui.transitioning || ui.corrupt;
  for (const id of ['buyWater', 'buyFood']) $(id).disabled = s.failed || s.stamina < 5 || ui.corrupt;
  if (ui.corrupt) notice(ui.storageError);
}
function doMove(action) {
  if (ui.page !== 'game' || ui.transitioning || ui.corrupt || document.querySelector('dialog[open]')) return;
  const daily = settle(ui.island);
  if (daily.error) { notice(daily.error); return; }
  if (daily.days) {
    login(ui.island); setDetector(activeAction()); save(); render();
    return;
  }
  const s = ui.island, previousStage = s.stage, previousShelter = s.shelter;
  const result = record(s, action);
  if (!result.accepted) { render(); return; }
  save();
  if (result.completed) {
    ui.transitioning = true;
    ui.transition = {stage: previousStage, progress: 1, shelter: previousStage === 3 ? previousShelter + (previousShelter < 6 ? 1 : 0) : s.shelter};
    $('toastTitle').textContent = result.message;
    $('toastDetail').textContent = previousStage === 3 ? SHELTERS[s.shelter] + ' · 本轮运动完成' : STAGES[previousStage].reward + ' · 即将进入下一关';
    $('toast').hidden = false;
    transitionTimer = setTimeout(() => { clearTransition(); setDetector(activeAction()); render(); }, 2400);
    setDetector('none');
  }
  render();
}

function stopCamera() {
  camera.revision++; camera.running = false; camera.starting = false; camera.inFlight = false;
  clearTimeout(camera.timer); camera.timer = null;
  camera.worker?.terminate(); camera.worker = null;
  camera.stream?.getTracks().forEach(track => track.stop()); camera.stream = null;
  $('video').srcObject = null; camera.landmarks = null;
  $('cameraBadge').textContent = '已暂停'; $('cameraBadge').className = 'camera-badge';
  $('cameraPlaceholder').hidden = false; $('stopCamera').hidden = true;
  $('startCamera').hidden = ui.mode === 'demo' && ui.page === 'game'; $('startCamera').disabled = false;
  $('loginPreview').hidden = true; $('loginCamera').disabled = false;
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
async function startCamera() {
  if (camera.starting || camera.running) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof Worker === 'undefined') { status('浏览器无法启用摄像头。请用本地启动程序打开，并使用较新的 Chrome 或 Edge。'); return; }
  camera.starting = true; const revision = ++camera.revision;
  $('loginCamera').disabled = true; $('startCamera').disabled = true;
  status('正在请求摄像头权限…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {width: {ideal: 640}, height: {ideal: 480}, facingMode: 'user', frameRate: {ideal: 24, max: 30}}});
    if (revision !== camera.revision) { stream.getTracks().forEach(t => t.stop()); return; }
    camera.stream = stream; $('video').srcObject = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (revision === camera.revision) { stopCamera(); status('摄像头连接已断开，请检查设备后重新开启。'); } });
    await $('video').play();
    if (revision !== camera.revision) return;
    status('正在加载本机姿态模型，首次开启可能需要几秒…');
    const worker = new Worker(new URL('./pose-worker.js', import.meta.url), {type: 'module'}); camera.worker = worker;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('模型加载超时，请关闭占用资源的程序后重试。')), 45000);
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message || '识别模块无法启动。')); };
      worker.onmessage = ({data}) => {
        if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
        else if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
      };
      worker.postMessage({type: 'init'});
    });
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
      const result = detector.update(data.landmarks, data.timestamp, $('video').videoWidth / $('video').videoHeight);
      if (!ui.transitioning) status(result.hint);
      if (result.count) {
        if (ui.page === 'login') enterGame('camera');
        else if (ui.page === 'game' && ui.mode === 'camera') doMove(detector.action);
      }
    };
    $('cameraBadge').textContent = '本机识别中'; $('cameraBadge').className = 'camera-badge live';
    $('cameraPlaceholder').hidden = true; $('stopCamera').hidden = false; $('startCamera').hidden = true;
    $('loginPreview').hidden = false; $('loginCamera').disabled = false; $('loginCamera').textContent = '摄像头已开启 · 点击暂停';
    $('fps').hidden = false; status('摄像头已就绪，请站稳后完成动作。');
    frameLoop(revision);
  } catch (error) {
    if (revision !== camera.revision) return;
    stopCamera();
    const messages = {NotAllowedError: '未获得摄像头权限。请点击地址栏旁的权限图标允许摄像头，再重试。', NotFoundError: '未找到摄像头，请连接摄像头后重试。', NotReadableError: '摄像头可能被其他应用占用，请关闭占用程序后重试。'};
    status(messages[error.name] || '无法开启本机识别：' + error.message);
    $('loginCamera').textContent = '重试开启摄像头';
  }
}

let lastPaint = 0;
function paint(t) {
  requestAnimationFrame(paint);
  if (t - lastPaint < 32 || document.hidden) return;
  lastPaint = t;
  if (ui.page === 'rules') drawPostcard($('introCanvas'), t);
  else if (ui.page === 'login') {
    drawPostcard($('loginCanvas'), t);
    if (camera.running) mirror($('loginMirror'), $('video'), camera.lastPose + 500 > performance.now() ? camera.landmarks : null);
  } else if (ui.island) {
    const s = ui.island;
    const stage = ui.transition?.stage ?? s.stage;
    const progress = ui.transition?.progress ?? (s.stage < 4 ? s.counts[s.stage] / required(s) : 1);
    const landmarks = camera.lastPose + 500 > performance.now() ? camera.landmarks : null;
    drawWorld($('scene'), {stage, progress, target: required(s), shelter: ui.transition?.shelter ?? s.shelter, video: camera.running ? $('video') : null, landmarks, t, demo: ui.mode === 'demo', transitioning: ui.transitioning});
    if (camera.running) mirror($('cameraMirror'), $('video'), landmarks);
    if (camera.running && camera.lastPose > 0 && performance.now() - camera.lastPose > 5000) {
      stopCamera(); status('识别暂时没有响应，请重新开启摄像头。进度已经保存。');
    }
  }
}
requestAnimationFrame(paint);
const ruleTimer = setInterval(() => {
  const remaining = Math.max(0, Math.ceil((rulesDeadline - performance.now()) / 1000));
  $('enterIsland').textContent = remaining ? `阅读规则 · ${remaining} 秒` : '开始我的荒岛生活 →';
  $('enterIsland').disabled = remaining > 0;
  if (!remaining) clearInterval(ruleTimer);
}, 150);
$('enterIsland').onclick = () => { if (performance.now() >= rulesDeadline) showLogin(); };
$('loginCamera').onclick = () => camera.running || camera.starting ? (stopCamera(), $('loginCamera').textContent = '开启摄像头，挥手登岛') : startCamera();
$('demoLogin').onclick = () => enterGame('demo');
$('startCamera').onclick = startCamera; $('stopCamera').onclick = () => { stopCamera(); status('体感已暂停，运动进度已保存。'); };
$('calibrate').onclick = () => { setDetector(activeAction()); status('已清除旧动作基线，请重新站稳。'); };
$('demoMove').onclick = () => { if (ui.mode === 'demo') doMove(activeAction()); };
$('anotherRound').onclick = () => { if (!ui.corrupt && nextRound(ui.island)) { clearTransition(); setDetector(activeAction()); save(); render(); } };
for (const [id, kind] of [['buyWater', 'water'], ['buyFood', 'food']]) $(id).onclick = () => { if (!ui.corrupt && exchange(ui.island, kind)) { save(); render(); } };
$('help').onclick = () => $('helpDialog').showModal();
for (const id of ['exitDemo', 'backLogin']) $(id).onclick = showLogin;
function confirmAction(title, text, action) {
  $('confirmTitle').textContent = title; $('confirmText').textContent = text;
  const dialog = $('confirmDialog'); dialog.returnValue = ''; dialog.showModal();
  dialog.addEventListener('close', () => { if (dialog.returnValue === 'confirm') action(); }, {once: true});
}
function resetIsland() {
  confirmAction('重新开始荒岛？', `将替换当前${ui.mode === 'demo' ? '试玩' : '体感'}存档。建议先导出存档备份。`, () => {
    clearTransition(); ui.island = fresh(); ui.corrupt = false; ui.storageError = ''; setDetector(activeAction()); save(); render();
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
      clearTransition(); ui.island = imported; ui.corrupt = false; ui.storageError = ''; login(ui.island); setDetector(activeAction()); save(); render();
    });
  } catch (error) { notice('无法导入：' + error.message); }
};
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && !event.repeat && ui.page === 'game' && ui.mode === 'demo' && !document.querySelector('dialog[open]') && !['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault(); doMove(activeAction());
  }
});
document.addEventListener('visibilitychange', () => { setDetector(activeAction()); if (document.hidden) save(); });
window.addEventListener('pagehide', () => { save(); stopCamera(); });
// Stop stale tabs from overwriting a newer game session's save.
window.addEventListener('storage', event => {
  if (event.key === KEYS[ui.mode] && ui.page === 'game') {
    stopCamera(); clearTransition(); ui.corrupt = true;
    ui.storageError = '存档已在另一个标签页更新。本页已暂停写入，请返回登岛页重新载入，避免覆盖新进度。';
    notice(ui.storageError); render();
  }
});
setInterval(() => {
  if (ui.page !== 'game' || ui.corrupt || document.hidden) return;
  const result = settle(ui.island);
  if (result.error) { notice(result.error); return; }
  if (result.days) { clearTransition(); login(ui.island); setDetector(activeAction()); save(); render(); }
}, 15000);
