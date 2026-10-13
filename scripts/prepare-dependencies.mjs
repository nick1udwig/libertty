import { chmod, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const brokenEd25519 = `      {
        // Remove leading zero bytes
        let i = 0;
        for (; i < pubBin.length && pubBin[i] === 0x00; ++i);
        if (i > 0)
          pubBin = pubBin.slice(i);
      }`;
const fixedEd25519 = `      // The BIT STRING has one unused-bits byte, followed by 32 key bytes.
      // A public key may itself start with zero bytes; retain those bytes.
      if (pubBin.length !== 33 || pubBin[0] !== 0x00)
        throw new Error('Malformed ED25519 public key');
      pubBin = pubBin.slice(1);`;

export async function prepareDependencies(directory = root, platform = process.platform, arch = process.arch) {
  // Remove this version-scoped patch once ssh2 publishes its upstream fix:
  // https://github.com/mscdex/ssh2/pull/1515
  const ssh = path.join(directory, 'node_modules/ssh2');
  const packageFile = await readFile(path.join(ssh, 'package.json'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!packageFile) return; // SSH and PTY peers are development-only test dependencies.
  const pkg = JSON.parse(packageFile);
  if (pkg.version !== '1.17.0') throw new Error('Review the Ed25519 compatibility patch before updating ssh2.');
  const file = path.join(ssh, 'lib/keygen.js'), source = await readFile(file, 'utf8');
  const start = source.indexOf("    case 'ed25519': {"), end = source.indexOf('      // Parse private key', start);
  if (start < 0 || end < 0) throw new Error('Unexpected ssh2 Ed25519 implementation.');
  const section = source.slice(start, end);
  if (!section.includes(fixedEd25519)) {
    if (!section.includes(brokenEd25519)) throw new Error('Unexpected ssh2 Ed25519 implementation.');
    await writeFile(file, source.slice(0, start) + section.replace(brokenEd25519, fixedEd25519) + source.slice(end));
  }

  // node-pty 1.1.0 ships Darwin prebuilt helpers without execute permission:
  // https://github.com/microsoft/node-pty/issues/850
  if (platform === 'darwin') {
    let found = false;
    for (const location of [`prebuilds/darwin-${arch}`, 'build/Release', 'build/Debug']) {
      const helper = path.join(directory, 'node_modules/node-pty', location, 'spawn-helper');
      const info = await stat(helper).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info?.isFile()) { await chmod(helper, info.mode | 0o111); found = true; }
    }
    if (!found) throw new Error('node-pty is missing its macOS spawn-helper.');
  }
}

const entrypoint = process.argv[1] && await realpath(process.argv[1]).catch(() => undefined);
if (entrypoint === fileURLToPath(import.meta.url)) await prepareDependencies();
