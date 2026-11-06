import test from 'node:test';
import assert from 'node:assert/strict';
import {roundSummary} from '../web/core.js';
import {rankBand} from '../web/narration.js';
import {
  checkUsername, checkPassword, validateForm, normalizeUsername, errorCode, errorText, waitMinutes, withTimeout, userFrom,
  PRIVACY, cleanRecent, addRecent, removeRecent, loadRecent, saveRecent, RECENT_KEY, RECENT_MAX,
  boardModel, medalOf, emptyText, sameName, rankText, reasonText, settlementRows, settlementTotal, bigScreenSettlementSummary, formatCalories, rollValue,
} from '../web/stage/ui/logic.js';

test('usernames: 2–16 Chinese characters, letters, digits or underscores', () => {
  for (const ok of ['阿林', 'ab', 'Leo_2009', '跳跳虎_3', 'a'.repeat(16), '𠀀a']) assert.equal(checkUsername(ok), '', ok);
  assert.match(checkUsername(''), /请输入/);
  assert.match(checkUsername('小'), /2 到 16/);
  assert.match(checkUsername('a'.repeat(17)), /2 到 16/);
  for (const bad of ['小 星', 'a-b', 'hi!', '😀😀', 'ab​']) assert.match(checkUsername(bad), /只能用/, bad);
  // A Chinese IME can type full-width letters; they count as ASCII.
  assert.equal(normalizeUsername(' ＡＢＣ１２ '), 'ABC12');
  assert.equal(checkUsername('ＡＢ'), '');
});

test('passwords need 6 characters; forms report the first problem field', () => {
  assert.match(checkPassword(''), /请输入密码/);
  assert.match(checkPassword('12345'), /至少 6 位/);
  assert.equal(checkPassword('123456'), '');
  assert.equal(validateForm('login', {username: '阿林', password: '123456'}), null);
  assert.deepEqual(validateForm('login', {username: '阿', password: '123456'}).field, 'username');
  assert.equal(validateForm('register', {username: '阿林', password: '123456', confirm: ''}).field, 'confirm');
  assert.match(validateForm('register', {username: '阿林', password: '123456', confirm: '123457'}).message, /不一样/);
  assert.equal(validateForm('register', {username: '阿林', password: '123456', confirm: '123456'}), null);
  assert.equal(validateForm('password', {current: '', password: '123456', confirm: '123456'}).field, 'current');
  assert.match(validateForm('password', {current: 'x', password: '123', confirm: '123'}).message, /新密码至少/);
  assert.equal(validateForm('delete', {password: ''}).field, 'password');
  assert.equal(validateForm('delete', {password: 'x'}), null);
});

test('ApiError codes map to the Chinese messages in the brief', () => {
  assert.equal(errorText({code: 'credentials'}), '用户名或密码不对');
  assert.equal(errorText({code: 'rate'}), '操作太频繁，请稍后再试');
  assert.match(errorText({code: 'network'}), /连不上服务器.*游客/);
  assert.match(errorText({code: 'taken'}), /已被占用/);
  assert.match(errorText({code: 'invalid'}), /不符合要求/);
  assert.equal(errorText({code: 'locked', retryAfter: 600}), '账号已锁定，请 10 分钟后再试');
  assert.equal(errorText({code: 'locked', details: {retryAfter: 61}}), '账号已锁定，请 2 分钟后再试');
  const now = Date.parse('2026-11-06T06:00:00Z');
  assert.equal(errorText({code: 'locked', lockedUntil: '2026-11-06T06:14:10Z'}, {now}), '账号已锁定，请 15 分钟后再试');
  assert.equal(errorText({code: 'locked'}), '账号已锁定，请稍后再试');
  assert.equal(errorText({code: 'whatever'}), '出了点问题，请稍后再试');
  assert.equal(errorText({code: 'credentials'}, {context: 'menu'}), '密码不对');
  assert.doesNotMatch(errorText({code: 'network'}, {context: 'menu'}), /游客/);
  assert.equal(waitMinutes({}), null);
});
test('fetch failures and timeouts count as network errors', async () => {
  assert.equal(errorCode(new TypeError('Failed to fetch')), 'network');
  assert.equal(errorCode(Object.assign(new Error('x'), {name: 'AbortError'})), 'network');
  assert.equal(errorCode({code: 'taken'}), 'taken');
  assert.equal(errorCode(new Error('boom')), 'unknown');
  await assert.rejects(withTimeout(new Promise(() => {}), 20), error => errorCode(error) === 'network');
  assert.equal(await withTimeout(Promise.resolve(7), 20), 7);
  assert.deepEqual(userFrom({token: 't', user: {id: 1, username: '阿林'}}, 'x'), {id: 1, username: '阿林'});
  assert.deepEqual(userFrom(undefined, '阿林'), {username: '阿林'});
});

test('privacy notice says what is stored, what is not, and that accounts can be deleted', () => {
  const text = PRIVACY.sections.flat().join('');
  for (const word of ['用户名', '加密后的密码', '小岛存档', '动作次数', '真实姓名', '照片', '不会上传', '删除']) assert.ok(text.includes(word), word);
});

test('recent usernames: newest first, at most five, no duplicates, never a password', () => {
  let list = [];
  for (const name of ['a1', 'b2', 'c3', 'd4', 'e5', 'f6']) list = addRecent(list, name);
  assert.deepEqual(list, ['f6', 'e5', 'd4', 'c3', 'b2']);
  assert.equal(list.length, RECENT_MAX);
  assert.deepEqual(addRecent(list, 'c3').slice(0, 2), ['c3', 'f6']);
  assert.deepEqual(removeRecent(list, 'e5'), ['f6', 'd4', 'c3', 'b2']);
  assert.deepEqual(cleanRecent(['ok_1', '', 'x', 42, {username: 'a'}, 'ok_1', 'bad name']), ['ok_1']);
  const memory = new Map();
  const storage = {getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value)};
  assert.equal(saveRecent(storage, ['阿林', 'Coco']), true);
  assert.deepEqual(JSON.parse(memory.get(RECENT_KEY)), ['阿林', 'Coco']);
  assert.deepEqual(loadRecent(storage), ['阿林', 'Coco']);
  memory.set(RECENT_KEY, '{broken');
  assert.deepEqual(loadRecent(storage), []);
  const throwing = {getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); }};
  assert.deepEqual(loadRecent(throwing), []);
  assert.equal(saveRecent(throwing, ['阿林']), false);
});

test('leaderboard keeps server ranks and ties, gives medals, and shows "me" only outside the list', () => {
  const entries = [{rank: 1, username: '椰子大王', total: 96}, {rank: 2, username: '阿林', total: 88},
    {rank: 2, username: 'Coco', total: 88}, {rank: 4, username: 'Mint', total: 80}];
  const model = boardModel({entries, me: {rank: 3, total: 88}}, {limit: 10, highlight: 'coco'});
  assert.deepEqual(model.rows.map(r => r.rank), [1, 2, 2, 4]);
  assert.deepEqual(model.rows.map(r => r.medal), ['gold', 'silver', 'silver', null]);
  assert.deepEqual(model.rows.map(r => r.isMe), [false, false, true, false]);
  assert.equal(model.me, null);
  const far = boardModel({entries, me: {rank: 23, total: 12}}, {limit: 3, highlight: '小星星'});
  assert.equal(far.rows.length, 3);
  assert.deepEqual([far.me.rank, far.me.moves, far.me.isMe], [23, 12, true]);
  assert.equal(boardModel({entries, me: {rank: null, total: 0}}, {highlight: '小星星'}).me, null);
  assert.equal(boardModel({entries: [], me: null}).rows.length, 0);
  assert.equal(boardModel(null).rows.length, 0);
  assert.equal(boardModel({entries: [{username: '', total: 3}, null, {username: 'x_1', total: '7'}]}).rows[0].moves, 7);
  assert.equal(medalOf(3), 'bronze');
  assert.equal(medalOf(11), null);
  assert.equal(emptyText('week'), '本周还没有人上榜，来做第一个！');
  assert.ok(sameName('Leo', 'leo') && !sameName('Leo', null));
});
test('rank card wording follows weekRank and weekPercentile', () => {
  assert.deepEqual(rankText({weekRank: 3, weekPercentile: 80, weekTotal: 46}),
    {rank: 3, headline: '本周第 3 名', detail: '超过 80% 的同学', percentile: 80, total: 46});
  assert.equal(rankText({weekRank: 1, weekPercentile: null}).detail, '本周第一个上榜的同学');
  assert.equal(rankText({weekRank: 1, weekPercentile: 100}).detail, '超过本周所有其他同学');
  assert.equal(rankText({weekRank: 9, weekPercentile: 0}).detail, '已经上榜，下次冲得更高！');
  assert.equal(rankText({weekRank: 5, weekPercentile: 66.9}).detail, '超过 66% 的同学');
  assert.equal(rankText({weekRank: 2, weekPercentile: 50}).total, null);
  for (const none of [null, undefined, {}, {weekRank: 0}, {weekRank: 2.5}]) assert.equal(rankText(none), null);
  // The screen and the voice agree on who is alone on the board this week.
  assert.equal(rankBand({rank: 1, percentile: null}), 'solo');
  assert.equal(rankText({weekRank: 1, weekPercentile: null}).percentile, null);
});

test('reason texts for unranked rounds', () => {
  assert.equal(reasonText('guest').detail, '游客成绩不计入排行。');
  assert.equal(reasonText('offline').detail, '离线，成绩没有上传。');
  assert.match(reasonText('demo').detail, /键鼠试玩.*不计入/);
  assert.equal(reasonText('queued').detail, '网络恢复后自动上传。');
  assert.equal(reasonText(null), null);
  assert.equal(reasonText('other'), null);
});

test('settlement rows and total come from core.roundSummary', () => {
  const summary = roundSummary({counts: [12, 10, 16, 8]});
  const rows = settlementRows(summary);
  assert.deepEqual(rows.map(r => r.move), ['竖直跳', '开合跳', '手臂平举', '深蹲']);
  assert.deepEqual(rows.map(r => r.stage), ['摘椰子', '砍树', '耕种', '建房']);
  assert.deepEqual(rows.map(r => r.count), [12, 10, 16, 8]);
  assert.deepEqual(settlementTotal(summary), {count: 46, calories: 38});
  assert.equal(settlementTotal(roundSummary({counts: [0, 0, 1, 0]})).calories, 0.5);
  assert.deepEqual(settlementRows(null), []);
  assert.deepEqual(settlementTotal(null), {count: 0, calories: 0});
  assert.match(summary.calorieNote, /估算/);
  assert.equal(formatCalories(0.5), '0.5');
  assert.equal(formatCalories(38), '38');
  assert.equal(formatCalories(7.25), '7.25');
});

test('big-screen settlement uses its own calorie coefficients and high encouragement rank', () => {
  const summary = bigScreenSettlementSummary(roundSummary({counts: [10, 10, 10, 10]}));
  assert.deepEqual(summary.items.map(item => item.calories), [3.5, 3.5, 1, 2.5]);
  assert.equal(summary.totalCalories, 10.5);
  assert.equal(summary.percentile, 98);
  assert.match(summary.encouragement, /太棒了/);
});

test('rolling numbers ease up to the exact value', () => {
  assert.equal(rollValue(38, 0), 0);
  assert.equal(rollValue(38, 1), 38);
  assert.equal(rollValue(7.5, 1), 7.5);
  let last = -1;
  for (let t = 0; t <= 1; t += 0.05) {
    const v = rollValue(46, t);
    assert.ok(v >= last && v <= 46);
    last = v;
  }
  assert.equal(rollValue(10, -2), 0);
  assert.equal(rollValue(10, 5), 10);
});

test('components load in node without touching the DOM', async () => {
  const [account, board, settlement] = await Promise.all([import('../web/stage/ui/account.js'),
    import('../web/stage/ui/board.js'), import('../web/stage/ui/settlement.js')]);
  assert.equal(typeof account.mountLogin, 'function');
  assert.equal(typeof account.mountAccountMenu, 'function');
  assert.equal(typeof board.mountBoard, 'function');
  assert.equal(typeof settlement.mountSettlement, 'function');
});
