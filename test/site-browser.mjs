import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { freePort, launchBrowser, until } from './support/browser.mjs';

const root = new URL('../', import.meta.url).pathname;
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--config', 'site/vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
server.stdout.on('data', chunk => logs.push(String(chunk)));
server.stderr.on('data', chunk => logs.push(String(chunk)));
let browser;
try {
  await until(async () => {
    if (server.exitCode !== null) throw new Error(logs.join(''));
    try { return (await fetch(origin)).ok; } catch { return false; }
  }, 'site preview');
  browser = await launchBrowser();
  await mkdir(root + '.test-artifacts/site', { recursive: true });
  for (const width of [320, 390, 760, 1280]) {
    const mobile = width <= 760;
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    await context.route('https://fonts.googleapis.com/**', route => route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    assert.equal(await page.locator('html').evaluate(el => el.classList.contains('in-app')), false);
    for (const selector of ['#features-title', '#steps-title', '#platforms-title', '#docs-title', 'footer']) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} is accessible at ${width}px`);
      assert.equal(await page.locator('html').evaluate(el => el.classList.contains('in-app')), false, 'Reading does not enter the demo');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal page overflow at ${width}px`);
    await page.goto(origin + '/#platforms');
    await page.locator('#platforms-title').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#platforms').evaluate(el => Math.abs(el.getBoundingClientRect().top) < 2), 'Section deep links land on the content');
    await page.goto(origin);
    if (mobile) await page.waitForFunction(() => document.querySelector('#demo').getBoundingClientRect().top >= innerHeight);
    await page.screenshot({ path: root + `.test-artifacts/site/landing-${width}.png` });
    if (mobile) {
      await page.locator('#cue').click();
      await page.waitForFunction(() => document.documentElement.classList.contains('in-app'));
      assert.equal(new URL(page.url()).hash, '#demo');
      assert.equal(await page.locator('#app').evaluate(el => el.inert), false);
      assert.equal(await page.locator('#app').getAttribute('src'), 'app.html');
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
      await page.goBack();
      await page.waitForFunction(() => !document.documentElement.classList.contains('in-app'));
      assert.equal(await page.locator('#app').evaluate(el => el.inert), true);
      assert.equal(await page.locator('#features-title').isVisible(), true);
      await page.goto(origin + '/#demo');
      await page.waitForFunction(() => document.documentElement.classList.contains('in-app'));
    }
    assert.deepEqual(errors, [], `No browser errors at ${width}px`);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(origin);
  assert.equal(await page.locator('#platforms-title').isVisible(), true, 'Product content is available without JavaScript');
  assert.equal(await page.locator('#docs-title').isVisible(), true, 'Documentation is available without JavaScript');
  await context.close();
  console.log('PASS: Mobile and desktop product content, section links, swipe demo, Back and static HTML.');
} finally {
  await browser?.close();
  server.kill();
}
