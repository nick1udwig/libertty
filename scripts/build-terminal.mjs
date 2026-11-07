import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(path.join(root, 'build/terminal-config.json'), 'utf8'));
const version = (zig) => {
  try {
    return execFileSync(zig, ['version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};
let zig = process.env.ZIG ?? 'zig';
if (version(zig) !== config.zigVersion) {
  if (process.env.ZIG) throw new Error(`ZIG must select Zig ${config.zigVersion}`);
  const platform = `${process.platform}-${process.arch}`,
    toolchain = config.toolchains[platform];
  if (!toolchain) throw new Error(`Set ZIG to Zig ${config.zigVersion} for ${platform}`);
  const cache = path.join(root, '.test-artifacts/toolchains'),
    directory = path.join(cache, `zig-${platform}-${config.zigVersion}`);
  zig = path.join(directory, 'zig');
  if (version(zig) !== config.zigVersion) {
    await mkdir(cache, { recursive: true });
    const temporary = await mkdtemp(path.join(cache, 'zig-download-'));
    try {
      const archive = path.join(temporary, 'zig.tar.xz');
      execFileSync(
        'curl',
        ['--fail', '--location', '--retry', '3', '--output', archive, toolchain.url],
        { stdio: 'inherit' },
      );
      if (
        createHash('sha256')
          .update(await readFile(archive))
          .digest('hex') !== toolchain.sha256
      )
        throw new Error('Zig download checksum mismatch');
      await mkdir(directory, { recursive: true });
      execFileSync('tar', ['-xJf', archive, '--strip-components=1', '-C', directory], {
        stdio: 'inherit',
      });
      if (version(zig) !== config.zigVersion) throw new Error('Unexpected Zig version');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
const target = 'wasm32-unknown-unknown',
  env = { ...process.env, ZIG: zig };
execFileSync('rustup', ['target', 'add', target], { cwd: root, stdio: 'inherit' });
const check = process.argv.includes('--check');
execFileSync(
  'cargo',
  [
    check ? 'clippy' : 'build',
    '--locked',
    '-p',
    'libertty-terminal-wasm',
    '--target',
    target,
    '--release',
    ...(check ? ['--', '-D', 'warnings'] : []),
  ],
  { cwd: root, stdio: 'inherit', env },
);
if (!check) {
  await mkdir(path.join(root, 'src/generated'), { recursive: true });
  await copyFile(
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, 'target'),
      target,
      'release/libertty_terminal_wasm.wasm',
    ),
    path.join(root, 'src/generated/terminal.wasm'),
  );
}
