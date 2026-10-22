// Game rules are independent of the camera, browser storage and drawing.
export const VERSION = 1;
export const SHELTERS = ['荒地', '简陋棚屋', '茅草小屋', '原木木屋', '加固木屋', '石木堡垒', '临海营地据点'];
export const PROTECTION = [0, 0.12, 0.24, 0.36, 0.48, 0.60, 0.72];
export const STAGES = [
  {name: '摘椰子', action: 'jump', move: '竖直跳', result: '获得水源', guide: '双脚起跳，再平稳落地。请让肩、髋和双脚完整入镜。', reward: '淡水 +2', cost: 3},
  {name: '砍树', action: 'jack', move: '开合跳', result: '获得木材', guide: '双脚打开时双手举过头，再收脚、放下双臂。', reward: '木材 +5', cost: 3},
  {name: '耕种', action: 'raise', move: '手臂平举', result: '获得食物', guide: '从双臂自然下垂开始，向两侧平举至肩高，再完整放下。', reward: '食物 +2', cost: 3},
  {name: '建房', action: 'squat', move: '深蹲', result: '庇护所升级', guide: '从站直开始，屈膝下蹲，再站起。侧前方机位更容易看到膝盖。', reward: '庇护所升 1 级 · 消耗 5 木材', cost: 5},
];
const DAY = 86400000;
export function today(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}
export function ordinal(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const n = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === date ? n / DAY : NaN;
}
const finite = (n, min, max, fallback = min) => typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
export function fresh(date = today()) {
  return {version: VERSION, started: date, settled: date, lastLogin: date, absenceBlocks: 0,
    hp: 100, stamina: 0, water: 0, food: 0, wood: 0, shelter: 0,
    stage: 0, counts: [0, 0, 0, 0], rounds: 0, moves: 0, gifts: 0, failed: false,
    history: [], updatedAt: new Date().toISOString()};
}
export function sanitize(raw, date = today()) {
  if (!raw || raw.version !== VERSION || typeof raw !== 'object') throw new Error('存档版本不支持');
  const s = fresh(date);
  for (const k of ['started', 'settled', 'lastLogin']) {
    if (!Number.isFinite(ordinal(raw[k])) || ordinal(raw[k]) > ordinal(date)) throw new Error('存档日期无效，或电脑日期早于存档');
    s[k] = raw[k];
  }
  if (ordinal(s.started) > ordinal(s.settled) || ordinal(s.lastLogin) > ordinal(s.settled)) throw new Error('存档日期顺序无效');
  for (const k of ['stamina', 'water', 'food', 'wood', 'rounds', 'moves', 'gifts', 'absenceBlocks']) s[k] = finite(raw[k], 0, 1000000);
  s.hp = finite(raw.hp, 0, 100, 100);
  s.shelter = finite(raw.shelter, 0, 6);
  s.stage = finite(raw.stage, 0, 4);
  const target = required(s, date);
  s.counts = Array.from({length: 4}, (_, i) => finite(raw.counts?.[i], 0, target));
  // Completed stages cannot be undone or claimed a second time by malformed counters.
  for (let i = 0; i < s.stage; i++) s.counts[i] = target;
  for (let i = s.stage + 1; i < 4; i++) s.counts[i] = 0;
  if (s.stage === 3 && s.wood < 5) throw new Error('建房存档缺少必要木材');
  if (s.stage < 4 && s.counts[s.stage] >= target) s.counts[s.stage] = target - 1;
  s.failed = s.hp === 0;
  s.history = Array.isArray(raw.history) ? raw.history.filter(x => typeof x === 'string').map(x => x.slice(0, 160)).slice(-30) : [];
  return s;
}
export function age(s, date = today()) { return Math.max(0, ordinal(date) - ordinal(s.started)); }
export function required(s, date = today()) { return Math.min(15, 5 + Math.floor(age(s, date) / 2)); }
export function log(s, message) { s.history = [...s.history.slice(-29), message]; }
// Uses local calendar days, with UTC day ordinals solely to avoid DST arithmetic.
export function settle(s, date = today()) {
  const to = ordinal(date), from = ordinal(s.settled);
  if (!Number.isFinite(to) || to < from) return {error: '电脑日期早于存档，请校准时间后重试。', days: 0, loss: 0};
  let loss = 0, downgraded = 0;
  // At most 100 health points: even the strongest camp cannot survive an unbounded absence.
  for (let d = from + 1; d <= to && !s.failed; d++) {
    const blocks = Math.floor(Math.max(0, d - ordinal(s.lastLogin)) / 2);
    const decay = Math.max(0, blocks - s.absenceBlocks);
    if (decay) { const n = Math.min(s.shelter, decay); s.shelter -= n; downgraded += n; s.absenceBlocks = blocks; }
    const waterMissing = s.water < 1, foodMissing = s.food < 1;
    s.water = Math.max(0, s.water - 1); s.food = Math.max(0, s.food - 1);
    const damage = Math.max(1, Math.ceil((4 + (waterMissing ? 10 : 0) + (foodMissing ? 8 : 0)) * (1 - PROTECTION[s.shelter])));
    const damageTaken = Math.min(s.hp, damage); s.hp -= damageTaken; loss += damageTaken;
    if (s.hp === 0) s.failed = true;
  }
  const days = to - from;
  if (days) {
    s.settled = date;
    s.stage = 0; s.counts = [0, 0, 0, 0];
    log(s, `${date} · 经过 ${days} 天，生命 −${loss}${downgraded ? `，庇护所下降 ${downgraded} 级` : ''}。`);
  }
  return {days, loss, downgraded};
}
export function login(s, date = today()) {
  const result = settle(s, date);
  if (result.error) return result;
  // A new calendar-day visit earns a camp-dependent gift only after a completed gesture.
  if (!s.failed && s.lastLogin !== date && s.shelter > 0) {
    const gift = 1 + Math.floor(s.shelter / 2);
    s.stamina += gift; s.gifts += gift;
    log(s, `营地馈赠 · 体力 +${gift}。`);
  }
  s.lastLogin = date; s.absenceBlocks = 0;
  return result;
}
export function record(s, action, date = today()) {
  const sync = settle(s, date);
  if (sync.error || s.failed || s.stage >= 4 || action !== STAGES[s.stage].action) return {accepted: false};
  const i = s.stage, config = STAGES[i], target = required(s, date);
  s.moves++; s.stamina++; s.counts[i]++;
  if (s.counts[i] < target) return {accepted: true, completed: false};
  s.stamina -= config.cost;
  let message = config.result;
  if (i === 0) s.water += 2;
  if (i === 1) s.wood += 5;
  if (i === 2) s.food += 2;
  if (i === 3) {
    if (s.wood < 5) { s.stamina += config.cost; s.counts[i]--; return {accepted: true, completed: false, message: '木材不足，请导入完整存档或开始下一轮采集。'}; }
    s.wood -= 5;
    if (s.shelter < 6) s.shelter++;
    else { s.water++; s.food++; message = '营地加固完成'; }
    s.rounds++;
    const healed = Math.min(6, 100 - s.hp); s.hp += healed;
    log(s, `完成第 ${s.rounds} 轮运动 · 生命 +${healed}，${SHELTERS[s.shelter]}。`);
  }
  s.stage++;
  return {accepted: true, completed: true, message};
}
export function nextRound(s) {
  if (s.failed || s.stage !== 4) return false;
  s.stage = 0; s.counts = [0, 0, 0, 0]; return true;
}
export function exchange(s, kind) {
  if (s.failed || !['food', 'water'].includes(kind) || s.stamina < 5) return false;
  s.stamina -= 5; s[kind]++; return true;
}
