import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { herdrFixture } from './herdr-fixture.ts';

const fixture = await herdrFixture(), root = new URL('../', import.meta.url).pathname;
const origin = 'http://127.0.0.1:' + (process.env.TEST_PORT || '3178'), base = origin + '/reconnect-test/';
const token = 'reconnect-test-pairing-token';
const server = spawn(process.env.TEST_BACKEND !== 'node' ? root + 'target/debug/termai' : process.execPath, process.env.TEST_BACKEND !== 'node' ? [] : ['server/index.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: new URL(origin).port,
  TERMAI_BASE_PATH: '/reconnect-test', TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_TOKEN: token,
  TERMAI_DATA_DIR: fixture.directory + '/termai', TERMAI_NO_RC: '1', TERMAI_CWD: fixture.directory,
  HOME: fixture.directory, PATH: fixture.directory + ':' + process.env.PATH, HERDR_SOCKET_PATH: fixture.socketPath,
} });
const exited = once(server, 'exit');
let logs = '', browser;
server.stdout.on('data', data => logs += data); server.stderr.on('data', data => logs += data);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (const end = Date.now() + 12000; Date.now() < end;) { if (await check()) return; await delay(30); }
  throw new Error('Backend did not start: ' + logs);
}
try {
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await context.addInitScript(() => {
    window.__sockets = []; window.__states = 0; window.__sent = []; window.__lateCloses = [];
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args); window.__sockets.push(this);
        this.addEventListener('message', event => { if (JSON.parse(event.data).type === 'state') window.__states++; });
      }
      set onclose(handler) {
        this.addEventListener('close', event => {
          if (window.__holdCloses) window.__lateCloses.push(() => handler(event)); else handler(event);
        });
      }
      send(data) { if (typeof data === 'string') window.__sent.push(JSON.parse(data)); return super.send(data); }
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(base + 'terminal.html');
  await page.locator('#token').fill(token); await page.locator('#login-form button').click();
  const connected = async (states, timeout = 12000) => {
    await page.waitForFunction(states => window.__states > states && document.querySelector('#connection-label').textContent === 'Connected', states, { timeout });
    assert.equal(await page.locator('#reconnect-banner').isVisible(), false);
  };
  await connected(0);
  const stateCount = () => page.evaluate(() => window.__states);
  const foreground = async () => page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const background = async () => page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const online = async () => page.evaluate(() => window.dispatchEvent(new Event('online')));

  // Recover before a closing socket delivers its close event to the app.
  let states = await stateCount();
  await page.evaluate(() => {
    window.__holdCloses = true;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
  });
  await connected(states);
  await page.evaluate(() => { window.__holdCloses = false; for (const close of window.__lateCloses.splice(0)) close(); });
  assert.equal(await page.locator('#connection-label').textContent(), 'Connected');

  // An online event must replace an existing OPEN socket, without replaying input.
  states = await stateCount();
  await page.locator('#terminal textarea').focus(); await page.keyboard.type('echo reconnect-once');
  const inputs = await page.evaluate(() => window.__sent.filter(message => message.type === 'input').length);
  await online(); await connected(states);
  assert.equal(await page.evaluate(() => window.__sent.filter(message => message.type === 'input').length), inputs);
  await page.keyboard.press('Control+c');

  async function stallNext(path) {
    let seen, release, held = false, aborted = false;
    const entered = new Promise(resolve => seen = resolve), unblock = new Promise(resolve => release = resolve);
    const matcher = url => url.pathname.endsWith(path);
    const handler = async route => {
      if (held) { await route.continue(); return; }
      held = true; seen(); await unblock;
      try { await route.continue(); } catch { /* The client already canceled this request. */ }
    };
    const failed = request => { if (new URL(request.url()).pathname.endsWith(path)) aborted = true; };
    page.on('requestfailed', failed); await page.route(matcher, handler);
    return { entered, aborted: () => aborted, done: async () => { release(); await page.unroute(matcher, handler); page.off('requestfailed', failed); } };
  }

  // A request stranded by backgrounding cannot block the next foreground attempt.
  let stalled = await stallNext('/api/connect'); states = await stateCount();
  await online(); await stalled.entered; await background(); await foreground(); await connected(states);
  await page.waitForFunction(() => window.__sockets.filter(socket => socket.readyState === WebSocket.OPEN).length === 1);
  assert.equal(stalled.aborted(), true, 'backgrounding aborts authorization'); await stalled.done();

  // Even without a visibility/network event, the deadline drives another attempt.
  stalled = await stallNext('/api/connect'); states = await stateCount();
  await online(); await stalled.entered; await connected(states, 22000);
  assert.equal(stalled.aborted(), true, 'the connection deadline aborts authorization'); await stalled.done();

  // Herdr also bounds/cancels the ticket request after authorization succeeds.
  await page.goto(base + 'terminal.html?herdrTerminal=term_0'); await connected(0);
  stalled = await stallNext('/api/herdr/ticket'); states = await stateCount();
  await online(); await stalled.entered; await background(); await foreground(); await connected(states);
  assert.equal(stalled.aborted(), true, 'backgrounding aborts Herdr ticket acquisition'); await stalled.done();
  stalled = await stallNext('/api/herdr/ticket'); states = await stateCount();
  await online(); await stalled.entered; await connected(states, 22000);
  assert.equal(stalled.aborted(), true, 'the connection deadline aborts Herdr ticket acquisition'); await stalled.done();
  assert.deepEqual(errors, []);
  console.log('PASS reconnect browser: closing sockets, stale OPEN sockets, no input replay, canceled authorization/tickets, and deadline recovery for shell and Herdr');
} finally {
  await browser?.close(); server.kill('SIGTERM'); await exited; await fixture.close();
}
