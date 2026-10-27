import { createHash } from 'node:crypto';
import { chmod, readFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

export async function ensureHerdrBinary({ file, url, expected, download = fetch }) {
  const cached = await readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (cached && checksum(cached) === expected) {
    await chmod(file, 0o755);
    return true;
  }
  const response = await download(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Herdr test download failed: ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (checksum(bytes) !== expected) throw new Error('Herdr test checksum mismatch.');
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(file), '.herdr-'));
  try {
    const candidate = path.join(temporary, 'herdr');
    await writeFile(candidate, bytes, { mode: 0o755 });
    await rename(candidate, file);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(new URL('../build/release-config.json', import.meta.url), 'utf8')).herdr;
  const target = process.platform + '-' + process.arch;
  const expected = config.sha256[target];
  if (!expected) throw new Error('Unsupported Herdr test target: ' + target);
  const name = 'herdr-' + (process.platform === 'darwin' ? 'macos' : 'linux') + '-' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64');
  const directory = path.resolve(import.meta.dirname, '../.test-artifacts/bin'), file = path.join(directory, 'herdr');
  const cached = await ensureHerdrBinary({ file, url: `https://github.com/herdrdev/herdr/releases/download/${config.version}/${name}`, expected });
  if (process.env.GITHUB_PATH) await writeFile(process.env.GITHUB_PATH, directory + '\n', { flag: 'a' });
  if (process.env.GITHUB_ENV) await writeFile(process.env.GITHUB_ENV, 'HERDR_BINARY=' + file + '\n', { flag: 'a' });
  console.log('Verified ' + (cached ? 'cached ' : '') + 'Herdr ' + config.version + ' for ' + target);
}
