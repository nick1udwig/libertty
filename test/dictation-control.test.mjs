import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('controller ignores retained attempt events and restores the retry deadline', () => {
  execFileSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'test/support/dictation-control.mjs'], { stdio: 'pipe' });
});
