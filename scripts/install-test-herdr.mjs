import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const config = JSON.parse(await readFile(new URL('../build/release-config.json', import.meta.url), 'utf8')).herdr;
const target = process.platform + '-' + process.arch;
const expected = config.sha256[target];
if (!expected) throw new Error('Unsupported Herdr test target: ' + target);
const name = 'herdr-' + (process.platform === 'darwin' ? 'macos' : 'linux') + '-' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64');
const response = await fetch(`https://github.com/herdrdev/herdr/releases/download/${config.version}/${name}`, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw new Error('Herdr test download failed: ' + response.status);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Herdr test checksum mismatch.');
const directory = path.resolve(import.meta.dirname, '../.test-artifacts/bin');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'herdr'), bytes, { mode: 0o755 });
if (process.env.GITHUB_PATH) await writeFile(process.env.GITHUB_PATH, directory + '\n', { flag: 'a' });
if (process.env.GITHUB_ENV) await writeFile(process.env.GITHUB_ENV, 'HERDR_BINARY=' + path.join(directory, 'herdr') + '\n', { flag: 'a' });
console.log('Verified Herdr ' + config.version + ' for ' + target);
