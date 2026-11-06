import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

const root = new URL('../', import.meta.url).pathname;
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port;
    probe.close(() => resolve(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const server = spawn('python3', ['start.py', '--host', '127.0.0.1', '--port', String(port), '--no-browser'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
let serverOutput = '', serverError = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverError += chunk; });
let browser;

function installMocks({force2d = false} = {}) {
  window.__perfCamera = {requests: 0, stopped: false};
  Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
    async enumerateDevices() { return [{kind: 'videoinput', deviceId: 'smoke-camera', label: 'Smoke camera'}]; },
    async getUserMedia() {
      window.__perfCamera.requests++;
      const source = document.createElement('canvas');
      source.width = 640; source.height = 480;
      const ctx = source.getContext('2d');
      let shade = 0;
      const paint = () => { shade = (shade + 1) % 30; ctx.fillStyle = `rgb(20, ${90 + shade}, 82)`; ctx.fillRect(0, 0, 640, 480); };
      paint();
      const timer = setInterval(paint, 80);
      const stream = source.captureStream(15);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { window.__perfCamera.stopped = true; clearInterval(timer); stop(); };
      }
      return stream;
    },
    addEventListener() {},
    removeEventListener() {},
  }});
  class FakeWorker {
    constructor() { this.terminated = false; }
    postMessage(message) {
      if (message.type === 'init') queueMicrotask(() => { if (!this.terminated) this.onmessage?.({data: {type: 'ready'}}); });
      if (message.type === 'frame') {
        message.frame?.close?.();
        queueMicrotask(() => { if (!this.terminated) this.onmessage?.({data: {type: 'pose', landmarks: [], worldLandmarks: [], latency: 4, timestamp: performance.now()}}); });
      }
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(window, 'Worker', {configurable: true, value: FakeWorker});
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attributes, ...args) {
    if (type === 'webgl2') {
      if (force2d) return null;
      return original.call(this, type, {...attributes, preserveDrawingBuffer: true}, ...args);
    }
    return original.call(this, type, attributes, ...args);
  };
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(`Local server exited (${server.exitCode}): ${serverError}`);
    if (serverOutput.includes(`MoveCraft: http://localhost:${port}`)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not start: ${serverError}`);
}
async function runAllTiers(page) {
  await page.locator('#startButton').click();
  await page.waitForFunction(() => document.body.dataset.state === 'done', {timeout: 15000});
  const report = await page.evaluate(() => window.__perfReport);
  assert.equal(report.test.secondsPerTier, 0.5);
  assert.deepEqual(report.tiers.map(tier => tier.tier), ['low', 'medium', 'high']);
  for (const tier of report.tiers) {
    assert.ok(tier.averageFps > 0, `${tier.tier} FPS should be sampled`);
    assert.ok(tier.p50FrameMs > 0, `${tier.tier} p50 should be sampled`);
    assert.ok(tier.p95FrameMs >= tier.p50FrameMs, `${tier.tier} p95 should be >= p50`);
  }
  assert.ok(report.environment.browser.userAgent.length > 0);
  assert.ok(report.environment.browser.name.length > 0);
  assert.ok(report.environment.screen.width > 0);
  assert.ok(report.environment.gpu.renderer.length > 0);
  return report;
}
async function sampleScenePixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#world');
    const gl = canvas.getContext('webgl2');
    const colors = new Set();
    if (gl) {
      gl.finish();
      const pixel = new Uint8Array(4);
      for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
        gl.readPixels(Math.floor(canvas.width * (x + .5) / 16), Math.floor(canvas.height * (y + .5) / 12), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        colors.add(`${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]}`);
      }
      return {mode: 'webgl', colors: colors.size, width: canvas.width, height: canvas.height};
    }
    const fallback = document.querySelector('#world2d');
    const ctx = fallback.getContext('2d', {willReadFrequently: true});
    const image = ctx.getImageData(0, 0, fallback.width, fallback.height).data;
    for (let i = 0; i < image.length; i += 4 * 320) colors.add(`${image[i]},${image[i + 1]},${image[i + 2]}`);
    return {mode: '2d', colors: colors.size, width: fallback.width, height: fallback.height};
  });
}

try {
  await waitForServer();
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader']});
  const errors = [];
  const context = await browser.newContext({viewport: {width: 1365, height: 900}});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin});
  await context.addInitScript(installMocks);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto(`${origin}/perf-lab.html?smoke=1`);
  await page.waitForFunction(() => ['WebGL 3D', '2D 回退'].includes(document.querySelector('#modeBadge')?.textContent), {timeout: 15000});
  assert.equal(await page.locator('input[value="render"]').isChecked(), true);
  assert.equal(await page.locator('#cameraField').isVisible(), false);
  assert.equal(await page.locator('#copyButton').isDisabled(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.waitForTimeout(200);
  const desktopPixels = await sampleScenePixels(page);
  assert.ok(desktopPixels.width > 0 && desktopPixels.height > 0 && desktopPixels.colors > 4, JSON.stringify(desktopPixels));
  await page.screenshot({path: '/tmp/movecraft-perf-lab-desktop.png'});

  const renderReport = await runAllTiers(page);
  assert.equal(renderReport.test.mode, 'render-only');
  assert.equal(renderReport.camera.status, 'not-tested-no-camera');
  assert.equal(await page.evaluate(() => window.__perfCamera.requests), 0, 'render-only mode must not request camera access');
  assert.ok((await page.locator('#lowPose').textContent()).includes('无摄像头'));
  await page.locator('#copyButton').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /"schema": "movecraft-perf-v2"/);
  assert.match(copied, /"medium"/);

  await page.locator('input[value="camera"]').check();
  assert.equal(await page.locator('#cameraField').isVisible(), true);
  await page.locator('#startButton').click();
  await page.waitForFunction(() => document.body.dataset.state === 'done', {timeout: 15000});
  const cameraReport = await page.evaluate(() => window.__perfReport);
  assert.equal(cameraReport.test.mode, 'camera+render');
  assert.equal(cameraReport.camera.enabled, true);
  assert.ok(cameraReport.camera.resolution?.width > 0);
  assert.equal(await page.evaluate(() => window.__perfCamera.requests), 1);
  assert.equal(await page.evaluate(() => window.__perfCamera.stopped), true);

  await page.setViewportSize({width: 390, height: 844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.waitForTimeout(200);
  const mobilePixels = await sampleScenePixels(page);
  assert.ok(mobilePixels.width > 0 && mobilePixels.height > 0 && mobilePixels.colors > 4, JSON.stringify(mobilePixels));
  await page.screenshot({path: '/tmp/movecraft-perf-lab-mobile.png', fullPage: true});
  await context.close();

  const fallbackContext = await browser.newContext({viewport: {width: 1280, height: 800}});
  await fallbackContext.addInitScript(installMocks, {force2d: true});
  const fallbackPage = await fallbackContext.newPage();
  fallbackPage.on('pageerror', error => errors.push(error.stack || error.message));
  await fallbackPage.goto(`${origin}/perf-lab.html?smoke=1`);
  await fallbackPage.waitForFunction(() => document.querySelector('#modeBadge')?.textContent === '2D 回退', {timeout: 15000});
  const fallbackReport = await runAllTiers(fallbackPage);
  assert.equal(fallbackReport.render.mode, '2d');
  assert.equal(fallbackReport.render.sampling, '2d-canvas-pixel-change');
  assert.ok(fallbackReport.tiers.every(tier => tier.averageFps > 0 && tier.p50FrameMs > 0));
  const fallbackPixels = await sampleScenePixels(fallbackPage);
  assert.ok(fallbackPixels.colors > 4, JSON.stringify(fallbackPixels));
  await fallbackPage.screenshot({path: '/tmp/movecraft-perf-lab-2d.png'});
  await fallbackContext.close();

  assert.deepEqual(errors, [], 'browser errors or failed requests');
  console.log(`Perf lab smoke passed: no-camera and camera modes; 3 tiers with FPS/p50/p95; browser/UA/GPU/screen report; 2D fallback sampling; desktop/mobile layout; canvas pixels ${desktopPixels.colors}/${mobilePixels.colors}/${fallbackPixels.colors}.`);
} finally {
  await browser?.close();
  server.kill();
}
