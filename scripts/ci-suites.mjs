import { execFileSync, spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
export const suites = {
  terminal: [['test/browser.mjs', { TEST_ENGINE: 'server', TEST_PORT: '3137' }], ['test/browser.mjs', { TEST_ENGINE: 'client', TEST_PORT: '3138', TEST_BASE_PATH: '/terminal' }]],
  reading: [['test/reading-browser.mjs', { TEST_BASE_PATH: '/terminal' }]],
  herdr: [['test/herdr-browser.mjs'], ['test/herdr-loading-browser.mjs'], ['test/rust-herdr.mjs']],
  'herdr-native': [['test/herdr-spaces-browser.mjs'], ['test/herdr-resize-native.mjs'], ['test/herdr-space-flash-native.mjs'], ['test/herdr-app-scroll-native.mjs']],
  plugins: [['test/plugins-browser.mjs']],
  reconnect: [['test/reconnect-browser.mjs'], ['test/herdr-reopen-browser.mjs']],
  gestures: [['test/terminal-gestures-browser.mjs'], ['test/terminal-touch-browser.mjs']],
  dictation: [['test/dictation-browser.mjs'], ['test/herdr-dictation-browser.mjs']],
  files: [['test/transfers-browser.mjs'], ['test/files-browser.mjs']],
  workspace: [['test/workspace-browser.mjs']],
};
const all = Object.keys(suites);
const rules = [
  [/^src\/(?:dictation|voxtype|paste-mode)|^crates\/server\/(?:src|tests)\/(?:dictation|paste_mode)/, ['dictation', 'herdr']],
  [/^src\/herdr|^crates\/server\/(?:src|tests)\/herdr/, ['herdr', 'herdr-native', 'plugins', 'reconnect', 'dictation', 'workspace']],
  [/^src\/(?:plugin|tab-gestures)|^examples\/plugins\/|^crates\/server\/(?:src|tests)\/plugin_file/, ['plugins', 'herdr', 'workspace']],
  [/^src\/reconnecting-socket/, ['reconnect', 'terminal', 'herdr']],
  [/^src\/terminal-(?:gestures|focus|links|selection|touch|viewport)/, ['gestures', 'terminal', 'herdr-native']],
  [/^src\/terminal-projection/, ['herdr', 'herdr-native']],
  [/^src\/(?:file|transfer|image-upload)|^crates\/server\/(?:src|tests)\/(?:files|transfers)/, ['files', 'workspace', 'herdr']],
  [/^src\/reading|^crates\/server\/(?:src|tests)\/reading/, ['reading', 'dictation']],
  [/^src\/(?:workspace|hosts|settings|notifications|push|service-worker|vault)|^crates\/server\/(?:src|tests)\/(?:notifications|vault|storage|history)/, ['workspace', 'herdr', 'plugins']],
  [/^crates\/server\/(?:src|tests)\/(?:ssh|system_ssh|pairing)/, ['terminal', 'files', 'workspace', 'herdr', 'plugins', 'reconnect']],
];

export function selectSuites(files) {
  if (files === null) return { suites: [...all], state: true };
  const selected = new Set();
  let state = false;
  for (const file of files) {
    if (/^(?:docs\/|[^/]+\.md$|LICENSE$|contracts\/regression-inventory\.json$)/.test(file)) continue;
    if (/^(?:test\/(?:architecture-|rust-architecture-adapter)|\.github\/workflows\/performance\.yml$)/.test(file)) continue;
    if (/^test\/.*\.test\.(?:ts|mjs)$/.test(file)) continue;
    if (/^test\/rust-state-compat\.mjs$/.test(file)) { state = true; continue; }
    const owners = all.filter(suite => suites[suite].some(([harness]) => harness === file));
    if (owners.length) { for (const owner of owners) selected.add(owner); continue; }
    if (/^crates\/server\/(?:src|tests)\/(?:vault|storage|history|pairing|ssh)\b/.test(file)) state = true;
    const matching = rules.filter(([pattern]) => pattern.test(file));
    if (matching.length) {
      for (const [, owners] of matching) for (const owner of owners) selected.add(owner);
    } else {
      // Unknown or shared inputs must expand coverage rather than silently skip it.
      for (const suite of all) selected.add(suite);
      state = true;
    }
  }
  return { suites: all.filter(suite => selected.has(suite)), state };
}

export function changedFiles(event, directory = root) {
  const base = event.pull_request?.base?.sha || event.before;
  if (!/^[a-f0-9]{40,64}$/.test(base || '') || /^0+$/.test(base)) return null;
  try {
    execFileSync('git', ['cat-file', '-e', base + '^{commit}'], { cwd: directory, stdio: 'ignore' });
    const range = base + (event.pull_request ? '...HEAD' : '..HEAD');
    return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', range], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch { return null; }
}

async function run(file, env = {}) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(file + ' failed: ' + (signal || code))));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const suite = process.argv[2];
  if (suite) {
    if (!Object.hasOwn(suites, suite)) throw new Error('Unknown CI suite: ' + suite);
    const env = {};
    if (['herdr-native', 'dictation'].includes(suite)) {
      await run('scripts/install-test-herdr.mjs');
      env.HERDR_BINARY = path.join(root, '.test-artifacts/bin/herdr');
      env.PATH = path.dirname(env.HERDR_BINARY) + path.delimiter + process.env.PATH;
    }
    for (const [file, overrides] of suites[suite]) await run(file, { ...env, ...overrides });
  } else {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const selection = selectSuites(changedFiles(event));
    console.log(JSON.stringify(selection));
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      `suites=${JSON.stringify(selection.suites)}\nintegration=${selection.suites.length > 0}\nstate=${selection.state}\n`);
  }
}
