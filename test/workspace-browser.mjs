import { launchBrowser, freePort, delay, until, waitForBackend } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { sshdPath, sshdConfig } from './support/sshd.mjs';
import { WebSocket } from 'ws';

const fixturePort3153 = await freePort();
const fixturePort3154 = await freePort();
const fixturePort3158 = await freePort();
const root = path.resolve(import.meta.dirname, '..'), fixture = await mkdtemp('/tmp/libertty-workspace-');
const origin = 'http://127.0.0.1:' + fixturePort3153, secondary = 'http://127.0.0.1:' + fixturePort3154, sshPort = fixturePort3158;
const processes = [], logs = [], errors = [];
let browser;
function start(command, args, env = {}) { const proc = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(proc); proc.stdout.on('data', b => logs.push(String(b))); proc.stderr.on('data', b => logs.push(String(b))); return proc; }
async function vaultData(name) {
  const bytes=await readFile(fixture+'/'+name+'/vault.json','utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return '{"keys":[],"knownHosts":[]}';});
  return JSON.parse(bytes);
}
async function setFixturePin(fingerprint) {
  // Corrupt only the disposable stored pin to exercise the production verifier.
  const data=await vaultData('secondary');
  data.knownHosts=data.knownHosts.filter(pin=>pin.host!=='127.0.0.1'||pin.port!==sshPort);
  if(fingerprint)data.knownHosts.push({host:'127.0.0.1',port:sshPort,fingerprint});
  await writeFile(fixture+'/secondary/vault.json',JSON.stringify(data),{mode:0o600});
}
async function activeFrame(page) { const iframe = await page.locator('#terminal-stack iframe:visible').elementHandle(); const frame = await iframe.contentFrame(); await frame.waitForFunction(() => window.__shellState?.ready); return frame; }
async function connectNew(page, name) { await page.getByRole('button', { name: new RegExp('^Terminals for ' + name + ' ') }).click(); await page.getByRole('menuitem', { name: 'Connect new terminal', exact: true }).click(); }
async function command(frame, text) { const prompt = await frame.evaluate(() => window.__shellState.prompt); await frame.locator('#terminal textarea').focus(); await frame.page().keyboard.type(text); await frame.page().keyboard.press('Enter'); await frame.waitForFunction(prompt => window.__shellState.ready && window.__shellState.prompt > prompt, prompt); }
try {
  await mkdir(fixture + '/remote/git/pebble-agent', { recursive: true });
  await writeFile(fixture + '/remote/hello_world.py', "import argparse\np=argparse.ArgumentParser()\np.add_argument('--myarg')\n");
  await writeFile(fixture + '/remote/SKILL.md', '# Skill\n');
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519'); await writeFile(fixture + '/host', hostKey.private, { mode: 0o600 }); await writeFile(fixture + '/authorized', '');
  await sshdConfig(fixture, sshPort);
  start(sshdPath(), ['-D', '-e', '-f', fixture + '/sshd_config']);
  const backendSpecs = [[fixturePort3153, 'primary', ''], [fixturePort3154, 'secondary', 'test-backend-token-123456789']];
  const startBackend = ([port, name, token]) => start(root + '/target/debug/libertty', [], { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), LIBERTTY_BASE_PATH: '', LIBERTTY_ALLOWED_HOSTS: '127.0.0.1,localhost', LIBERTTY_ALLOWED_ORIGINS: origin, LIBERTTY_TOKEN: token, LIBERTTY_NO_RC: '1', LIBERTTY_CWD: fixture, HOME: fixture, LIBERTTY_DATA_DIR: fixture + '/' + name, LIBERTTY_HISTORY_FILE: fixture + '/no-history', LIBERTTY_ETERNAL_HISTORY_FILE: fixture + '/no-history' });
  const backends = backendSpecs.map(startBackend);
  await Promise.all([waitForBackend(origin, backends[0]), waitForBackend(secondary, backends[1])]);
  const primaryPairingToken = (await readFile(fixture + '/primary/pairing-token', 'utf8')).trim();
  const request = (base, api, token, data, from = origin) => fetch(base + '/api/' + api, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: from, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  assert.equal((await request(secondary, 'keychain')).status, 401);
  assert.equal((await request(secondary, 'connect', undefined, { token: 'wrong' })).status, 401);
  assert.equal((await request(origin, 'connect', undefined, {}, 'http://untrusted.invalid')).status, 403);
  const preflight = await fetch(secondary + '/api/connect', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  const ownerA = (await (await request(origin, 'connect', undefined, { noSession: true, token: primaryPairingToken })).json()).accessToken;
  const ownerB = (await (await request(origin, 'connect', undefined, { noSession: true, token: primaryPairingToken })).json()).accessToken;
  const isolated = (await (await request(origin, 'sessions', ownerA, { name: 'isolation fixture' })).json()).id;
  assert.equal((await request(origin, 'context?session=' + isolated, ownerB)).status, 404);
  assert.equal((await request(origin, 'ticket?session=' + isolated, ownerB, {})).status, 404);
  assert.equal((await request(origin, 'ssh/captured?session=' + isolated, ownerB, { id: 'unowned' })).status, 404);
  assert.equal((await request(origin, 'ssh/captured?session=' + isolated, ownerA, { id: 'stale' })).status, 400);
  const ticket = (await (await request(origin, 'ticket?session=' + isolated, ownerA, {})).json()).ticket;
  const socketURL = origin.replace('http:', 'ws:') + '/ws?session=' + isolated + '&ticket=' + ticket;
  await new Promise((resolve, reject) => { const socket = new WebSocket(socketURL, { origin }); socket.once('open', () => { socket.close(); resolve(); }); socket.once('error', reject); });
  await new Promise((resolve, reject) => { const socket = new WebSocket(socketURL, { origin }); socket.once('open', () => { socket.close(); reject(new Error('Reused websocket ticket was accepted')); }); socket.once('error', error => { assert.match(error.message, /403/); resolve(); }); });
  await request(origin, 'sessions/close?session=' + isolated, ownerA, {});
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' }), page = await context.newPage();
  // Inspect the real terminal buffer without exposing a debug API in production.
  await context.route('**/api/dictation**', route => route.fulfill({ json: { installed: true, available: true } }));
  await context.route('**/assets/terminal-*.js', async route => {
    const response = await route.fetch(), original = await response.text();
    const body = original.replace(/new ([\w$]+)\(\{ghostty:/, 'window.__testTerminal=new $1({ghostty:');
    assert.notEqual(body, original); await route.fulfill({ response, body });
  });

  page.on('pageerror', error => errors.push(String(error))); page.on('dialog', d => d.accept());
  await installWireObserver(context);
  await context.addInitScript(() => {
    const Original = window.WebSocket; window.WebSocket = class extends Original {
      constructor(...args) { super(...args); this.addEventListener('message', async event => { const m = await window.__wireMessage(event.data, this); if (m.type === 'state') window.__shellState = m.state; if (m.type === 'hello') window.__engine = m.engine; if (m.type === 'output') window.__output = (window.__output || '') + m.data; if (m.type === 'ssh-command') window.__sshCapture = m.id; if (m.type === 'ssh-released' && window.__sshCapture === m.id) window.__sshCapture = undefined; }); }
    };
  });
  await page.goto(origin);
  await page.locator('#backend-login').waitFor({ state: 'visible' });
  const originalTerminal = await page.locator('#terminal-stack iframe').elementHandle();
  const lockedFrame = await originalTerminal.contentFrame();
  await lockedFrame.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Locked');
  await page.getByRole('button', { name: 'Cancel backend login' }).click();
  await page.locator('#terminal-back').click(); await page.locator('#page-back').click();
  await page.getByRole('button', { name: /^Backends/ }).click();
  await page.getByRole('button', { name: 'Primary backend HTTP' }).click();
  await page.locator('#backend-token').fill('wrong'); await page.locator('#backend-login-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#backend-login-error').textContent.includes('pairing token'));
  await page.locator('#backend-token').fill(primaryPairingToken); await page.locator('#backend-login-form button[type=submit]').click();
  await lockedFrame.waitForFunction(() => window.__shellState?.ready && document.querySelector('#connection-label').textContent === 'Connected');
  assert.equal(await originalTerminal.evaluate(el => el.isConnected), true, 'pairing from Backends must revive the existing blank terminal');
  await page.locator('#nav-terminals').click();
  let frame = await activeFrame(page); assert.equal(await page.locator('[role=tab]').count(), 1);
  await page.locator('#workspace-shortcuts').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('.input-dock').isVisible(), false, 'Embedded terminal does not duplicate the bottom shortcut bar');
  const checkBottomControls = async () => {
    const bounds = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      return { terminal: box('#terminal-stack'), tabs: box('#terminal-header'), shortcuts: box('#workspace-shortcuts'), height: innerHeight, scroll: document.documentElement.scrollHeight };
    });
    assert.ok(bounds.terminal.top <= 1, 'Terminal fills the space above bottom controls');
    assert.ok(bounds.terminal.bottom <= bounds.tabs.top + 1);
    assert.ok(bounds.tabs.bottom <= bounds.shortcuts.top + 1, 'Tabs sit directly above configurable buttons');
    assert.equal(bounds.shortcuts.bottom, bounds.height); assert.equal(bounds.scroll, bounds.height, 'Bottom controls introduce no page overflow');
  };
  await checkBottomControls();
  const viewport = page.viewportSize(); await page.setViewportSize({ width: 390, height: 480 }); await delay(100); await checkBottomControls(); await page.setViewportSize(viewport);
  const controlModifier = page.locator('#workspace-shortcuts').getByRole('button', { name: 'Ctrl', exact: true });
  await controlModifier.click(); await until(async () => await controlModifier.getAttribute('aria-pressed') === 'true');
  assert.equal(await frame.locator('[data-modifier]').getAttribute('aria-pressed'), 'true', 'Outer modifier state matches active terminal');
  await controlModifier.click(); await until(async () => await controlModifier.getAttribute('aria-pressed') === 'false');
  await page.screenshot({ path: '/tmp/libertty-bottom-controls.png' });
  await frame.locator('#copy-selection').evaluate(el => el.click());
  await page.getByText('Select terminal text first.', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#toast').isVisible(), false, 'Embedded notices must appear only in the workspace');
  await command(frame, 'export TAB_ID=first');
  assert.equal(await page.locator('#terminal-options').count(), 0);
  await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#settings-pane').isVisible(), true); assert.equal(await page.locator('#terminal-stack').isVisible(), false); assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.locator('#font-size').inputValue(), '10');
  await page.locator('#font-size').fill('14'); await frame.waitForFunction(() => document.querySelector('#font-size').value === '14');
  await page.locator('#auto-alternatives').uncheck(); await frame.waitForFunction(() => !document.querySelector('#auto-alternatives').checked);
  await page.locator('#auto-alternatives').check(); await page.locator('#tap-alternate-send').uncheck(); await frame.waitForFunction(() => !document.querySelector('#tap-alternate-send').checked); await page.locator('#tap-alternate-send').check();
  // A theme change restyles the workspace at once and reloads the terminal into the same session with the matching palette.
  const themeOf = target => target.evaluate(() => [document.documentElement.dataset.theme ?? 'forest', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), document.querySelector('meta[name=theme-color]').content]);
  const switchTheme = async name => { await frame.evaluate(() => { window.__previousTheme = true; }); await page.locator('#theme').selectOption(name); await frame.waitForFunction(() => !window.__previousTheme && window.__shellState?.ready); };
  assert.equal(await page.locator('#theme').inputValue(), 'auto'); assert.deepEqual(await themeOf(page), ['ink', '#000', '#000000']); assert.deepEqual(await themeOf(frame), ['ink', '#000', '#000000']);
  await frame.evaluate(() => { window.__previousTheme = true; });
  await page.emulateMedia({ colorScheme: 'light' }); await frame.waitForFunction(() => !window.__previousTheme && window.__shellState?.ready);
  assert.equal(await page.locator('#theme').inputValue(), 'auto'); assert.deepEqual(await themeOf(page), ['paper', '#fbfaf6', '#fbfaf6']); assert.deepEqual(await themeOf(frame), ['paper', '#fbfaf6', '#fbfaf6']);
  await frame.evaluate(() => { window.__previousTheme = true; });
  await page.emulateMedia({ colorScheme: 'dark' }); await frame.waitForFunction(() => !window.__previousTheme && window.__shellState?.ready);
  await switchTheme('paper'); assert.deepEqual(await themeOf(page), ['paper', '#fbfaf6', '#fbfaf6']); assert.deepEqual(await themeOf(frame), ['paper', '#fbfaf6', '#fbfaf6']);
  await switchTheme('ink'); assert.deepEqual(await themeOf(frame), ['ink', '#000', '#000000']);
  await switchTheme('1776'); assert.deepEqual(await themeOf(page), ['1776', '#0b1430', '#0b1430']); assert.deepEqual(await themeOf(frame), ['1776', '#0b1430', '#0b1430']);
  await switchTheme('flag'); assert.deepEqual(await themeOf(page), ['flag', '#fcfdff', '#fcfdff']); assert.deepEqual(await themeOf(frame), ['flag', '#fcfdff', '#fcfdff']);
  await switchTheme('forest'); assert.deepEqual(await themeOf(page), ['forest', '#0b0f0d', '#0b0f0d']); assert.deepEqual(await themeOf(frame), ['forest', '#0b0f0d', '#0b0f0d']);
  await page.locator('#customize-shortcuts').click(); assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.locator('#add-shortcut').click();
  const shortcut = page.locator('.shortcut-row').last(); await shortcut.locator('.shortcut-label').fill('Help'); await shortcut.locator('select').selectOption('keys'); await shortcut.locator('.binding').fill('Ctrl+H');
  await page.getByRole('button', { name: 'Save shortcuts', exact: true }).click(); await frame.waitForFunction(() => document.querySelector('#shortcut-buttons').textContent.includes('Help'));
  await page.screenshot({ path: root + '/.test-artifacts/workspace-settings.png' });
  await page.locator('#font-size').fill('10'); await page.locator('#nav-terminals').click();
  assert.equal(await page.locator('[role=tab]').count(), 1); await activeFrame(page);
  let sessionCreates = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) sessionCreates++; });
  const firstSession = new URL(frame.url()).searchParams.get('session');
  await page.locator('#terminal-back').click();
  assert.equal(await page.getByRole('button', { name: 'Terminals for This machine (1 open)', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'This machine HTTP' }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), firstSession); assert.equal(sessionCreates, 0);
  await page.locator('#terminal-back').click(); await connectNew(page, 'This machine'); frame = await activeFrame(page);
  assert.equal(sessionCreates, 1);
  assert.equal(await frame.locator('#font-size').inputValue(), '10'); assert.ok((await frame.locator('#shortcut-buttons').textContent()).includes('Help'));
  const secondSession = new URL(frame.url()).searchParams.get('session'); assert.notEqual(secondSession, firstSession);
  await page.locator('#terminal-back').click();
  await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).click();
  await page.screenshot({ path: root + '/.test-artifacts/workspace-host-menu.png' });
  assert.equal(await page.getByRole('menuitem', { name: 'This machine (2)', exact: true }).count(), 1);
  await page.getByRole('menuitem', { name: 'This machine', exact: true }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), firstSession);
  await page.locator('#terminal-back').click(); await page.getByRole('button', { name: 'This machine HTTP' }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), firstSession); assert.equal(sessionCreates, 1);
  await page.locator('#terminal-back').click(); await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).click();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#host-terminal-menu').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).evaluate(el => document.activeElement === el), true);
  await page.getByRole('button', { name: 'Terminals for This machine (2 open)', exact: true }).click();
  await page.getByRole('menuitem', { name: 'This machine (2)', exact: true }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), secondSession); assert.equal(sessionCreates, 1);
  await command(frame, 'export TAB_ID=second'); assert.equal(await page.locator('[role=tab]').count(), 2);
  await page.locator('[role=tab]').first().click(); frame = await activeFrame(page); await command(frame, "printf '%s' \"$TAB_ID\" > first-tab.txt"); assert.equal(await readFile(fixture + '/first-tab.txt', 'utf8'), 'first');
  // After a reload, only the visible tab connects; a hidden tab connects when it is shown.
  const terminalSockets = new Set();
  page.on('websocket', socket => { const url = new URL(socket.url()); if (url.pathname.endsWith('/ws')) terminalSockets.add(url.searchParams.get('session') || 'default'); });
  await page.reload(); frame = await activeFrame(page); assert.equal(await page.locator('[role=tab]').count(), 2); await command(frame, "printf '%s' \"$TAB_ID\" > restored-tab.txt"); assert.equal(await readFile(fixture + '/restored-tab.txt', 'utf8'), 'first');
  assert.deepEqual([...terminalSockets], [firstSession], 'Hidden tabs wait to connect until they are shown');
  // A background terminal must keep draining output while another tab is visible.
  await command(frame, `python3 -c 'import time; time.sleep(1); print("background line\\n" * 30000); open("background-done", "w").write("ok")' &`);
  await page.locator('[role=tab]').nth(1).click(); await until(async () => (await readFile(fixture + '/background-done', 'utf8').catch(() => '')) === 'ok');
  await activeFrame(page); assert.deepEqual([...terminalSockets].sort(), [firstSession, secondSession].sort(), 'Showing a tab connects it');
  await page.locator('#terminal-back').click(); await page.locator('#library-add').click(); await page.locator('#host-name').fill('Build server'); await page.locator('#host-backend').selectOption('new'); await page.locator('#host-url').fill(secondary + '/'); await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await page.getByRole('button', { name: 'Build server HTTP' }).click(); await page.locator('#backend-token').fill('test-backend-token-123456789'); await page.locator('#backend-login-form button[type=submit]').click(); frame = await activeFrame(page);
  await command(frame, 'printf routed > direct-backend.txt'); assert.equal(await readFile(fixture + '/direct-backend.txt', 'utf8'), 'routed');
  // Returning from ordinary OpenSSH must not leave remote text below our prompt.
  const nestedKey = ssh2.utils.generateKeyPairSync('ed25519');
  await writeFile(fixture + '/nested-key', nestedKey.private, { mode: 0o600 }); await writeFile(fixture + '/authorized', nestedKey.public + '\n');
  const localPrompt = await frame.evaluate(() => window.__shellState.prompt);
  await frame.locator('#terminal textarea').focus();
  await page.keyboard.type(`ssh -tt -F /dev/null -oIdentitiesOnly=yes -oIdentityAgent=none -oUserKnownHostsFile=${fixture}/nested-known -oStrictHostKeyChecking=accept-new -i ${fixture}/nested-key -p ${sshPort} ${os.userInfo().username}@127.0.0.1 'env PS1=NESTED_READY bash --noprofile --norc -i'`);
  await page.keyboard.press('Enter');
  await frame.waitForFunction(() => window.__output.includes('\x1b[?2004hNESTED_READY'));
  await page.keyboard.type("printf '\\033[2J\\033[HKEEP ABOVE\\033[15;1HSTALE REMOTE TEXT\\033[2;1H'"); await page.keyboard.press('Enter');
  await frame.waitForFunction(() => window.__output.includes('STALE REMOTE TEXT\x1b[2;1H'));
  await page.keyboard.type('exit'); await page.keyboard.press('Enter');
  await frame.waitForFunction(prompt => window.__shellState.ready && window.__shellState.prompt > prompt, localPrompt);
  await frame.waitForFunction(() => {
    const terminal = window.__testTerminal, buffer = terminal.buffer.active, first = buffer.length - terminal.rows;
    return buffer.getLine(first + buffer.cursorY)?.translateToString(true).endsWith(' $');
  });
  const restoredScreen = await frame.evaluate(() => {
    const terminal = window.__testTerminal, buffer = terminal.buffer.active, first = buffer.length - terminal.rows;
    return { cursor: buffer.cursorY, lines: Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(first + row)?.translateToString(true) || '') };
  });
  assert.ok(restoredScreen.lines.some(line => line.includes('KEEP ABOVE')));
  assert.ok(restoredScreen.lines.slice(restoredScreen.cursor + 1).every(line => !line), 'Returning prompt must erase stale text below it');
  assert.ok(!restoredScreen.lines.some(line => line.includes('STALE REMOTE TEXT')));
  await page.screenshot({ path: root + '/.test-artifacts/workspace-ssh-return.png' });
  await page.locator('#terminal-back').click(); await page.locator('#page-back').click(); await page.getByRole('button', { name: /Keychain Encrypted/ }).click(); await page.locator('#library-add').click(); await page.locator('#key-name').fill('Personal SSH key'); await page.locator('#key-passphrase').fill('test-key-passphrase'); await page.locator('#key-confirm').fill('test-key-passphrase'); await page.getByRole('button', { name: 'Save key', exact: true }).click(); await page.locator('#key-details').waitFor({ state: 'visible' });
  const publicKey = await page.locator('#public-key').inputValue(); assert.match(publicKey, /^ssh-ed25519 /); await writeFile(fixture + '/authorized', publicKey + '\n');
  assert.equal(await page.locator('#backend-filter').inputValue(), 'browser');
  assert.equal((await vaultData('primary')).keys.length, 0); assert.equal((await vaultData('secondary')).keys.length, 0);
  const records = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('libertty-keychain', 1); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, read = db.transaction('keys').objectStore('keys').getAll(); read.onsuccess = () => { resolve(read.result); db.close(); }; };
  }));
  assert.equal(records.length, 1); assert.ok(records[0].ciphertext); assert.ok(!JSON.stringify(records).includes('PRIVATE KEY') && !JSON.stringify(records).includes('test-key-passphrase'));
  const backupDownload = page.waitForEvent('download'); await page.locator('#export-key-backup').click();
  const backup = await readFile(await (await backupDownload).path(), 'utf8'); assert.ok(!backup.includes('PRIVATE KEY') && !backup.includes('test-key-passphrase'));
  await page.locator('#export-private-key').click(); await page.locator('#key-transfer-passphrase').fill('wrong'); await page.locator('#key-transfer-submit').click();
  await page.waitForFunction(() => document.querySelector('#key-transfer-error').textContent.includes('Incorrect passphrase'));
  await page.locator('#key-transfer-passphrase').fill('test-key-passphrase'); const privateDownload = page.waitForEvent('download'); await page.locator('#key-transfer-submit').click();
  const rawKey = await readFile(await (await privateDownload).path(), 'utf8'), parsed = ssh2.utils.parseKey(rawKey); assert.ok(!(parsed instanceof Error));
  assert.equal(parsed.getPublicSSH().toString('base64'), publicKey.split(' ')[1]);
  // A fresh browser restores the portable encrypted backup without a backend request.
  const other = await browser.newContext(), restorePage = await other.newPage();
  await restorePage.goto(origin);
  await restorePage.getByRole('button', { name: 'Cancel backend login' }).click();
  await restorePage.locator('#terminal-back').click(); await restorePage.locator('#page-back').click(); await restorePage.getByRole('button', { name: /Keychain Encrypted/ }).click();
  await other.setOffline(true);
  await restorePage.locator('#library-add').click(); await restorePage.locator('#key-name').fill('Restored browser key'); await restorePage.locator('#key-method').selectOption('import');
  await restorePage.locator('#key-import-file').setInputFiles({ name: 'backup.libertty-key.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await restorePage.locator('#key-passphrase').fill('test-key-passphrase'); await restorePage.locator('#key-confirm').fill('test-key-passphrase'); await restorePage.locator('#key-form button[type=submit]').click();
  await restorePage.locator('#key-details').waitFor({ state: 'visible' }); assert.equal(await restorePage.locator('#public-key').inputValue(), publicKey);
  assert.match(await restorePage.locator('#key-storage').innerText(), /No device backups/); await other.close();
  await page.getByRole('button', { name: 'Close key details' }).click(); await page.screenshot({ path: root + '/.test-artifacts/workspace-keychain.png' });
  await page.locator('#page-back').click(); await page.screenshot({ path: root + '/.test-artifacts/workspace-vault.png' }); await page.getByRole('button', { name: /^Hosts/ }).click();
  await page.locator('#library-add').click(); await page.locator('#host-name').fill('Remote shell'); await page.locator('#host-kind').selectOption('ssh'); await page.locator('#host-address').fill('127.0.0.1'); await page.locator('#host-user').fill(os.userInfo().username); await page.locator('#host-port').fill(String(sshPort)); await page.getByRole('button', { name: 'Save host', exact: true }).click();
  await page.screenshot({ path: root + '/.test-artifacts/workspace-hosts.png' });
  await context.route(origin + '/api/ssh/probe', async route => { await delay(150); await route.continue(); });
  await page.getByRole('button', { name: 'Remote shell SSH' }).click(); await page.locator('#ssh-secret').fill('test-key-passphrase'); await page.screenshot({ path: root + '/.test-artifacts/workspace-passphrase.png' }); await page.locator('#ssh-connect').click();
  await page.locator('#ssh-dialog').waitFor({ state: 'hidden', timeout: 30000 }); frame = await activeFrame(page); assert.equal(await frame.evaluate(() => window.__engine), 'server');
  assert.ok(await page.locator('[role=tab][aria-selected=true]').getAttribute('title').then(title => title.includes('Build server')), 'The eligible lower-latency backend should carry SSH');
  const sshSession = new URL(frame.url()).searchParams.get('session'), createsBeforeReuse = sessionCreates;
  await page.locator('#terminal-back').click();
  assert.equal(await page.getByRole('button', { name: 'Terminals for Remote shell (1 open)', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Remote shell SSH' }).click(); frame = await activeFrame(page);
  assert.equal(new URL(frame.url()).searchParams.get('session'), sshSession); assert.equal(sessionCreates, createsBeforeReuse);
  assert.equal(await page.locator('#ssh-dialog').isVisible(), false);
  await command(frame, 'printf ssh-connected > ssh-result.txt'); assert.equal(await readFile(fixture + '/remote/ssh-result.txt', 'utf8'), 'ssh-connected');
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('look at SKILL.md'); await page.keyboard.press('Enter');
  await page.locator('.reading-view .reading-markdown h1').waitFor();
  assert.equal(await page.locator('.reading-markdown h1').textContent(), 'Skill');
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  await frame.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'look at skill dot md', bubbles: true, cancelable: true })));
  await frame.getByRole('button', { name: 'Read SKILL.md', exact: true }).waitFor();
  await frame.getByRole('button', { name: 'Read SKILL.md', exact: true }).click();
  await page.locator('.reading-view:not([hidden]) .reading-markdown h1').waitFor();
  assert.equal(await page.locator('.reading-view:not([hidden]) .reading-markdown h1').textContent(), 'Skill');
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  for (const line of ['printf remote-output | look at', 'look at printf remote-output']) {
    await frame.waitForFunction(() => window.__shellState.ready);
    await frame.locator('#terminal textarea').focus(); await page.keyboard.type(line); await page.keyboard.press('Enter');
    await page.locator('.reading-view:not([hidden]) .reading-text').waitFor();
    assert.equal(await page.locator('.reading-view:not([hidden]) .reading-text').textContent(), 'remote-output');
    await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  }
  await frame.waitForFunction(() => window.__shellState.ready);
  await frame.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'Python three hello world dot py myarg food', bubbles: true, cancelable: true })));
  await frame.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'python3 hello_world.py --myarg food', {}, { timeout: 15000 });
  const pythonPrompt = await frame.evaluate(() => window.__shellState.prompt); await page.keyboard.press('Control+c');
  await frame.waitForFunction(prompt => window.__shellState.ready && window.__shellState.prompt > prompt, pythonPrompt);
  await frame.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'Cd ~ fas get fas pebble agent', bubbles: true, cancelable: true })));
  await frame.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'cd ~/git/pebble-agent', {}, { timeout: 15000 });
  await page.keyboard.press('Enter'); await frame.waitForFunction(() => window.__shellState.ready && window.__shellState.cwd.endsWith('/git/pebble-agent'));
  await page.screenshot({ path: root + '/.test-artifacts/workspace-terminal.png' });
  const lastSession = new URL(frame.url()).searchParams.get('session'); await page.reload(); frame = await activeFrame(page); assert.equal(new URL(frame.url()).searchParams.get('session'), lastSession); assert.ok((await frame.evaluate(() => window.__shellState.cwd)).endsWith('/git/pebble-agent'));
  await page.locator('[role=tab][aria-selected=true] .tab-close').click(); await until(async () => await page.locator('[role=tab]').count() === 3);
  await page.locator('#terminal-back').click();
  assert.equal(await page.getByRole('button', { name: 'Terminals for Remote shell (0 open)', exact: true }).count(), 1);
  await connectNew(page, 'This machine'); frame = await activeFrame(page);
  const endedFrameId = await page.locator('#terminal-stack iframe:visible').getAttribute('id');
  const endedSession = new URL(frame.url()).searchParams.get('session'), createsBeforeEnded = sessionCreates;
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type('exit'); await page.keyboard.press('Enter');
  await until(async () => new URL((await page.locator('#terminal-stack iframe:visible').getAttribute('src')), origin).searchParams.get('session') !== endedSession);
  frame = await activeFrame(page);
  const replacementSession = new URL(frame.url()).searchParams.get('session');
  assert.notEqual(replacementSession, endedSession); assert.equal(sessionCreates, createsBeforeEnded + 1);
  assert.equal(await page.locator('#terminal-stack iframe:visible').getAttribute('id'), endedFrameId);
  assert.equal(await frame.locator('#reconnect-banner').isVisible(), false);
  // A session removed on the backend also gets replaced without leaving a dead tab.
  await page.evaluate(async sid => { const response = await fetch('/api/sessions/close?session=' + sid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (!response.ok) throw Error('Could not close test session'); }, replacementSession);
  await until(async () => new URL((await page.locator('#terminal-stack iframe:visible').getAttribute('src')), origin).searchParams.get('session') !== replacementSession);
  frame = await activeFrame(page); assert.equal(sessionCreates, createsBeforeEnded + 2);
  assert.equal(await frame.locator('#reconnect-banner').isVisible(), false);
  await page.locator('#terminal-back').click();
  await page.getByRole('button', { name: 'Terminals for This machine (3 open)', exact: true }).waitFor();
  const createsBeforeRecoveredReuse = sessionCreates;
  await page.getByRole('button', { name: 'This machine HTTP' }).click(); frame = await activeFrame(page);
  assert.equal(await page.locator('#terminal-stack iframe:visible').getAttribute('id'), endedFrameId); assert.equal(sessionCreates, createsBeforeRecoveredReuse);
  await page.locator(`[role=tab][aria-controls="${endedFrameId}"] .tab-close`).click();
  assert.equal((await vaultData('primary')).keys.length, 0); assert.equal((await vaultData('secondary')).keys.length, 0, 'SSH must not persist browser keys');
  // Browser storage survives reload; selected devices receive explicit encrypted copies.
  await page.locator('#terminal-back').click(); await page.locator('#page-back').click(); await page.getByRole('button', { name: /Keychain Encrypted/ }).click();
  await page.getByRole('button', { name: /Personal SSH key ED25519/ }).click();
  await page.locator('#backup-key').click(); await page.locator('#backup-devices input').nth(0).check();
  await page.locator('#key-transfer-passphrase').fill('test-key-passphrase'); await page.locator('#key-transfer-submit').click(); await page.locator('#key-transfer').waitFor({ state: 'hidden' });
  assert.equal((await vaultData('primary')).keys.length, 1); assert.equal((await vaultData('secondary')).keys.length, 0);
  await page.locator('#backup-key').click(); assert.equal(await page.locator('#backup-devices input:checked').count(), 0);
  for (const check of await page.locator('#backup-devices input').all()) await check.check();
  await page.locator('#key-transfer-passphrase').fill('test-key-passphrase'); await page.locator('#key-transfer-submit').click(); await page.locator('#key-transfer').waitFor({ state: 'hidden' });
  assert.equal((await vaultData('primary')).keys.length, 1); assert.equal((await vaultData('secondary')).keys.length, 1);
  const disk = await readFile(fixture + '/primary/vault.json', 'utf8'); assert.ok(!disk.includes('PRIVATE KEY') && !disk.includes('test-key-passphrase'));
  const backupKey = (await vaultData('primary')).keys[0];
  assert.equal((await request(origin, 'keychain', ownerA, { action: 'export', id: backupKey.id, passphrase: 'wrong' })).status, 400);
  // A failed destination does not erase successful backups; retry updates, not duplicates.
  await context.route(secondary + '/api/keychain', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test device unavailable' }) }) : route.continue());
  await page.locator('#backup-key').click(); for (const check of await page.locator('#backup-devices input').all()) await check.check();
  await page.locator('#key-transfer-passphrase').fill('test-key-passphrase'); await page.locator('#key-transfer-submit').click();
  await page.waitForFunction(() => document.querySelector('#key-transfer-error').textContent.includes('Test device unavailable'));
  assert.equal((await vaultData('primary')).keys.length, 1); await context.unroute(secondary + '/api/keychain');
  await page.locator('#key-transfer-passphrase').fill('test-key-passphrase'); await page.locator('#key-transfer-submit').click(); await page.locator('#key-transfer').waitFor({ state: 'hidden' });
  assert.equal((await vaultData('secondary')).keys.length, 1);
  // A backend backup can restore the canonical key after local deletion.
  await page.locator('#delete-key').click(); await page.locator('#key-details').waitFor({ state: 'hidden' });
  await page.locator('#backend-filter').selectOption('primary'); await page.getByRole('button', { name: /Personal SSH key ED25519/ }).click();
  await page.locator('#restore-backend-key').click(); await page.locator('#key-transfer-passphrase').fill('test-key-passphrase'); await page.locator('#key-transfer-submit').click(); await page.locator('#key-transfer').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#backend-filter').inputValue(), 'browser'); assert.equal(await page.locator('#public-key').inputValue(), publicKey);
  assert.match(await page.locator('#key-storage').innerText(), /Source of truth: this browser/);
  await page.getByRole('button', { name: 'Close key details' }).click(); await page.locator('#nav-terminals').click();
  // Raw SSH-file import is validated by the backend but stored only in the browser.
  await page.locator('#terminal-back').click(); await page.locator('#page-back').click(); await page.getByRole('button', { name: /Keychain Encrypted/ }).click();
  await page.locator('#library-add').click(); await page.locator('#key-name').fill('Imported SSH file'); await page.locator('#key-method').selectOption('import'); await page.locator('#key-import').fill(rawKey);
  await page.locator('#key-passphrase').fill('x'); await page.locator('#key-confirm').fill('x'); await page.locator('#key-form button[type=submit]').click(); await page.locator('#key-details').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#public-key').inputValue(), publicKey); assert.equal((await vaultData('primary')).keys.length, 1);
  await page.locator('#key-rename').fill('Renamed import'); await page.locator('#rename-key').click();
  await page.getByRole('button', { name: /Renamed import ED25519/ }).click(); await page.locator('#delete-key').click(); await page.locator('#key-details').waitFor({ state: 'hidden' });
  await page.locator('#nav-terminals').click();
  // A changed pin must fail even if the caller supplies trust for the new key.
  const backendToken = await page.evaluate(url => localStorage.getItem('libertty.access:' + url + '/'), secondary);
  const remoteKey = (await vaultData('secondary')).keys[0];
  await setFixturePin('SHA256:changed-fixture');
  const changed = await request(secondary, 'sessions', backendToken, { name: 'changed host', ssh: { host: '127.0.0.1', port: sshPort, username: os.userInfo().username, keyId: remoteKey.id, passphrase: 'test-key-passphrase', trust: 'ignored' } });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).changed, true);
  // A phone may resume on Hosts with cached credentials after its backend restarted.
  // Remove terminal documents so their independent reconnect cannot conceal a stale
  // workspace credential. Keep the workspace itself alive throughout both restarts.
  await page.locator('#terminal-back').click();
  await page.locator('#terminal-stack iframe').evaluateAll(frames => frames.forEach(frame => frame.remove()));
  const restart = async index => {
    const stopped = new Promise(resolve => backends[index].once('exit', resolve)); backends[index].kill('SIGTERM'); await stopped;
    backends[index] = startBackend(backendSpecs[index]);
    await until(async () => { try { return (await fetch(index ? secondary : origin)).ok; } catch { return false; } });
  };
  let unauthorizedCreates = 0, successfulCreates = 0;
  page.on('response', response => { if (response.request().method() === 'POST' && response.url().endsWith('/api/sessions')) { if (response.status() === 401) unauthorizedCreates++; if (response.ok()) successfulCreates++; } });
  await restart(0);
  await connectNew(page, 'This machine');
  await page.locator('#terminal-header').waitFor({ state: 'visible', timeout: 10000 }); frame = await activeFrame(page);
  await command(frame, 'printf recovered > recovered-primary.txt'); assert.equal(await readFile(fixture + '/recovered-primary.txt', 'utf8'), 'recovered');
  assert.equal(unauthorizedCreates, 0); assert.equal(successfulCreates, 1);
  assert.equal(await page.locator('#backend-login').isVisible(), false);
  await page.locator('#terminal-back').click(); await restart(1);
  await connectNew(page, 'Build server');
  await page.locator('#terminal-header').waitFor({ state: 'visible' }); frame = await activeFrame(page);
  await command(frame, 'printf recovered > recovered-secondary.txt'); assert.equal(await readFile(fixture + '/recovered-secondary.txt', 'utf8'), 'recovered');
  assert.equal(unauthorizedCreates, 0); assert.equal(successfulCreates, 2);
  assert.equal(await page.locator('#backend-login').isVisible(), false);
  // A fresh browser session has neither sessionStorage nor cookies. Persisted
  // per-backend credentials must recover both local and cross-origin access.
  const stored = await context.storageState(); stored.cookies = [];
  for (const entry of stored.origins) entry.localStorage = entry.localStorage.filter(item => !['libertty.tabs', 'libertty.activeTab'].includes(item.name));
  const reopened = await browser.newContext({ storageState: stored }), reopenedPage = await reopened.newPage();
  await reopenedPage.goto(origin);
  const reopenedFrame = await (await reopenedPage.locator('#terminal-stack iframe').elementHandle()).contentFrame();
  await reopenedFrame.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Connected');
  assert.equal(await reopenedPage.locator('#backend-login').isVisible(), false);
  await reopenedPage.locator('#terminal-back').click(); await reopenedPage.getByRole('button', { name: 'Build server HTTP' }).click();
  const remoteFrame = await (await reopenedPage.locator('#terminal-stack iframe:visible').elementHandle()).contentFrame();
  await remoteFrame.waitForFunction(() => document.querySelector('#connection-label')?.textContent === 'Connected');
  assert.equal(await reopenedPage.locator('#backend-login').isVisible(), false);
  assert.equal(new URL(remoteFrame.url()).searchParams.get('backend'), secondary + '/');
  await reopened.close();
  // Capture the authoritative Readline buffer across all ways of entering SSH.
  await writeFile(fixture + '/authorized', nestedKey.public + '\n');
  await writeFile(fixture + '/capture-host', '');
  const captureConfig = fixture + '/capture-config';
  await writeFile(captureConfig, `Host capture-host\n HostName 127.0.0.1\n User ${os.userInfo().username}\n Port ${sshPort}\n IdentityFile ${fixture}/nested-key\n IdentitiesOnly yes\n IdentityAgent none\n UserKnownHostsFile ${fixture}/nested-known\n GlobalKnownHostsFile /dev/null\n`);
  const sshCommand = `ssh -F ${captureConfig} capture-host`, parentId = await page.locator('#terminal-stack iframe:visible').getAttribute('id');
  const capturedTabsBefore = await page.locator('[role=tab]').count();
  // The secondary test backend's changed-key fixture must be explicitly forgotten.
  await setFixturePin();
  // Reconnection/terminal-cleanup wrappers must still hand off to remote facts.
  await command(frame, 'ssh() { local rc started; started=$SECONDS; command ssh "$@"; rc=$?; printf wrapper-cleanup; return "$rc"; }');
  for (const method of ['typing', 'history', 'search', 'completion', 'paste', 'reload']) {
    frame = await activeFrame(page);
    await command(frame, `history -s '${sshCommand}'`);
    await frame.locator('#terminal textarea').focus();
    if (method === 'history') await page.keyboard.press('ArrowUp');
    else if (method === 'search') { await page.keyboard.press('Control+r'); await page.keyboard.type('capture-host'); await page.keyboard.press('ArrowRight'); }
    else if (method === 'completion') { await page.keyboard.type(`ssh -F ${captureConfig} capture-h`); await page.keyboard.press('Tab'); }
    else if (method === 'paste') await frame.evaluate(command => window.__testTerminal.paste(command), sshCommand);
    else await page.keyboard.type(sshCommand);
    if (method === 'typing') await context.route(secondary + '/api/ssh/captured?**', async route => {
      if (!route.request().postDataJSON().action) await delay(500);
      await route.continue();
    });
    if (method === 'reload') await context.route(secondary + '/api/ssh/captured?**', async route => {
      if (route.request().postDataJSON().action) { await route.continue(); return; }
      const response = await route.fetch(); if (response.ok()) { await route.abort(); } else await route.fulfill({ response });
    });
    const completed = method === 'reload' ? page.waitForEvent('requestfailed', { predicate: request => request.url().includes('/api/ssh/captured'), timeout: 20000 }) : undefined;
    await page.keyboard.press('Enter');
    if (method === 'typing') await page.locator('#terminal-loading').waitFor({ state: 'visible' });
    if (completed) { await completed; await context.unroute(secondary + '/api/ssh/captured?**'); await page.reload(); }
    await until(async () => await page.locator('[role=tab]').count() === capturedTabsBefore + 1, 20000);
    if (method === 'typing') await context.unroute(secondary + '/api/ssh/captured?**');
    const childId = await page.locator('#terminal-stack iframe:visible').getAttribute('id'); frame = await activeFrame(page);
    assert.equal(await page.locator('#terminal-loading').isVisible(), false, 'SSH loading ends at the remote prompt');
    assert.notEqual(childId, parentId, method); assert.equal(await frame.evaluate(() => window.__engine), 'server');
    assert.equal(await page.locator('#ssh-dialog').isVisible(), false); assert.equal(await page.locator('#captured-ssh-dialog').isVisible(), false);
    await command(frame, `printf ${method} > capture-${method}.txt`);
    assert.equal(await readFile(fixture + '/remote/capture-' + method + '.txt', 'utf8'), method);
    if (method === 'typing') {
      for (const [input, expected] of [['Alice', 'ls'], ['Alas', 'ls'], ['L S', 'ls'], ['L. S.', 'ls'], ['vi skill dot md', 'vi SKILL.md'], ['Python three hello world dot py myarg food', 'python3 hello_world.py --myarg food']]) {
        await frame.locator('#terminal textarea').evaluate((el, input) => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: input, bubbles: true, cancelable: true })), input);
        await frame.waitForFunction(expected => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === expected, expected);
        assert.ok((await frame.locator('.alternative-choice .choice-command').allTextContents()).includes(input));
        const prompt = await frame.evaluate(() => window.__shellState.prompt); await page.keyboard.press('Control+c');
        await frame.waitForFunction(prompt => window.__shellState.ready && window.__shellState.prompt > prompt, prompt);
      }
      await frame.locator('#terminal textarea').evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'Cd ~ fas get fas pebble agent', bubbles: true, cancelable: true })));
      await frame.waitForFunction(() => document.querySelector('.alternative-choice.selected .choice-command')?.textContent === 'cd ~/git/pebble-agent');
      await page.keyboard.press('Enter'); await frame.waitForFunction(() => window.__shellState.cwd.endsWith('/git/pebble-agent'));
    }
    await frame.locator('#terminal textarea').focus(); await page.keyboard.type('exit'); await page.keyboard.press('Enter');
    await until(async () => await page.locator('#terminal-stack iframe:visible').getAttribute('id') === parentId);
    await page.locator(`[role=tab][aria-controls="${childId}"] .tab-close`).click();
  }
  const references = (await vaultData('secondary')).keys.filter(key => key.reference);
  assert.equal(references.length, 1); assert.equal(references[0].reference.path, fixture + '/nested-key');
  const persisted = JSON.parse(await readFile(fixture + '/secondary/vault.json', 'utf8')).keys.find(key => key.reference);
  assert.equal(persisted.ciphertext, undefined); assert.equal(persisted.privateKey, undefined);
  assert.deepEqual(Object.keys(persisted).sort(), ['createdAt', 'fingerprint', 'id', 'name', 'publicKey', 'reference']);
  // The discovered host reuses the reference without another passphrase dialog.
  await page.locator('#terminal-back').click();
  await page.getByRole('button', { name: new RegExp('^' + os.userInfo().username + '@127\\.0\\.0\\.1 SSH') }).click();
  await until(async () => await page.locator('[role=tab]').count() === capturedTabsBefore + 1, 20000);
  frame = await activeFrame(page); assert.equal(await page.locator('#ssh-dialog').isVisible(), false);
  await command(frame, 'printf reused > capture-reused.txt'); assert.equal(await readFile(fixture + '/remote/capture-reused.txt', 'utf8'), 'reused');
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  await until(async () => await page.locator('[role=tab]').count() === capturedTabsBefore);
  await page.locator(`[role=tab][aria-controls="${parentId}"]`).click(); frame = await activeFrame(page);
  // Agent authentication signs with the backend agent and never persists its private key.
  const agentSocket = fixture + '/agent.sock'; start('/usr/bin/ssh-agent', ['-D', '-a', agentSocket]);
  await until(async () => access(agentSocket).then(() => true, () => false));
  await new Promise((resolve, reject) => execFile('/usr/bin/ssh-add', [fixture + '/nested-key'], { env: { ...process.env, SSH_AUTH_SOCK: agentSocket } }, error => error ? reject(error) : resolve()));
  await command(frame, `export SSH_AUTH_SOCK=${agentSocket}`);
  const configBase = `Host capture-host\n HostName 127.0.0.1\n User ${os.userInfo().username}\n Port ${sshPort}\n UserKnownHostsFile ${fixture}/nested-known\n GlobalKnownHostsFile /dev/null\n`;
  await writeFile(captureConfig, configBase + ' IdentityFile none\n IdentitiesOnly no\n');
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type(sshCommand); await page.keyboard.press('Enter');
  await until(async () => await page.locator('[role=tab]').count() === capturedTabsBefore + 1, 20000);
  frame = await activeFrame(page); assert.equal(await page.locator('#captured-ssh-dialog').isVisible(), false);
  await command(frame, 'printf agent > capture-agent.txt'); assert.equal(await readFile(fixture + '/remote/capture-agent.txt', 'utf8'), 'agent');
  const agentReference = (await vaultData('secondary')).keys.find(key => key.reference?.type === 'agent'); assert.equal(agentReference.reference.path, agentSocket);
  assert.ok(await page.evaluate(id => JSON.parse(localStorage.getItem('libertty.hosts')).some(host => host.backendKeyId === id), agentReference.id));
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  await until(async () => await page.locator('[role=tab]').count() === capturedTabsBefore);
  await page.locator(`[role=tab][aria-controls="${parentId}"]`).click(); frame = await activeFrame(page);
  // A locked file asks only when needed, retains the request after a wrong passphrase,
  // and registers its reference only after successful SSH authentication.
  const lockedPair = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'existing-pass', cipher: 'aes256-cbc', rounds: 4 });
  await writeFile(fixture + '/locked-key', lockedPair.private, { mode: 0o600 }); await writeFile(fixture + '/locked-key.pub', lockedPair.public); await writeFile(fixture + '/authorized', lockedPair.public + '\n');
  await writeFile(captureConfig, configBase + ` IdentityFile ${fixture}/locked-key\n IdentitiesOnly yes\n IdentityAgent none\n`);
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type(sshCommand); await page.keyboard.press('Enter');
  await page.locator('#captured-ssh-dialog').waitFor({ state: 'visible' }); assert.ok(!(await vaultData('secondary')).keys.some(key => key.reference?.path.endsWith('/locked-key')));
  await page.locator('#captured-ssh-secret').fill('wrong'); await page.locator('#captured-ssh-connect').click();
  await page.waitForFunction(() => !document.querySelector('#captured-ssh-connect').disabled && document.querySelector('#captured-ssh-error').textContent.includes('unlocked'));
  await page.locator('#captured-ssh-secret').fill('existing-pass'); await page.locator('#captured-ssh-connect').click();
  await page.locator('#captured-ssh-dialog').waitFor({ state: 'hidden' }); frame = await activeFrame(page);
  await command(frame, 'printf unlocked > capture-unlocked.txt'); assert.equal(await readFile(fixture + '/remote/capture-unlocked.txt', 'utf8'), 'unlocked');
  const lockedReference = (await vaultData('secondary')).keys.find(key => key.reference?.path.endsWith('/locked-key')); assert.ok(lockedReference);
  await page.locator('[role=tab][aria-selected=true] .tab-close').click();
  await until(async () => await page.locator('[role=tab]').count() === capturedTabsBefore);
  await page.locator(`[role=tab][aria-controls="${parentId}"]`).click(); frame = await activeFrame(page);
  // Cancelling a captured connection leaves the original shell usable.
  await frame.locator('#terminal textarea').focus(); await page.keyboard.type(sshCommand); await page.keyboard.press('Enter'); await page.locator('#captured-ssh-dialog').waitFor({ state: 'visible' });
  await page.locator('#captured-ssh-cancel').click(); await page.locator('#captured-ssh-dialog').waitFor({ state: 'hidden' });
  // The HTTP response can close the modal before the socket releases input.
  await frame.waitForFunction(() => window.__sshCapture === undefined);
  await command(frame, 'printf usable > capture-cancelled.txt'); assert.equal(await readFile(fixture + '/capture-cancelled.txt', 'utf8'), 'usable');
  await command(frame, 'ssh() { printf native > capture-function.txt; }');
  await command(frame, 'ssh capture-host');
  await until(async () => readFile(fixture + '/capture-function.txt', 'utf8').then(value => value === 'native', error => { if (error.code === 'ENOENT') return false; throw error; }));
  assert.equal(await readFile(fixture + '/capture-function.txt', 'utf8'), 'native');
  await command(frame, 'unset -f ssh');
  // Replacing a referenced file cannot silently authenticate as a different identity.
  await writeFile(fixture + '/locked-key', nestedKey.private);
  const currentToken = await page.evaluate(url => localStorage.getItem('libertty.access:' + url + '/'), secondary);
  const replaced = await request(secondary, 'sessions', currentToken, { name: 'changed reference', ssh: { host: '127.0.0.1', port: sshPort, username: os.userInfo().username, keyId: lockedReference.id, passphrase: 'existing-pass' } });
  assert.equal(replaced.status, 400); assert.match((await replaced.json()).error, /referenced SSH key has changed/);
  assert.deepEqual(errors, []);
  console.log('PASS workspace: Readline SSH capture (typing/history/search/completion/paste), remote alternatives, backend key references, recovered handoffs, clean prompt after nested SSH exit, terminal-first, settings pane and shared preferences, 10 pt, persistent isolated tabs, host reuse/count/menu, explicit new terminals, automatic ended-shell replacement, background output, direct cross-origin backend, local encrypted IndexedDB vault, offline backup restore, unlocked private export, explicit multi-device backups, backend restore, transient browser SSH keys, verified OpenSSH, automatic routing, remote directory/Python repair, SSH reconnect and close, CORS, owner isolation, single-use tickets, changed-host rejection and remembered pairing after backend and browser restarts');
} catch (error) { console.error(logs.join('')); console.error(error); if (browser) { const pages = browser.contexts()[0]?.pages(); if (pages?.[0]) { await pages[0].screenshot({ path: root + '/.test-artifacts/workspace-failure.png' }); console.error(await pages[0].locator('body').innerText()); } } process.exitCode = 1; }
finally { await browser?.close(); for (const proc of processes) proc.kill('SIGTERM'); await delay(500); for (const proc of processes) if (proc.exitCode === null) proc.kill('SIGKILL'); await rm(fixture, { recursive: true, force: true }); }
