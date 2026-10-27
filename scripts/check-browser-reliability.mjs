import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
let failed = false;
const workers = process.env.BROWSER_RELIABILITY_JOBS ? [Number(process.env.BROWSER_RELIABILITY_JOBS)] : [1, 3];
if (workers.some(jobs => ![1, 3].includes(jobs))) throw new Error('BROWSER_RELIABILITY_JOBS must be 1 or 3.');
for (const jobs of workers) {
  console.log(`Checking browser reliability with ${jobs} worker${jobs === 1 ? '' : 's'}.`);
  const result = spawnSync(process.execPath, ['scripts/check-browser.mjs'], {
    cwd: root, stdio: 'inherit',
    env: {
      ...process.env, BROWSER_JOBS: String(jobs), BROWSER_REPEAT: process.env.BROWSER_REPEAT || '3',
      BROWSER_HARNESSES: 'reading-browser.mjs,terminal-touch-browser.mjs,terminal-selection-browser.mjs',
      TEST_SHELL_DELAY_MS: '400', TEST_GESTURE_DELAY_MS: '400',
    },
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) failed = true;
}
if (failed) process.exitCode = 1;
