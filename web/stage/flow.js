// Kiosk flow for the projection page (web/stage.html) as a pure state machine.
// step(state, event) returns {state, effects}; the page performs the effects
// (drawing, sound, speech, network) and reports results back as events.
// Game rules stay in core.js and are called in the same order as web/app.js.
import {STAGES, fresh, sanitize, required, login, record, settle, nextRound, roundSummary} from '../core.js';
import {bigScreenSettlementSummary} from './ui/logic.js';

export const TIMING = {
  presenceLost: 1500,     // no confident pose for this long: nobody in view
  welcomeRepeat: 60000,   // greet the same visitor at most once a minute
  awayPause: 30000,       // nobody in view during a round: pause
  awayEnd: 120000,        // paused this long: end the round without submitting
  transition: 3600,       // stage-complete celebration, as in app.js
  transitionMax: 15000,   // move on even if the count speech never reports back
  slowRep: 3500,          // slower reps earn a short encouragement
  idle: 120000,           // login/ready/failed with nobody around: back to attract
  settleMin: 1500,        // ignore stray keys right after a result appears
  settlementMax: 45000,   // the settlement screen moves on by itself
  submitMax: 15000,       // stop waiting for the leaderboard server
  board: 20000,           // leaderboard countdown before logging out
};
export const PHASES = ['attract', 'login', 'loading', 'ready', 'play', 'failed', 'settlement', 'leaderboard'];

// Somebody is in view when a shoulder and a hip are confidently visible.
export function personInView(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 25) return false;
  const seen = i => (landmarks[i]?.visibility ?? 0) >= 0.5;
  return (seen(11) || seen(12)) && (seen(23) || seen(24));
}

export function initialState({online = false, demo = false, now = 0} = {}) {
  return {phase: 'attract', phaseSince: now, online, demo, cameraLive: false, menu: false, menuSince: 0,
    presence: {present: false, lastSeen: -Infinity, since: -Infinity}, lastWelcome: -Infinity, lastInput: now, session: null};
}
function newSession({user = null, guest = false, offline = false, island = null, persist = false, welcome = 'guest'}) {
  return {user, guest, offline, island, persist, welcome, dirty: false,
    round: null, transition: null, paused: null, watchFrom: 0, lastCountAt: 0, result: null, boardUntil: 0};
}
function newRound(island, now, demo) {
  return {startedAt: now, pausedMs: 0, demo: !!demo, fresh: island.stage === 0 && island.counts.every(count => count === 0)};
}

// Only accounts whose island loaded from the server are saved, never during keyboard demo rounds.
export function canSave(session) { return !!session?.persist && !session.round?.demo; }
// Why a finished round is not ranked; null means it may be submitted.
export function settlementReason(session) {
  if (session?.round?.demo) return 'demo';
  if (session?.offline) return 'offline';
  if (!session?.user || session.guest) return 'guest';
  return null;
}

// Events carry {type, now (monotonic ms), date (YYYY-MM-DD), at (ISO time)}; tests pass them explicitly.
export function step(state, event) {
  const s = structuredClone(state), fx = [];
  const e = {now: 0, ...event};
  const handler = HANDLERS[e.type];
  if (handler) handler(s, e, fx);
  return {state: s, effects: fx};
}
function setPhase(s, phase, now) { s.phase = phase; s.phaseSince = now; }
function save(s, fx) {
  const session = s.session;
  if (!canSave(session)) return;
  session.dirty = false;
  fx.push({type: 'save', user: session.user, island: structuredClone(session.island)});
}

const HANDLERS = {
  'online': (s, e) => { s.online = !!e.online; },
  'camera': (s, e) => {
    s.cameraLive = !!e.live;
    if (s.session) s.session.watchFrom = e.now;
  },
  'input': (s, e) => { s.lastInput = e.now; },
  'pose': onPose,
  'tick': onTick,
  'key': onKey,
  'wave': (s, e, fx) => {
    if (s.menu) return;
    if (s.phase === 'attract') wake(s, e, fx);
    else if (s.phase === 'ready') begin(s, e, fx);
  },
  'wake': (s, e, fx) => { if (s.phase === 'attract' && !s.menu) wake(s, e, fx); },
  'login.done': loginDone,
  'save.loaded': saveLoaded,
  'save.failed': saveFailed,
  'save.conflict': saveConflict,
  'begin': (s, e, fx) => { if (s.phase === 'ready') begin(s, e, fx); },
  'rep': onRep,
  'spoken': (s, e, fx) => {
    const t = s.session?.transition;
    if (s.phase !== 'play' || !t || (e.stage !== undefined && e.stage !== t.stage)) return;
    t.spoken = true;
    advance(s, e, fx);
  },
  'submit.done': (s, e, fx) => {
    const r = s.session?.result;
    if (s.phase !== 'settlement' || !r?.pending) return;
    r.rank = e.rank || null;
    showResult(s, e, fx);
  },
  'submit.failed': (s, e, fx) => {
    const r = s.session?.result;
    if (s.phase !== 'settlement' || !r?.pending) return;
    r.reason = e.queued ? 'queued' : 'offline';
    showResult(s, e, fx);
  },
  'settlement.done': settlementDone,
  'menu.open': (s, e) => {
    if (s.menu) return;
    s.menu = true; s.menuSince = e.now;
    const session = s.session;
    if (s.phase === 'play' && session && !session.paused) session.paused = {reason: 'menu', since: e.now};
  },
  'menu.close': closeMenu,
  'restartStage': restartStage,
  'restartIsland': restartIsland,
  'logout': (s, e, fx) => {
    s.menu = false;
    if (s.phase !== 'attract') exit(s, e, fx, 'logout');
  },
  'demo.toggle': (s, e, fx) => {
    s.demo = !s.demo;
    const session = s.session;
    if (s.demo && session?.round && ['play', 'failed'].includes(s.phase)) session.round.demo = true;
    if (session) session.watchFrom = e.now;
    fx.push({type: 'demo', on: s.demo});
  },
};

function wake(s, e, fx) { setPhase(s, 'login', e.now); s.lastInput = e.now; fx.push({type: 'phase', phase: 'login'}); }

function loginDone(s, e, fx) {
  if (s.phase !== 'login') return;
  if (e.user && !e.guest) {
    s.session = newSession({user: e.user, persist: true, welcome: 'back'});
    setPhase(s, 'loading', e.now);
    fx.push({type: 'phase', phase: 'loading'}, {type: 'loadSave', user: e.user});
    return;
  }
  // Guests neither read nor write a save.
  const offline = !s.online;
  s.session = newSession({guest: true, offline, island: fresh(e.date), welcome: offline ? 'offline' : 'guest'});
  enterReady(s, e, fx);
}
function enterReady(s, e, fx) {
  setPhase(s, 'ready', e.now);
  s.lastInput = e.now;
  fx.push({type: 'phase', phase: 'ready'}, {type: 'ready', welcome: s.session.welcome, user: s.session.user});
}
function saveLoaded(s, e, fx) {
  const session = s.session;
  if (s.phase !== 'loading' || !session) return;
  if (!e.island) {
    session.island = fresh(e.date); session.welcome = 'new'; session.dirty = true;
  } else {
    try {
      session.island = sanitize(e.island, e.date); session.welcome = 'back';
    } catch (error) {
      // Never overwrite a save this device cannot read; play this round without saving.
      session.island = fresh(e.date); session.persist = false; session.welcome = 'new';
      fx.push({type: 'notice', tone: 'warn', text: `存档无法读取（${error.message}），本轮不保存，原存档保持不变。`});
    }
  }
  if (e.conflict) fx.push({type: 'notice', tone: 'info', text: '本机记录与服务器存档不一致，已以服务器为准。'});
  enterReady(s, e, fx);
}
function saveFailed(s, e, fx) {
  const session = s.session;
  if (s.phase !== 'loading' || !session) return;
  // The server is unreachable: continue as a guest so the round can still be played.
  Object.assign(session, {guest: true, offline: true, persist: false, island: fresh(e.date), welcome: 'offline'});
  s.online = false;
  fx.push({type: 'notice', tone: 'warn', text: '连不上服务器，本轮按游客进行，成绩不计入排行。'});
  enterReady(s, e, fx);
}
function saveConflict(s, e, fx) {
  const session = s.session;
  if (!session || !e.island) return;
  try { session.island = sanitize(e.island, e.date); } catch { return; }
  session.dirty = false;
  fx.push({type: 'notice', tone: 'info', text: '存档已在其他设备更新，已以服务器为准。'});
  if (s.phase === 'play' && !session.transition) {
    if (session.island.stage >= 4) enterSettlement(s, e, fx);
    else startStage(s, e, fx, {resume: true});
  }
}

// The wave on the ready screen is the "completed gesture" that core.login rewards, as in app.js enterGame.
function begin(s, e, fx) {
  const session = s.session;
  if (!session?.island) return;
  const daily = login(session.island, e.date);
  if (daily.error) {
    fx.push({type: 'notice', tone: 'warn', text: daily.error + ' 本轮使用临时小岛，不保存。'});
    session.island = fresh(e.date); session.persist = false;
  } else if (daily.days) {
    fx.push({type: 'notice', tone: session.island.failed ? 'warn' : 'info',
      text: `离开了 ${daily.days} 天，生命 −${daily.loss}${daily.downgraded ? `，庇护所下降 ${daily.downgraded} 级` : ''}。`});
  }
  session.dirty = true;
  if (!session.island.failed && session.island.stage === 4) nextRound(session.island, e.date);
  session.round = newRound(session.island, e.now, s.demo);
  session.watchFrom = e.now;
  save(s, fx);
  if (session.island.failed) { setPhase(s, 'failed', e.now); fx.push({type: 'phase', phase: 'failed'}, {type: 'failed'}); return; }
  setPhase(s, 'play', e.now);
  fx.push({type: 'phase', phase: 'play'});
  startStage(s, e, fx, {greeting: true});
}
function startStage(s, e, fx, {greeting = false, resume = false} = {}) {
  const session = s.session, island = session.island, stage = island.stage;
  session.lastCountAt = e.now;
  fx.push({type: 'stage', stage, action: STAGES[stage].action, target: required(island, e.date),
    done: island.counts[stage], greeting, resume, island: structuredClone(island)});
}

// One counted move. Keyboard demo reps only count in demo mode, camera reps only outside it.
function onRep(s, e, fx) {
  const session = s.session, island = session?.island;
  if (s.phase !== 'play' || !island || session.transition || session.paused || s.menu || island.stage >= 4) return;
  if (e.source === 'demo' ? !s.demo : s.demo) return;
  if (e.action && e.action !== STAGES[island.stage].action) return;
  const daily = settle(island, e.date);
  if (daily.error) { fx.push({type: 'notice', tone: 'warn', text: daily.error}); return; }
  if (daily.days) { newDay(s, e, fx, daily); return; }
  const stage = island.stage, shelterBefore = island.shelter;
  const result = record(island, STAGES[stage].action, e.date);
  if (!result.accepted) {
    if (result.message) fx.push({type: 'notice', tone: 'warn', text: result.message});
    return;
  }
  session.dirty = true;
  if (session.round && e.source === 'demo') session.round.demo = true;
  const count = island.counts[stage], target = required(island, e.date);
  const slow = e.now - session.lastCountAt > TIMING.slowRep;
  session.lastCountAt = e.now; session.watchFrom = e.now;
  fx.push({type: 'rep', stage, action: STAGES[stage].action, count, target, completed: !!result.completed,
    shelter: island.shelter, reinforced: stage === 3 && shelterBefore === 6, slow, source: e.source || 'camera'});
  if (!result.completed) return;
  session.transition = {stage, at: e.now, spoken: false};
  fx.push({type: 'stageDone', stage, message: result.message, shelter: island.shelter, shelterBefore,
    resources: {water: island.water, wood: island.wood, food: island.food}, hp: island.hp});
  save(s, fx);
}
function newDay(s, e, fx, daily) {
  const session = s.session, island = session.island;
  session.transition = null;
  login(island, e.date);
  session.round = newRound(island, e.now, s.demo);
  session.dirty = true;
  save(s, fx);
  fx.push({type: 'notice', tone: 'info', text: `新的一天已结算：经过 ${daily.days} 天，生命 −${daily.loss}。今天的目标已更新。`});
  if (island.failed) { setPhase(s, 'failed', e.now); fx.push({type: 'phase', phase: 'failed'}, {type: 'failed'}); return; }
  if (s.phase !== 'play') { setPhase(s, 'play', e.now); fx.push({type: 'phase', phase: 'play'}); }
  startStage(s, e, fx);
}
// After a stage is complete: wait for the celebration and the count speech, as in app.js.
function advance(s, e, fx) {
  const session = s.session, t = session?.transition;
  if (s.phase !== 'play' || !t || session.paused || s.menu) return;
  const elapsed = e.now - t.at;
  if (elapsed < TIMING.transition || (!t.spoken && elapsed < TIMING.transitionMax)) return;
  const daily = settle(session.island, e.date);
  if (daily.error) return;
  if (daily.days) { newDay(s, e, fx, daily); return; }
  session.transition = null;
  if (session.island.stage >= 4) enterSettlement(s, e, fx);
  else startStage(s, e, fx);
}

function enterSettlement(s, e, fx) {
  const session = s.session, round = session.round || newRound(session.island, e.now, s.demo);
  const summary = bigScreenSettlementSummary(roundSummary(session.island));
  const reason = settlementReason(session);
  const submit = reason === null && round.fresh;
  session.result = {summary, reason, rank: null, pending: submit, shownAt: 0, demo: !!round.demo};
  setPhase(s, 'settlement', e.now);
  fx.push({type: 'phase', phase: 'settlement'});
  if (session.dirty) save(s, fx);
  const durationSec = Math.max(1, Math.round((e.now - round.startedAt - round.pausedMs) / 1000));
  fx.push({type: 'settle', summary, reason, demo: !!round.demo,
    submit: submit ? {counts: [...session.island.counts], durationSec, mode: 'camera', finishedAt: e.at} : null});
  if (!submit) showResult(s, e, fx);
}
function showResult(s, e, fx) {
  const r = s.session.result;
  r.pending = false; r.shownAt = e.now;
  fx.push({type: 'result', summary: r.summary, rank: r.rank, reason: r.reason, demo: r.demo});
}
function settlementDone(s, e, fx) {
  const r = s.session?.result;
  if (s.phase !== 'settlement' || !r || r.pending || s.menu) return;
  if (!e.force && e.now - r.shownAt < TIMING.settleMin) return;
  if (!s.online) { exit(s, e, fx, 'done'); return; }
  setPhase(s, 'leaderboard', e.now);
  s.session.boardUntil = e.now + TIMING.board;
  fx.push({type: 'phase', phase: 'leaderboard'}, {type: 'board', user: s.session.user, until: s.session.boardUntil});
}
// Back to attract. Progress already earned is kept; an unfinished round is never submitted.
function exit(s, e, fx, reason) {
  const session = s.session;
  if (session?.dirty) save(s, fx);
  fx.push({type: 'exit', reason, user: session?.user || null});
  s.session = null; s.menu = false;
  setPhase(s, 'attract', e.now);
  s.lastInput = e.now;
  fx.push({type: 'phase', phase: 'attract'});
}

function onPose(s, e, fx) {
  if (!e.present) return;
  const p = s.presence, arrived = !p.present;
  p.present = true; p.lastSeen = e.now;
  if (arrived) p.since = e.now;
  if (arrived && s.phase === 'attract' && !s.menu && e.now - s.lastWelcome >= TIMING.welcomeRepeat) {
    s.lastWelcome = e.now;
    fx.push({type: 'welcome'});
  }
  const session = s.session;
  if (session?.paused?.reason === 'away' && !s.menu) resume(s, e, fx);
}
function onTick(s, e, fx) {
  const p = s.presence;
  if (p.present && e.now - p.lastSeen > TIMING.presenceLost) p.present = false;
  if (s.menu) return;
  const session = s.session;
  if (s.phase === 'play' && session) {
    if (e.date && !session.transition && !session.paused && session.island.settled !== e.date) {
      const daily = settle(session.island, e.date);
      if (daily.days) { newDay(s, e, fx, daily); return; }
    }
    const watching = s.cameraLive && !s.demo;
    if (watching && !session.paused && !p.present && e.now - Math.max(p.lastSeen, session.watchFrom) > TIMING.awayPause) {
      pause(s, e, fx, 'away');
      return;
    }
    if (session.paused?.reason === 'away' && e.now - session.paused.since > TIMING.awayEnd) { exit(s, e, fx, 'away'); return; }
    advance(s, e, fx);
  } else if (s.phase === 'settlement' && session?.result) {
    const r = session.result;
    if (r.pending && e.now - s.phaseSince > TIMING.submitMax) { r.reason = 'offline'; showResult(s, e, fx); }
    else if (!r.pending && e.now - r.shownAt > TIMING.settlementMax) settlementDone(s, {...e, force: true}, fx);
  } else if (s.phase === 'leaderboard' && session) {
    if (e.now >= session.boardUntil) exit(s, e, fx, 'done');
  } else if (['login', 'loading', 'ready', 'failed'].includes(s.phase)) {
    const active = Math.max(s.lastInput, s.phaseSince, p.present ? e.now : p.lastSeen);
    if (e.now - active > TIMING.idle) exit(s, e, fx, 'idle');
  }
}
function pause(s, e, fx, reason) {
  s.session.paused = {reason, since: e.now};
  fx.push({type: 'pause', reason});
}
function resume(s, e, fx) {
  const session = s.session, paused = session.paused;
  session.paused = null;
  if (session.round && paused) session.round.pausedMs += e.now - paused.since;
  session.watchFrom = e.now; session.lastCountAt = e.now;
  fx.push({type: 'resume', reason: paused?.reason || null});
  if (session.transition) advance(s, e, fx);
  else if (session.island.stage < 4) startStage(s, e, fx, {resume: true});
}
function closeMenu(s, e, fx) {
  if (!s.menu) return;
  const held = e.now - s.menuSince;
  s.menu = false;
  const session = s.session;
  if (!session) return;
  if (s.phase === 'leaderboard') session.boardUntil += held;
  if (session.result?.shownAt) session.result.shownAt += held;
  if (session.paused?.reason === 'menu') resume(s, e, fx);
  else if (session.paused?.reason === 'away') session.paused.since = e.now;
}
// Menu "重来本关": undo the current stage's counted reps (and the stamina they earned).
function restartStage(s, e, fx) {
  const session = s.session, island = session?.island;
  if (s.phase !== 'play' || !island || session.transition || island.stage >= 4) return;
  const n = island.counts[island.stage];
  island.counts[island.stage] = 0;
  island.stamina = Math.max(0, island.stamina - n);
  island.moves = Math.max(0, island.moves - n);
  if (n) session.dirty = true;
  if (session.round) session.round.fresh = session.round.fresh && island.stage === 0;
  s.menu = false;
  if (session.paused) { if (session.round) session.round.pausedMs += e.now - session.paused.since; session.paused = null; }
  session.watchFrom = e.now;
  fx.push({type: 'notice', tone: 'info', text: '本关重新开始。'});
  startStage(s, e, fx);
}
// Menu "重新开岛" after the island failed; the teacher confirms it in the menu first.
function restartIsland(s, e, fx) {
  const session = s.session;
  if (s.phase !== 'failed' || !session) return;
  session.island = fresh(e.date);
  session.round = newRound(session.island, e.now, s.demo);
  session.paused = null; session.transition = null; session.dirty = true; session.watchFrom = e.now;
  s.menu = false;
  save(s, fx);
  setPhase(s, 'play', e.now);
  fx.push({type: 'phase', phase: 'play'}, {type: 'notice', tone: 'info', text: '新的小岛准备好了。'});
  startStage(s, e, fx);
}
// Keys that are not page shortcuts (F, C, M, D, Esc are handled by the page itself).
function onKey(s, e, fx) {
  s.lastInput = e.now;
  if (e.repeat || s.menu) return;
  if (s.phase === 'attract') wake(s, e, fx);
  else if (s.phase === 'ready' && (e.key === 'Enter' || (e.key === ' ' && s.demo))) begin(s, e, fx);
  else if (s.phase === 'play' && e.key === ' ' && s.demo) onRep(s, {...e, source: 'demo'}, fx);
  else if (s.phase === 'settlement') settlementDone(s, e, fx);
  else if (s.phase === 'leaderboard' && e.now - s.phaseSince >= TIMING.settleMin) exit(s, e, fx, 'done');
}
