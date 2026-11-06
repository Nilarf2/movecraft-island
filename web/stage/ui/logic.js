// Pure rules and wording for the big-screen account, leaderboard and settlement UI.
// No DOM access here, so tests/stage-ui.test.mjs runs these functions in node.
import {STAGES} from '../../core.js';

export const USERNAME_MIN = 2, USERNAME_MAX = 16, PASSWORD_MIN = 6;
export const RECENT_KEY = 'movecraft.stage.recentUsers', RECENT_MAX = 5;
export const WELCOME_MS = 1000, REQUEST_TIMEOUT_MS = 15000;

const NAME_CHARS = /^[\p{Script=Han}A-Za-z0-9_]+$/u;
const chars = text => [...text].length; // code points, so a rare Han character counts once

// A Chinese IME can type full-width letters and digits; NFKC turns them into ASCII.
export function normalizeUsername(value) {
  return String(value ?? '').normalize('NFKC').trim();
}
export function checkUsername(value) {
  const name = normalizeUsername(value);
  if (!name) return '请输入用户名';
  if (!NAME_CHARS.test(name)) return '用户名只能用中文、字母、数字和下划线';
  if (chars(name) < USERNAME_MIN || chars(name) > USERNAME_MAX) return `用户名要 ${USERNAME_MIN} 到 ${USERNAME_MAX} 个字符`;
  return '';
}
export function checkPassword(value, label = '密码') {
  const text = String(value ?? '');
  if (!text) return `请输入${label}`;
  if (chars(text) < PASSWORD_MIN) return `${label}至少 ${PASSWORD_MIN} 位`;
  return '';
}
const repeat = (confirm, password, label) => !confirm ? `请再输一次${label}` : confirm !== password ? `两次输入的${label}不一样` : '';
// The first problem as {field, message}, or null. Modes: login, register, password (change), delete.
export function validateForm(mode, {username, password, confirm, current} = {}) {
  const rules = [];
  if (mode === 'login' || mode === 'register') rules.push(['username', checkUsername(username)], ['password', checkPassword(password)]);
  if (mode === 'register') rules.push(['confirm', repeat(confirm, password, '密码')]);
  if (mode === 'password') rules.push(['current', current ? '' : '请输入现在的密码'],
    ['password', checkPassword(password, '新密码')], ['confirm', repeat(confirm, password, '新密码')]);
  if (mode === 'delete') rules.push(['password', password ? '' : '请输入密码']);
  const found = rules.find(([, message]) => message);
  return found ? {field: found[0], message: found[1]} : null;
}

// ApiError carries a string code; fetch failures and timeouts count as network errors.
export function errorCode(error) {
  if (typeof error === 'string') return error;
  if (typeof error?.code === 'string' && error.code) return error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'network';
  if (error?.name === 'TypeError' && /fetch|network|load failed/i.test(error.message || '')) return 'network';
  return 'unknown';
}
// Minutes left on a lock, rounded up; null when the server did not say.
export function waitMinutes(error, now = Date.now()) {
  const seconds = Number(error?.retryAfter ?? error?.details?.retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds / 60);
  const until = Date.parse(error?.lockedUntil ?? error?.details?.lockedUntil ?? '');
  return Number.isFinite(until) && until > now ? Math.ceil((until - now) / 60000) : null;
}
export const ERROR_TEXT = {
  credentials: '用户名或密码不对',
  locked: '账号已锁定，请稍后再试',
  rate: '操作太频繁，请稍后再试',
  network: '连不上服务器，可以先用游客模式',
  taken: '用户名已被占用，换一个吧',
  invalid: '输入不符合要求，请检查后再试',
  auth: '登录已过期，请重新登录',
  server: '服务器出了点问题，请稍后再试',
  unsupported: '这个功能暂时用不了',
  unknown: '出了点问题，请稍后再试',
};
// For invalid input the server's own Chinese message is more precise (for example a password over 128 characters).
function serverText(error) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  return text && text.length <= 40 && /\p{Script=Han}/u.test(text) && text !== '输入不符合要求' ? text : '';
}
// context 'menu' is the account menu: only a password was typed there, and guest mode does not apply.
export function errorText(error, {context = 'login', now} = {}) {
  const code = errorCode(error);
  if (code === 'locked') {
    const minutes = waitMinutes(error, now);
    return minutes ? `账号已锁定，请 ${minutes} 分钟后再试` : ERROR_TEXT.locked;
  }
  if (code === 'invalid' && serverText(error)) return serverText(error);
  if (context === 'menu' && code === 'credentials') return '密码不对';
  if (context === 'menu' && code === 'network') return '连不上服务器，请稍后再试';
  return ERROR_TEXT[code] || ERROR_TEXT.unknown;
}
export function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), {name: 'TimeoutError', code: 'network'})), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// api.login/register may resolve to {user}, to the user itself, or to nothing useful.
export function userFrom(result, username) {
  const user = result?.user && typeof result.user === 'object' ? result.user
    : result && typeof result === 'object' && result.username ? result : {};
  return {...user, username: String(user.username || username)};
}

export const PRIVACY = {
  title: '隐私说明',
  sections: [
    ['存了什么', '用户名、加密后的密码、小岛存档、动作次数。'],
    ['没存什么', '真实姓名、照片。摄像头画面只在本机分析，不会上传。'],
    ['可以删除', '登录后按 Esc，在「账号管理」里删除账号。'],
  ],
};

// Recent usernames on this device: at most five, newest first, never a password.
export function cleanRecent(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const name = typeof item === 'string' ? normalizeUsername(item) : '';
    if (name && !checkUsername(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, RECENT_MAX);
}
export const addRecent = (list, username) => cleanRecent([normalizeUsername(username), ...cleanRecent(list)]);
export const removeRecent = (list, username) => cleanRecent(list).filter(name => name !== normalizeUsername(username));
// Private windows and full quotas throw; the list is a convenience, so errors are ignored.
export function loadRecent(storage) {
  try { return cleanRecent(JSON.parse(storage?.getItem(RECENT_KEY) || '[]')); } catch { return []; }
}
export function saveRecent(storage, list) {
  try { storage?.setItem(RECENT_KEY, JSON.stringify(cleanRecent(list))); return true; } catch { return false; }
}

// Leaderboard: the server decides ranks, ties included; rows keep its order.
export const PERIODS = [{id: 'week', label: '本周'}, {id: 'all', label: '总榜'}];
export const emptyText = period => period === 'week' ? '本周还没有人上榜，来做第一个！' : '还没有人上榜，来做第一个！';
export const medalOf = rank => rank >= 1 && rank <= 3 ? ['gold', 'silver', 'bronze'][rank - 1] : null;
export function highlightName(highlight) {
  const name = typeof highlight === 'string' ? highlight : highlight?.username ?? highlight?.name;
  return name ? normalizeUsername(name) : null;
}
// The server treats usernames as case-insensitive, so "Lin" and "lin" are the same player.
export const sameName = (a, b) => !!a && !!b && normalizeUsername(a).toLowerCase() === normalizeUsername(b).toLowerCase();
// Entries are {rank, username, total, rounds}; "me" may come without a username.
function boardRow(entry, index, who, mine = false) {
  if (!entry || typeof entry !== 'object') return null;
  const username = String(entry.username ?? entry.name ?? (mine ? who ?? '' : '')).trim();
  if (!username && !mine) return null;
  const given = Number(entry.rank);
  const rank = Number.isInteger(given) && given > 0 ? given : index >= 0 ? index + 1 : null;
  const moves = Math.max(0, Math.floor(Number(entry.total ?? entry.moves ?? entry.score ?? entry.count) || 0));
  const isMe = mine || entry.me === true || entry.isMe === true || sameName(username, who);
  return {rank, username: username || '你', moves, isMe, medal: medalOf(rank)};
}
// data is {entries, me} (or a bare array). me is shown below the list only when it is not in the top rows.
export function boardModel(data, {limit = 10, highlight = null} = {}) {
  const max = Math.max(1, Math.floor(Number(limit) || 10));
  const list = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
  const mine = data?.me && typeof data.me === 'object' ? data.me : null;
  // Without a highlight, the server's own "me" still tells which row is the current player.
  const who = highlightName(highlight) ?? highlightName(mine);
  const all = list.map((entry, i) => boardRow(entry, i, who)).filter(Boolean);
  const rows = all.slice(0, max);
  const me = mine ? boardRow(mine, -1, who, true) : all.slice(max).find(row => row.isMe) || null;
  return {rows, me: me?.rank && !rows.some(row => row.isMe) ? me : null};
}
export const formatCount = n => Math.round(Number(n) || 0).toLocaleString('zh-CN');

// Settlement rank card. rank is {weekRank, weekPercentile, weekTotal}; percentile is 0–100,
// null when this player is the only one this week (the same meaning narration.js rankBand uses).
export function rankText(rank) {
  const n = Number(rank?.weekRank);
  if (!rank || !Number.isInteger(n) || n < 1) return null;
  const raw = rank.weekPercentile;
  const p = raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)) ? null
    : Math.max(0, Math.min(100, Math.floor(Number(raw))));
  let detail;
  if (p === null) detail = n === 1 ? '本周第一个上榜的同学' : '';
  else if (p >= 100) detail = '超过本周所有其他同学';
  else if (p <= 0) detail = '已经上榜，下次冲得更高！';
  else detail = `超过 ${p}% 的同学`;
  // weekTotal is this player's moves counted this week (the leaderboard "total").
  const total = rank.weekTotal === null || rank.weekTotal === undefined ? NaN : Number(rank.weekTotal);
  return {rank: n, headline: `本周第 ${n} 名`, detail, percentile: p,
    total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : null};
}
export const REASON_TEXT = {
  guest: {title: '游客模式', detail: '游客成绩不计入排行。'},
  offline: {title: '离线', detail: '离线，成绩没有上传。'},
  demo: {title: '键鼠试玩', detail: '键鼠试玩，不计入排行。'},
  queued: {title: '等待上传', detail: '网络恢复后自动上传。'},
};
export const reasonText = reason => REASON_TEXT[reason] || null;

// Rows from core.js roundSummary(): {items: [{action, move, count, calories}], totalCalories, calorieNote}.
export function bigScreenSettlementSummary(summary) {
  const perMove = [0.35, 0.35, 0.1, 0.25];
  const items = (summary?.items || []).map((item, i) => ({...item,
    calories: Math.round(Math.max(0, Number(item.count) || 0) * perMove[i] * 100) / 100}));
  const totalCalories = Math.round(items.reduce((total, item) => total + item.calories, 0) * 100) / 100;
  return {...summary, items, totalCalories,
    percentile: Math.min(99, 98 + Math.floor(totalCalories / 20)),
    percentileNote: '排名为鼓励性游戏设定，不代表真实全国排名。',
    calorieNote: '热量与排名均为鼓励性游戏设定，不代表实际热量或真实全国排名。',
    encouragement: '太棒了！你完成了整轮运动，行动力和坚持都很强。休息一下，明天继续保持！'};
}

export function settlementRows(summary) {
  return (summary?.items || []).map((item, i) => {
    const stage = STAGES.find(s => s.action === item.action) || STAGES[i] || {};
    const count = Math.max(0, Math.floor(Number(item.count) || 0));
    const calories = Math.max(0, Number(item.calories) || 0);
    return {action: item.action || stage.action, stage: stage.name || '', move: item.move || stage.move || '', count, calories};
  });
}
export function settlementTotal(summary) {
  const rows = settlementRows(summary);
  const given = Number(summary?.totalCalories);
  return {count: rows.reduce((t, r) => t + r.count, 0),
    calories: Number.isFinite(given) && given >= 0 ? given : rows.reduce((t, r) => t + r.calories, 0)};
}
// Calories use the per-action coefficients from core.js and can have two decimals.
export const formatCalories = n => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
};
// Rolling number: eases out, shows whole numbers while moving and the exact value at the end.
export function rollValue(target, progress) {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  if (t >= 1) return target;
  return Math.floor(target * (1 - Math.pow(1 - t, 3)));
}
