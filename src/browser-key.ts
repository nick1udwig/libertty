import type { KeyInfo } from './connections.ts';

export interface KeyBackup { backendURL: string; backendName: string; keyId: string; savedAt: string }
export interface BrowserKeyInfo extends KeyInfo { backups: KeyBackup[] }
export interface EncryptedBrowserKey extends BrowserKeyInfo {
  format: 'libertty-browser-key'; version: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: 600000; salt: string };
  cipher: { name: 'AES-GCM'; iv: string }; ciphertext: string;
}
const encode = new TextEncoder();
const bytes = (text: string) => encode.encode(text);
const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const un64 = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; } return out;
}
function uint(value: number) { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value); return out; }
function string(value: string | Uint8Array) { const raw = typeof value === 'string' ? bytes(value) : value; return concat(uint(raw.length), raw); }
function password(value: string) { if (!value) throw new Error('Enter a key passphrase.'); }
function name(value: string) { if (!value.trim() || value.length > 100) throw new Error('Enter a key name.'); return value.trim(); }
/** OpenSSH's Ed25519 container; key generation and signing primitives are Web Crypto. */
export async function generateBrowserKey(): Promise<{ privateKey: string; publicKey: string; fingerprint: string }> {
  if (!globalThis.crypto?.subtle) throw new Error('Browser keys need an HTTPS connection.');
  let pair: CryptoKeyPair;
  try { pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair; }
  catch { throw new Error('This browser cannot generate Ed25519 keys. Import an existing key instead.'); }
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey), seed = un64(jwk.d!), publicBytes = un64(jwk.x!);
  const publicBlob = concat(string('ssh-ed25519'), string(publicBytes));
  const check = crypto.getRandomValues(new Uint8Array(4));
  const privateBlob = concat(check, check, string('ssh-ed25519'), string(publicBytes), string(concat(seed, publicBytes)), string('libertty'));
  const padding = Uint8Array.from({ length: 8 - privateBlob.length % 8 }, (_, i) => i + 1);
  const container = concat(bytes('openssh-key-v1\0'), string('none'), string('none'), string(''), uint(1), string(publicBlob), string(concat(privateBlob, padding)));
  const pem = b64(container).match(/.{1,70}/g)!.join('\n'); seed.fill(0); privateBlob.fill(0); container.fill(0);
  return { privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${pem}\n-----END OPENSSH PRIVATE KEY-----\n`, publicKey: 'ssh-ed25519 ' + b64(publicBlob), fingerprint: 'SHA256:' + b64(new Uint8Array(await crypto.subtle.digest('SHA-256', publicBlob))).replace(/=+$/, '') };
}
function associated(record: EncryptedBrowserKey) { return bytes(JSON.stringify([record.format, record.version, record.publicKey, record.fingerprint])); }
async function wrappingKey(passphrase: string, salt: string) {
  password(passphrase);
  const input = await crypto.subtle.importKey('raw', bytes(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: un64(salt) }, input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export function publicInfo(record: EncryptedBrowserKey): BrowserKeyInfo {
  const { id, name, publicKey, fingerprint, createdAt, backups } = record; return { id, name, publicKey, fingerprint, createdAt, backups };
}
export async function encryptBrowserKey(label: string, passphrase: string, key: { privateKey: string; publicKey: string; fingerprint: string }): Promise<EncryptedBrowserKey> {
  password(passphrase);
  if (!key.privateKey || key.privateKey.length > 20000) throw new Error('Invalid private key.');
  const record: EncryptedBrowserKey = { format: 'libertty-browser-key', version: 1, id: crypto.randomUUID(), name: name(label), publicKey: key.publicKey, fingerprint: key.fingerprint, createdAt: new Date().toISOString(), backups: [],
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: b64(crypto.getRandomValues(new Uint8Array(16))) }, cipher: { name: 'AES-GCM', iv: b64(crypto.getRandomValues(new Uint8Array(12))) }, ciphertext: '' };
  const plaintext = bytes(key.privateKey);
  try { record.ciphertext = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: un64(record.cipher.iv), additionalData: associated(record) }, await wrappingKey(passphrase, record.kdf.salt), plaintext))); }
  finally { plaintext.fill(0); }
  return record;
}
export async function decryptBrowserKey(record: EncryptedBrowserKey, passphrase: string): Promise<string> {
  password(passphrase);
  const key = await wrappingKey(passphrase, record.kdf.salt);
  try {
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(record.cipher.iv), additionalData: associated(record) }, key, un64(record.ciphertext)));
    const value = new TextDecoder().decode(plaintext); plaintext.fill(0); return value;
  } catch { throw new Error('Incorrect passphrase or damaged key backup.'); }
}
export function parseKeyBackup(text: string): EncryptedBrowserKey {
  try {
    if (text.length > 100000) throw new Error();
    const r = JSON.parse(text);
    if (r.format !== 'libertty-browser-key' || r.version !== 1 || r.kdf?.name !== 'PBKDF2' || r.kdf.hash !== 'SHA-256' || r.kdf.iterations !== 600000 || r.cipher?.name !== 'AES-GCM' ||
      typeof r.name !== 'string' || typeof r.publicKey !== 'string' || r.publicKey.length > 12000 || typeof r.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(r.fingerprint) || typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt)) ||
      typeof r.kdf.salt !== 'string' || un64(r.kdf.salt).length !== 16 || typeof r.cipher.iv !== 'string' || un64(r.cipher.iv).length !== 12 || typeof r.ciphertext !== 'string' || un64(r.ciphertext).length < 16 || un64(r.ciphertext).length > 21000) throw new Error();
    return { format: r.format, version: 1, id: crypto.randomUUID(), name: name(r.name), publicKey: r.publicKey, fingerprint: r.fingerprint, createdAt: r.createdAt, backups: [],
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: r.kdf.salt }, cipher: { name: 'AES-GCM', iv: r.cipher.iv }, ciphertext: r.ciphertext };
  } catch { throw new Error('Choose a libertty encrypted key backup.'); }
}
