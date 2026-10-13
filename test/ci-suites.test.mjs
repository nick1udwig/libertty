import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, selectSuites, suites } from '../scripts/ci-suites.mjs';

test('documentation, unit tests and performance changes need only the default checks', () => {
  assert.deepEqual(selectSuites(['README.md', 'docs/releases.md', 'test/dictation.test.ts', 'test/ci-build.test.mjs', 'contracts/regression-inventory.json', 'test/architecture-benchmark.ts', '.github/workflows/performance.yml']), { suites: [], state: false });
});

test('feature changes select their consumers without the complete platform matrix', () => {
  assert.deepEqual(selectSuites(['src/dictation.ts']).suites, ['herdr', 'dictation']);
  assert.deepEqual(selectSuites(['src/reading-request.ts']).suites, ['reading', 'dictation']);
  assert.deepEqual(selectSuites(['src/reconnecting-socket.ts']).suites, ['terminal', 'herdr', 'reconnect']);
  assert.deepEqual(selectSuites(['test/herdr-spaces-browser.mjs']).suites, ['herdr-native']);
  assert.deepEqual(selectSuites(['test/files-browser.mjs', 'test/transfers-browser.mjs']).suites, ['files']);
  assert.equal(selectSuites(['crates/server/src/vault.rs']).state, true);
  assert.deepEqual(selectSuites(['test/rust-state-compat.mjs']), { suites: [], state: true });
});

test('shared inputs and unknown changes retain all integration coverage', () => {
  for (const files of [null, ['src/protocol.ts'], ['crates/engine/src/repair.rs'], ['package-lock.json'], ['src/new-feature.ts'], ['.github/workflows/ci.yml']]) {
    assert.deepEqual(selectSuites(files), { suites: Object.keys(suites), state: true });
  }
});

test('every selected browser harness exists and belongs to one targeted suite', async () => {
  const seen = new Set();
  for (const [name, harnesses] of Object.entries(suites)) for (const [file] of harnesses) {
    await access(new URL('../' + file, import.meta.url));
    if (seen.has(file)) { assert.equal(name, 'terminal'); continue; }
    seen.add(file);
    assert.deepEqual(selectSuites([file]), { suites: [name], state: false });
  }
});

test('push and pull request diffs cover deletions and renames without base-branch changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-ci-suites-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-q'); await mkdir(path.join(directory, 'src'));
  await writeFile(path.join(directory, 'src/reading.ts'), 'reading'); const original = commit();
  git('mv', 'src/reading.ts', 'src/dictation.ts'); const head = commit();
  assert.deepEqual(changedFiles({ before: original }, directory).sort(), ['src/dictation.ts', 'src/reading.ts']);
  git('checkout', '-qb', 'base', original); await writeFile(path.join(directory, 'src/files.ts'), 'base-only change'); const base = commit();
  git('checkout', '-q', head);
  assert.deepEqual(changedFiles({ pull_request: { base: { sha: base } } }, directory).sort(), ['src/dictation.ts', 'src/reading.ts']);
  for (const event of [{}, { before: '0'.repeat(40) }, { before: 'f'.repeat(40) }]) assert.equal(changedFiles(event, directory), null);
});
