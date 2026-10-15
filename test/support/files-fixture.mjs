import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { freePort, pair, waitForBackend } from './browser.mjs';
import { sshdPath, sshdConfig } from './sshd.mjs';

// Real local, SFTP and second-backend roots shared by files and transfer harnesses.
export async function filesFixture({ sourceFile = false, locale = false } = {}) {
  const root = path.resolve(import.meta.dirname, '../..');
  const port = await freePort(),
    secondPort = await freePort(),
    sshPort = await freePort();
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'termai-files-'));
  const origin = `http://127.0.0.1:${port}`,
    base = origin + '/t/';
  const second = `http://127.0.0.1:${secondPort}/t/`;
  const token = 'files-feature-test-123456789';
  const processes = [];
  let logs = '';
  function start(command, args, environment = {}) {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.push(child);
    child.stdout.on('data', (data) => (logs += data));
    child.stderr.on('data', (data) => (logs += data));
    child.on('error', (error) => (logs += String(error)));
    return child;
  }
  async function close() {
    await Promise.all(
      processes.map(async (child) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
        try {
          child.kill('SIGTERM');
          await exited;
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const request = (target, route, owner, data) =>
    fetch(target + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        ...(owner ? { Authorization: 'Bearer ' + owner } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const bytes = Buffer.from([0, 255, 1, 2, 3, 10, 13, 90]);
  try {
    for (const directory of ['local', 'remote', 'secondary']) {
      const folder = path.join(fixture, directory);
      await mkdir(folder + '/docs', { recursive: true });
      await writeFile(folder + '/docs/über file.bin', bytes);
      await writeFile(folder + '/.hidden', 'hidden');
      if (sourceFile) await writeFile(folder + '/hello_world.py', 'source file');
      await symlink('docs', folder + '/linked');
    }
    const hostKey = ssh2.utils.generateKeyPairSync('ed25519'),
      key = ssh2.utils.generateKeyPairSync('ed25519');
    await writeFile(fixture + '/host', hostKey.private, { mode: 0o600 });
    await writeFile(fixture + '/authorized', key.public);
    const config = await sshdConfig(fixture, sshPort, {
      env: locale ? { LANG: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' } : {},
    });
    start(sshdPath(), ['-D', '-e', '-f', config]);
    const backends = [
      [port, 'local'],
      [secondPort, 'secondary'],
    ].map(([port, directory]) =>
      start(root + '/target/debug/termai', [], {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        TERMAI_BASE_PATH: '/t',
        TERMAI_ALLOWED_ORIGINS: origin,
        TERMAI_TOKEN: token,
        TERMAI_NO_RC: '1',
        TERMAI_CWD: fixture + '/' + directory,
        HOME: fixture + '/' + directory,
        TERMAI_DATA_DIR: fixture + '/data-' + directory,
      }),
    );
    await Promise.all([waitForBackend(base, backends[0]), waitForBackend(second, backends[1])]);
    const owner = await pair(base, token),
      other = await pair(base, token);
    return {
      fixture,
      origin,
      base,
      second,
      sshPort,
      bytes,
      key,
      owner,
      other,
      request,
      close,
      get logs() {
        return logs;
      },
    };
  } catch (error) {
    await close();
    throw new Error(error.message + '\n' + logs, { cause: error });
  }
}
