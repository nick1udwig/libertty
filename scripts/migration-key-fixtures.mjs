import { generateKeyPairSync, createHash, createHmac, createCipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { inspectPrivateKey } from '../server/vault.ts';
import { sshArguments } from '../server/system-ssh.ts';

const cases = [];
function record(name, privateKey, passphrase = 'synthetic-import-password') {
  for (const password of [passphrase, 'incorrect-password']) {
    try { cases.push({ name, privateKey, passphrase: password, expected: { value: inspectPrivateKey(privateKey, password) } }); }
    catch (error) { cases.push({ name, privateKey, passphrase: password, expected: { error: error.message } }); }
  }
}
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
for (const cipher of [undefined, 'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'des-ede3-cbc']) {
  record('RSA ' + (cipher || 'plain'), rsa.export({ format: 'pem', type: 'pkcs1', ...(cipher ? { cipher, passphrase: 'synthetic-import-password' } : {}) }));
}
for (const namedCurve of ['prime256v1', 'secp384r1', 'secp521r1']) {
  const key = generateKeyPairSync('ec', { namedCurve }).privateKey;
  for (const cipher of [undefined, 'aes-256-cbc']) record('EC ' + namedCurve + ' ' + (cipher || 'plain'), key.export({ format: 'pem', type: 'sec1', ...(cipher ? { cipher, passphrase: 'synthetic-import-password' } : {}) }));
  record('Unsupported PKCS8 ' + namedCurve, key.export({ format: 'pem', type: 'pkcs8' }));
}
const dsa = generateKeyPairSync('dsa', { modulusLength: 1024, divisorLength: 160 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
const traditional = execFileSync('openssl', ['pkey', '-traditional'], { input: dsa, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
record('DSA plain', traditional);
record('DSA encrypted', execFileSync('openssl', ['pkey', '-traditional', '-aes-256-cbc', '-passout', 'pass:synthetic-import-password'], { input: dsa, stdio: ['pipe', 'pipe', 'ignore'] }).toString());
record('Unsupported PKCS8 RSA', rsa.export({ format: 'pem', type: 'pkcs8' }));
const field = value => { const header = Buffer.alloc(4); header.writeUInt32BE(value.length); return Buffer.concat([header, value]); };
const integer = value => { const bytes = Buffer.from(value, 'base64url'); return field(bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes); };
const wrap = value => value.toString('base64').match(/.{1,64}/g).join('\n');
const jwk = rsa.export({ format: 'jwk' });
const publicBlob = Buffer.concat([field(Buffer.from('ssh-rsa')), integer(jwk.e), integer(jwk.n)]);
const privateBlob = Buffer.concat([integer(jwk.d), integer(jwk.p), integer(jwk.q), integer(jwk.qi)]);
for (const [encrypted, passphrase] of [[false, ''], [false, 'synthetic-import-password'], [true, 'synthetic-import-password']]) {
  const type = 'ssh-rsa', encryption = encrypted ? 'aes256-cbc' : 'none', comment = 'Synthetic test identity';
  let raw = privateBlob;
  if (encrypted) raw = Buffer.concat([raw, Buffer.alloc((16 - raw.length % 16) % 16)]);
  const key = createHash('sha1').update('putty-private-key-file-mac-key' + passphrase).digest();
  const mac = createHmac('sha1', key).update(Buffer.concat([field(Buffer.from(type)), field(Buffer.from(encryption)), field(Buffer.from(comment)), field(publicBlob), field(raw)])).digest('hex');
  let encoded = raw;
  if (encrypted) {
    const derivations = [0, 1].map(index => { const counter = Buffer.alloc(4); counter.writeUInt32BE(index); return createHash('sha1').update(counter).update(passphrase).digest(); });
    const cipher = createCipheriv('aes-256-cbc', Buffer.concat(derivations).subarray(0, 32), Buffer.alloc(16)); cipher.setAutoPadding(false);
    encoded = Buffer.concat([cipher.update(raw), cipher.final()]);
  }
  const pub = wrap(publicBlob), secret = wrap(encoded);
  record('PuTTY RSA ' + encrypted + ' ' + (passphrase ? 'password MAC' : 'empty MAC'), 'PuTTY-User-Key-File-2: ' + type + '\nEncryption: ' + encryption + '\nComment: ' + comment + '\nPublic-Lines: ' + pub.split('\n').length + '\n' + pub + '\nPrivate-Lines: ' + secret.split('\n').length + '\n' + secret + '\nPrivate-MAC: ' + mac + '\n');
}
const commands = [];
for (const command of ["ssh -i '/tmp/key with spaces' -p2222 user@host", 'ssh -o IdentityFile=~/.ssh/work host', 'ssh -i "key\\\\name" host', 'echo ssh host', 'ssh host uptime', 'ssh -L 8080:localhost:80 host', 'ssh -N host', 'ssh $HOST', 'ssh host; echo second', 'ssh host && true', 'ssh $(hostname)', 'ssh "\x24{HOST}"', 'ssh -oProxyCommand=foo host', 'ssh -i', 'ssh "broken', 'ssh host # comment', '/usr/bin/ssh -tt -l nick -oIdentitiesOnly=yes fixture', 'ssh ""', 'ssh -F /tmp/config -o IdentityAgent=none host']) {
  commands.push({ command, expected: sshArguments(command) ?? null });
}
await writeFile(new URL('../test/fixtures/rust-migration/keys.json', import.meta.url), JSON.stringify({ reference: '455386b', synthetic: true, cases, commands }, null, 2) + '\n');
console.log('Captured ' + cases.length + ' legacy key and ' + commands.length + ' SSH command reference cases.');
