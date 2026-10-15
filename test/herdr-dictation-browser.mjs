import { launchBrowser, freePort, startBackend, delay, until } from './support/browser.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { resumableVoxtype } from './support/voxtype-daemon.mjs';
import { herdrRequest } from './support/herdr.ts';
import { installWireObserver } from './wire-observer.mjs';

const fixturePort3191 = await freePort();

const root = new URL('../', import.meta.url).pathname, directory = await realpath(await mkdtemp('/tmp/termai-herdr-dictation-'));
const target = { session: '', socketPath: directory + '/herdr.sock' }, base = 'http://127.0.0.1:' + fixturePort3191 + '/';
const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory + '/config', XDG_DATA_HOME: directory + '/data', XDG_STATE_HOME: directory + '/state', HERDR_SOCKET_PATH: target.socketPath, HERDR_SESSION: '', SHELL: '/bin/bash', TERM: 'xterm-256color' };
const daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(daemon, 'listening');
let transcript = 'C D work space';
const voice = resumableVoxtype(daemon, { transcript: () => transcript, finalDelay: () => 0 });
let herdr, backend, browser;
try {
  await mkdir(directory + '/work-space'); await mkdir(directory + '/config');
  await writeFile(directory + '/token', 'fixture-secret-'.repeat(8), { mode: 0o600 });
  await writeFile(directory + '/.bashrc', "PS1='fixture> '\n");
  await writeFile(directory + '/program.mjs', "process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('PROGRAM_READY'); process.stdin.on('data', bytes => { if (bytes.includes(3)) process.exit(); });");
  herdr = spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', ['server'], { cwd: directory, env, stdio: 'ignore' });
  await until(async () => { try { await herdrRequest(target, 'session.snapshot'); return true; } catch { return false; } }, 'Herdr server');
  const created = await herdrRequest(target, 'workspace.create', { cwd: directory, label: 'Shell dictation', focus: false });
  const pane = created.root_pane;
  assert.ok(pane?.terminal_id, JSON.stringify(created));
  await until(async () => { const reply = await herdrRequest(target, 'pane.process_info', { pane_id: pane.pane_id }); return reply.process_info.shell_pid === reply.process_info.foreground_process_group_id; }, 'shell at prompt');
  backend = startBackend({ cwd: root, env: { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(fixturePort3191), TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_DATA_DIR: directory + '/termai', TERMAI_NO_RC: '1', TERMAI_CWD: directory, TERMAI_VOXTYPE_TOKEN_FILE: directory + '/token', TERMAI_VOXTYPE_URL: 'ws://127.0.0.1:' + daemon.address().port + '/v1/dictate' }, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'Termai backend');
  const token = (await readFile(directory + '/termai/pairing-token', 'utf8')).trim();
  browser = await launchBrowser({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await installWireObserver(context);
  await context.addInitScript(() => {
    window.__messages = []; window.__sent = []; const Original = WebSocket;
    window.WebSocket = class extends Original { constructor(...args) { super(...args); this.addEventListener('message', async event => { const message = await window.__wireMessage(event.data, this); window.__messages.push(message); if (message.type === 'state') window.__state = message.state; }); } send(data) { window.__sent.push(window.__wireSent(data)); super.send(data); } };
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + 'terminal.html?herdrTerminal=' + pane.terminal_id);
  await page.locator('#token').fill(token); await page.locator('#login-form button').click();
  await page.waitForFunction(() => window.__state?.ready);
  const mic = page.locator('#termai-dictation'); await mic.waitFor();
  async function dictate(text, reconnect = false) {
    transcript = text;
    await page.evaluate(() => window.__messages = []);
    // Lifecycle starts must not turn into hold-to-finish gestures on busy runners.
    await mic.press('Enter'); await page.waitForFunction(() => window.__messages.some(message => message.type === 'dictation' && message.state === 'ready'));
    await delay(250);
    if (reconnect) {
      const id = voice.currentId, before = voice.resumptions;
      await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); }); await delay(1200);
      assert.equal(await mic.getAttribute('aria-pressed'), 'true');
      await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
      await until(() => voice.resumptions > before, 'Herdr recording resume');
      assert.equal(voice.currentId, id);
      await delay(200);
    }
    await mic.press('Enter');
    await page.waitForFunction(() => window.__messages.some(message => message.type === 'dictation' && message.state === 'done'));
  }
  await dictate('C D work space', true);
  await page.locator('.alternative-choice.selected .choice-command').filter({ hasText: /^cd work-space$/ }).waitFor({ state: 'visible' });
  assert.ok(await page.locator('.alternative-choice .choice-command').filter({ hasText: /^C D work space$/ }).isVisible());
  let info = await herdrRequest(target, 'pane.process_info', { pane_id: pane.pane_id });
  assert.equal(info.process_info.foreground_processes.find(process => process.pid === info.process_info.shell_pid).cwd, directory, 'Dictation does not execute cd');
  await page.locator('.alternative-choice.selected').click();
  await until(async () => { const reply = await herdrRequest(target, 'pane.process_info', { pane_id: pane.pane_id }); return reply.process_info.foreground_processes.some(process => process.cwd === directory + '/work-space'); }, 'selected alternate executes once');
  await page.waitForFunction(() => window.__state.ready && window.__state.cwd.endsWith('/work-space'));
  await page.locator('#terminal textarea').focus();
  await page.locator('#terminal textarea').evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertReplacementText', data: 'C D ..', bubbles: true, cancelable: true })));
  await page.locator('.alternative-choice.selected .choice-command').filter({ hasText: /^cd \.\.$/ }).waitFor({ state: 'visible' });
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+k');
  await page.locator('#terminal textarea').evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    for (const data of ['C', 'C D ..']) element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data, bubbles: true, cancelable: true, isComposing: true }));
    element.dispatchEvent(new CompositionEvent('compositionend', { data: 'C D ..', bubbles: true }));
  });
  await page.locator('.alternative-choice.selected .choice-command').filter({ hasText: /^cd \.\.$/ }).waitFor({ state: 'visible' });
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+k');
  await page.locator('#terminal textarea').focus(); await page.keyboard.type('echo prefix  tail');
  await page.keyboard.press('Control+a'); for (let i = 0; i < 'echo prefix '.length; i++) await page.keyboard.press('ArrowRight');
  await dictate('C D ..');
  await page.locator('.alternative-choice.selected .choice-command').filter({ hasText: /^cd \.\.$/ }).waitFor({ state: 'visible' });
  const screen = async () => (await herdrRequest(target, 'pane.read', { pane_id: pane.pane_id, source: 'recent_unwrapped', lines: 1000 })).read.text;
  assert.ok((await screen()).includes('echo prefix cd .. tail'), 'Existing prefix and suffix survive a correction');
  await herdrRequest(target, 'pane.send_text', { pane_id: pane.pane_id, text: 'X' });
  await page.evaluate(() => window.__messages = []); await page.locator('.alternative-choice.selected').click();
  await page.waitForFunction(() => window.__messages.some(message => message.type === 'result' && !message.accepted));
  assert.ok((await screen()).includes('echo prefix cd ..X tail'), 'An edit from another viewer prevents replacement and execution');
  await page.locator('#terminal textarea').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+k');
  await page.keyboard.type('node ' + directory + '/program.mjs'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__state?.inputTarget === 'program');
  await dictate('C D work space');
  assert.equal(await page.locator('#alternatives-menu').isVisible(), false, 'Foreground programs keep literal dictation');
  await page.locator('#terminal textarea').evaluate(element => element.blur());
  await page.evaluate(() => window.__sent = []);
  await page.locator('#terminal-enter').tap();
  await page.waitForFunction(() => window.__sent.some(message => message.type === 'input' && message.data === '\r'));
  assert.equal(await page.evaluate(() => window.__sent.filter(message => message.type === 'input' && message.data === '\r').length), 1, 'Standalone Enter sends one Return');
  assert.deepEqual(await page.locator('#terminal textarea').evaluate(element => ({ focused: element === document.activeElement, readOnly: element.readOnly, inputMode: element.inputMode })), { focused: false, readOnly: true, inputMode: 'none' }, 'Standalone Enter keeps the keyboard dismissed');
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
  await page.waitForFunction(() => document.querySelector('#terminal-enter').disabled);
  assert.deepEqual(errors, []);
  console.log('PASS Herdr shell dictation: real process detection, retained microphone audio through reconnect, microphone and keyboard C D alternatives, scoped repair, preserved prefix/suffix, rejected external edits, selected command execution, literal foreground input');
} catch (error) {
  for (const page of browser?.contexts().flatMap(context => context.pages()) || []) console.error(await page.evaluate(() => ({ messages: window.__messages, state: window.__state, choices: [...document.querySelectorAll('.choice-command')].map(item => item.textContent), notice: document.querySelector('#toast')?.textContent })));
  throw error;
} finally {
  await browser?.close();
  if (backend) { const exit = once(backend, 'exit'); backend.kill('SIGTERM'); await exit; }
  if (herdr) { const exit = once(herdr, 'exit'); herdr.kill('SIGTERM'); await exit; }
  for (const socket of daemon.clients) socket.terminate(); await new Promise(resolve => daemon.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
