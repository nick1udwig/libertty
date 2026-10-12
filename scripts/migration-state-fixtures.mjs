// Every credential and key in this fixture is generated solely for regression tests.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { Vault } from '../server/vault.ts';
import { Pairings, pairingToken } from '../server/pairing.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-state-oracle-'));
try {
  const vault = new Vault(directory);
  const cases = [];
  for (const encrypted of [false, true]) {
    const passphrase = 'synthetic-fixture-password-' + encrypted;
    const pair = ssh2.utils.generateKeyPairSync('ed25519', encrypted ? { passphrase, cipher: 'aes256-cbc', rounds: 16 } : {});
    const info = await vault.create('Synthetic fixture ' + encrypted, passphrase, pair.private);
    cases.push({ id: info.id, passphrase, privateKey: pair.private, publicKey: info.publicKey, fingerprint: info.fingerprint });
  }
  await vault.trust('fixture.example', 22, 'SHA256:synthetic-host-pin');
  const token = pairingToken(directory), registry = new Pairings(directory, token), credential = registry.issue();
  const fixture = { version: 1, synthetic: true, pairing: { token, credential, data: JSON.parse(await readFile(path.join(directory, 'paired-clients.json'), 'utf8')) },
    vault: { data: JSON.parse(await readFile(path.join(directory, 'vault.json'), 'utf8')), listed: await vault.list(), cases } };
  await writeFile(new URL('../test/fixtures/rust-migration/state.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
  console.log('Captured synthetic reference pairings and encrypted/unencrypted OpenSSH vault fixtures.');
} finally { await rm(directory, { recursive: true, force: true }); }
