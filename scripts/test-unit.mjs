import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { unitTestFiles } from './unit-files.mjs';

const files = unitTestFiles(readdirSync(new URL('../test/', import.meta.url)), process.env.VERIFY_QUICK_DONE === '1');
const result = spawnSync(process.execPath, ['--test', ...files.map(file => 'test/' + file)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
