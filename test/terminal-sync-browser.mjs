import { launchBrowser, freePort, delay, until } from './support/browser.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'libertty-sync-'));
const port = Number(process.env.TEST_PORT || await freePort()), base = `http://127.0.0.1:${port}`;
const token = 'sync-test-pairing-token-123456789';
const server = spawn(new URL('../target/debug/libertty', import.meta.url).pathname, [], { cwd: root, env: { ...process.env, HOME: fixture, XDG_DATA_HOME: path.join(fixture, 'data'), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), LIBERTTY_TOKEN: token, LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_NO_RC: '1', LIBERTTY_CWD: fixture }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', browser;
server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(base).then(r => r.ok, () => false)) break;
    if (server.exitCode !== null) throw new Error(logs);
    await delay(100);
  }
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 900, height: 600 }, serviceWorkers: 'block' });
  // An unavailable dictation daemon would open its install dialog over the terminal.
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await context.route(/\/assets\/terminal-[A-Za-z0-9_-]{8}\.js$/, async route => {
    const response = await route.fetch(), original = await response.text();
    const body = original.replace(/new ([\w$]+)\(\{fontSize:/, 'window.__testTerminal=new $1({fontSize:');
    assert.notEqual(body, original); await route.fulfill({ response, body });
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base + '/terminal.html');
  await page.locator('#token').fill(token); await page.locator('#login-form button').click();
  await page.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Connected' && document.querySelector('#shell-status')?.textContent === 'At prompt');
  await delay(300);
  // Record what each paint shows, so a paint in the middle of an update is visible to the test.
  await page.evaluate(() => {
    const term = window.__testTerminal, paint = term.renderNow.bind(term);
    window.__paints = [];
    term.renderNow = () => {
      const buffer = term.buffer.active;
      window.__paints.push({ at: performance.now(), text: Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n') });
      paint();
    };
  });
  const paints = marker => page.evaluate(marker => window.__paints.filter(paint => paint.text.includes(marker)), marker);

  // Pieces of one update reach the terminal in separate socket messages 300 milliseconds apart.
  await page.locator('#terminal textarea').evaluate(element => element.focus());
  await page.keyboard.type("printf '\\e[?2026h\\e[2J\\e[HSHELL-%s' PARTIAL; sleep 0.3; printf '\\nSHELL-%s\\e[?2026l\\n' DONE");
  await until(() => page.evaluate(() => window.__paints.some(paint => paint.text.includes('sleep 0.3'))), 'the typed command to echo');
  await page.keyboard.press('Enter');
  await until(async () => (await paints('SHELL-DONE')).length > 0, 'the finished update to paint');
  assert.deepEqual((await paints('SHELL-PARTIAL')).filter(paint => !paint.text.includes('SHELL-DONE')), [], 'No paint shows half of an update');

  // An update split inside the browser stays hidden until its closing marker arrives.
  await page.evaluate(() => window.__testTerminal.write('\x1b[?2026h\x1b[2J\x1b[HLOCAL-PARTIAL'));
  await delay(200);
  assert.deepEqual(await paints('LOCAL-PARTIAL'), [], 'An open update does not paint');
  await page.evaluate(() => window.__testTerminal.write('\r\nLOCAL-DONE\x1b[?2026l'));
  await until(async () => (await paints('LOCAL-DONE')).length > 0, 'the closed update to paint');

  // A program that never closes its update still paints after the limit.
  const opened = await page.evaluate(() => { window.__testTerminal.write('\x1b[?2026h\r\nSTUCK-UPDATE'); return performance.now(); });
  await until(async () => (await paints('STUCK-UPDATE')).length > 0, 'the unfinished update to paint at its limit');
  const waited = (await paints('STUCK-UPDATE'))[0].at - opened;
  assert.ok(waited >= 950 && waited < 2500, `An unfinished update paints after about one second, not ${Math.round(waited)} ms`);
  await page.evaluate(() => window.__testTerminal.write('\x1b[?2026l'));
  assert.deepEqual(errors, []);
  console.log('PASS: synchronized updates paint once complete across socket messages and local writes, and an unfinished update paints after its limit');
} catch (error) { console.error(logs); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); await delay(100); await rm(fixture, { recursive: true, force: true }); }
