// 临时假模块，只在开发时用：web/net/api.js 和 web/stage/ui/ 的正式组件交付前用来走通流程。
// 正式模块到了以后删掉本文件。假 api 只有地址里带 ?fake=1 时才会用，现场永远走真接口或离线游客。
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const apiError = (code, message, status = 0) => Object.assign(new Error(message), {name: 'ApiError', code, status});
const BOARD = [['海风小队', 182], ['椰子王', 160], ['阿木', 131], ['晨跑达人', 118], ['小麦', 96], ['林间', 80], ['浪花', 64], ['石头', 52], ['小鱼', 40], ['阿海', 33], ['椰林', 21]];

// mode: '' 正常；'offline' 全部连不上；'submit' 只有提交成绩失败（进本地队列）。
export function createFakeApi({mode = ''} = {}) {
  const accounts = new Map(), board = new Map(BOARD);
  let nextId = 100;
  const net = async (ms = 150) => { await sleep(ms); if (mode === 'offline') throw apiError('network', '连不上服务器'); };
  const current = () => {
    const account = [...accounts.values()].find(item => item.id === api.user?.id);
    if (!account) throw apiError('auth', '登录已过期，请重新登录', 401);
    return account;
  };
  const api = {
    fake: true, user: null, online: mode !== 'offline',
    async health() { await net(60); return {ok: true}; },
    async register(username, password) {
      await net();
      if (accounts.has(username)) throw apiError('taken', '用户名已被占用', 409);
      const account = {id: nextId++, username, password, save: null, version: 0};
      accounts.set(username, account);
      api.user = {id: account.id, username};
      return {token: 'fake', user: api.user};
    },
    async login(username, password) {
      await net();
      const account = accounts.get(username);
      if (!account || account.password !== password) throw apiError('credentials', '用户名或密码不对', 401);
      api.user = {id: account.id, username};
      return {token: 'fake', user: api.user};
    },
    async logout() { api.user = null; },
    async me() { return api.user; },
    async loadSave() { await net(400); const account = current(); return account.save ? {data: structuredClone(account.save), version: account.version} : null; },
    async storeSave(data) { await net(120); const account = current(); account.save = structuredClone(data); account.version++; return {version: account.version}; },
    async submitRound({counts}) {
      try { await net(500); if (mode === 'submit') throw apiError('network', '连不上服务器'); } catch { return {queued: true}; }
      const account = current();
      board.set(account.username, (board.get(account.username) || 0) + counts.reduce((sum, n) => sum + n, 0));
      const totals = [...board.values()].sort((a, b) => b - a), mine = board.get(account.username);
      const others = totals.length - 1;
      return {accepted: true, weekTotal: mine, weekRank: totals.indexOf(mine) + 1,
        weekPercentile: others ? Math.floor(100 * totals.filter(value => value < mine).length / others) : null};
    },
    async leaderboard(period = 'week', limit = 10) {
      await net(200);
      const entries = [...board.entries()].sort((a, b) => b[1] - a[1]).map(([username, total], i) => ({rank: i + 1, username, total, rounds: 1}));
      const me = api.user ? entries.find(entry => entry.username === api.user.username) || null : null;
      return {period, weekStart: '2026-11-02', entries: entries.slice(0, limit), me};
    },
    async stats() { return {}; },
    recentUsers() { return [...accounts.keys()].slice(-5).reverse(); },
    forgetRecent() {},
    async flush() {},
  };
  return api;
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
};

// 临时登录界面：onDone({user}) / onDone({guest: true}) / Esc 时 onDone({cancel: true})。
export function mountLogin(root, {api, onDone}) {
  const name = el('input', {autocomplete: 'off', spellcheck: false, maxLength: 16});
  const pass = el('input', {type: 'password', autocomplete: 'new-password', maxLength: 128});
  const err = el('p', {className: 'err', role: 'alert'});
  const run = async register => {
    err.textContent = '';
    const username = name.value.trim(), password = pass.value;
    if ([...username].length < 2 || password.length < 6) { err.textContent = '用户名至少 2 个字，密码至少 6 位'; return; }
    try {
      const result = await (register ? api.register(username, password, {remember: false}) : api.login(username, password, {remember: false}));
      onDone({user: result?.user || api.user});
    } catch (error) { err.textContent = error?.code === 'network' ? '连不上服务器，可以先用游客模式' : error?.message || '登录失败'; }
  };
  const form = el('form', {className: 'panel plain'}, el('h2', {textContent: '登录（临时界面）'}),
    el('label', {}, '用户名', name), el('label', {}, '密码', pass), err,
    el('div', {className: 'row'}, el('button', {type: 'submit', className: 'primary', textContent: '登录'}),
      el('button', {type: 'button', textContent: '注册', onclick: () => run(true)}),
      el('button', {type: 'button', textContent: '游客', id: 'tmpGuest', onclick: () => onDone({guest: true})})));
  form.onsubmit = event => { event.preventDefault(); run(false); };
  form.onkeydown = event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); onDone({cancel: true}); } };
  root.replaceChildren(form);
  return {focus: () => name.focus(), destroy: () => form.remove()};
}

// 临时排行榜：compact 只显示前 5 名，不带标题。
export function mountBoard(root, {api, period = 'week', highlight = null, limit = 10, compact = false}) {
  const list = el('ol'), status = el('p', {className: 'sub', textContent: '正在加载…'});
  const box = el('div', {className: compact ? 'plain compact' : 'panel plain'}, compact ? null : el('h2', {textContent: '本周排行（临时界面）'}), status, list);
  root.replaceChildren(box);
  const who = typeof highlight === 'string' ? highlight : highlight?.username || null;
  let alive = true, revision = 0;
  async function refresh() {
    const mine = ++revision;
    try {
      const data = await api.leaderboard(period, compact ? 5 : limit);
      if (!alive || mine !== revision) return;
      const rows = (data?.entries || []).slice(0, compact ? 5 : limit);
      status.textContent = rows.length ? '' : '本周还没有人上榜，来做第一个！';
      list.replaceChildren(...rows.map(row => el('li', {className: row.username === who ? 'me' : ''},
        el('span', {textContent: `${row.rank}. ${row.username}`}), el('b', {textContent: String(row.total ?? 0)}))));
    } catch { if (alive && mine === revision) { status.textContent = '离线，暂时看不到排行榜'; list.replaceChildren(); } }
  }
  refresh();
  return {refresh, destroy() { alive = false; box.remove(); }};
}
