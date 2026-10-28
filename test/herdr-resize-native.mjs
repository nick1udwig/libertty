import { launchBrowser, freePort, delay, until as wait } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import { installBackgroundGrace } from './support/background-grace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pty from 'node-pty';
import { herdrRequest, herdrSnapshot } from './support/herdr.ts';
import { shellQuote } from '../src/shell-words.ts';
import { GZIP_FAST_PROTOCOL } from '../src/wire.ts';

const fixturePort3172 = await freePort();

// A real Herdr desktop and responsive PTY app, in an entirely disposable HOME.
const root = new URL('../', import.meta.url).pathname, dir = await mkdtemp('/tmp/libertty-herdr-resize-');
const target = { session: '', socketPath: dir + '/herdr.sock' };
const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir + '/config', XDG_DATA_HOME: dir + '/data', XDG_STATE_HOME: dir + '/state', HERDR_SOCKET_PATH: target.socketPath, HERDR_SESSION: '', HERDR_ENV: '', SHELL: '/bin/bash', TERM: 'xterm-256color' };
const geometry = async () => { try { return JSON.parse(await readFile(dir + '/geometry.json', 'utf8')); } catch { return {}; } };
let herdr, desktop, backend, browser;
try {
  await mkdir(dir + '/config', { recursive: true });
  await writeFile(dir + '/responsive.mjs', `
    import { writeFileSync } from 'node:fs';
    const draw = () => { const cols = process.stdout.columns, rows = process.stdout.rows;
      writeFileSync(${JSON.stringify(dir + '/geometry.json')}, JSON.stringify({ cols, rows }));
      process.stdout.write('\\x1b[2J\\x1b[HResponsive terminal\\r\\n' + '╭' + '─'.repeat(cols - 2) + '╮\\r\\n│ › type here' + ' '.repeat(Math.max(0, cols - 14)) + '│\\r\\n' + '╰' + '─'.repeat(cols - 2) + '╯\\r\\n' + cols + ' columns × ' + rows + ' rows\\x1b[3;5H\\x1b[?25h'); };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', data => { if (data.includes(3)) process.exit(); writeFileSync(${JSON.stringify(dir + '/input.txt')}, data); });
    draw(); process.on('SIGWINCH', () => setImmediate(draw)); setInterval(() => {}, 10000);
  `);
  herdr = spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', ['server'], { cwd: dir, env, stdio: 'ignore' });
  await wait(async () => { try { await herdrSnapshot(target); return true; } catch { return false; } }, 'isolated Herdr server');
  desktop = pty.spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', [], { cwd: dir, env, cols: 150, rows: 45, name: 'xterm-256color' });
  desktop.onData(() => {});
  const created = await herdrRequest(target, 'workspace.create', { cwd: dir, label: 'Resize fixture', focus: true });
  const snapshot = await herdrSnapshot(target), terminal = snapshot.terminals.find(t => t.workspaceId === created.workspace.workspace_id);
  assert.ok(terminal);
  await delay(400);
  await herdrRequest(target, 'pane.send_text', { pane_id: terminal.paneId, text: [process.execPath, dir + '/responsive.mjs'].map(shellQuote).join(' ') + '\r' });
  await wait(async () => (await geometry()).cols > 80, 'desktop application geometry');
  const original = await geometry();
  const base = 'http://127.0.0.1:' + fixturePort3172;
  backend = spawn(new URL('../target/debug/libertty', import.meta.url).pathname, [], { cwd: root, env: { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(fixturePort3172), LIBERTTY_BASE_PATH: '/', LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_ALLOWED_ORIGINS: base, LIBERTTY_DATA_DIR: dir + '/libertty', LIBERTTY_TOKEN: '', LIBERTTY_NO_RC: '1', LIBERTTY_CWD: dir }, stdio: 'ignore' });
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'isolated libertty backend');
  const token = (await readFile(dir + '/libertty/pairing-token', 'utf8')).trim();
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  if (!process.env.TEST_WIRE) await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { effectiveType: '4g', downlink: 10 } }));
  await installBackgroundGrace(context);
  await context.route(/\/assets\/terminal-[A-Za-z0-9_-]{8}\.js$/, async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__terminal=new $1({ghostty:');
    assert.notEqual(body, source); await route.fulfill({ response, body });
  });
  await installWireObserver(context);
  await context.addInitScript(() => {
    window.__resizes = []; window.__frames = []; window.__layoutPaints = []; const Original = WebSocket;
    const observe = () => {
      const t = window.__terminal;
      if (t && window.__layoutPaints.length < 300) {
        const buffer = t.buffer.active, top = buffer.viewportY;
        const title = buffer.getLine(top)?.translateToString(true), border = buffer.getLine(top+1)?.translateToString(true);
        if (title?.startsWith('Responsive terminal')) window.__layoutPaints.push({ time: performance.now(), cols:t.cols, rows:t.rows, title, border, visible: getComputedStyle(document.querySelector('#terminal-viewport')).visibility !== 'hidden' });
      }
      requestAnimationFrame(observe);
    }; requestAnimationFrame(observe);
    window.WebSocket = class extends Original { constructor(...args) { super(...args); this.addEventListener('message', async event => { const m = await window.__wireMessage(event.data, this); if (m.type === 'herdr-frame') window.__frames.push({ width: m.width, height: m.height }); }); } send(data) { try { const m = window.__wireSent(data); if (m.type === 'resize') window.__resizes.push(m); } catch {} return super.send(data); } };
  });
  const errors = [];
  const phone = await context.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(base + '/terminal.html?herdrTerminal=' + terminal.terminalId + '&backend=' + encodeURIComponent(base + '/'));
  await phone.locator('#login-form').waitFor({ state: 'visible' }); await phone.locator('#token').fill(token); await phone.locator('#login-form button[type=submit]').click();
  await phone.waitForFunction(() => window.__terminal && document.querySelector('#connection-label').textContent === 'Connected');
  if (!process.env.TEST_WIRE) assert.equal(await phone.evaluate(() => window.__testShellSocket.protocol), GZIP_FAST_PROTOCOL, 'Real native Herdr covers the default wire protocol');
  await wait(async () => { const actual = await geometry(), wanted = await phone.evaluate(() => ({ cols: window.__terminal.cols, rows: window.__terminal.rows })); return actual.cols < original.cols && JSON.stringify(actual) === JSON.stringify(wanted); }, 'real PTY sized to mobile');
  const mobile = await geometry();
  assert.ok(mobile.cols < original.cols);
  await phone.waitForFunction(() => { const t = window.__terminal; return t.buffer.active.getLine(1)?.translateToString(true) === '╭' + '─'.repeat(t.cols - 2) + '╮' && t.buffer.active.cursorX === 4 && t.buffer.active.cursorY === 2; });
  const firstFrames = await phone.evaluate(() => window.__frames.filter(f => f.width));
  assert.deepEqual(firstFrames[0], { width:mobile.cols, height:mobile.rows }, 'First native frame must already have the requested mobile geometry');
  const paints = await phone.evaluate(() => window.__layoutPaints);
  await writeFile(root + '.test-artifacts/herdr-initial-layout-paints.json', JSON.stringify({ original, mobile, firstFrames, paints }, null, 2));
  assert.deepEqual(paints.filter(p => p.visible && p.border !== '╭' + '─'.repeat(p.cols - 2) + '╮'), [], 'Every visible mobile paint must already contain the resized native layout');
  await mkdir(root + '.test-artifacts', { recursive: true }); await phone.screenshot({ path: root + '.test-artifacts/herdr-resize-mobile.png' });
  const webDesktop = await context.newPage(); await webDesktop.setViewportSize({ width: 1200, height: 800 });
  await webDesktop.goto(phone.url()); await webDesktop.waitForFunction(() => window.__terminal && document.querySelector('#connection-label').textContent === 'Connected');
  await delay(150); assert.deepEqual(await geometry(), mobile, 'Desktop observer cannot override the mobile PTY');
  const tablet = await context.newPage(); await tablet.setViewportSize({ width: 720, height: 900 }); await tablet.goto(phone.url());
  await wait(async () => { const actual = await geometry(), wanted = await tablet.evaluate(() => ({ cols: window.__terminal?.cols, rows: window.__terminal?.rows })); return actual.cols > mobile.cols && JSON.stringify(actual) === JSON.stringify(wanted); }, 'second mobile viewer shares control');
  await tablet.close(); await wait(async () => JSON.stringify(await geometry()) === JSON.stringify(mobile), 'remaining phone keeps control');
  await phone.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await delay(200); assert.deepEqual(await geometry(), mobile, 'Short backgrounding retains mobile geometry');
  await phone.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await phone.locator('.terminal-presentation').isVisible(), false, 'Returning during grace does not freeze or reload the picture');
  await phone.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); window.__expireBackground(); });
  await wait(async () => JSON.stringify(await geometry()) === JSON.stringify(original), 'backgrounding releases native geometry');
  await phone.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await wait(async () => JSON.stringify(await geometry()) === JSON.stringify(mobile), 'foreground reconnect reacquires mobile geometry');
  await phone.bringToFront();
  await phone.locator('#terminal-viewport.awaiting-herdr-layout').waitFor({state:'detached'});
  const input = phone.locator('#terminal textarea');
  await input.evaluate(element => { window.__inputBlurs=0; element.addEventListener('blur',()=>window.__inputBlurs++); });
  const canvas = await phone.locator('#terminal canvas').boundingBox();
  await phone.touchscreen.tap(canvas.x+canvas.width*.5,canvas.y+canvas.height*.3);
  assert.equal(await input.evaluate(element => element===document.activeElement && !element.readOnly),true,'A real Herdr pane accepts tapped input');
  await phone.setViewportSize({width:390,height:460});
  await wait(async () => { const actual=await geometry(), wanted=await phone.evaluate(() => ({cols:window.__terminal.cols,rows:window.__terminal.rows})); return actual.rows<mobile.rows && JSON.stringify(actual)===JSON.stringify(wanted); },'keyboard opening resizes the real PTY');
  await phone.locator('#terminal-viewport.awaiting-herdr-layout').waitFor({state:'detached'});
  assert.equal(await phone.evaluate(() => window.__inputBlurs),0,'The real Herdr redraw must keep the keyboard input focused');
  assert.equal(await input.evaluate(element => element===document.activeElement && !element.readOnly),true,'Keyboard-sized Herdr remains editable');
  await phone.keyboard.type('k');
  await wait(async () => await readFile(dir+'/input.txt','utf8').catch(()=>undefined)==='k','typed input reaches the real Herdr application after keyboard resize');
  await phone.bringToFront(); await phone.setViewportSize({ width: 360, height: 500 });
  await wait(async () => { const size = await geometry(); return size.cols < mobile.cols && size.rows < mobile.rows; }, 'keyboard/screen size updates native PTY');
  const resized = await phone.evaluate(() => ({ cols: window.__terminal.cols, rows: window.__terminal.rows })); assert.deepEqual(await geometry(), resized);
  await phone.close(); await wait(async () => JSON.stringify(await geometry()) === JSON.stringify(original), 'desktop geometry restored after mobile disconnect');
  assert.deepEqual(errors, []);
  console.log('PASS: real Herdr desktop PTY ' + original.cols + '×' + original.rows + ' adapts to mobile ' + mobile.cols + '×' + mobile.rows + ', redraws its native border/cursor, shares multiple mobile viewers, updates for the keyboard, and restores on background/disconnect.');
} catch (error) {
  console.error('Resize fixture geometry:', await geometry());
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) console.error('Browser resize state:', await page.evaluate(() => ({ cols: window.__terminal?.cols, rows: window.__terminal?.rows, coarse: matchMedia('(pointer: coarse)').matches, notice: document.querySelector('#toast')?.textContent, resizes: window.__resizes?.slice(-5), frames: window.__frames?.slice(-5), connection: document.querySelector('#connection-label')?.textContent } )).catch(() => ({})));
  throw error;
} finally {
  await browser?.close();
  if (backend) { const exited = once(backend, 'exit'); backend.kill(); await exited; }
  const stopped = herdr && herdr.exitCode === null && herdr.signalCode === null ? once(herdr, 'exit') : null;
  desktop?.kill(); await herdrRequest(target, 'server.stop').catch(() => {}); herdr?.kill(); await stopped;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
