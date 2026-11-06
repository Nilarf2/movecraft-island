import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ApiError, createApi, defaultBase} from '../web/net/api.js';

const BASE = 'https://pose.example.org/island/api/v1/';
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  dump() { return [...this.map.values()].join('\n'); }
}
// route(method, path, body, headers) returns [status, json] or throws to simulate a network failure.
function fakeFetch(route) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/island/api/v1/', '') + new URL(url).search;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method, path, body, headers: init.headers});
    const [status, json] = await route(init.method, path, body, init.headers);
    return new Response(json === undefined ? null : JSON.stringify(json), {status, headers: {'Content-Type': 'application/json'}});
  };
  return {fetch, calls};
}
const session = (user = 'Lin', id = 7) => ({token: 'tok-' + user, expiresAt: new Date(Date.now() + 3600e3).toISOString(), user: {id, username: user}});
function setup(route) {
  const storage = new MemoryStorage(), sessionStorage = new MemoryStorage(), f = fakeFetch(route);
  return {storage, sessionStorage, calls: f.calls, api: createApi({base: BASE, storage, sessionStorage, fetch: f.fetch})};
}
const offline = () => { throw new TypeError('fetch failed'); };

test('base comes from the meta tag or the page path, never from URL parameters', () => {
  const page = {href: 'https://pose.example.org/island/stage.html?api=https://evil.example/&base=https://evil.example/'};
  const noMeta = {querySelector: () => null};
  assert.equal(defaultBase(noMeta, page), BASE);
  const meta = content => ({querySelector: () => ({getAttribute: () => content})});
  assert.equal(defaultBase(meta('http://127.0.0.1:8787/api/v1'), page), 'http://127.0.0.1:8787/api/v1/');
  assert.throws(() => defaultBase(meta('javascript:alert(1)'), page));
});

test('remember picks localStorage, otherwise sessionStorage; passwords are never stored', async () => {
  for (const remember of [false, true]) {
    const {api, storage, sessionStorage, calls} = setup(() => [200, session()]);
    const result = await api.login('Lin', 'pw-secret-1', {remember});
    assert.deepEqual(result.user, {id: 7, username: 'Lin'});
    assert.equal(calls[0].body.remember, remember);
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(storage.dump().includes('tok-Lin'), remember);
    assert.equal(sessionStorage.dump().includes('tok-Lin'), !remember);
    assert.ok(!storage.dump().includes('pw-secret-1') && !sessionStorage.dump().includes('pw-secret-1'));
    const again = createApi({base: BASE, storage, sessionStorage, fetch: offline});
    assert.equal(again.user.username, 'Lin');
  }
});

test('a 401 or an expired session signs the player out', async () => {
  const {api, storage} = setup((method, path) => path === 'auth/login' ? [200, session()] : [401, {error: {code: 'auth', message: '登录已过期，请重新登录'}}]);
  await api.login('Lin', 'secret1', {remember: true});
  await assert.rejects(api.loadSave(), error => error instanceof ApiError && error.code === 'auth' && error.status === 401);
  assert.equal(api.user, null);
  assert.equal(storage.dump().includes('tok-Lin'), false);
  const old = {...session(), expiresAt: new Date(Date.now() - 1000).toISOString()};
  storage.setItem('movecraft.api.session', JSON.stringify(old));
  assert.equal(createApi({base: BASE, storage, sessionStorage: new MemoryStorage(), fetch: offline}).user, null);
});

test('error codes and Chinese messages', async () => {
  const replies = {
    'auth/login': [401, {error: {code: 'credentials', message: '用户名或密码不对'}}],
    'auth/register': [409, {error: {code: 'taken', message: '这个用户名已经有人用了'}}],
  };
  const {api} = setup((method, path) => replies[path] || [429, {error: {code: 'locked', message: '账号已锁定', retryAfter: 900}}]);
  await assert.rejects(api.login('Lin', 'x'), {code: 'credentials', status: 401, message: '用户名或密码不对'});
  await assert.rejects(api.register('Lin', 'secret1'), {code: 'taken', status: 409});
  await assert.rejects(api.health(), {code: 'locked', retryAfter: 900});
  const {api: down} = setup(offline);
  await assert.rejects(down.health(), error => error.code === 'network' && /连不上/.test(error.message));
  assert.equal(down.online, false);
  const {api: proxy} = setup(() => [502, undefined]);
  await assert.rejects(proxy.health(), error => error.code === 'server' && error.message.length > 0);
});
test('recent users: at most five, newest first, case-insensitive, forgettable', async () => {
  const {api} = setup((method, path, body) => [200, {...session(body.username), user: {id: 1, username: body.username}}]);
  for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'A3']) await api.login(name, 'secret1');
  assert.deepEqual(api.recentUsers(), ['A3', 'a6', 'a5', 'a4', 'a2']);
  api.forgetRecent('a6');
  assert.deepEqual(api.recentUsers(), ['A3', 'a5', 'a4', 'a2']);
});

test('save conflict carries latest and the next save builds on it', async () => {
  let server = {version: 3, data: {hp: 50}};
  const {api, calls} = setup((method, path, body) => {
    if (path === 'auth/login') return [200, session()];
    if (body.version !== server.version) return [409, {error: {code: 'conflict', message: '存档已在别处更新', latest: server}}];
    server = {version: server.version + 1, data: body.data};
    return [200, {version: server.version}];
  });
  await api.login('Lin', 'secret1');
  await assert.rejects(api.storeSave({hp: 90}), error => error.code === 'conflict' && error.latest.version === 3 && error.latest.data.hp === 50);
  assert.deepEqual(await api.storeSave({hp: 90}), {version: 4});
  assert.equal(calls.at(-1).body.version, 3);
});

test('submitRound queues on network failure and flush sends it once with the original token', async () => {
  let up = false;
  const seen = [];
  const {api} = setup((method, path, body, headers) => {
    if (path === 'auth/login') return [200, session(body.username, body.username === 'Lin' ? 7 : 8)];
    if (path === 'auth/logout') return [200, {ok: true}];
    if (!up) throw new TypeError('fetch failed');
    seen.push({roundId: body.roundId, auth: headers.Authorization});
    return [201, {accepted: true, weekTotal: 40, weekRank: 1, weekPercentile: null}];
  });
  await api.login('Lin', 'secret1');
  const result = await api.submitRound({counts: [10, 10, 10, 10], durationSec: 120, mode: 'camera', finishedAt: new Date()});
  assert.deepEqual(result, {queued: true});
  assert.equal(api.pending(), 1);
  await api.logout();
  await api.login('Bo', 'secret1');   // the next player on the same screen
  await api.flush();                  // the background retry after login, still offline
  assert.equal(api.pending(), 1);
  up = true;
  assert.equal((await api.flush()).sent, 1);
  assert.equal(api.pending(), 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, 'Bearer tok-Lin');
  assert.match(seen[0].roundId, /^[0-9a-f-]{36}$/);
  assert.equal((await api.flush()).sent, 0);
});

test('rejected rounds are not queued; a rejected queued round is dropped', async () => {
  const {api} = setup((method, path) => path === 'auth/login' ? [200, session()]
    : [422, {error: {code: 'rejected', message: '只有摄像头模式的成绩计入排行'}}]);
  await api.login('Lin', 'secret1');
  await assert.rejects(api.submitRound({counts: [1, 1, 1, 1], durationSec: 9, mode: 'keyboard'}), {code: 'rejected'});
  assert.equal(api.pending(), 0);
  let up = false;
  const {api: late} = setup((method, path) => path === 'auth/login' ? [200, session()]
    : up ? [422, {error: {code: 'rejected', message: '完成时间和服务器时间相差太多'}}] : offline());
  await late.login('Lin', 'secret1');
  await late.flush();
  assert.deepEqual(await late.submitRound({counts: [1, 1, 1, 1], durationSec: 9, mode: 'camera'}), {queued: true});
  up = true;
  assert.deepEqual(await late.flush(), {sent: 0, dropped: 1, pending: 0});
});

test('logout clears the player at once, even offline', async () => {
  const {api, sessionStorage} = setup((method, path) => path === 'auth/login' ? [200, session()] : offline());
  await api.login('Lin', 'secret1');
  const done = api.logout();
  assert.equal(api.user, null);
  assert.equal(sessionStorage.dump().includes('tok-Lin'), false);
  assert.deepEqual(await done, {ok: true});
});

test('against the real Python server', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'movecraft-api-'));
  const env = {...process.env, DB_PATH: join(dir, 'db.sqlite3'), PORT: '0', SCRYPT_N: '16', HOST: '127.0.0.1'};
  let child;
  try { child = spawn('python3', ['-m', 'server.serve'], {cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'ignore']}); }
  catch { t.skip('python3 not available'); return; }
  t.after(() => { child.kill(); rmSync(dir, {recursive: true, force: true}); });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.on('error', reject);
    child.stdout.on('data', chunk => { out += chunk; const m = out.match(/:(\d+)\/api\/v1\//); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('server did not start')), 8000).unref();
  });
  const make = () => createApi({base: `http://127.0.0.1:${port}/api/v1/`, storage: new MemoryStorage(), sessionStorage: new MemoryStorage()});
  const api = make();
  assert.deepEqual(await api.health(), {ok: true});
  const {user} = await api.register('测试同学', 'secret1');
  assert.equal(user.username, '测试同学');
  assert.equal((await api.me()).username, '测试同学');
  assert.deepEqual(await api.loadSave(), {data: null, version: 0, updatedAt: null});
  assert.equal((await api.storeSave({hp: 100})).version, 1);
  const other = make();
  await other.login('测试同学', 'secret1');
  await other.loadSave();
  await other.storeSave({hp: 80});
  await assert.rejects(api.storeSave({hp: 90}), error => error.code === 'conflict' && error.latest.data.hp === 80);
  const round = await api.submitRound({counts: [10, 10, 10, 10], durationSec: 150, mode: 'camera', finishedAt: Date.now()});
  assert.deepEqual([round.accepted, round.weekTotal, round.weekRank, round.weekPercentile], [true, 40, 1, null]);
  await assert.rejects(api.submitRound({counts: [10, 10, 10, 10], durationSec: 150, mode: 'keyboard'}), {code: 'rejected', status: 422});
  const board = await api.leaderboard('week', 10);
  assert.deepEqual(board.entries.map(e => [e.rank, e.username, e.total]), [[1, '测试同学', 40]]);
  assert.equal(board.me.rank, 1);
  assert.equal((await api.stats()).week.total, 40);
  await assert.rejects(api.changePassword('wrong-pw', 'newpass1'), {code: 'credentials', status: 403});
  await api.changePassword('secret1', 'newpass1');
  assert.equal(await other.me(), null);   // other sessions were revoked
  await api.logout();
  await assert.rejects(api.login('测试同学', 'secret1'), {code: 'credentials'});
  await api.login('测试同学', 'newpass1');
  await api.deleteAccount('newpass1');
  assert.equal(api.user, null);
  await assert.rejects(api.login('测试同学', 'newpass1'), {code: 'credentials'});
});
