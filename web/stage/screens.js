// 每个状态一屏：切换显示，挂载登录、排行榜、结算组件。组件缺失或出错时用最简单的文字版顶上，流程不断。
const $ = id => document.getElementById(id);
const SCREENS = {attract: 's-attract', login: 's-login', loading: 's-loading', ready: 's-ready', failed: 's-failed',
  settlement: 's-settlement', leaderboard: 's-leaderboard'};
const SLOTS = ['attractBoard', 'loginRoot', 'settleRoot', 'boardRoot'];
const REASON = {guest: '游客成绩不计入排行。', offline: '离线，成绩没有上传。', demo: '键鼠试玩，不计入排行。', queued: '网络恢复后自动上传。'};
const TITLES = {new: '注册成功！', back: '欢迎回来！', guest: '游客模式', offline: '离线模式'};

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
};
function plainSettlement(root, {summary, rank, reason, demo, onDone}) {
  const rankLine = Number.isFinite(summary?.percentile) ? `已击败全国 ${summary.percentile}% 的人` : REASON[reason] || '';
  const button = el('button', {type: 'button', className: 'primary', textContent: '完成', onclick: () => onDone?.()});
  root.replaceChildren(el('div', {className: 'panel plain'}, el('h2', {textContent: demo ? '键鼠试玩结算' : '本轮结算'}),
    el('ol', {}, ...summary.items.map(item => el('li', {}, el('span', {textContent: item.move}), el('b', {textContent: `${item.count} 个 · ${item.calories} 千卡`})))),
    el('p', {className: 'total', textContent: `合计消耗 ${summary.totalCalories} 千卡`}),
    rankLine ? el('p', {className: 'sub', textContent: rankLine}) : null,
    el('p', {className: 'sub', textContent: summary.encouragement}),
    el('p', {className: 'sub', textContent: summary.calorieNote}), el('div', {className: 'row'}, button)));
  return {destroy() { root.replaceChildren(); }};
}
const plainText = (root, title, text) => {
  root.replaceChildren(el('div', {className: 'panel plain'}, title ? el('h2', {textContent: title}) : null, el('p', {className: 'sub', textContent: text})));
  return {destroy() { root.replaceChildren(); }};
};

export function createScreens({ui = {}} = {}) {
  const mounted = {};
  function unmount(slot) {
    const handle = mounted[slot]; delete mounted[slot];
    try { handle?.destroy?.(); } catch (error) { console.warn('[stage] 组件卸载出错：', slot, error); }
    $(slot).replaceChildren();
  }
  // factory may be null (component missing); a throwing component also gets the fallback.
  function mount(slot, factory, fallback) {
    unmount(slot);
    if (factory) {
      try { const handle = factory($(slot)); mounted[slot] = handle || {}; return handle || {}; } catch (error) { console.warn('[stage] 组件出错，改用简易版：', slot, error); }
    }
    unmount(slot);
    mounted[slot] = fallback ? fallback($(slot)) : null;
    return mounted[slot];
  }
  return {
    show(phase) {
      $('s-boot').hidden = true;
      for (const [name, id] of Object.entries(SCREENS)) $(id).hidden = name !== phase;
    },
    boot(text) { $('bootText').textContent = text; },
    unmountAll() { for (const slot of SLOTS) unmount(slot); },
    attractSub(cameraLive) { $('attractSub').textContent = cameraLive ? '站到镜头前挥挥手，或按任意键' : '按任意键开始'; },
    attract({api, cameraLive}) {
      this.attractSub(cameraLive);
      mount('attractBoard', api && ui.mountBoard ? root => ui.mountBoard(root, {api, period: 'week', limit: 5, compact: true, highlight: null}) : null,
        root => plainText(root, '本周排行', api ? '排行榜暂时不可用' : '离线模式，暂时看不到排行榜'));
    },
    refreshAttractBoard() { try { mounted.attractBoard?.refresh?.(); } catch { /* the side panel is optional */ } },
    // Returns null when there is no login component: the page then continues as a guest.
    login({api, sfx, onDone, onCancel}) {
      if (!api || !ui.mountLogin) return null;
      const handle = mount('loginRoot', root => ui.mountLogin(root, {api, sfx, onDone, onCancel}), null);
      try { handle?.focus?.(); } catch { /* focus is a convenience */ }
      return handle;
    },
    ready({welcome, user, cameraLive, demo}) {
      $('readyTitle').textContent = TITLES[welcome] || '准备上岛';
      $('readyName').textContent = user?.username || '';
      this.readyCta({cameraLive, demo});
    },
    readyCta({cameraLive, demo}) {
      $('readyCta').textContent = demo ? '按空格开始' : cameraLive ? '挥手登岛' : '按 Enter 开始';
      $('readySub').textContent = demo ? '键鼠试玩：空格开始，之后每按一次空格算一个动作'
        : cameraLive ? '右手向右侧平举，停一下，再往左挥 · 老师可按 Enter 直接开始'
          : '摄像头没有开启 · 老师按 Enter 开始，或按 D 用键鼠试玩';
    },
    // Live wave hint from the detector while waiting on the ready screen.
    readyHint(text) { if (text && $('readySub').textContent !== text) $('readySub').textContent = text; },
    settlementPending() { mount('settleRoot', null, root => plainText(root, '这一轮全部完成！', '正在计算本周排名…')); },
    settlement({summary, rank, reason, demo = false, sfx, onDone}) {
      mount('settleRoot', ui.mountSettlement ? root => ui.mountSettlement(root, {summary, rank, reason, demo, sfx, onDone}) : null,
        root => plainSettlement(root, {summary, rank, reason, demo, onDone}));
    },
    board({api, user}) {
      mount('boardRoot', api && ui.mountBoard ? root => ui.mountBoard(root, {api, period: 'week', highlight: user?.username || null, limit: 10, compact: false}) : null,
        root => plainText(root, '本周排行', '排行榜暂时不可用'));
    },
    countdown(seconds) { $('boardCount').textContent = String(Math.max(0, seconds)); },
    pause(on, {title = '没有看到你', sub = '回到镜头前就能继续'} = {}) {
      $('pause').hidden = !on;
      if (on) { $('pauseTitle').textContent = title; $('pauseSub').textContent = sub; }
    },
  };
}
