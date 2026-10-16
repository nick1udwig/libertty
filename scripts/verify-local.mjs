import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
run('npm', ['run', 'ci:quick']);
run('npm', ['run', 'contracts:vocabulary', '--', '--check']);
run('cargo', ['fmt', '--all', '--', '--check']);
run('cargo', ['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings']);
run('npm', ['run', 'test:rust']);
run('npm', ['run', 'build']);
run('npm', ['test']);
run('npm', ['run', 'test:install']);
run('npm', ['run', 'verify:browser']);
