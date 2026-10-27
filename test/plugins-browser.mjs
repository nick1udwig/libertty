import { launchBrowser, freePort, delay, until } from './support/browser.mjs';
import { showTerminalTabs, connectSSH } from './support/workspace-navigation.mjs';
import { fingerprint } from './support/ssh-key.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import ssh2 from 'ssh2';
import { sshdPath, sshFixturePath, sshdConfig } from './support/sshd.mjs';
import { WebSocket } from 'ws';
import { herdrFixture } from './herdr-fixture.ts';

const root = new URL('../', import.meta.url).pathname, fixture = await herdrFixture();
const port = await freePort(), sshPort = await freePort(), origin = 'http://127.0.0.1:' + port, base = origin + '/plugins-test', processes = [], errors = [];
let logs = '', browser, page, bearer;
function start(command, args, env = {}) { const process = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...globalThis.process.env, ...env } }); processes.push(process); process.stdout.on('data', b => logs += b); process.stderr.on('data', b => logs += b); return process; }
async function request(route, data, credential = bearer) { return fetch(base + '/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(credential ? { Authorization: 'Bearer ' + credential } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); }
async function settings() { if (await page.locator('#workspace-navigation').isVisible()) { await showTerminalTabs(page); await page.locator('#terminal-back').click(); } await page.locator('#nav-settings').click(); }
async function hosts() { if (await page.locator('#nav-terminals').isVisible()) await page.locator('#nav-terminals').click(); await showTerminalTabs(page); await page.locator('#terminal-back').click(); }
async function action(name, host = 'This machine') { await hosts(); await page.getByRole('button', { name: new RegExp('^Terminals for ' + host + ' ') }).click(); await page.getByRole('menuitem', { name, exact: true }).click(); }
async function pluginFrame() { const element = await page.locator('#terminal-stack > iframe[sandbox]:visible').elementHandle(); const frame = await element.contentFrame(); await frame.waitForFunction(() => !!window.libertty); await frame.evaluate(() => libertty.ready); return frame; }
async function tabClosed(tab) { await page.waitForFunction(id => !JSON.parse(localStorage.getItem('libertty.tabs')).some(tab => tab.id === id), tab.id); }
async function loadPackage(pkg) {
  await settings(); await page.locator('#plugin-file').setInputFiles({ name: 'plugin.libertty-plugin.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pkg)) });
  await until(async () => (await page.locator('#plugin-list').textContent()).includes(pkg.manifest.version), 'plugin installation');
}
try {
  await writeFile(fixture.directory + '/app.log', 'info started\nwarning review this\n');
  await mkdir(fixture.directory + '/remote'); await writeFile(fixture.directory + '/remote/app.log', 'remote warning\n');
  start(root + 'target/debug/libertty', [], { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), LIBERTTY_BASE_PATH: '/plugins-test', LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_ALLOWED_ORIGINS: origin, LIBERTTY_DATA_DIR: fixture.directory + '/data', LIBERTTY_TOKEN: 'plugin-test-pairing-token-123456789', LIBERTTY_NO_RC: '1', LIBERTTY_CWD: fixture.directory, HOME: fixture.directory, HERDR_SOCKET_PATH: fixture.socketPath, PATH: fixture.directory + ':' + process.env.PATH });
  await until(async () => { try { return (await fetch(base + '/')).ok; } catch { return false; } }, 'backend');
  assert.equal((await request('plugins/read?path=app.log', undefined, undefined)).status, 401);
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.stack || String(error)));
  await page.clock.install();
  await page.goto(base + '/'); await page.locator('#backend-token').fill('plugin-test-pairing-token-123456789'); await page.locator('#backend-login-form button[type=submit]').click();
  await until(async () => (await page.locator('#terminal-stack > iframe').count()) === 1, 'default terminal');
  const cookieOwner = await page.evaluate(async () => (await (await fetch(new URL('api/connect', document.baseURI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"noSession":true}' })).json()).accessToken);
  bearer = cookieOwner;
  await hosts(); await page.getByRole('button', { name: /^Terminals for This machine / }).click();
  assert.deepEqual(await page.locator('#host-terminal-menu button').allTextContents(), ['Connect new terminal', 'Connect SFTP / Files', 'Connect Herdr', 'This machine', 'Edit host']);
  await page.getByRole('menuitem', { name: 'Connect SFTP / Files', exact: true }).click();
  await page.locator('.file-browser').waitFor();
  const filesTab = await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.pluginId === 'files'));
  await page.getByRole('button', { name: 'Close ' + filesTab.name, exact: true }).last().click();
  await tabClosed(filesTab);
  assert.ok(!(await (await request('sessions')).json()).some(session => session.id === filesTab.session), 'Files releases its connection');

  const sample = JSON.parse(await readFile(root + 'examples/plugins/example.log-viewer.libertty-plugin.json', 'utf8'));
  await settings(); await page.locator('#plugin-file').setInputFiles({ name: 'unsupported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...sample, manifest: { ...sample.manifest, permissions: ['shell.exec'] } })) });
  await page.locator('#plugin-install-error').filter({ hasText: 'file.read permission' }).waitFor();
  await loadPackage(sample); await action('Connect Log viewer'); await page.locator('#plugin-read-path').fill('app.log'); await page.locator('#plugin-connect-form button[type=submit]').click();
  let frame = await pluginFrame(); await frame.locator('#log').filter({ hasText: 'warning review this' }).waitFor();
  const logTab = await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.pluginId === 'example.log-viewer'));
  assert.equal(logTab.readPath, fixture.directory + '/app.log');
  assert.equal((await request('ticket?session=' + logTab.session, {})).status, 404, 'Plugin connections allocate no PTY');
  const denied = await frame.evaluate(async base => {
    const result = {};
    try { void parent.localStorage; result.parent = 'accessible'; } catch { result.parent = 'blocked'; }
    try { void localStorage.length; result.storage = 'accessible'; } catch { result.storage = 'blocked'; }
    try { await fetch(base + '/api/keychain'); result.fetch = 'accessible'; } catch { result.fetch = 'blocked'; }
    try { await libertty.request('file.read', { path: '/etc/passwd' }); result.path = 'accessible'; } catch { result.path = 'blocked'; }
    try { await libertty.request('shell.exec', { command: 'id' }); result.shell = 'accessible'; } catch { result.shell = 'blocked'; }
    result.context = Object.keys(await libertty.ready).sort(); return result;
  }, base);
  assert.deepEqual(denied, { parent: 'blocked', storage: 'blocked', fetch: 'blocked', path: 'blocked', shell: 'blocked', context: ['name', 'state'] });
  await appendFile(fixture.directory + '/app.log', 'warning updated\n'); await until(async () => (await frame.locator('#log').textContent()).includes('warning updated'), 'live log refresh');
  await frame.locator('#filter').fill('warning'); await until(async () => await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.pluginId === 'example.log-viewer')?.pluginState?.filter === 'warning'), 'plugin state');
  let reads = 0; page.on('request', request => { if (request.url().includes('/api/plugins/read')) reads++; });
  await settings(); await frame.waitForFunction(() => libertty.visible === false);
  const hiddenReads = reads; await page.clock.runFor(2200); assert.equal(reads, hiddenReads, 'Hidden plugin views pause their reads');
  await page.locator('#nav-terminals').click(); await page.reload(); frame = await pluginFrame(); assert.equal(await frame.locator('#filter').inputValue(), 'warning');
  await frame.locator('#log').filter({ hasText: 'warning updated' }).waitFor();
  assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Plugin fits a mobile viewport');
  await mkdir(root + '.test-artifacts', { recursive: true }); await page.screenshot({ path: root + '.test-artifacts/plugins-mobile.png' });

  await settings(); await page.getByRole('checkbox', { name: 'Enable Log viewer' }).uncheck(); await page.locator('#nav-terminals').click();
  await page.getByText(/This plugin version is missing or disabled/).waitFor();
  await settings(); await page.getByRole('checkbox', { name: 'Enable Log viewer' }).check(); await page.locator('#nav-terminals').click(); frame = await pluginFrame(); assert.equal(await frame.locator('#filter').inputValue(), 'warning');
  const updated = { ...sample, manifest: { ...sample.manifest, version: '2.0.0' }, view: sample.view.replace('Log viewer</h1>', 'Log viewer v2</h1>') };
  await loadPackage(updated); await page.locator('#nav-terminals').click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.id === JSON.parse(localStorage.getItem('libertty.activeTab'))).pluginVersion), '1.0.0', 'Open tabs keep their package version');
  await action('Connect Log viewer'); await page.locator('#plugin-read-path').fill('app.log'); await page.locator('#plugin-connect-form button[type=submit]').click(); await pluginFrame();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.id === JSON.parse(localStorage.getItem('libertty.activeTab'))).pluginVersion), '2.0.0');
  await settings(); await page.getByRole('button', { name: 'Remove plugin', exact: true }).click(); await page.locator('#nav-terminals').click(); await page.getByText(/This plugin version is missing or disabled/).filter({ visible: true }).waitFor();
  await page.reload(); await page.getByText(/This plugin version is missing or disabled/).filter({ visible: true }).waitFor();
  await loadPackage(sample); await page.locator('#nav-terminals').click();
  await showTerminalTabs(page); await page.locator('#tabs .tab').filter({ hasText: 'Log viewer' }).first().click(); frame = await pluginFrame(); assert.equal(await frame.locator('#filter').inputValue(), 'warning', 'Reinstalling restores retained state');
  await page.getByRole('button', { name: 'Close Log viewer · This machine', exact: true }).first().click();
  await tabClosed(logTab);
  assert.ok(!(await (await request('sessions')).json()).some(session => session.id === logTab.session), 'Plugin tab close releases its session');

  await action('Connect Herdr'); await page.locator('#plugin-connect-form button[type=submit]').click(); await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').first().waitFor();
  const localHerdr = await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.pluginId === 'herdr'));
  assert.equal(localHerdr.ownsSession, true); assert.equal(localHerdr.herdrSource, localHerdr.session);
  assert.equal((await request('ticket?session=' + localHerdr.session, {})).status, 404);
  await page.reload(); await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').first().waitFor();
  await showTerminalTabs(page); await page.getByRole('button', { name: 'Close ' + localHerdr.name, exact: true }).click();
  await tabClosed(localHerdr);
  assert.ok(!(await (await request('sessions')).json()).some(session => session.id === localHerdr.session));
  assert.equal((await request('herdr/snapshot')).status, 200, 'Closing the view leaves Herdr agents running');

  const hostKey = ssh2.utils.generateKeyPairSync('ed25519'), identity = ssh2.utils.generateKeyPairSync('ed25519');
  await writeFile(fixture.directory + '/host-key', hostKey.private, { mode: 0o600 }); await writeFile(fixture.directory + '/authorized', identity.public + '\n');
  await sshdConfig(fixture.directory, sshPort, { hostKey: 'host-key', pid: 'sshd.pid', env: { HERDR_SOCKET_PATH: fixture.socketPath, PATH: sshFixturePath(fixture.directory) } });
  start(sshdPath(), ['-D', '-e', '-f', fixture.directory + '/sshd_config']);
  await delay(150);
  const key = await (await request('keychain', { action: 'create', name: 'Fixture key', privateKey: identity.private, passphrase: 'fixture-secret' })).json();
  assert.ok(key.id);
  await page.evaluate(({ key, sshPort, username }) => {
    const hosts = JSON.parse(localStorage.getItem('libertty.hosts')); hosts.push({ id: 'ssh-plugin', name: 'Remote host', kind: 'ssh', backendId: 'primary', hostname: '127.0.0.1', port: sshPort, username, route: 'fixed', keyFingerprint: key.fingerprint }); localStorage.setItem('libertty.hosts', JSON.stringify(hosts));
  }, { key, sshPort, username: os.userInfo().username });
  await page.reload();
  const trustPrompts = [];
  page.on('dialog', dialog => { trustPrompts.push(dialog.message()); return dialog.accept(); });
  if (process.env.TEST_SSH_CONNECT_DELAY_MS) {
    let delayed = false;
    await context.route('**/api/sessions', async route => {
      if (!delayed && route.request().postDataJSON()?.ssh?.trust) {
        delayed = true;
        const response = await route.fetch();
        await delay(Number(process.env.TEST_SSH_CONNECT_DELAY_MS));
        await route.fulfill({ response });
      } else await route.continue();
    });
  }
  await action('Connect Log viewer', 'Remote host'); await page.locator('#plugin-read-path').fill(fixture.directory + '/remote/app.log'); await page.locator('#plugin-connect-form button[type=submit]').click(); await page.locator('#ssh-secret').fill('fixture-secret'); await connectSSH(page);
  assert.equal(trustPrompts.length, 1, 'Unknown SSH hosts require fingerprint verification');
  assert.ok(trustPrompts[0].includes(fingerprint(ssh2.utils.parseKey(hostKey.private).getPublicSSH())));
  frame = await pluginFrame(); await frame.locator('#log').filter({ hasText: 'remote warning' }).waitFor();
  const remoteLog = await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.pluginId === 'example.log-viewer' && tab.hostId === 'ssh-plugin'));
  await page.getByRole('button', { name: 'Close ' + remoteLog.name, exact: true }).click();
  await tabClosed(remoteLog);
  assert.ok(!(await (await request('sessions')).json()).some(session => session.id === remoteLog.session), 'Remote plugin cleanup closes its SSH connection');
  await action('Connect Herdr', 'Remote host'); await page.locator('#plugin-connect-form button[type=submit]').click(); await page.locator('#ssh-secret').fill('fixture-secret'); await connectSSH(page);
  await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').first().waitFor();
  const remoteHerdr = await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).find(tab => tab.pluginId === 'herdr' && tab.hostId === 'ssh-plugin'));
  assert.equal(remoteHerdr.ownsSession, true); assert.equal(remoteHerdr.herdrSource, remoteHerdr.session);
  const sourceTabs = await page.evaluate(() => JSON.parse(localStorage.getItem('libertty.tabs')).filter(tab => tab.hostId === 'ssh-plugin'));
  assert.equal(sourceTabs.length, 1, 'Direct SSH Herdr needs no source terminal');
  const other = (await (await request('connect', { noSession: true, token: 'plugin-test-pairing-token-123456789' }, '')).json()).accessToken;
  assert.equal((await request('herdr/ticket?herdrSource=' + remoteHerdr.herdrSource, {}, other)).status, 404);
  assert.equal((await request('plugins/read?session=' + remoteHerdr.session + '&path=' + encodeURIComponent(fixture.directory + '/remote/app.log'), undefined, other)).status, 404, 'Other pairings cannot read plugin sessions');
  await action('Connect new terminal', 'Remote host'); await page.locator('#ssh-secret').fill('fixture-secret'); await connectSSH(page);
  await until(async () => await page.locator('#terminal-stack > iframe:not([sandbox]):visible').count() === 1, 'independent SSH terminal');
  await page.getByRole('button', { name: 'Close Remote host', exact: true }).click();
  await showTerminalTabs(page); await page.locator('#tabs .herdr-tab').filter({ hasText: 'Remote host' }).click(); await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').first().waitFor();
  const ticket = await (await request('herdr/ticket?herdrSource=' + remoteHerdr.herdrSource, {})).json();
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/herdr/ws?herdrSource=' + remoteHerdr.herdrSource + '&ticket=' + ticket.ticket, { origin });
  await once(socket, 'open'); const closed = once(socket, 'close');
  await showTerminalTabs(page); await page.getByRole('button', { name: 'Close ' + remoteHerdr.name, exact: true }).click(); await closed;
  await tabClosed(remoteHerdr);
  assert.ok(!(await (await request('sessions')).json()).some(session => session.id === remoteHerdr.session));
  assert.equal((await request('herdr/ticket?herdrSource=' + remoteHerdr.herdrSource, {})).status, 404, 'Closed connections cannot issue new tickets');
  assert.equal((await request('herdr/snapshot')).status, 200, 'Remote connection cleanup leaves agents running');

  assert.deepEqual(errors, []); console.log('Plugin browser checks passed: runtime installation, scoped bridge, state/versions, unavailable packages, mobile layout, local and independent SSH Herdr, ownership and cleanup.');
} catch (error) { console.error(logs); if (page) await page.screenshot({ path: '/tmp/libertty-plugin-failure.png' }).catch(() => {}); throw error; }
finally { await browser?.close(); for (const process of processes.reverse()) { const exited = once(process, 'exit'); process.kill('SIGTERM'); await exited; } await fixture.close(); }
