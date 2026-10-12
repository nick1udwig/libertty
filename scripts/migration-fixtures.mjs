import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'termai-oracle-'));
try {
  const tests = (await readdir(path.join(root, 'test'))).filter(file => file.endsWith('.test.ts')).map(file => 'test/' + file);
  const result = spawnSync(process.execPath, ['--import', './scripts/migration-oracle.mjs', '--test', ...tests, 'test/dependencies.test.mjs'], {
    cwd: root, env: { ...process.env, TERMAI_ORACLE_DIR: temporary }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Reference tests failed; refusing to replace the parity corpus.');
  const unique = new Map();
  for (const file of await readdir(temporary)) for (const row of JSON.parse(await readFile(path.join(temporary, file), 'utf8'))) unique.set(JSON.stringify(row), row);
  const fixtures = [...unique.values()].sort((a, b) => a.operation.localeCompare(b.operation) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const output = path.join(root, 'test/fixtures/rust-migration');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'engine.json'), JSON.stringify({ version: 1, reference: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), fixtures }) + '\n');
  await writeFile(path.join(output, 'unit-baseline.txt'), result.stdout.replaceAll(/\([0-9.]+ms\)/g, '(timing omitted)').replace(/^ℹ duration_ms .+$/m, 'ℹ duration_ms omitted'));
  console.log(`Captured ${fixtures.length} sanitized pure-engine fixtures.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
