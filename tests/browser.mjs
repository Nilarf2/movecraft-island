import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const port = 18787, origin = `http://localhost:${port}`;
const server = spawn('python3', ['start.py', '--port', String(port), '--no-browser'], {stdio: 'ignore'});
const failures = [], report = [];
await mkdir('reports', {recursive: true});
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(origin)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  await context.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {configurable: true, value: null});
    window.__cameraRequests = [];
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__cameraRequests.push(constraints);
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  page.on('requestfailed', request => failures.push(request.url() + ': ' + request.failure()?.errorText));
  await page.goto(origin);
  assert.equal(await page.locator('#enterIsland').isDisabled(), true);
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#enterIsland').isDisabled(), true);
  await page.screenshot({path: 'reports/desktop-rules.png'});
  await page.locator('#enterIsland').waitFor({state: 'visible'});
  await page.waitForFunction(() => !document.querySelector('#enterIsland').disabled);
  report.push('10-second rule countdown: passed');
  await page.locator('#enterIsland').click();
  await page.waitForFunction(() => document.querySelector('#loginStatus').textContent.includes('未获得摄像头权限'));
  assert.equal(await page.evaluate(() => window.__cameraRequests.length), 1);
  const defaultCamera = await page.evaluate(() => window.__cameraRequests[0]);
  assert.equal(defaultCamera.audio, false);
  assert.equal(defaultCamera.video.facingMode, 'user');
  assert.equal(defaultCamera.video.deviceId, undefined);
  await page.locator('#loginCamera').click();
  await page.waitForFunction(() => window.__cameraRequests.length === 2);
  assert.match(await page.locator('#loginStatus').textContent(), /未获得摄像头权限/);
  report.push('Login automatically requests the default camera, handles denial, and retries: passed');
  await page.locator('#demoLogin').click();
  const canvas = await page.locator('#scene').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set(); for (let i = 0; i < data.length; i += 256) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return {colors: colors.size, width: canvas.width, height: canvas.height};
  });
  assert.ok(canvas.colors > 50, JSON.stringify(canvas));
  await page.screenshot({path: 'reports/desktop-game.png', fullPage: true});
  for (let stage = 0; stage < 4; stage++) {
    assert.equal(await page.locator('#targetValue').textContent(), ' / 10');
    for (let rep = 0; rep < 10; rep++) await page.locator('#demoMove').click();
    assert.equal(await page.locator('#toast').isVisible(), true);
    await page.locator('#toast').waitFor({state: 'hidden', timeout: 10000});
  }
  await page.locator('#settlementPage').waitFor({state: 'visible'});
  assert.deepEqual(await page.locator('#settlementRows p').allTextContents(), [
    '完成 10 个竖直跳，消耗 10 卡', '完成 10 个开合跳，消耗 10 卡',
    '完成 10 个手臂平举，消耗 5 卡', '完成 10 个深蹲，消耗 10 卡',
  ]);
  assert.equal(await page.locator('#settlementTotal').textContent(), '共消耗 35 卡');
  assert.match(await page.locator('#settlementRank').textContent(), /已击败全国 9\d% 的人/);
  assert.match(await page.locator('#settlementNote').textContent(), /非真实全国排名/);
  assert.match(await page.locator('#settlementMode').textContent(), /键鼠试玩.*非实际运动记录/);
  assert.ok((await page.locator('#settlementEncouragement').textContent()).length > 15);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: 'reports/desktop-settlement.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: 'reports/mobile-settlement.png', fullPage: true});
  await page.setViewportSize({width: 1440, height: 1000});
  await page.locator('#settlementCamp').click();
  assert.equal(await page.locator('#finished').isVisible(), true);
  assert.equal(await page.locator('#campName').textContent(), '简陋棚屋');
  assert.equal(await page.locator('#waterValue').textContent(), '2');
  assert.equal(await page.locator('#foodValue').textContent(), '2');
  assert.equal(await page.locator('#staminaValue').textContent(), '26');
  await page.locator('#buyWater').click();
  assert.equal(await page.locator('#waterValue').textContent(), '3');
  assert.equal(await page.locator('#staminaValue').textContent(), '21');
  await page.locator('#backLogin').click();
  await page.locator('#demoLogin').click();
  assert.equal(await page.locator('#settlementPage').isVisible(), true);
  assert.equal(await page.locator('#settlementTotal').textContent(), '共消耗 35 卡');
  await page.locator('#settlementNext').click();
  assert.equal(await page.locator('#gamePage').isVisible(), true);
  assert.equal(await page.locator('#repValue').textContent(), '0');
  assert.match(await page.locator('#taskTitle').textContent(), /竖直跳/);
  assert.deepEqual(await page.evaluate(() => {
    const save = JSON.parse(localStorage.getItem('movecraft.island.v1.demo'));
    return {stage: save.stage, counts: save.counts};
  }), {stage: 0, counts: [0, 0, 0, 0]});
  assert.equal(await page.locator('#campName').textContent(), '简陋棚屋');
  assert.equal(await page.locator('#waterValue').textContent(), '3');
  report.push('Four 10-rep stages, 35-calorie settlement, rewards, exchange, save restore, and next round: passed');
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'reports/mobile-game.png', fullPage: true});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#backLogin').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: 'reports/mobile-login.png', fullPage: true});
  report.push('Desktop/mobile game, login, and settlement screenshots with no horizontal overflow: passed');

  const voiceContext = await browser.newContext({viewport: {width: 1440, height: 1000}});
  await voiceContext.addInitScript(() => {
    window.__spoken = [];
    window.__cameraRequests = [];
    class FakeUtterance { constructor(text) { this.text = text; } }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {configurable: true, value: FakeUtterance});
    Object.defineProperty(window, 'speechSynthesis', {configurable: true, value: {
      speak(utterance) {
        window.__spoken.push(utterance.text);
        window.__finishSpeech = () => utterance.onend?.();
        queueMicrotask(() => utterance.onstart?.());
      },
      cancel() {}, getVoices() { return [{lang: 'zh-CN'}]; },
    }});
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__cameraRequests.push(constraints);
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  const voicePage = await voiceContext.newPage();
  voicePage.on('pageerror', error => failures.push(error.message));
  await voicePage.goto(origin);
  await voicePage.waitForFunction(() => window.__spoken.length === 1);
  assert.equal(await voicePage.locator('#rulesPage').isVisible(), true);
  assert.equal(await voicePage.locator('#enterIsland').isDisabled(), true);
  assert.match(await voicePage.evaluate(() => window.__spoken[0]), /竖直跳.*开合跳.*手臂平举.*深蹲.*每项从十次开始，每两天增加一次，最多二十五次/);
  await voicePage.evaluate(() => window.__finishSpeech());
  await voicePage.locator('#loginPage').waitFor({state: 'visible'});
  await voicePage.waitForFunction(() => window.__cameraRequests.length === 1);
  assert.equal(await voicePage.locator('#rulesPage').isVisible(), false);
  assert.equal(await voicePage.evaluate(() => window.__cameraRequests[0].video.facingMode), 'user');
  report.push('Rule narration completion automatically enters login and requests the default camera: passed');
  await voicePage.evaluate(async () => {
    const {fresh} = await import('/core.js');
    const save = {...fresh(), stage: 4, counts: [10, 10, 10, 10], rounds: 1, moves: 40, shelter: 1, stamina: 26};
    localStorage.setItem('movecraft.island.v1.demo', JSON.stringify(save));
  });
  await voicePage.locator('#demoLogin').click();
  const spokenSettlement = await voicePage.evaluate(() => window.__spoken.at(-1));
  for (const line of ['完成十个竖直跳，消耗十卡。', '完成十个开合跳，消耗十卡。', '完成十个手臂平举，消耗五卡。', '完成十个深蹲，消耗十卡。', '共消耗三十五卡。', '非真实全国排名', '明天继续加油']) {
    assert.ok(spokenSettlement.includes(line), line);
  }
  await voicePage.locator('#settlementNext').click();
  assert.match(await voicePage.evaluate(() => window.__spoken.at(-1)), /摘椰子.*十个竖直跳.*双脚起跳/);
  await voicePage.evaluate(() => window.__finishSpeech());
  await voicePage.locator('#demoMove').click();
  assert.match(await voicePage.evaluate(() => window.__spoken.at(-1)), /已完成竖直跳一个.*做得好/);
  report.push('Settlement speaks every result and encouragement; stages and rep counts speak instructions and praise: passed');
  await voiceContext.close();
  const workerResult = await page.evaluate(async () => {
    const worker = new Worker('/pose-worker.js', {type: 'module'});
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker load timeout')), 60000);
        worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
        worker.onmessage = async ({data}) => {
          if (data.type === 'ready') {
            const canvas = new OffscreenCanvas(640, 480); canvas.getContext('2d').fillRect(0, 0, 640, 480);
            const frame = canvas.transferToImageBitmap(); worker.postMessage({type: 'frame', frame, timestamp: performance.now()}, [frame]);
          } else if (data.type === 'pose') { clearTimeout(timeout); resolve({type: data.type, landmarks: data.landmarks.length, latency: data.latency}); }
          else if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); }
        };
        worker.postMessage({type: 'init'});
      });
    } finally { worker.terminate(); }
  });
  assert.equal(workerResult.type, 'pose');
  report.push(`Local MediaPipe worker loads and infers blank frame: passed (${Math.round(workerResult.latency)} ms)`);
  assert.deepEqual(failures, []);
  console.log(report.join('\n'));
} finally {
  await browser?.close();
  server.kill();
}
