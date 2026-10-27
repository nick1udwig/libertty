import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (command, args, env = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
if (process.env.VERIFY_QUICK_DONE !== '1') {
  run('npm', ['run', 'ci:quick']);
  run('npm', ['run', 'contracts:vocabulary', '--', '--check']);
  run('cargo', ['fmt', '--all', '--', '--check']);
}
run('cargo', ['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings']);
run('npm', ['run', 'test:rust']);
run('npm', ['run', 'build:frontend']);
run('npm', ['test'], { VERIFY_QUICK_DONE: '1', LIBERTTY_DEV_SKIP_BUILD: '1' });
run('npm', ['run', 'test:install']);
run('npm', ['run', 'verify:browser'], { LIBERTTY_DEV_SKIP_BUILD: '1' });
