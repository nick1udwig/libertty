#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, rename, rm, readlink, realpath, symlink, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { integrations, findExecutable } from './setup-integrations.mjs';

const marker = '# Managed by the libertty installer';
const legacyMarker = '# Managed by the Termai installer';
const managed = text => [marker, legacyMarker].some(value => text?.toLowerCase().includes(value.toLowerCase()));
function renamedEnvironment(environment) {
  const result = { ...environment };
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith('TERMAI_')) continue;
    const current = 'LIBERTTY_' + name.slice('TERMAI_'.length);
    if (!(current in result)) result[current] = value;
    delete result[name];
  }
  return result;
}
export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function parseOptions(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (['--yes', '--no-service', '--no-companions', '--no-tailscale'].includes(option)) result[option.slice(2)] = true;
    else if (['--version', '--archive', '--sha256', '--prefix', '--port', '--base-path'].includes(option)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value for ' + option);
      result[option.slice(2)] = args[++i];
    } else throw new Error('Unknown installer option: ' + option);
  }
  if (result.port && (!/^\d+$/.test(result.port) || +result.port < 1 || +result.port > 65535)) throw new Error('Port must be between 1 and 65535.');
  if (result['base-path'] && !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(result['base-path'])) throw new Error('Invalid base path.');
  return result;
}
export async function confirm(question, options) {
  if (options.yes) { console.log(question + ' Yes (--yes).'); return true; }
  let input, output, reader, fd;
  try {
    fd = openSync('/dev/tty', 'r+');
    input = createReadStream('/dev/tty', { fd, autoClose: false }); output = createWriteStream('/dev/tty', { fd, autoClose: false });
    reader = createInterface({ input, output, terminal: true });
    const answer = (await reader.question(question + ' [Y/n] ')).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } catch { throw new Error('Interactive setup needs a terminal; use --yes with explicit --no-* options for unattended installation.'); }
  finally { reader?.close(); input?.destroy(); output?.destroy(); if (fd !== undefined) closeSync(fd); }
}
export function command(command, args = [], { optional = false, capture = false, timeout = 30000, env } = {}) {
  let tty;
  if (!capture) { try { tty = openSync('/dev/tty', 'r'); } catch {} }
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout, env: env ? { ...process.env, ...env } : process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : [tty ?? 'inherit', 'inherit', 'inherit'] });
    if (!optional && (result.error || result.status !== 0)) throw new Error(command + ' failed' + (result.error ? ': ' + result.error.message : ' (exit ' + result.status + ')'));
    return { ok: !result.error && result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } finally { if (tty !== undefined) closeSync(tty); }
}
const read = async file => readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
const exists = async file => !!await stat(file).catch(() => undefined);
async function atomic(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.new-' + process.pid;
  await writeFile(temporary, value, { mode }); await rename(temporary, file);
}
function installationPath(value) {
  if (!path.isAbsolute(value) || /[%$"\\\x00-\x1f]/.test(value)) throw new Error('Installation paths must be absolute and contain no control characters, percent, dollar, quote or backslash.');
  return value;
}
export async function install(options, dependencies = {}) {
  const run = dependencies.command || command, ask = dependencies.confirm || (question => confirm(question, options));
  const home = dependencies.home || os.homedir(), platform = dependencies.platform || process.platform;
  const bundle = dependencies.bundle || path.resolve(import.meta.dirname, '..');
  const configHome = installationPath(dependencies.configHome || process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const dataHome = installationPath(dependencies.dataHome || process.env.XDG_DATA_HOME || path.join(home, '.local/share'));
  const prefix = installationPath(path.resolve(options.prefix || path.join(dataHome, 'libertty')));
  const configFile = path.join(configHome, 'libertty/config.json');
  const legacyConfigFile = path.join(configHome, 'termai/config.json');
  const launch = path.join(prefix, 'launch');
  const unit = platform === 'linux' ? path.join(configHome, 'systemd/user/libertty.service') : path.join(home, 'Library/LaunchAgents/com.libertty.server.plist');
  const legacyUnit = platform === 'linux' ? path.join(configHome, 'systemd/user/termai.service') : path.join(home, 'Library/LaunchAgents/com.termai.server.plist');
  const metadata = JSON.parse(await readFile(path.join(bundle, 'release.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version) || metadata.tag !== 'v' + metadata.version || !/^[a-f0-9]{40}$/.test(metadata.commit)) throw new Error('Invalid release metadata.');
  if (metadata.platform !== platform + '-' + (dependencies.arch || process.arch)) throw new Error('This release does not match the host platform.');
  if (metadata.backend !== undefined && !['node', 'rust'].includes(metadata.backend)) throw new Error('Unsupported release backend.');
  const previous = await read(configFile);
  const legacyConfig = previous ? undefined : await read(legacyConfigFile);
  const saved = previous || legacyConfig;
  if (saved && !['libertty', 'termai'].includes(JSON.parse(saved).managedBy)) throw new Error('Existing config.json is not managed by libertty; review it before installing.');
  const defaultData = !await exists(path.join(dataHome, 'libertty')) && await exists(path.join(dataHome, 'termai')) ? path.join(dataHome, 'termai') : path.join(dataHome, 'libertty');
  const env = { HOST: '127.0.0.1', PORT: '7321', LIBERTTY_BASE_PATH: '/t', LIBERTTY_ALLOWED_HOSTS: 'localhost,127.0.0.1', LIBERTTY_DATA_DIR: defaultData, LIBERTTY_CWD: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, PATH: [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':'), ...renamedEnvironment(saved ? JSON.parse(saved).env : {}) };
  if (options.port) env.PORT = options.port;
  if (options['base-path']) env.LIBERTTY_BASE_PATH = options['base-path'];
  let bash = env.LIBERTTY_BASH || process.env.LIBERTTY_BASH || process.env.TERMAI_BASH || (platform === 'darwin' ? '/opt/homebrew/bin/bash' : '/bin/bash');
  const modern = candidate => run(candidate, ['-c', '(( BASH_VERSINFO[0] > 4 || BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4 ))'], { optional: true, capture: true }).ok;
  if (!modern(bash) && platform === 'darwin') {
    if (!await ask('Install modern Bash with Homebrew?')) throw new Error('libertty needs Bash 4.4 or newer.');
    run('brew', ['install', 'bash'], { timeout: 600000 });
    bash = run('brew', ['--prefix', 'bash'], { capture: true }).stdout.trim() + '/bin/bash';
  }
  if (!modern(bash)) throw new Error('Install Bash 4.4 or newer and set LIBERTTY_BASH to its absolute path.');
  env.LIBERTTY_BASH = bash;
  const pythonReady = () => run('python3', ['-c', 'import sys; assert sys.version_info >= (3,8)'], { optional: true, capture: true, env }).ok;
  if (!pythonReady()) {
    if (!await ask('Install Python 3 for libertty shell integration?')) throw new Error('libertty needs Python 3.8 or newer.');
    const find = name => findExecutable(name, env);
    if (platform === 'darwin') run('brew', ['install', 'python'], { timeout: 600000 });
    else if (await find('apt-get')) run('sudo', [await find('apt-get'), 'install', '-y', 'python3'], { timeout: 600000 });
    else if (await find('pacman')) run('sudo', [await find('pacman'), '-S', '--needed', '--noconfirm', 'python'], { timeout: 600000 });
    else if (await find('dnf')) run('sudo', [await find('dnf'), 'install', '-y', 'python3'], { timeout: 600000 });
    else throw new Error('Install Python 3.8 or newer with your package manager, then rerun setup.');
    if (!pythonReady()) throw new Error('Python 3.8 or newer is still unavailable on the configured PATH.');
  }
  const userManager = platform === 'linux' ? run('systemctl', ['--user', 'show-environment'], { optional: true, capture: true }).ok : platform === 'darwin';
  const service = !options['no-service'] && userManager && await ask(platform === 'linux' ? 'Install and start libertty as a systemd user service?' : 'Install and start libertty as a login LaunchAgent?');
  if (!userManager && !options['no-service']) console.log('No systemd user manager is available; the launcher will be installed for manual use.');
  const oldUnit = await read(unit);
  const oldLegacyUnit = await read(legacyUnit);
  if (service && ((oldUnit && !managed(oldUnit)) || (oldLegacyUnit && !managed(oldLegacyUnit)))) throw new Error('Existing terminal service is not installer-managed; use --no-service or migrate it explicitly.');
  const oldLauncher = await read(launch);
  if (oldLauncher && !managed(oldLauncher)) throw new Error('Existing launch file is not installer-managed.');
  const userBin = path.join(home, '.local/bin/libertty'), oldUserBin = await read(userBin);
  const legacyUserBin = path.join(home, '.local/bin/termai'), oldLegacyUserBin = await read(legacyUserBin);
  if (oldUserBin && !managed(oldUserBin)) throw new Error('Existing ~/.local/bin/libertty is not installer-managed.');
  const current = path.join(prefix, 'current'), oldCurrent = await readlink(current).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  const releaseDir = path.join(prefix, 'releases', metadata.tag + '-' + metadata.platform + '-' + metadata.commit.slice(0, 12));
  const oldRecord = await read(path.join(prefix, 'install.json'));
  const active = service && (platform === 'linux' ? run('systemctl', ['--user', 'is-active', '--quiet', 'libertty.service'], { optional: true, capture: true }).ok : run('launchctl', ['print', 'gui/' + process.getuid() + '/com.libertty.server'], { optional: true, capture: true }).ok);
  const enabled = service && platform === 'linux' && run('systemctl', ['--user', 'is-enabled', '--quiet', 'libertty.service'], { optional: true, capture: true }).ok;
  const migrateService = service && !!oldLegacyUnit;
  const legacyActive = migrateService && (platform === 'linux' ? run('systemctl', ['--user', 'is-active', '--quiet', 'termai.service'], { optional: true, capture: true }).ok : run('launchctl', ['print', 'gui/' + process.getuid() + '/com.termai.server'], { optional: true, capture: true }).ok);
  const legacyEnabled = migrateService && platform === 'linux' && run('systemctl', ['--user', 'is-enabled', '--quiet', 'termai.service'], { optional: true, capture: true }).ok;
  if ((active || legacyActive) && !await ask('Restart libertty to apply this release (ends live terminal connections)?')) throw new Error('Installation cancelled before changing the running service.');
  await mkdir(path.dirname(releaseDir), { recursive: true, mode: 0o700 });
  if (!await exists(releaseDir)) {
    const staging = releaseDir + '.new-' + process.pid;
    try { await cp(bundle, staging, { recursive: true }); await rename(staging, releaseDir); }
    finally { await rm(staging, { recursive: true, force: true }); }
  }
  const label = 'gui/' + (process.getuid?.() ?? 0);
  const restore = async (file, value, mode) => { if (value === undefined) await rm(file, { force: true }); else await atomic(file, value, mode); };
  const config = { managedBy: 'libertty', env, version: metadata.version, commit: metadata.commit };
  try {
    if (migrateService) {
      if (platform === 'linux') run('systemctl', ['--user', 'disable', '--now', 'termai.service']);
      else if (legacyActive) run('launchctl', ['bootout', label + '/com.termai.server']);
      await rm(legacyUnit);
    }
    await rm(current + '.new', { force: true }); await symlink(releaseDir, current + '.new'); await rename(current + '.new', current);
    await atomic(configFile, JSON.stringify(config, null, 2) + '\n');
    const command = metadata.backend === 'rust' ? shellQuote(path.join(current, 'bin/libertty-backend')) : shellQuote(path.join(current, 'bin/node')) + ' ' + shellQuote(path.join(current, 'scripts/launch.mjs'));
    await atomic(launch, '#!/bin/sh\n' + marker + '\nexec ' + command + ' --config ' + shellQuote(configFile) + ' "$@"\n', 0o755);
    await atomic(userBin, '#!/bin/sh\n' + marker + '\nexec ' + shellQuote(launch) + ' "$@"\n', 0o755);
    if (managed(oldLegacyUserBin)) await atomic(legacyUserBin, '#!/bin/sh\n' + marker + '\nexec ' + shellQuote(launch) + ' "$@"\n', 0o755);
    if (service) {
      if (platform === 'linux') {
        await atomic(unit, marker + '\n[Unit]\nDescription=libertty terminal workspace\nAfter=network.target\n\n[Service]\nType=simple\nExecStart="' + launch + '"\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n');
        run('systemctl', ['--user', 'daemon-reload']); run('systemctl', ['--user', 'enable', 'libertty.service']); run('systemctl', ['--user', 'restart', 'libertty.service']);
      } else {
        const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        await atomic(unit, `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${marker} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.libertty.server</string><key>ProgramArguments</key><array><string>${xml(launch)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(path.join(prefix, 'server.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(prefix, 'server.log'))}</string></dict></plist>\n`);
        run('launchctl', ['bootout', label + '/com.libertty.server'], { optional: true }); run('launchctl', ['bootstrap', label, unit]);
      }
      const probe = dependencies.health || (async () => {
        for (let i = 0; i < 60; i++) {
          try {
            const response = await fetch(`http://127.0.0.1:${env.PORT}${env.LIBERTTY_BASE_PATH === '/' ? '' : env.LIBERTTY_BASE_PATH}/healthz`, { signal: AbortSignal.timeout(1500) });
            const value = await response.json(); if (response.ok && value.ok && value.commit === metadata.commit && value.version === metadata.version) return;
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('libertty did not become ready on its configured port.');
      });
      await probe();
    }
    await atomic(path.join(prefix, 'install.json'), JSON.stringify({ managedBy: 'libertty', releaseDir, configFile, unit: service ? unit : null, metadata }, null, 2) + '\n');
  } catch (error) {
    if (service) run(platform === 'linux' ? 'systemctl' : 'launchctl', platform === 'linux' ? ['--user', 'stop', 'libertty.service'] : ['bootout', label + '/com.libertty.server'], { optional: true });
    await rm(current, { force: true }); if (oldCurrent) await symlink(oldCurrent, current);
    await restore(configFile, previous); await restore(launch, oldLauncher, 0o755); await restore(userBin, oldUserBin, 0o755);
    if (managed(oldLegacyUserBin)) await restore(legacyUserBin, oldLegacyUserBin, 0o755);
    await restore(path.join(prefix, 'install.json'), oldRecord);
    if (service) {
      await restore(unit, oldUnit);
      if (platform === 'linux') {
        run('systemctl', ['--user', 'daemon-reload'], { optional: true });
        if (!enabled) run('systemctl', ['--user', 'disable', 'libertty.service'], { optional: true });
        if (active) run('systemctl', ['--user', 'restart', 'libertty.service'], { optional: true });
      } else if (active) run('launchctl', ['bootstrap', label, unit], { optional: true });
    }
    if (migrateService) {
      await restore(legacyUnit, oldLegacyUnit);
      if (platform === 'linux') {
        run('systemctl', ['--user', 'daemon-reload'], { optional: true });
        if (legacyEnabled) run('systemctl', ['--user', 'enable', 'termai.service'], { optional: true });
        if (legacyActive) run('systemctl', ['--user', 'restart', 'termai.service'], { optional: true });
      } else if (legacyActive) run('launchctl', ['bootstrap', label, legacyUnit], { optional: true });
    }
    throw new Error(error.message + '\nPrevious release, configuration and service restored.');
  }
  return { home, platform, prefix, configFile, config, metadata, releaseDir, launch, service, run, ask, options };
}
export async function main(args) {
  const installed = await install(parseOptions(args));
  const failures = [];
  if (installed.service && installed.platform === 'linux') {
    try {
      const lingering = installed.run('loginctl', ['show-user', String(process.getuid()), '-p', 'Linger', '--value'], { optional: true, capture: true });
      if (lingering.ok && lingering.stdout.trim() !== 'yes' && await installed.ask('Keep user services running after logout and start them at boot (enable lingering with sudo)?')) installed.run('sudo', ['loginctl', 'enable-linger', os.userInfo().username]);
    } catch (error) { failures.push('Autostart: ' + error.message); }
  }
  const companions = await integrations(installed);
  companions.failures.push(...failures);
  await atomic(path.join(installed.prefix, 'setup-status.json'), JSON.stringify(companions, null, 2) + '\n');
  console.log(`libertty ${installed.metadata.version} installed.\nLauncher: ${path.join(installed.home, '.local/bin/libertty')}`);
  console.log(installed.service ? 'Open ' + companions.url : 'Start the server with the launcher above, then open ' + companions.url);
  const tokenFile = path.join(installed.config.env.LIBERTTY_DATA_DIR, 'pairing-token');
  const token = await read(tokenFile);
  if (token?.trim() && installed.service) console.log('Pairing token: ' + token.trim());
  else console.log('Pairing token file: ' + tokenFile);
  console.log(`Herdr: ${companions.herdr}; Voxtype Mobile: ${companions.voxtype}; Tailscale: ${companions.tailscale}.`);
  if (companions.failures.length) { console.error('libertty is installed; optional setup needs attention.\n' + companions.failures.join('\n')); process.exitCode = 2; }
}
// macOS temporary paths commonly traverse /var -> /private/var.
const entrypoint = process.argv[1] && await realpath(process.argv[1]).catch(() => undefined);
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
