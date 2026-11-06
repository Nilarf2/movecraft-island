[memoh pruned] tool result (read).structuredContent.content too long (bytes=18532, lines=261), showing head/tail

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

[...snip...]

, settlements, legacy}) {
  const lines = new Map();
  const add = part => {
    const existing = lines.get(part.text);
    if (existing && existing.group !== part.group) throw new Error(`同一句台词出现在两个分组：${part.text}`);
    if (!existing) lines.set(part.text, {text: part.text, style: VOICE_STYLES[part.group], group: part.group});
  };
  if (legacy) rulesParts().forEach(add);
  loginConfirmParts().forEach(add);
  for (const [id, text] of Object.entries(HINTS)) add(line(HINT_VOICE[id], LOGIN_HINTS.has(id) ? 'login' : 'correction'));
  for (const item of [...Object.values(CAMERA_ERRORS), ...Object.values(CAMERA_TIMEOUTS)]) add(line(item.voice, 'login'));
  for (const key of Object.keys(KIOSK)) kioskParts(key).forEach(add);
  for (let stage = 0; stage < STAGES.length; stage++) {
    for (let target = targets[0]; target <= targets[1]; target++) {
      stageParts({stage, target, greeting: stage === 0}).forEach(add);
      stageParts({stage, target}).forEach(add);
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
  const uneven = roundSummary({counts: [1, 2, 3, 4]});
  for (const demo of [false, true]) {
    for (let count = settlements[0]; count <= settlements[1]; count++) {
      const summary = roundSummary({counts: [count, count, count, count]});
      if (legacy) settlementParts({demo, summary}).forEach(add);
      settlementParts({demo, summary, percentile: false}).forEach(add);
    }
    settlementParts({demo, summary: uneven, percentile: false}).forEach(add);
  }
  if (legacy) for (let percentile = 95; percentile <= 99; percentile++) add(line(rankText(percentile), 'settlement'));
  for (const reason of [null, 'guest', 'offline']) {
    for (const rank of [1, 2, 5, 20]) for (const percentile of [null, 30, 80]) rankParts({rank, percentile, reason}).forEach(add);
  }
  failedParts().forEach(add);
  return [...lines.values()];
}
