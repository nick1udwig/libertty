import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const cases = [], records = [];
for (const encrypted of [false, true]) {
  const passphrase = 'synthetic-passphrase-' + encrypted;
  const pair = ssh2.utils.generateKeyPairSync('ed25519', encrypted ? { passphrase, cipher: 'aes256-ctr', rounds: 4 } : {});
  const parsed = ssh2.utils.parseKey(pair.private, passphrase);
  assert.ok(!(parsed instanceof Error));
  const wire = parsed.getPublicSSH(), id = randomUUID();
  const publicKey = 'ssh-ed25519 ' + wire.toString('base64');
  const fingerprint = 'SHA256:' + createHash('sha256').update(wire).digest('base64').replace(/=+$/, '');
  const salt = randomBytes(16), iv = randomBytes(12);
  const secret = scryptSync(passphrase, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    const ciphertext = Buffer.concat([cipher.update(pair.private, 'utf8'), cipher.final()]);
    records.push({ id, name: 'Synthetic key ' + encrypted, publicKey, fingerprint, createdAt: new Date().toISOString(),
      salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  } finally { secret.fill(0); }
  cases.push({ id, passphrase, privateKey: pair.private, publicKey, fingerprint });
}
const token = randomBytes(32).toString('hex'), credential = randomBytes(32).toString('hex');
const fixture = { synthetic: true, vault: { cases, data: { keys: records, futureField: 'retained',
  knownHosts: [{ host: 'fixture.example', port: 22, fingerprint: 'SHA256:synthetic-host-pin', futureHostField: { retained: true } }] } },
  pairing: { token, credential, data: { version: 1, tokenHash: digest(token), credentials: [digest(credential)] } } };
const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-state-compat-'));
try {
  await writeFile(path.join(directory, 'fixture.json'), JSON.stringify(fixture), { mode: 0o600 });
  await writeFile(path.join(directory, 'vault.json'), JSON.stringify(fixture.vault.data), { mode: 0o600 });
  await writeFile(path.join(directory, 'paired-clients.json'), JSON.stringify(fixture.pairing.data), { mode: 0o600 });
  const child = spawn('cargo', ['run', '--locked', '--release', '--package', 'termai-server', '--example', 'state_compat', '--', directory], { cwd: root, stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Rust persisted-state compatibility failed: ' + code))); });
  const result = JSON.parse(await readFile(path.join(directory, 'rust-results.json'), 'utf8'));
  const vault = JSON.parse(await readFile(path.join(directory,'vault.json'),'utf8'));
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
  assert.equal(vault.futureField, 'retained');
  assert.deepEqual(vault.knownHosts[0].futureHostField, { retained: true });
  console.log('PASS saved-state compatibility: generated Node-written data opens in Rust; an independent crypto reader verifies encrypted imports, generated keys, host pins, unknown fields and pairing digests.');
} finally { await rm(directory, { recursive: true, force: true }); }
