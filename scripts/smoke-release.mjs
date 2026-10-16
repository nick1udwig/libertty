#!/usr/bin/env node
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const directory = await mkdtemp(path.join(os.tmpdir(), 'libertty-smoke-'));
let backend;
try {
  execFileSync('tar', ['-xzf', path.resolve(process.argv[2]), '-C', directory]);
  const version = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'));
  assert.ok(execFileSync(path.join(directory, 'bin/libertty'), ['--version'], { encoding: 'utf8' }).includes(version.version));
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}/smoke/`;
  backend = spawn(path.join(directory, 'bin/libertty'), [], { env: { ...process.env, HOME: directory, PORT: String(port), HOST: '127.0.0.1', LIBERTTY_BASE_PATH: '/smoke', LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_DATA_DIR: directory + '/data', LIBERTTY_NO_RC: '1' }, stdio: 'ignore' });
  const exited = once(backend, 'exit');
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + 'healthz')).ok) break; } catch {}
    if (backend.exitCode !== null) throw new Error('Packaged backend exited before readiness.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const health = await (await fetch(base + 'healthz')).json();
  assert.equal(health.version, version.version); assert.equal(health.commit, version.commit);
  if (version.backend === 'rust') { assert.equal(health.runtime, 'rust'); assert.equal(health.packaged, true); }
  assert.equal((await fetch(base)).status, 200);
  const token = (await readFile(directory + '/data/pairing-token', 'utf8')).trim();
  const connect = await fetch(base + 'api/connect', { method: 'POST', headers: { Origin: new URL(base).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(connect.status, 200);
  const { accessToken } = await connect.json();
  const ticketResponse = await fetch(base + 'api/ticket', { method: 'POST', headers: { Origin: new URL(base).origin, Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: '{}' });
  const { ticket } = await ticketResponse.json();
  const socket = new WebSocket(base.replace('http:', 'ws:') + 'ws?ticket=' + ticket, { origin: new URL(base).origin });
  const messages = [];
  socket.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  await once(socket, 'open');
  const wait = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Packaged PTY smoke check timed out.'); };
  await wait(() => messages.some(message => message.type === 'state' && message.state.ready));
  assert.equal(messages.find(message => message.type === 'hello').engine, 'server');
  socket.send(JSON.stringify({ type: 'input', data: 'printf "RELEASE_PTY_OK\\n"\r' }));
  await wait(() => messages.some(message => message.type === 'output' && message.data.includes('RELEASE_PTY_OK')) && messages.filter(message => message.type === 'state' && message.state.ready).length > 1);
  socket.close();
  backend.kill(); await exited; backend = undefined;
  console.log('Packaged release passed: version, mounted frontend, pairing, real PTY and Bash prompt hooks (' + (version.backend || 'node') + ').');
} finally {
  if (backend && backend.exitCode === null) { const exited = once(backend, 'exit'); backend.kill(); await exited; }
  await rm(directory, { recursive: true, force: true });
}
