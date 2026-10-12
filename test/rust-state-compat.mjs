import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { createDecipheriv, createHash, scryptSync } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const fixture = JSON.parse(await readFile(new URL('./fixtures/rust-migration/state.json', import.meta.url), 'utf8'));
const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-state-compat-'));
try {
  await writeFile(path.join(directory, 'fixture.json'), JSON.stringify(fixture), { mode: 0o600 });
  await writeFile(path.join(directory, 'vault.json'), JSON.stringify(fixture.vault.data), { mode: 0o600 });
  await writeFile(path.join(directory, 'paired-clients.json'), JSON.stringify(fixture.pairing.data), { mode: 0o600 });
  const child = spawn('cargo', ['run', '--locked', '--release', '--package', 'termai-server', '--example', 'state_compat', '--', directory], { cwd: root, stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Rust persisted-state compatibility failed: ' + code))); });
  const result = JSON.parse(await readFile(path.join(directory, 'rust-results.json'), 'utf8'));
  const vault = JSON.parse(await readFile(path.join(directory,'vault.json'),'utf8'));
  const digest = value => createHash('sha256').update(value).digest('hex');
  for (const key of result.keys) {
    const record = vault.keys.find(record => record.id === key.id);
    const secret = scryptSync(key.passphrase,Buffer.from(record.salt,'base64'),32,{N:32768,maxmem:64*1024*1024});
    const decipher = createDecipheriv('aes-256-gcm',secret,Buffer.from(record.iv,'base64'));
    decipher.setAuthTag(Buffer.from(record.tag,'base64'));
    let bytes;
    try { bytes=Buffer.concat([decipher.update(Buffer.from(record.ciphertext,'base64')),decipher.final()]); }
    finally { secret.fill(0); }
    try {
      assert.equal(bytes.toString(), key.privateKey);
      const parsed = ssh2.utils.parseKey(bytes, key.passphrase); assert.ok(!(parsed instanceof Error));
    } finally { bytes.fill(0); }
  }
  const registry = JSON.parse(await readFile(path.join(directory,'paired-clients.json'),'utf8'));
  assert.equal(registry.version,1); assert.equal(registry.tokenHash,digest(fixture.pairing.token));
  assert.ok(registry.credentials.includes(digest(fixture.pairing.credential)));
  assert.ok(registry.credentials.includes(digest(result.credential)));
  assert.equal(vault.knownHosts[0].fingerprint,'SHA256:synthetic-host-pin');
  console.log('PASS saved-state compatibility: archived Node-written data opens in Rust; an independent crypto reader verifies encrypted imports, generated keys, host pins and pairing digests.');
} finally { await rm(directory, { recursive: true, force: true }); }
