#!/usr/bin/env node
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const archive = path.resolve(process.argv[2]);
const root = path.resolve(import.meta.dirname, '..');
const home = await mkdtemp(path.join(os.tmpdir(), 'termai-install-smoke-'));
let backend;
try {
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = String(listener.address().port); await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home + '/.config', XDG_DATA_HOME: home + '/.local/share' };
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  execFileSync('bash', [root + '/install.sh', '--archive', archive, '--sha256', digest, '--yes', '--no-service', '--no-companions', '--no-tailscale', '--port', port], { env, stdio: 'inherit', timeout: 120000 });
  const launcher = home + '/.local/bin/termai';
  assert.match(execFileSync(launcher, ['--version'], { env, encoding: 'utf8' }), /termai \d+\.\d+\.\d+/);
  const configFile = home + '/.config/termai/config.json';
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  for (const engine of ['server', 'client']) {
  config.env.TERMAI_ENGINE = engine;
  await writeFile(configFile, JSON.stringify(config));
  // The managed config must set cwd, port and data paths even outside the release directory.
  backend = spawn(launcher, [], { env: { ...env, TERMAI_NO_RC: '1' }, cwd: home, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/t/healthz', { signal: AbortSignal.timeout(1000) });
      const value = await response.json();
      if (response.ok && value.commit === config.commit && value.version === config.version) { ready = true; break; }
    } catch {}
    if (backend.exitCode !== null) throw new Error('Installed launcher exited before readiness.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Installed launcher must start the packaged server.');
  const token = await readFile(home + '/.local/share/termai/pairing-token', 'utf8'); assert.ok(token.trim().length >= 32);
  const exited = once(backend, 'exit'); backend.kill(); await exited; backend = undefined;
  }
  console.log('Installed release passed: verified bootstrap, private config, user launcher and server readiness in both engine modes.');
} finally {
  if (backend && backend.exitCode === null) { const exited = once(backend, 'exit'); backend.kill(); await exited; }
  await rm(home, { recursive: true, force: true });
}
