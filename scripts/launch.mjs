#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) throw new Error('Supply --config with the installed config.json.');
const config = JSON.parse(await readFile(process.argv[index + 1], 'utf8'));
for (const [name, value] of Object.entries(config.env)) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid service environment setting: ' + name);
  process.env[name] = value;
}
process.env.NODE_ENV = 'production';
process.chdir(path.resolve(import.meta.dirname, '..'));
const metadata = JSON.parse(await readFile('release.json', 'utf8'));
if (metadata.backend === 'rust') {
  const args = process.argv.slice(2); args.splice(args.indexOf('--config'), 2);
  process.execve(path.resolve('bin/termai-backend'), [path.resolve('bin/termai-backend'), ...args], process.env);
} else await import('../server/index.ts');
