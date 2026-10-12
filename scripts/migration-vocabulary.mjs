import { commonFlags, subcommands } from '../src/engine/command-policy.ts';
import { symbolNames } from '../src/engine/speech.ts';
import { readFile, writeFile } from 'node:fs/promises';
const output = new URL('../contracts/engine-vocabulary.json', import.meta.url);
const content = JSON.stringify({ commonFlags, subcommands, symbolNames }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== content) throw new Error('Rust engine vocabulary is stale.');
} else await writeFile(output, content);
console.log('Verified shared command and speech vocabulary.');
