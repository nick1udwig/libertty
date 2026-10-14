import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishRelease } from '../scripts/publish-release.mjs';

async function fixture(t, tag = 'v0.2.3') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termai-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'release'), installer = path.join(root, 'install.sh');
  await mkdir(directory);
  await writeFile(installer, '#!/bin/sh\necho install\n');
  for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
    const file = `termai-${tag}-${target}.tar.gz`, bytes = Buffer.from(target);
    await writeFile(path.join(directory, file), bytes);
    await writeFile(path.join(directory, file + '.sha256'), createHash('sha256').update(bytes).digest('hex') + '  ' + file + '\n');
  }
  const calls = [];
  const options = { exists: false, isDraft: true, failUpload: false, failDraft: false, ignoreDraft: false };
  const gh = args => {
    calls.push(args);
    if (args[1] === 'view' && !options.exists) return { status: 1, stderr: 'release not found' };
    if (['create', 'upload'].includes(args[1])) {
      if (options.failUpload) return { status: 1, stderr: 'upload interrupted' };
      options.exists = true;
      options.assets = options.uploadedAssets;
    }
    if (args[1] === 'edit' && args.includes('--draft=true')) {
      if (options.failDraft) return { status: 1, stderr: 'draft edit denied' };
      if (!options.ignoreDraft) options.isDraft = true;
    }
    if (args[1] === 'edit' && args.includes('--draft=false')) options.isDraft = false;
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ isDraft: options.isDraft, assets: options.assets }) };
    return { status: 0, stdout: '' };
  };
  // These are the asset names and sizes the remote CLI should report after upload.
  const prepare = async () => {
    await writeFile(path.join(directory, 'install.sh'), await readFile(installer));
    const sums = [];
    for (const file of [...(await readdir(directory)).filter(file => file.endsWith('.tar.gz')).sort(), 'install.sh']) {
      sums.push(createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex') + '  ' + file);
    }
    await writeFile(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n');
    options.uploadedAssets = await Promise.all((await readdir(directory)).map(async name => ({ name, state: 'uploaded', size: (await stat(path.join(directory, name))).size })));
    options.assets = options.uploadedAssets;
  };
  await prepare();
  return { directory, installer, tag, gh, calls, options };
}

test('release stays a draft until all eight assets are present, then becomes latest', async t => {
  const f = await fixture(t);
  await publishRelease(f);
  assert.deepEqual(f.calls.map(args => args[1]), ['view', 'create', 'view', 'edit']);
  assert.ok(f.calls[1].includes('--draft') && f.calls[1].includes('--verify-tag'));
  assert.ok(f.calls.at(-1).includes('--draft=false') && f.calls.at(-1).includes('--latest=true'));
  assert.equal((await readFile(path.join(f.directory, 'SHA256SUMS'), 'utf8')).trim().split('\n').length, 4);
});

test('retry uploads into an existing draft and publishes prereleases without marking them latest', async t => {
  const f = await fixture(t, 'v0.2.3-rc.1');
  f.options.exists = true;
  await publishRelease(f);
  assert.deepEqual(f.calls.map(args => args[1]), ['view', 'upload', 'view', 'edit']);
  assert.ok(f.calls[1].includes('--clobber'));
  assert.ok(f.calls.at(-1).includes('--prerelease=true') && f.calls.at(-1).includes('--latest=false'));
});

test('missing archives or mismatched checksums cannot create a release', async t => {
  const f = await fixture(t);
  const archive = path.join(f.directory, `termai-${f.tag}-linux-x64.tar.gz`);
  await writeFile(archive + '.sha256', 'bad checksum');
  await assert.rejects(publishRelease(f), /checksum mismatch/);
  await rm(archive);
  await assert.rejects(publishRelease(f), /ENOENT/);
  assert.deepEqual(f.calls, []);
});

test('failed uploads and missing or truncated remote assets never publish a draft', async t => {
  const f = await fixture(t);
  f.options.failUpload = true;
  await assert.rejects(publishRelease(f), /upload interrupted/);
  f.options.failUpload = false;
  const asset = f.options.uploadedAssets.pop();
  await assert.rejects(publishRelease(f), /Missing uploaded asset/);
  f.options.uploadedAssets.push({ ...asset, size: 0 });
  await assert.rejects(publishRelease(f), /uploaded size mismatch/);
  assert.ok(f.calls.every(args => args[1] !== 'edit'));
});

test('an empty public release returns to draft before uploading and publishing verified assets', async t => {
  const f = await fixture(t);
  f.options.exists = true;
  f.options.isDraft = false;
  f.options.assets = [];
  await publishRelease(f);
  assert.deepEqual(f.calls.map(args => args[1]), ['view', 'edit', 'view', 'upload', 'view', 'edit']);
  assert.ok(f.calls[1].includes('--draft=true') && f.calls[1].includes('--verify-tag'));
  assert.ok(f.calls[3].includes('--clobber'));
  assert.ok(f.calls.at(-1).includes('--draft=false') && f.calls.at(-1).includes('--latest=true'));
});

test('a failed or ineffective draft edit never uploads to an empty public release', async t => {
  const f = await fixture(t);
  f.options.exists = true;
  f.options.isDraft = false;
  f.options.assets = [];
  f.options.failDraft = true;
  await assert.rejects(publishRelease(f), /draft edit denied/);
  f.options.failDraft = false;
  f.options.ignoreDraft = true;
  await assert.rejects(publishRelease(f), /must be a draft before uploading/);
  assert.ok(f.calls.every(args => args[1] === 'view' || args.includes('--draft=true')));
});

test('upload failures leave a recovered public release in draft for a safe retry', async t => {
  const f = await fixture(t);
  f.options.exists = true;
  f.options.isDraft = false;
  f.options.assets = [];
  f.options.failUpload = true;
  await assert.rejects(publishRelease(f), /upload interrupted/);
  assert.equal(f.options.isDraft, true);
  assert.ok(f.calls.every(args => !args.includes('--draft=false')));
  f.options.failUpload = false;
  await publishRelease(f);
  assert.equal(f.options.isDraft, false);
  assert.equal(f.calls.filter(args => args.includes('--draft=true')).length, 1);
});

test('retries refuse to overwrite any public assets, including incomplete releases', async t => {
  const f = await fixture(t);
  f.options.exists = true;
  f.options.isDraft = false;
  await assert.rejects(publishRelease(f), /already has public assets/);
  f.options.assets = f.options.assets.slice(0, 1);
  await assert.rejects(publishRelease(f), /already has public assets/);
  assert.deepEqual(f.calls.map(args => args[1]), ['view', 'view']);
});
