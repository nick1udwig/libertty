import { launchBrowser, freePort, waitForBackend, pair } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import { herdrFixture } from './herdr-fixture.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';

const fixture = await herdrFixture(), root = new URL('../', import.meta.url).pathname;
const base = 'http://127.0.0.1:' + await freePort();
const history = Array.from({ length: 160 }, () => 'alpha beta gamma').join('\n');
fixture.setScreen(0, history);
const server = spawn(root + 'target/debug/libertty', [], { cwd: root, stdio: 'ignore', env: { ...process.env,
  NODE_ENV: 'production', HOST: '127.0.0.1', PORT: new URL(base).port, LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_ALLOWED_ORIGINS: base,
  LIBERTTY_DATA_DIR: fixture.directory + '/libertty', HOME: fixture.directory, LIBERTTY_CWD: fixture.directory, LIBERTTY_TOKEN: '',
  LIBERTTY_NO_RC: '1', HERDR_SOCKET_PATH: fixture.socketPath, PATH: fixture.directory + ':' + process.env.PATH,
} });
const exited = once(server, 'exit');
let browser;
try {
  await waitForBackend(base, server);
  const accessToken = await pair(base, (await readFile(fixture.directory + '/libertty/pairing-token', 'utf8')).trim());
  await mkdir(root + '.test-artifacts', { recursive: true });
  browser = await launchBrowser();
  for (const herdr of [false, true]) for (const theme of ['forest', 'paper', 'ink', '1776', 'flag']) {
    const label = (herdr ? 'herdr' : 'terminal') + '-' + theme;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    await installWireObserver(context);
    // Keep optional dictation setup from intercepting selection touches on clean backends.
    await context.route(url => url.pathname.endsWith('/api/dictation'), route => route.fulfill({ json: { installed: true, available: true } }));
    await context.addInitScript(({ accessToken, theme }) => {
      localStorage.setItem('libertty.theme', JSON.stringify(theme));
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copies.push(text); } } });
      const Original = WebSocket;
      window.WebSocket = class extends Original { constructor(...args) { super(...args); this.addEventListener('message', async event => { const message = await window.__wireMessage(event.data, this); if (message.type === 'state') window.__state = message.state; }); } };
      if (parent === window) addEventListener('message', event => { if (event.data?.type === 'terminal-loaded') event.source.postMessage({ type: 'authorize', accessToken }, location.origin); });
    }, { accessToken, theme });
    await context.route('**/assets/terminal-*.js', async route => {
      const response = await route.fetch(), original = await response.text();
      const body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__terminal=new $1({ghostty:');
      assert.notEqual(body, original); await route.fulfill({ response, body });
    });
    let session = 'selection-herdr';
    if (!herdr) {
      const response = await fetch(base + '/api/sessions', { method: 'POST', headers: { Origin: base, Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: label }) });
      assert.ok(response.ok); session = (await response.json()).id;
    }
    const params = new URLSearchParams({ embedded: '1', session, ...(herdr ? { herdrTerminal: 'term_0' } : {}) });
    await context.route('**/selection-fixture.html', route => route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style><iframe src="/terminal.html?${params}" allow="clipboard-write"></iframe>` }));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.goto(base + '/selection-fixture.html');
    const frame = page.frames().find(frame => frame.url().includes('terminal.html'));
    await frame.waitForFunction(() => window.__terminal && document.querySelector('#connection-label').textContent === 'Connected' && (window.__state?.ready || window.__state?.inputTarget === 'program'));
    if (!herdr) await frame.evaluate(history => window.__terminal.write('\x1bc\x1b[3J' + history.replaceAll('\n', '\r\n')), history);
    await frame.waitForFunction(() => window.__terminal.buffer.active.length > 100);
    assert.equal(await frame.evaluate(() => document.documentElement.dataset.theme || 'forest'), theme);
    const word = await frame.evaluate(() => {
      const t = window.__terminal, b = t.buffer.active, rect = document.querySelector('#terminal canvas').getBoundingClientRect(), top = b.length - t.rows;
      for (let row = Math.floor(t.rows / 3); row < t.rows - 2; row++) {
        const col = b.getLine(top + row)?.translateToString(true).indexOf('alpha') ?? -1;
        if (col >= 0) return { x: rect.x + col * rect.width / t.cols, y: rect.y + row * rect.height / t.rows, width: 5 * rect.width / t.cols, height: rect.height / t.rows };
      }
      throw new Error('No visible selection fixture');
    });
    const bounds = await page.locator('iframe').boundingBox();
    const clip = { x: Math.ceil(bounds.x + word.x) + 2, y: Math.ceil(bounds.y + word.y) + 2, width: Math.floor(word.width) - 4, height: Math.floor(word.height) - 4 };
    const before = await page.screenshot({ clip });
    const cdp = await context.newCDPSession(page);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + word.x + word.width / 2, y: bounds.y + word.y + word.height / 2 }] });
    await page.clock.runFor(400);
    await page.clock.resume();
    await frame.locator('.terminal-selection span').waitFor({ state: 'visible' });
    const selected = await page.screenshot({ clip, path: root + '.test-artifacts/selection-' + label + '.png' });
    const pixels = await page.evaluate(async images => {
      const read = async encoded => {
        const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data;
      };
      const [before, selected] = await Promise.all(images.map(read));
      let min = 1, max = 0, difference = 0;
      const linear = value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; };
      for (let i = 0; i < selected.length; i += 4) {
        const luminance = .2126 * linear(selected[i]) + .7152 * linear(selected[i + 1]) + .0722 * linear(selected[i + 2]);
        min = Math.min(min, luminance); max = Math.max(max, luminance);
        for (let c = 0; c < 3; c++) difference += Math.abs(selected[i + c] - before[i + c]);
      }
      return { contrast: (max + .05) / (min + .05), difference: difference / (selected.length / 4 * 3) };
    }, [before.toString('base64'), selected.toString('base64')]);
    assert.ok(pixels.contrast >= 4.5, label + ': selected glyph contrast ' + pixels.contrast.toFixed(2));
    assert.ok(pixels.difference > 5, label + ': selection must visibly tint the word');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await frame.waitForFunction(() => window.__copies.at(-1) === 'alpha');
    assert.deepEqual(errors, []);
    console.log('PASS ' + label + ': selected text contrast ' + pixels.contrast.toFixed(2) + ', visible tint and copied alpha.');
    await context.close();
  }
} finally {
  await browser?.close(); server.kill(); await exited; await fixture.close();
}
