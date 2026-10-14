import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { SourceTextModule } from 'node:vm';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const start = performance.now();
const list = args => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const deleted = new Set(list(['--deleted']));
const files = list(['--cached', '--others', '--exclude-standard']).filter(file => !deleted.has(file));
let modules = 0, data = 0;
for (const file of files) {
  if (!/\.(?:[cm]?js|ts|json)$/.test(file)) continue;
  const source = await readFile(path.join(root, file), 'utf8');
  try {
    if (file.endsWith('.json')) { JSON.parse(source); data++; }
    else {
      new SourceTextModule(file.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source, { identifier: file });
      modules++;
    }
  } catch (error) { throw new Error(file + ': ' + error.message, { cause: error }); }
}
const assets = JSON.parse(await readFile(path.join(root, 'contracts/assets.json'), 'utf8'));
for (const [file, digest] of Object.entries(assets)) {
  assert.equal(createHash('sha256').update(await readFile(path.join(root, file))).digest('hex'), digest, file);
}
console.log(`Verified syntax for ${modules} modules, ${data} JSON files and ${Object.keys(assets).length} asset checksums.`);

// Keep this explicit: adding a native or package-dependent harness must not make
// the required check install dependencies, build Rust or start a browser.
const tests = [
  'api.test.ts',
  'compound-repair.test.ts',
  'dictation-alternatives.test.ts',
  'dictation-layout.test.ts',
  'dictation-wake-lock.test.ts',
  'dictation.test.ts',
  'facts.test.ts',
  'file-options.test.ts',
  'herdr-notifications.test.ts',
  'herdr-spaces.test.ts',
  'inline-suggestions.test.ts',
  'input-line.test.ts',
  'paste-mode.test.ts',
  'plugin-file.test.ts',
  'plugins.test.ts',
  'push-worker.test.ts',
  'publish-release.test.mjs',
  'queue.test.ts',
  'reconnecting-socket.test.ts',
  'service-worker.test.ts',
  'shell-words.test.ts',
  'shortcuts.test.ts',
  'touch-cursor.test.ts',
  'vault.test.ts',
  'wire.test.ts',
];
const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=spec', ...tests.map(file => 'test/' + file)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'Quick unit tests failed: ' + (result.signal || result.status));
console.log(`Quick checks completed in ${((performance.now() - start) / 1000).toFixed(2)}s.`);
