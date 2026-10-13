import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBuildManifest, verifyBuildManifest } from '../scripts/ci-build.mjs';

const root = path.resolve(import.meta.dirname, '..');
const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = directory => {
  git(directory, 'add', '.');
  git(directory, '-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
};
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-ci-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q');
  await writeFile(path.join(directory, '.gitignore'), 'dist/\ntarget/\n.test-artifacts/\nnode_modules/\nrelease/\n.release-companions/\n');
  await writeFile(path.join(directory, 'source.txt'), 'source revision');
  commit(directory);
  for (const file of ['dist/index.html', 'dist/assets/app.js', 'src/engine/termai-engine.wasm', 'target/debug/termai', 'target/debug/examples/herdr_snapshot', 'target/release/termai']) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), file, { mode: file.startsWith('target/') ? 0o755 : 0o644 });
  }
  // The generated Wasm file is ignored in the real checkout too.
  await writeFile(path.join(directory, '.gitignore'), await readFile(path.join(directory, '.gitignore'), 'utf8') + 'src/engine/termai-engine.wasm\n');
  commit(directory);
  const file = path.join(directory, '.test-artifacts/build.json');
  return { directory, file };
}

test('browser and release builds survive artifact transport with checksums and executable permissions', async t => {
  const { directory, file } = await fixture(t);
  for (const kind of ['browser', 'release']) {
    const manifest = await createBuildManifest(directory, kind, file);
    const archive = path.join(directory, '.test-artifacts/build.tar.gz');
    const executable = path.join(directory, kind === 'release' ? 'target/release/termai' : 'target/debug/termai');
    const mode = (await stat(executable)).mode & 0o777;
    execFileSync('tar', ['-czf', archive, ...Object.keys(manifest.files), '.test-artifacts/build.json'], { cwd: directory });
    await rm(path.join(directory, 'dist'), { recursive: true });
    for (const input of Object.keys(manifest.files).filter(input => !input.startsWith('dist/'))) await rm(path.join(directory, input));
    execFileSync('tar', ['-xzf', archive], { cwd: directory });
    assert.deepEqual(await verifyBuildManifest(directory, kind, file), manifest);
    assert.equal((await stat(executable)).mode & 0o777, mode);
  }
});

test('reuse rejects stale revisions, wrong platforms, incomplete manifests and modified build files', async t => {
  const { directory, file } = await fixture(t);
  const manifest = await createBuildManifest(directory, 'release', file);
  for (const changes of [{ format: 0 }, { kind: 'browser' }, { commit: '0'.repeat(40) }, { platform: 'wrong-platform' }, { rust: '' }, { files: {} }]) {
    await writeFile(file, JSON.stringify({ ...manifest, ...changes }));
    await assert.rejects(verifyBuildManifest(directory, 'release', file));
  }
  await writeFile(file, JSON.stringify(manifest));
  await writeFile(path.join(directory, 'dist/assets/app.js'), 'changed');
  await assert.rejects(verifyBuildManifest(directory, 'release', file), /checksums/);
  await writeFile(path.join(directory, 'dist/assets/app.js'), 'dist/assets/app.js');
  await writeFile(path.join(directory, 'dist/extra.js'), 'unexpected asset');
  await assert.rejects(verifyBuildManifest(directory, 'release', file), /checksums/);
  await rm(path.join(directory, 'dist/extra.js'));
  await writeFile(path.join(directory, 'source.txt'), 'new source revision');
  commit(directory);
  await assert.rejects(verifyBuildManifest(directory, 'release', file), /revision mismatch/);
});

test('dirty build provenance and dirty checkouts require the explicit local packaging override', async t => {
  const { directory, file } = await fixture(t);
  const clean = await createBuildManifest(directory, 'release', file);
  await writeFile(path.join(directory, 'source.txt'), 'uncommitted source');
  await assert.rejects(verifyBuildManifest(directory, 'release', file), /clean source/);
  const dirty = await createBuildManifest(directory, 'release', file);
  assert.equal(dirty.dirty, true);
  git(directory, 'checkout', '--', 'source.txt');
  await assert.rejects(verifyBuildManifest(directory, 'release', file), /clean source/);
  assert.deepEqual(await verifyBuildManifest(directory, 'release', file, { allowDirty: true }), dirty);
  await writeFile(file, JSON.stringify(clean));
  await verifyBuildManifest(directory, 'release', file);
});

test('release packaging reuses a verified build without Cargo and retains release pins and companion provenance', async t => {
  const { directory, file } = await fixture(t);
  for (const name of ['scripts/package-release.mjs', 'scripts/ci-build.mjs', 'scripts/setup.mjs', 'scripts/setup-integrations.mjs', 'install.sh', 'LICENSE', 'examples/plugins']) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await cp(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.2.0', type: 'module' }));
  await writeFile(path.join(directory, 'package-lock.json'), '{}');
  await mkdir(path.join(directory, 'node_modules/ws'), { recursive: true });
  await cp(path.join(root, 'node_modules/ws'), path.join(directory, 'node_modules/ws'), { recursive: true });
  const companion = path.join(directory, '.release-companions/voxtype-mobile');
  await mkdir(companion, { recursive: true });
  git(companion, 'init', '-q');
  for (const name of ['LICENSE', 'scripts/install-daemon', 'artifacts/voxtype-mobile-daemon']) {
    await mkdir(path.dirname(path.join(companion, name)), { recursive: true });
    await writeFile(path.join(companion, name), 'pinned companion ' + name, { mode: 0o755 });
  }
  commit(companion);
  const pins = { node: process.versions.node, voxtypeMobile: { repository: 'fixture/voxtype', commit: git(companion, 'rev-parse', 'HEAD') } };
  await mkdir(path.join(directory, 'build'));
  await writeFile(path.join(directory, 'build/release-config.json'), JSON.stringify(pins));
  commit(directory);
  const manifest = await createBuildManifest(directory, 'release', file);
  const commands = path.join(directory, '.test-artifacts/commands');
  await mkdir(commands);
  for (const name of ['cargo', 'rustc']) await writeFile(path.join(commands, name), '#!/bin/sh\necho Unexpected compiler invocation >&2\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, PATH: commands + path.delimiter + process.env.PATH, TERMAI_RELEASE_BUILD_MANIFEST: file, VOXTYPE_MOBILE_CHECKOUT: companion };
  delete env.TERMAI_RELEASE_ALLOW_DIRTY;
  delete env.RELEASE_TAG;
  const packageBuild = () => execFileSync(process.execPath, ['scripts/package-release.mjs'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  packageBuild();
  const name = 'termai-v0.2.0-' + process.platform + '-' + process.arch + '.tar.gz';
  const archive = path.join(directory, 'release', name), extracted = path.join(directory, '.test-artifacts/extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzpf', archive, '-C', extracted]);
  const metadata = JSON.parse(await readFile(path.join(extracted, 'release.json'), 'utf8'));
  assert.equal(metadata.commit, manifest.commit);
  assert.equal(metadata.dirty, false);
  assert.equal(metadata.rust, manifest.rust);
  assert.equal(await readFile(path.join(extracted, 'bin/termai-backend'), 'utf8'), 'target/release/termai');
  assert.equal((await stat(path.join(extracted, 'bin/termai-backend'))).mode & 0o111, 0o111);
  if (process.platform === 'linux') {
    const source = JSON.parse(await readFile(path.join(extracted, 'companions/voxtype-mobile/source.json'), 'utf8'));
    assert.deepEqual(source, pins.voxtypeMobile);
    assert.equal(await readFile(path.join(extracted, 'companions/voxtype-mobile/daemon'), 'utf8'), 'pinned companion artifacts/voxtype-mobile-daemon');
  }
  assert.equal(await readFile(archive + '.sha256', 'utf8'), createHash('sha256').update(await readFile(archive)).digest('hex') + '  ' + name + '\n');
  env.RELEASE_TAG = 'v9.0.0';
  assert.throws(packageBuild, /Tag|tag/);
  delete env.RELEASE_TAG;
  await writeFile(path.join(directory, 'dist/assets/app.js'), 'tampered');
  assert.throws(packageBuild, /checksums/);
});
