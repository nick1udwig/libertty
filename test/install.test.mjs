import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, readlink, stat, symlink } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { install, parseOptions } from '../scripts/setup.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function fixture(t, platform = 'linux', manager = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'libertty-install-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = directory + '/home with spaces', bundle = directory + '/bundle';
  await mkdir(home); await mkdir(bundle + '/scripts', { recursive: true });
  const metadata = { version: '0.1.0', tag: 'v0.1.0', commit: '1'.repeat(40), platform: platform + '-arm64' };
  await writeFile(bundle + '/release.json', JSON.stringify(metadata));
  await writeFile(bundle + '/scripts/launch.mjs', '// fixture');
  const calls = [];
  const command = (name, args, options = {}) => {
    calls.push({ name, args });
    if (args.includes('is-active') || args.includes('is-enabled') || args.includes('print')) return { ok: false, stdout: '' };
    if (args.includes('show-environment')) return { ok: manager, stdout: '' };
    if (name === 'brew' && args.includes('--prefix')) return { ok: true, stdout: '/opt/homebrew/opt/bash\n' };
    return { ok: true, stdout: '' };
  };
  const dependencies = { home, configHome: home + '/config', dataHome: home + '/data', platform, arch: 'arm64', bundle, command, health: async () => {}, confirm: async () => true };
  return { directory, home, bundle, metadata, dependencies, calls };
}
test('installer validates explicit options before making changes', () => {
  assert.deepEqual(parseOptions(['--yes', '--port', '7400', '--base-path', '/workspace']), { yes: true, port: '7400', 'base-path': '/workspace' });
  for (const args of [['--port', '0'], ['--port', '65536'], ['--base-path', '/x?'], ['--prefix'], ['--surprise']]) assert.throws(() => parseOptions(args));
});
async function legacyInstallation(f, platform = 'linux') {
  const config = f.home + '/config/termai/config.json';
  const unit = platform === 'linux' ? f.home + '/config/systemd/user/termai.service' : f.home + '/Library/LaunchAgents/com.termai.server.plist';
  await mkdir(path.dirname(config), { recursive: true });
  await mkdir(path.dirname(unit), { recursive: true });
  await mkdir(f.home + '/data/termai', { recursive: true });
  await mkdir(f.home + '/.local/bin', { recursive: true });
  await writeFile(f.home + '/data/termai/pairing-token', 'existing-pairing-token');
  await writeFile(config, JSON.stringify({ managedBy: 'termai', env: { PORT: '7600', TERMAI_BASE_PATH: '/existing', TERMAI_CWD: '/saved/workspace', TERMAI_DATA_DIR: f.home + '/data/termai', TERMAI_TOKEN: 'saved-token', LIBERTTY_CWD: '/new/workspace' } }));
  await writeFile(unit, '# Managed by the Termai installer\nlegacy service');
  await writeFile(f.home + '/.local/bin/termai', '#!/bin/sh\n# Managed by the Termai installer\nlegacy launcher');
  const run = f.dependencies.command;
  f.dependencies.command = (name, args, options) => {
    if ((args.includes('termai.service') || args.some(arg => arg.endsWith('/com.termai.server'))) && (args.includes('is-active') || args.includes('is-enabled') || args.includes('print'))) return { ok: true, stdout: '' };
    return run(name, args, options);
  };
  return { config, unit };
}
for (const platform of ['linux', 'darwin']) {
  test(`rebrand migrates ${platform} service and settings while preserving pairing data`, async t => {
    const f = await fixture(t, platform), legacy = await legacyInstallation(f, platform);
    const installed = await install({ yes: true }, f.dependencies);
    assert.equal(installed.config.managedBy, 'libertty');
    assert.equal(installed.config.env.PORT, '7600');
    assert.equal(installed.config.env.LIBERTTY_BASE_PATH, '/existing');
    assert.equal(installed.config.env.LIBERTTY_CWD, '/new/workspace');
    assert.equal(installed.config.env.LIBERTTY_TOKEN, 'saved-token');
    assert.equal(installed.config.env.LIBERTTY_DATA_DIR, f.home + '/data/termai');
    assert.equal('TERMAI_TOKEN' in installed.config.env, false);
    assert.equal(await readFile(f.home + '/data/termai/pairing-token', 'utf8'), 'existing-pairing-token');
    await assert.rejects(stat(legacy.unit), { code: 'ENOENT' });
    assert.ok((await readFile(f.home + '/.local/bin/termai', 'utf8')).includes(installed.launch));
    assert.equal(JSON.parse(await readFile(legacy.config, 'utf8')).managedBy, 'termai');
    assert.ok(f.calls.some(call => platform === 'linux' ? call.args.join(' ') === '--user disable --now termai.service' : call.args.includes('bootout')));
  });
  test(`failed rebrand restores the ${platform} service and legacy launcher`, async t => {
    const f = await fixture(t, platform), legacy = await legacyInstallation(f, platform);
    const originalUnit = await readFile(legacy.unit, 'utf8'), originalLauncher = await readFile(f.home + '/.local/bin/termai', 'utf8');
    f.dependencies.health = async () => { throw new Error('fixture startup failure'); };
    await assert.rejects(install({ yes: true }, f.dependencies), /Previous release.*restored/);
    assert.equal(await readFile(legacy.unit, 'utf8'), originalUnit);
    assert.equal(await readFile(f.home + '/.local/bin/termai', 'utf8'), originalLauncher);
    await assert.rejects(stat(f.home + '/config/libertty/config.json'), { code: 'ENOENT' });
    assert.ok(f.calls.some(call => platform === 'linux' ? call.args.join(' ') === '--user restart termai.service' : call.args.includes('bootstrap') && call.args.includes(legacy.unit)));
  });
}
test('Rust releases install a direct native launcher and upgrades can roll back to Node', async t => {
  const f = await fixture(t);
  f.metadata.backend = 'rust';
  await writeFile(f.bundle + '/release.json', JSON.stringify(f.metadata));
  const installed = await install({ yes: true, 'no-service': true }, f.dependencies);
  const launcher = await readFile(installed.launch, 'utf8');
  assert.ok(launcher.includes("/bin/libertty-backend' --config '"));
  assert.ok(!launcher.includes('/bin/node'));
  f.metadata.version = '0.2.0'; f.metadata.tag = 'v0.2.0'; f.metadata.commit = '2'.repeat(40); f.metadata.backend = 'node';
  await writeFile(f.bundle + '/release.json', JSON.stringify(f.metadata));
  await install({ yes: true, 'no-service': true }, f.dependencies);
  assert.ok((await readFile(installed.launch, 'utf8')).includes('/scripts/launch.mjs'));
  assert.ok(await stat(installed.releaseDir));
});
test('fresh install uses user systemd, preserves pairing data, and quotes paths with spaces', async t => {
  const f = await fixture(t); await mkdir(f.home + '/data/libertty', { recursive: true });
  await writeFile(f.home + '/data/libertty/pairing-token', 'existing-token');
  const installed = await install({ yes: true }, f.dependencies);
  assert.equal(installed.service, true);
  const config = JSON.parse(await readFile(installed.configFile, 'utf8'));
  assert.equal(config.env.HOST, '127.0.0.1'); assert.equal(config.env.LIBERTTY_CWD, f.home);
  assert.equal(await readFile(f.home + '/data/libertty/pairing-token', 'utf8'), 'existing-token');
  assert.equal(await readlink(installed.prefix + '/current'), installed.releaseDir);
  const unit = await readFile(f.home + '/config/systemd/user/libertty.service', 'utf8');
  assert.ok(unit.includes('ExecStart="' + installed.launch + '"'));
  assert.ok(f.calls.some(call => call.name === 'systemctl' && call.args.join(' ') === '--user restart libertty.service'));
  assert.equal((await stat(installed.configFile)).mode & 0o777, 0o600);
});
test('failed upgrade restores previous release, config, launcher, and service', async t => {
  const f = await fixture(t), installed = await install({ yes: true }, f.dependencies);
  const originalConfig = await readFile(installed.configFile, 'utf8'), originalUnit = await readFile(f.home + '/config/systemd/user/libertty.service', 'utf8');
  f.metadata.version = '0.2.0'; f.metadata.tag = 'v0.2.0'; f.metadata.commit = '2'.repeat(40);
  await writeFile(f.bundle + '/release.json', JSON.stringify(f.metadata));
  const command = (name, args, options) => args.includes('is-active') || args.includes('is-enabled') ? { ok: true, stdout: '' } : f.dependencies.command(name, args, options);
  await assert.rejects(install({ yes: true, port: '7400' }, { ...f.dependencies, command, health: async () => { throw new Error('fixture startup failure'); } }), /Previous release.*restored/);
  assert.equal(await readlink(installed.prefix + '/current'), installed.releaseDir);
  assert.equal(await readFile(installed.configFile, 'utf8'), originalConfig);
  assert.equal(await readFile(f.home + '/config/systemd/user/libertty.service', 'utf8'), originalUnit);
  assert.equal(JSON.parse(await readFile(installed.prefix + '/install.json', 'utf8')).metadata.version, '0.1.0');
  assert.equal(f.calls.at(-1).args.join(' '), '--user restart libertty.service');
});
test('an unmanaged service is refused before changing files or restarting it', async t => {
  const f = await fixture(t); const unit = f.home + '/config/systemd/user/libertty.service';
  await mkdir(path.dirname(unit), { recursive: true }); await writeFile(unit, 'ExecStart=/some/existing/app');
  await assert.rejects(install({ yes: true }, f.dependencies), /not installer-managed/);
  assert.equal(await readFile(unit, 'utf8'), 'ExecStart=/some/existing/app');
  assert.ok(!f.calls.some(call => call.args.includes('restart')));
});
test('declining a missing Python prerequisite leaves the installation untouched', async t => {
  const f = await fixture(t), run = f.dependencies.command;
  f.dependencies.command = (name, args, settings) => name === 'python3' ? { ok: false, stdout: '' } : run(name, args, settings);
  f.dependencies.confirm = async () => false;
  await assert.rejects(install({}, f.dependencies), /Python 3.8/);
  await assert.rejects(stat(f.home + '/data/libertty/current'));
  assert.ok(!f.calls.some(call => call.args.includes('restart')));
});
test('upgrades retain custom environment settings and previous versions', async t => {
  const f = await fixture(t), installed = await install({ yes: true, 'no-service': true }, f.dependencies);
  const config = JSON.parse(await readFile(installed.configFile, 'utf8')); config.env.PORT = '7600'; config.env.LIBERTTY_CWD = '/custom/workspace';
  await writeFile(installed.configFile, JSON.stringify(config));
  f.metadata.commit = '2'.repeat(40); await writeFile(f.bundle + '/release.json', JSON.stringify(f.metadata));
  const updated = await install({ yes: true, 'no-service': true }, f.dependencies);
  assert.equal(updated.config.env.PORT, '7600'); assert.equal(updated.config.env.LIBERTTY_CWD, '/custom/workspace');
  assert.ok(await stat(installed.releaseDir)); assert.notEqual(updated.releaseDir, installed.releaseDir);
});
test('machines without a user bus get a manual launcher without system service mutation', async t => {
  const f = await fixture(t, 'linux', false), installed = await install({ yes: true }, f.dependencies);
  assert.equal(installed.service, false); assert.ok(await stat(installed.launch));
  assert.ok(!f.calls.some(call => ['enable', 'restart', 'daemon-reload'].some(action => call.args.includes(action))));
});
test('Apple Silicon generates a login LaunchAgent, never systemd', async t => {
  const f = await fixture(t, 'darwin'), installed = await install({ yes: true }, f.dependencies);
  const plist = await readFile(f.home + '/Library/LaunchAgents/com.libertty.server.plist', 'utf8');
  assert.ok(plist.includes('<string>' + installed.launch + '</string>'));
  assert.ok(f.calls.some(call => call.name === 'launchctl' && call.args[0] === 'bootstrap'));
  assert.ok(!f.calls.some(call => call.name === 'systemctl'));
});
test('bootstrap rejects checksum mismatch before executing a downloaded runtime', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'libertty-bootstrap-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory + '/app/bin', { recursive: true }); await mkdir(directory + '/app/scripts');
  const executed = directory + '/executed';
  await writeFile(directory + '/app/bin/node', '#!/bin/sh\ntouch "' + executed + '"\n', { mode: 0o755 });
  await writeFile(directory + '/app/scripts/setup.mjs', '');
  execFileSync('tar', ['-czf', directory + '/app.tar.gz', '-C', directory + '/app', '.']);
  const result = spawnSync('bash', [root + '/install.sh', '--archive', directory + '/app.tar.gz', '--sha256', '0'.repeat(64), '--yes'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum mismatch/);
  await assert.rejects(stat(executed));
  const digest = createHash('sha256').update(await readFile(directory + '/app.tar.gz')).digest('hex');
  const correct = spawnSync('bash', [root + '/install.sh', '--archive', directory + '/app.tar.gz', '--sha256', digest, '--yes'], { encoding: 'utf8' });
  assert.equal(correct.status, 0, correct.stderr); assert.ok(await stat(executed));
});
test('bootstrap installs its launcher when the temporary directory is reached through a symlink', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'libertty-symlink-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'bundle'), home = path.join(directory, 'home');
  for (const entry of ['bin', 'scripts', 'server', 'build', 'node_modules']) await mkdir(path.join(bundle, entry), { recursive: true });
  await mkdir(home); await mkdir(path.join(directory, 'temporary'));
  const temporary = path.join(directory, 'temporary-alias');
  await symlink(path.join(directory, 'temporary'), temporary);
  await symlink(process.execPath, path.join(bundle, 'bin/node'));
  await symlink(path.join(root, 'node_modules/ws'), path.join(bundle, 'node_modules/ws'));
  for (const entry of ['setup.mjs', 'setup-integrations.mjs']) await cp(path.join(root, 'scripts', entry), path.join(bundle, 'scripts', entry));
  await cp(path.join(root, 'build/release-config.json'), path.join(bundle, 'build/release-config.json'));
  await writeFile(path.join(bundle, 'release.json'), JSON.stringify({ version: '0.1.1', tag: 'v0.1.1', commit: '1'.repeat(40), platform: process.platform + '-' + process.arch }));
  await writeFile(path.join(bundle,'scripts/launch.mjs'), "import { readFile } from 'node:fs/promises'; const config=JSON.parse(await readFile(process.argv[process.argv.indexOf('--config')+1],'utf8')); Object.assign(process.env,config.env); await import('../server/index.ts');\n");
  await writeFile(path.join(bundle, 'server/index.ts'), 'console.log("libertty 0.1.1");\n');
  const archive = path.join(directory, 'app.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', bundle, '.']);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), TMPDIR: temporary };
  const result = spawnSync('bash', [root + '/install.sh', '--archive', archive, '--sha256', digest, '--yes', '--no-service', '--no-companions', '--no-tailscale'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Libertty 0\.1\.1 installed/);
  assert.equal(execFileSync(path.join(home, '.local/bin/libertty'), ['--version'], { env, encoding: 'utf8' }).trim(), 'libertty 0.1.1');
  const config = JSON.parse(await readFile(path.join(home, '.config/libertty/config.json'), 'utf8'));
  assert.equal(config.version, '0.1.1');
  assert.equal(config.env.LIBERTTY_CWD, home);
});
test('bootstrap rejects older or non-glibc Linux before downloading or executing a release', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'libertty-libc-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(directory + '/uname', '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', { mode: 0o755 });
  for (const libc of ['glibc 2.35', 'glibc 2.38', 'musl', 'glibc 2.39', 'glibc 2.44']) {
    await writeFile(directory + '/getconf', '#!/bin/sh\necho "' + libc + '"\n', { mode: 0o755 });
    const result = spawnSync('bash', [root + '/install.sh', '--archive', directory + '/missing.tar.gz'], { encoding: 'utf8', env: { ...process.env, PATH: directory + ':' + process.env.PATH } });
    assert.notEqual(result.status, 0);
    if (['glibc 2.39', 'glibc 2.44'].includes(libc)) assert.match(result.stderr, /Archive does not exist/);
    else assert.match(result.stderr, /require glibc 2.39.*nothing installed/);
  }
});
