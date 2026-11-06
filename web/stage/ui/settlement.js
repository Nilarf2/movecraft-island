// Big-screen settlement: the four moves roll in one by one, then the total, then the rank card flips.
// The countdown to the leaderboard belongs to the stage page; this only calls onDone when 继续 is pressed.
import {h, uid, trapTab, play, reducedMotion, whenStyled} from './dom.js';
import {settlementRows, settlementTotal, reasonText, formatCount, formatCalories, rollValue} from './logic.js';

export const TIMING = {first: 450, step: 520, roll: 700, total: 420, flip: 650};
const TIPS = {
  guest: '注册账号，下一轮就能上榜。',
  demo: '用摄像头完整玩一轮，成绩才计入排行。',
  queued: '成绩已经记下，不用重玩。',
};

export function mountSettlement(root, {summary = null, rank = null, reason = null, demo = false, sfx = null, onDone = () => {}} = {}) {
  const rows = settlementRows(summary), total = settlementTotal(summary);
  const why = reasonText(reason), place = summary?.percentile;
  const still = reducedMotion();
  const timers = new Set(), tweens = new Set();
  let destroyed = false, done = false, frame = 0;
  const titleId = uid('mcui-settle');

  const count = (n, unit = '次') => h('span', {class: 'mcui-count'}, h('span', {'data-num': '', text: '0'}), h('small', {text: unit}));
  const kcal = () => h('span', {class: 'mcui-kcal'}, h('span', {'data-num': '', text: '0'}), h('small', {text: '千卡'}));
  const moveEls = rows.map(row => {
    const el = h('li', {class: 'mcui-move is-pending', 'data-action': row.action},
      h('span', {class: 'mcui-move-name', text: `完成${row.move}`}), count(0, '个'), kcal());
    return {row, el, nums: el.querySelectorAll('[data-num]')};
  });
  const totalEl = h('div', {class: 'mcui-total is-pending'},
    h('span', {class: 'mcui-move-name', text: '合计'}), count(), kcal());
  const totalNums = totalEl.querySelectorAll('[data-num]');
  const list = rows.length ? h('ol', {class: 'mcui-moves', 'aria-hidden': 'true'}, ...moveEls.map(m => m.el))
    : h('p', {class: 'mcui-state', text: '这一轮没有记录到动作'});
  const spoken = h('p', {class: 'mcui-sr', 'aria-live': 'polite'});

  let side;
  if (place !== null && place !== undefined) {
    side = h('div', {class: 'mcui-flip', 'data-ui': 'rank'}, h('div', {class: 'mcui-flip-inner'},
      h('div', {class: 'mcui-face mcui-face-front', 'aria-hidden': 'true'},
        h('span', {class: 'mcui-face-q', text: '?'}), h('p', {class: 'mcui-face-label', text: '全国鼓励排名'})),
      h('div', {class: 'mcui-face mcui-face-back'},
        h('p', {class: 'mcui-face-rank'}, '已击败全国', h('b', {text: String(place)}), '% 的人'),
        h('p', {class: 'mcui-face-detail', text: '你比许多人都更愿意坚持运动！'}))));
  } else if (why) {
    side = h('div', {class: 'mcui-reason is-pending', 'data-ui': 'reason', 'data-reason': reason},
      h('p', {class: 'mcui-reason-title', text: why.title}), h('p', {text: why.detail}),
      TIPS[reason] ? h('p', {class: 'mcui-reason-tip', text: TIPS[reason]}) : null);
  } else {
    side = h('div', {class: 'mcui-reason is-pending', 'data-ui': 'cheer'},
      h('p', {class: 'mcui-reason-title', text: '继续加油'}),
      h('p', {class: 'mcui-reason-tip', text: summary?.encouragement || '休息一下，明天继续！'}));
  }

  const ok = h('button', {class: 'mcui-btn is-primary', type: 'button', 'data-action': 'ok', text: '继续', onclick: confirm});
  const card = h('div', {class: 'mcui-card mcui-settle', role: 'dialog', 'aria-labelledby': titleId},
    h('div', {class: 'mcui-settle-head'}, h('h2', {id: titleId, class: 'mcui-title', text: '本轮完成！'}),
      h('p', {class: 'mcui-sub', text: demo ? '键鼠试玩结算，不计入实际运动记录。' : '四关全部完成，辛苦啦！'})),
    h('div', {class: 'mcui-settle-body'}, h('div', {class: 'mcui-moves-box'}, list, totalEl), side),
    h('div', {class: 'mcui-settle-foot'}, h('p', {class: 'mcui-sub', text: summary?.calorieNote || ''}), ok),
    spoken);
  const layer = h('div', {class: 'mcui mcui-layer', 'data-ui': 'settlement', 'data-state': 'running',
    onkeydown: event => { if (event.key === 'Tab') trapTab(event, layer); }}, card);
  const setNums = (nums, n, calories) => {
    nums[0].textContent = formatCount(n);
    nums[1].textContent = formatCalories(calories);
  };
  // One requestAnimationFrame loop drives every rolling number.
  function tween(ms, step) {
    const item = {start: performance.now(), ms, step};
    tweens.add(item);
    if (!frame) frame = requestAnimationFrame(tick);
  }
  function tick(now) {
    frame = 0;
    for (const item of tweens) {
      const t = Math.min(1, Math.max(0, (now - item.start) / item.ms));
      item.step(t);
      if (t >= 1) tweens.delete(item);
    }
    if (tweens.size && !destroyed) frame = requestAnimationFrame(tick);
  }
  const roll = (nums, n, calories) => tween(TIMING.roll, t =>
    t >= 1 ? setNums(nums, n, calories) : setNums(nums, rollValue(n, t), rollValue(calories, t)));
  const later = (ms, fn) => {
    const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
    timers.add(id);
  };

  function run() {
    let at = TIMING.first;
    moveEls.forEach(({row, el, nums}, i) => {
      later(at, () => {
        el.classList.remove('is-pending');
        roll(nums, row.count, row.calories);
        play(sfx, 'coin', {pitch: (i + 1) / (moveEls.length + 1)});
      });
      at += TIMING.step;
    });
    later(at + TIMING.total, () => {
      totalEl.classList.remove('is-pending');
      roll(totalNums, total.count, total.calories);
      play(sfx, 'repFinal');
    });
    later(at + TIMING.total + TIMING.roll + TIMING.flip, reveal);
  }
  // The final state. Also used to skip the animation and when motion is reduced.
  function finish() {
    for (const id of timers) clearTimeout(id);
    timers.clear(); tweens.clear();
    cancelAnimationFrame(frame); frame = 0;
    for (const {row, el, nums} of moveEls) { el.classList.remove('is-pending'); setNums(nums, row.count, row.calories); }
    totalEl.classList.remove('is-pending');
    setNums(totalNums, total.count, total.calories);
    reveal(true);
  }
  function reveal(quiet = false) {
    if (done) return;
    done = true;
    if (place) side.classList.add('is-flipped'); else side.classList.remove('is-pending');
    if (!quiet) play(sfx, place ? 'whoosh' : 'uiSelect');
    const head = `本轮一共 ${formatCount(total.count)} 次，约 ${formatCalories(total.calories)} 千卡。`;
    spoken.textContent = head + (place !== null && place !== undefined ? `已击败全国百分之${place}的人！` : why ? why.detail : '');
    layer.dataset.state = 'done';
  }
  function confirm() {
    if (destroyed) return;
    if (!done) finish();
    play(sfx, 'uiSelect');
    onDone();
  }

  const styled = whenStyled(layer);
  root.append(layer);
  if (still) finish(); else run();
  styled.then(() => { if (!destroyed) ok.focus({preventScroll: true}); });
  return {
    destroy() {
      destroyed = true;
      for (const id of timers) clearTimeout(id);
      timers.clear(); tweens.clear();
      cancelAnimationFrame(frame);
      layer.remove();
    },
  };
}
