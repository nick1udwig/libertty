import { installWireObserver } from './wire-observer.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';
import { herdrFixture } from './herdr-fixture.ts';

const fixture = await herdrFixture(), root = new URL('../', import.meta.url).pathname;
const base = 'http://127.0.0.1:3183', history = Array.from({ length: 160 }, (_, i) => `ROW-${i} alpha beta gamma`).join('\n')
  + '\nRead https://example.com/touch\n\x1b]8;;https://example.com/help\x07Open help\x1b]8;;\x07\n';
fixture.setScreen(0, history);
const server = spawn(new URL('../target/debug/termai', import.meta.url).pathname, [], { cwd: root, stdio: 'ignore', env: { ...process.env,
  NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3183', TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_ALLOWED_ORIGINS: base,
  TERMAI_DATA_DIR: fixture.directory + '/termai', HOME: fixture.directory, TERMAI_CWD: fixture.directory, TERMAI_TOKEN: '',
  TERMAI_NO_RC: '1', HERDR_SOCKET_PATH: fixture.socketPath, PATH: fixture.directory + ':' + process.env.PATH,
} });
const exited = once(server, 'exit'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, live;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base).then(r => r.ok, () => false)) break; await delay(100); }
  const token = (await readFile(fixture.directory + '/termai/pairing-token', 'utf8')).trim();
  const response = await fetch(base + '/api/connect', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, noSession: true }) });
  assert.ok(response.ok); const { accessToken } = await response.json();
  const safari = process.env.TEST_BROWSER === 'webkit';
  browser = await (safari ? webkit.launch() : chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=gl'] }));
  for (const herdr of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    await installWireObserver(context);
  await context.addInitScript(({ accessToken }) => {
      window.__copies = []; window.__inputs = []; window.__opened = [];
      window.__nativeTouches = [];
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel']) document.addEventListener(type, event => {
        if (event.isTrusted) window.__nativeTouches.push({ type, at: event.timeStamp, target: event.target?.tagName, x: event.clientX, y: event.clientY,
          touches: event.changedTouches && [...event.changedTouches].map(touch => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY })) });
      }, { capture: true });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copies.push(text); } } });
      window.open = (...args) => { window.__opened.push(args); return null; };
      const Original = WebSocket;
      window.WebSocket = class extends Original { constructor(...args) { super(...args); this.addEventListener('message', async e => { const m = await window.__wireMessage(e.data, this); if (m.type === 'state') window.__state = m.state; }); } send(data) { if (window.__wireSent(data).type === 'input') window.__inputs.push(JSON.stringify(window.__wireSent(data))); return super.send(data); } };
      if (parent === window) addEventListener('message', async e => { if (e.data?.type === 'terminal-loaded') e.source.postMessage({ type: 'authorize', accessToken }, location.origin); });
    }, { accessToken });
    await context.route('**/assets/terminal-*.js', async route => {
      const response = await route.fetch(), original = await response.text();
      const body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__testTerminal=new $1({ghostty:');
      assert.notEqual(body, original); await route.fulfill({ response, body });
    });
    let session = 'touch-herdr';
    if (!herdr) {
      const created = await fetch(base + '/api/sessions', { method: 'POST', headers: { Origin: base, Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Touch fixture' }) });
      assert.ok(created.ok); session = (await created.json()).id;
    }
    const params = new URLSearchParams({ embedded: '1', session, ...(herdr ? { herdrTerminal: 'term_0' } : {}) });
    await context.route('**/touch-fixture.html', route => route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style><iframe src="/terminal.html?${params}" allow="clipboard-write; microphone"></iframe>` }));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/touch-fixture.html');
    await page.locator('iframe').waitFor();
    const frame = page.frames().find(frame => frame.url().includes('terminal.html'));
    await frame.waitForFunction(() => window.__testTerminal && document.querySelector('#connection-label').textContent === 'Connected' && (window.__state?.ready || window.__state?.inputTarget === 'program'));
    if (!herdr) await frame.evaluate(history => { window.__testTerminal.write('\x1bc\x1b[3J' + history.replaceAll('\n', '\r\n')); }, history);
    else {
      await frame.waitForFunction(() => window.__testTerminal.buffer.active.length > 100);
      let revision = 0; live = setInterval(() => fixture.setScreen(0, history + 'Live ' + ++revision), 80);
    }
    // Deliberately omit pointer events. These previously got stopped without
    // ever starting a gesture, leaving both scrolling and selection inert.
    const touch = (type, point, selector = '#terminal canvas') => frame.evaluate(({ type, point, selector }) => {
      const target = document.querySelector(selector), contact = { identifier: 42, target, clientX: point.x, clientY: point.y };
      const touches = type === 'touchend' || type === 'touchcancel' ? [] : [contact];
      // Linux WebKit exposes Touch but does not allow constructing one. Replay
      // the event's lists explicitly; native taps are checked separately below.
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: [contact] } });
      target.dispatchEvent(event);
    }, { type, point, selector });
    const pointer = (type, point = { x: 150, y: 180 }) => frame.evaluate(({ type, point }) => document.querySelector('#terminal canvas').dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 42, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y })), { type, point });
    const start = { x: 150, y: 180 }, end = { x: 150, y: 280 };
    await touch('touchstart', start); await touch('touchmove', end);
    assert.ok(await frame.evaluate(() => window.__testTerminal.getViewportY() > 0), 'Touch-only dragging must scroll ' + (herdr ? 'Herdr' : 'the normal terminal'));
    await touch('touchend', end); await touch('touchstart', start); await touch('touchcancel', start);
    // Pointer cancellation must not cancel the continuing touch stream.
    await frame.evaluate(() => window.__testTerminal.scrollToBottom());
    await pointer('pointerdown'); await touch('touchstart', start); await pointer('pointercancel'); await pointer('lostpointercapture');
    await touch('touchmove', end); await touch('touchend', end); await touch('touchstart', start); await touch('touchcancel', start);
    assert.ok(await frame.evaluate(() => window.__testTerminal.getViewportY() > 0), 'Touch scrolling survives pointer cancellation');
    await frame.evaluate(() => window.__testTerminal.scrollToBottom());
    await touch('touchstart', start); await pointer('pointerdown'); await pointer('pointercancel');
    await touch('touchmove', end); await touch('touchend', end); await touch('touchstart', start); await touch('touchcancel', start);
    assert.ok(await frame.evaluate(() => window.__testTerminal.getViewportY() > 0), 'Touch-first event ordering must also keep touch ownership');
    const word = await frame.evaluate(() => {
      const t = window.__testTerminal, b = t.buffer.active, rect = document.querySelector('#terminal canvas').getBoundingClientRect(), top = b.length - t.rows - Math.floor(t.getViewportY());
      for (let row = 1; row < t.rows - 2; row++) { const col = b.getLine(top + row)?.translateToString(true).indexOf('alpha') ?? -1; if (col >= 0) return { x: rect.x + (col + .5) * rect.width / t.cols, y: rect.y + (row + .5) * rect.height / t.rows, cell: rect.width / t.cols }; }
      throw new Error('No visible alpha');
    });
    await touch('touchstart', word); await pointer('pointercancel'); await delay(450); await touch('touchend', word);
    await frame.waitForFunction(() => window.__copies.at(-1) === 'alpha');
    assert.ok(await frame.locator('.terminal-selection span').count(), 'Long press highlights the selected word');
    await touch('touchstart', word); await touch('touchmove', { ...word, x: word.x + 9 * word.cell }); await touch('touchend', { ...word, x: word.x + 9 * word.cell });
    await frame.waitForFunction(() => window.__copies.at(-1) === 'alpha beta');
    const handle = await frame.locator('.selection-handle').last().evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const endHandle = '.selection-handle[aria-label="Selection end"]';
    await touch('touchstart', handle, endHandle); await touch('touchmove', { ...handle, x: handle.x + 6 * word.cell }, endHandle); await touch('touchend', { ...handle, x: handle.x + 6 * word.cell }, endHandle);
    await frame.waitForFunction(() => window.__copies.at(-1) === 'alpha beta gamma');
    await frame.evaluate(() => window.__testTerminal.scrollToBottom());
    for (const [needle, expected] of [['https://example.com/touch', 'https://example.com/touch'], ['Open help', 'https://example.com/help']]) {
      const linkPoint = () => frame.evaluate(needle => {
        const t = window.__testTerminal, b = t.buffer.active, r = document.querySelector('#terminal canvas').getBoundingClientRect(), top = b.length - t.rows;
        for (let row = 0; row < t.rows; row++) { const col = b.getLine(top + row)?.translateToString(true).indexOf(needle) ?? -1; if (col >= 0) return { x: r.x + (col + .5) * r.width / t.cols, y: r.y + (row + .5) * r.height / t.rows }; } throw new Error('Missing link');
      }, needle);
      const point = await linkPoint();
      await touch('touchstart', point); await touch('touchend', point);
      assert.equal(await frame.evaluate(() => window.__opened.at(-1)?.[0]), expected, 'Touch-only taps activate terminal links');
      const count = await frame.evaluate(() => window.__opened.length);
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const nativePoint = await linkPoint(), frameBounds = await page.locator('iframe').boundingBox();
      await page.touchscreen.tap(frameBounds.x + nativePoint.x, frameBounds.y + nativePoint.y);
      await frame.waitForFunction(count => window.__opened.length >= count + 1, count).catch(async error => {
        console.error('Native link tap:', { herdr, needle, nativePoint, frameBounds, observed: await frame.evaluate(() => ({ opened: window.__opened, events: window.__nativeTouches,
          viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale }, rows: window.__testTerminal.rows, cols: window.__testTerminal.cols, scroll: window.__testTerminal.getViewportY() })) });
        throw error;
      });
      assert.equal(await frame.evaluate(() => window.__opened.length), count + 1, 'Native pointer/touch delivery opens a link exactly once');
      assert.equal(await frame.evaluate(() => window.__opened.at(-1)?.[0]), expected);
    }
    const edge = await frame.locator('.terminal-scrollbar').evaluate(el => { const r = el.getBoundingClientRect(), thumb = el.firstChild.getBoundingClientRect(); return { x: r.right - 10, y: thumb.y + thumb.height / 2, top: r.y + thumb.height / 2 }; });
    await touch('touchstart', edge, '.terminal-scrollbar'); await touch('touchmove', { ...edge, y: edge.top }, '.terminal-scrollbar'); await touch('touchend', { ...edge, y: edge.top }, '.terminal-scrollbar');
    assert.equal(await frame.evaluate(() => window.__testTerminal.getViewportY()), await frame.evaluate(() => window.__testTerminal.buffer.active.length - window.__testTerminal.rows), 'Touch-only scrollbar dragging reaches the oldest history');
    assert.equal(await frame.locator('#terminal textarea').evaluate(el => el === document.activeElement), false);
    assert.deepEqual(await frame.evaluate(() => window.__inputs), [], 'Reading gestures must not send terminal input');
    assert.deepEqual(errors, []); clearInterval(live); live = undefined;
    await context.close();
  }
  console.log('PASS: ' + (safari ? 'WebKit' : 'Chromium') + ' touch-only and cancelled-pointer scrolling, hold/drag copying, selection handles and plain/OSC-8 links share the normal/Herdr iframe gesture path during live updates.');
} finally {
  clearInterval(live); await browser?.close(); server.kill(); await exited; await fixture.close();
}
