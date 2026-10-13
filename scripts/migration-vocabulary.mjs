import { readFile } from 'node:fs/promises';

// The native engine and the frontend now consume this same canonical data.
const vocabulary=JSON.parse(await readFile(new URL('../contracts/engine-vocabulary.json',import.meta.url),'utf8'));
for (const key of ['commonFlags','subcommands','symbolNames']) if (!vocabulary[key]||typeof vocabulary[key]!=='object') throw new Error('Missing engine vocabulary: '+key);
for (const [name,symbol] of Object.entries(vocabulary.symbolNames)) if (!name||typeof symbol!=='string'||!symbol) throw new Error('Invalid speech symbol: '+name);
console.log('Verified canonical command and speech vocabulary.');
