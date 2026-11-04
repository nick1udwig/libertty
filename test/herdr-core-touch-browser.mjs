import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { launchBrowser, freePort, pair, waitForBackend } from './support/browser.mjs';
import { installWireObserver } from './wire-observer.mjs';
import { exerciseCoreTouch } from './support/core-touch.mjs';

const root = await mkdtemp('/tmp/libertty-core-touch-');
const hc = process.env.LIBERTTY_HC_BINARY || 'hc', session = 'touch';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HC_')));
Object.assign(env, {
  HC_SESSION: session, HC_SOCKET: root + '/core.sock',
  XDG_CONFIG_HOME: root + '/config', XDG_STATE_HOME: root + '/state', XDG_RUNTIME_DIR: root + '/runtime',
  LIBERTTY_HC_BINARY: hc, TERM: 'xterm-256color',
});
await mkdir(root + '/runtime');
await mkdir(root + '/config/herdr-core', { recursive: true });
await writeFile(root + '/config/herdr-core/config.toml', 'shell = ["/bin/bash", "--noprofile", "--norc"]\n');
const port = await freePort(), base = `http://127.0.0.1:${port}/`;
const token = 'core-touch-test-pairing-token-123456789';
let backend, browser, bearer, created, logs = '';
async function action(body) {
  const response = await fetch(base + 'api/herdr/action?herdrCore=1&herdrSession=' + session, {
    method: 'POST', headers: { Origin: base.slice(0, -1), Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
try {
  backend = spawn(new URL('../target/debug/libertty', import.meta.url).pathname, [], {
    env: { ...env, HOST: '127.0.0.1', PORT: String(port), LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_BASE_PATH: '/', LIBERTTY_DATA_DIR: root + '/data', LIBERTTY_CWD: root, LIBERTTY_NO_RC: '1', LIBERTTY_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', data => logs += data);
  backend.stderr.on('data', data => logs += data);
  await waitForBackend(base, backend);
  bearer = await pair(base, token);
  created = await action({ action: 'create-space' });
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  await installWireObserver(context);
  await context.route(/\/assets\/terminal-[A-Za-z0-9_-]{8}\.js$/, async route => {
    const response = await route.fetch(), original = await response.text();
    const body = original.replace(/new ([\w$]+)\(\{fontSize:/, 'window.__testTerminal=new $1({fontSize:');
    assert.notEqual(body, original);
    await route.fulfill({ response, body });
  });
  const query = new URLSearchParams({ herdrCore: '1', herdrSession: session, herdrTerminal: created.terminalId });
  await context.route('**/touch-fixture.html', route => route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style><iframe src="/terminal.html?${query}" allow="clipboard-write"></iframe>` }));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + 'touch-fixture.html');
  const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
  await frame.locator('#token').fill(token);
  await frame.locator('#login-form button[type=submit]').click();
  await exerciseCoreTouch(page, frame, root);
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  if (created) await action({ action: 'close-space', workspaceId: created.workspaceId }).catch(() => {});
  backend?.kill();
  try { execFileSync(hc, ['server', 'stop'], { env, stdio: 'ignore', timeout: 10000 }); } catch {}
  await rm(root, { recursive: true, force: true });
}
