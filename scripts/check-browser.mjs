import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserShard } from './browser-shards.mjs';
import { browserSummary, retryHarness } from './browser-results.mjs';
import { expandBrowserCases, expandBrowserNames } from './browser-groups.mjs';
import { browserPortRange } from './browser-ports.mjs';

const root = path.resolve(import.meta.dirname, '..');
const browser = process.env.CHROME_PATH || process.env.CHROMIUM || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
const env = { ...process.env, CHROME_PATH: browser, CHROMIUM: browser };
// Each harness owns its ports, servers and browser, so a few can run at once without sharing state.
const jobs = Math.max(1, Number.parseInt(process.env.BROWSER_JOBS || '', 10) || 3);
const repeats = Number(process.env.BROWSER_REPEAT || 1);
const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 480000);
const retries = Number(process.env.BROWSER_RETRIES || 0);
if (![0, 1].includes(retries)) throw new Error('BROWSER_RETRIES must be 0 or 1.');
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('BROWSER_REPEAT must be a positive integer.');
if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('BROWSER_TIMEOUT_MS must be a positive integer.');

execFileSync(process.execPath, ['scripts/install-test-herdr.mjs'], { cwd: root, env, stdio: 'inherit' });
const herdrBinary = path.join(root, '.test-artifacts/bin/herdr');
const herdr = { HERDR_BINARY: herdrBinary, PATH: path.dirname(herdrBinary) + path.delimiter + process.env.PATH };

// One explicit list is shared by release validation and local pre-commit checks.
const harnesses = expandBrowserCases([
  ['browser.mjs', { TEST_BASE_PATH: '/terminal' }],
  ['reading-browser.mjs', { TEST_BASE_PATH: '/terminal' }],
  ...['herdr-browser.mjs', 'herdr-loading-browser.mjs', 'plugins-browser.mjs', 'rust-herdr.mjs',
    'pairing-browser.mjs', 'reconnect-browser.mjs', 'herdr-reopen-browser.mjs',
    'tab-scrolling-browser.mjs', 'terminal-gestures-browser.mjs', 'terminal-touch-browser.mjs', 'terminal-selection-browser.mjs', 'dictation-browser.mjs',
    'transfers-browser.mjs', 'files-browser.mjs', 'workspace-browser.mjs'].map(file => [file, {}]),
  ...['herdr-dictation-browser.mjs', 'herdr-reading-browser.mjs', 'herdr-spaces-browser.mjs', 'herdr-resize-native.mjs',
    'herdr-space-flash-native.mjs'].map(file => [file, herdr]),
  ['herdr-app-scroll-native.mjs', { ...herdr, TEST_WIRE: 'gzip', TEST_LINK: 'lossy' }],
]);
const durations = {
  'dictation-availability-browser.mjs': 39,
  'dictation-capture-browser.mjs': 23,
  'dictation-program-browser.mjs': 12,
  'files-browser.mjs': 12,
  'herdr-app-scroll-native.mjs': 25,
  'herdr-dictation-browser.mjs': 14,
  'herdr-interaction-browser.mjs': 13,
  'herdr-loading-browser.mjs': 8,
  'herdr-navigation-browser.mjs': 17,
  'herdr-reading-browser.mjs': 17,
  'herdr-reopen-browser.mjs': 4,
  'herdr-resize-native.mjs': 5,
  'herdr-space-flash-native.mjs': 12,
  'herdr-spaces-browser.mjs': 41,
  'herdr-transport-browser.mjs': 27,
  'pairing-browser.mjs': 5,
  'plugins-browser.mjs': 11,
  'reading-browser.mjs': 9,
  'reconnect-herdr-browser.mjs': 28,
  'reconnect-native-browser.mjs': 36,
  'rust-herdr.mjs': 2,
  'tab-scrolling-browser.mjs': 6,
  'terminal-gestures-browser.mjs': 16,
  'terminal-input-browser.mjs': 16,
  'terminal-layout-browser.mjs': 10,
  'terminal-repair-browser.mjs': 12,
  'terminal-selection-browser.mjs': 9,
  'terminal-touch-browser.mjs': 4,
  'transfers-browser.mjs': 6,
  'workspace-core-browser.mjs': 12,
  'workspace-ssh-browser.mjs': 25,
  'workspace-vault-browser.mjs': 23,
};
const sharded = browserShard(harnesses.map(([file, overrides]) => [file, overrides, durations[file] || 20]), process.env.BROWSER_SHARD);
const selected = expandBrowserNames(process.env.BROWSER_HARNESSES?.split(','));
if (selected?.some(file => !harnesses.some(([name]) => name === file))) throw new Error('Unknown BROWSER_HARNESSES entry.');
const cases = sharded.filter(([file]) => !selected || selected.includes(file));

// Buffer each harness so parallel output stays readable, and report every failure instead of stopping at the first.
async function run({ file, overrides, iteration, attempt, ports }) {
  const parent = path.join(root, '.test-artifacts/browser');
  await mkdir(parent, { recursive: true });
  const diagnostics = await mkdtemp(path.join(parent, path.basename(file, '.mjs') + '-'));
  return new Promise(resolve => {
    const start = performance.now(), output = [];
    const child = spawn(process.execPath, ['test/' + file], { cwd: root, env: { ...env, ...overrides, TEST_PORT_RANGE: ports, TEST_DIAGNOSTICS_DIR: diagnostics }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false, killTimer;
    const kill = signal => {
      try { if (process.platform === 'win32') child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') output.push(Buffer.from(String(error))); }
    };
    const timer = setTimeout(() => {
      timedOut = true; output.push(Buffer.from(`Harness exceeded ${timeout}ms.\n`));
      kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 5000);
    }, timeout);
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
    child.on('error', error => output.push(Buffer.from(error.stack || String(error))));
    child.on('close', async (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      const passed = code === 0 && !timedOut;
      const seconds = Number(((performance.now() - start) / 1000).toFixed(1));
      process.stdout.write(Buffer.concat(output));
      console.log(`${passed ? 'PASS' : 'FAIL'} ${file} (${seconds}s, iteration ${iteration}/${repeats}, attempt ${attempt}${signal ? ', ' + signal : ''})`);
      try {
        if (passed) await rm(diagnostics, { recursive: true, force: true });
        else {
          await writeFile(path.join(diagnostics, 'runner.log'), Buffer.concat(output));
          await writeFile(path.join(diagnostics, 'result.json'), JSON.stringify({ file, code, signal, seconds, overrides, ports, iteration, jobs, timedOut, shellDelay: env.TEST_SHELL_DELAY_MS, gestureDelay: env.TEST_GESTURE_DELAY_MS }, null, 2) + '\n');
          console.error('Browser diagnostics: ' + path.relative(root, diagnostics));
        }
        resolve({ passed, code, signal, seconds, timedOut, diagnostics: passed ? undefined : path.relative(root, diagnostics) });
      } catch (error) { console.error(error); resolve({ passed: false, seconds, error: String(error) }); }
    });
  });
}
const queue = Array.from({ length: repeats }, (_, index) => cases.map(([file, overrides]) => ({ file, overrides, iteration: index + 1 }))).flat(), results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async (_, worker) => {
  const ports = browserPortRange(worker);
  for (let harness = queue.shift(); harness; harness = queue.shift()) {
    const result = await retryHarness(attempt => run({ ...harness, attempt, ports }), retries);
    results.push({ ...result, file: harness.file, variant: harness.overrides.TEST_WIRE, shard: process.env.BROWSER_SHARD || 'all', iteration: harness.iteration, jobs });
    if (result.status === 'flaky') console.warn(`::warning::Flaky browser harness: ${harness.file} passed on retry.`);
  }
}));
results.sort((a, b) => a.file.localeCompare(b.file) || a.iteration - b.iteration);
const report = path.join(root, '.test-artifacts', 'browser-results-' + (process.env.BROWSER_SHARD || 'all').replace('/', '-') + '-workers-' + jobs);
await writeFile(report + '.json', JSON.stringify(results, null, 2) + '\n');
const summary = browserSummary(results);
await writeFile(report + '.md', summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
const failures = results.filter(result => result.status === 'fail').map(result => result.file + '#' + result.iteration);
if (failures.length) {
  console.error('Browser harnesses failed: ' + failures.join(', '));
  process.exit(1);
}
