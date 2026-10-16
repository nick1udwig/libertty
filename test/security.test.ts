import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

for (const mode of ['production', 'development']) {
  test(`${mode}: unauthenticated adversarial requests cannot read files, access APIs or crash upgrades`, { timeout: 30000 }, async () => {
    await mkdir(path.join(root, '.test-artifacts'), { recursive: true });
    const directory = await mkdtemp(path.join(root, '.test-artifacts/security-'));
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`, base = origin + '/audit';
    const sentinel = 'PRIVATE-ENVIRONMENT-SENTINEL';
    await writeFile(path.join(directory, 'private.txt'), sentinel);
    const development = mode === 'development';
    const child = spawn(development ? process.execPath : path.join(root,'target/debug/libertty'), development ? ['scripts/dev.mjs'] : [], { cwd: root, env: {
      ...process.env, NODE_ENV: mode, HOST: '127.0.0.1', PORT: String(port), HOME: directory,
      LIBERTTY_TOKEN: '', LIBERTTY_DATA_DIR: directory, LIBERTTY_BASE_PATH: '/audit',
      LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_ALLOWED_ORIGINS: '', LIBERTTY_ENGINE: 'server',
      CARGO_HOME: process.env.CARGO_HOME || path.join(process.env.HOME!,'.cargo'),
      RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(process.env.HOME!,'.rustup'),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let logs = ''; child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
    try {
      const startupDeadline = Date.now() + 20000;
      while (!logs.includes('Pairing token:')) {
        assert.equal(child.exitCode, null, 'server must start'); assert.ok(Date.now() < startupDeadline, 'server startup timeout');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const token = (await readFile(path.join(directory, 'pairing-token'), 'utf8')).trim();
      const fake = '0'.repeat(64);
      const clean = async (response: Response) => {
        const body = await response.text();
        for (const secret of [token, sentinel, root, 'const owners = new Set', 'root:x:0:0:']) assert.ok(!body.includes(secret), 'response must not expose secrets or filesystem details');
        assert.equal(response.headers.get('set-cookie'), null, 'unpaired requests must not receive credentials');
      };
      const endpoints = ['connect', 'ping', 'sessions', 'sessions/close', 'keychain', 'ssh/probe', 'ssh/captured', 'ticket', 'context', 'suggest', 'facts', 'reading/file', 'reading/capture', 'herdr/snapshot', 'herdr/action', 'herdr/ticket', 'herdr/captured', 'new', 'nonexistent'];
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
        for (const endpoint of endpoints) {
          const response = await fetch(base + '/api/' + endpoint, { method,
            headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + fake, Cookie: 'libertty=' + fake,
              'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Host': 'localhost' },
            ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify({ token: fake, noSession: true, action: 'export', kind: 'context', host: '127.0.0.1', port: 22 }) }),
          });
          assert.ok([401, 403].includes(response.status), `${method} ${endpoint} requires credentials`);
          await clean(response);
        }
      }
      const relative = directory.slice(root.length);
      for (const route of ['/server/index.ts?raw', '/server/pairing.ts?raw', '/.env', '/.git/config', '/package.json',
        relative + '/pairing-token?raw', relative + '/private.txt?raw', '/@fs' + directory + '/pairing-token?raw',
        '/@fs/etc/passwd', '/@vite/client', '/@id/__x00__private', '/%2e%2e%2fserver/index.ts', '/%00', '/%zz']) {
        const response = await fetch(base + route);
        assert.ok(response.status >= 400, `private route ${route} must be rejected`); await clean(response);
      }
      for (const route of ['', '/terminal.html']) {
        const response = await fetch(base + route + '/'.repeat(route ? 0 : 1));
        assert.equal(response.status, 200); await clean(response);
      }
      // Raw request targets deliberately avoid browser/URL normalization.
      for (const [target, protocol, includeOrigin] of [['//[', '', true], ['/audit/ws', '', true],
        ['/audit/ws?ticket=' + fake, '', true], ['/audit/', 'vite-hmr', false], ['/audit/', 'vite-ping', true]] as const) {
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect(port, '127.0.0.1'); let response = '';
          socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Upgrade was left open')); });
          socket.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
          socket.on('data', chunk => {
            response += chunk;
            // Hyper can reject an upgrade while keeping the HTTP connection
            // alive; the complete rejection is sufficient to end this probe.
            if (response.includes('\r\n\r\n')) socket.destroy();
          });
          socket.once('close', () => { try { assert.ok(!response.includes('101 Switching'), 'unpaired upgrades must not succeed'); resolve(); } catch (error) { reject(error); } });
          socket.once('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n${includeOrigin ? 'Origin: ' + origin + '\r\n' : ''}${protocol ? 'Sec-WebSocket-Protocol: ' + protocol + '\r\n' : ''}\r\n`));
        });
        assert.equal((await fetch(base + '/api/ping')).status, 401, 'server must survive malformed upgrades');
      }
      const paired = await fetch(base + '/api/connect', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, noSession: true }) });
      assert.equal(paired.status, 200);
      const { accessToken } = await paired.json();
      const sessions = await fetch(base + '/api/sessions', { headers: { Authorization: 'Bearer ' + accessToken } });
      assert.deepEqual(await sessions.json(), [], 'no probe may create a shell');
      if (mode === 'development') {
        const cookie = paired.headers.get('set-cookie')!.split(';')[0];
        const page = await fetch(base + '/', { headers: { Cookie: cookie } });
        assert.match(await page.text(), /workspace-app/, 'pairing must unlock the development frontend');
        assert.equal((await fetch(base + '/src/main.ts', { headers: { Cookie: cookie } })).status, 200);
      }
    } finally { child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); }
  });
}
