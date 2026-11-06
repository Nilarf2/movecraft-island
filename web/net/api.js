// MoveCraft account and leaderboard client. Full contract: server/README.md.
// The API base comes from the caller or <meta name="movecraft-api">, never from the URL:
// a crafted link must not be able to send a player's password to another server.
export const CODES = ['network', 'invalid', 'taken', 'credentials', 'locked', 'rate', 'conflict', 'rejected', 'auth', 'server'];
const MESSAGES = {
  network: '连不上服务器，请检查网络',
  invalid: '输入不符合要求',
  taken: '这个用户名已经有人用了',
  credentials: '用户名或密码不对',
  locked: '账号已锁定，请稍后再试',
  rate: '操作太频繁，请稍后再试',
  conflict: '存档已在别处更新',
  rejected: '这一轮成绩没有被计入',
  auth: '登录已过期，请重新登录',
  server: '服务器暂时不可用，请稍后再试',
};
const AUTH_KEY = 'movecraft.api.session';
const QUEUE_KEY = 'movecraft.api.queue';
const RECENT_KEY = 'movecraft.stage.recentUsers'; // shared with web/stage/ui/logic.js
const RECENT_MAX = 5, QUEUE_MAX = 20, TIMEOUT_MS = 8000, HEALTH_TIMEOUT_MS = 4000;
const RETRYABLE = new Set(['network', 'server', 'rate']);

export class ApiError extends Error {
  constructor(code, message, status = 0, extra = {}) {
    super(message || MESSAGES[code] || MESSAGES.server);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    if (Number.isFinite(extra.retryAfter)) this.retryAfter = extra.retryAfter;
    if (extra.latest !== undefined) this.latest = extra.latest;
  }
}

// Default './api/v1/' next to the page; a page may override it with <meta name="movecraft-api" content="...">.
export function defaultBase(doc = globalThis.document, location = globalThis.location) {
  const meta = doc?.querySelector?.('meta[name="movecraft-api"]')?.getAttribute?.('content')?.trim();
  return resolveBase(meta || './api/v1/', location?.href);
}
function resolveBase(base, href) {
  const url = new URL(String(base), href);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('API 地址只能是 http 或 https');
  url.search = ''; url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function safeStore(storage) {
  const memory = new Map();
  const ok = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  return {
    get: key => ok(() => (storage ? storage.getItem(key) : memory.get(key)) ?? null, memory.get(key) ?? null),
    set: (key, value) => ok(() => (storage ? storage.setItem(key, value) : memory.set(key, value)), memory.set(key, value)),
    remove: key => ok(() => (storage ? storage.removeItem(key) : memory.delete(key)), memory.delete(key)),
  };
}
const readJson = (store, key, fallback) => { try { return JSON.parse(store.get(key)) ?? fallback; } catch { return fallback; } };
const readList = (store, key) => { const v = readJson(store, key, []); return Array.isArray(v) ? v : []; };
const uuid = () => {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  // randomUUID only exists in secure contexts; a school LAN over plain http still has getRandomValues.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const isoTime = value => value instanceof Date ? value.toISOString()
  : typeof value === 'number' ? new Date(value).toISOString()
  : typeof value === 'string' ? value : new Date().toISOString();
const sameName = (a, b) => String(a).normalize('NFKC').trim().toLowerCase() === String(b).normalize('NFKC').trim().toLowerCase();

export function createApi({base, storage, sessionStorage, fetch, now = () => Date.now(), timeoutMs = TIMEOUT_MS} = {}) {
  const root = base ? resolveBase(base, globalThis.location?.href) : defaultBase();
  const doFetch = fetch || globalThis.fetch?.bind(globalThis);
  const local = safeStore(storage), temp = safeStore(sessionStorage);
  let auth = restore(), online = null, saveVersion = null, flushing = null;

  function restore() {
    for (const [store, remember] of [[temp, false], [local, true]]) {
      const s = readJson(store, AUTH_KEY, null);
      if (s && typeof s.token === 'string' && s.user?.id != null && Date.parse(s.expiresAt) > now()) return {...s, remember};
      if (s) store.remove(AUTH_KEY);
    }
    return null;
  }
  function setAuth(next) {
    local.remove(AUTH_KEY); temp.remove(AUTH_KEY);
    auth = next; saveVersion = null;
    if (next) (next.remember ? local : temp).set(AUTH_KEY, JSON.stringify(
      {token: next.token, expiresAt: next.expiresAt, user: next.user}));
  }

  // One HTTP call. Resolves with the JSON body; rejects with ApiError.
  async function request(method, path, {body, token, timeout = timeoutMs} = {}) {
    const headers = {Accept: 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), timeout) : 0;
    let response, data = null;
    try {
      response = await doFetch(new URL(path, root).href, {method, headers, signal: abort?.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'});
      data = await response.json().catch(() => null);
    } catch {
      online = false;
      throw new ApiError('network', MESSAGES.network, 0);
    } finally { clearTimeout(timer); }
    if (response.ok) { online = true; return data ?? {}; }
    online = response.status < 500 && response.status !== 404;
    const e = data?.error && typeof data.error === 'object' ? data.error : {};
    const code = CODES.includes(e.code) ? e.code : codeFor(response.status);
    const message = typeof e.message === 'string' && e.message && e.message.length <= 200 ? e.message : MESSAGES[code];
    throw new ApiError(code, message, response.status, e);
  }
  // Requests on behalf of the signed-in player; a dead token signs the player out locally.
  // Every successful call also re-sends queued rounds in the background.
  async function call(method, path, options = {}) {
    const token = 'token' in options ? options.token : auth?.token;
    let data;
    try { data = await request(method, path, {...options, token}); } catch (error) {
      if (error.code === 'auth' && token && auth?.token === token) setAuth(null);
      throw error;
    }
    kick();
    return data;
  }
  const kick = () => { flush().catch(() => {}); };
  // Rounds that could not be sent wait in the same storage as their session, each with its own token,
  // so a queued round is never credited to the next player who signs in on a shared screen.
  const queueOf = store => readList(store, QUEUE_KEY).filter(item => item?.body?.roundId && typeof item.token === 'string');
  function enqueue(item, remember) {
    const store = remember ? local : temp;
    store.set(QUEUE_KEY, JSON.stringify([...queueOf(store), item].slice(-QUEUE_MAX)));
  }
  async function drain(store, state) {
    const done = new Set();
    for (const item of queueOf(store)) {
      if (state.stop) break;
      if (!(Date.parse(item.expiresAt) > now())) { done.add(item.body.roundId); state.dropped++; continue; }
      try {
        const data = await request('POST', 'rounds', {body: item.body, token: item.token});
        if (data.accepted !== true) throw new ApiError('server', MESSAGES.server, 200);
        done.add(item.body.roundId); state.sent++;
      } catch (error) {
        if (RETRYABLE.has(error.code)) { state.stop = true; break; }
        if (error.code === 'auth' && auth?.token === item.token) setAuth(null);
        done.add(item.body.roundId); state.dropped++;  // rejected or expired: retrying cannot help
      }
    }
    if (done.size) store.set(QUEUE_KEY, JSON.stringify(queueOf(store).filter(item => !done.has(item.body.roundId))));
  }
  function flush() {
    flushing ??= (async () => {
      const state = {sent: 0, dropped: 0, stop: false};
      try { await drain(temp, state); await drain(local, state); } finally { flushing = null; }
      return {sent: state.sent, dropped: state.dropped, pending: pending()};
    })();
    return flushing;
  }
  const pending = () => queueOf(temp).length + queueOf(local).length;

  async function submitRound({counts, durationSec, mode, finishedAt} = {}) {
    if (!auth) throw new ApiError('auth', MESSAGES.auth, 401);
    const session = auth;
    const body = {roundId: uuid(), counts: Array.isArray(counts) ? [...counts] : counts, durationSec, mode,
      finishedAt: isoTime(finishedAt)};
    try {
      const data = await call('POST', 'rounds', {body, token: session.token});
      if (data.accepted !== true) throw new ApiError('server', MESSAGES.server, 200);
      return data;
    } catch (error) {
      if (!RETRYABLE.has(error.code)) throw error;
      enqueue({body, token: session.token, expiresAt: session.expiresAt}, session.remember);
      return {queued: true};
    }
  }
  async function signIn(path, username, password, {remember = false} = {}) {
    const data = await call('POST', path, {body: {username, password, remember: remember === true}, token: null});
    setAuth({token: data.token, expiresAt: data.expiresAt, user: data.user, remember: remember === true});
    rememberName(data.user.username);
    return {user: {...data.user}, expiresAt: data.expiresAt};
  }
  async function logout() {
    const session = auth;
    setAuth(null);  // the next player never sees this account, even if the network is down
    if (!session) return {ok: true};
    try { await flush(); } catch { /* queued rounds keep their own token */ }
    try { await request('POST', 'auth/logout', {token: session.token}); } catch { /* the token expires on its own */ }
    return {ok: true};
  }
  async function me() {
    if (!auth) return null;
    try { return {...(await call('GET', 'me')).user}; } catch (error) {
      if (error.code === 'auth') return null;
      throw error;
    }
  }
  async function loadSave() {
    if (!auth) throw new ApiError('auth', MESSAGES.auth, 401);
    const session = auth, data = await call('GET', 'save');
    if (auth === session) saveVersion = data.version ?? 0;
    return {data: data.data ?? null, version: data.version ?? 0, updatedAt: data.updatedAt ?? null};
  }
  // On 409 the error carries latest ({data, version, updatedAt}); the next storeSave builds on that version.
  async function storeSave(data, {version} = {}) {
    if (!auth) throw new ApiError('auth', MESSAGES.auth, 401);
    const session = auth;
    try {
      const out = await call('PUT', 'save', {body: {data, version: Number.isInteger(version) ? version : (saveVersion ?? 0)}});
      if (auth === session) saveVersion = out.version;
      return out;
    } catch (error) {
      if (error.code === 'conflict' && auth === session && Number.isInteger(error.latest?.version)) saveVersion = error.latest.version;
      throw error;
    }
  }
  function leaderboard(period = 'week', limit = 10) {
    const p = period === 'all' ? 'all' : 'week';
    const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 10));
    return call('GET', `leaderboard?period=${p}&limit=${n}`);
  }
  function stats() {
    if (!auth) return Promise.reject(new ApiError('auth', MESSAGES.auth, 401));
    return call('GET', 'me/stats');
  }
  // Resolves when the API answers; rejects with ApiError otherwise (the caller then offers guest mode).
  async function health() {
    const data = await call('GET', 'health', {timeout: Math.min(timeoutMs, HEALTH_TIMEOUT_MS), token: null});
    if (data.ok !== true) { online = false; throw new ApiError('server', MESSAGES.server, 200); }
    return {ok: true};
  }
  function changePassword(oldPassword, newPassword) {
    if (!auth) return Promise.reject(new ApiError('auth', MESSAGES.auth, 401));
    return call('POST', 'me/password', {body: {oldPassword, newPassword}});
  }
  async function deleteAccount(password) {
    if (!auth) throw new ApiError('auth', MESSAGES.auth, 401);
    const session = auth;
    await call('DELETE', 'me', {body: {password}});
    for (const store of [temp, local]) {
      store.set(QUEUE_KEY, JSON.stringify(queueOf(store).filter(item => item.token !== session.token)));
    }
    forgetRecent(session.user.username);
    if (auth === session) setAuth(null);
    return {ok: true};
  }
  function recentUsers() {
    return readList(local, RECENT_KEY).filter(name => typeof name === 'string' && name).slice(0, RECENT_MAX);
  }
  function rememberName(username) {
    const list = [username, ...recentUsers().filter(name => !sameName(name, username))].slice(0, RECENT_MAX);
    local.set(RECENT_KEY, JSON.stringify(list));
  }
  function forgetRecent(username) {
    local.set(RECENT_KEY, JSON.stringify(recentUsers().filter(name => !sameName(name, username))));
  }
  function session() {
    if (auth && !(Date.parse(auth.expiresAt) > now())) setAuth(null);
    return auth;
  }

  return {
    get user() { const s = session(); return s ? {...s.user} : null; },
    get online() { return online; },
    get base() { return root; },
    health, me, logout, flush, pending,
    register: (username, password, options) => signIn('auth/register', username, password, options),
    login: (username, password, options) => signIn('auth/login', username, password, options),
    loadSave, storeSave, submitRound, leaderboard, stats,
    changePassword, deleteAccount, recentUsers, forgetRecent,
  };
}

function codeFor(status) {
  if (status === 401) return 'auth';
  if (status === 409) return 'conflict';
  if (status === 422) return 'rejected';
  if (status === 429) return 'rate';
  if (status === 400 || status === 413 || status === 415) return 'invalid';
  return 'server';
}
