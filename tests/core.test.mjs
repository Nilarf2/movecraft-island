import test from 'node:test';
import assert from 'node:assert/strict';
import {fresh, sanitize, ordinal, settle, login, record, nextRound, exchange, required, STAGES} from '../web/core.js';

const DAY = '2026-10-21';
function finishStage(s, date = DAY) {
  const action = STAGES[s.stage].action;
  let result;
  for (let i = 0; i < required(s, date); i++) result = record(s, action, date);
  return result;
}

test('calendar settlement handles leap days and DST dates as whole calendar days', () => {
  assert.ok(Number.isNaN(ordinal('2026-02-29')));
  assert.equal(ordinal('2024-03-01') - ordinal('2024-02-28'), 2);
  for (const [start, end] of [['2026-03-07', '2026-03-09'], ['2026-10-31', '2026-11-02']]) {
    const s = fresh(start); s.water = 10; s.food = 10;
    assert.deepEqual(settle(s, end), {days: 2, loss: 8, downgraded: 0});
    assert.equal(s.water, 8); assert.equal(s.food, 8);
  }
});

test('daily drain consumes supplies once, resets stages, and reports actual health loss', () => {
  const s = fresh(DAY); s.water = 1; s.food = 1; s.stage = 2; s.counts = [5, 5, 3, 0];
  assert.deepEqual(settle(s, '2026-10-22'), {days: 1, loss: 4, downgraded: 0});
  assert.equal(s.hp, 96); assert.equal(s.water, 0); assert.equal(s.food, 0);
  assert.equal(s.stage, 0); assert.deepEqual(s.counts, [0, 0, 0, 0]);
  assert.deepEqual(settle(s, '2026-10-22'), {days: 0, loss: 0, downgraded: 0});
  assert.equal(settle(s, '2026-10-23').loss, 22);
  s.hp = 3;
  assert.equal(settle(s, '2026-10-24').loss, 3);
  assert.equal(s.hp, 0); assert.equal(s.failed, true);
  assert.equal(record(s, 'jump', '2026-10-24').accepted, false);
});

test('absence downgrades shelter every two days and login gifts only once per date', () => {
  const s = fresh(DAY); s.shelter = 6; s.water = 20; s.food = 20;
  const result = login(s, '2026-10-25');
  assert.equal(result.days, 4); assert.equal(result.downgraded, 2);
  assert.equal(s.shelter, 4); assert.equal(s.stamina, 3); assert.equal(s.gifts, 3);
  login(s, '2026-10-25'); assert.equal(s.gifts, 3);
  login(s, '2026-10-26'); assert.equal(s.shelter, 4); assert.equal(s.gifts, 6);
});

test('future clock rollback does not mutate progress or consume supplies', () => {
  const s = fresh(DAY); const before = structuredClone(s);
  assert.ok(login(s, '2026-10-20').error);
  assert.deepEqual(s, before);
  assert.equal(record(s, 'jump', '2026-10-20').accepted, false);
  assert.deepEqual(s, before);
});

test('four stages reward once in order and a second round remains playable', () => {
  const s = fresh(DAY); s.hp = 80;
  assert.equal(record(s, 'squat', DAY).accepted, false);
  assert.equal(s.moves, 0);
  for (let stage = 0; stage < 4; stage++) {
    const result = finishStage(s);
    assert.equal(result.completed, true); assert.equal(s.stage, stage + 1);
    assert.equal(record(s, STAGES[stage].action, DAY).accepted, false);
  }
  assert.deepEqual([s.water, s.food, s.wood, s.shelter, s.rounds, s.moves, s.stamina, s.hp], [2, 2, 0, 1, 1, 20, 6, 86]);
  assert.equal(nextRound(s), true); assert.deepEqual(s.counts, [0, 0, 0, 0]);
  assert.equal(nextRound(s), false);
  for (let stage = 0; stage < 4; stage++) finishStage(s);
  assert.equal(s.rounds, 2); assert.equal(s.shelter, 2); assert.equal(s.water, 4);
});

test('difficulty increases every two days and caps at fifteen', () => {
  const s = fresh(DAY);
  assert.equal(required(s, DAY), 5); assert.equal(required(s, '2026-10-22'), 5);
  assert.equal(required(s, '2026-10-23'), 6); assert.equal(required(s, '2030-01-01'), 15);
});

test('maximum shelter rewards reinforcement without overflowing level or health', () => {
  const s = fresh(DAY); s.shelter = 6; s.hp = 99;
  for (let stage = 0; stage < 4; stage++) finishStage(s);
  assert.equal(s.shelter, 6); assert.equal(s.hp, 100);
  assert.equal(s.water, 3); assert.equal(s.food, 3);
});

test('supply exchange checks cost, resource name and failure state', () => {
  const s = fresh(DAY);
  assert.equal(exchange(s, 'water'), false);
  s.stamina = 5;
  assert.equal(exchange(s, 'wood'), false); assert.equal(s.stamina, 5);
  assert.equal(exchange(s, 'water'), true); assert.equal(s.water, 1); assert.equal(s.stamina, 0);
  s.stamina = 5; s.failed = true;
  assert.equal(exchange(s, 'food'), false);
});

test('save import rejects invalid dates and normalizes hostile or inconsistent values', () => {
  assert.throws(() => sanitize({...fresh(DAY), version: 999}, DAY));
  assert.throws(() => sanitize({...fresh(DAY), settled: '2026-02-30'}, DAY));
  assert.throws(() => sanitize({...fresh(DAY), settled: '2026-10-22'}, DAY));
  const s = sanitize({...fresh(DAY), stage: 2, counts: [0, 2, 999, -4], hp: -10, shelter: 999, stamina: Infinity,
    history: [null, 'a'.repeat(200), ...Array(40).fill('event')]}, DAY);
  assert.equal(s.failed, true); assert.equal(s.hp, 0); assert.equal(s.shelter, 6); assert.equal(s.stamina, 0);
  assert.deepEqual(s.counts, [5, 5, 4, 0]); assert.equal(s.history.length, 30);
  assert.ok(s.history.every(x => x.length <= 160));
});
