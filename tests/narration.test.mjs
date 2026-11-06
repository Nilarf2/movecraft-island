import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {STAGES, SHELTERS, fresh, record, required, roundSummary} from '../web/core.js';
import {HINTS} from '../web/detector.js';
import {VOICE_ASSETS} from '../web/voice.js';
import {
  allVoiceLines, VOICE_STYLES, RULES, LOGIN_CONFIRM, GREETING, FAILED_LINE, CAMERA_ERRORS, CAMERA_TIMEOUTS,
  chineseNumber, chineseQuantity, chineseCalories, rulesParts, stageParts, countParts, settlementParts,
  correctionParts, loginConfirmParts, loginStatusParts, failedParts, cameraError, spokenLine,
} from '../web/narration.js';

const lines = allVoiceLines();
const known = new Set(lines.map(line => line.text));
const DATE = '2026-11-02';
const daysBefore = days => new Date(Date.UTC(2026, 10, 2) - days * 86400000).toISOString().slice(0, 10);

function assertRecorded(parts, context) {
  assert.ok(parts.length > 0, `no speech for ${context}`);
  for (const part of parts) {
    assert.equal(part.key, part.text, `key must equal text (${context})`);
    assert.ok(known.has(part.text), `missing recording for ${context}: ${part.text}`);
  }
}

test('every line is unique, styled by its group, and free of doubled punctuation', () => {
  assert.equal(known.size, lines.length);
  for (const line of lines) {
    assert.ok(line.text.length > 0);
    assert.equal(line.style, VOICE_STYLES[line.group], line.text);
    assert.ok(line.style, `group ${line.group} needs a style`);
    assert.doesNotMatch(line.text, /[。！？，、]{2}/, line.text);
  }
  assert.ok(lines.length < 260, `script should stay small enough to record: ${lines.length}`);
});

test('numbers read naturally for counts, quantities and calories', () => {
  assert.deepEqual([1, 2, 10, 12, 20, 22, 25].map(chineseNumber), ['一', '二', '十', '十二', '二十', '二十二', '二十五']);
  assert.deepEqual([2, 12, 22].map(chineseQuantity), ['两', '十二', '二十二']);
  assert.deepEqual([3.5, 7, 35, 38.5, 87.5].map(chineseCalories), ['三点五', '七', '三十五', '三十八点五', '八十七点五']);
});

test('rules narration stays near 20 seconds and matches the difficulty rules', () => {
  assertRecorded(rulesParts(), 'rules');
  assert.ok(RULES.length <= 115, `rules are ${RULES.length} characters`);
  const s = fresh(DATE);
  assert.equal(required(s, DATE), 10);
  s.started = daysBefore(2); assert.equal(required(s, DATE), 11);
  s.started = daysBefore(400); assert.equal(required(s, DATE), 25);
  for (const phrase of ['十个开始', '每两天加一个', '最多二十五个']) assert.ok(RULES.includes(phrase), phrase);
});

test('every stage intro, resume and count the rules can produce has a recording', () => {
  for (let target = 10; target <= 25; target++) {
    for (let shelter = 0; shelter < SHELTERS.length; shelter++) {
      const s = fresh(DATE);
      s.started = daysBefore((target - 10) * 2);
      Object.assign(s, {stamina: 1000, wood: 1000, shelter});
      assert.equal(required(s, DATE), target);
      while (s.stage < 4) {
        const stage = s.stage, previousShelter = s.shelter;
        for (const greeting of [false, true]) {
          assertRecorded(stageParts({stage, target, done: s.counts[stage], greeting}), `stage ${stage} at ${s.counts[stage]}/${target}`);
        }
        const result = record(s, STAGES[stage].action, DATE);
        assert.equal(result.accepted, true);
        for (const slow of [false, true]) {
          const parts = countParts({stage, count: s.counts[stage], target: required(s, DATE), shelter: s.shelter,
            reinforced: stage === 3 && previousShelter === 6, slow});
          assertRecorded(parts, `count ${s.counts[stage]}/${target} stage ${stage} shelter ${previousShelter}`);
          if (result.completed) assert.equal(parts.length, 2, 'completion needs a reward line');
        }
      }
    }
  }
});

test('count lines stay short and mark the milestones', () => {
  const text = options => countParts({stage: 0, target: 10, ...options}).map(part => part.text).join('');
  assert.equal(text({count: 4}), '四！');
  assert.equal(text({count: 5}), '五！过半了，保持节奏！');
  assert.equal(text({count: 7}), '七！还剩三个，坚持住！');
  assert.equal(text({count: 9}), '九！最后一个！');
  assert.equal(text({count: 10}), '十！椰子摘够了，淡水加两份！');
  assert.match(text({count: 4, slow: true}), /^四！.+/);
  assert.match(countParts({stage: 3, count: 10, target: 10, shelter: 6, reinforced: true}).at(-1).text, /加固/);
  assert.match(countParts({stage: 3, count: 10, target: 10, shelter: 2}).at(-1).text, /茅草小屋/);
});

test('settlement for equal, uneven and empty rounds is fully recorded', () => {
  const grid = [0, 1, 4, 9, 10, 11, 17, 25];
  for (const demo of [false, true]) {
    for (let n = 0; n <= 25; n++) assertRecorded(settlementParts({demo, summary: roundSummary({counts: [n, n, n, n]})}), `settlement ${n}`);
    for (const a of grid) for (const b of grid) for (const c of grid) for (const d of grid) {
      assertRecorded(settlementParts({demo, summary: roundSummary({counts: [a, b, c, d]})}), `settlement ${[a, b, c, d]}`);
    }
  }
  const tens = settlementParts({summary: roundSummary({counts: [10, 10, 10, 10]})}).map(part => part.text).join('');
  for (const phrase of ['辛苦啦', '各做了十个', '一共消耗三十五卡', '百分之九十八', '游戏换算', '不是真实测量', '明天岛上见']) assert.ok(tens.includes(phrase), phrase);
  const demo = settlementParts({demo: true, summary: roundSummary({counts: [11, 11, 11, 11]})}).map(part => part.text).join('');
  assert.match(demo, /^键鼠试玩结算.*三十八点五卡/);
});

test('every detector hint and camera problem has a spoken line', () => {
  for (const [id, hint] of Object.entries(HINTS)) {
    assertRecorded(correctionParts(hint), `hint ${id}`);
    assertRecorded(loginStatusParts(hint), `login hint ${id}`);
    assert.notEqual(spokenLine(hint), undefined);
  }
  for (const [name, item] of Object.entries(CAMERA_ERRORS)) {
    const error = new DOMException('test', name);
    assert.deepEqual(cameraError(error), item);
    assertRecorded(loginStatusParts(item.screen), `camera ${name}`);
  }
  for (const [name, item] of Object.entries(CAMERA_TIMEOUTS)) {
    const message = cameraError(new Error(item.screen));
    assert.ok(message.screen.endsWith(item.screen));
    assertRecorded(loginStatusParts(message.screen), `timeout ${name}`);
  }
  assertRecorded(loginConfirmParts(), 'login confirm');
  assertRecorded(failedParts(), 'failed');
  for (const text of [LOGIN_CONFIRM, GREETING, FAILED_LINE]) assert.ok(known.has(text), text);
});

test('values outside the recorded range fall back to device speech instead of throwing', () => {
  const outside = [
    ...stageParts({stage: 0, target: 30}),
    ...countParts({stage: 0, count: 120, target: 130}),
    ...loginStatusParts(cameraError(new Error('unexpected')).screen),
  ];
  assert.ok(outside.some(part => !known.has(part.text)));
  assert.equal(cameraError(new Error('unexpected')).voice, '无法开启本机识别：unexpected');
});

test('generated voice assets only cover lines in the current script', () => {
  const stale = Object.keys(VOICE_ASSETS).filter(text => !known.has(text));
  assert.deepEqual(stale, [], 'regenerate voice assets after changing the script');
});

test('every mapped voice clip exists in web/', () => {
  const missing = Object.values(VOICE_ASSETS).filter(path => !existsSync(new URL(`../web/${path}`, import.meta.url)));
  assert.deepEqual(missing, []);
});
