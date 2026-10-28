#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const usage = 'Usage: node scripts/deploy-local.mjs [--master] [--dry-run]';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';

async function main() {
  if (args.has('--help')) { console.log(usage); return; }
  if ([...args].some(arg => !['--master', '--dry-run'].includes(arg))) throw new Error(usage);
  if (process.platform !== 'linux') throw new Error('Local source deployment requires Linux and a systemd user service.');
  const config = await readJson(path.join(root, '.deploy.local.json')).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Create .deploy.local.json using docs/local-deployment.md.');
    throw error;
  });
  const service = config.service ?? 'libertty.service';
  if (!/^[\w@.-]+\.service$/.test(service)) throw new Error('Invalid deployment service name.');
  if (!Array.isArray(config.urls) || !config.urls.length) throw new Error('Configure at least one deployment URL.');
  const urls = config.urls.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Deployment URLs must use HTTP or HTTPS without credentials, queries or fragments.');
    url.pathname = url.pathname.replace(/\/?$/, '/');
    return url;
  });
  const output = (command, arguments_, cwd = root) => execFileSync(command, arguments_, { cwd, encoding: 'utf8' }).trim();
  const systemctl = (...arguments_) => output('systemctl', ['--user', ...arguments_]);
  const property = name => systemctl('show', service, '--property=' + name, '--value');
  const worktrees = output('git', ['worktree', 'list', '--porcelain', '-z']).split('\0\0').map(record => record.split('\0'));
  const master = worktrees.find(fields => fields.includes('branch refs/heads/master'));
  if (!master) throw new Error('The master branch must have an existing worktree.');
  const mainCheckout = await realpath(master.find(field => field.startsWith('worktree ')).slice(9));
  const checkout = args.has('--master') ? mainCheckout : await realpath(root);
  const mainBinary = path.join(mainCheckout, 'target/release/libertty');
  const binary = path.join(checkout, 'target/release/libertty');
  const unit = await readFile(property('FragmentPath'), 'utf8');
  const baseCommand = unit.split(/\r?\n/).filter(line => line.startsWith('ExecStart=')).at(-1)?.slice(10).trim();
  if (![mainBinary, quote(mainBinary)].includes(baseCommand)) throw new Error('The base service must run the master checkout release binary directly.');
  const pinned = (await readJson(path.join(checkout, 'build/release-config.json'))).node;
  if (process.versions.node !== pinned || output('node', ['--version']) !== 'v' + pinned) throw new Error('Select Node ' + pinned + ' before deploying.');
  const version = (await readJson(path.join(checkout, 'package.json'))).version;
  const branch = output('git', ['branch', '--show-current'], checkout) || 'detached HEAD';
  const commit = output('git', ['rev-parse', '--short', 'HEAD'], checkout);
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dropIn = path.join(configHome, 'systemd/user', service + '.d/branch.conf');
  const previous = await readFile(dropIn, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (previous !== null) {
    const lines = previous.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith(';'));
    if (lines.length !== 3 || lines[0] !== '[Service]' || lines[1] !== 'ExecStart=' || !lines[2].startsWith('ExecStart=')) throw new Error('branch.conf contains extra settings and cannot be replaced safely.');
  }
  const next = checkout === mainCheckout ? null : '[Service]\nExecStart=\nExecStart=' + quote(binary) + '\n';
  console.log('Deploy ' + branch + ' at ' + commit + ' from ' + checkout + '.');
  console.log('Build with npm ci and npm run build:release.');
  console.log((next === null ? 'Remove ' : 'Write ') + dropIn + ', then reload and restart ' + service + '.');
  console.log('Keep WorkingDirectory=' + property('WorkingDirectory') + '.');
  console.log('Check version ' + version + ' and frontend assets at ' + urls.map(url => url.href).join(', ') + '.');
  if (args.has('--dry-run')) return;

  for (const arguments_ of [['ci'], ['run', 'build:release']]) execFileSync('npm', arguments_, { cwd: checkout, stdio: 'inherit' });
  const executableVersion = output(binary, ['--version'], checkout);
  if (!executableVersion.startsWith('libertty ' + version + ' ')) throw new Error('The release binary version does not match package.json.');
  async function setDropIn(contents) {
    if (contents === null) { await rm(dropIn, { force: true }); return; }
    await mkdir(path.dirname(dropIn), { recursive: true });
    const temporary = dropIn + '.' + process.pid + '.tmp';
    try {
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, dropIn);
    } finally { await rm(temporary, { force: true }); }
  }
  const get = url => fetch(url, { signal: AbortSignal.timeout(3000) });
  async function check(url) {
    let failure;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await get(new URL('healthz', url));
        if (!response.ok) throw new Error('Health endpoint returned HTTP ' + response.status + '.');
        const health = await response.json();
        if (health.ok !== true || health.version !== version || health.runtime !== 'rust') throw new Error('Health endpoint did not report the expected release.');
        failure = undefined;
        break;
      } catch (error) { failure = error; await delay(500); }
    }
    if (failure) throw new Error('Deployment health failed at ' + url.href, { cause: failure });
    const response = await get(url);
    if (!response.ok) throw new Error('Frontend returned HTTP ' + response.status + '.');
    const html = await response.text();
    const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]))];
    if (!assets.length) throw new Error('Frontend has no application assets.');
    for (const asset of assets) {
      const assetUrl = new URL(asset, url);
      if (assetUrl.origin !== url.origin || !assetUrl.pathname.startsWith(url.pathname)) throw new Error('Frontend asset is outside the application mount.');
      const relative = decodeURIComponent(assetUrl.pathname.slice(url.pathname.length));
      if (!/^assets\/[^/\\]+\.(js|css)$/.test(relative)) throw new Error('Invalid frontend asset path.');
      const expected = await readFile(path.join(checkout, 'dist', relative));
      const served = await get(assetUrl);
      if (!served.ok || !Buffer.from(await served.arrayBuffer()).equals(expected)) throw new Error('Served frontend asset differs from the release build.');
    }
    console.log('Healthy: ' + url.href + ' (' + version + ', ' + assets.length + ' matching assets).');
  }
  await setDropIn(next);
  try {
    systemctl('daemon-reload');
    systemctl('restart', service);
    for (const url of urls) await check(url);
    if (property('ActiveState') !== 'active' || await realpath('/proc/' + property('MainPID') + '/exe') !== await realpath(binary)) throw new Error('The service is not running the selected release binary.');
  } catch (error) {
    await setDropIn(previous);
    systemctl('daemon-reload');
    systemctl('restart', service);
    console.error('Restored the previous service command.');
    throw error;
  }
  console.log('Deployed ' + branch + ' at ' + commit + '.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
