import { launchBrowser, freePort, until, delay, waitForShell } from './support/browser.mjs';
import { showTerminalTabs } from './support/workspace-navigation.mjs';
import { installWireObserver } from './wire-observer.mjs';
import { herdrRequest } from './support/herdr.ts';
import { sshdPath, sshdConfig } from './support/sshd.mjs';
import { fingerprint } from './support/ssh-key.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import ssh2 from 'ssh2';
import os from 'node:os';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url).pathname, dir = await mkdtemp('/tmp/libertty-herdr-reading-');
const target = { session: '', socketPath: dir + '/herdr.sock' }, port = await freePort(), sshPort = await freePort();
const base = 'http://127.0.0.1:' + port + '/reading-test/', origin = new URL(base).origin;
const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir + '/config', XDG_DATA_HOME: dir + '/data', XDG_STATE_HOME: dir + '/state', HERDR_SOCKET_PATH: target.socketPath, HERDR_SESSION: '', HERDR_ENV: '', SHELL: '/bin/bash', TERM: 'xterm-256color' };
const processes = [];
let browser, logs = '';
const start = (binary, args, options = {}) => {
  const child = spawn(binary, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], ...options }); processes.push(child);
  child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data); return child;
};
try {
  await mkdir(dir + '/work tree'); await mkdir(dir + '/remote');
  await writeFile(dir + '/work tree/note.txt', 'A reader inside Herdr.\n');
  await writeFile(dir + '/work tree/README.md', '# Herdr reader\n\n[Read note](note.txt)\n');
  start(process.env.HERDR_BINARY || '/usr/bin/herdr', ['server']);
  await until(async () => { try { await herdrRequest(target, 'session.snapshot'); return true; } catch { return false; } }, 'Herdr server');
  const { root_pane: pane } = await herdrRequest(target, 'workspace.create', { cwd: dir + '/work tree', label: 'Reading', focus: false });
  start(root + 'target/debug/libertty', [], { cwd: root, env: { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), LIBERTTY_BASE_PATH: '/reading-test', LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_ALLOWED_ORIGINS: origin, LIBERTTY_DATA_DIR: dir + '/libertty', LIBERTTY_TOKEN: '', LIBERTTY_CWD: dir, LIBERTTY_NO_RC: '1' } });
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'libertty backend');
  for (const path of ['reading', 'reading/file?path=/tmp/file', 'reading/capture?id=' + 'a'.repeat(32)]) {
    const response = await fetch(base + 'api/herdr/' + path, { ...(path === 'reading' ? { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' } : {}) });
    assert.equal(response.status, 401);
  }
  const token = (await readFile(dir + '/libertty/pairing-token', 'utf8')).trim();
  browser = await launchBrowser(); const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await installWireObserver(context);
  await context.addInitScript(() => {
    // Dictation setup help is a modal that would capture typed reading commands.
    localStorage.setItem('libertty.voxtype:' + location.origin + '/reading-test/', 'dismissed');
    const Original = WebSocket;
    window.WebSocket = class extends Original { constructor(...args) { super(...args); this.addEventListener('message', async event => { const message = await window.__wireMessage(event.data, this); if (message.type === 'state') window.__state = message.state; }); } };
    if (!localStorage.getItem('libertty.tabs')) {
      const id = crypto.randomUUID();
      localStorage.setItem('libertty.hosts', JSON.stringify([{ id: 'herdr-reader', name: 'Herdr', kind: 'herdr', backendId: 'primary' }]));
      localStorage.setItem('libertty.tabs', JSON.stringify([{ id, session: 'default', name: 'Herdr', pluginId: 'herdr', pluginVersion: '1', herdrSession: '', backendId: 'primary', hostId: 'herdr-reader' }]));
      localStorage.setItem('libertty.activeTab', JSON.stringify(id));
    }
  });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator('#backend-token').fill(token); await page.locator('#backend-login-form button[type=submit]').click();
  const terminal = async () => {
    const element = await page.locator('.herdr-view:visible .herdr-terminal').elementHandle(), frame = await element.contentFrame();
    await waitForShell(frame); return frame;
  };
  const type = async command => { const frame = await terminal(); await frame.locator('#terminal textarea').focus(); await page.keyboard.type(command); await page.keyboard.press('Enter'); };
  const closeReader = async () => { await showTerminalTabs(page); await page.locator('#tabs [role=tab][aria-selected=true] .tab-close').click(); await terminal(); };
  await type('look at README.md'); await page.locator('.reading-markdown h1').filter({ hasText: 'Herdr reader' }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.pluginId === 'reading').readHerdrTerminal), pane.terminal_id);
  await page.locator('.reading-markdown a').click(); await page.locator('.reading-text').filter({ hasText: 'A reader inside Herdr.' }).waitFor();
  await page.reload(); await page.locator('.reading-text').filter({ hasText: 'A reader inside Herdr.' }).waitFor();
  await closeReader();
  if (await page.locator('.reading-view:visible').count()) await closeReader();
  for (const command of ['look at printf prefix-output', 'printf pipe-output | look at']) {
    await type(command); await page.locator('.reading-text').filter({ hasText: command.includes('prefix') ? 'prefix-output' : 'pipe-output' }).waitFor();
    const capture = await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.id === JSON.parse(localStorage.getItem('libertty.activeTab'))).readCapture);
    const foreign = await (await fetch(base + 'api/connect', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, noSession: true }) })).json();
    assert.equal((await fetch(base + 'api/herdr/reading/capture?id=' + capture, { headers: { Authorization: 'Bearer ' + foreign.accessToken } })).status, 404, 'Captured output belongs to its paired viewer');
    await page.reload(); await page.locator('.reading-text').waitFor(); await closeReader();
  }
  const frame = await terminal(); await frame.locator('#terminal textarea').focus();
  await frame.locator('#terminal textarea').evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'look at note dot txt', bubbles: true, cancelable: true })));
  await frame.locator('.reading-choice').filter({ hasText: 'Read note.txt' }).click();
  await page.locator('.reading-text').filter({ hasText: 'A reader inside Herdr.' }).waitFor(); await closeReader();
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519'), identity = ssh2.utils.generateKeyPairSync('ed25519', { cipher: 'aes256-ctr', passphrase: 'fixture-passphrase' });
  await writeFile(dir + '/host-key', hostKey.private, { mode: 0o600 }); await writeFile(dir + '/authorized', identity.public + '\n');
  await sshdConfig(dir, sshPort, { hostKey: 'host-key', env: { HERDR_SOCKET_PATH: target.socketPath, PATH: process.env.PATH } });
  start(sshdPath(), ['-D', '-e', '-f', dir + '/sshd_config']); await delay(150);
  const remote = await page.evaluate(async input => {
    const request = async (path, body) => {
      const response = await fetch(new URL('api/' + path, document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
    };
    const source = await request('sessions', { name: 'SSH reader', files: true, ssh: input });
    await request('herdr/connect', { source: source.id });
    const id = crypto.randomUUID(), tabs = JSON.parse(localStorage.getItem('libertty.tabs'));
    tabs.push({ id, session: source.id, name: 'SSH Herdr', pluginId: 'herdr', pluginVersion: '1', herdrSession: '', herdrSource: source.id, backendId: 'primary' });
    localStorage.setItem('libertty.tabs', JSON.stringify(tabs)); localStorage.setItem('libertty.activeTab', JSON.stringify(id)); return source.id;
  }, { host: '127.0.0.1', port: sshPort, username: os.userInfo().username, privateKey: identity.private, passphrase: 'fixture-passphrase', trust: fingerprint(ssh2.utils.parseKey(hostKey.private).getPublicSSH()) });
  await page.reload(); await terminal(); await type('look at note.txt');
  await page.locator('.reading-text').filter({ hasText: 'A reader inside Herdr.' }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.id === JSON.parse(localStorage.getItem('libertty.activeTab'))).herdrSource), remote);
  await closeReader(); await type("look at sh -c 'printf x >> once; printf remote-output'");
  await page.locator('.reading-text').filter({ hasText: 'remote-output' }).waitFor();
  assert.equal(await readFile(dir + '/work tree/once', 'utf8'), 'x');
  const standalone = await context.newPage(); standalone.on('pageerror', error => errors.push(error.message));
  await standalone.goto(base + 'terminal.html?herdrTerminal=' + pane.terminal_id);
  await standalone.waitForFunction(() => window.__state?.ready && !document.querySelector('#terminal-viewport').classList.contains('awaiting-herdr-layout') && document.querySelector('#terminal-viewport').getAttribute('aria-busy') !== 'true');
  await standalone.locator('#terminal textarea').focus(); await standalone.keyboard.type('look at note.txt'); await standalone.keyboard.press('Enter');
  await standalone.waitForURL(base); await standalone.locator('.reading-text:visible').filter({ hasText: 'A reader inside Herdr.' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS Herdr reader: typed and dictated files, relative links, prefix and piped command output, reloads, source navigation and SSH context.');
} catch (error) {
  for (const frame of browser?.contexts().flatMap(context => context.pages()).flatMap(page => page.frames()) || []) console.error(await frame.evaluate(() => ({ url: location.href, state: window.__state, notice: document.querySelector('#toast')?.textContent, text: document.body.innerText.slice(0, 1000) })).catch(() => ({})));
  console.error(logs); throw error;
}
finally {
  await browser?.close();
  for (const child of processes.reverse()) { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } }
  await rm(dir, { recursive: true, force: true });
}
