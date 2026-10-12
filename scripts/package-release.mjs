#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, chmod, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'release'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const config = JSON.parse(await readFile(path.join(root, 'build/release-config.json'), 'utf8'));
const localTest = process.env.TERMAI_RELEASE_ALLOW_DIRTY === '1';
const backend = process.env.TERMAI_BACKEND || 'rust';
if (!['node', 'rust'].includes(backend)) throw new Error('TERMAI_BACKEND must be node or rust.');
const tag = process.env.RELEASE_TAG || 'v' + pkg.version;
if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag) || tag !== 'v' + pkg.version) throw new Error('Release tag must equal v + package.json version.');
const platform = process.platform + '-' + process.arch;
if (!['linux-x64', 'linux-arm64', 'darwin-arm64'].includes(platform)) throw new Error('Unsupported release platform: ' + platform);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain') && !localTest) throw new Error('Commit changes before packaging a release; use TERMAI_RELEASE_ALLOW_DIRTY=1 only for local tests.');
if (process.versions.node !== config.node && !localTest) throw new Error('Release builds must use Node ' + config.node);
if (process.platform === 'linux' && !process.env.VOXTYPE_MOBILE_CHECKOUT && !localTest) throw new Error('Linux releases must include the pinned Voxtype Mobile daemon.');
await access(path.join(root, 'dist/index.html'));
if (backend === 'rust') execFileSync('cargo', ['build', '--release', '--locked', '-p', 'termai-server', '--bin', 'termai'], { cwd: root, stdio: 'inherit' });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'termai-release-'));
try {
  for (const file of [...(backend === 'node' ? ['server', 'src'] : []), 'dist', 'scripts', 'install.sh', 'package.json', 'package-lock.json', 'LICENSE', 'examples/plugins', 'build/release-config.json']) {
    await mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await cp(path.join(root, file), path.join(temporary, file), { recursive: true });
  }
  await mkdir(path.join(temporary, 'bin'), { recursive: true });
  await cp(process.execPath, path.join(temporary, 'bin/node'));
  const nodeLicense = path.resolve(path.dirname(process.execPath), '../LICENSE');
  await cp(nodeLicense, path.join(temporary, 'NODE-LICENSE')).catch(() => {
    throw new Error('Use an official Node distribution with its LICENSE beside bin/; Node licensing must be included.');
  });
  if (backend === 'node') execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: temporary, stdio: 'inherit', env: { ...process.env, npm_config_build_from_source: 'true' } });
  else {
    await mkdir(path.join(temporary, 'node_modules'), { recursive: true });
    await cp(path.join(root, 'node_modules/ws'), path.join(temporary, 'node_modules/ws'), { recursive: true });
    await cp(path.join(root, 'target/release/termai'), path.join(temporary, 'bin/termai-backend'));
    await chmod(path.join(temporary, 'bin/termai-backend'), 0o755);
  }
  await writeFile(path.join(temporary, 'bin/termai'), `#!/bin/sh\nset -eu\napp=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport NODE_ENV=production\nexport TERMAI_CWD="\${TERMAI_CWD:-$HOME}"\ncd "$app"\nexec "$app/bin/node" "$app/server/index.ts" "$@"\n`, { mode: 0o755 });
  await chmod(path.join(temporary, 'bin/node'), 0o755);
  if (backend === 'rust') await writeFile(path.join(temporary, 'bin/termai'), '#!/bin/sh\nset -eu\napp=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport TERMAI_CWD="${TERMAI_CWD:-$HOME}"\ncd "$app"\nexec "$app/bin/termai-backend" "$@"\n', { mode: 0o755 });
  const metadata = { version: pkg.version, tag, commit: git('rev-parse', 'HEAD'), dirty: !!git('status', '--porcelain'), platform, backend, node: process.version, ...(backend === 'rust' ? { rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim() } : {}) };
  await writeFile(path.join(temporary, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  if (process.env.VOXTYPE_MOBILE_CHECKOUT && process.platform === 'linux') {
    const source = path.resolve(process.env.VOXTYPE_MOBILE_CHECKOUT);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    if (commit !== config.voxtypeMobile.commit) throw new Error('Voxtype Mobile checkout does not match release pin.');
    await mkdir(path.join(temporary, 'companions/voxtype-mobile/scripts'), { recursive: true });
    await cp(path.join(source, 'artifacts/voxtype-mobile-daemon'), path.join(temporary, 'companions/voxtype-mobile/daemon'));
    await cp(path.join(source, 'scripts/install-daemon'), path.join(temporary, 'companions/voxtype-mobile/scripts/install-daemon'));
    await cp(path.join(source, 'LICENSE'), path.join(temporary, 'companions/voxtype-mobile/LICENSE'));
    await writeFile(path.join(temporary, 'companions/voxtype-mobile/source.json'), JSON.stringify({ repository: config.voxtypeMobile.repository, commit }) + '\n');
  }
  await mkdir(output, { recursive: true });
  const name = `termai-${tag}-${platform}.tar.gz`;
  execFileSync('tar', ['-czf', path.join(output, name), '-C', temporary, '.']);
  const digest = createHash('sha256').update(await readFile(path.join(output, name))).digest('hex');
  await writeFile(path.join(output, name + '.sha256'), digest + '  ' + name + '\n');
  console.log(path.join(output, name));
} finally { await rm(temporary, { recursive: true, force: true }); }
