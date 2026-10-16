import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

if (!process.argv[2]) throw new Error('Usage: npm run verify:package -- release/libertty-vVERSION-PLATFORM.tar.gz');
const root = path.resolve(import.meta.dirname, '..');
const archive = path.resolve(process.argv[2]);
const browser = process.env.CHROME_PATH || process.env.CHROMIUM || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
const env = { ...process.env, CHROME_PATH: browser, CHROMIUM: browser };
const run = (file, args = [], overrides = {}) => execFileSync(process.execPath, [file, ...args], { cwd: root, env: { ...env, ...overrides }, stdio: 'inherit' });

run('scripts/smoke-release.mjs', [archive]);
run('scripts/smoke-install.mjs', [archive]);
const directory = await mkdtemp(path.join(os.tmpdir(), 'libertty-package-browser-'));
try {
  execFileSync('tar', ['-xzpf', archive, '-C', directory]);
  run('test/browser.mjs', [], {
    TEST_EXECUTABLE: path.join(directory, 'bin/libertty'), TEST_PORT: '3137', TEST_BASE_PATH: '/terminal',
  });
} finally { await rm(directory, { recursive: true, force: true }); }
