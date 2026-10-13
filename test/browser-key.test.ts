import { test } from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { generateBrowserKey, encryptBrowserKey, decryptBrowserKey, parseKeyBackup, publicInfo } from '../src/browser-key.ts';
import { fingerprint } from './support/ssh-key.ts';

test('browser generation produces interoperable OpenSSH Ed25519 keys and fingerprints', async () => {
  const key = await generateBrowserKey(), parsed = ssh2.utils.parseKey(key.privateKey);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed)); assert.equal(parsed.type, 'ssh-ed25519');
  assert.equal('ssh-ed25519 ' + parsed.getPublicSSH().toString('base64'), key.publicKey);
  assert.equal(fingerprint(parsed.getPublicSSH()), key.fingerprint);
  const data = Buffer.from('interoperability check'), signature = parsed.sign(data); assert.ok(signature instanceof Buffer); assert.equal(parsed.verify(data, signature), true);
});
test('encrypted browser backups round trip and authenticate both ciphertext and identity', async () => {
  const key = await generateBrowserKey(), record = await encryptBrowserKey('Local key', 'x', key);
  assert.ok(!JSON.stringify(record).includes('PRIVATE KEY')); assert.equal('ciphertext' in publicInfo(record), false);
  await assert.rejects(encryptBrowserKey('empty', '', key), /passphrase/);
  assert.equal(await decryptBrowserKey(record, 'x'), key.privateKey);
  await assert.rejects(decryptBrowserKey(record, 'wrong'), /Incorrect/);
  const copy = parseKeyBackup(JSON.stringify(record)); assert.notEqual(copy.id, record.id); assert.equal(await decryptBrowserKey(copy, 'x'), key.privateKey);
  await assert.rejects(decryptBrowserKey({ ...record, publicKey: record.publicKey + 'tampered' }, 'x'), /damaged/);
  assert.throws(() => parseKeyBackup(JSON.stringify({ ...record, kdf: { ...record.kdf, iterations: 2000000000 } })), /backup/);
  assert.throws(() => parseKeyBackup('{}'), /backup/);
});
