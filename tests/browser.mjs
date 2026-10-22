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
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
  await page.locator('#loginCamera').click();
  await page.waitForFunction(() => document.querySelector('#loginStatus').textContent.includes('未获得摄像头权限'));
  report.push('Camera denial and retry message: passed');
  await page.locator('#demoLogin').click();
  const canvas = await page.locator('#scene').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set(); for (let i = 0; i < data.length; i += 256) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return {colors: colors.size, width: canvas.width, height: canvas.height};
  });
  assert.ok(canvas.colors > 50, JSON.stringify(canvas));
  await page.screenshot({path: 'reports/desktop-game.png', fullPage: true});
  for (let stage = 0; stage < 4; stage++) {
    for (let rep = 0; rep < 5; rep++) await page.locator('#demoMove').click();
    assert.equal(await page.locator('#toast').isVisible(), true);
    await page.waitForTimeout(2500);
  }
  assert.equal(await page.locator('#finished').isVisible(), true);
  assert.equal(await page.locator('#campName').textContent(), '简陋棚屋');
  assert.equal(await page.locator('#waterValue').textContent(), '2');
  assert.equal(await page.locator('#foodValue').textContent(), '2');
  assert.equal(await page.locator('#staminaValue').textContent(), '6');
  await page.locator('#buyWater').click();
  assert.equal(await page.locator('#waterValue').textContent(), '3');
  await page.locator('#backLogin').click();
  await page.locator('#demoLogin').click();
  assert.equal(await page.locator('#campName').textContent(), '简陋棚屋');
  assert.equal(await page.locator('#waterValue').textContent(), '3');
  report.push('All four stages, rewards, exchange, and save restore: passed');
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'reports/mobile-game.png', fullPage: true});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#backLogin').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: 'reports/mobile-login.png', fullPage: true});
  report.push('Desktop/mobile screenshots and no horizontal overflow: passed');
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
