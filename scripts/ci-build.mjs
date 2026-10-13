import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const inputs = {
  browser: ['dist', 'src/engine/termai-engine.wasm', 'target/debug/termai', 'target/debug/examples/herdr_snapshot'],
  release: ['dist', 'target/release/termai'],
};
const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();

async function buildFiles(directory, kind) {
  assert.ok(Object.hasOwn(inputs, kind), 'Unknown CI build kind: ' + kind);
  const files = {};
  async function visit(relative) {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = relative + '/' + entry.name;
      if (entry.isDirectory()) await visit(file);
      else {
        assert.ok(entry.isFile(), 'CI builds must contain regular files: ' + file);
        await hash(file);
      }
    }
  }
  async function hash(file) {
    files[file] = createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex');
  }
  await readFile(path.join(directory, 'dist/index.html'));
  for (const input of inputs[kind]) {
    if (input === 'dist') await visit(input);
    else await hash(input);
  }
  return files;
}

export async function createBuildManifest(directory, kind, file) {
  const manifest = {
    format: 1, kind, commit: git(directory, 'rev-parse', 'HEAD'),
    dirty: !!git(directory, 'status', '--porcelain'),
    platform: process.platform + '-' + process.arch,
    node: process.version,
    rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
    files: await buildFiles(directory, kind),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function verifyBuildManifest(directory, kind, file, { allowDirty = false } = {}) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(manifest.format, 1, 'Unsupported CI build manifest');
  assert.equal(manifest.kind, kind, 'CI build kind mismatch');
  assert.equal(manifest.commit, git(directory, 'rev-parse', 'HEAD'), 'CI build source revision mismatch');
  assert.equal(manifest.platform, process.platform + '-' + process.arch, 'CI build platform mismatch');
  assert.ok(allowDirty || (manifest.dirty === false && !git(directory, 'status', '--porcelain')), 'CI builds require clean source checkouts');
  assert.ok(typeof manifest.rust === 'string' && manifest.rust.startsWith('rustc '), 'Missing CI build compiler provenance');
  assert.deepEqual(await buildFiles(directory, kind), manifest.files, 'CI build contents do not match their checksums');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, kind, file] = process.argv.slice(2);
  assert.ok(file && ['create', 'verify'].includes(command), 'Usage: node scripts/ci-build.mjs create|verify browser|release MANIFEST');
  if (command === 'create') await createBuildManifest(root, kind, path.resolve(file));
  else await verifyBuildManifest(root, kind, path.resolve(file));
}
