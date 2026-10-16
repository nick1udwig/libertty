import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, cp, mkdtemp, mkdir, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ssh2 from 'ssh2';
import { prepareDependencies } from '../scripts/prepare-dependencies.mjs';

const require = createRequire(import.meta.url);
const keygenFile = path.join(path.dirname(require.resolve('ssh2/package.json')), 'lib/keygen.js');

test('ssh2 preserves leading zero public-key bytes in synchronous and asynchronous Ed25519 generation', async () => {
  // This fixed test seed yields a real public key starting with TWO zero bytes.
  const seed = Buffer.from('0000000000000000000000000000000000000000000000000000000000000024', 'hex');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey), pub = publicKey.export({ format: 'der', type: 'spki' }), priv = privateKey.export({ format: 'der', type: 'pkcs8' });
  assert.deepEqual(pub.subarray(-32, -30), Buffer.from([0, 0]));
  // Load the installed conversion code with deterministic Node crypto outputs.
  const module = { exports: {} }, dependencyRequire = createRequire(keygenFile);
  const fixtureCrypto = { ...crypto,
    generateKeyPairSync: () => ({ publicKey: pub, privateKey: priv }),
    generateKeyPair: (_type, _options, callback) => queueMicrotask(() => callback(null, pub, priv)),
  };
  const load = runInThisContext('(function(require, module, exports) {' + await readFile(keygenFile, 'utf8') + '\n})', { filename: keygenFile });
  load(name => name === 'crypto' ? fixtureCrypto : dependencyRequire(name), module, module.exports);
  const generated = [module.exports.generateKeyPairSync('ed25519', {}), await new Promise((resolve, reject) => module.exports.generateKeyPair('ed25519', {}, (error, pair) => error ? reject(error) : resolve(pair)))];
  for (const pair of generated) {
    const parsed = ssh2.utils.parseKey(pair.private);
    assert.ok(!(parsed instanceof Error), parsed.message);
    assert.deepEqual(parsed.getPublicSSH().subarray(-32), pub.subarray(-32));
    assert.equal(pair.public, 'ssh-ed25519 ' + parsed.getPublicSSH().toString('base64'));
    const data = Buffer.from('Ed25519 leading-zero regression'), signature = parsed.sign(data);
    assert.ok(Buffer.isBuffer(signature));
    assert.equal(verify(null, data, publicKey, signature), true);
  }
});

test('dependency preparation is idempotent and fixes both prebuilt and source-built macOS helper permissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'libertty-dependencies-'));
  try {
    const ssh = path.join(directory, 'node_modules/ssh2');
    await mkdir(path.join(ssh, 'lib'), { recursive: true });
    await writeFile(path.join(ssh, 'package.json'), JSON.stringify({ version: '1.17.0' }));
    await writeFile(path.join(ssh, 'lib/keygen.js'), await readFile(keygenFile));
    const helpers = ['prebuilds/darwin-arm64', 'build/Release'].map(location => path.join(directory, 'node_modules/node-pty', location, 'spawn-helper'));
    for (const helper of helpers) { await mkdir(path.dirname(helper), { recursive: true }); await writeFile(helper, 'fixture'); await chmod(helper, 0o644); }
    await prepareDependencies(directory, 'darwin', 'arm64');
    const prepared = await readFile(path.join(ssh, 'lib/keygen.js'), 'utf8');
    await prepareDependencies(directory, 'darwin', 'arm64');
    assert.ok(await readFile(path.join(ssh, 'lib/keygen.js'), 'utf8') === prepared);
    for (const helper of helpers) assert.equal((await stat(helper)).mode & 0o777, 0o755);
    await rm(path.join(directory, 'node_modules/node-pty'), { recursive: true });
    await assert.rejects(prepareDependencies(directory, 'darwin', 'arm64'), /missing.*spawn-helper/);
    await prepareDependencies(directory, 'linux', 'x64');
    await writeFile(path.join(ssh, 'package.json'), JSON.stringify({ version: '1.18.0' }));
    await assert.rejects(prepareDependencies(directory, 'linux', 'x64'), /Review.*patch/);
    // Direct execution must still run its version guard through a symlink.
    await mkdir(path.join(directory, 'scripts'));
    await cp(path.resolve(import.meta.dirname, '../scripts/prepare-dependencies.mjs'), path.join(directory, 'scripts/prepare-dependencies.mjs'));
    await symlink(path.join(directory, 'scripts'), path.join(directory, 'scripts-alias'));
    const result = spawnSync(process.execPath, [path.join(directory, 'scripts-alias/prepare-dependencies.mjs')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Review.*patch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
