import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePluginPackage } from '../../src/plugin-package.ts';

const directory = path.resolve(process.argv[2] || new URL('./log-viewer', import.meta.url).pathname);
const pkg = parsePluginPackage({ manifest: JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')), view: await readFile(path.join(directory, 'view.html'), 'utf8') });
const output = path.resolve(process.argv[3] || path.join(directory, '..', pkg.manifest.id + '.libertty-plugin.json'));
await writeFile(output, JSON.stringify(pkg, null, 2) + '\n');
console.log(output);
