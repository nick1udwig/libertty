import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { Vault } from '../server/vault.ts';
import { Pairings } from '../server/pairing.ts';

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
  const vault = new Vault(directory);
  for (const key of result.keys) {
    const bytes = await vault.unlock(key.id, key.passphrase);
    try {
      assert.equal(bytes.toString(), key.privateKey);
      const parsed = ssh2.utils.parseKey(bytes, key.passphrase); assert.ok(!(parsed instanceof Error));
    } finally { bytes.fill(0); }
  }
  const registry = new Pairings(directory, fixture.pairing.token);
  assert.ok(registry.has(fixture.pairing.credential)); assert.ok(registry.has(result.credential));
  assert.equal((await vault.list()).knownHosts[0].fingerprint, 'SHA256:synthetic-host-pin');
  console.log('PASS saved-state compatibility: Node → Rust → Node, encrypted imports, fingerprints, generated keys, host pins, and pairing rollback.');
} finally { await rm(directory, { recursive: true, force: true }); }
