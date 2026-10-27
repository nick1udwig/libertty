import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureHerdrBinary } from '../scripts/install-test-herdr.mjs';

const bytes = Buffer.from('pinned Herdr binary'), expected = createHash('sha256').update(bytes).digest('hex');
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'libertty-herdr-cache-'));
  try { await run({ directory, file: path.join(directory, 'herdr'), url: 'https://example.test/herdr', expected }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('a verified Herdr cache hit avoids downloads and restores execute permissions', () => fixture(async options => {
  let downloads = 0;
  const download = async () => { downloads++; return new Response(bytes); };
  assert.equal(await ensureHerdrBinary({ ...options, download }), false);
  await chmod(options.file, 0o644);
  assert.equal(await ensureHerdrBinary({ ...options, download }), true);
  assert.equal(downloads, 1);
  assert.equal((await stat(options.file)).mode & 0o777, 0o755);
  assert.deepEqual(await readFile(options.file), bytes);
}));

test('a corrupt Herdr cache is replaced only by a verified download', () => fixture(async options => {
  await writeFile(options.file, 'corrupt');
  assert.equal(await ensureHerdrBinary({ ...options, download: async () => new Response(bytes) }), false);
  assert.deepEqual(await readFile(options.file), bytes);
  assert.deepEqual(await readdir(options.directory), ['herdr']);
}));

test('a bad download leaves the existing Herdr cache untouched', () => fixture(async options => {
  await writeFile(options.file, 'corrupt');
  await assert.rejects(ensureHerdrBinary({ ...options, download: async () => new Response('wrong binary') }), /checksum mismatch/);
  assert.equal(await readFile(options.file, 'utf8'), 'corrupt');
  assert.deepEqual(await readdir(options.directory), ['herdr']);
}));

test('an HTTP failure does not create a Herdr binary', () => fixture(async options => {
  await assert.rejects(ensureHerdrBinary({ ...options, download: async () => new Response('Unavailable', { status: 503 }) }), /download failed: 503/);
  assert.deepEqual(await readdir(options.directory), []);
}));
