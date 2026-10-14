import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = directory => {
  git(directory, 'add', '.');
  git(directory, '-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
};
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q');
  await writeFile(path.join(directory, '.gitignore'), 'dist/\ntarget/\n.test-artifacts/\nnode_modules/\nrelease/\n.release-companions/\n');
  for (const file of ['dist/index.html', 'target/release/termai']) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), file, { mode: 0o755 });
  }
  return { directory };
}

test('release packaging builds once and retains metadata, checksums, permissions and companion pins', async t => {
  const { directory } = await fixture(t);
  for (const name of ['scripts/package-release.mjs', 'scripts/setup.mjs', 'scripts/setup-integrations.mjs', 'install.sh', 'LICENSE', 'examples/plugins']) {
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
  const revision = git(directory, 'rev-parse', 'HEAD');
  const commands = path.join(directory, '.test-artifacts/commands');
  await mkdir(commands, { recursive: true });
  await writeFile(path.join(commands, 'cargo'), '#!/bin/sh\necho built >> .test-artifacts/builds\n', { mode: 0o755 });
  await writeFile(path.join(commands, 'rustc'), '#!/bin/sh\necho rustc-fixture\n', { mode: 0o755 });
  const env = { ...process.env, PATH: commands + path.delimiter + process.env.PATH, VOXTYPE_MOBILE_CHECKOUT: companion };
  delete env.TERMAI_RELEASE_ALLOW_DIRTY;
  delete env.RELEASE_TAG;
  const packageBuild = () => execFileSync(process.execPath, ['scripts/package-release.mjs'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  packageBuild();
  assert.equal(await readFile(path.join(directory, '.test-artifacts/builds'), 'utf8'), 'built\n');
  const name = 'termai-v0.2.0-' + process.platform + '-' + process.arch + '.tar.gz';
  const archive = path.join(directory, 'release', name), extracted = path.join(directory, '.test-artifacts/extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzpf', archive, '-C', extracted]);
  const metadata = JSON.parse(await readFile(path.join(extracted, 'release.json'), 'utf8'));
  assert.equal(metadata.commit, revision);
  assert.equal(metadata.dirty, false);
  assert.equal(metadata.rust, 'rustc-fixture');
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
  await writeFile(path.join(directory, 'uncommitted.txt'), 'dirty');
  assert.throws(packageBuild, /Commit changes/);
});
