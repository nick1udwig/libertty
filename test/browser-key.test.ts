import { test } from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { generateBrowserKey, encryptBrowserKey, decryptBrowserKey, parseKeyBackup, publicInfo } from '../src/browser-key.ts';
import { fingerprint } from './support/ssh-key.ts';

test('browser generation produces interoperable OpenSSH Ed25519 keys and fingerprints', async () => {
  const key = await generateBrowserKey(), parsed = ssh2.utils.parseKey(key.privateKey);
  assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed)); assert.equal(parsed.type, 'ssh-ed25519');
  assert.equal('ssh-ed25519 ' + parsed.getPublicSSH().toString('base64'), key.publicKey);
  assert.equal(fingerprint(parsed.getPublicSSH()), key.fingerprint);
  const data = Buffer.from('interoperability check'), signature = parsed.sign(data); assert.ok(signature instanceof Buffer); assert.equal(parsed.verify(data, signature), true);
});
test('Termai encrypted backups retain their authenticated format and still decrypt', async () => {
  const key = await generateBrowserKey(), record = await encryptBrowserKey('Existing key', 'secret', key);
  assert.equal(record.format, 'libertty-browser-key');
  record.format = 'termai-browser-key';
  const secret = pbkdf2Sync('secret', Buffer.from(record.kdf.salt, 'base64'), 600000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', secret, Buffer.from(record.cipher.iv, 'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify([record.format, record.version, record.publicKey, record.fingerprint])));
  try { record.ciphertext = Buffer.concat([cipher.update(key.privateKey, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64'); }
  finally { secret.fill(0); }
  const backup = parseKeyBackup(JSON.stringify(record));
  assert.equal(backup.format, 'termai-browser-key');
  assert.equal(await decryptBrowserKey(backup, 'secret'), key.privateKey);
  await assert.rejects(decryptBrowserKey({ ...backup, format: 'libertty-browser-key' }, 'secret'), /damaged/);
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
