import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const browser = process.env.CHROME_PATH || process.env.CHROMIUM || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath());
const env = { ...process.env, CHROME_PATH: browser, CHROMIUM: browser };
const run = (file, overrides = {}) => execFileSync(process.execPath, [file], { cwd: root, env: { ...env, ...overrides }, stdio: 'inherit' });

// One explicit list is shared by release validation and local pre-commit checks.
run('test/browser.mjs', { TEST_PORT: '3137', TEST_BASE_PATH: '/terminal' });
run('test/reading-browser.mjs', { TEST_BASE_PATH: '/terminal' });
for (const file of [
  'herdr-browser.mjs', 'herdr-loading-browser.mjs', 'plugins-browser.mjs', 'rust-herdr.mjs',
  'pairing-browser.mjs', 'reconnect-browser.mjs', 'herdr-reopen-browser.mjs',
  'tab-scrolling-browser.mjs', 'terminal-gestures-browser.mjs', 'terminal-touch-browser.mjs', 'terminal-selection-browser.mjs', 'dictation-browser.mjs',
  'transfers-browser.mjs', 'files-browser.mjs', 'workspace-browser.mjs',
]) run('test/' + file);

run('scripts/install-test-herdr.mjs');
env.HERDR_BINARY = path.join(root, '.test-artifacts/bin/herdr');
env.PATH = path.dirname(env.HERDR_BINARY) + path.delimiter + process.env.PATH;
for (const file of [
  'herdr-dictation-browser.mjs', 'herdr-reading-browser.mjs', 'herdr-spaces-browser.mjs', 'herdr-resize-native.mjs',
  'herdr-space-flash-native.mjs', 'herdr-app-scroll-native.mjs',
]) run('test/' + file);
run('test/herdr-app-scroll-native.mjs', { TEST_WIRE: 'gzip', TEST_LINK: 'lossy' });
