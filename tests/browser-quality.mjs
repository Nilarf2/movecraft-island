import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {fresh} from '../web/core.js';
import {LOGIN_CONFIRM} from '../web/narration.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = 18788;
const origin = `http://127.0.0.1:${port}`;
const server = spawn('python3', ['start.py', '--host', '127.0.0.1', '--port', String(port), '--no-browser'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
let serverOutput = '', serverError = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverError += chunk; });
const failures = [];
const results = [];
let browser;

function makeSave(date, overrides = {}) {
  const save = fresh(date);
  Object.assign(save, overrides);
  return JSON.stringify(save);
}

function installBrowserMocks({camera = 'denied', seed = null, voiceEnabled = true} = {}) {
  if (location.protocol !== 'http:') return;
  window.__spoken = [];
  Object.defineProperty(window, 'Audio', {configurable: true, value: undefined});
  window.__camera = {mode: camera, requests: 0, streams: [], workers: [], pending: null, stops: 0};
  class FakeUtterance { constructor(text) { this.text = text; } }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {configurable: true, value: FakeUtterance});
  Object.defineProperty(window, 'speechSynthesis', {configurable: true, value: {
    active: null,
    speak(utterance) {
      const entry = {text: utterance.text, utterance, finish: utterance.onend};
      window.__spoken.push(entry);
      this.active = entry;
      queueMicrotask(() => utterance.onstart?.());
    },
    finish() {
      const entry = this.active;
      this.active = null;
      entry?.utterance.onend?.();
    },
    finishStale(index) { window.__spoken[index]?.finish?.(); },
    cancel() { this.active = null; },
    getVoices() { return [{lang: 'zh-CN'}]; },
  }});
  const cameraState = window.__camera;
  function newStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const context = canvas.getContext('2d');
    const paint = () => { context.fillStyle = '#6a9'; context.fillRect(0, 0, 640, 480); };
    paint();
    const stream = canvas.captureStream(15);
    cameraState.streams.push(stream);
    for (const track of stream.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => { if (track.readyState !== 'ended') cameraState.stops++; stop(); };
    }
    return stream;
  }
  Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
    async enumerateDevices() { return []; },
    async getUserMedia() {
      cameraState.requests++;
      if (cameraState.mode === 'denied') throw new DOMException('Denied by test', 'NotAllowedError');
      if (cameraState.mode === 'delayed') return await new Promise(resolve => { cameraState.pending = () => resolve(newStream()); });
      return newStream();
    },
    addEventListener() {},
  }});
  class FakeWorker {
    constructor() { this.terminated = false; cameraState.workers.push(this); }
    postMessage(message) {
      if (message.type === 'init') {
        const ready = () => { if (!this.terminated) this.onmessage?.({data: {type: 'ready'}}); };
        if (cameraState.mode === 'worker-delayed') cameraState.releaseWorker = ready;
        else queueMicrotask(ready);
      } else if (message.type === 'frame') {
        message.frame?.close?.();
        if (cameraState.mode === 'live') queueMicrotask(() => {
          if (!this.terminated) this.onmessage?.({data: {type: 'pose', landmarks: [], timestamp: performance.now(), latency: 1}});
        });
      }
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(window, 'Worker', {configurable: true, value: FakeWorker});
  if (seed && !localStorage.getItem('movecraft.island.v1.demo')) localStorage.setItem('movecraft.island.v1.demo', seed);
  if (voiceEnabled === false) localStorage.setItem('movecraft.island.v1.voice', 'false');
}

async function fixture(options = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, timezoneId: 'Asia/Shanghai'});
  const errors = [], external = [];
  await context.route('**/*', route => {
    if (route.request().url().startsWith(origin)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(installBrowserMocks, options);
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.stack || error.message));
    page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  await page.clock.setFixedTime(new Date(options.date || '2026-11-02T12:00:00+08:00'));
  await page.goto(origin);
  await page.waitForFunction(() => window.__spoken.length > 0 || !document.querySelector('#voiceEnabled').checked);
  return {context, page, errors, external};
}

async function enterDemo(page) {
  if (await page.locator('#rulesPage').isVisible()) {
    const speechCount = await page.evaluate(() => window.__spoken.length);
    if (speechCount) await page.evaluate(() => window.speechSynthesis.finish());
    await page.locator('#loginPage').waitFor({state: 'visible'});
  }
  await page.locator('#demoLogin').click();
  await page.locator('#gamePage').waitFor({state: 'visible'});
}

async function finishSpeech(page) { await page.evaluate(() => window.speechSynthesis.finish()); }
async function spoken(page) { return page.evaluate(() => window.__spoken.map(entry => entry.text)); }

async function scenario(name, options, test) {
  let f;
  try {
    f = await fixture(options);
    await test(f);
    assert.deepEqual(f.errors, [], 'uncaught browser page errors');
    assert.deepEqual(f.external, [], 'browser attempted a request outside the local test server');
    results.push(`PASS ${name}`);
  } catch (error) {
    failures.push(`FAIL ${name}\n${error.stack || error}`);
  } finally {
    await f?.context.close();
  }
}

try {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`Local server exited early (${server.exitCode}): ${serverError}`);
    if (serverOutput.includes(`MoveCraft: http://localhost:${port}`)) break;
    await delay(100);
  }
  if (!serverOutput.includes(`MoveCraft: http://localhost:${port}`)) throw new Error(`Local server failed to start: ${serverError}`);
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check']});

  await scenario('voice preference survives refresh; stale rules completion cannot navigate while muted', {}, async ({page}) => {
    await page.locator('#voiceEnabled').uncheck();
    await page.evaluate(() => window.speechSynthesis.finishStale(0));
    assert.equal(await page.locator('#rulesPage').isVisible(), true, 'cancelled rules completion must not enter login');
    await page.reload();
    assert.equal(await page.locator('#voiceEnabled').isChecked(), false);
    assert.equal(await page.locator('#voiceStatus').textContent(), '语音朗读已关闭');
    assert.equal(await page.locator('#rulesPage').isVisible(), true);
    assert.deepEqual(await spoken(page), [], 'muted reload must not enqueue rules narration');
  });

  await scenario('settlement narration celebrates the round without duplicate punctuation', {seed: makeSave('2026-11-02', {stage: 4, counts: [10, 10, 10, 10], rounds: 1, moves: 40, shelter: 1, stamina: 26})}, async ({page}) => {
    await finishSpeech(page);
    await page.locator('#loginPage').waitFor({state: 'visible'});
    await page.locator('#demoLogin').click();
    await page.locator('#settlementPage').waitFor({state: 'visible'});
    const line = (await spoken(page)).at(-1);
    for (const phrase of ['键鼠试玩结算，不计入真实运动。', '竖直跳、开合跳、手臂平举和深蹲各做了十个，一共消耗三十五卡。', '你击败了全国百分之九十八的人！', '热量和排名都是游戏换算的鼓励，不是真实测量。', '明天岛上见']) {
      assert.ok(line.includes(phrase), `settlement narration should include: ${phrase}`);
    }
    assert.doesNotMatch(line, /[。！？.!?]{2}/, 'sentence boundaries must not repeat punctuation');
  });

  await scenario('equal counts read half calories in one recorded sentence', {
    date: '2026-11-04T12:00:00+08:00',
    seed: makeSave('2026-11-04', {started: '2026-11-02', stage: 4, counts: [11, 11, 11, 11], rounds: 1, moves: 44, shelter: 1, stamina: 30}),
  }, async ({page}) => {
    await finishSpeech(page);
    await page.locator('#loginPage').waitFor({state: 'visible'});
    await page.locator('#demoLogin').click();
    const line = (await spoken(page)).at(-1);
    assert.ok(line.includes('各做了十一个，一共消耗三十八点五卡。'));
    assert.ok(line.includes('百分之九十八'));
  });

  await scenario('uneven legacy counts point to the on-screen table and keep the rank', {
    date: '2026-11-04T12:00:00+08:00',
    seed: makeSave('2026-11-04', {started: '2026-11-02', stage: 4, counts: [10, 10, 11, 10], rounds: 1, moves: 41, shelter: 1, stamina: 27}),
  }, async ({page}) => {
    await finishSpeech(page);
    await page.locator('#loginPage').waitFor({state: 'visible'});
    await page.locator('#demoLogin').click();
    const line = (await spoken(page)).at(-1);
    assert.ok(line.includes('每项的次数和热量都在屏幕上。'));
    assert.ok(line.includes('你击败了全国百分之九十八的人！'));
    assert.ok((await page.locator('#settlementRows p').allTextContents()).includes('完成 11 个手臂平举，消耗 5.5 卡'));
    assert.equal(await page.locator('#settlementTotal').textContent(), '共消耗 35.5 卡');
  });

  await scenario('two reps each use the classifier form 两个', {
    seed: makeSave('2026-11-02', {stage: 4, counts: [2, 2, 2, 2], rounds: 1, moves: 8, shelter: 1, stamina: 8}),
  }, async ({page}) => {
    await finishSpeech(page);
    await page.locator('#loginPage').waitFor({state: 'visible'});
    await page.locator('#demoLogin').click();
    const line = (await spoken(page)).at(-1);
    assert.ok(line.includes('各做了两个，一共消耗七卡。'));
    assert.ok(line.includes('百分之九十五'));
  });

  const quickCountSave = makeSave('2026-11-02', {stamina: 12});
  await scenario('rapid rep narration coalesces to the latest count and transition waits for it', {seed: quickCountSave}, async ({page}) => {
    await enterDemo(page);
    for (let i = 0; i < 4; i++) await page.locator('#demoMove').click();
    const isCount = line => /^[一二三四五六七八九十]+！/.test(line);
    let lines = await spoken(page);
    assert.equal(lines.filter(isCount).length, 0, 'counts must wait for the activity instructions');
    await finishSpeech(page);
    lines = await spoken(page);
    assert.ok(lines.some(line => line === '四！'), 'queued count should collapse to latest');
    for (let i = 0; i < 6; i++) await page.locator('#demoMove').click();
    await finishSpeech(page);
    lines = await spoken(page);
    assert.ok(lines.some(line => line.startsWith('十！椰子摘够了')), 'final count announces the reward');
    assert.equal(lines.filter(isCount).length, 2, 'only active and latest count should be spoken');
    await delay(3800);
    assert.equal(await page.locator('#toast').isVisible(), true, 'stage change must wait while latest count is still speaking');
    assert.equal((await spoken(page)).filter(line => /砍树.*十个开合跳/.test(line)).length, 0);
    await finishSpeech(page);
    await page.locator('#toast').waitFor({state: 'hidden'});
    assert.match(await page.locator('#taskTitle').textContent(), /砍树.*开合跳/);
    lines = await spoken(page);
    assert.match(lines.at(-1), /砍树.*十个开合跳/);
  });

  await scenario('help dialog holds a ready stage transition until it closes', {seed: makeSave('2026-11-02', {stamina: 12, counts: [9, 0, 0, 0]})}, async ({page}) => {
    await enterDemo(page);
    await finishSpeech(page);
    await page.locator('#demoMove').click();
    await page.locator('#help').click();
    await finishSpeech(page);
    await delay(3800);
    assert.equal(await page.locator('#helpDialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#toast').isVisible(), true, 'ready transition must remain pending behind help');
    await page.locator('#helpDialog button[aria-label="关闭规则"]').click();
    await page.locator('#toast').waitFor({state: 'hidden'});
    assert.match(await page.locator('#taskTitle').textContent(), /砍树.*开合跳/);
  });

  await scenario('exchange after midnight applies overnight shortage damage before purchase', {date: '2026-11-02T23:59:59+08:00', seed: makeSave('2026-11-02', {stamina: 10})}, async ({page}) => {
    await enterDemo(page);
    await page.clock.setFixedTime(new Date('2026-11-03T00:00:01+08:00'));
    await page.locator('#buyWater').click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('movecraft.island.v1.demo')));
    assert.equal(saved.settled, '2026-11-03');
    assert.equal(saved.hp, 78, 'one day without water and food costs 22 health');
    assert.equal(saved.water, 1, 'water purchase occurs after daily settlement');
    assert.equal(saved.food, 0);
    assert.equal(saved.stamina, 5);
  });

  await scenario('closing help after midnight settles the day before showing a pending transition', {date: '2026-11-02T23:59:59+08:00', seed: makeSave('2026-11-02', {stamina: 12, counts: [9, 0, 0, 0]})}, async ({page}) => {
    await enterDemo(page);
    await finishSpeech(page);
    await page.locator('#demoMove').click();
    await page.locator('#help').click();
    await delay(3800);
    await page.clock.setFixedTime(new Date('2026-11-03T00:00:01+08:00'));
    await page.locator('#helpDialog button[aria-label="关闭规则"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('movecraft.island.v1.demo')).settled === '2026-11-03');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('movecraft.island.v1.demo')));
    assert.equal(saved.settled, '2026-11-03');
    assert.equal(saved.stage, 0);
    assert.equal(saved.hp, 88, 'water earned before midnight is consumed before shortage damage');
    assert.match(await page.locator('#taskTitle').textContent(), /摘椰子.*竖直跳/);
    assert.equal(await page.locator('#toast').isVisible(), false);
  });

  await scenario('a stale reset confirmation cannot overwrite another tab', {seed: makeSave('2026-11-02', {stamina: 12})}, async ({context, page}) => {
    await enterDemo(page);
    await page.locator('#newIsland').click();
    const second = await context.newPage();
    await second.goto(origin);
    const updated = await second.evaluate(() => {
      const key = 'movecraft.island.v1.demo';
      const value = JSON.parse(localStorage.getItem(key));
      value.moves = 123;
      localStorage.setItem(key, JSON.stringify(value));
      return localStorage.getItem(key);
    });
    await page.locator('#storageWarning').waitFor({state: 'visible'});
    await page.locator('#confirmDialog button[value="confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#storageWarning').textContent.includes('本次操作已取消'));
    assert.match(await page.locator('#storageWarning').textContent(), /本次操作已取消/);
    assert.equal(await page.evaluate(() => localStorage.getItem('movecraft.island.v1.demo')), updated);
  });

  await scenario('clock rollback while confirming import preserves the existing save', {date: '2026-11-02T12:00:00+08:00', seed: makeSave('2026-11-02', {stamina: 12})}, async ({page}) => {
    await enterDemo(page);
    const before = await page.evaluate(() => localStorage.getItem('movecraft.island.v1.demo'));
    await page.locator('#saveFile').setInputFiles({name: 'save.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({format: 'movecraft-island', mode: 'demo', island: fresh('2026-11-02')}))});
    await page.locator('#confirmDialog').waitFor({state: 'visible'});
    await page.clock.setFixedTime(new Date('2026-11-01T12:00:00+08:00'));
    await page.locator('#confirmDialog button[value="confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#storageWarning').textContent.includes('无法导入'));
    assert.equal(await page.evaluate(() => localStorage.getItem('movecraft.island.v1.demo')), before);
  });

  await scenario('a later successful save clears the earlier storage failure', {seed: makeSave('2026-11-02', {stamina: 12})}, async ({page}) => {
    await enterDemo(page);
    await page.evaluate(() => {
      window.__setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function() { throw new DOMException('Storage full', 'QuotaExceededError'); };
    });
    await page.locator('#demoMove').click();
    assert.match(await page.locator('#storageWarning').textContent(), /未能保存/);
    await page.evaluate(() => { Storage.prototype.setItem = window.__setItem; });
    await page.locator('#demoMove').click();
    assert.equal(await page.locator('#storageWarning').isVisible(), false);
    assert.match(await page.locator('#saveStatus').textContent(), /已自动保存/);
  });

  await scenario('large resource values fit within the narrow mobile card', {seed: makeSave('2026-11-02', {stamina: 1000000, water: 1000000, food: 1000000, wood: 1000000})}, async ({page}) => {
    await page.setViewportSize({width: 320, height: 844});
    await enterDemo(page);
    const bounds = await page.locator('.vitals').evaluate(element => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll('strong')].map(value => {
        const range = document.createRange(); range.selectNodeContents(value);
        return [...range.getClientRects()].map(rect => ({left: rect.left, right: rect.right, boxLeft: box.left, boxRight: box.right}));
      }).flat();
    });
    assert.ok(bounds.length >= 5);
    for (const rect of bounds) assert.ok(rect.left >= rect.boxLeft && rect.right <= rect.boxRight, 'resource text must not be clipped by the card');
  });

  await scenario('cross-tab save update and localStorage.clear both stop writes', {seed: makeSave('2026-11-02', {stamina: 12})}, async ({context, page}) => {
    await enterDemo(page);
    const second = await context.newPage();
    second.setDefaultTimeout(7000);
    await second.goto(origin);
    await second.evaluate(() => {
      const key = 'movecraft.island.v1.demo';
      const value = JSON.parse(localStorage.getItem(key));
      value.moves += 1;
      localStorage.setItem(key, JSON.stringify(value));
    });
    await page.locator('#storageWarning').waitFor({state: 'visible'});
    assert.match(await page.locator('#storageWarning').textContent(), /另一个标签页更新/);
    assert.equal(await page.locator('#demoMove').isDisabled(), true);
    assert.equal(await page.locator('#buyWater').isDisabled(), true);

    const third = await context.newPage();
    third.setDefaultTimeout(7000);
    await third.goto(origin);
    await enterDemo(third);
    await second.evaluate(() => localStorage.clear());
    await third.locator('#storageWarning').waitFor({state: 'visible'});
    assert.match(await third.locator('#storageWarning').textContent(), /另一个标签页更新/);
    assert.equal(await third.locator('#demoMove').isDisabled(), true);
  });

  await scenario('camera reaches ready, announces login gesture, and stops on inference watchdog', {camera: 'silent'}, async ({page}) => {
    const speechCount = await page.evaluate(() => window.__spoken.length);
    await page.evaluate(() => window.speechSynthesis.finish());
    await page.locator('#loginPage').waitFor({state: 'visible'});
    await page.waitForFunction(() => document.querySelector('#cameraBadge').classList.contains('live'));
    assert.ok((await spoken(page)).slice(speechCount).some(line => line.includes(LOGIN_CONFIRM)));
    await page.locator('#loginStatus').waitFor({state: 'visible'});
    await page.waitForFunction(() => document.querySelector('#loginStatus').textContent.includes('识别暂时没有响应'), undefined, {timeout: 7000});
    assert.equal(await page.locator('#cameraBadge').textContent(), '已暂停');
    assert.equal(await page.evaluate(() => window.__camera.workers.length), 1);
    assert.ok(await page.evaluate(() => window.__camera.stops >= 1), 'watchdog must release camera tracks');
  });

  await scenario('late camera permission result is stopped after switching to demo mode', {camera: 'delayed'}, async ({page}) => {
    await page.evaluate(() => window.speechSynthesis.finish());
    await page.locator('#loginPage').waitFor({state: 'visible'});
    await page.waitForFunction(() => window.__camera.requests === 1);
    await page.locator('#demoLogin').click();
    assert.equal(await page.locator('#modeNotice').isVisible(), true);
    await page.evaluate(() => window.__camera.pending());
    await page.waitForFunction(() => window.__camera.stops >= 1);
    assert.equal(await page.locator('#modeNotice').isVisible(), true, 'late camera result must not replace the demo session');
    assert.equal(await page.evaluate(() => window.__camera.workers.length), 0, 'stale stream must be stopped before worker startup');
  });

  await scenario('camera finishing initialization behind help waits to announce login', {camera: 'worker-delayed'}, async ({page}) => {
    await finishSpeech(page);
    await page.locator('#loginPage').waitFor({state: 'visible'});
    await page.waitForFunction(() => typeof window.__camera.releaseWorker === 'function');
    await page.locator('#help').click();
    const before = (await spoken(page)).length;
    await page.evaluate(() => window.__camera.releaseWorker());
    await page.waitForFunction(() => document.querySelector('#cameraBadge').classList.contains('live'));
    assert.equal((await spoken(page)).length, before, 'login announcement must not interrupt an open help dialog');
    await page.locator('#helpDialog button[aria-label="关闭规则"]').click();
    await page.waitForFunction(text => window.__spoken.at(-1)?.text.includes(text), LOGIN_CONFIRM);
    assert.equal((await spoken(page)).at(-1), LOGIN_CONFIRM);
  });

} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(1500)]);
  }
}

console.log([...results, ...failures].join('\n\n'));
if (failures.length) process.exitCode = 1;
