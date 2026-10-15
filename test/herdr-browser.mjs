import { launchBrowser, freePort, startBackend, delay, until } from './support/browser.mjs';
import { showTerminalTabs } from './support/workspace-navigation.mjs';
import { installWireObserver } from './wire-observer.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import os from 'node:os';
import ssh2 from 'ssh2';
import { sshdPath, sshFixturePath, sshdConfig } from './support/sshd.mjs';
import { fingerprint } from './support/ssh-key.ts';
import { herdrFixture } from './herdr-fixture.ts';

const fixturePort3167 = await freePort();
const fixturePort3168 = await freePort();

const fixture = await herdrFixture(), origin = 'http://127.0.0.1:' + fixturePort3167, base = origin + '/herdr-test';
const root = new URL('../', import.meta.url).pathname;
const voiceToken = 'fixture-voice-token-'.repeat(4), daemon = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(daemon, 'listening'); await writeFile(fixture.directory + '/voice-token', voiceToken, { mode: 0o600 });
let voiceBytes = 0, voiceAcks = 0;
daemon.on('connection', (socket, request) => {
  assert.equal(request.headers.authorization, 'Bearer ' + voiceToken);
  if (request.url === '/v1/capabilities') { socket.send(JSON.stringify({ type: 'capabilities', protocol: 2, dictation: true, sample_rate: 16000, channels: 1, format: 'opus', framing: 'sequence_opus_v1', audio_encodings: ['opus_v1'], results: ['final'] })); return; }
  socket.send(JSON.stringify({ type: 'ready', protocol: 2, sample_rate: 16000, channels: 1, format: 'opus', audio_encoding: 'opus_v1', framing: 'sequence_opus_v1', max_seconds: 300, max_encoded_bytes: 2097152, resume: true, accepted_frames: 0, finished: false }));
  socket.on('message', (bytes, binary) => {
    if (binary) voiceBytes += bytes.length;
    else { const message = JSON.parse(bytes.toString()); if (message.type === 'finish') socket.send(JSON.stringify({ type: 'final', text: 'Dictated directly into Herdr' })); if (message.type === 'ack') voiceAcks++; }
  });
});
const backend = startBackend({ cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, TERMAI_VOXTYPE_TOKEN_FILE: fixture.directory + '/voice-token', TERMAI_VOXTYPE_URL: 'ws://127.0.0.1:' + daemon.address().port + '/v1/dictate', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(fixturePort3167), TERMAI_BASE_PATH: '/herdr-test',
  TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_ALLOWED_ORIGINS: origin, TERMAI_DATA_DIR: fixture.directory + '/termai',
  TERMAI_NO_RC: '1', TERMAI_CWD: fixture.directory, HOME: fixture.directory,
  PATH: fixture.directory + ':' + process.env.PATH, TERMAI_TOKEN: '', HERDR_SOCKET_PATH: fixture.socketPath,
} });
const exited = once(backend, 'exit'), errors = [], network = []; let logs = '', browser, page, sshd, liveOutput;
backend.stdout.on('data', b => logs += b); backend.stderr.on('data', b => logs += b);
const sha = data => createHash('sha256').update(data).digest('hex');
try {
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'backend');
  const token = (await readFile(fixture.directory + '/termai/pairing-token', 'utf8')).trim();
  const request = (name, data, bearer) => fetch(base + '/api/' + name, { method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  for (const name of ['herdr/snapshot', 'herdr/action', 'herdr/ticket', 'herdr/captured', 'notifications/key', 'notifications/subscribe', 'notifications/unsubscribe', 'notifications/unwatch', 'herdr/notifications']) assert.equal((await request(name, {})).status, 401);
  const bearer = (await (await request('connect', { noSession: true, token })).json()).accessToken;
  assert.equal((await request('herdr/snapshot?herdrSession=../../escape', undefined, bearer)).status, 400);
  assert.equal((await request('herdr/action', { action: 'rename', terminalId: 'missing', name: 'x' }, bearer)).status, 400);
  {
    for (const geometry of [{ mobile: true, cols: 0, rows: 30 }, { mobile: true, cols: 40, rows: 1001 }, { mobile: true, cols: 40.5, rows: 30 }, { mobile: true, cols: 40 }]) assert.equal((await request('herdr/ticket?terminalId=term_0', geometry, bearer)).status, 400);
    const reply = await (await request('herdr/ticket?terminalId=term_0', { mobile: true, cols: 40, rows: 30 }, bearer)).json(); assert.equal(reply.initialGeometry, true);
  }
  const ticket = (await (await request('herdr/ticket', {}, bearer)).json()).ticket;
  const wsURL = base.replace('http:', 'ws:') + '/herdr/ws?ticket=' + ticket;
  await new Promise((resolve, reject) => { const ws = new WebSocket(wsURL, { origin }); ws.once('open', () => { ws.close(); resolve(); }); ws.once('error', reject); });
  await new Promise((resolve, reject) => { const ws = new WebSocket(wsURL, { origin }); ws.once('open', () => { ws.close(); reject(new Error('Reused Herdr ticket')); }); ws.once('error', error => { assert.match(error.message, /403/); resolve(); }); });
  const scoped = (await (await request('herdr/ticket?herdrSession=work', {}, bearer)).json()).ticket;
  await new Promise((resolve, reject) => { const ws = new WebSocket(base.replace('http:', 'ws:') + '/herdr/ws?ticket=' + scoped, { origin }); ws.once('open', () => { ws.close(); reject(new Error('Session scope bypass')); }); ws.once('error', error => { assert.match(error.message, /403/); resolve(); }); });
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write', 'microphone'] }); page = await context.newPage(); page.setDefaultTimeout(12000);
  const notificationRequests = [], notificationDevice = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  await context.route('**/api/notifications/**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/key')) { await route.continue(); return; }
    notificationRequests.push({ url: route.request().url(), data: route.request().postDataJSON() });
    await route.fulfill({ json: { device: notificationDevice, ok: true } });
  });
  await context.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Herdr terminal link</title>' }));
  await context.route('**/api/herdr/notifications?*', async route => { notificationRequests.push({ url: route.request().url(), data: route.request().postDataJSON() }); await route.fulfill({ json: { ok: true } }); });
  page.on('pageerror', error => errors.push(error.stack || String(error)));
  page.on('console', message => { if (message.type() === 'error') network.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) network.push(response.status() + ' ' + response.url()); });
  page.on('requestfailed', request => network.push(request.url() + ' ' + request.failure()?.errorText));
  page.on('request', request => { if (/herdr-view|api\/herdr/.test(request.url())) network.push('request ' + request.url()); });
  await context.route('**/assets/terminal-*.js', async route => {
    const response = await route.fetch(), original = await response.text();
    const body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__testTerminal=new $1({ghostty:').replace(/([\w$]+)=([\w$]+)\?new ([\w$]+)\(([\w$]+),([\w$]+)\):void 0/, '$1=$2?(window.__testProjection=new $3($4,$5)):void 0');
    assert.notEqual(body, original); assert.ok(body.includes('window.__testProjection')); await route.fulfill({ response, body });
  });
  await installWireObserver(context);
  await context.addInitScript(() => {
    const delayedPaints = new WeakSet();
    window.addEventListener('message', event => {
      if (!window.__delayHerdrPaint || event.data?.type !== 'terminal-rendered' || delayedPaints.has(event)) return;
      event.stopImmediatePropagation();
      const delayed = new MessageEvent('message', { data: event.data, origin: event.origin, source: event.source });
      delayedPaints.add(delayed);
      setTimeout(() => window.dispatchEvent(delayed), 2000);
    });
    window.__wakeLocks = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { async request() {
      const lock = new EventTarget(); lock.released = false;
      lock.release = async () => { lock.released = true; lock.dispatchEvent(new Event('release')); };
      window.__wakeLocks.push(lock); return lock;
    } } });
    window.__installed = false; window.__permissionRequests = 0; window.__presence = [];
    const media = window.matchMedia.bind(window); window.matchMedia = query => query === '(display-mode: standalone)' ? { ...media(query), matches: window.__installed } : media(query);
    let permission = 'default'; Object.defineProperty(Notification, 'permission', { get: () => localStorage.getItem('termai.notifications.primary') ? 'granted' : permission });
    Notification.requestPermission = async () => { window.__permissionRequests++; permission = 'granted'; return permission; };
    const subscriptions = new WeakMap();
    PushManager.prototype.getSubscription = async function() { return subscriptions.get(this) || null; };
    PushManager.prototype.subscribe = async function(options) {
      const manager = this;
      const subscription = { options: { applicationServerKey: options.applicationServerKey.buffer }, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', keys: { p256dh: btoa(String.fromCharCode(4) + 'a'.repeat(64)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''), auth: btoa('a'.repeat(16)).replaceAll('=', '') } }), unsubscribe: async () => { subscriptions.delete(manager); return true; } };
      subscriptions.set(this, subscription); return subscription;
    };
    window.__sounds = []; window.__focused = true;
    window.__notices = [];
    if (window.parent === window && !location.pathname.endsWith('terminal.html')) document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => window.__notices.push(document.querySelector('#notice')?.textContent)).observe(document.querySelector('#notice'), { childList: true }));
    window.__herdrMessages = [];
    const Original = window.WebSocket; window.WebSocket = class extends Original { constructor(...args) { super(...args); this.addEventListener('message', async e => { const m = await window.__wireMessage(e.data, this); if (m.type === 'state') window.__state = m.state; }); if (String(args[0]).includes('/herdr/ws')) { this.addEventListener('message', async e => window.__herdrMessages.push(await window.__wireMessage(e.data, this))); this.addEventListener('close', e => window.__herdrMessages.push({ closed: e.code })); } } send(data) { try { const message = window.__wireSent(data); if (message.type === 'notification-presence') window.__presence.push(message); } catch {} return super.send(data); } };
    Object.defineProperty(document, 'hasFocus', { value: () => window.__focused });
    // Capture scheduled playback while still fetching/decoding the real bundled assets.
    if (window.parent !== window) return;
    window.AudioContext = class {
      state = 'running'; destination = {};
      async resume() { this.state = 'running'; }
      async decodeAudioData(bytes) { return { bytes: bytes.byteLength }; }
      createBufferSource() { return { connect() {}, start() { window.__sounds.push(this.buffer.bytes); } }; }
    };
  });
  await page.goto(base);
  await page.locator('#backend-login').waitFor({ state: 'visible' }); await page.locator('#backend-token').fill(token); await page.locator('#backend-login-form button[type=submit]').click();
  const shell = await (await page.locator('#terminal-stack > iframe').elementHandle()).contentFrame();
  await shell.waitForFunction(() => window.__state?.ready);
  await shell.locator('#terminal textarea').focus(); await page.keyboard.type('herdr'); await page.keyboard.press('Enter');
  await showTerminalTabs(page); await page.locator('#tabs .herdr-tab').waitFor();
  assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem('termai.hosts'))).some(host => host.kind === 'herdr'), 'Typing herdr saves its host automatically');
  const agentFrame = async () => {
    const element = await page.locator('.herdr-terminal').elementHandle(), frame = await element.contentFrame();
    await frame.waitForFunction(() => window.__testTerminal && window.__state?.inputTarget === 'program' && document.querySelector('#connection-label').textContent === 'Connected' && !document.querySelector('#terminal-viewport').classList.contains('awaiting-herdr-layout') && document.querySelector('#terminal-viewport').getAttribute('aria-busy') !== 'true' && !frameElement.inert && frameElement.checkVisibility({checkVisibilityCSS:true}));
    return frame;
  };
  const tab = id => page.locator('.herdr-agent-tab[data-terminal="term_' + id + '"]');
  const tabBounds = async (...ids) => {
    let bounds;
    // Snapshots replace the strip DOM, so read both drag targets in one turn.
    await until(async () => {
      bounds = await page.evaluate(ids => ids.map(id => {
        const element = document.querySelector('.herdr-agent-tab[data-terminal="term_' + id + '"]');
        if (!element?.checkVisibility({ checkVisibilityCSS: true })) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }), ids);
      return bounds.every(Boolean);
    }, 'visible agent drag targets');
    return bounds;
  };
  await page.locator('.herdr-agent-tab[data-terminal="space:w1"]').waitFor();
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#herdr-strip').inputValue(), 'spaces', 'New installations default to spaces');
  await page.locator('#herdr-strip').selectOption('agents'); await page.locator('#nav-terminals').click();
  await tab(0).waitFor(); let terminal = await agentFrame();
  assert.equal(await page.locator('.herdr-message').count(), 0);
  const text = () => terminal.evaluate(() => { const b = window.__testTerminal.buffer.active; return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true)).join('\n'); });
  await until(async () => (await text()).includes('Live Herdr terminal'), 'rendered ANSI frame');
  const imageResponse = page.waitForResponse(response => response.url().includes('/api/herdr/images/upload'));
  const imageChooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Attach images', exact: true }).click();
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await (await imageChooser).setFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: imageBytes });
  const uploadedImage = await imageResponse; assert.equal(uploadedImage.status(), 200);
  const imagePath = (await uploadedImage.json()).path; assert.deepEqual(await readFile(imagePath), imageBytes);
  await until(() => fixture.actions.some(action => action.method === 'pane.send_input' && action.params.text === imagePath), 'image path pasted into the selected Herdr terminal');
  assert.equal(fixture.actions.find(action => action.method === 'pane.send_input' && action.params.text === imagePath).params.pane_id, 'w1:p0');
  await (await import('node:fs/promises')).rm(imagePath);
  fixture.actions.splice(0, fixture.actions.length);
  fixture.setScreen(0, 'Codex\n╭────────────────────╮\n│ › type here        │\n╰────────────────────╯\nfooter\n', { x: 4, y: 2 });
  await until(async () => await terminal.evaluate(() => { const t = window.__testTerminal; return t.buffer.active.cursorY === 2 && t.buffer.active.cursorX === 4 && t.buffer.active.getLine(2)?.translateToString(true).includes('type here'); }), 'cursor inside Codex input box');
  fixture.setScreen(0, '0123456789'.repeat(12) + '\nfooter\n', { x: 10, y: 1 });
  await until(async () => await terminal.evaluate(() => { const t = window.__testTerminal; return t.buffer.active.cursorY === 1 && t.buffer.active.cursorX === 10; }), 'cursor follows local wrapping');
  fixture.setScreen(0, '0123456789'.repeat(12) + '\nfooter\n', { x: 0, y: 1 });
  await until(async () => await terminal.evaluate(() => { const t = window.__testTerminal; return t.buffer.active.cursorY === 1 && t.buffer.active.cursorX === 0; }), 'cursor at native wrap boundary');
  fixture.setScreen(0, 'api-refactor\nLive Herdr terminal\n');
  await until(async () => (await text()).includes('Live Herdr terminal'), 'restore initial terminal');
  assert.equal(await tab(0).getAttribute('data-status'), 'idle'); assert.equal(await tab(1).getAttribute('data-status'), 'working');
  const idle = await tab(0).locator('.herdr-status-dot').evaluate(el => ({ fill: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderColor }));
  assert.equal(idle.fill, 'rgba(0, 0, 0, 0)'); assert.equal(idle.border, 'rgb(168, 240, 160)');
  assert.equal(await terminal.locator('#shortcut-buttons').textContent(), await shell.locator('#shortcut-buttons').textContent());
  await page.locator('#workspace-shortcuts').waitFor({ state: 'visible' });
  assert.equal(await terminal.locator('.input-dock').isVisible(), false, 'Embedded pane delegates shortcuts to the workspace');
  await showTerminalTabs(page);
  await page.waitForFunction(() => document.querySelector('#terminal-tabs-drawer').getBoundingClientRect().height === 44);
  const bottomControls = await page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
    return { screen: box('.herdr-screen'), spaces: box('.herdr-agent-strip'), tabs: box('#terminal-header'), shortcuts: box('#workspace-shortcuts'), height: innerHeight };
  });
  assert.ok(bottomControls.screen.bottom <= bottomControls.tabs.top + 1);
  assert.ok(bottomControls.tabs.bottom <= bottomControls.spaces.top + 1, 'Terminal tabs sit above Herdr spaces');
  assert.ok(bottomControls.spaces.bottom <= bottomControls.shortcuts.top + 1, 'Herdr spaces sit above configurable buttons');
  assert.equal(bottomControls.shortcuts.bottom, bottomControls.height);
  await terminal.locator('#terminal textarea').focus(); await page.keyboard.type('Split routes into handlers'); await page.keyboard.press('Enter');
  await until(() => fixture.actions.some(a => a.method === 'pane.send_text' && a.params.text === '\r'), 'direct Enter delivery');
  assert.equal(fixture.actions.filter(a => a.method === 'pane.send_text').map(a => a.params.text).join(''), 'Split routes into handlers\r');
  await page.locator('#workspace-shortcuts').getByRole('button', { name: 'Esc', exact: true }).click();
  await until(() => fixture.actions.some(a => a.method === 'pane.send_text' && a.params.text === '\x1b'), 'shared Escape button');
  const mic = terminal.locator('#termai-dictation'); await mic.waitFor({ state: 'visible' });
  // Keyboard activation keeps this lifecycle check independent of the hold-to-finish gesture.
  await mic.press('Enter'); await terminal.waitForFunction(() => window.__herdrMessages.some(m => m.type === 'dictation' && m.state === 'ready')); await delay(350);
  await until(() => voiceBytes > 0, 'embedded audio capture starts');
  assert.equal(await page.evaluate(() => window.__wakeLocks.at(-1)?.released), false, 'Embedded dictation holds a lock owned by the outer page');
  assert.equal(await terminal.evaluate(() => window.__wakeLocks.length), 0, 'The iframe uses the eligible outer document');
  const beforeHiddenVoice = voiceBytes;
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); void window.__wakeLocks.at(-1).release(); });
  await terminal.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(() => voiceBytes > beforeHiddenVoice, 'embedded audio continues while hidden'); assert.equal(await mic.getAttribute('aria-pressed'), 'true', 'Hiding the page does not switch away from the recording pane');
  assert.ok(voiceBytes > beforeHiddenVoice, 'Embedded audio transport continues during simulated lock');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await terminal.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(async () => await page.evaluate(() => window.__wakeLocks.length === 2 && !window.__wakeLocks.at(-1).released), 'outer wake lock restored');
  await mic.press('Enter'); await until(() => fixture.actions.some(a => a.method === 'pane.send_input' && a.params.text === 'Dictated directly into Herdr'), 'direct dictation delivery');
  assert.equal(await page.evaluate(() => window.__wakeLocks.every(lock => lock.released)), true, 'Herdr finish releases the outer wake lock');
  await until(() => voiceAcks === 1, 'acknowledge after insertion'); assert.ok(voiceBytes > 0);
  assert.equal(fixture.actions.filter(a => a.method === 'pane.send_input').length, 1, 'Dictation inserts once without pressing Enter');
  assert.equal(await terminal.locator('.alternative-choice').count(), 0, 'Program dictation stays in the terminal');
  await terminal.locator('#terminal textarea').evaluate(el => el.blur());
  const touchHistory = Array.from({ length: 160 }, (_, i) => 'ROW-' + i + ' alpha beta gamma ' + 'long line '.repeat(8)).join('\n');
  fixture.setScreen(0, touchHistory);
  await until(async () => (await text()).includes('ROW-159'), 'unwrapped history');
  const desktop = await context.newPage(); await desktop.setViewportSize({ width: 1200, height: 800 });
  await desktop.goto(base + '/terminal.html?herdrTerminal=term_0&backend=' + encodeURIComponent(base + '/'));
  await desktop.waitForFunction(() => window.__testTerminal && window.__state?.inputTarget === 'program');
  await until(async () => await desktop.evaluate(() => window.__testTerminal.buffer.active.length >= 160), 'desktop history');
  const desktopSize = await desktop.evaluate(() => ({ cols: window.__testTerminal.cols, rows: window.__testTerminal.rows, length: window.__testTerminal.buffer.active.length }));
  const mobileSize = await terminal.evaluate(() => ({ cols: window.__testTerminal.cols, length: window.__testTerminal.buffer.active.length }));
  assert.ok(desktopSize.cols > mobileSize.cols && mobileSize.length > desktopSize.length, 'Each viewport wraps the same history to its own width');
  await page.setViewportSize({ width: 360, height: 800 }); await delay(250);
  assert.deepEqual(await desktop.evaluate(() => ({ cols: window.__testTerminal.cols, rows: window.__testTerminal.rows, length: window.__testTerminal.buffer.active.length })), desktopSize, 'Desktop web viewport retains its own font and local dimensions');
  const nativeSize = await terminal.evaluate(() => ({ cols: window.__testTerminal.cols, rows: window.__testTerminal.rows }));
  await until(async () => await desktop.evaluate(cols => window.__testProjection.nativeColumns === cols, nativeSize.cols), 'Desktop sees the shared mobile PTY geometry');
  assert.ok(fixture.actions.some(a => a.method === 'fixture.terminal.resize' && a.params.cols === nativeSize.cols), 'Mobile screen changes resize the real terminal');
  await desktop.close(); await page.bringToFront(); await page.setViewportSize({ width: 390, height: 844 });
  await terminal.waitForFunction(cols => window.__testTerminal.cols === cols && !document.querySelector('#terminal-viewport').classList.contains('awaiting-herdr-layout') && getComputedStyle(frameElement).visibility !== 'hidden', mobileSize.cols);
  const cdp = await context.newCDPSession(page), touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 1 }] });
  const hold = async locator => {
    if (await page.locator('.herdr-tab-menu:visible').count()) await page.keyboard.press('Escape');
    let rect;
    await until(async () => {
      try {
        await locator.scrollIntoViewIfNeeded();
        rect = await locator.boundingBox();
        return !!rect && await locator.evaluate(element => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        });
      }
      catch (error) { if (!error.message.includes('not attached')) throw error; return false; }
    }, 'attached tab for long press');
    const menu = await locator.evaluate(element => element.closest('#tabs') ? 'body > .host-terminal-menu' : '.herdr-tab-menu');
    await touch('touchStart', rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].some(menu => menu.checkVisibility({ checkVisibilityCSS: true })), menu);
    await touch('touchEnd');
  };
  const swipeStrip = async mode => {
    const style = await page.addStyleTag({ content: '.herdr-agent-strip .herdr-agent-tab { min-width: 260px; }' });
    const strip = page.locator('.herdr-agent-strip:visible');
    const state = () => strip.evaluate(strip => ({ scroll: strip.scrollLeft, order: [...strip.querySelectorAll('.herdr-agent-tab')].map(tab => tab.dataset.terminal), selected: strip.querySelector('[aria-selected=true]')?.dataset.terminal }));
    try {
      await strip.evaluate(strip => { strip.scrollLeft = 0; });
      const initial = await state(), rect = await strip.boundingBox(), y = rect.y + rect.height / 2;
      assert.ok(await strip.evaluate(strip => strip.scrollWidth > strip.clientWidth), mode + ' strip overflows');
      await touch('touchStart', rect.x + rect.width - 45, y); await delay(35);
      await touch('touchMove', rect.x + rect.width - 90, y); await delay(500);
      await touch('touchMove', rect.x + 60, y); await touch('touchEnd'); await delay(80);
      const forward = await state();
      assert.ok(forward.scroll > initial.scroll + 100, mode + ' swipe scrolls to later tabs, including after a pause');
      assert.deepEqual(forward.order, initial.order, mode + ' swipe preserves tab order');
      assert.equal(forward.selected, initial.selected, mode + ' swipe does not select a tab');
      assert.equal(await page.locator('.herdr-tab-menu:visible, .herdr-agent-tab.dragging, .herdr-agent-tab[data-drop]').count(), 0, mode + ' swipe opens no actions or drag preview');
      await touch('touchStart', rect.x + 60, y); await delay(35);
      await touch('touchMove', rect.x + 160, y); await touch('touchMove', rect.x + rect.width - 45, y); await touch('touchEnd'); await delay(80);
      const reverse = await state();
      assert.ok(reverse.scroll < forward.scroll - 100, mode + ' reverse swipe scrolls to earlier tabs');
      assert.deepEqual(reverse.order, initial.order, mode + ' reverse swipe preserves tab order');
      assert.equal(reverse.selected, initial.selected, mode + ' reverse swipe does not select a tab');
      assert.equal(await page.locator('.herdr-tab-menu:visible, .herdr-agent-tab.dragging, .herdr-agent-tab[data-drop]').count(), 0);
    } finally {
      await style.evaluate(style => style.remove()); await strip.evaluate(strip => { strip.scrollLeft = 0; });
    }
  };
  const canvas = await terminal.locator('#terminal canvas').boundingBox(), x = canvas.x + canvas.width / 2, y = canvas.y + canvas.height / 2;
  await touch('touchStart', x, y); await delay(30); await touch('touchMove', x, y + 75); await touch('touchEnd'); await delay(100);
  assert.ok(await terminal.evaluate(() => window.__testTerminal.getViewportY() > 0), 'Herdr uses normal touch scrolling');
  assert.equal(await terminal.locator('#terminal textarea').evaluate(el => el === document.activeElement), false, 'Scrolling leaves the keyboard closed');
  // A live TUI sends cursor frames while the user reads and selects history.
  await terminal.evaluate(() => {
    const frame = window.__herdrMessages.filter(m => m.type === 'herdr-frame' && m.width).at(-1);
    let visible = false; const bytes = atob(frame.bytes);
    window.__cursorFrames = setInterval(() => { visible = !visible; window.__testProjection.frame({ ...frame, bytes: btoa(bytes + '\x1b[?25' + (visible ? 'h' : 'l')) }); }, 40);
  });
  await touch('touchStart', x, y); await touch('touchCancel');
  const historyOffset = await terminal.evaluate(() => window.__testTerminal.getViewportY()); await delay(200);
  assert.ok(Math.abs(await terminal.evaluate(() => window.__testTerminal.getViewportY()) - historyOffset) < 1e-6, 'Live cursor frames preserve the scrolled viewport');
  const historyWord = await terminal.evaluate(() => {
    const term = window.__testTerminal, rect = document.querySelector('#terminal canvas').getBoundingClientRect();
    const top = term.buffer.active.length - term.rows - Math.floor(term.getViewportY());
    for (let row = 0; row < term.rows; row++) {
      const col = term.buffer.active.getLine(top + row)?.translateToString(true).indexOf('alpha') ?? -1;
      if (col >= 0) return { x: (col + .5) * rect.width / term.cols, y: (row + .5) * rect.height / term.rows, cell: rect.width / term.cols };
    }
    throw new Error('No history word for live selection');
  });
  let liveRevision = 0; liveOutput = setInterval(() => fixture.setScreen(0, touchHistory + '\nLIVE ' + String(++liveRevision).padStart(6, '0')), 80);
  await touch('touchStart', canvas.x + historyWord.x, canvas.y + historyWord.y); await delay(450); await touch('touchEnd');
  await terminal.locator('.selection-notice').filter({ hasText: 'Copied 5 characters' }).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'alpha', 'Live cursor frames must not clear touch selection in scrollback');
  await touch('touchStart', canvas.x + historyWord.x, canvas.y + historyWord.y);
  await touch('touchMove', canvas.x + historyWord.x + 9 * historyWord.cell, canvas.y + historyWord.y); await delay(200); await touch('touchEnd');
  await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === 'alpha beta', 'Live drag selection copies the selected text');
  clearInterval(liveOutput); await terminal.evaluate(() => clearInterval(window.__cursorFrames));
  await delay(800); await terminal.evaluate(() => window.__testTerminal.scrollToBottom()); await delay(80);
  const wordPoint = await terminal.evaluate(() => {
    const term = window.__testTerminal, rect = document.querySelector('#terminal canvas').getBoundingClientRect();
    const top = term.buffer.active.length - term.rows;
    for (let row = 0; row < term.rows; row++) {
      const col = term.buffer.active.getLine(top + row)?.translateToString(true).indexOf('alpha') ?? -1;
      if (col >= 0) return { x: (col + 2) * rect.width / term.cols, y: (row + .5) * rect.height / term.rows };
    }
    throw new Error('No word for selection');
  });
  await touch('touchStart', canvas.x + wordPoint.x, canvas.y + wordPoint.y); await delay(450); await touch('touchEnd');
  await terminal.locator('.selection-notice').filter({ hasText: 'Copied 5 characters' }).waitFor({ state: 'visible' });
  assert.equal(await terminal.evaluate(() => navigator.clipboard.readText()), 'alpha', 'Hold selects and copies through normal terminal gestures');
  const plainURL = 'https://example.com/herdr/a/long/path?from=terminal#touch', helpURL = 'https://example.com/herdr/help';
  fixture.setScreen(0, touchHistory + '\nRead ' + plainURL + '\n\x1b]8;;' + helpURL + '\x07Open help\x1b]8;;\x07\nLive footer');
  await until(async () => (await text()).includes('Open help'), 'Herdr hyperlinks render');
  await terminal.evaluate(() => {
    window.__testTerminal.scrollToBottom();
    const frame = window.__herdrMessages.filter(m => m.type === 'herdr-frame' && m.width).at(-1);
    window.__cursorFrames = setInterval(() => window.__testProjection.frame(frame), 40);
  });
  for (const [label, url] of [['https://', plainURL], ['Open help', helpURL]]) {
    const point = await terminal.evaluate(label => {
      const term = window.__testTerminal, rect = document.querySelector('#terminal canvas').getBoundingClientRect();
      const top = term.buffer.active.length - term.rows - Math.floor(term.getViewportY());
      for (let row = 0; row < term.rows; row++) {
        const col = term.buffer.active.getLine(top + row)?.translateToString(true).indexOf(label) ?? -1;
        if (col >= 0) return { x: (col + 1.5) * rect.width / term.cols, y: (row + .5) * rect.height / term.rows };
      }
      throw new Error('No terminal link: ' + label);
    }, label);
    const bounds = await terminal.locator('#terminal canvas').boundingBox(), opened = page.waitForEvent('popup');
    await touch('touchStart', bounds.x + point.x, bounds.y + point.y); await touch('touchEnd');
    const popup = await opened; await popup.waitForLoadState(); assert.equal(popup.url(), url); await popup.close(); await page.bringToFront();
    assert.equal(await terminal.locator('#terminal textarea').evaluate(el => el === document.activeElement), false, 'Link taps leave terminal input closed');
  }
  await terminal.evaluate(() => clearInterval(window.__cursorFrames)); fixture.setScreen(0, touchHistory);
  await until(async () => !(await text()).includes('Open help'), 'Restore history after link checks');
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#herdr-layout').inputValue(), 'reflow');
  await page.locator('#herdr-layout').selectOption('full-width'); await page.locator('#page-back').click();
  assert.ok(await terminal.evaluate(() => window.__testTerminal.cols < 80), 'Mobile always fits the PTY to its screen despite a saved full-width preference');
  await page.setViewportSize({ width: 1100, height: 900 });
  // Delay the parent handoff so geometry alone cannot make this gesture ready.
  await page.evaluate(() => { window.__delayHerdrPaint = true; });
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click(); await page.locator('#font-size').fill('24'); await page.locator('#page-back').click();
  await until(async () => await terminal.evaluate(() => window.__testTerminal.cols === 80), 'Desktop full-width layout retains the native column count after releasing mobile geometry');
  await terminal.waitForFunction(() => {
    const viewport = document.querySelector('#terminal-viewport');
    return window.__testTerminal.options.fontSize === 32 && viewport.classList.contains('full-width') && viewport.scrollWidth > viewport.clientWidth + 160;
  });
  terminal = await agentFrame();
  await page.evaluate(() => { window.__delayHerdrPaint = false; });
  const wideBounds = await terminal.locator('#terminal-viewport').boundingBox();
  await touch('touchStart', wideBounds.x + 250, wideBounds.y + 200); await delay(30); await touch('touchMove', wideBounds.x + 90, wideBounds.y + 200); await touch('touchEnd');
  await terminal.waitForFunction(() => document.querySelector('#terminal-viewport').scrollLeft > 100);
  assert.ok(await terminal.locator('#terminal-viewport').evaluate(el => el.scrollLeft > 100), 'Full-width terminal pans sideways with the shared gesture code');
  assert.equal(await terminal.locator('#terminal textarea').evaluate(el => el === document.activeElement), false, 'Panning leaves the keyboard closed');
  await terminal.locator('#terminal-viewport').evaluate(el => el.scrollLeft = 0); await terminal.evaluate(() => window.__testTerminal.scrollToBottom());
  await page.evaluate(() => navigator.clipboard.writeText('copy sentinel'));
  const wideWord = await terminal.evaluate(() => {
    const term = window.__testTerminal, rect = document.querySelector('#terminal canvas').getBoundingClientRect(), top = term.buffer.active.length - term.rows;
    for (let row = 0; row < term.rows; row++) { const col = term.buffer.active.getLine(top + row)?.translateToString(true).indexOf('alpha') ?? -1; if (col >= 0) return { x: (col + 2) * rect.width / term.cols, y: (row + .5) * rect.height / term.rows }; }
    throw new Error('No full-width word for selection');
  });
  const wideCanvas = await terminal.locator('#terminal canvas').boundingBox();
  await touch('touchStart', wideCanvas.x + wideWord.x, wideCanvas.y + wideWord.y); await delay(450); await touch('touchEnd');
  await terminal.locator('.selection-notice').filter({ hasText: 'Copied 5 characters' }).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'alpha', 'Full-width mode retains hold-to-copy');
  assert.equal(await terminal.locator('#terminal textarea').evaluate(el => el === document.activeElement), false, 'Copying focuses the document without opening terminal input');
  fixture.setScreen(0, '╭' + '─'.repeat(78) + '╮\n│ › prompt' + ' '.repeat(69) + '│\n╰' + '─'.repeat(78) + '╯\nfooter\n', { x: 4, y: 1 });
  await until(async () => await terminal.evaluate(() => { const term = window.__testTerminal; return Array.from({ length: term.buffer.active.length }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true)).some(row => row === '╭' + '─'.repeat(78) + '╮'); }), 'Terminal app borders stay on a single row');
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click(); await page.locator('#herdr-layout').selectOption('reflow'); await page.locator('#font-size').fill('10'); await page.locator('#page-back').click(); await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => await terminal.evaluate(() => window.__testTerminal.cols < 80), 'Return to mobile prose reflow');
  assert.ok(fixture.actions.some(a => a.method === 'fixture.terminal.release'), 'Desktop layout releases the mobile controller');
  fixture.setScreen(0, 'api-refactor\nLive Herdr terminal\n');
  await tab(1).click();
  assert.equal(await tab(1).getAttribute('aria-selected'), 'true'); await tab(0).click(); terminal = await agentFrame();
  await hold(tab(0)); await page.locator('.herdr-tab-menu').getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Agent tab name', exact: true }).fill('routes');
  await page.locator('.herdr-rename').getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await tab(0).textContent()).includes('routes'), 'upstream rename');
  assert.equal(fixture.snapshot.panes[0].label, 'routes', 'Mobile rename updates the actual desktop pane label');
  fixture.rename(0, 'desktop'); await until(async () => (await tab(0).textContent()).includes('desktop'), 'desktop rename propagates to mobile');
  fixture.rename(0, 'routes'); await until(async () => (await tab(0).textContent()).includes('routes'), 'restore shared label');
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  await page.locator('#customize-shortcuts').click(); await page.locator('#add-shortcut').click();
  const shortcut = page.locator('.shortcut-row').last(); await shortcut.locator('.shortcut-label').fill('Help'); await shortcut.locator('select').selectOption('keys'); await shortcut.locator('.binding').fill('Ctrl+H');
  await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click();
  await terminal.waitForFunction(() => document.querySelector('#shortcut-buttons').textContent.includes('Help'));
  await shell.waitForFunction(() => document.querySelector('#shortcut-buttons').textContent.includes('Help'));
  await page.locator('#nav-terminals').click(); terminal = await agentFrame();
  await page.locator('#workspace-shortcuts').getByRole('button', { name: 'Help', exact: true }).click();
  await until(() => fixture.actions.some(a => a.method === 'pane.send_text' && a.params.text === '\x08'), 'customized shortcuts shared after reconnect');
  // Reconnecting an agent view starts a fresh input revision, so dictation still works.
  await terminal.evaluate(() => { window.__herdrMessages = []; });
  await terminal.locator('#termai-dictation').press('Enter'); await terminal.waitForFunction(() => window.__herdrMessages.some(m => m.type === 'dictation' && m.state === 'ready')); await delay(350);
  await terminal.locator('#termai-dictation').press('Enter'); await until(() => voiceAcks === 2, 'dictation after a hidden view reconnects');
  await swipeStrip('Agents');
  const [before, after] = await tabBounds(0, 2);
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2); await page.mouse.down();
  await page.locator('.herdr-tab-menu').waitFor({ state: 'visible' });
  await page.mouse.move(after.x + after.width * .8, after.y + after.height / 2, { steps: 10 });
  const dropPreview = page.locator('.herdr-drop-indicator:visible');
  assert.equal(await dropPreview.textContent(), 'Drop here');
  const dropBounds = await dropPreview.boundingBox();
  assert.ok(dropBounds.height >= 80 && dropBounds.y < after.y - 40, 'Drop marker rises above the finger covering the strip');
  await page.screenshot({ path: root + '.test-artifacts/herdr-terminal-drop.png' });
  await page.mouse.up();
  assert.equal(await page.locator('.herdr-drop-indicator:visible').count(), 0, 'Drop marker clears on release');
  assert.deepEqual(await page.locator('.herdr-agent-tab').evaluateAll(els => els.map(el => el.dataset.terminal)), ['term_1', 'term_2', 'term_0']);
  // Real touch drag goes back and forth; moving tabs must retain capture.
  const [routeRect, testRect] = await tabBounds(0, 1);
  await touch('touchStart', routeRect.x + routeRect.width / 2, routeRect.y + routeRect.height / 2);
  await page.locator('.herdr-tab-menu').waitFor({ state: 'visible' });
  await touch('touchMove', testRect.x + 5, testRect.y + testRect.height / 2); await touch('touchEnd');
  assert.deepEqual(await page.locator('.herdr-agent-tab').evaluateAll(els => els.map(el => el.dataset.terminal)), ['term_0', 'term_1', 'term_2']);
  const [routeAgain, docsRect] = await tabBounds(0, 2);
  await touch('touchStart', routeAgain.x + routeAgain.width / 2, routeAgain.y + routeAgain.height / 2);
  await page.locator('.herdr-tab-menu').waitFor({ state: 'visible' });
  await touch('touchMove', docsRect.x + docsRect.width - 5, docsRect.y + docsRect.height / 2); await touch('touchEnd');
  assert.deepEqual(await page.locator('.herdr-agent-tab').evaluateAll(els => els.map(el => el.dataset.terminal)), ['term_1', 'term_2', 'term_0']);
  await tab(2).click();
  await page.waitForFunction(() => document.querySelector('.herdr-agent-tab[data-terminal=term_2]').getAttribute('aria-selected') === 'true'); terminal = await agentFrame();
  assert.deepEqual(await page.locator('.herdr-agent-tab').evaluateAll(els => els.map(el => el.dataset.terminal)), ['term_1', 'term_2', 'term_0']);
  await showTerminalTabs(page); await page.locator('#tabs .tab').first().click();
  assert.equal(await page.locator('.herdr-agent-strip').isVisible(), false);
  await delay(250); const readsWhileHidden = fixture.actions.filter(a => a.method === 'pane.read').length; await delay(300);
  assert.equal(fixture.actions.filter(a => a.method === 'pane.read').length, readsWhileHidden, 'Hidden views stop reading history');
  fixture.update(1, 'idle');
  await until(async () => (await page.evaluate(() => window.__sounds.length)) === 1, 'done sound under regular terminal');
  assert.equal(await page.locator('.herdr-attention').textContent(), '1');
  fixture.update(0, 'blocked');
  await until(async () => (await page.evaluate(() => window.__sounds.length)) === 2, 'request sound under regular terminal');
  assert.equal(await page.locator('.herdr-attention').textContent(), '2');
  await delay(150); assert.equal(await page.evaluate(() => window.__sounds.length), 2, 'snapshots must not repeat sound');
  await showTerminalTabs(page); await page.locator('#tabs .herdr-tab').click(); await tab(1).waitFor();
  assert.equal(await tab(1).getAttribute('data-status'), 'done'); assert.equal(await tab(0).getAttribute('data-status'), 'blocked');
  await tab(1).click(); await until(async () => await tab(1).getAttribute('data-status') === 'idle', 'acknowledge only viewed completion');
  await showTerminalTabs(page); await page.locator('#tabs .tab').first().click(); await page.evaluate(() => window.__focused = false);
  fixture.update(1, 'working'); await delay(150); fixture.update(1, 'idle');
  await delay(300); assert.equal(await page.evaluate(() => window.__sounds.length), 2, 'unfocused webapp stays quiet');
  await page.evaluate(() => window.__focused = true); await showTerminalTabs(page); await page.locator('#tabs .herdr-tab').click();
  await until(async () => await tab(1).getAttribute('data-status') === 'idle', 'view after muted notification');
  await showTerminalTabs(page); await hold(page.locator('#tabs .herdr-tab'));
  await page.locator('body > .host-terminal-menu:visible').getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Tab name', exact: true }).fill('Agent team'); await page.locator('dialog[open]').getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await until(async () => await tab(1).count() === 1 && await tab(1).getAttribute('data-status') === 'idle', 'restored view and acknowledgements');
  assert.equal(await page.locator('#tabs .herdr-tab .tab-name').textContent(), 'Agent team');
  assert.deepEqual(await page.locator('.herdr-agent-tab').evaluateAll(els => els.map(el => el.dataset.terminal)), ['term_1', 'term_2', 'term_0']);
  await showTerminalTabs(page); await page.locator('#tabs .herdr-tab').click();
  await mkdir(root + '.test-artifacts', { recursive: true }); await page.screenshot({ path: root + '.test-artifacts/herdr-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 800 }); await page.screenshot({ path: root + '.test-artifacts/herdr-desktop.png' });
  // Asset identity and content type, including a mounted installation.
  const mp3s = (await page.locator('script[type=module]').first().getAttribute('src')) ? await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.endsWith('.mp3')).map(e => e.name)) : [];
  assert.equal(mp3s.length, 2);
  for (const url of mp3s) {
    const response = await fetch(url); assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    const name = new URL(url).pathname.includes('/done-') ? 'done' : 'request';
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(await readFile(root + 'src/assets/herdr/' + name + '.mp3')));
  }
  await showTerminalTabs(page); await hold(page.locator('#tabs .herdr-tab')); await page.locator('body > .host-terminal-menu:visible').getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  assert.ok(fixture.actions.some(a => a.method === 'fixture.terminal.open' && a.params.mode === 'control'));
  assert.equal(await page.locator('.herdr-view').count(), 0); assert.equal(fixture.snapshot.agents.length, 3);
  await page.setViewportSize({ width: 390, height: 844 });
  // Reopening a dedicated local Herdr transport reuses its tab after the source closes.
  const localHerdr = await page.evaluate(async () => {
    const api = async (name, data) => { const response = await fetch(new URL('api/' + name, document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; };
    const source = await api('sessions', { files: true, name: 'Dedicated Herdr' });
    const target = await api('herdr/connect', { source: source.id, session: '' });
    const tab = { id: crypto.randomUUID(), session: source.id, backendId: 'primary', hostId: 'local', pluginId: 'herdr', pluginVersion: '1', mode: 'herdr', ownsSession: true, name: 'Dedicated Herdr', ...target };
    const tabs = JSON.parse(localStorage.getItem('termai.tabs')); tabs.push(tab); localStorage.setItem('termai.tabs', JSON.stringify(tabs)); localStorage.setItem('termai.activeTab', JSON.stringify(tab.id));
    return tab;
  });
  await page.reload(); await tab(0).waitFor();
  await page.evaluate(async source => { const response = await fetch(new URL('api/sessions/close?session=' + source, document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (!response.ok) throw new Error(await response.text()); }, localHerdr.session);
  await page.waitForFunction(previous => JSON.parse(localStorage.getItem('termai.tabs')).some(tab => tab.id === previous.id && tab.session !== previous.session && tab.herdrSource === tab.session && !tab.ended), localHerdr);
  await agentFrame(); assert.equal(await page.locator('#tabs .herdr-tab').count(), 1, 'Reconnecting must reuse the local Herdr tab');
  assert.equal(await page.getByRole('button', { name: 'Reconnect', exact: true }).count(), 0, 'An expired source restores without a manual reconnect');
  // Exercise the opening transition before using touch coordinates for the tab menu.
  const drawerMotion = await page.addStyleTag({ content: '#terminal-tabs-drawer, #terminal-tabs-drawer .terminal-header { transition-duration: 1s !important; }' });
  await showTerminalTabs(page); await hold(page.locator('#tabs .herdr-tab')); await page.locator('body > .host-terminal-menu:visible').getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await drawerMotion.evaluate(element => element.remove());
  const controlsBeforeSSH = fixture.actions.filter(a => a.method === 'fixture.terminal.open' && a.params.mode === 'control').length;
  // A real disposable SSH server exercises command capture and Unix socket forwarding.
  await mkdir(fixture.directory + '/remote');
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519'), identity = ssh2.utils.generateKeyPairSync('ed25519', { cipher: 'aes256-ctr', passphrase: 'fixture-passphrase' });
  await writeFile(fixture.directory + '/host-key', hostKey.private, { mode: 0o600 });
  await writeFile(fixture.directory + '/authorized', identity.public + '\n');
  await sshdConfig(fixture.directory, fixturePort3168, { hostKey: 'host-key', pid: 'sshd.pid', env: { HERDR_SOCKET_PATH: fixture.socketPath, PATH: sshFixturePath(fixture.directory) } });
  sshd = spawn(sshdPath(), ['-D', '-e', '-f', fixture.directory + '/sshd_config'], { stdio: ['ignore', 'pipe', 'pipe'] });
  sshd.stderr.on('data', bytes => logs += bytes); await delay(150);
  const trust = fingerprint(ssh2.utils.parseKey(hostKey.private).getPublicSSH());
  const remote = await page.evaluate(async ({ identity, trust, username, fixturePort3168 }) => {
    const response = await fetch(new URL('api/sessions', document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'SSH fixture', ssh: { host: '127.0.0.1', port: fixturePort3168, username, privateKey: identity, passphrase: 'fixture-passphrase', trust } }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    const hosts = JSON.parse(localStorage.getItem('termai.hosts')); hosts.push({ id: 'ssh-fixture', name: 'SSH fixture', kind: 'ssh', backendId: 'primary', hostname: '127.0.0.1', port: fixturePort3168, username }); localStorage.setItem('termai.hosts', JSON.stringify(hosts));
    const tabs = JSON.parse(localStorage.getItem('termai.tabs')); tabs.push({ id: result.id, session: result.id, name: 'SSH fixture', backendId: 'primary', hostId: 'ssh-fixture' }); localStorage.setItem('termai.tabs', JSON.stringify(tabs)); localStorage.setItem('termai.activeTab', JSON.stringify(result.id));
    return result;
  }, { identity: identity.private, trust, username: os.userInfo().username, fixturePort3168 });
  await page.reload(); await showTerminalTabs(page); await page.locator('#tabs .tab').filter({ hasText: 'SSH fixture' }).click();
  const remoteFrame = await (await page.locator('#terminal-stack > iframe:visible').elementHandle()).contentFrame();
  await remoteFrame.waitForFunction(() => window.__state?.ready);
  await remoteFrame.locator('#terminal textarea').focus(); await page.keyboard.type('herdr'); await page.keyboard.press('Enter');
  await showTerminalTabs(page); await page.locator('#tabs .herdr-tab').waitFor(); await tab(0).waitFor(); terminal = await agentFrame();
  const remoteHost = await page.evaluate(source => JSON.parse(localStorage.getItem('termai.hosts')).find(host => host.kind === 'herdr' && host.herdrSource === source), remote.id);
  assert.equal(remoteHost.herdrSourceHostId, 'ssh-fixture', 'Typing herdr in SSH saves a host for that machine');
  await until(() => fixture.actions.filter(a => a.method === 'fixture.terminal.open' && a.params.mode === 'control').length > controlsBeforeSSH, 'Mobile acquires native geometry through SSH');
  const remoteCols = await terminal.evaluate(() => window.__testTerminal.cols);
  await until(async () => await terminal.evaluate(cols => window.__testProjection.nativeColumns === cols, remoteCols), 'SSH controller frames match the mobile grid');
  assert.equal((await request('herdr/ticket?herdrSource=' + remote.id, {}, bearer)).status, 404, 'Another pairing cannot use an SSH host it does not own');
  await terminal.waitForFunction(() => document.querySelector('#terminal-viewport').getAttribute('aria-busy') !== 'true');
  await terminal.evaluate(() => window.__testTerminal.focus());
  assert.equal(await terminal.locator('#terminal textarea').evaluate(el => el === document.activeElement && !el.readOnly), true, 'Explicit terminal focus must enable SSH input');
  await page.keyboard.type('SSH input');
  await until(() => fixture.actions.filter(a => a.method === 'pane.send_text').map(a => a.params.text).join('').includes('SSH input'), 'input through SSH Unix forwarding');
  // A captured SSH profile reconnects through its saved source host with fresh credentials.
  const reconnectKey = await page.evaluate(async privateKey => {
    const response = await fetch(new URL('api/keychain', document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', name: 'Reconnect fixture', privateKey, passphrase: 'fixture-passphrase' }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }, identity.private);
  const remoteHerdrTab = await page.evaluate(() => JSON.parse(localStorage.getItem('termai.tabs')).find(tab => tab.mode === 'herdr'));
  await page.evaluate(async source => { const response = await fetch(new URL('api/sessions/close?session=' + source, document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (!response.ok) throw new Error(await response.text()); }, remote.id);
  await page.locator('#ssh-dialog').waitFor({ state: 'visible' });
  await page.locator('#ssh-key').selectOption(reconnectKey.fingerprint); await page.locator('#ssh-secret').fill('fixture-passphrase'); await page.locator('#ssh-connect').click();
  await page.waitForFunction(previous => JSON.parse(localStorage.getItem('termai.tabs')).some(tab => tab.id === previous.id && tab.herdrSource !== previous.herdrSource && tab.herdrSource === tab.session && tab.ownsSession && !tab.ended), remoteHerdrTab);
  await tab(0).waitFor(); terminal = await agentFrame();
  assert.equal(await page.locator('#tabs .herdr-tab').count(), 1, 'Reconnecting must reuse the captured SSH Herdr tab');
  const restoredSource = await page.evaluate(hostId => JSON.parse(localStorage.getItem('termai.hosts')).find(host => host.id === hostId).herdrSource, remoteHost.id);
  assert.notEqual(restoredSource, remote.id, 'The captured host must save its refreshed source');
  assert.equal((await request('herdr/ticket?herdrSource=' + restoredSource, {}, bearer)).status, 404, 'Reconnection retains owner isolation');
  const standalone = await context.newPage(); await standalone.goto(base + '/terminal.html');
  await standalone.waitForFunction(() => window.__state?.ready);
  await standalone.locator('#terminal textarea').focus(); await standalone.keyboard.type('herdr'); await standalone.keyboard.press('Enter');
  await standalone.waitForURL(base + '/');
  await standalone.waitForFunction(() => {
    const active = JSON.parse(localStorage.getItem('termai.activeTab')), tab = JSON.parse(localStorage.getItem('termai.tabs')).find(tab => tab.id === active);
    return tab?.mode === 'herdr' && !tab.herdrSource;
  });
  await until(async () => (await standalone.locator('.herdr-agent-strip:visible .herdr-agent-tab').count()) === 3, 'standalone discovery opens the workspace');
  await standalone.close();
  // Desktop-created spaces remain absent from agent mode, and appear in spaces mode.
  await showTerminalTabs(page); await page.locator('#tabs .herdr-tab').last().click();
  fixture.addSpace('w2', 'Scratch'); fixture.addTerminal('w2', 'Scratch shell', false);
  await delay(250); assert.equal(await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').count(), 3);
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#herdr-strip').inputValue(), 'agents');
  await page.locator('#herdr-strip').selectOption('spaces'); await page.locator('#nav-terminals').click();
  const spaceTab = id => page.locator('.herdr-agent-strip:visible .herdr-agent-tab[data-terminal="space:' + id + '"]');
  await spaceTab('w2').waitFor(); await swipeStrip('Spaces'); await spaceTab('w2').click(); terminal = await agentFrame();
  await until(async () => (await text()).includes('Scratch shell'), 'ordinary terminal opened from a space');
  await spaceTab('w1').click(); await spaceTab('w1').click();
  await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'docs · Termai' }).click();
  assert.equal(await page.locator('.herdr-terminal').getAttribute('data-terminal'), 'term_2');
  await spaceTab('w1').click();
  await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'Create agent', exact: true }).click();
  await page.getByLabel('Agent name', { exact: true }).fill('Mobile review');
  await page.getByLabel('Agent type', { exact: true }).selectOption('codex'); await page.getByLabel('Space', { exact: true }).selectOption('w2');
  await page.getByRole('dialog').getByRole('button', { name: 'Create agent', exact: true }).click();
  await until(async () => await page.locator('.herdr-terminal').getAttribute('data-terminal') === 'term_4', 'created agent selected');
  assert.equal(fixture.snapshot.agents.length, 4); assert.equal(fixture.snapshot.panes[4].label, 'Mobile review');
  assert.equal(fixture.actions.filter(a => a.method === 'agent.start').length, 1);
  await page.reload(); await spaceTab('w2').waitFor();
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#herdr-strip').inputValue(), 'spaces');
  await page.locator('#herdr-strip').selectOption('agents'); await page.locator('#nav-terminals').click();
  await tab(4).waitFor(); assert.equal(await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').count(), 4);
  fixture.addTerminal('w2', 'Desktop agent', true);
  await tab(5).waitFor(); assert.equal(await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').count(), 5);
  fixture.rejectClose('Server refused to close pane.');
  await hold(tab(5)); await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await until(async () => (await page.locator('#notice').textContent()).includes('Server refused to close pane.'), 'server close failure shown');
  assert.equal(await tab(5).count(), 1); assert.equal(fixture.snapshot.agents.length, 5, 'Rejected close keeps the server pane and mobile tab');
  fixture.rejectClose();
  await hold(tab(5)); await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await until(async () => await tab(5).count() === 0, 'agent removed after server close');
  assert.ok(!fixture.snapshot.panes.some(p => p.terminal_id === 'term_5')); assert.equal(fixture.snapshot.agents.length, 4);
  await tab(4).click(); terminal = await agentFrame();
  await hold(tab(4)); await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'Close tab', exact: true }).click();
  await until(async () => await tab(4).count() === 0 && await page.locator('.herdr-terminal').getAttribute('data-terminal') !== 'term_4', 'closing selected agent chooses a surviving pane');
  assert.ok(!fixture.snapshot.panes.some(p => p.terminal_id === 'term_4'));
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  await page.locator('#herdr-strip').selectOption('spaces'); await page.locator('#nav-terminals').click();
  await spaceTab('w2').click(); terminal = await agentFrame();
  await hold(spaceTab('w2')); await page.locator('.herdr-tab-menu:visible').getByRole('menuitem', { name: 'Close', exact: true }).click();
  await until(async () => await spaceTab('w2').count() === 0, 'space removed after server close');
  assert.ok(!fixture.snapshot.workspaces.some(w => w.workspace_id === 'w2')); assert.ok(!fixture.snapshot.panes.some(p => p.workspace_id === 'w2'));
  assert.deepEqual(fixture.actions.filter(a => a.method === 'workspace.close').at(-1).params, { workspace_id: 'w2', close_group: false });
  fixture.addSpace('desktop-closed', 'Desktop close'); fixture.addTerminal('desktop-closed', 'Desktop shell', false);
  await spaceTab('desktop-closed').click(); terminal = await agentFrame();
  const closureNotices = await page.evaluate(() => window.__notices.length);
  fixture.pauseEvents(); fixture.closeSpace('desktop-closed');
  await until(async () => await spaceTab('desktop-closed').count() === 0, 'external close reconciles the space list before its metadata event');
  terminal = await agentFrame();
  assert.equal(await spaceTab('w1').getAttribute('aria-selected'), 'true', 'External close selects a surviving space');
  assert.deepEqual(await page.evaluate(index => window.__notices.slice(index), closureNotices), [], 'Closing a pane must not show an error');
  fixture.pauseEvents(false);
  await page.reload(); await spaceTab('w1').waitFor(); assert.equal(await spaceTab('w2').count(), 0, 'Closed space stays closed after reload');
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  // The primary backend's label is installation-specific; choose its single control.
  const enable = page.locator('#herdr-notifications button').first();
  assert.equal(await enable.isDisabled(), true, 'Permission is offered inside the installed PWA'); assert.equal(await page.evaluate(() => window.__permissionRequests), 0);
  await page.evaluate(() => window.__installed = true); await page.locator('#page-back').click(); await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  await page.locator('#herdr-notifications button').first().click();
  await until(async () => await page.locator('#herdr-notifications button').first().textContent().then(text => text.startsWith('Disable')), 'Enable background alerts');
  assert.equal(await page.evaluate(() => window.__permissionRequests), 1, 'Permission requested only from Enable');
  assert.ok(notificationRequests.some(request => request.url.endsWith('/subscribe') && request.data.subscription.endpoint.includes('fcm.googleapis.com')));
  await until(() => notificationRequests.some(request => request.url.includes('/herdr/notifications') && request.data.device === notificationDevice));
  const registration = await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(new URL('notifications/primary/', document.baseURI)); return { scope: registration.scope, script: registration.active.scriptURL }; });
  assert.equal(registration.scope, base + '/notifications/primary/'); assert.equal(registration.script, base + '/push-sw.js');
  await until(async () => await page.evaluate(() => window.__presence.some(message => message.focused === true)));
  await page.evaluate(() => { window.__focused = false; window.dispatchEvent(new Event('blur')); });
  await until(async () => await page.evaluate(() => window.__presence.some(message => message.focused === false)));
  await page.evaluate(() => { window.__focused = true; window.dispatchEvent(new Event('focus')); });
  const notificationTab = await page.evaluate(() => JSON.parse(localStorage.getItem('termai.tabs')).find(tab => tab.mode === 'herdr').id);
  await page.evaluate(tabId => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'herdr-notification', tabId, terminalId: 'term_1' } })), notificationTab);
  await until(async () => await page.locator('.herdr-view:visible .herdr-terminal').getAttribute('data-terminal') === 'term_1');
  await page.goto(base + '/?notificationTab=' + notificationTab + '&notificationTerminal=term_2');
  await until(async () => await page.locator('.herdr-view:visible .herdr-terminal').getAttribute('data-terminal') === 'term_2');
  assert.equal(new URL(page.url()).search, '', 'Cold notification routing consumes its parameters');
  await showTerminalTabs(page); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click(); await page.locator('#herdr-notifications button').first().click();
  await until(async () => !(await page.evaluate(() => localStorage.getItem('termai.notifications.primary'))));
  assert.ok(notificationRequests.some(request => request.url.endsWith('/unsubscribe')));
  await page.locator('#nav-terminals').click(); terminal = await agentFrame();
  const lastClosureNotices = await page.evaluate(() => window.__notices.length);
  fixture.pauseEvents(); fixture.closeSpace('w1');
  await until(async () => await spaceTab('w1').count() === 0 && await page.locator('.herdr-empty:visible').count() === 1, 'closing the last space shows the empty state');
  assert.equal(await page.locator('.herdr-view:visible iframe').count(), 0, 'The last closed terminal is removed');
  assert.deepEqual(await page.evaluate(index => window.__notices.slice(index), lastClosureNotices), [], 'Closing the last space must not show an error');
  fixture.pauseEvents(false);
  assert.deepEqual(errors, []); console.log('Herdr browser checks passed: automatic discovery, shared direct input/shortcuts/touch scroll/copy, live-output selection and wrapped/labeled link taps, native mobile sizing/release, desktop reflow/full-width layouts and panning, PWA enable/disable/scoped workers/focus/click routing, session labels, hold menus, ordering, persistence, server pane/space close, sounds and scoped tickets.');
} catch (error) { await page?.screenshot({ path: '/tmp/termai-herdr-failure.png' }).catch(() => {}); console.error(await Promise.all(page.frames().map(frame => frame.evaluate(() => ({ url: location.href, notice: document.querySelector('.selection-notice')?.textContent, pending: document.querySelector('#terminal-viewport')?.className, parentVisible: frameElement && getComputedStyle(frameElement).visibility, layout: window.__herdrMessages?.filter(m => m.type === 'herdr-layout'), rows: window.__testTerminal?.rows, cols: window.__testTerminal?.cols, view: window.__testTerminal?.getViewportY(), cursor: window.__testTerminal ? {x: window.__testTerminal.buffer.active.cursorX, y: window.__testTerminal.buffer.active.cursorY} : undefined, frames: JSON.stringify(window.__herdrMessages?.filter(m => m.type === 'herdr-frame').map(m => ({width:m.width,height:m.height,full:m.full}))), selected: window.__testTerminal?.getSelection() })).catch(() => ({}))))); console.error(logs, errors, network, await page?.evaluate(() => ({ text: document.body.innerText, notices: window.__notices, messages: window.__herdrMessages, hosts: localStorage.getItem('termai.hosts'), tabs: localStorage.getItem('termai.tabs') })).catch(() => ({}))); throw error; }
finally { clearInterval(liveOutput); await browser?.close(); backend.kill('SIGTERM'); await exited; sshd?.kill('SIGTERM'); for (const socket of daemon.clients) socket.terminate(); await new Promise(resolve => daemon.close(resolve)); await fixture.close(); }
