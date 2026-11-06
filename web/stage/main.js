// 大屏页主控：把 flow.js 状态机的 effects 落到画面、声音、旁白和网络上，再把结果作为事件送回去。
// 其他模块一律动态 import，缺失或报错时降级：3D → 2D，小人 → 不显示，音效 → 静音，接口 → 游客/离线。
import {step, initialState, TIMING} from './flow.js';
import {STAGES, SHELTERS, today} from '../core.js';
import {kioskParts, stageParts, countParts, settlementParts, correctionParts, failedParts, cameraError} from '../narration.js';
import {createWorld} from './world.js';
import {createHud} from './hud.js';
import {createScreens} from './screens.js';
import {createMenu} from './menu.js';
import {createSpeech} from './speech.js';
import {createCamera} from './camera.js';
import {createSaves} from './saves.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const reducedMotion = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
const pref = (key, fallback) => { try { return localStorage.getItem('movecraft.stage.' + key) ?? fallback; } catch { return fallback; } };
const setPref = (key, value) => { try { localStorage.setItem('movecraft.stage.' + key, String(value)); } catch { /* not remembered */ } };
const load = path => import(path).catch(error => { console.warn('[stage] 模块没有加载：', path, error?.message || error); return null; });
const timeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), {code: 'network'})), ms))]);
const safe = (fn, ...args) => { try { return fn?.(...args); } catch (error) { console.warn('[stage]', error); return undefined; } };

const [THREE, islandModule, avatarModule, sfxModule, poseModule, qualityModule, apiModule, accountUi, boardUi, settlementUi] = await Promise.all([
  params.get('3d') === '0' ? null : load('three'), load('../world/island.js'), load('../world/avatar.js'), load('./sfx.js'),
  load('./pose-stream.js'), load('./quality.js'), load('../net/api.js'),
  load('./ui/account.js'), load('./ui/board.js'), load('./ui/settlement.js'),
]);
// TEMP: 正式的 api.js 和 ui 组件交付前，用 fakes.js 的临时登录和排行榜走流程；交付后删掉这一段和 fakes.js。
const useFake = params.has('fake');
const fakes = useFake || !accountUi?.mountLogin || !boardUi?.mountBoard ? await load('./fakes.js') : null;

function storage(name) { try { const s = globalThis[name]; s?.getItem('x'); return s; } catch { return undefined; } }
function makeApi() {
  if (useFake && fakes) return fakes.createFakeApi({mode: params.get('fake') || ''});
  if (!apiModule?.createApi) return null;
  try {
    const base = document.querySelector('meta[name="movecraft-api"]')?.content;
    return apiModule.createApi({...(base ? {base} : {}), storage: storage('localStorage'), sessionStorage: storage('sessionStorage'), fetch: globalThis.fetch?.bind(globalThis)});
  } catch (error) { console.warn('[stage] api 初始化失败：', error); return null; }
}
const api = makeApi();
const ui = {
  mountLogin: accountUi?.mountLogin || fakes?.mountLogin || null,
  mountBoard: boardUi?.mountBoard || fakes?.mountBoard || null,
  mountSettlement: settlementUi?.mountSettlement || null,
};
const NOOP_SFX = {available: false, unlock() {}, play() {}, ambient() {}, setVolume() {}, mute() {}, duck() {}};
const sfx = (() => { try { return sfxModule?.createSfx?.({}) || NOOP_SFX; } catch (error) { console.warn('[stage] 音效不可用：', error); return NOOP_SFX; } })();
const speech = createSpeech({sfx});
const hud = createHud({reducedMotion});
const screens = createScreens({ui});
const menu = createMenu({sfx});
let booted = false;
const world = createWorld({canvas: $('world'), canvas2d: $('world2d'), THREE, islandModule, avatarModule, qualityModule, reducedMotion,
  onFallback: () => { if (booted) { applyCam(); hud.notice('3D 画面出错，已切换到简单画面，游戏照常进行。', 'warn'); } }});
const camera = createCamera({poseModule, onFrame, onDetect, onStatus: onCameraStatus});
const saves = createSaves({api,
  onConflict: island => { if (island) send('save.conflict', {island}); },
  onNotice: (text, tone) => hud.notice(text, tone)});
const modules = {
  three: !!THREE, island: !!islandModule?.createIsland, avatar: !!avatarModule?.createAvatar, sfx: sfx !== NOOP_SFX,
  poseStream: !!poseModule?.createPoseStream, quality: !!qualityModule?.createQuality, api: api ? (api.fake ? 'fake' : 'real') : null,
  account: accountUi?.mountLogin ? 'real' : fakes?.mountLogin ? 'fake' : null, board: boardUi?.mountBoard ? 'real' : fakes?.mountBoard ? 'fake' : null,
  settlement: settlementUi?.mountSettlement ? 'real' : 'plain',
};

// ---- 状态机 ----
let state = initialState({online: false, demo: params.has('demo'), now: performance.now()});
let sessionRev = 0, muted = pref('muted', '0') === '1', volume = Number(pref('volume', '0.8'));
let qualityChoice = pref('quality', 'auto'), camVisible = pref('cam', '1') === '1';
const queue = [];
let busy = false;
function send(type, extra = {}) {
  queue.push({type, ...extra});
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const event = queue.shift();
      const now = new Date();
      let result;
      try { result = step(state, {now: performance.now(), date: today(now), at: now.toISOString(), ...event}); } catch (error) { console.error('[stage] flow error', event.type, error); continue; }
      state = result.state;
      for (const effect of result.effects) { try { perform(effect); } catch (error) { console.error('[stage] effect error', effect.type, error); } }
    }
  } finally { busy = false; }
  syncChrome();
}
function syncChrome() {
  document.body.dataset.phase = state.phase;
  const session = state.session, badges = [];
  if (session?.user && !session.guest) badges.push({text: session.user.username || session.user.name || '已登录', kind: 'user'});
  if (session && (session.guest || session.offline)) badges.push({text: '游客 · 成绩不计入排行', kind: 'guest'});
  if (state.demo) badges.push({text: '试玩', kind: 'demo'});
  if (!state.online || session?.offline) badges.push({text: '离线', kind: 'offline'});
  if (muted) badges.push({text: '静音', kind: 'user'});
  const key = JSON.stringify(badges);
  if (key !== syncChrome.last) { syncChrome.last = key; hud.badges(badges); }
  if (!state.menu && menu.open) menu.hide();
  syncAction();
}
// The detector follows the screen: wave on attract/ready, the stage's move while playing with the camera.
let currentAction = null;
function wantedAction() {
  const s = state, session = s.session;
  if (s.menu) return 'none';
  if (s.phase === 'attract' || s.phase === 'ready') return 'wave';
  if (s.phase === 'play' && !s.demo && session && !session.transition && !session.paused && session.island?.stage < 4) return STAGES[session.island.stage].action;
  return 'none';
}
function syncAction(force = false) {
  const action = wantedAction();
  if (!force && action === currentAction) return;
  currentAction = action;
  camera.setAction(action);
}
// ---- effects ----
function perform(effect) {
  switch (effect.type) {
    case 'phase': return enterPhase(effect.phase);
    case 'loadSave': return loadSave(effect.user);
    case 'ready': return onReady(effect);
    case 'stage': return onStage(effect);
    case 'rep': return onRep(effect);
    case 'stageDone': return onStageDone(effect);
    case 'save': return saves.save(effect.user, effect.island);
    case 'settle': return onSettle(effect);
    case 'result': return onResult(effect);
    case 'board': return onBoard(effect);
    case 'exit': return onExit(effect);
    case 'welcome': return speech.say(kioskParts('attract'), {key: 'kiosk.attract'});
    case 'pause': return onPause(effect);
    case 'resume': return screens.pause(false);
    case 'failed': return onFailed();
    case 'demo': return onDemo(effect.on);
    case 'notice': return hud.notice(effect.text, effect.tone);
    default: return undefined;
  }
}
function enterPhase(phase) {
  screens.show(phase);
  hud.show(phase === 'play' || phase === 'failed' ? phase : false);
  if (phase !== 'play') { screens.pause(false); hud.clearToast(); }
  world.attract(phase === 'attract');
  if (phase === 'attract') {
    screens.unmountAll();
    screens.attract({api, cameraLive: camera.live});
    checkOnline();
  } else if (phase === 'login') {
    screens.unmountAll();
    openLogin();
  } else if (phase === 'settlement') screens.settlementPending();
}
function openLogin() {
  const handle = screens.login({api, sfx, onDone: result => {
    if (state.phase !== 'login') return;
    if (result?.user) { sessionRev++; send('login.done', {user: normalizeUser(result.user)}); }
    else if (result?.guest) send('login.done', {guest: true});
    else send('logout');
  }, onCancel: () => { if (state.phase === 'login') send('logout'); }});
  if (!handle) {
    hud.notice('账号服务暂时不可用，本轮按游客进行，成绩不计入排行。', 'warn');
    send('login.done', {guest: true});
    return;
  }
  if (!state.online) hud.notice('现在连不上服务器，可以先选「游客」。', 'warn');
  speech.say(kioskParts('loginPrompt'), {key: 'kiosk.loginPrompt'});
}
const normalizeUser = user => ({...user, id: user.id ?? user.username, username: user.username ?? user.name ?? ''});

async function loadSave() {
  const rev = sessionRev;
  if (!api?.loadSave) { send('save.failed'); return; }
  try {
    const result = await timeout(api.loadSave(), 12000);
    if (rev !== sessionRev || state.phase !== 'loading') return;
    const island = result && typeof result === 'object' && 'data' in result ? result.data : result;
    send('save.loaded', {island: island && typeof island === 'object' ? island : null});
  } catch (error) {
    if (rev !== sessionRev || state.phase !== 'loading') return;
    console.warn('[stage] 读取存档失败：', error?.code || error);
    send('save.failed');
  }
}
function onReady({welcome, user}) {
  saves.reset(user ? user.id ?? user.username : null);
  screens.ready({welcome, user, cameraLive: camera.live, demo: state.demo});
  sfx.play('login');
  const first = {new: 'welcomeNew', back: 'welcomeBack', guest: 'guest', offline: 'offline'}[welcome] || 'guest';
  speech.say([...kioskParts(first), ...kioskParts('wavePrompt')], {key: 'kiosk.ready.' + first});
}
// ---- 游戏中 ----
const PART = {jump: 'legs', jack: 'body', raise: 'arms', squat: 'legs'};
let lastCountAt = 0, hintSince = 0, lastHintText = '', repPulseUntil = 0, sideTimer = 0;
const demoHint = stage => `键鼠试玩：按空格算一次${STAGES[stage].move}`;
function onStage({stage, action, target, done, greeting, island}) {
  world.focus(stage, {target, done});
  world.shelter(island.shelter, false);
  world.resources({water: island.water, wood: island.wood, food: island.food});
  if (done > 0) world.rep(stage, done, target);
  hud.show('play');
  hud.stage({stage, target, done, island});
  // Put the big counter on the side away from the player once the camera has eased over.
  clearTimeout(sideTimer);
  const side = () => { const p = world.player(); hud.side(p && p.x < innerWidth / 2 ? 'right' : 'left'); };
  side(); sideTimer = setTimeout(side, 1500);
  lastCountAt = performance.now(); hintSince = lastCountAt; lastHintText = '';
  hud.hint(state.demo ? demoHint(stage) : STAGES[stage].guide);
  syncAction(true);
  speech.say(stageParts({stage, target, done, greeting}), {key: `stage.${action}`});
}
function onRep({stage, action, count, target, completed, shelter, reinforced, slow, source}) {
  lastCountAt = performance.now();
  hud.count(count, target);
  world.rep(stage, count, target);
  world.flash(PART[action] || 'body');
  if (source === 'demo') repPulseUntil = performance.now() + 900;
  sfx.play(completed ? 'repFinal' : 'rep', {pitch: target ? count / target : 0});
  const spoken = speech.say(countParts({stage, count, target, shelter, reinforced, slow}), {key: `count.${action}.${count}`, replace: false, group: 'count'});
  if (completed) spoken.then(() => send('spoken', {stage}));
}
function onStageDone({stage, message, shelter, shelterBefore, resources, hp}) {
  sfx.play('stageDone');
  world.stageDone(stage);
  hud.reward({stage, resources, hp, shelter, shelterBefore}, world.origin());
  if (stage === 3 && shelter > shelterBefore) { world.shelter(shelter, true); setTimeout(() => sfx.play('shelterUp'), 500); }
  world.resources(resources);
  const detail = stage < 3 ? STAGES[stage].reward + ' · 准备下一关' : `${SHELTERS[shelter]} · 这一轮完成`;
  hud.toast(message || STAGES[stage].result, detail, ['water', 'wood', 'food', 'house'][stage]);
  hud.hint(stage < 3 ? `下一关：${STAGES[stage + 1].name} · ${STAGES[stage + 1].move}` : '四关全部完成！');
}

// ---- 结算、排行榜、退出 ----
function onSettle({submit}) {
  world.celebrate();
  sfx.play('roundDone');
  if (!submit) return;
  const rev = sessionRev;
  if (!api?.submitRound) { send('submit.failed', {queued: false}); return; }
  timeout(Promise.resolve().then(() => api.submitRound(submit)), TIMING.submitMax - 1000).then(result => {
    if (rev !== sessionRev) return;
    if (result?.queued) send('submit.failed', {queued: true});
    else send('submit.done', {rank: Number.isInteger(result?.weekRank)
      ? {weekRank: result.weekRank, weekPercentile: result.weekPercentile ?? null, weekTotal: result.weekTotal ?? null} : null});
  }, error => {
    if (rev !== sessionRev) return;
    console.warn('[stage] 提交成绩失败：', error?.code || error);
    if (error?.code === 'rejected' || error?.code === 'invalid') send('submit.done', {rank: null});
    else send('submit.failed', {queued: false});
  });
}
function onResult({summary, rank, reason, demo}) {
  screens.settlement({summary, rank, reason, demo, sfx, onDone: () => send('settlement.done')});
  speech.say(settlementParts({demo, summary, percentile: false, gamePercentile: summary.percentile, reason}), {key: 'settlement'});
}
function onBoard({user}) {
  screens.board({api, user});
  sfx.play('whoosh');
  countdown();
}
let lastCount = null;
function countdown() {
  if (state.phase !== 'leaderboard' || !state.session) { lastCount = null; return; }
  const seconds = Math.max(0, Math.ceil((state.session.boardUntil - performance.now()) / 1000));
  if (seconds === lastCount) return;
  lastCount = seconds;
  screens.countdown(seconds);
  if (seconds <= 3 && seconds > 0) sfx.play('countdown');
}
function onExit({reason, user}) {
  const rev = ++sessionRev;
  speech.cancel();
  if (reason === 'done') speech.say(kioskParts('bye'), {key: 'kiosk.bye'});
  menu.hide(); screens.pause(false); hud.reset();
  if (!user || !api) { saves.reset(null); return; }
  const id = user.id ?? user.username;
  saves.drain().then(() => {
    if (rev !== sessionRev || (api.user && (api.user.id ?? api.user.username) !== id)) return;
    saves.reset(null);
    return api.logout?.();
  }).catch(error => console.warn('[stage] 退出登录失败：', error?.code || error));
}
function onPause({reason}) {
  if (reason !== 'away') return;
  speech.cancel();
  screens.pause(true, {title: '没有看到你', sub: `回到镜头前就能继续 · ${Math.round(TIMING.awayEnd / 60000)} 分钟后自动结束这一轮`});
}
function onFailed() {
  sfx.play('error');
  hud.show('failed');
  if (state.session?.island) hud.values(state.session.island);
  hud.hint('老师按 Esc 打开菜单，选「重新开岛」', 'warn');
  speech.say(failedParts(), {key: 'island.failed'});
}
function onDemo(on) {
  world.setDemoMode(on);
  if (state.phase === 'ready') screens.readyCta({cameraLive: camera.live, demo: on});
  const stage = state.session?.island?.stage;
  if (state.phase === 'play' && stage < 4) hud.hint(on ? demoHint(stage) : STAGES[stage].guide);
  hud.notice(on ? '键鼠试玩已打开：空格算一次动作，成绩不提交。' : state.session?.round?.demo ? '键鼠试玩已关闭。这一轮仍按试玩结算，不提交成绩。' : '键鼠试玩已关闭。', 'info', 4000);
  syncAction(true);
}

// ---- 摄像头 ----
function onFrame({landmarks, worldLandmarks, timestamp, present}) {
  if (!present) { world.noPose(); return; }
  world.pose(landmarks, worldLandmarks, timestamp);
  send('pose', {present: true});
}
function onDetect(result, action) {
  if (result.count) {
    if (action === 'wave') send('wave');
    else send('rep', {action, source: 'camera'});
    return;
  }
  if (state.phase === 'ready' && action === 'wave') { screens.readyHint(result.hint); return; }
  const session = state.session;
  if (state.phase !== 'play' || state.demo || state.menu || !session || session.transition || session.paused || action !== currentAction) return;
  const now = performance.now();
  if (result.hint !== lastHintText) { lastHintText = result.hint; hintSince = now; }
  hud.hint(result.hint, result.valid === false ? 'warn' : 'info');
  if (speech.busy || now - lastCountAt < 7000 || now - hintSince < 2500) return;
  speech.say(correctionParts(result.hint), {key: result.hint, correction: true});
}
let lastCamError = -Infinity;
function onCameraStatus({state: camState, error, changed}) {
  $('cam').dataset.state = camState;
  $('camText').textContent = camText(camState);
  if (camState === 'error' && performance.now() - lastCamError > 60000) {
    lastCamError = performance.now();
    hud.notice(cameraError(error).screen + ' 可以按 D 用键鼠试玩。', 'warn', 9000);
  }
  if (!changed) return;
  applyCam();
  send('camera', {live: camera.live});
  if (state.phase === 'ready') screens.readyCta({cameraLive: camera.live, demo: state.demo});
  if (state.phase === 'attract') screens.attractSub(camera.live);
}
function camText(s) {
  return {starting: '正在开启摄像头…', ready: '摄像头就绪', running: `识别中 · ${Math.round(camera.fps)} 帧/秒`, stalled: '识别暂时没有响应',
    error: '摄像头打不开', stopped: '摄像头已关闭', unavailable: '没有摄像头模块'}[s] || '摄像头';
}
// ---- 键盘、鼠标 ----
const IGNORED = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'NumLock', 'ScrollLock', 'ContextMenu', 'Dead', 'Process', 'Unidentified',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'MediaPlayPause', 'PrintScreen']);
const typing = () => {
  const node = document.activeElement;
  if (!node || node === document.body) return false;
  if (node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
  return node.tagName === 'INPUT' && !['button', 'submit', 'checkbox', 'radio', 'range', 'reset'].includes(node.type);
};
let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  safe(() => sfx.unlock());
  safe(() => sfx.ambient(true));
}
document.addEventListener('keydown', event => {
  unlock();
  send('input');
  if (event.isComposing || event.keyCode === 229) return;
  if (menu.open) { if (event.key.toLowerCase() === 'f') toggleFullscreen(); else menu.key(event); return; }
  if (typing()) return;  // 光标在输入框里时，所有快捷键都不生效
  if (event.ctrlKey || event.metaKey || event.altKey || IGNORED.has(event.key) || /^F\d+$/.test(event.key)) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === 'Escape') {
    if (state.phase !== 'login') openMenu();
    else if (!$('loginRoot').contains(document.activeElement)) send('logout');
    return;
  }
  if (event.repeat) return;
  if (key === 'f') return toggleFullscreen();
  if (key === 'c') { camVisible = !camVisible; setPref('cam', camVisible ? 1 : 0); applyCam(); return; }
  if (key === 'm') return setMuted(!muted);
  if (key === 'd') return send('demo.toggle');
  if (key === ' ' && (state.phase === 'play' || state.phase === 'ready')) event.preventDefault();
  send('key', {key: event.key, repeat: event.repeat});
});
document.addEventListener('pointerdown', event => {
  unlock();
  send('input');
  if (state.phase === 'attract' && !state.menu && !$('attractBoard').contains(event.target)) send('wake');
});
// C: the corner window in 3D; the 2D scene has its own mirror panel, so C switches that one instead.
function applyCam() {
  $('cam').hidden = !camVisible || world.mode !== '3d';
  world.setVideo(camVisible && camera.live ? camera.video : null);
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => hud.notice('浏览器不允许全屏，可以按 F11。', 'warn', 4000));
}
function setMuted(on) {
  muted = on; setPref('muted', on ? 1 : 0);
  speech.mute(on); safe(() => sfx.mute(on));
  syncChrome();
}
// ---- Esc 菜单 ----
const QUALITY = ['auto', 'low', 'medium', 'high'];
const QUALITY_TEXT = {auto: '自动', low: '低', medium: '中', high: '高'};
function openMenu() {
  if (state.menu) return;
  speech.cancel();
  send('menu.open');
  menu.show(menuItems(), {onClose: () => send('menu.close')});
}
function menuItems() {
  const s = state, inRound = s.phase === 'play' && !!s.session && !s.session.transition;
  const items = [{label: '继续', run() {}}];
  if (s.phase === 'failed') items.push({label: '重新开岛', danger: true, confirm: true, armedLabel: '确定重新开岛？原来的小岛会被替换，再按 Enter 确认', run: () => send('restartIsland')});
  else items.push({label: '重来本关', disabled: !inRound, run: () => send('restartStage')});
  items.push(
    {label: '切换摄像头', disabled: !camera.available, keep: true, value: () => camera.label.slice(0, 18),
      run: () => camera.next().then(label => { hud.notice('摄像头：' + label, 'info', 3000); menu.refresh(); })},
    {label: '画质', keep: true, value: () => QUALITY_TEXT[qualityChoice] + (world.mode === '2d' ? ' · 简单画面' : ''), run: () => cycleQuality(1), adjust: cycleQuality},
    {label: '音量', keep: true, value: () => muted ? '静音' : Math.round(volume * 100) + '%', run: () => setMuted(!muted), adjust: dir => setVolume(volume + dir * 0.1)},
  );
  if (s.session) items.push({label: '退出登录', danger: true, run: () => send('logout')});
  return items;
}
function cycleQuality(dir) {
  qualityChoice = QUALITY[(QUALITY.indexOf(qualityChoice) + dir + QUALITY.length) % QUALITY.length];
  setPref('quality', qualityChoice);
  world.setQuality(qualityChoice);
}
function setVolume(v) {
  volume = Math.round(Math.max(0, Math.min(1, v)) * 10) / 10;
  setPref('volume', volume);
  safe(() => sfx.setVolume(volume)); speech.setVolume(volume);
  if (muted && volume > 0) setMuted(false);
}

// ---- 每 250 ms 一次：计时、倒计时、小人示范动作；每帧：画面 ----
const ATTRACT_DEMO = ['wave', 'jump', 'jack', 'raise', 'squat'];
let lastOnlineCheck = -Infinity, lastCamText = 0;
function tick() {
  send('tick');
  const now = performance.now();
  countdown();
  if (state.phase === 'attract' && now - lastOnlineCheck > 30000) checkOnline();
  if (camera.state === 'running' && now - lastCamText > 1000) { lastCamText = now; $('camText').textContent = camText('running'); }
  if (state.presence.present && camera.fresh(700)) return;  // the player drives the avatar
  const stage = state.session?.island?.stage;
  if (now < repPulseUntil && stage < 4) world.demo(STAGES[stage].action);
  else if (state.phase === 'attract') world.demo(ATTRACT_DEMO[Math.floor(now / 4000) % ATTRACT_DEMO.length]);
  else if (state.phase === 'ready') world.demo('wave');
  else if (state.phase === 'play' && !state.demo && stage < 4) world.demo(STAGES[stage].action);
  else world.demo('idle');
}
async function checkOnline() {
  lastOnlineCheck = performance.now();
  if (!api?.health) { if (state.online) send('online', {online: false}); return; }
  let online = false;
  try { await timeout(api.health(), 5000); online = true; } catch { online = false; }
  if (online !== state.online) send('online', {online});
  if (online) safe(() => api.flush?.())?.catch?.(() => {});
}
let lastFrame = performance.now(), lastCam = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, Math.max(0, t - lastFrame));
  lastFrame = t;
  world.frame(dt, t, {poseFps: camera.fps});
  if (camVisible && world.mode === '3d' && t - lastCam > 66) { lastCam = t; safe(() => camera.draw($('camCanvas'))); }
}

// ---- 启动 ----
speech.mute(muted); speech.setVolume(volume);
safe(() => sfx.setVolume(volume)); safe(() => sfx.mute(muted));
if (qualityChoice !== 'auto') world.setQuality(qualityChoice);
applyCam();
$('cam').dataset.state = camera.state; $('camText').textContent = camText(camera.state);
world.setDemoMode(state.demo);
booted = true;
enterPhase('attract');
syncChrome();
if (camera.available) camera.start();
setInterval(tick, 250);
requestAnimationFrame(frame);
addEventListener('pagehide', () => { camera.stop(); speech.cancel(); });
console.info('[stage] modules', JSON.stringify(modules), 'render', world.mode, world.error?.message || '');
// Read-only status for tests and for checking the projector PC from the console.
window.__stage = Object.freeze({modules, get render() { return world.mode; }, get renderError() { return world.error?.message || null; },
  get phase() { return state.phase; }, get demo() { return state.demo; }, get online() { return state.online; },
  get camera() { return camera.state; }, get stage() { return state.session?.island?.stage ?? null; }});
window.__stageBooted = true;
