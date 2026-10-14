import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

if (!process.argv[2]) throw new Error('Usage: npm run verify:package -- release/termai-vVERSION-PLATFORM.tar.gz');
const root = path.resolve(import.meta.dirname, '..');
const archive = path.resolve(process.argv[2]);
const browser = process.env.CHROME_PATH || process.env.CHROMIUM || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
const env = { ...process.env, CHROME_PATH: browser, CHROMIUM: browser };
const run = (file, args = [], overrides = {}) => execFileSync(process.execPath, [file, ...args], { cwd: root, env: { ...env, ...overrides }, stdio: 'inherit' });

run('scripts/smoke-release.mjs', [archive]);
run('scripts/smoke-install.mjs', [archive]);
const directory = await mkdtemp(path.join(os.tmpdir(), 'termai-package-browser-'));
try {
  execFileSync('tar', ['-xzpf', archive, '-C', directory]);
  for (const [engine, port] of [['server', '3137'], ['client', '3138']]) {
    run('test/browser.mjs', [], {
      TEST_EXECUTABLE: path.join(directory, 'bin/termai'), TEST_ENGINE: engine, TEST_PORT: port, TEST_BASE_PATH: '/terminal',
    });
  }
} finally { await rm(directory, { recursive: true, force: true }); }
