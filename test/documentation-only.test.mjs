import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { documentationFiles, documentationOnly } from '../scripts/documentation-only.mjs';

test('documentation selection rejects empty, mixed and executable changes', () => {
  assert.equal(documentationFiles(['README.md', '.agents/skills/example/SKILL.md', 'docs/images/example.png']), true);
  for (const files of [[], ['README.md', 'src/main.ts'], ['docs/example.js'], ['package.json'], ['.github/workflows/ci.yml']]) assert.equal(documentationFiles(files), false);
  for (const base of ['', '0'.repeat(40), '--all']) assert.equal(documentationOnly(base), false);
});
test('a real Git comparison checks both sides of a source-to-document rename', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'libertty-docs-only-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git('add', '.'); git('commit', '-qm', 'Fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q');
    await writeFile(path.join(cwd, 'app.ts'), 'export const value = 1;\n');
    await writeFile(path.join(cwd, 'README.md'), '# Before\n');
    const base = commit();
    await writeFile(path.join(cwd, 'README.md'), '# After\n');
    const docs = commit();
    assert.equal(documentationOnly(base, { cwd }), true);
    assert.equal(documentationOnly(docs, { cwd }), false);
    await mkdir(path.join(cwd, 'docs'));
    git('mv', 'app.ts', 'docs/example.md'); commit();
    assert.equal(documentationOnly(docs, { cwd }), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
