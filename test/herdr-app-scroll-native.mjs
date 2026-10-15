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

const fixturePort3173 = await freePort();

const root = new URL('../', import.meta.url).pathname, dir = await mkdtemp('/tmp/termai-herdr-app-scroll-');
const target = { session: '', socketPath: dir + '/herdr.sock' }, base = 'http://127.0.0.1:' + fixturePort3173;
const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir + '/config', XDG_DATA_HOME: dir + '/data', XDG_STATE_HOME: dir + '/state', HERDR_SOCKET_PATH: target.socketPath, HERDR_SESSION: '', HERDR_ENV: '', SHELL: '/bin/bash', TERM: 'xterm-256color' };
const state = async () => { try { return JSON.parse(await readFile(dir + '/state.json', 'utf8')); } catch { return {}; } };
let herdr, desktop, backend, browser;
try {
  await mkdir(dir + '/config', { recursive: true });
  // A generic fullscreen TUI: its transcript lives in the application, while
  // the terminal's alternate buffer has no scrollback. No Codex heuristics.
  await writeFile(dir + '/app.mjs', `
    import { writeFileSync } from 'node:fs';
    let offset = 0, wheels = 0, tick = 0, pending = '';
    const title = () => 'Application transcript TICK:' + String(tick).padStart(6, '0');
    const draw = () => { const cols = process.stdout.columns, rows = process.stdout.rows;
      writeFileSync(${JSON.stringify(dir + '/state.json')}, JSON.stringify({ cols, rows, offset, wheels }));
      let screen = '\\x1b[2J\\x1b[H' + title() + '\\r\\n';
      for (let row = 0; row < rows - 7; row++) screen += (row === 1 ? '\\x1b]8;;https://example.com/help\\x07Open help\\x1b]8;;\\x07'
        : row === 2 ? 'https://example.com/tui' : 'ROW-' + (100 - offset + row) + ' alpha beta gamma') + '\\r\\n';
      screen += '╭' + '─'.repeat(cols - 2) + '╮\\r\\n│ › type here' + ' '.repeat(Math.max(0, cols - 14)) + '│\\r\\n╰' + '─'.repeat(cols - 2) + '╯';
      process.stdout.write(screen + '\\x1b[' + (rows - 4) + ';5H\\x1b[?25h'); };
    process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h');
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', data => {
      pending += data; const events = [...pending.matchAll(/\\x1b\\[<(\\d+);(\\d+);(\\d+)[Mm]/g)];
      for (const event of events) { const button = Number(event[1]); if (button === 64) offset = Math.min(90, offset + 1); if (button === 65) offset = Math.max(0, offset - 1); wheels++; }
      if (events.length) { pending = pending.slice(events.at(-1).index + events.at(-1)[0].length); draw(); }
      if (pending.includes('\\x03')) process.exit();
    });
    draw(); process.on('SIGWINCH', () => setImmediate(draw));
    setInterval(() => { tick++; process.stdout.write('\\x1b[1;1H' + title() + '\\x1b[' + (process.stdout.rows - 4) + ';5H'); }, 30);
  `);
  herdr = spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', ['server'], { cwd: dir, env, stdio: 'ignore' });
  await wait(async () => { try { await herdrSnapshot(target); return true; } catch { return false; } }, 'isolated Herdr');
  desktop = pty.spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', [], { cwd: dir, env, cols: 150, rows: 45, name: 'xterm-256color' }); desktop.onData(() => {});
  const created = await herdrRequest(target, 'workspace.create', { cwd: dir, label: 'App scroll fixture', focus: true });
  const terminal = (await herdrSnapshot(target)).terminals.find(t => t.workspaceId === created.workspace.workspace_id); assert.ok(terminal);
  await delay(400); await herdrRequest(target, 'pane.send_text', { pane_id: terminal.paneId, text: "printf 'SHELL HISTORY\\n%.0s' {1..160}\r" });
  await wait(async () => (await herdrRequest(target, 'pane.read', { pane_id: terminal.paneId, source: 'recent_unwrapped', lines: 1000, format: 'ansi' })).read.text.includes('SHELL HISTORY'), 'native shell history');
  backend = spawn(new URL('../target/debug/termai', import.meta.url).pathname, [], { cwd: root, env: { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(fixturePort3173), TERMAI_BASE_PATH: '/', TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_ALLOWED_ORIGINS: base, TERMAI_DATA_DIR: dir + '/termai', TERMAI_TOKEN: '', TERMAI_NO_RC: '1', TERMAI_CWD: dir }, stdio: 'ignore' });
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'isolated backend');
  const token = (await readFile(dir + '/termai/pairing-token', 'utf8')).trim();
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await installBackgroundGrace(context);
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await installWireObserver(context);
  await context.addInitScript(() => {
    window.__dropScreens = false; window.__frames = 0; window.__deltas = 0; window.__screens = 0; window.__historyDeltas = 0;
    window.WebSocket = class extends WebSocket {
      send(data) {
        if (window.__holdAcks && window.__wireSent(data).type === 'ack') {
          window.__releaseFrames = () => super.send(data);
          return;
        }
        super.send(data);
      }
      set onmessage(handler) {
        window.__receive = message => handler.call(this, { data: JSON.stringify(message) });
        super.onmessage = async event => {
          const message = await window.__wireMessage(event.data, this);
          if (message.type === 'herdr-frame') { window.__frames++; if (!message.full) window.__deltas++; }
          if (message.type === 'screen') { if (message.delta) window.__historyDeltas++; window.__screens++; window.__lastScreen = message; if (window.__dropScreens) return; }
          handler.call(this, event);
        };
      }
    };
  });
  await context.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Native terminal link</title>' }));
  await context.route('**/assets/terminal-*.js', async route => {
    const response = await route.fetch(), original = await response.text(), body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__terminal=new $1({ghostty:');
    assert.notEqual(body, original); await route.fulfill({ response, body });
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/terminal.html?herdrTerminal=' + terminal.terminalId);
  await page.locator('#token').fill(token); await page.locator('#login-form button[type=submit]').click();
  await page.waitForFunction(() => window.__terminal && document.querySelector('#connection-label').textContent === 'Connected');
  await page.waitForFunction(() => window.__terminal.buffer.active.length > window.__terminal.rows);
  await herdrRequest(target, 'pane.send_text', { pane_id: terminal.paneId, text: [process.execPath, dir + '/app.mjs'].map(shellQuote).join(' ') + '\r' });
  await wait(async () => (await state()).cols === await page.evaluate(() => window.__terminal.cols), 'mobile app geometry');
  await page.waitForFunction(() => window.__terminal.buffer.active.getLine(1)?.translateToString(true).includes('ROW-100'));
  assert.ok((await herdrSnapshot(target)).terminals.some(item => item.terminalId === terminal.terminalId));
  const pane = await herdrRequest(target, 'pane.get', { pane_id: terminal.paneId }); assert.equal(pane.pane.scroll.max_offset_from_bottom, 0);
  assert.equal(await page.evaluate(() => window.__terminal.buffer.active.length), await page.evaluate(() => window.__terminal.rows));
  await page.waitForFunction(() => window.__screens > 1 && window.__historyDeltas > 0 && window.__lastScreen.text.includes('TICK:'));
  // Prove text uses native deltas, not the 150 ms snapshot loop: withhold all
  // history messages while sampling the displayed animation on browser paints.
  const animation = await page.evaluate(async () => {
    window.__dropScreens = true;
    window.__staleScreen = window.__lastScreen;
    const values = new Set(), start = performance.now(), frames = window.__frames, deltas = window.__deltas;
    await new Promise(resolve => {
      const sample = () => {
        const tick = window.__terminal.buffer.active.getLine(0)?.translateToString(true).match(/TICK:(\d+)/)?.[1];
        if (tick) values.add(tick);
        if (performance.now() - start < 1500) requestAnimationFrame(sample); else resolve();
      };
      requestAnimationFrame(sample);
    });
    return { paints: values.size, frames: window.__frames - frames, deltas: window.__deltas - deltas };
  });
  assert.ok(animation.paints >= 15, 'Live text keeps animating faster than the snapshot ceiling: ' + JSON.stringify(animation));
  assert.ok(animation.deltas > 0, 'Incremental native frames render without needing a new full snapshot');
  await page.evaluate(() => { window.__holdAcks = true; });
  await delay(250);
  const held = await page.evaluate(() => ({ frames: window.__frames, tick: Number(window.__terminal.buffer.active.getLine(0).translateToString(true).match(/TICK:(\d+)/)?.[1]) }));
  await delay(1500);
  assert.equal(await page.evaluate(() => window.__frames), held.frames, 'The two-frame acknowledgement window stops stale frames from queueing');
  await page.evaluate(() => { window.__holdAcks = false; window.__releaseFrames(); });
  await page.waitForFunction(tick => Number(window.__terminal.buffer.active.getLine(0).translateToString(true).match(/TICK:(\d+)/)?.[1]) > tick + 30, held.tick, { timeout: 1500 });
  assert.equal(await page.locator('#connection-label').textContent(), 'Connected', 'Backpressure does not reconnect a slow viewer');
  assert.equal(await page.evaluate(() => {
    const t = window.__terminal, before = t.buffer.active.getLine(0)?.translateToString(true);
    window.__receive(window.__staleScreen);
    return t.buffer.active.getLine(0)?.translateToString(true) === before;
  }), true, 'A delayed history snapshot cannot roll live text back');
  assert.deepEqual(await page.evaluate(() => ({ x: window.__terminal.buffer.active.cursorX, y: window.__terminal.buffer.active.cursorY })),
    { x: 4, y: await page.evaluate(() => window.__terminal.rows - 5) }, 'Live deltas retain the native composer cursor');
  await page.evaluate(() => { window.__dropScreens = false; });
  const cdp = await context.newCDPSession(page), touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 1 }] });
  for (const [row, url] of [[2, 'https://example.com/help'], [3, 'https://example.com/tui']]) {
    const point = await page.evaluate(row => { const t = window.__terminal, r = document.querySelector('#terminal canvas').getBoundingClientRect(); return { x: r.x + 1.5 * r.width / t.cols, y: r.y + (row + .5) * r.height / t.rows }; }, row);
    const opened = context.waitForEvent('page'); await touch('touchStart', point.x, point.y); await touch('touchEnd');
    const popup = await opened; await popup.waitForLoadState(); assert.equal(popup.url(), url);
    assert.equal(await popup.evaluate(() => window.opener), null, 'Opened links cannot access the terminal');
    await popup.close(); await page.bringToFront();
  }
  const drag = async (from, to) => { await touch('touchStart', 150, from); for (let i = 1; i <= 5; i++) { await delay(25); await touch('touchMove', 150, from + (to - from) * i / 5); } await delay(120); await touch('touchEnd'); };
  await drag(180, 300);
  await wait(async () => (await state()).offset > 3, 'touch scroll reaches app wheel handler');
  const older = await state(); assert.ok(older.wheels > 3, 'Fast drags deliver multiple native wheel events');
  await page.waitForFunction(() => !window.__terminal.buffer.active.getLine(1)?.translateToString(true).includes('ROW-100'));
  assert.equal(await page.evaluate(() => window.__terminal.getViewportY()), 0, 'The application, rather than local scrollback, moves');
  // Holding the displayed app text must continue to use local selection/copy.
  const word = await page.evaluate(() => { const t = window.__terminal, r = document.querySelector('#terminal canvas').getBoundingClientRect(), col = t.buffer.active.getLine(1).translateToString(true).indexOf('alpha'); return { x: r.x + (col + .5) * r.width / t.cols, y: r.y + 1.5 * r.height / t.rows }; });
  await touch('touchStart', word.x, word.y); await delay(450); await touch('touchEnd'); await page.locator('.selection-notice').filter({ hasText: 'Copied 5 characters' }).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'alpha');
  assert.equal((await state()).offset, older.offset, 'Selecting does not scroll the app');
  await drag(300, 180); await wait(async () => (await state()).offset < older.offset, 'reverse drag scrolls toward latest output');
  assert.equal(await page.locator('#terminal textarea').evaluate(el => el === document.activeElement), false);
  // Join the already-running controller at the same size, after its cached
  // full frame has been superseded by deltas. The new pane must obtain its own
  // complete baseline without changing the existing mobile owner's geometry.
  await delay(150);
  const geometry = await state(), joined = await context.newPage();
  joined.on('pageerror', error => errors.push(error.message));
  await joined.goto(base + '/terminal.html?herdrTerminal=' + terminal.terminalId);
  await joined.waitForFunction(() => window.__terminal && window.__deltas > 0 && window.__lastScreen?.text.includes('TICK:'));
  const joinedAnimation = await joined.evaluate(async () => {
    window.__dropScreens = true;
    const values = new Set(), start = performance.now();
    await new Promise(resolve => {
      const sample = () => {
        const tick = window.__terminal.buffer.active.getLine(0)?.translateToString(true).match(/TICK:(\d+)/)?.[1];
        if (tick) values.add(tick);
        if (performance.now() - start < 900) requestAnimationFrame(sample); else resolve();
      };
      requestAnimationFrame(sample);
    });
    return values.size;
  });
  assert.ok(joinedAnimation >= 9, 'A joining pane keeps rendering from its refreshed baseline without snapshots: ' + joinedAnimation);
  assert.deepEqual({ cols: (await state()).cols, rows: (await state()).rows }, { cols: geometry.cols, rows: geometry.rows });
  await joined.close();
  // Reopen a fullscreen alternate-buffer app after releasing mobile ownership.
  await page.bringToFront();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); window.__expireBackground();
  });
  await wait(async () => (await state()).cols > geometry.cols, 'background restores desktop geometry');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__terminal?.buffer.active.getLine(0)?.translateToString(true).includes('Application transcript') && document.querySelector('#connection-label').textContent === 'Connected');
  await page.reload();
  await page.waitForFunction(() => window.__terminal?.buffer.active.getLine(0)?.translateToString(true).includes('Application transcript') && document.querySelector('#connection-label').textContent === 'Connected');
  const tick = await page.evaluate(() => window.__terminal.buffer.active.getLine(0).translateToString(true));
  await page.waitForFunction(before => window.__terminal.buffer.active.getLine(0).translateToString(true) !== before, tick);
  if (process.env.TEST_LINK === 'lossy') {
    await page.evaluate(() => { window.__linkProfile.enabled = true; });
    await page.waitForFunction(() => window.__linkProfile.losses > 0);
    const before = await page.evaluate(() => Number(window.__terminal.buffer.active.getLine(0).translateToString(true).match(/TICK:(\d+)/)?.[1]));
    await page.waitForFunction(before => Number(window.__terminal.buffer.active.getLine(0).translateToString(true).match(/TICK:(\d+)/)?.[1]) > before + 10, before);
    let heldTicket, release;
    const gate = new Promise(resolve => release = resolve);
    const hold = async route => { if (!heldTicket) { heldTicket = route; await gate; } await route.continue().catch(() => {}); };
    await page.route('**/api/herdr/ticket?**', hold);
    const started = Date.now();
    const stalledTick = await page.evaluate(() => {
      const tick = Number(window.__terminal.buffer.active.getLine(0).translateToString(true).match(/TICK:(\d+)/)?.[1]);
      window.__linkProfile.pause(5500); return tick;
    });
    try {
      await page.waitForFunction(() => document.querySelector('#connection-label').textContent.startsWith('Connection stalled'), undefined, { timeout: 8000 });
      await wait(() => !!heldTicket, 'replacement ticket during the outage');
      assert.equal(await page.locator('.terminal-presentation').isVisible(), true, 'An outage retains the previous terminal picture');
    } finally { release(); await page.unroute('**/api/herdr/ticket?**', hold); }
    await page.waitForFunction(tick => document.querySelector('#connection-label').textContent === 'Connected' && document.querySelector('.terminal-presentation').hidden
      && Number(window.__terminal.buffer.active.getLine(0).translateToString(true).match(/TICK:(\d+)/)?.[1]) > tick + 150, stalledTick, { timeout: 12000 });
    const recoveryMs = Date.now() - started;
    assert.ok(recoveryMs < 8500, 'The recovered screen must catch up within three seconds of signal returning: ' + recoveryMs);
    const link = await page.evaluate(() => { window.__linkProfile.enabled = false; const { messages, losses, stalls } = window.__linkProfile; return { messages, losses, stalls }; });
    assert.ok(link.losses > 0 && link.stalls === 1);
    await writeFile(root + '.test-artifacts/herdr-lossy-link.json', JSON.stringify({ ...link, outageMs: 5500, recoveryMs }, null, 2));
    console.log('PASS lossy gzip Herdr: ordered retransmission delays, retained picture during a silent outage, replacement connection, and fresh-screen catch-up in ' + recoveryMs + ' ms.');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: real Herdr live animation rendered ' + animation.paints + ' distinct updates in 1.5 s with history withheld; shell-to-TUI/joining baselines, incremental frames, stale snapshots, cursor, native touch scrolling, hold/copy, plain/OSC-8 links and keyboard behavior and fullscreen background/reopen recovery passed.');
} finally {
  await browser?.close(); if (backend) { const exited = once(backend, 'exit'); backend.kill(); await exited; }
  const stopped = herdr && herdr.exitCode === null && herdr.signalCode === null ? once(herdr, 'exit') : null;
  desktop?.kill(); await herdrRequest(target, 'server.stop').catch(() => {}); herdr?.kill(); await stopped;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
