import test from 'node:test';
import assert from 'node:assert/strict';
import {step, initialState, TIMING, personInView, canSave, settlementReason} from '../web/stage/flow.js';
import {STAGES, fresh} from '../web/core.js';

const DATE = '2026-11-07';
const AT = '2026-11-07T08:00:00.000Z';
function machine({online = true, demo = false, date = DATE} = {}) {
  const m = {now: 0, date, state: initialState({online, demo, now: 0}), effects: []};
  m.send = (type, extra = {}) => {
    const result = step(m.state, {type, now: m.now, date: m.date, at: AT, ...extra});
    m.state = result.state; m.effects.push(...result.effects);
    return result.effects;
  };
  m.wait = ms => { m.now += ms; return m.send('tick'); };
  m.of = type => m.effects.filter(effect => effect.type === type);
  m.clear = () => { m.effects = []; };
  return m;
}
const person = [...Array(33)].map(() => ({x: 0.5, y: 0.5, visibility: 0.9}));
function playStage(m, source = 'demo') {
  const stage = m.state.session.island.stage, action = STAGES[stage].action;
  for (let i = 0; i < 10; i++) {
    m.now += 700;
    if (source === 'demo') m.send('key', {key: ' '});
    else { m.send('pose', {present: true}); m.send('rep', {action, source: 'camera'}); }
  }
  assert.ok(m.state.session.transition, `stage ${stage} should be complete`);
  m.send('spoken', {stage});
  m.wait(TIMING.transition);
}
function guestDemoToPlay(m) {
  m.send('demo.toggle');
  m.send('key', {key: 'a'});
  assert.equal(m.state.phase, 'login');
  m.send('login.done', {guest: true});
  assert.equal(m.state.phase, 'ready');
  m.send('key', {key: 'Enter'});
  assert.equal(m.state.phase, 'play');
}
function userToPlay(m, island = null) {
  m.send('camera', {live: true});
  m.send('wave');
  m.send('login.done', {user: {id: 7, name: '小林'}});
  assert.equal(m.state.phase, 'loading');
  m.send('save.loaded', {island});
  assert.equal(m.state.phase, 'ready');
  m.send('wave');
}

test('person detection needs a confident shoulder and hip', () => {
  assert.equal(personInView(person), true);
  assert.equal(personInView([]), false);
  const hidden = person.map((p, i) => [23, 24].includes(i) ? {...p, visibility: 0.1} : p);
  assert.equal(personInView(hidden), false);
});

test('a keyboard demo guest round walks attract → login → ready → four stages → settlement → leaderboard → attract', () => {
  const m = machine();
  guestDemoToPlay(m);
  const stages = [];
  for (let i = 0; i < 4; i++) { stages.push(m.of('stage').at(-1).stage); playStage(m); }
  assert.deepEqual(stages, [0, 1, 2, 3]);
  assert.equal(m.of('stage')[0].greeting, true);
  assert.equal(m.of('rep').length, 40);
  assert.deepEqual(m.of('rep').slice(0, 3).map(rep => rep.count), [1, 2, 3]);
  assert.equal(m.of('stageDone').length, 4);
  assert.equal(m.of('stageDone')[3].shelter, 1);
  assert.equal(m.state.phase, 'settlement');
  const [settle] = m.of('settle');
  assert.equal(settle.submit, null);
  assert.equal(settle.demo, true);
  assert.deepEqual(settle.summary.items.map(item => item.count), [10, 10, 10, 10]);
  const [result] = m.of('result');
  assert.equal(result.reason, 'demo');
  assert.equal(result.rank, null);
  m.send('key', {key: 'x'});
  assert.equal(m.state.phase, 'settlement', 'a stray key right after the result is ignored');
  m.now += TIMING.settleMin;
  m.send('key', {key: 'x'});
  assert.equal(m.state.phase, 'leaderboard');
  m.wait(TIMING.board - 1000);
  assert.equal(m.state.phase, 'leaderboard');
  m.wait(1000);
  assert.equal(m.state.phase, 'attract');
  assert.equal(m.state.session, null);
  assert.equal(m.of('exit').at(-1).reason, 'done');
  assert.deepEqual(m.of('phase').map(effect => effect.phase), ['login', 'ready', 'play', 'settlement', 'leaderboard', 'attract']);
});

test('keyboard demo never submits, even for a logged-in camera account', () => {
  const m = machine();
  userToPlay(m);
  // Two real camera reps, then the teacher switches to the keyboard demo.
  m.send('pose', {present: true});
  m.send('rep', {action: 'jump', source: 'camera'});
  m.now += 700;
  m.send('rep', {action: 'jump', source: 'camera'});
  const savesBefore = m.of('save').length;
  m.send('demo.toggle');
  assert.equal(m.state.session.round.demo, true);
  m.send('rep', {action: 'jump', source: 'camera'});
  assert.equal(m.state.session.island.counts[0], 2, 'camera reps are ignored in demo mode');
  for (let i = 0; i < 8; i++) { m.now += 700; m.send('key', {key: ' '}); }
  m.send('spoken', {stage: 0}); m.wait(TIMING.transition);
  for (let i = 1; i < 4; i++) playStage(m);
  assert.equal(m.state.phase, 'settlement');
  assert.equal(m.of('settle')[0].submit, null);
  assert.equal(m.of('result')[0].reason, 'demo');
  assert.equal(m.of('save').length, savesBefore, 'a demo round is not saved to the account');
  m.send('demo.toggle');
  assert.equal(m.state.session.result.reason, 'demo', 'switching demo off afterwards does not make the round count');
});

test('keyboard reps are ignored outside demo mode', () => {
  const m = machine();
  userToPlay(m);
  m.send('key', {key: ' '});
  assert.equal(m.state.session.island.counts[0], 0);
  m.send('rep', {action: 'jack', source: 'camera'});
  assert.equal(m.state.session.island.counts[0], 0, 'a move for another stage does not count');
});

test('a full camera round for an account saves and submits once with the round counts', () => {
  const m = machine();
  userToPlay(m);
  assert.deepEqual(m.of('loadSave').map(effect => effect.user.id), [7]);
  assert.equal(m.of('ready')[0].welcome, 'new');
  assert.equal(m.of('save').length, 1, 'the daily login is saved, as app.js does');
  for (let i = 0; i < 4; i++) playStage(m, 'camera');
  assert.equal(m.state.phase, 'settlement');
  assert.equal(m.of('save').length, 5, 'saved after each stage');
  const [settle] = m.of('settle');
  assert.deepEqual(settle.submit.counts, [10, 10, 10, 10]);
  assert.equal(settle.submit.mode, 'camera');
  assert.equal(settle.submit.finishedAt, AT);
  assert.ok(settle.submit.durationSec >= 28 && settle.submit.durationSec < 60, String(settle.submit.durationSec));
  assert.equal(m.of('result').length, 0, 'the result waits for the server rank');
  m.now += 300;
  m.send('submit.done', {rank: {weekRank: 3, weekPercentile: 80, weekTotal: 12}});
  assert.deepEqual(m.of('result')[0].rank, {weekRank: 3, weekPercentile: 80, weekTotal: 12});
  assert.equal(m.of('result')[0].reason, null);
  m.send('submit.done', {rank: {weekRank: 1}});
  assert.equal(m.of('result').length, 1, 'a late duplicate is ignored');
  m.wait(TIMING.settlementMax + 1);
  assert.equal(m.state.phase, 'leaderboard', 'settlement moves on by itself');
  assert.equal(m.of('board')[0].user.id, 7);
  m.now += TIMING.settleMin;
  m.send('key', {key: 'q'});
  assert.equal(m.state.phase, 'attract');
  assert.equal(m.of('settle').length, 1);
});

test('a slow or failed submission still shows the result without a rank', () => {
  const m = machine();
  userToPlay(m);
  for (let i = 0; i < 4; i++) playStage(m, 'camera');
  m.wait(TIMING.submitMax + 1);
  assert.equal(m.of('result')[0].reason, 'offline');
  const q = machine();
  userToPlay(q);
  for (let i = 0; i < 4; i++) playStage(q, 'camera');
  q.send('submit.failed', {queued: true});
  assert.equal(q.of('result')[0].reason, 'queued');
});

test('guests neither load nor save, and are not ranked', () => {
  const m = machine();
  m.send('camera', {live: true});
  m.send('wave');
  m.send('login.done', {guest: true});
  assert.equal(m.of('ready')[0].welcome, 'guest');
  m.send('wave');
  for (let i = 0; i < 4; i++) playStage(m, 'camera');
  assert.equal(m.of('loadSave').length, 0);
  assert.equal(m.of('save').length, 0);
  assert.equal(m.of('settle')[0].submit, null);
  assert.equal(m.of('result')[0].reason, 'guest');
  assert.equal(canSave(m.state.session), false);
});

test('without the server, guests see the offline reason and the leaderboard is skipped', () => {
  const m = machine({online: false});
  guestDemoToPlay(m);
  assert.equal(m.of('ready')[0].welcome, 'offline');
  m.send('demo.toggle');
  m.send('demo.toggle');
  for (let i = 0; i < 4; i++) playStage(m);
  assert.equal(m.of('result')[0].reason, 'demo');
  m.now += TIMING.settleMin;
  m.send('key', {key: 'Enter'});
  assert.equal(m.state.phase, 'attract');
  assert.equal(m.of('board').length, 0);
});

test('an unreachable save server falls back to an offline guest round', () => {
  const m = machine();
  m.send('wave');
  m.send('login.done', {user: {id: 7, name: '小林'}});
  m.send('save.failed');
  assert.equal(m.state.phase, 'ready');
  assert.equal(m.state.session.offline, true);
  assert.equal(m.state.online, false);
  assert.match(m.of('notice')[0].text, /成绩不计入排行/);
  m.send('wave');
  for (let i = 0; i < 4; i++) playStage(m, 'camera');
  assert.equal(m.of('save').length, 0);
  assert.equal(m.of('result')[0].reason, 'offline');
});

test('an unreadable server save is never overwritten', () => {
  const m = machine();
  userToPlay(m, {version: 99});
  assert.match(m.of('notice')[0].text, /存档无法读取/);
  for (let i = 0; i < 4; i++) playStage(m, 'camera');
  assert.equal(m.of('save').length, 0);
});

test('a server conflict notice is shown and the server save is used', () => {
  const m = machine();
  const island = {...fresh('2026-11-05'), shelter: 2, wood: 3};
  m.send('wave');
  m.send('login.done', {user: {id: 7, name: '小林'}});
  m.send('save.loaded', {island, conflict: true});
  assert.equal(m.of('ready')[0].welcome, 'back');
  assert.match(m.of('notice').at(-1).text, /以服务器为准/);
  assert.equal(m.state.session.island.shelter, 2);
});

test('leaving the camera pauses after 30 s, coming back resumes, and 2 min away ends without submitting', () => {
  const m = machine();
  userToPlay(m);
  m.send('pose', {present: true});
  m.send('rep', {action: 'jump', source: 'camera'});
  m.wait(TIMING.awayPause - 500);
  assert.equal(m.state.session.paused, null);
  m.wait(1000);
  assert.equal(m.state.session.paused.reason, 'away');
  assert.equal(m.of('pause').length, 1);
  m.send('rep', {action: 'jump', source: 'camera'});
  assert.equal(m.state.session.island.counts[0], 1, 'no counting while paused');
  m.wait(5000);
  m.send('pose', {present: true});
  assert.equal(m.state.session.paused, null);
  assert.equal(m.of('stage').at(-1).resume, true);
  assert.equal(m.of('stage').at(-1).done, 1);
  m.wait(TIMING.awayPause + 1000);
  assert.equal(m.state.session.paused.reason, 'away');
  m.wait(TIMING.awayEnd - 2000);
  assert.equal(m.state.phase, 'play');
  m.wait(2500);
  assert.equal(m.state.phase, 'attract');
  assert.equal(m.of('exit')[0].reason, 'away');
  assert.equal(m.of('settle').length, 0, 'an abandoned round is not submitted');
  assert.deepEqual(m.of('save').at(-1).island.counts, [1, 0, 0, 0], 'earned progress is kept');
});

test('the away timer is off in keyboard demo mode and while the menu is open', () => {
  const m = machine();
  m.send('camera', {live: true});
  guestDemoToPlay(m);
  m.wait(TIMING.awayPause + TIMING.awayEnd);
  assert.equal(m.state.phase, 'play');
  assert.equal(m.of('pause').length, 0);
  const n = machine();
  userToPlay(n);
  n.send('menu.open');
  n.wait(TIMING.awayEnd * 2);
  assert.equal(n.state.phase, 'play');
  n.send('rep', {action: 'jump', source: 'camera'});
  assert.equal(n.state.session.island.counts[0], 0, 'no counting behind the menu');
  n.send('menu.close');
  assert.equal(n.state.session.paused, null);
  assert.equal(n.of('stage').at(-1).resume, true);
});

test('a visitor is welcomed once, and again only after a minute', () => {
  const m = machine();
  m.send('pose', {present: true});
  assert.equal(m.of('welcome').length, 1);
  m.wait(TIMING.presenceLost + 500);
  assert.equal(m.state.presence.present, false);
  m.now += 10000;
  m.send('pose', {present: true});
  assert.equal(m.of('welcome').length, 1);
  m.wait(TIMING.presenceLost + 500);
  m.now += TIMING.welcomeRepeat;
  m.send('pose', {present: true});
  assert.equal(m.of('welcome').length, 2);
});

test('zero health enters the failed flow; only the menu restart brings a new island', () => {
  const m = machine();
  const island = {...fresh('2026-10-01'), hp: 5};
  userToPlay(m, island);
  assert.equal(m.state.phase, 'failed');
  assert.equal(m.of('failed').length, 1);
  assert.match(m.of('notice').at(-1).text, /生命 −5/);
  m.send('rep', {action: 'jump', source: 'camera'});
  m.send('key', {key: 'Enter'});
  assert.equal(m.state.phase, 'failed');
  m.send('restartIsland');
  assert.equal(m.state.phase, 'play');
  assert.equal(m.state.session.island.hp, 100);
  assert.equal(m.state.session.island.failed, false);
  assert.equal(m.of('save').at(-1).island.hp, 100);
  assert.equal(m.of('stage').at(-1).stage, 0);
});

test('restarting a stage undoes its reps and the stamina they earned', () => {
  const m = machine();
  userToPlay(m);
  for (let i = 0; i < 4; i++) { m.now += 700; m.send('pose', {present: true}); m.send('rep', {action: 'jump', source: 'camera'}); }
  assert.equal(m.state.session.island.stamina, 4);
  m.send('menu.open');
  m.send('restartStage');
  assert.equal(m.state.menu, false);
  assert.deepEqual(m.state.session.island.counts, [0, 0, 0, 0]);
  assert.equal(m.state.session.island.stamina, 0);
  assert.equal(m.state.session.island.moves, 0);
  assert.equal(m.of('stage').at(-1).done, 0);
});

test('a round resumed from an earlier session is shown but not submitted', () => {
  const m = machine();
  const island = {...fresh(DATE), stage: 2, counts: [10, 10, 0, 0], wood: 5, water: 2, stamina: 14, moves: 20};
  userToPlay(m, island);
  assert.equal(m.of('stage')[0].stage, 2);
  playStage(m, 'camera'); playStage(m, 'camera');
  assert.equal(m.of('settle')[0].submit, null);
  assert.equal(m.of('result')[0].reason, null);
});

test('a completed round from earlier today starts the next round', () => {
  const m = machine();
  const island = {...fresh(DATE), stage: 4, counts: [10, 10, 10, 10], shelter: 1, stamina: 26, rounds: 1, moves: 40};
  userToPlay(m, island);
  assert.equal(m.state.phase, 'play');
  assert.equal(m.of('stage')[0].stage, 0);
  assert.equal(m.state.session.round.fresh, true);
});

test('the stage transition waits for the count speech, but not forever', () => {
  const m = machine();
  guestDemoToPlay(m);
  for (let i = 0; i < 10; i++) { m.now += 700; m.send('key', {key: ' '}); }
  m.wait(TIMING.transition + 100);
  assert.equal(m.of('stage').length, 1);
  m.wait(TIMING.transitionMax);
  assert.equal(m.of('stage').at(-1).stage, 1);
});

test('idle login and ready screens return to attract', () => {
  const m = machine();
  m.send('key', {key: 'a'});
  m.wait(TIMING.idle + 1);
  assert.equal(m.state.phase, 'attract');
  assert.equal(m.of('exit')[0].reason, 'idle');
  assert.equal(settlementReason({user: {id: 1}, round: {demo: false}}), null);
});
