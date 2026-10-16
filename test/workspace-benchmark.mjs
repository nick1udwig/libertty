import { installWireObserver } from './wire-observer.mjs';
// Local Chromium comparison: initial/reload readiness and input-to-renderer-drain latency.
// No injected network delay or CPU throttling; not a phone performance guarantee.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), temp = await mkdtemp('/tmp/libertty-ui-bench-');
const baseline = process.env.BENCH_BEFORE || '2a99127', rounds = Number(process.env.BENCH_REPEATS || 9);
const processes = [], rows = [];
let browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
try {
  const before = temp + '/before'; await mkdir(before);
  execFileSync('tar', ['-x', '-C', before], { input: execFileSync('git', ['archive', baseline], { cwd: root, maxBuffer: 16 * 1024 * 1024 }) });
  await symlink(root + '/node_modules', before + '/node_modules');
  execFileSync('npm', ['run', 'build'], { cwd: before, stdio: 'pipe' });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--use-gl=angle', '--use-angle=gl'] });
  const variants = [...['server', 'client'].map(engine => ({ engine, name: 'before', cwd: before })), { engine: 'server', name: 'workspace', cwd: root }];
  if (process.env.BENCH_REVERSE === '1') variants.reverse();
  let port = 3163;
  for (const variant of variants) {
    port++; const fixture = temp + '/' + variant.engine + '-' + variant.name; await mkdir(fixture);
    const origin = 'http://127.0.0.1:' + port;
    // Historical comparisons run the archived release; the working tree uses Rust.
    const reference = variant.name === 'before';
    const proc = spawn(reference ? process.execPath : path.join(variant.cwd,'target/debug/libertty'), reference ? ['server/index.ts'] : [], { cwd: variant.cwd, env: { ...process.env, HOME: fixture, NODE_ENV: 'production', ...(reference ? { TERMAI_ENGINE: variant.engine } : {}), HOST: '127.0.0.1', PORT: String(port), ...Object.fromEntries(Object.entries({ BASE_PATH: '', ALLOWED_HOSTS: '127.0.0.1', TOKEN: 'benchmark-pairing-token-123456789', NO_RC: '1', CWD: fixture, DATA_DIR: fixture + '/vault', HISTORY_FILE: fixture + '/history', ETERNAL_HISTORY_FILE: fixture + '/history' }).map(([name, value]) => [(reference ? 'TERMAI_' : 'LIBERTTY_') + name, value])) }, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(proc);
    let logs = ''; proc.stdout.on('data', chunk => logs += chunk); proc.stderr.on('data', chunk => logs += chunk);
    for (let i = 0; ; i++) { if (await fetch(origin).then(r => r.ok).catch(() => false)) break; if (i >= 150 || proc.exitCode !== null) throw new Error(logs); await delay(40); }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await installWireObserver(context);
  await context.addInitScript(() => {
      window.__submit = []; window.__submitBegan = 0; window.__echo = []; window.__began = 0; window.__sequence = 0;
      const Original = WebSocket;
      window.WebSocket = class extends Original {
        constructor(...args) { super(...args); this.addEventListener('message', async event => {
          const m = await window.__wireMessage(event.data, this);
          if (m.type === 'state' && m.state.ready && window.__submitBegan) { window.__submit.push(performance.now() - window.__submitBegan); window.__submitBegan = 0; }
          if (m.type === 'state' && m.state.ready && !window.__readyScheduled) { window.__readyScheduled = true; requestAnimationFrame(() => requestAnimationFrame(() => window.__readyAt = performance.timeOrigin + performance.now())); }
          if (m.type === 'output' && window.__began && m.data.includes('x')) window.__sequence = m.seq;
        }); }
        send(raw) { const m = window.__wireSent(raw);
          if (m.type === 'input' && m.data === '\r') window.__submitBegan = performance.now();
          if (m.type === 'input' && m.data === 'x') { window.__began = performance.now(); window.__sequence = 0; }
          if (m.type === 'ack' && window.__sequence && m.seq >= window.__sequence) { window.__echo.push(performance.now() - window.__began); window.__began = window.__sequence = 0; }
          super.send(raw);
        }
      };
    });
    // Pair before measuring terminal startup so human token entry is excluded.
    const pairing = await context.request.post(origin + '/api/connect', { headers: { Origin: origin }, data: { token: 'benchmark-pairing-token-123456789', noSession: true } });
    if (!pairing.ok()) throw new Error('Benchmark pairing failed: ' + pairing.status());
    const page = await context.newPage(), starts = [];
    let frame;
    for (let i = 0; i <= rounds; i++) {
      await page.goto(origin);
      frame = variant.name === 'workspace' || process.env.BENCH_BEFORE_WORKSPACE === '1' ? await (await page.locator('#terminal-stack iframe:visible').elementHandle()).contentFrame() : page.mainFrame();
      await frame.waitForFunction(() => window.__readyAt);
      const start = await page.evaluate(() => performance.timeOrigin), end = await frame.evaluate(() => window.__readyAt); starts.push(end - start);
    }
    await frame.locator('#terminal textarea').focus();
    for (let i = 0; i < 51; i++) { await page.keyboard.type('x'); await frame.waitForFunction(count => window.__echo.length >= count, i + 1); }
    const echoes = await frame.evaluate(() => window.__echo.slice(1));
    await page.keyboard.press('Control+u');
    for (let i = 0; i < 101; i++) { await page.keyboard.type(':'); await page.keyboard.press('Enter'); await frame.waitForFunction(count => window.__submit.length >= count, i + 1); }
    const submits = await frame.evaluate(() => window.__submit.slice(1));
    const row = { submitMedianMs: median(submits), submitSamplesMs: submits, variant: variant.name, engine: variant.engine, coldReadyMs: starts[0], reloadMedianMs: median(starts.slice(1)), echoMedianMs: median(echoes), reloadSamplesMs: starts.slice(1), echoSamplesMs: echoes };
    rows.push(row); console.log(JSON.stringify(row));
    await context.close(); proc.kill('SIGTERM'); await delay(300);
  }
  await writeFile(process.env.BENCH_OUTPUT || root + '/.test-artifacts/workspace-ui-benchmark.json', JSON.stringify({ baseline, rounds, rows }, null, 2));
} finally { await browser?.close(); for (const proc of processes) if (proc.exitCode === null) proc.kill('SIGKILL'); await rm(temp, { recursive: true, force: true }); }
