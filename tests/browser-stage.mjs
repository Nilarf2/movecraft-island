import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';

const port = Number(process.env.STAGE_TEST_PORT || 18810);
const origin = `http://localhost:${port}`;
const server = spawn('python3', ['start.py', '--port', String(port), '--no-browser'], {stdio: 'ignore'});
let browser;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${origin}/stage.html`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`stage server did not start on ${port}`);
}

async function openStage({demo = true, disable3d = false} = {}) {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}, reducedMotion: 'reduce'});
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const query = new URLSearchParams();
  if (demo) query.set('demo', '');
  if (disable3d) query.set('3d', '0');
  await page.goto(`${origin}/stage.html?${query}`);
  await page.waitForFunction(() => window.__stageBooted === true);
  await page.waitForFunction(() => ['error', 'running', 'unavailable'].includes(window.__stage.camera), undefined, {timeout: 15000});
  return {context, page, pageErrors};
}

async function startGuestDemo(page) {
  await page.keyboard.press('x');
  await page.waitForFunction(() => window.__stage.phase === 'login');
  await page.locator('#loginRoot [data-action="guest"]').click();
  await page.waitForFunction(() => window.__stage.phase === 'ready');
  await page.keyboard.press('m');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__stage.phase === 'play');
}

async function finishStage(page, stage) {
  await page.waitForFunction(expected => window.__stage.stage === expected
    && document.querySelector('#countNow')?.textContent === '0', stage, {timeout: 20000});
  for (let rep = 0; rep < 10; rep++) await page.keyboard.press('Space');
  assert.equal(await page.locator('#countNow').textContent(), '10', `stage ${stage} did not count ten reps`);
  if (stage < 3) {
    await page.waitForFunction(() => document.querySelector('#countNow')?.textContent === '0', undefined, {timeout: 20000});
  } else {
    await page.waitForFunction(() => window.__stage.phase === 'settlement', undefined, {timeout: 20000});
  }
}

try {
  await waitForServer();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  const {context, page, pageErrors} = await openStage();
  const modules = await page.evaluate(() => window.__stage.modules);
  for (const name of ['three', 'island', 'avatar', 'sfx', 'poseStream', 'quality', 'api', 'account', 'board', 'settlement']) {
    assert.ok(modules[name], `stage module ${name} did not load: ${JSON.stringify(modules)}`);
  }
  assert.equal(await page.evaluate(() => window.__stage.render), '3d');
  assert.equal(await page.evaluate(() => window.__stage.camera), 'error');
  await startGuestDemo(page);
  for (let stage = 0; stage < 4; stage++) await finishStage(page, stage);
  assert.equal(await page.locator('#s-settlement').isVisible(), true);
  for (const count of await page.locator('.mcui-move .mcui-count > span').allTextContents()) assert.equal(count, '10');
  assert.equal(await page.locator('.mcui-total .mcui-count > span').textContent(), '40');
  assert.equal(await page.locator('.mcui-total .mcui-kcal > span').textContent(), '10.5');
  assert.equal(await page.locator('.mcui-kcal small').first().textContent(), '千卡');
  assert.match(await page.locator('[data-ui="rank"]').innerText(), /已击败全国98% 的人/);
  assert.match(await page.locator('#settleRoot').innerText(), /键鼠试玩/);
  await page.screenshot({path: 'reports/stage/settlement.png', fullPage: true});
  await page.waitForTimeout(1600);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__stage.phase === 'attract');
  assert.deepEqual(pageErrors, []);
  await context.close();

  const fallback = await openStage({disable3d: true});
  assert.equal(await fallback.page.evaluate(() => window.__stage.render), '2d');
  assert.match(await fallback.page.evaluate(() => window.__stage.renderError), /没有加载/);
  await fallback.page.keyboard.press('x');
  await fallback.page.waitForFunction(() => window.__stage.phase === 'login');
  assert.deepEqual(fallback.pageErrors, []);
  await fallback.context.close();

  console.log('PASS stage loads real modules, renders 3D, and handles camera denial');
  console.log('PASS guest keyboard round completes four stages, settles honestly, and returns to attract');
  console.log('PASS explicit 2D fallback still opens the real login flow');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
