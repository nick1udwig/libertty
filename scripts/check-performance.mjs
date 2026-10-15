import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const browser = process.env.CHROME_PATH || process.env.CHROMIUM || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
const env = { ...process.env, CHROME_PATH: browser, CHROMIUM: browser };
const run = (command, args, overrides = {}) => execFileSync(command, args, { cwd: root, env: { ...env, ...overrides }, stdio: 'inherit' });

run('cargo', ['build', '--locked', '--release', '-p', 'termai-server', '--example', 'wire']);
run(process.execPath, ['test/transport-benchmark.mjs'], {
  WIRE_PROFILES: 'fast', WIRE_VARIANTS: 'json,gzip-fast', WIRE_SAMPLES: process.env.WIRE_FAST_SAMPLES || '101', WIRE_OUTPUT: 'transport-selected-fast-final.json',
});
run(process.execPath, ['test/transport-benchmark.mjs'], {
  WIRE_PROFILES: 'mobile', WIRE_VARIANTS: 'json,gzip', WIRE_OUTPUT: 'transport-selected-constrained.json',
});
run(process.execPath, ['test/transport-benchmark.mjs'], {
  WIRE_PROFILES: 'lossy', WIRE_VARIANTS: 'json,gzip', WIRE_OUTPUT: 'transport-selected-lossy.json',
});
run(process.execPath, ['test/transport-budgets.mjs'], { WIRE_RESULTS_DIR: '.test-artifacts' });
