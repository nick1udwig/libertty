import { launchBrowser, freePort } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';
import { herdrFixture } from './herdr-fixture.ts';

const fixturePort3183 = await freePort();

const fixture = await herdrFixture(), root = new URL('../', import.meta.url).pathname;
const wrappedURL = 'https://example.com/' + 'wrapped/'.repeat(12) + 'end?q=1';
const base = 'http://127.0.0.1:' + fixturePort3183, history = Array.from({ length: 160 }, (_, i) => `ROW-${i} alpha beta gamma`).join('\n')
  + '\nRead https://example.com/touch\nWRAPPED ' + wrappedURL + '\n\x1b]8;;https://example.com/help\x07Open help\x1b]8;;\x07\n';
fixture.setScreen(0, history);
const server = spawn(new URL('../target/debug/libertty', import.meta.url).pathname, [], { cwd: root, stdio: 'ignore', env: { ...process.env,
  NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(fixturePort3183), LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_ALLOWED_ORIGINS: base,
  LIBERTTY_DATA_DIR: fixture.directory + '/libertty', HOME: fixture.directory, LIBERTTY_CWD: fixture.directory, LIBERTTY_TOKEN: '',
  LIBERTTY_NO_RC: '1', HERDR_SOCKET_PATH: fixture.socketPath, PATH: fixture.directory + ':' + process.env.PATH,
} });
const exited = once(server, 'exit'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, live;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(base).then(r => r.ok, () => false)) break; await delay(100); }
  const token = (await readFile(fixture.directory + '/libertty/pairing-token', 'utf8')).trim();
  const response = await fetch(base + '/api/connect', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, noSession: true }) });
  assert.ok(response.ok); const { accessToken } = await response.json();
  const safari = process.env.TEST_BROWSER === 'webkit';
  browser = await (safari ? webkit.launch() : launchBrowser({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=gl'] }));
  for (const herdr of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    await installWireObserver(context);
    await context.route(url => url.pathname.endsWith('/api/dictation'), route => route.fulfill({ json: { installed: true, available: true } }));
  await context.addInitScript(({ accessToken }) => {
      window.__copies = []; window.__inputs = []; window.__opened = [];
      window.__nativeTouches = [];
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel']) document.addEventListener(type, event => {
        if (event.isTrusted) window.__nativeTouches.push({ type, at: event.timeStamp, target: { tag: event.target?.tagName, id: event.target?.id, class: event.target?.className }, x: event.clientX, y: event.clientY, primary: event.isPrimary, pointer: event.pointerType,
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
    await page.clock.install();
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
    const contacts = (events, measure = false) => frame.evaluate(({ events, measure }) => {
      const canvas = document.querySelector('#terminal canvas'), bounds = canvas.getBoundingClientRect;
      let measurements = 0;
      if (measure) canvas.getBoundingClientRect = function () { measurements++; return bounds.call(this); };
      try {
        for (const { type, point, selector = '#terminal canvas' } of events) {
          const target = document.querySelector(selector);
          if (type.startsWith('touch')) {
            const contact = { identifier: 42, target, clientX: point.x, clientY: point.y };
            const touches = type === 'touchend' || type === 'touchcancel' ? [] : [contact];
            // Linux WebKit exposes Touch but does not allow constructing one.
            // Native taps are checked separately below.
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: [contact] } });
            target.dispatchEvent(event);
          } else target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 42, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y }));
        }
      } finally { if (measure) canvas.getBoundingClientRect = bounds; }
      return measurements;
    }, { events, measure });
    const touch = (type, point, selector = '#terminal canvas') => contacts([{ type, point, selector }]);
    const start = { x: 150, y: 180 }, end = { x: 150, y: 280 };
    const idleWork = await frame.evaluate(() => {
      const term = window.__testTerminal, canvas = document.querySelector('#terminal canvas'), highlights = document.querySelector('.terminal-selection');
      const bounds = canvas.getBoundingClientRect, replace = highlights.replaceChildren;
      let measurements = 0, replacements = 0;
      canvas.getBoundingClientRect = function () { measurements++; return bounds.call(this); };
      highlights.replaceChildren = function (...nodes) { replacements++; return replace.apply(this, nodes); };
      try { for (let i = 0; i < 12; i++) term.scrollLines(-1); }
      finally { canvas.getBoundingClientRect = bounds; highlights.replaceChildren = replace; }
      return { measurements, replacements };
    });
    assert.deepEqual(idleWork, { measurements: 0, replacements: 0 }, 'Scrolling without a selection does no overlay layout or DOM rebuilding');
    await frame.evaluate(() => window.__testTerminal.scrollToBottom());
    const measurements = await contacts([
      { type: 'touchstart', point: start },
      ...Array.from({ length: 12 }, (_, i) => ({ type: 'touchmove', point: { x: start.x, y: start.y + (i + 1) * 8 } })),
      { type: 'touchcancel', point: end },
    ], true);
    assert.equal(measurements, 1, 'A twelve-move scroll gesture measures the canvas only once');
    assert.ok(await frame.evaluate(() => window.__testTerminal.getViewportY() > 0), 'Cached geometry still scrolls terminal history');
    await contacts([{ type: 'touchstart', point: start }, { type: 'touchmove', point: end }]);
    const rows = await frame.evaluate(() => { const term = window.__testTerminal, rows = term.rows; term.resize(term.cols, rows - 1); return rows; });
    const resizedMeasurements = await contacts([{ type: 'touchmove', point: { x: end.x, y: end.y + 8 } }, { type: 'touchcancel', point: end }], true);
    assert.equal(resizedMeasurements, 0, 'Resizing cancels the active gesture');
    const freshMeasurements = await contacts([{ type: 'touchstart', point: start }, { type: 'touchmove', point: end }, { type: 'touchcancel', point: end }], true);
    assert.equal(freshMeasurements, 1, 'A new gesture after resize measures the updated canvas');
    await frame.evaluate(rows => window.__testTerminal.resize(window.__testTerminal.cols, rows), rows);
    await frame.evaluate(() => window.__testTerminal.scrollToBottom());
    // Keep synthetic drag sequences in one browser turn so slow test-driver
    // round trips cannot turn them into a 350ms long press.
    const drag = types => contacts(types.map(type => ({ type, point: type === 'touchmove' || type === 'touchend' ? end : start })));
    await drag(['touchstart', 'touchmove']);
    assert.ok(await frame.evaluate(() => window.__testTerminal.getViewportY() > 0), 'Touch-only dragging must scroll ' + (herdr ? 'Herdr' : 'the normal terminal'));
    await drag(['touchend', 'touchstart', 'touchcancel']);
    // Pointer cancellation must not cancel the continuing touch stream.
    await frame.evaluate(() => window.__testTerminal.scrollToBottom());
    await drag(['pointerdown', 'touchstart', 'pointercancel', 'lostpointercapture', 'touchmove', 'touchend', 'touchstart', 'touchcancel']);
    assert.ok(await frame.evaluate(() => window.__testTerminal.getViewportY() > 0), 'Touch scrolling survives pointer cancellation');
    await frame.evaluate(() => window.__testTerminal.scrollToBottom());
    await drag(['touchstart', 'pointerdown', 'pointercancel', 'touchmove', 'touchend', 'touchstart', 'touchcancel']);
    assert.ok(await frame.evaluate(() => window.__testTerminal.getViewportY() > 0), 'Touch-first event ordering must also keep touch ownership');
    const word = await frame.evaluate(() => {
      const t = window.__testTerminal, b = t.buffer.active, rect = document.querySelector('#terminal canvas').getBoundingClientRect(), top = b.length - t.rows - Math.floor(t.getViewportY());
      for (let row = Math.floor(t.rows / 3); row < t.rows - 2; row++) {
        const y = rect.y + (row + .5) * rect.height / t.rows;
        const col = b.getLine(top + row)?.translateToString(true).indexOf('alpha') ?? -1;
        if (col >= 0 && y > rect.top + 40 && y < rect.bottom - 40) return { x: rect.x + (col + .5) * rect.width / t.cols, y, cell: rect.width / t.cols };
      }
      throw new Error('No visible alpha');
    });
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    await contacts([{ type: 'touchstart', point: word }, { type: 'pointercancel', point: word }]);
    await page.clock.runFor(400);
    await touch('touchend', word);
    await page.clock.resume();
    await frame.waitForFunction(() => window.__copies.at(-1) === 'alpha');
    assert.ok(await frame.locator('.terminal-selection span').count(), 'Long press highlights the selected word');
    await contacts([{ type: 'touchstart', point: word }, { type: 'touchmove', point: { ...word, x: word.x + 9 * word.cell } }, { type: 'touchend', point: { ...word, x: word.x + 9 * word.cell } }]);
    await frame.waitForFunction(() => window.__copies.at(-1) === 'alpha beta');
    const handle = await frame.locator('.selection-handle').last().evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const endHandle = '.selection-handle[aria-label="Selection end"]';
    await contacts([{ type: 'touchstart', point: handle, selector: endHandle }, { type: 'touchmove', point: { ...handle, x: handle.x + 6 * word.cell }, selector: endHandle }, { type: 'touchend', point: { ...handle, x: handle.x + 6 * word.cell }, selector: endHandle }]);
    await frame.waitForFunction(() => window.__copies.at(-1) === 'alpha beta gamma');
    const selectionEdge = await frame.evaluate(x => ({ x, y: document.querySelector('#terminal canvas').getBoundingClientRect().top + 1 }), word.x + 9 * word.cell);
    const beforeEdge = await frame.evaluate(() => window.__testTerminal.getViewportY());
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    await contacts([{ type: 'touchstart', point: word }, { type: 'touchmove', point: { ...word, x: selectionEdge.x } }, { type: 'touchmove', point: selectionEdge }]);
    await page.clock.runFor(120);
    await frame.waitForFunction(before => window.__testTerminal.getViewportY() > before, beforeEdge);
    await touch('touchcancel', selectionEdge);
    const cancelledOffset = await frame.evaluate(() => window.__testTerminal.getViewportY());
    await page.clock.runFor(200);
    assert.ok(Math.abs(await frame.evaluate(() => window.__testTerminal.getViewportY()) - cancelledOffset) < 1e-6, 'Cancellation stops edge selection scrolling');
    await page.clock.resume();
    await frame.evaluate(() => window.__testTerminal.scrollToBottom());
    for (const [needle, expected, offset = 0] of [
      ['https://example.com/touch', 'https://example.com/touch'],
      ['WRAPPED https://', wrappedURL, 8],
      ['wrapped/', wrappedURL],
      ['Open help', 'https://example.com/help'],
    ]) {
      const linkPoint = () => frame.evaluate(({ needle, offset }) => {
        const t = window.__testTerminal, b = t.buffer.active, r = document.querySelector('#terminal canvas').getBoundingClientRect(), top = b.length - t.rows;
        for (let row = 0; row < t.rows; row++) { const col = b.getLine(top + row)?.translateToString(true).indexOf(needle) ?? -1; if (col >= 0) return { x: r.x + (col + offset + .5) * r.width / t.cols, y: r.y + (row + .5) * r.height / t.rows }; } throw new Error('Missing link');
      }, { needle, offset });
      const point = await linkPoint();
      await contacts([{ type: 'touchstart', point }, { type: 'touchend', point }]);
      assert.equal(await frame.evaluate(() => window.__opened.at(-1)?.[0]), expected, 'Touch-only taps activate terminal links');
      const count = await frame.evaluate(() => window.__opened.length);
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const nativePoint = await linkPoint(), frameBounds = await page.locator('iframe').boundingBox();
      await page.touchscreen.tap(frameBounds.x + nativePoint.x, frameBounds.y + nativePoint.y);
      await frame.waitForFunction(count => window.__opened.length >= count + 1, count).catch(async error => {
        console.error('Native link tap:', JSON.stringify({ herdr, needle, nativePoint, frameBounds, observed: await frame.evaluate(() => ({ opened: window.__opened, copies: window.__copies, events: window.__nativeTouches,
          viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale, ratio: devicePixelRatio }, screen: { width: screen.width, height: screen.height }, rows: window.__testTerminal.rows, cols: window.__testTerminal.cols, scroll: window.__testTerminal.getViewportY() })) }));
        throw error;
      });
      assert.equal(await frame.evaluate(() => window.__opened.length), count + 1, 'Native pointer/touch delivery opens a link exactly once');
      assert.equal(await frame.evaluate(() => window.__opened.at(-1)?.[0]), expected);
    }
    const edge = await frame.locator('.terminal-scrollbar').evaluate(el => { const r = el.getBoundingClientRect(), thumb = el.firstChild.getBoundingClientRect(); return { x: r.right - 10, y: thumb.y + thumb.height / 2, top: r.y + thumb.height / 2 }; });
    await contacts([{ type: 'touchstart', point: edge, selector: '.terminal-scrollbar' }, { type: 'touchmove', point: { ...edge, y: edge.top }, selector: '.terminal-scrollbar' }, { type: 'touchend', point: { ...edge, y: edge.top }, selector: '.terminal-scrollbar' }]);
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
