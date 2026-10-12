import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import { WebSocket } from 'ws';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = await mkdtemp('/tmp/termai-dev-pairing-');
const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`; const base = origin + '/audit/';
const server = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), HOME: directory, TERMAI_CWD: directory, TERMAI_NO_RC: '1', TERMAI_TOKEN: 'dev-test-pairing-token-123456789', TERMAI_DATA_DIR: directory, TERMAI_BASE_PATH: '/audit', TERMAI_ALLOWED_HOSTS: '127.0.0.1', CARGO_HOME: process.env.CARGO_HOME || path.join(process.env.HOME, '.cargo'), RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(process.env.HOME, '.rustup') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d); const exited = once(server, 'exit'); let browser;
try {
  for (let i = 0; !logs.includes('Pairing token:'); i++) { if (i > 1200 || server.exitCode !== null) throw Error('Startup failed: ' + logs); await new Promise(r => setTimeout(r, 50)); }
  const asset = await fetch(base + '@vite/client');
  assert.equal(asset.status, 401, 'unpaired clients cannot read development assets');
  assert.equal(await new Promise((resolve, reject) => {
    http.get(base, { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  }), 403);
  async function deniedUpgrade(headers) {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:'), 'vite-hmr', { headers, handshakeTimeout: 5000 });
      socket.on('open', () => { socket.close(); reject(Error('Unauthorized Vite upgrade succeeded')); });
      socket.on('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
      socket.on('error', () => {});
    });
  }
  assert.equal(await deniedUpgrade({ Origin: origin }), 403, 'unpaired Vite upgrades must fail');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const page = await browser.newPage(); const errors = []; const hmr = [];
  await page.context().route(url => url.pathname.endsWith('/api/dictation'), route => route.fulfill({ json: { installed: true, available: true } }));
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.text().includes('[vite]')) hmr.push(m.text()); });
  await page.goto(base);
  const input = page.locator('#token'), submit = page.locator('#login-form button[type=submit]');
  await input.fill('incorrect'); await submit.click();
  await page.waitForFunction(() => document.querySelector('#login-error').textContent.includes('pairing token'));
  await input.fill('dev-test-pairing-token-123456789'); await submit.click();
  await page.locator('#terminal-stack iframe').waitFor();
  const frame = await (await page.locator('#terminal-stack iframe').elementHandle()).contentFrame();
  await frame.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Connected');
  await frame.waitForFunction(() => document.querySelector('#shell-status')?.textContent === 'At prompt');
  await frame.locator('#terminal canvas').click();
  assert.equal(await frame.locator('#terminal textarea').evaluate(el => el === document.activeElement && !el.readOnly), true, 'Clicking the terminal must enable input');
  await page.keyboard.type('printf dev-paired > checked.txt'); await page.keyboard.press('Enter');
  for (let i = 0; await readFile(directory + '/checked.txt', 'utf8').catch(() => '') !== 'dev-paired'; i++) {
    assert.ok(i < 100, 'paired terminal must execute the command'); await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(errors, []);
  assert.ok(hmr.some(m => m.includes('connected.')), 'authenticated Vite HMR should connect');
  const saved = await page.context().storageState();
  assert.equal(await deniedUpgrade({ Origin: 'https://untrusted.invalid', Cookie: 'termai=' + saved.cookies.find(cookie => cookie.name === 'termai').value }), 403, 'paired Vite upgrades require an allowed origin');
  assert.ok(saved.cookies.find(cookie => cookie.name === 'termai').expires > Date.now() / 1000, 'pairing cookie must survive browser shutdown');
  saved.cookies = [];
  const reopened = await browser.newContext({ storageState: saved }), reopenedPage = await reopened.newPage();
  await reopenedPage.goto(base); await reopenedPage.locator('#terminal-stack iframe').waitFor();
  const reopenedFrame = await (await reopenedPage.locator('#terminal-stack iframe').elementHandle()).contentFrame();
  await reopenedFrame.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Connected');
  await reopened.close();
  console.log('PASS ' + ('Rust') + ' development browser: mounted pairing gate, protected development assets, incorrect-token rejection, connected terminal, remembered pairing without cookies, authenticated Vite HMR');
} finally { await browser?.close(); server.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); }
