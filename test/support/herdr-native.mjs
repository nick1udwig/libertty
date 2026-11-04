import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import pty from 'node-pty';
import { until } from './browser.mjs';
import { herdrRequest, herdrSnapshot } from './herdr.ts';

const binary = process.env.HERDR_BINARY || '/usr/bin/herdr';
const root = new URL('../../', import.meta.url).pathname;

/** A real Herdr server, its desktop client and a libertty backend, all in the disposable HOME `dir`. */
export function herdrFixture(dir) {
  const target = { session: '', socketPath: dir + '/herdr.sock' };
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: dir + '/config',
    XDG_DATA_HOME: dir + '/data',
    XDG_STATE_HOME: dir + '/state',
    HERDR_SOCKET_PATH: target.socketPath,
    HERDR_SESSION: '',
    HERDR_ENV: '',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
  };
  let herdr, desktop, backend;
  return {
    target,
    env,
    /** Starts the Herdr server, then a 150×45 desktop client attached to it. */
    async startHerdr() {
      herdr = spawn(binary, ['server'], { cwd: dir, env, stdio: 'ignore' });
      await until(async () => {
        try {
          await herdrSnapshot(target);
          return true;
        } catch {
          return false;
        }
      }, 'isolated Herdr server');
      desktop = pty.spawn(binary, [], { cwd: dir, env, cols: 150, rows: 45, name: 'xterm-256color' });
      desktop.onData(() => {});
    },
    /** Starts a libertty backend on `port` and returns its pairing token. */
    async startBackend(port, executable = root + 'target/debug/libertty') {
      const base = 'http://127.0.0.1:' + port;
      backend = spawn(executable, [], {
        cwd: root,
        env: {
          ...env,
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
          PORT: String(port),
          LIBERTTY_BASE_PATH: '/',
          LIBERTTY_ALLOWED_HOSTS: '127.0.0.1',
          LIBERTTY_ALLOWED_ORIGINS: base,
          LIBERTTY_DATA_DIR: dir + '/libertty',
          LIBERTTY_TOKEN: '',
          LIBERTTY_NO_RC: '1',
          LIBERTTY_CWD: dir,
        },
        stdio: 'ignore',
      });
      await until(async () => {
        try {
          return (await fetch(base)).ok;
        } catch {
          return false;
        }
      }, 'isolated libertty backend');
      return (await readFile(dir + '/libertty/pairing-token', 'utf8')).trim();
    },
    /** Stops every process and removes the disposable HOME. */
    async stop() {
      if (backend) {
        const exited = once(backend, 'exit');
        backend.kill();
        await exited;
      }
      const stopped =
        herdr && herdr.exitCode === null && herdr.signalCode === null ? once(herdr, 'exit') : null;
      desktop?.kill();
      await herdrRequest(target, 'server.stop').catch(() => {});
      herdr?.kill();
      await stopped;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
