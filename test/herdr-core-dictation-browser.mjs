import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { launchBrowser, freePort, until, pair, waitForBackend, delay } from './support/browser.mjs';
import { resumableVoxtype } from './support/voxtype-daemon.mjs';
import { installWireObserver } from './wire-observer.mjs';

const directory = await mkdtemp('/tmp/libertty-core-dictation-');
const session = 'dictation';
const env = { ...process.env, HOME: directory, SHELL: '/bin/bash', XDG_RUNTIME_DIR: join(directory, 'runtime'), XDG_CONFIG_HOME: join(directory, 'config'), XDG_STATE_HOME: join(directory, 'state'), HC_SESSION: session };
await mkdir(env.XDG_RUNTIME_DIR);
await mkdir(join(directory, 'work-space'));
await writeFile(join(directory, '.bashrc'), "PS1='fixture> '\n");
await writeFile(join(directory, 'token'), 'fixture-secret-'.repeat(8), { mode: 0o600 });
execFileSync('git', ['init', '-q', directory]);
execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
const daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(daemon, 'listening');
let transcript = 'C D work space';
resumableVoxtype(daemon, { transcript: () => transcript, finalDelay: () => 0 });
const port = await freePort(), base = `http://127.0.0.1:${port}/`;
const token = 'core-dictation-pairing-token-123456789';
let backend, browser, bearer, logs = '';
async function api(path, body) {
  const response = await fetch(new URL(path, base), { method: 'POST', headers: { Origin: base.slice(0, -1), Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
try {
  backend = spawn(new URL('../target/debug/libertty', import.meta.url).pathname, [], { env: { ...env, HOST: '127.0.0.1', PORT: String(port), LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_DATA_DIR: join(directory, 'data'), LIBERTTY_CWD: directory, LIBERTTY_NO_RC: '1', LIBERTTY_TOKEN: token, LIBERTTY_VOXTYPE_TOKEN_FILE: join(directory, 'token'), LIBERTTY_VOXTYPE_URL: `ws://127.0.0.1:${daemon.address().port}/v1/dictate` }, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', bytes => logs += bytes);
  backend.stderr.on('data', bytes => logs += bytes);
  await waitForBackend(base, backend);
  bearer = await pair(base, token);
  const created = await api(`api/herdr/action?herdrCore=1&herdrSession=${session}`, { action: 'create-space' });
  browser = await launchBrowser({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  await installWireObserver(context);
  await context.addInitScript(() => {
    window.__messages = []; window.__sent = [];
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', async event => { const message = await window.__wireMessage(event.data, this); window.__messages.push(message); if (message.type === 'state') window.__state = message.state; }); }
      send(data) { window.__sent.push(window.__wireSent(data)); super.send(data); }
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(base + `terminal.html?herdrCore=1&herdrSession=${session}&herdrTerminal=${encodeURIComponent(created.terminalId)}`);
  await page.locator('#token').fill(token);
  await page.locator('#login-form button').click();
  await page.waitForFunction(() => window.__state?.ready);
  const input = page.locator('#terminal textarea'), mic = page.locator('#libertty-dictation');
  await mic.waitFor({ state: 'visible' });
  async function clear() {
    await input.focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+k');
    await delay(100);
    await page.evaluate(() => window.__messages = []);
  }
  async function dictate(text, delayedEcho = false) {
    transcript = text;
    await page.evaluate(() => window.__messages = []);
    await mic.press('Enter');
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'ready'));
    await delay(250);
    const pid = await page.evaluate(() => JSON.parse(window.__state.inputContext)[1]);
    if (delayedEcho) process.kill(pid, 'SIGSTOP');
    try {
      await mic.press('Enter');
      await page.waitForFunction(() => window.__messages.some(m => m.type === 'dictation' && m.state === 'done'));
      if (delayedEcho) {
        await delay(500);
        assert.equal(await page.evaluate(() => window.__messages.some(m => m.type === 'repair-result')), false, 'Repair waits for shell echo');
      }
    } finally {
      if (delayedEcho) process.kill(pid, 'SIGCONT');
    }
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'repair-result'));
    const reply = await page.evaluate(() => window.__messages.find(m => m.type === 'repair-result'));
    assert.ok(reply.accepted, JSON.stringify(reply));
    return reply;
  }
  for (const text of ['C D work space', 'echo ' + 'wrapped words '.repeat(8).trim(), 'echo trailing spaces  ']) {
    await clear();
    const reply = await dictate(text);
    await page.locator('.alternative-choice.selected').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.literal-choice .choice-command').textContent(), text);
    assert.equal(reply.original, text);
    assert.equal(reply.selected, text === 'C D work space' ? 'cd work-space' : text.trim());
    console.log('PASS Core microphone alternatives: ' + JSON.stringify(text));
  }
  await clear();
  await dictate('C D work space', true);
  await page.locator('.alternative-choice.selected .choice-command').filter({ hasText: /^cd work-space$/ }).waitFor({ state: 'visible' });
  console.log('PASS Core microphone alternatives wait for delayed shell echo');
  await clear();
  await input.evaluate(element => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'C D work space');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.locator('.alternative-choice.selected .choice-command').filter({ hasText: /^cd work-space$/ }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.literal-choice .choice-command').textContent(), 'C D work space');
  await page.locator('.alternative-choice.selected').click();
  await page.waitForFunction(() => window.__state?.ready && window.__state.cwd.endsWith('/work-space'));
  console.log('PASS Core clipboard dictation alternatives and selected command execution');
} catch (error) {
  for (const page of browser?.contexts().flatMap(context => context.pages()) || []) console.error(await page.evaluate(() => ({ messages: window.__messages, state: window.__state, choices: [...document.querySelectorAll('.choice-command')].map(item => item.textContent) })));
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  if (backend) { const exit = once(backend, 'exit'); backend.kill(); await exit; }
  try { execFileSync(process.env.LIBERTTY_HC_BINARY || 'hc', ['server', 'stop'], { env, stdio: 'ignore', timeout: 10000 }); } catch {}
  for (const socket of daemon.clients) socket.terminate();
  await new Promise(resolve => daemon.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
