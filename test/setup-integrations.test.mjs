import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { integrations, voxtypeAvailable } from '../scripts/setup-integrations.mjs';

async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'libertty-integrations-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const releaseDir = home + '/release'; await mkdir(releaseDir + '/build', { recursive: true });
  const binary = Buffer.from('#!/bin/sh\nexit 0\n');
  await writeFile(releaseDir + '/build/release-config.json', JSON.stringify({ herdr: { version: 'v0.9.3', sha256: { 'linux-x64': createHash('sha256').update(binary).digest('hex') } } }));
  const hostname = 'machine.test.ts.net';
  const config = { managedBy: 'libertty', env: { PORT: '7321', LIBERTTY_BASE_PATH: '/t', LIBERTTY_ALLOWED_HOSTS: 'localhost,127.0.0.1', XDG_DATA_HOME: home + '/data', XDG_CONFIG_HOME: home + '/config', LIBERTTY_BASH: '/bin/bash', PATH: home + '/.local/bin:/usr/bin:/bin' } };
  const configFile = home + '/config.json'; await writeFile(configFile, JSON.stringify(config));
  const serve = { Web: { [hostname + ':443']: { Handlers: { '/other': { Proxy: 'http://127.0.0.1:9999' } } } } };
  const calls = [];
  const run = (name, args, settings = {}) => {
    calls.push({ name, args, settings });
    if (name === 'sudo') { name = args[0]; args = args.slice(1); }
    if (name === '/fake/tailscale') {
      if (args[0] === 'status') return { ok: true, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: hostname + '.' } }) };
      if (args[0] === 'serve') {
        if (args[1] === 'status') return { ok: true, stdout: JSON.stringify(serve) };
        const mount = args.find(arg => arg.startsWith('--set-path=')).split('=')[1];
        if (args.at(-1) === 'off') delete serve.Web[hostname + ':443'].Handlers[mount];
        else serve.Web[hostname + ':443'].Handlers[mount] = { Proxy: args.at(-1) };
      }
    }
    return { ok: true, stdout: '' };
  };
  const installed = { home, prefix: home, releaseDir, configFile, config, platform: 'linux', metadata: { version: '0.1.0', commit: '1'.repeat(40), platform: 'linux-x64' }, service: true, options, run, ask: async () => true };
  const dependencies = {
    findExecutable: async name => ['/fake/herdr', '/fake/tailscale', '/fake/python3'].find(file => file.endsWith('/' + name)),
    voxtypeAvailable: async () => true,
    fetch: async url => url.includes('/healthz') ? Response.json({ ok: true, ...installed.metadata }) : new Response(binary),
  };
  return { home, hostname, binary, config, configFile, serve, calls, installed, dependencies };
}

test('Herdr is installed only after verifying the pinned binary checksum', async t => {
  const f = await fixture(t, { 'no-tailscale': true });
  f.dependencies.findExecutable = async () => undefined;
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.herdr, 'installed');
  assert.deepEqual(await readFile(f.home + '/.local/bin/herdr'), f.binary);
  assert.equal((await stat(f.home + '/.local/bin/herdr')).mode & 0o777, 0o755);
});
test('a corrupted Herdr download never becomes executable and does not prevent dictation detection', async t => {
  const f = await fixture(t, { 'no-tailscale': true });
  f.dependencies.findExecutable = async () => undefined;
  f.dependencies.fetch = async () => new Response('corrupted');
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.herdr, 'failed'); assert.equal(result.voxtype, 'ready');
  await assert.rejects(stat(f.home + '/.local/bin/herdr'));
});
test('existing companions are retained without installation prompts', async t => {
  const f = await fixture(t, { 'no-tailscale': true });
  f.installed.ask = async () => { throw new Error('Unexpected prompt'); };
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.herdr, 'found'); assert.equal(result.voxtype, 'ready'); assert.deepEqual(result.failures, []);
  assert.equal(f.calls.length, 0);
});
test('Voxtype installation reuses the bundled upstream installer and configured user paths', async t => {
  const f = await fixture(t, { 'no-tailscale': true });
  const companion = f.installed.releaseDir + '/companions/voxtype-mobile';
  await mkdir(companion + '/scripts', { recursive: true }); await writeFile(companion + '/daemon', 'fixture', { mode: 0o755 });
  let probes = 0; f.dependencies.voxtypeAvailable = async () => ++probes > 1;
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.voxtype, 'ready');
  const call = f.calls.find(call => call.args[0] === companion + '/scripts/install-daemon');
  assert.equal(call.args[1], companion + '/daemon');
  assert.equal(call.settings.env.XDG_DATA_HOME, f.config.env.XDG_DATA_HOME); assert.equal(call.settings.env.HOME, f.home);
});
test('declining optional installation changes neither companions nor Tailscale', async t => {
  const f = await fixture(t); f.installed.ask = async () => false;
  f.dependencies.findExecutable = async () => undefined; f.dependencies.voxtypeAvailable = async () => false;
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.herdr, 'skipped'); assert.equal(result.voxtype, 'skipped'); assert.equal(result.tailscale, 'skipped');
  assert.equal(f.calls.length, 0); assert.deepEqual(result.failures, []);
});
test('Voxtype setup selects the available ALSA package without relying on a distribution version', async t => {
  const f = await fixture(t, { 'no-tailscale': true });
  const companion = f.installed.releaseDir + '/companions/voxtype-mobile';
  await mkdir(companion, { recursive: true }); await writeFile(companion + '/daemon', 'fixture', { mode: 0o755 });
  let ready = false;
  f.dependencies.voxtypeAvailable = async () => ready;
  f.dependencies.findExecutable = async name => ['herdr', 'python3', 'apt-get'].includes(name) ? '/fake/' + name : undefined;
  const run = f.installed.run;
  f.installed.run = (name, args, settings) => {
    const value = run(name, args, settings);
    if (name === '/fake/python3' && args[1].includes('ctypes')) return { ok: ready, stdout: '' };
    if (args.includes('install') && args.includes('libopus0')) ready = true;
    return value;
  };
  assert.equal((await integrations(f.installed, f.dependencies)).voxtype, 'ready');
  assert.ok(f.calls.some(call => call.args.includes('libasound2t64') && call.args.includes('libopus0')));
});
test('Tailscale setup preserves other routes, verifies HTTPS, and is idempotent', async t => {
  const f = await fixture(t, { 'no-companions': true });
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.url, 'https://' + f.hostname + '/t/'); assert.equal(result.tailscale, 'ready');
  assert.deepEqual(f.serve.Web[f.hostname + ':443'].Handlers['/other'], { Proxy: 'http://127.0.0.1:9999' });
  assert.ok(JSON.parse(await readFile(f.configFile, 'utf8')).env.LIBERTTY_ALLOWED_HOSTS.includes(f.hostname));
  assert.equal(f.calls.filter(call => call.args.includes('restart')).length, 1);
  f.calls.length = 0;
  assert.equal((await integrations(f.installed, f.dependencies)).tailscale, 'ready');
  assert.equal(f.calls.filter(call => call.args.includes('restart') || call.args.includes('--bg')).length, 0);
});
for (const condition of ['route conflict', 'public Funnel']) test('Tailscale ' + condition + ' preserves existing configuration', async t => {
  const f = await fixture(t, { 'no-companions': true }), previous = await readFile(f.configFile, 'utf8');
  if (condition === 'route conflict') f.serve.Web[f.hostname + ':443'].Handlers['/t'] = { Proxy: 'http://127.0.0.1:8888' };
  else f.serve.AllowFunnel = { [f.hostname + ':443']: true };
  const original = structuredClone(f.serve);
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.tailscale, 'failed'); assert.equal(await readFile(f.configFile, 'utf8'), previous);
  assert.deepEqual(f.serve, original); assert.ok(!f.calls.some(call => call.args.includes('--bg') || call.args.includes('restart')));
});
test('public Funnel on a separate port does not block the private Libertty listener', async t => {
  const f = await fixture(t, { 'no-companions': true });
  f.serve.AllowFunnel = { [f.hostname + ':8443']: true };
  assert.equal((await integrations(f.installed, f.dependencies)).tailscale, 'ready');
  assert.equal(f.serve.AllowFunnel[f.hostname + ':8443'], true);
});
test('failed Serve setup restores allowed hosts and removes only its new route', async t => {
  const f = await fixture(t, { 'no-companions': true }), previous = await readFile(f.configFile, 'utf8');
  const original = structuredClone(f.serve), run = f.installed.run;
  f.installed.run = (name, args, settings) => {
    const value = run(name, args, settings);
    if (args.includes('--bg')) throw new Error('Fixture failed after adding route');
    return value;
  };
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.tailscale, 'failed'); assert.equal(await readFile(f.configFile, 'utf8'), previous);
  assert.equal(f.config.env.LIBERTTY_ALLOWED_HOSTS, 'localhost,127.0.0.1'); assert.deepEqual(f.serve, original);
  assert.equal(f.calls.filter(call => call.args.includes('restart')).length, 2);
});
test('a valid NeedsLogin status with nonzero exit still runs the interactive login flow', async t => {
  const f = await fixture(t, { 'no-companions': true }), run = f.installed.run;
  let loggedIn = false;
  f.installed.run = (name, args, settings) => {
    if (args.includes('up')) loggedIn = true;
    if (args[0] === 'status' && !loggedIn) return { ok: false, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) };
    return run(name, args, settings);
  };
  assert.equal((await integrations(f.installed, f.dependencies)).tailscale, 'ready'); assert.equal(loggedIn, true);
});
test('a conflicting optional Android route does not undo working Libertty HTTPS', async t => {
  const f = await fixture(t); f.serve.Web[f.hostname + ':443'].Handlers['/voxtype'] = { Proxy: 'http://127.0.0.1:8888' };
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.tailscale, 'ready'); assert.equal(result.voxtype, 'ready'); assert.equal(result.voxtypeRoute, 'failed');
  assert.deepEqual(f.serve.Web[f.hostname + ':443'].Handlers['/voxtype'], { Proxy: 'http://127.0.0.1:8888' });
});
test('macOS skips Linux-only dictation installation while retaining Herdr support', async t => {
  const f = await fixture(t, { 'no-tailscale': true }); f.installed.platform = 'darwin';
  f.dependencies.voxtypeAvailable = async () => false;
  const result = await integrations(f.installed, f.dependencies);
  assert.equal(result.herdr, 'found'); assert.equal(result.voxtype, 'unsupported'); assert.deepEqual(result.failures, []);
});
test('dictation detection authenticates the capabilities endpoint and rejects incompatible daemons', async t => {
  const f = await fixture(t);
  await mkdir(f.config.env.XDG_DATA_HOME + '/voxtype-mobile', { recursive: true });
  const tokenFile = f.config.env.XDG_DATA_HOME + '/voxtype-mobile/token';
  await writeFile(tokenFile, 'a'.repeat(32), { mode: 0o600 });
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  let compatible = true;
  server.on('connection', (socket, request) => {
    assert.equal(request.url, '/v1/capabilities'); assert.equal(request.headers.authorization, 'Bearer ' + 'a'.repeat(32));
    socket.send(JSON.stringify({ type: 'capabilities', protocol: compatible ? 2 : 1, dictation: true, sample_rate: 16000, channels: 1, format: 'opus', framing: 'sequence_opus_v1', audio_encodings: ['opus_v1'], results: ['final'] }));
  });
  const env = { ...f.config.env, LIBERTTY_VOXTYPE_URL: 'ws://127.0.0.1:' + server.address().port + '/v1/dictate' };
  assert.equal(await voxtypeAvailable(env), true); compatible = false;
  assert.equal(await voxtypeAvailable(env), false);
  assert.equal(await voxtypeAvailable({ ...env, LIBERTTY_VOXTYPE_URL: 'wss://example.com/v1/dictate' }), false);
});
