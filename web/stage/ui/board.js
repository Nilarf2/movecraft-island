// Big-screen leaderboard: 本周 / 总榜 tabs, medals for the top three, the current player highlighted.
// compact is the attract-screen sidebar: top five, no tabs. refresh() can be called any number of times.
import {h, uid, play, whenStyled} from './dom.js';
import {PERIODS, boardModel, emptyText, formatCount, errorCode, withTimeout} from './logic.js';

// The server accepts limit 1–100; asking for at least 10 rows costs nothing and keeps one cache shape.
const SERVER_MIN = 10, SERVER_MAX = 100;
const SUBTITLE = {week: '按本周摄像头模式的有效动作次数排名，每周一重新开始', all: '按所有摄像头模式的有效动作次数排名'};

export function mountBoard(root, {api = null, period = 'week', highlight = null, limit = 10, compact = false, sfx = null} = {}) {
  const show = compact ? 5 : Math.min(SERVER_MAX, Math.max(1, Math.floor(Number(limit) || 10)));
  const fetchLimit = Math.min(SERVER_MAX, Math.max(SERVER_MIN, show));
  let current = PERIODS.some(p => p.id === period) ? period : 'week';
  let serial = 0, destroyed = false, shown = null; // shown: the period whose rows are on screen

  const titleId = uid('mcui-board');
  const title = h('h2', {id: titleId, class: 'mcui-board-title'});
  const tabs = compact ? null : PERIODS.map(p => h('button', {class: 'mcui-tab', type: 'button', role: 'tab',
    'data-period': p.id, text: p.label, onclick: () => select(p.id)}));
  const tablist = tabs ? h('div', {class: 'mcui-tabs', role: 'tablist', 'aria-label': '排行榜范围', onkeydown: onTabKey}, ...tabs) : null;
  const sub = compact ? null : h('p', {class: 'mcui-board-sub'});
  const body = h('div', {class: 'mcui-board-body', role: tabs ? 'tabpanel' : null, 'aria-labelledby': titleId});
  const stale = h('p', {class: 'mcui-stale', role: 'status', hidden: true});
  const meLine = h('div', {class: 'mcui-me', 'data-ui': 'me', hidden: true});
  const panel = h('section', {class: `mcui mcui-board${compact ? ' is-compact' : ''}`, 'data-ui': 'board', 'aria-labelledby': titleId},
    h('div', {class: 'mcui-board-head'}, title, tablist), sub, body, stale, meLine);

  const score = moves => h('span', {class: 'mcui-score'}, formatCount(moves), h('small', {text: '次'}));
  const rowEl = row => h('li', {class: `mcui-row${row.isMe ? ' is-me' : ''}`, 'aria-current': row.isMe ? 'true' : null},
    h('span', {class: `mcui-rank${row.medal ? ` is-${row.medal}` : ''}`, text: String(row.rank)}),
    h('span', {class: 'mcui-who'}, h('span', {class: 'mcui-name', title: row.username, text: row.username}),
      row.isMe ? h('span', {class: 'mcui-you', text: '你'}) : null),
    score(row.moves));

  function setState(name, text, tone = 'info') {
    body.replaceChildren(h('p', {class: 'mcui-state', role: 'status', 'data-tone': tone, text}));
    meLine.hidden = stale.hidden = true;
    panel.dataset.state = name;
  }
  function loading() {
    shown = null;
    body.replaceChildren(h('p', {class: 'mcui-state', role: 'status', text: '正在加载排行榜…'}),
      h('div', {class: 'mcui-rows', 'aria-hidden': 'true'}, ...Array.from({length: compact ? 3 : 5}, () => h('div', {class: 'mcui-skel'}))));
    meLine.hidden = stale.hidden = true;
    panel.dataset.state = 'loading';
  }
  function render(data, period) {
    const model = boardModel(data, {limit: show, highlight});
    shown = period;
    if (!model.rows.length) setState('empty', emptyText(period));
    else {
      body.replaceChildren(h('ol', {class: 'mcui-rows'}, ...model.rows.map(rowEl)));
      stale.hidden = true;
      panel.dataset.state = 'ready';
    }
    meLine.hidden = !model.me;
    if (model.me) meLine.replaceChildren(h('span', {class: 'mcui-me-label', text: `你：第 ${model.me.rank} 名`}),
      h('span', {class: 'mcui-name', text: model.me.username === '你' ? '' : model.me.username}), score(model.me.moves));
  }
  // Each call replaces what is on screen; an older reply that arrives late is dropped.
  function refresh() {
    if (destroyed) return Promise.resolve();
    const id = ++serial, period = current;
    updateHeader();
    if (shown !== period) loading();
    if (typeof api?.leaderboard !== 'function') {
      setState('offline', '连不上服务器，排行榜暂时看不到', 'warn');
      return Promise.resolve();
    }
    panel.setAttribute('aria-busy', 'true');
    return withTimeout(Promise.resolve().then(() => api.leaderboard(period, fetchLimit)))
      .then(data => { if (id === serial && !destroyed) render(data, period); })
      .catch(error => {
        if (id !== serial || destroyed) return;
        const offline = errorCode(error) === 'network';
        if (shown === period) {
          // Keep the last rows on screen and say they may be out of date.
          stale.textContent = offline ? '连不上服务器，显示的是上次的排行' : '排行榜没能更新，显示的是上次的排行';
          stale.hidden = false;
        } else if (offline) setState('offline', '连不上服务器，排行榜暂时看不到', 'warn');
        else setState('error', '排行榜暂时看不到，请稍后再试', 'warn');
      })
      .finally(() => { if (id === serial && !destroyed) panel.removeAttribute('aria-busy'); });
  }
  function updateHeader() {
    title.textContent = compact ? (current === 'week' ? '本周排行' : '总排行') : '排行榜';
    if (sub) sub.textContent = SUBTITLE[current];
    for (const tab of tabs || []) {
      const on = tab.dataset.period === current;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
  }
  function select(id) {
    if (destroyed || id === current) return;
    current = id;
    play(sfx, 'uiMove');
    refresh();
  }
  function onTabKey(event) {
    const i = PERIODS.findIndex(p => p.id === current), last = PERIODS.length - 1;
    const next = {ArrowLeft: i ? i - 1 : last, ArrowRight: i === last ? 0 : i + 1, Home: 0, End: last}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(PERIODS[next].id);
    tabs[next].focus();
  }

  updateHeader();
  loading();
  whenStyled(panel);
  root.append(panel);
  refresh();
  return {
    refresh,
    destroy() { destroyed = true; serial++; panel.remove(); },
  };
}
