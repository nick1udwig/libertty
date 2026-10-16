import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function publishRelease({ directory, tag, installer, gh = args => spawnSync('gh', args, { cwd: directory, encoding: 'utf8' }) }) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  const digest = async file => createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex');
  const files = [], sums = [];
  for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
    const archive = `libertty-${tag}-${target}.tar.gz`;
    const sum = await digest(archive);
    assert.equal(await readFile(path.join(directory, archive + '.sha256'), 'utf8'), sum + '  ' + archive + '\n', archive + ': checksum mismatch');
    files.push(archive, archive + '.sha256');
    sums.push(sum + '  ' + archive);
  }
  await copyFile(installer, path.join(directory, 'install.sh'));
  sums.push(await digest('install.sh') + '  install.sh');
  await writeFile(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n');
  files.push('install.sh', 'SHA256SUMS');
  const run = args => {
    const result = gh(args);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'gh ' + args.slice(0, 2).join(' ') + ' failed: ' + result.stderr);
    return result.stdout;
  };
  const view = ['release', 'view', tag, '--json', 'isDraft,assets'];
  const existing = gh(view);
  if (existing.error) throw existing.error;
  if (existing.status === 0) {
    const release = JSON.parse(existing.stdout);
    if (!release.isDraft) {
      assert.equal(release.assets.length, 0, 'Release already has public assets; use a new version instead of replacing published assets.');
      // Creating a release in GitHub's UI can publish an empty release while the
      // tag-triggered builds are still running.
      run(['release', 'edit', tag, '--draft=true', '--verify-tag']);
      assert.equal(JSON.parse(run(view)).isDraft, true, 'Release must be a draft before uploading assets.');
    }
    run(['release', 'upload', tag, ...files, '--clobber']);
  } else {
    run(['release', 'create', tag, ...files, '--draft', '--verify-tag', '--title', tag, '--generate-notes']);
  }
  const uploaded = JSON.parse(run(view));
  assert.equal(uploaded.isDraft, true, 'Release must remain a draft until every file is uploaded.');
  for (const file of files) {
    const asset = uploaded.assets.find(asset => asset.name === file);
    assert.ok(asset && asset.state === 'uploaded', 'Missing uploaded asset: ' + file);
    assert.equal(asset.size, (await stat(path.join(directory, file))).size, file + ': uploaded size mismatch');
  }
  const prerelease = tag.includes('-');
  run(['release', 'edit', tag, '--draft=false', '--prerelease=' + prerelease, '--latest=' + !prerelease, '--verify-tag']);
  console.log('Published complete release ' + tag);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  await publishRelease({ directory: path.join(root, 'release'), tag: process.env.RELEASE_TAG, installer: path.join(root, 'install.sh') });
}
