import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const browser = process.env.CHROME_PATH || process.env.CHROMIUM || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
const env = { ...process.env, CHROME_PATH: browser, CHROMIUM: browser };
// Each harness owns its ports, servers and browser, so a few can run at once without sharing state.
const jobs = Math.max(1, Number.parseInt(process.env.BROWSER_JOBS || '', 10) || 3);

execFileSync(process.execPath, ['scripts/install-test-herdr.mjs'], { cwd: root, env, stdio: 'inherit' });
const herdrBinary = path.join(root, '.test-artifacts/bin/herdr');
const herdr = { HERDR_BINARY: herdrBinary, PATH: path.dirname(herdrBinary) + path.delimiter + process.env.PATH };

// One explicit list is shared by release validation and local pre-commit checks.
const harnesses = [
  ['browser.mjs', { TEST_PORT: '3137', TEST_BASE_PATH: '/terminal' }],
  ['reading-browser.mjs', { TEST_BASE_PATH: '/terminal' }],
  ...['herdr-browser.mjs', 'herdr-loading-browser.mjs', 'plugins-browser.mjs', 'rust-herdr.mjs',
    'pairing-browser.mjs', 'reconnect-browser.mjs', 'herdr-reopen-browser.mjs',
    'tab-scrolling-browser.mjs', 'terminal-gestures-browser.mjs', 'terminal-touch-browser.mjs', 'terminal-selection-browser.mjs', 'dictation-browser.mjs',
    'transfers-browser.mjs', 'files-browser.mjs', 'workspace-browser.mjs'].map(file => [file, {}]),
  ...['herdr-dictation-browser.mjs', 'herdr-reading-browser.mjs', 'herdr-spaces-browser.mjs', 'herdr-resize-native.mjs',
    'herdr-space-flash-native.mjs', 'herdr-app-scroll-native.mjs'].map(file => [file, herdr]),
  ['herdr-app-scroll-native.mjs', { ...herdr, TEST_WIRE: 'gzip', TEST_LINK: 'lossy' }],
];

// Buffer each harness so parallel output stays readable, and report every failure instead of stopping at the first.
function run([file, overrides]) {
  return new Promise(resolve => {
    const start = performance.now(), output = [];
    const child = spawn(process.execPath, ['test/' + file], { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
    child.on('close', (code, signal) => {
      const seconds = ((performance.now() - start) / 1000).toFixed(1);
      process.stdout.write(Buffer.concat(output));
      console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${file} (${seconds}s${signal ? ', ' + signal : ''})`);
      resolve(code === 0 ? undefined : file);
    });
  });
}
const queue = [...harnesses], failures = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let harness = queue.shift(); harness; harness = queue.shift()) {
    const failure = await run(harness);
    if (failure) failures.push(failure);
  }
}));
if (failures.length) {
  console.error('Browser harnesses failed: ' + failures.join(', '));
  process.exit(1);
}
