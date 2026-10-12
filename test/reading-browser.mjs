import { chromium } from 'playwright-core';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'termai-reading-'));
const port = 3167, origin = `http://127.0.0.1:${port}`, mount = process.env.TEST_BASE_PATH || '', base = origin + mount, token = 'reading-test-token-123456789';
await writeFile(path.join(fixture, 'note.txt'), 'A quiet place to read.\nSecond line.\n');
await writeFile(path.join(fixture, 'README.md'), '# Reader heading\n\nA **formatted** paragraph.\n\n![Pixel](image.png)\n\n[Open note](note.txt)\n\n<script>window.markdownRan = true</script>\n');
await mkdir(path.join(fixture, 'docs'));
await writeFile(path.join(fixture, 'docs', 'Guide.md'), '# Nested guide\n');
await writeFile(path.join(fixture, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL+WQAAAABJRU5ErkJggg==', 'base64'));
await writeFile(path.join(fixture, 'document.pdf'), '%PDF-1.1\n%%EOF\n');
await promisify(execFile)('git', ['init', '-q', fixture]);
await writeFile(path.join(fixture, 'change.txt'), 'before\n');
await promisify(execFile)('git', ['-C', fixture, 'add', 'change.txt']);
await writeFile(path.join(fixture, 'change.txt'), 'after\n');
const server = spawn(process.execPath, ['server/index.ts'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', HOME: fixture, TERMAI_CWD: fixture, TERMAI_DATA_DIR: fixture + '/data', TERMAI_TOKEN: token, TERMAI_NO_RC: '1', TERMAI_BASE_PATH: mount }, stdio: ['ignore', 'pipe', 'pipe'] });
const serverExited = once(server, 'exit');
let logs = '', browser;
server.stdout.on('data', data => logs += data); server.stderr.on('data', data => logs += data);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function saveLegacyReading(page, retainPluginTab = false) {
  await page.evaluate(retain => {
    const tabs = JSON.parse(localStorage.getItem('termai.tabs')), active = JSON.parse(localStorage.getItem('termai.activeTab'));
    const tab = tabs.find(tab => tab.id === active);
    localStorage.setItem('termai.readingTabs', JSON.stringify([{ id: tab.id, name: tab.name, backendId: tab.backendId, session: tab.session,
      path: tab.readPath, capture: tab.readCapture, exitCode: tab.readExitCode, sourceTabId: tab.parentTabId, lastUsed: tab.lastUsed }]));
    if (!retain) localStorage.setItem('termai.tabs', JSON.stringify(tabs.filter(tab => tab.id !== active)));
  }, retainPluginTab);
}
try {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/')).ok) break; } catch {} if (server.exitCode !== null) throw new Error(logs); await delay(50); }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.type === 'state') window.__shellState = message.state; }); }
    };
  });
  await page.goto(base + '/');
  await page.locator('#backend-login').waitFor({ state: 'visible' });
  await page.locator('#backend-token').fill(token); await page.locator('#backend-login-form button[type=submit]').click();
  let frame = await (await page.locator('#terminal-stack iframe').elementHandle()).contentFrame();
  await frame.waitForFunction(() => window.__shellState?.ready);
  const prompt = await frame.evaluate(() => window.__shellState.prompt);
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('look at note.txt'); await page.keyboard.press('Enter');
  await page.locator('.reading-view .reading-text').waitFor();
  assert.equal(await page.locator('.reading-text').textContent(), 'A quiet place to read.\nSecond line.\n');
  await frame.waitForFunction(prompt => window.__shellState.ready && window.__shellState.prompt > prompt, prompt);
  assert.equal(await frame.evaluate(() => window.__shellState.exitCode), 0);
  const history = await frame.evaluate(async () => {
    const url = new URL('api/context', document.baseURI);
    url.searchParams.set('session', new URL(location.href).searchParams.get('session') || 'default');
    return (await (await fetch(url)).json()).history;
  });
  assert.deepEqual(history, [], 'Reading Mode and its setup must stay out of shell history');
  assert.equal(await page.locator('[role=tab]').count(), 2);
  assert.equal(await page.locator('[role=tab][aria-selected=true] svg circle').count(), 1);
  const reader = await page.evaluate(() => JSON.parse(localStorage.getItem('termai.tabs')).find(tab => tab.id === JSON.parse(localStorage.getItem('termai.activeTab'))));
  assert.equal(reader.pluginId, 'reading'); assert.equal(reader.pluginVersion, '1'); assert.equal(reader.ownsSession, false);
  assert.equal(await page.locator('#' + await page.locator('[role=tab][aria-selected=true]').getAttribute('aria-controls')).count(), 1);
  await saveLegacyReading(page);
  await page.reload();
  await page.locator('.reading-view .reading-text').waitFor();
  assert.equal(await page.locator('.reading-text').textContent(), 'A quiet place to read.\nSecond line.\n');
  assert.equal(await page.evaluate(() => localStorage.getItem('termai.readingTabs')), null, 'Legacy storage is cleared after migration');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('termai.tabs')).find(tab => tab.pluginId === 'reading')), reader, 'Migration preserves the selected reader and its source');
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  frame = await (await page.locator('#terminal-stack iframe:visible').elementHandle()).contentFrame();
  await frame.waitForFunction(() => window.__shellState?.ready);
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('look at README.md'); await page.keyboard.press('Enter');
  await page.locator('.reading-markdown h1').waitFor();
  assert.equal(await page.locator('.reading-markdown h1').textContent(), 'Reader heading');
  assert.equal(await page.locator('.reading-markdown strong').textContent(), 'formatted');
  assert.equal(await page.locator('.reading-header, .reading-control').count(), 0);
  assert.equal(await page.locator('.reading-markdown script').count(), 0);
  assert.equal(await page.evaluate(() => window.markdownRan), undefined);
  await page.waitForFunction(() => document.querySelector('.reading-markdown img')?.naturalWidth === 1);
  await page.locator('.reading-markdown a').click();
  await page.locator('.reading-view .reading-text').waitFor();
  assert.equal(await page.locator('.reading-text').textContent(), 'A quiet place to read.\nSecond line.\n');
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  await page.locator('#reading-phrases').fill('inspect\nlook at'); await page.locator('#save-reading-phrases').click();
  await page.locator('#nav-terminals').click();
  await frame.locator('#terminal textarea').focus();
  await frame.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'inspect image dot png', bubbles: true, cancelable: true })));
  await frame.locator('.reading-choice').filter({ hasText: 'Read image.png' }).waitFor();
  await frame.locator('.reading-choice').filter({ hasText: 'Read image.png' }).tap();
  await page.locator('.reading-view:not([hidden]) .reading-image').waitFor();
  await page.waitForFunction(() => document.querySelector('.reading-view:not([hidden]) .reading-image')?.naturalWidth === 1);
  await page.locator('[role=tab]').first().click();
  await frame.locator('#terminal textarea').focus();
  await frame.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'look at docs slash guide dot md', bubbles: true, cancelable: true })));
  await frame.locator('.reading-choice').filter({ hasText: 'Read docs/Guide.md' }).waitFor();
  await frame.locator('.reading-choice').filter({ hasText: 'Read docs/Guide.md' }).tap();
  await page.locator('.reading-view:not([hidden]) .reading-markdown h1').waitFor();
  assert.equal(await page.locator('.reading-view:not([hidden]) .reading-markdown h1').textContent(), 'Nested guide');
  await page.locator('[role=tab]').first().click();
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('look at document.pdf'); await page.keyboard.press('Enter');
  await page.locator('.reading-view .reading-pdf').waitFor();
  assert.equal(await page.locator('.reading-pdf').evaluate(el => getComputedStyle(el).position), 'static');
  // Chromium's PDF viewer can reclaim keyboard focus when later checks reload the page.
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  for (const input of ['git diff | look at', 'look at git diff']) {
    await page.locator('[role=tab]').first().click();
    await frame.waitForFunction(() => window.__shellState.ready);
    await frame.locator('#terminal textarea').focus(); await page.keyboard.type(input); await page.keyboard.press('Enter');
    await page.locator('.reading-view:not([hidden]) .reading-text').waitFor();
    const text = await page.locator('.reading-view:not([hidden]) .reading-text').textContent();
    assert.match(text, /diff --git/); assert.match(text, /-before\n\+after/);
    assert.equal(await page.locator('.reading-view:not([hidden]) .reading-header').count(), 0);
    const beforeReload = await page.locator('[role=tab]').count();
    const capture = await page.evaluate(() => JSON.parse(localStorage.getItem('termai.tabs')).find(tab => tab.id === JSON.parse(localStorage.getItem('termai.activeTab'))).readCapture);
    assert.match(capture, /^[a-f0-9]{32}$/);
    if (input === 'git diff | look at') await saveLegacyReading(page, true);
    await page.reload();
    await page.locator('.reading-view:not([hidden]) .reading-text').waitFor();
    assert.equal(await page.locator('.reading-view:not([hidden]) .reading-text').textContent(), text);
    assert.equal(await page.locator('[role=tab]').count(), beforeReload, 'Reload must not duplicate a capture');
    await page.locator('[role=tab][aria-selected=true] .tab-close').click();
    frame = await (await page.locator('#terminal-stack iframe:visible').elementHandle()).contentFrame();
    await frame.waitForFunction(() => window.__shellState.ready);
    for (let i = 0; i < 40; i++) {
      const response = await page.request.get(base + '/api/reading/capture?id=' + capture);
      if (response.status() === 404) break;
      assert.ok(i < 39, 'Closing a capture must release it'); await delay(25);
    }
  }
  for (const spoken of ['look at git dif', 'git dif pipe inspect']) {
    await frame.waitForFunction(() => window.__shellState.ready);
    await frame.locator('#terminal textarea').focus();
    await frame.locator('#terminal textarea').evaluate((el, data) => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true })), spoken);
    await frame.locator('.reading-choice').filter({ hasText: 'Read git diff' }).waitFor();
    await frame.locator('.reading-choice').filter({ hasText: 'Read git diff' }).tap();
    await page.locator('.reading-view:not([hidden]) .reading-text').waitFor();
    assert.match(await page.locator('.reading-view:not([hidden]) .reading-text').textContent(), /-before\n\+after/);
    await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  }
  await frame.waitForFunction(() => window.__shellState.ready);
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('cat image.png | look at'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.reading-view:not([hidden]) .reading-image')?.naturalWidth === 1);
  await writeFile(path.join(fixture, 'change.txt'), 'before\n');
  await page.locator('[role=tab]').first().click();
  await frame.waitForFunction(() => window.__shellState.ready);
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('look at git diff'); await page.keyboard.press('Enter');
  await page.locator('.reading-view.reading-empty:not([hidden]) .reading-hint').waitFor();
  assert.match(await page.locator('.reading-view.reading-empty:not([hidden])').textContent(), /no unstaged changes/i);
  assert.equal(await page.locator('.reading-view.reading-empty:not([hidden])').evaluate(el => getComputedStyle(el).flexDirection), 'column');
  await page.reload();
  await page.locator('.reading-view.reading-empty:not([hidden]) .reading-hint').waitFor();
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  frame = await (await page.locator('#terminal-stack iframe:visible').elementHandle()).contentFrame();
  await frame.waitForFunction(() => window.__shellState.ready);
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('look at ls /definitely/not/present'); await page.keyboard.press('Enter');
  await page.locator('.reading-view.reading-empty:not([hidden])').waitFor();
  assert.match(await page.locator('.reading-view.reading-empty:not([hidden])').textContent(), /Exited with status 2.*Check the terminal for errors/s);
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  let finishRead, startedRead;
  const readingStarted = new Promise(resolve => startedRead = resolve);
  await page.route('**/api/reading/file?**', route => {
    startedRead(); return new Promise(resolve => finishRead = async () => { await route.fulfill({ contentType: 'text/plain', body: 'Late reader content' }).catch(() => {}); resolve(); });
  });
  await frame.waitForFunction(() => window.__shellState.ready);
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('look at note.txt'); await page.keyboard.press('Enter');
  await readingStarted;
  await page.getByText('Opening file…', { exact: true }).waitFor();
  const pendingReader = await page.locator('[role=tab][aria-selected=true]').getAttribute('aria-controls');
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  await finishRead(); await page.unroute('**/api/reading/file?**');
  assert.equal(await page.locator('#' + pendingReader).count(), 0, 'Closing a pending reader disposes its plugin view');
  assert.equal(await page.getByText('Late reader content', { exact: true }).count(), 0);
  await frame.waitForFunction(() => window.__shellState.ready);
  await page.close();
  const standalone = await context.newPage();
  standalone.on('pageerror', error => errors.push(String(error)));
  await standalone.goto(base + '/terminal.html');
  await standalone.waitForFunction(() => document.querySelector('#shell-status')?.textContent === 'At prompt');
  await standalone.locator('#terminal textarea').focus();
  await standalone.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'look at note.txt', bubbles: true, cancelable: true })));
  await standalone.locator('.reading-choice').waitFor();
  await standalone.locator('.reading-choice').tap();
  await standalone.waitForURL(base + '/');
  await standalone.locator('.reading-view:not([hidden]) .reading-text').waitFor();
  assert.equal(await standalone.locator('.reading-view:not([hidden]) .reading-text').textContent(), 'A quiet place to read.\nSecond line.\n');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Reading Mode browser checks passed');
} finally {
  await browser?.close(); server.kill('SIGTERM'); await serverExited; await rm(fixture, { recursive: true, force: true });
}
