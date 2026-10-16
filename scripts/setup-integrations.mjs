import { access, readFile, writeFile, rename, chmod, mkdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WebSocket } from 'ws';

const read = async file => readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
export async function findExecutable(name, env) {
  const candidates = (env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));
  if (name === 'tailscale') candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  for (const candidate of candidates) { try { await access(candidate, constants.X_OK); return candidate; } catch {} }
}
export async function voxtypeAvailable(env) {
  const file = env.LIBERTTY_VOXTYPE_TOKEN_FILE || path.join(env.XDG_DATA_HOME, 'voxtype-mobile/token');
  const token = (await read(file))?.trim();
  if (!token || token.length < 32 || /[\r\n]/.test(token) || (await stat(file)).mode & 0o077) return false;
  const url = new URL(env.LIBERTTY_VOXTYPE_URL || 'ws://127.0.0.1:8765/v1/dictate');
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) return false;
  url.pathname = url.pathname.replace(/\/dictate$/, '/capabilities');
  return new Promise(resolve => {
    const socket = new WebSocket(url, { headers: { Authorization: 'Bearer ' + token }, handshakeTimeout: 2000, maxPayload: 8192 });
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); socket.on('error', () => {}); socket.terminate(); resolve(value); };
    const timer = setTimeout(() => finish(false), 2500);
    socket.on('error', () => finish(false)); socket.on('close', () => finish(false));
    socket.once('message', bytes => {
      try { const event = JSON.parse(bytes.toString()); finish(event.type === 'capabilities' && event.protocol === 2 && event.dictation === true && event.sample_rate === 16000 && event.channels === 1 && event.format === 'opus' && event.framing === 'sequence_opus_v1' && event.audio_encodings?.includes('opus_v1') && event.results?.includes('final')); }
      catch { finish(false); }
    });
  });
}
export function tailscaleRoute(config, hostname, mount, upstream) {
  const listeners = config.Web || {};
  for (const [host, web] of Object.entries(listeners)) {
    if (host !== hostname + ':443') continue;
    for (const [route, handler] of Object.entries(web.Handlers || {})) {
      if ((route === '/' ? '/' : route.replace(/\/$/, '')) !== mount) continue;
      if (handler.Proxy !== upstream || Object.keys(handler).length !== 1) throw new Error(`${mount} already serves another target; existing route preserved.`);
      return 'existing';
    }
  }
  return 'new';
}
export async function integrations(installed, dependencies = {}) {
  const { run, ask, options, config, platform, home } = installed;
  const env = config.env;
  const find = dependencies.findExecutable || (name => findExecutable(name, env));
  const download = dependencies.fetch || fetch;
  const probe = dependencies.voxtypeAvailable || (() => voxtypeAvailable(env));
  const results = { herdr: 'skipped', voxtype: 'skipped', tailscale: 'skipped', url: `http://127.0.0.1:${env.PORT}${env.LIBERTTY_BASE_PATH === '/' ? '/' : env.LIBERTTY_BASE_PATH + '/'}`, failures: [] };
  const releaseConfig = JSON.parse(await readFile(path.join(installed.releaseDir, 'build/release-config.json'), 'utf8'));
  const attempt = async (name, work) => {
    try { await work(); } catch (error) { results[name] = 'failed'; results.failures.push(name + ': ' + error.message); console.error(name + ': ' + error.message); }
  };
  if (!options['no-companions']) {
    await attempt('herdr', async () => {
      if (await find('herdr')) { results.herdr = 'found'; return; }
      if (!await ask('Install Herdr ' + releaseConfig.herdr.version + ' for terminal and agent sessions?')) return;
      const target = installed.metadata.platform;
      const architecture = target.endsWith('arm64') ? 'aarch64' : 'x86_64';
      const name = 'herdr-' + (platform === 'darwin' ? 'macos' : 'linux') + '-' + architecture;
      const expected = releaseConfig.herdr.sha256[target];
      if (!expected) throw new Error('No verified Herdr binary for ' + target);
      const response = await download(`https://github.com/herdrdev/herdr/releases/download/${releaseConfig.herdr.version}/${name}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('Herdr download failed: HTTP ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Herdr checksum mismatch; nothing replaced.');
      const destination = path.join(home, '.local/bin/herdr'); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const temporary = destination + '.new-' + process.pid;
      try { await writeFile(temporary, bytes, { mode: 0o755 }); await chmod(temporary, 0o755); await rename(temporary, destination); }
      finally { await rm(temporary, { force: true }); }
      run(destination, ['--version']); results.herdr = 'installed';
    });
    await attempt('voxtype', async () => {
      if (await probe()) { results.voxtype = 'ready'; return; }
      if (platform !== 'linux') { results.voxtype = 'unsupported'; console.log('Voxtype Mobile automatic setup currently supports Linux; libertty and Herdr can run on macOS.'); return; }
      if (!await ask('Install or upgrade Voxtype Mobile, start its user service, and download its speech model (about 1 GB)?')) return;
      const companion = path.join(installed.releaseDir, 'companions/voxtype-mobile');
      try { await access(path.join(companion, 'daemon'), constants.X_OK); }
      catch { throw new Error('This bundle has no Voxtype Mobile daemon; use a complete published Linux release.'); }
      let python = await find('python3');
      const compatiblePython = () => python && run(python, ['-c', 'import sys; assert sys.version_info >= (3,11)'], { capture: true, optional: true }).ok;
      const codec = () => python && run(python, ['-c', "import ctypes; ctypes.CDLL('libopus.so.0'); ctypes.CDLL('libasound.so.2')"], { capture: true, optional: true }).ok;
      if (!compatiblePython() || !codec()) {
        if (!await ask('Install Python, Opus and ALSA runtime packages using sudo?')) throw new Error('Voxtype Mobile needs Python 3.11+, Opus and ALSA.');
        const apt = await find('apt-get'), pacman = await find('pacman'), dnf = await find('dnf');
        if (apt) {
          run('sudo', [apt, 'update'], { timeout: 300000 });
          const alsa = run('apt-cache', ['show', 'libasound2t64'], { optional: true, capture: true }).ok ? 'libasound2t64' : 'libasound2';
          run('sudo', [apt, 'install', '-y', 'python3', 'libopus0', alsa], { timeout: 600000 });
        } else if (pacman) run('sudo', [pacman, '-S', '--needed', '--noconfirm', 'python', 'opus', 'alsa-lib'], { timeout: 600000 });
        else if (dnf) run('sudo', [dnf, 'install', '-y', 'python3', 'opus', 'alsa-lib'], { timeout: 600000 });
        else throw new Error('Install Python 3.11+, the Opus runtime and ALSA with your distribution package manager, then rerun setup.');
        python = await find('python3');
        if (!compatiblePython() || !codec()) throw new Error('Python 3.11+, Opus and ALSA are still required; on older distributions upgrade Python before retrying.');
      }
      run(env.LIBERTTY_BASH, [path.join(companion, 'scripts/install-daemon'), path.join(companion, 'daemon')], { timeout: 1800000, env: { ...env, HOME: home } });
      if (!await probe()) throw new Error('The compatible dictation API is not ready; check voxtype.service.');
      results.voxtype = 'ready';
    });
  }
  if (!options['no-tailscale']) await attempt('tailscale', async () => {
    let executable = await find('tailscale');
    if (!executable) {
      if (!await ask('Install Tailscale for private access from your phone?')) return;
      if (platform === 'darwin') {
        run('brew', ['install', '--cask', 'tailscale'], { timeout: 600000 }); run('open', ['-a', 'Tailscale']);
      } else {
        const response = await download('https://tailscale.com/install.sh', { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Tailscale installer download failed.');
        const file = path.join(installed.prefix, 'tailscale-install-' + process.pid + '.sh');
        try { await writeFile(file, await response.text(), { mode: 0o600 }); run('sh', [file], { timeout: 600000 }); }
        finally { await rm(file, { force: true }); }
      }
      executable = await find('tailscale'); if (!executable) throw new Error('Tailscale CLI was not found after installation.');
    }
    if (!await ask('Connect Tailscale and expose libertty privately over HTTPS at ' + env.LIBERTTY_BASE_PATH + (platform === 'linux' ? ' (uses sudo for setup commands)?' : '?'))) return;
    let elevated = false;
    const ts = (args, settings = {}) => run(elevated ? 'sudo' : executable, elevated ? [executable, ...args] : args, settings);
    let status = ts(['status', '--json'], { capture: true, optional: true });
    const parseStatus = value => { try { return JSON.parse(value.stdout); } catch { return undefined; } };
    let state = parseStatus(status);
    if (!state?.BackendState) {
      if (platform === 'darwin') run('open', ['-a', 'Tailscale']);
      if (!await ask('Use sudo for Tailscale setup (the CLI or daemon needs permission)?')) throw new Error('Tailscale status is unavailable.');
      elevated = true;
      if (platform === 'linux') run('sudo', ['systemctl', 'start', 'tailscaled'], { optional: true });
      status = ts(['status', '--json'], { capture: true, optional: true });
      state = parseStatus(status);
    }
    if (!state?.BackendState) throw new Error('Start the Tailscale daemon and retry setup.');
    if (platform === 'linux' && !elevated && process.getuid() !== 0) {
      run('sudo', ['-v'], { timeout: 300000 }); elevated = true;
    }
    if (state.BackendState !== 'Running') { ts(['up'], { timeout: 300000 }); state = JSON.parse(ts(['status', '--json'], { capture: true }).stdout); }
    if (state.BackendState !== 'Running') throw new Error('Finish Tailscale login and rerun the installer.');
    const hostname = state.Self?.DNSName?.replace(/\.$/, '');
    if (!hostname || !/^[a-zA-Z0-9.-]+\.ts\.net$/.test(hostname)) throw new Error('Tailscale did not provide a valid tailnet DNS name.');
    const serve = JSON.parse(ts(['serve', 'status', '--json'], { capture: true }).stdout || '{}');
    if (serve.AllowFunnel?.[hostname + ':443']) throw new Error('This HTTPS listener has Funnel enabled; review public exposure before adding libertty.');
    const upstream = 'http://127.0.0.1:' + env.PORT;
    const route = tailscaleRoute(serve, hostname, env.LIBERTTY_BASE_PATH, upstream);
    const hosts = new Set(env.LIBERTTY_ALLOWED_HOSTS.split(',').filter(Boolean));
    const changed = !hosts.has(hostname); hosts.add(hostname);
    const previous = await readFile(installed.configFile, 'utf8');
    const oldHosts = env.LIBERTTY_ALLOWED_HOSTS;
    const restart = () => {
      if (!installed.service) return;
      if (platform === 'linux') run('systemctl', ['--user', 'restart', 'libertty.service']);
      else run('launchctl', ['kickstart', '-k', 'gui/' + process.getuid() + '/com.libertty.server']);
    };
    try {
      if (changed) {
        env.LIBERTTY_ALLOWED_HOSTS = [...hosts].join(',');
        const temporary = installed.configFile + '.new-' + process.pid;
        await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, installed.configFile);
        restart();
      }
      if (route === 'new') ts(['serve', '--bg', '--https=443', '--set-path=' + env.LIBERTTY_BASE_PATH, upstream], { timeout: 300000 });
      const final = JSON.parse(ts(['serve', 'status', '--json'], { capture: true }).stdout || '{}');
      if (tailscaleRoute(final, hostname, env.LIBERTTY_BASE_PATH, upstream) !== 'existing') throw new Error('Tailscale did not retain the requested route.');
      const url = 'https://' + hostname + (env.LIBERTTY_BASE_PATH === '/' ? '/' : env.LIBERTTY_BASE_PATH + '/');
      if (installed.service) {
        let ready = false;
        for (let i = 0; i < 8; i++) {
          try {
            const response = await download(url + 'healthz', { signal: AbortSignal.timeout(2500) });
            const value = await response.json();
            if (response.ok && value.ok && value.version === installed.metadata.version && value.commit === installed.metadata.commit) { ready = true; break; }
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!ready) throw new Error('libertty did not respond through private HTTPS; check Tailscale DNS and HTTPS permissions.');
      }
      results.tailscale = 'ready'; results.url = url;
    } catch (error) {
      if (route === 'new') {
        try {
          const current = JSON.parse(ts(['serve', 'status', '--json'], { capture: true }).stdout || '{}');
          if (tailscaleRoute(current, hostname, env.LIBERTTY_BASE_PATH, upstream) === 'existing') ts(['serve', '--https=443', '--set-path=' + env.LIBERTTY_BASE_PATH, 'off']);
        } catch (cleanup) { results.failures.push('Tailscale route cleanup: ' + cleanup.message); }
      }
      if (changed) {
        env.LIBERTTY_ALLOWED_HOSTS = oldHosts;
        await writeFile(installed.configFile, previous, { mode: 0o600 });
        try { restart(); } catch (cleanup) { results.failures.push('libertty restart after restoring hosts: ' + cleanup.message); }
      }
      throw error;
    }
    if (results.voxtype === 'ready' && await ask('Also expose Voxtype Mobile at /voxtype for the Android app?')) await attempt('voxtypeRoute', async () => {
      const voiceUrl = new URL(env.LIBERTTY_VOXTYPE_URL || 'ws://127.0.0.1:8765/v1/dictate');
      const voiceUpstream = 'http://' + voiceUrl.host;
      const final = JSON.parse(ts(['serve', 'status', '--json'], { capture: true }).stdout || '{}');
      if (tailscaleRoute(final, hostname, '/voxtype', voiceUpstream) === 'new') ts(['serve', '--bg', '--https=443', '--set-path=/voxtype', voiceUpstream], { timeout: 300000 });
      const voiceFinal = JSON.parse(ts(['serve', 'status', '--json'], { capture: true }).stdout || '{}');
      if (tailscaleRoute(voiceFinal, hostname, '/voxtype', voiceUpstream) !== 'existing') throw new Error('Voxtype route was not retained.');
      console.log('Android dictation address: wss://' + hostname + '/voxtype/v1/dictate');
      console.log('Android dictation token file: ' + (env.LIBERTTY_VOXTYPE_TOKEN_FILE || path.join(env.XDG_DATA_HOME, 'voxtype-mobile/token')));
      results.voxtypeRoute = 'ready';
    });
  });
  return results;
}
