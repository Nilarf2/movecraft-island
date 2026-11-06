// The island guide's spoken script. DOM-free so tools can list every line to record.
// Each part's key is its exact text; recorded clips are looked up by that text.
import {STAGES, SHELTERS, roundSummary} from './core.js';
import {HINTS} from './detector.js';

// One short delivery note per group, sent to the TTS model alongside each line.
export const VOICE_STYLES = {
  rules: '热情亲切的荒岛向导，语速适中、吐字清楚，像在给新朋友介绍玩法',
  login: '耐心、清楚、语气轻松，像站在旁边帮忙调试设备',
  stage: '有活力的带练教练宣布新任务，干脆利落，带一点期待',
  guide: '平稳清楚地讲动作要领，语速稍慢，友好',
  count: '短促有力的报数，像教练喊口令，节奏感强',
  cheer: '真诚开心的鼓励，语气上扬但不夸张',
  correction: '温和具体的提醒，语速平稳，不带责备',
  settlement: '庆祝的语气，开心温暖，像为朋友完成挑战鼓掌',
  note: '平实轻快地顺口带过，不严肃',
  failed: '温柔安慰，语速放慢，给人重新开始的信心',
};

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
// Counting reading: 2 → 二, 12 → 十二. Values without recordings fall back to digits for TTS.
export function chineseNumber(value) {
  if (!Number.isInteger(value) || value < 0 || value > 99) return String(value);
  if (value < 10) return DIGITS[value];
  const ones = value % 10 ? DIGITS[value % 10] : '';
  return value < 20 ? '十' + ones : DIGITS[Math.floor(value / 10)] + '十' + ones;
}
// Before a measure word a lone 2 reads 两 (两个、两卡); 12 and 22 keep 二.
export function chineseQuantity(value) { return value === 2 ? '两' : chineseNumber(value); }
// Calories are whole or half numbers: 3.5 → 三点五.
export function chineseCalories(value) {
  if (Number.isInteger(value)) return chineseQuantity(value);
  const whole = Math.floor(value);
  return Number.isFinite(value) && value > 0 && Math.abs(value - whole - 0.5) < 1e-9 ? chineseNumber(whole) + '点五' : String(value);
}

const line = (text, group) => ({text, key: text, group});

export const RULES = '欢迎来到体感荒岛！竖直跳摘椰子换淡水，开合跳砍树攒木材，手臂平举耕种收粮食，深蹲盖房子。'
  + '每项从十个开始，每两天加一个，最多二十五个。每天都要喝水吃饭，生命归零就挑战失败。'
  + '留出活动空间，量力而行。准备好了，就挥手登岛吧！';
export const LOGIN_CONFIRM = '摄像头准备好了。右手向右侧平举，停一下，再往左挥，就能登岛。';
export const GREETING = '登岛成功！';
export const FAILED_LINE = '生命值归零，这次挑战结束了。休息好了，随时可以重新开岛。';

const STAGE_VOICE = [
  {intro: n => `第一站，摘椰子！来${chineseQuantity(n)}个竖直跳，换点淡水。`, resume: '继续摘椰子！',
    guide: '双脚一起跳起来，再稳稳落地。记得让双脚都在画面里。', done: '椰子摘够了，淡水加两份！'},
  {intro: n => `第二站，砍树！来${chineseQuantity(n)}个开合跳，备好木材。`, resume: '继续砍树！',
    guide: '跳开时双手举过头顶，收脚时放下手臂。', done: '木头砍好了，木材加五份！'},
  {intro: n => `第三站，耕种！来${chineseQuantity(n)}个手臂平举，种下明天的口粮。`, resume: '继续耕种！',
    guide: '双臂从身体两侧抬到肩膀高度，再完整放下。', done: '麦子种下了，食物加两份！'},
  {intro: n => `最后一站，建房！来${chineseQuantity(n)}个深蹲，把家建起来。`, resume: '继续建房！',
    guide: '站直，臀部往后坐下去，再站起来。侧着点站，我更容易看清膝盖。', done: null},
];
const HALF = '过半了，保持节奏！';
const THREE_LEFT = '还剩三个，坚持住！';
const LAST = '最后一个！';
const STEADY = ['很好，继续！', '保持这个节奏！', '稳稳的，接着来！'];
const REINFORCED = '营地又加固了，淡水和食物各加一份！';
function shelterDone(level) {
  if (level === 1) return `${SHELTERS[1]}搭好了！`;
  if (level === SHELTERS.length - 1) return `${SHELTERS[level]}建成了！`;
  return level > 1 && level < SHELTERS.length ? `升级成${SHELTERS[level]}了！` : null;
}

export function rulesParts() { return [line(RULES, 'rules')]; }

// A partly finished stage resumes with the remaining count instead of restating the goal.
export function stageParts({stage, target, done = 0, greeting = false}) {
  const voice = STAGE_VOICE[stage];
  if (!voice) return [];
  const parts = greeting ? [line(GREETING, 'cheer')] : [];
  if (done > 0 && done < target) parts.push(line(voice.resume, 'stage'), line(`还差${chineseQuantity(target - done)}个。`, 'stage'));
  else parts.push(line(voice.intro(target), 'stage'));
  parts.push(line(voice.guide, 'guide'));
  return parts;
}

// Counts stay short; milestones get a cheer, and a slow pace earns a little encouragement.
export function countParts({stage, count, target, shelter = 0, reinforced = false, slow = false}) {
  const parts = [line(`${chineseNumber(count)}！`, 'count')];
  if (count >= target) {
    const done = stage === 3 ? (reinforced ? REINFORCED : shelterDone(shelter)) : STAGE_VOICE[stage]?.done;
    if (done) parts.push(line(done, 'cheer'));
  } else if (count === target - 1) parts.push(line(LAST, 'cheer'));
  else if (count === target - 3) parts.push(line(THREE_LEFT, 'cheer'));
  else if (count === Math.ceil(target / 2)) parts.push(line(HALF, 'cheer'));
  else if (slow) parts.push(line(STEADY[count % STEADY.length], 'cheer'));
  return parts;
}

const MOVES = STAGES.map(stage => stage.move);
const MOVE_LIST = MOVES.slice(0, -1).join('、') + '和' + MOVES.at(-1);
const rankText = percentile => `你击败了全国百分之${chineseNumber(percentile)}的人！`;
// Equal counts read as one recorded sentence; uneven legacy rounds point to the on-screen table.
export function settlementParts({demo = false, summary}) {
  const parts = [line(demo ? '键鼠试玩结算，不计入真实运动。' : '这一轮全部完成，辛苦啦！', 'settlement')];
  const counts = summary.items.map(item => item.count);
  if (counts[0] >= 1 && counts.every(count => count === counts[0])) {
    parts.push(line(`${MOVE_LIST}各做了${chineseQuantity(counts[0])}个，一共消耗${chineseCalories(summary.totalCalories)}卡。${rankText(summary.percentile)}`, 'settlement'));
  } else parts.push(line('每项的次数和热量都在屏幕上。', 'settlement'), line(rankText(summary.percentile), 'settlement'));
  parts.push(line('热量和排名都是游戏换算的鼓励，不是真实测量。', 'note'), line('每一个动作都算数。好好休息，明天岛上见！', 'settlement'));
  return parts;
}
// Detector hints stay as on-screen text; the guide says them in a more spoken way.
const HINT_VOICE = {
  ready: '站稳一点，让我看清你的全身。',
  waveSweep: '很好，右手保持在肩膀高度，往左挥。',
  waveReady: '右手先向右侧平举，停一下，再往左挥。',
  raiseUp: '好，双臂放回身体两侧，这一个就完成了。',
  raiseReady: '双臂向两侧抬到肩膀高，停一下，再放下来。',
  jackOpen: '放下双手，把脚收回来。',
  jackFeetOnly: '脚打开得不错，双手再举高一点。',
  jackReady: '跳开双脚，同时把双手举过头顶。',
  squatLow: '慢慢站直，这一个就完成了。',
  squatReady: '先站直，臀部往后下方坐，再站起来。',
  jumpCalibrate: '先站直别动，我在找地面的位置。',
  jumpAir: '双脚稳稳落地。',
  jumpReady: '双脚一起往上跳，再落回原地。',
  missingArms: '我看不全你的双臂，往后退一点，让肩膀和双臂都在画面里，光线亮一点更好。',
  missingBody: '往后退一点，让肩膀、膝盖和双脚都在画面里。',
};
const LOGIN_HINTS = new Set(['waveSweep', 'waveReady']);

// Camera problems: screen text keeps the full instructions, the voice keeps the next step.
export const CAMERA_ERRORS = {
  NotAllowedError: {screen: '未获得摄像头权限。请点击地址栏旁的摄像头图标允许访问，再重试。', voice: '还没有拿到摄像头权限。点一下地址栏旁边的摄像头图标，选择允许，再试一次。'},
  NotFoundError: {screen: '未找到摄像头，请连接摄像头后重试。', voice: '没有找到摄像头，接好摄像头再试一次。'},
  NotReadableError: {screen: '摄像头无法读取：可能被其他应用占用，或该设备是尚未连接的虚拟摄像头。请在上方切换到其他摄像头后重试。', voice: '摄像头打不开，可能正被别的程序占用。在上面换一个摄像头试试。'},
  OverconstrainedError: {screen: '所选摄像头不支持需要的分辨率或帧率，请切换到其他摄像头后重试。', voice: '这个摄像头不太合适，在上面换一个试试。'},
  SecurityError: {screen: '浏览器阻止了摄像头访问，请用近期版本的 Chrome 或 Edge 打开本地地址。', voice: '浏览器拦住了摄像头。换用新版的 Chrome 或 Edge 打开本地地址试试。'},
  AbortError: {screen: '摄像头启动被中断，请重试。', voice: '摄像头启动被打断了，再试一次吧。'},
};
export const CAMERA_TIMEOUTS = {
  noVideo: {screen: '摄像头没有送来画面，请检查设备是否正常连接后重试。', voice: '摄像头没有画面传过来，检查一下连接，再试一次。'},
  model: {screen: '模型加载超时，请关闭占用资源的程序后重试。', voice: '识别模型加载太久了，关掉占资源的程序，再试一次。'},
};
const UNKNOWN_CAMERA = '无法开启本机识别：';
export function cameraError(error) {
  const known = CAMERA_ERRORS[error?.name];
  if (known) return known;
  const detail = error?.message || error?.name || '';
  const timeout = Object.values(CAMERA_TIMEOUTS).find(item => item.screen === detail);
  const screen = UNKNOWN_CAMERA + detail;
  return {screen, voice: timeout?.voice || screen};
}

// Displayed status or hint text → what the guide says. Unknown text is read as shown.
const SPOKEN = new Map([
  ...Object.entries(HINTS).map(([id, text]) => [text, HINT_VOICE[id]]),
  ...Object.values(CAMERA_ERRORS).map(item => [item.screen, item.voice]),
  ...Object.values(CAMERA_TIMEOUTS).map(item => [UNKNOWN_CAMERA + item.screen, item.voice]),
]);
export function spokenLine(text) { return SPOKEN.get(text) ?? text; }
export function correctionParts(hint) { return [line(spokenLine(hint), 'correction')]; }
export function loginConfirmParts() { return [line(LOGIN_CONFIRM, 'login')]; }
export function loginStatusParts(text) { return [line(spokenLine(text), 'login')]; }
export function failedParts() { return [line(FAILED_LINE, 'failed')]; }

// Every line the game can say with a recording: the TTS generator renders exactly this list.
export function allVoiceLines() {
  const lines = new Map();
  const add = part => {
    const existing = lines.get(part.text);
    if (existing && existing.group !== part.group) throw new Error(`同一句台词出现在两个分组：${part.text}`);
    if (!existing) lines.set(part.text, {text: part.text, style: VOICE_STYLES[part.group], group: part.group});
  };
  rulesParts().forEach(add);
  loginConfirmParts().forEach(add);
  for (const [id, text] of Object.entries(HINTS)) add(line(HINT_VOICE[id], LOGIN_HINTS.has(id) ? 'login' : 'correction'));
  for (const item of [...Object.values(CAMERA_ERRORS), ...Object.values(CAMERA_TIMEOUTS)]) add(line(item.voice, 'login'));
  for (let stage = 0; stage < STAGES.length; stage++) {
    for (let target = 10; target <= 25; target++) {
      stageParts({stage, target, greeting: stage === 0}).forEach(add);
      for (let done = 1; done < target; done++) stageParts({stage, target, done}).forEach(add);
      for (let count = 1; count <= target; count++) {
        for (const slow of [false, true]) {
          if (stage < 3) countParts({stage, count, target, slow}).forEach(add);
          else for (let shelter = 1; shelter < SHELTERS.length; shelter++) {
            countParts({stage, count, target, shelter, slow}).forEach(add);
            if (shelter === SHELTERS.length - 1) countParts({stage, count, target, shelter, reinforced: true, slow}).forEach(add);
          }
        }
      }
    }
  }
  for (const demo of [false, true]) {
    for (let count = 1; count <= 25; count++) settlementParts({demo, summary: roundSummary({counts: [count, count, count, count]})}).forEach(add);
    settlementParts({demo, summary: roundSummary({counts: [0, 0, 0, 0]})}).forEach(add);
  }
  for (let percentile = 95; percentile <= 99; percentile++) add(line(rankText(percentile), 'settlement'));
  failedParts().forEach(add);
  return [...lines.values()];
}
