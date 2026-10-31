import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { launchBrowser, freePort, startBackend, waitForBackend } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'libertty-scroll-'));
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const token = 'scroll-benchmark-pairing-token-123456789';
const server = startBackend({ env: { ...process.env, HOME: fixture, XDG_DATA_HOME: path.join(fixture, 'data'), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), LIBERTTY_TOKEN: token, LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_NO_RC: '1', LIBERTTY_CWD: fixture }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, logs = '';
server.stdout.on('data', data => logs += data);
server.stderr.on('data', data => logs += data);
const samples = [];
const cpuRate = Number(process.env.BENCH_CPU_RATE || 1);
try {
  await waitForBackend(base, server);
  // Headless Chromium otherwise rasterizes and composites canvases in software, unlike phones.
  browser = await launchBrowser(process.env.BENCH_GPU === '1' ? { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl'] } : {});
  for (const [width, height, deviceScaleFactor] of [[390, 844, 2], [1440, 900, 1]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, serviceWorkers: 'block' });
    await context.route(/\/assets\/terminal-[A-Za-z0-9_-]{8}\.js$/, async route => {
      const response = await route.fetch(), original = await response.text();
      const body = original.replace(/new ([\w$]+)\(\{fontSize:/, 'window.__testTerminal=new $1({fontSize:');
      assert.notEqual(body, original);
      await route.fulfill({ response, body });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(base + '/terminal.html');
    await page.locator('#token').fill(token);
    await page.locator('#login-form button').click();
    await page.waitForFunction(() => window.__testTerminal?.wasmTerm && document.querySelector('#connection-label')?.textContent === 'Connected');
    await page.waitForTimeout(500);
    await page.evaluate(async () => {
      const term = window.__testTerminal;
      term.blur();
      term.write(Array.from({ length: 1000 }, (_, i) => `\r\n\x1b[32mROW-${i}\x1b[0m source output alpha beta 界 e\u0301`).join(''));
      term.scrollToLine(20);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const core = term.wasmTerm.core, painter = term.backend.painter;
      const counters = window.__scrollCounters = { coreScrolls: 0, bufferReads: 0, decodedRows: 0, glyphRuns: 0, paints: [] };
      const scroll = core.scrollLines.bind(core), read = core.readBuffer.bind(core);
      core.scrollLines = (...args) => { counters.coreScrolls++; return scroll(...args); };
      core.readBuffer = (...args) => { const result = read(...args); counters.bufferReads++; counters.decodedRows += result.rows.length; return result; };
      const fill = CanvasRenderingContext2D.prototype.fillText, render = painter.render.bind(painter);
      let painting = false;
      CanvasRenderingContext2D.prototype.fillText = function (...args) { if (painting) counters.glyphRuns++; return fill.apply(this, args); };
      painter.render = frame => {
        const start = performance.now();
        painting = true;
        try { return render(frame); }
        finally { painting = false; counters.paints.push(performance.now() - start); }
      };
      window.__scrollRun = async (kind, frames) => {
        term.scrollToLine(20);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        Object.assign(counters, { coreScrolls: 0, bufferReads: 0, decodedRows: 0, glyphRuns: 0, paints: [] });
        const intervals = [];
        let previous;
        for (let i = 1; i <= frames; i++) {
          const now = await new Promise(requestAnimationFrame);
          if (previous !== undefined) intervals.push(now - previous);
          previous = now;
          const step = kind === 'fast' ? 1.25 : .05;
          if (kind === 'live' && i % 12 === 0) term.write(`\r\n\x1b[33mLIVE ${i}\x1b[0m changing output`);
          // Multiple input events can arrive before one browser frame.
          for (let event = 1; event <= 4; event++) term.scrollToLine(20 + (i - 1) * step + step * event / 4);
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)] ?? 0;
        return { ...counters, paints: counters.paints.length, paintMs: counters.paints.reduce((a, b) => a + b, 0), paintP95Ms: percentile(counters.paints, .95), frameP95Ms: percentile(intervals, .95), offset: term.getViewportY() };
      };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await cdp.send('Performance.enable');
    const cpu = async () => (await cdp.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'TaskDuration').value * 1000;
    await page.evaluate(() => window.__scrollRun('slow', 60));
    for (let repeat = 0; repeat < Number(process.env.BENCH_REPEATS || 3); repeat++) {
      for (const kind of ['slow', 'fast', 'live']) {
        const before = await cpu();
        const result = await page.evaluate(kind => window.__scrollRun(kind, 120), kind);
        const sample = { width, height, deviceScaleFactor, cpuRate, gpu: process.env.BENCH_GPU === '1', repeat, kind, ...result, taskMs: await cpu() - before };
        assert.equal(result.offset, kind === 'fast' ? 170 : 26);
        samples.push(sample);
        console.log(JSON.stringify(sample));
      }
    }
    const idle = await page.evaluate(() => window.__scrollCounters.glyphRuns);
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.__scrollCounters.glyphRuns), idle, 'Stationary scrollback must not repaint');
    assert.deepEqual(errors, []);
    await context.close();
  }
  await mkdir('.test-artifacts', { recursive: true });
  const report = { description: 'Real Chromium terminal rendering with four scroll requests per frame; timings include instrumentation and are not device energy measurements.', samples };
  await writeFile(process.env.BENCH_REPORT || '.test-artifacts/terminal-scroll.json', JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  await rm(fixture, { recursive: true, force: true });
}
