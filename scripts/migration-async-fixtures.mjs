import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'termai-async-oracle-'));
try {
  const home = path.join(temporary, 'home'); await mkdir(home);
  const tests = (await readdir(path.join(root, 'test'))).filter(file => /^(?:completion|discovery|path-repair|path-spelling|pipeline|shared-engine|suggestions|transfer-suggestions|validation)\.test\.ts$/.test(file)).map(file => 'test/' + file);
  const result = spawnSync(process.execPath, ['--import', './scripts/migration-async-oracle.mjs', '--test', ...tests], {
    cwd: root, env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', TERMAI_ASYNC_ORACLE_DIR: temporary }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Reference assertions failed; refusing to replace the asynchronous corpus.');
  const unique = new Map();
  for (const file of (await readdir(temporary)).filter(file => file.endsWith('.json'))) for (const row of JSON.parse(await readFile(path.join(temporary, file), 'utf8'))) unique.set(JSON.stringify(row), row);
  const fixtures = [...unique.values()].sort((a,b) => a.operation.localeCompare(b.operation) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  await writeFile(path.join(root, 'test/fixtures/rust-migration/native-host.json'), JSON.stringify({ version: 1, reference: '455386bc9443e778f381e1eeaf37cec5a35c2f75', fixtures }) + '\n');
  console.log(`Captured ${fixtures.length} asynchronous regression fixtures from real reference hosts.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
