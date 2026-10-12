import { writeFile } from 'node:fs/promises';
import { Discovery } from '../src/engine/discovery.ts';

const catalog = { cwd: '/fixture', commands: ['git', 'ls', 'echo', 'orchard'], paths: [], history: [
  'git status', 'git add .', 'echo harmless', 'git commit -m "literal argument"',
  'orchard workspace reconcile target VALUE', 'git $(never run)', '_helper internal', 'missing command',
] };
const env = { HOME: '/fixture', PATH: '/fixture/bin:/usr/bin:/bin' };
const discovery = new Discovery();
let clock = 0, calls = [];
discovery.discover = async target => { calls.push(target); return { metadata: { flags: {}, subcommands: {}, requiredPositionals: {} } }; };
const originalNow = Date.now;
Date.now = () => clock;
const steps = [];
try {
  for (const [nextCatalog, nextEnv, now] of [
    [catalog, env, 0],
    [catalog, { ...env, PWD: '/other', SHLVL: '9', TERMAI_TOKEN: 'synthetic-only' }, 10],
    [{ ...catalog, cwd: '/fixture/subdirectory' }, env, 20],
    [catalog, { ...env, PATH: '/fixture/other-bin' }, 30],
    [catalog, env, 600001],
    [{ ...catalog, commands: ['echo'], history: Array.from({ length: 210 }, (_, index) => 'echo item' + index) }, env, 600002],
  ]) {
    clock = now; calls = [];
    await discovery.prewarm(nextCatalog, nextEnv);
    steps.push({ operation: 'prewarmTargets', args: [nextCatalog, nextEnv], now, expected: [...calls] });
    for (const target of calls) steps.push({ operation: 'markWarmed', args: [target, nextCatalog, nextEnv], now, expected: null });
  }
} finally { Date.now = originalNow; discovery.dispose(); }
await writeFile(new URL('../test/fixtures/rust-migration/prewarm.json', import.meta.url), JSON.stringify({ version: 1, reference: '455386bc9443e778f381e1eeaf37cec5a35c2f75', steps }, null, 2) + '\n');
console.log('Captured ' + steps.length + ' prewarm steps from the unchanged TypeScript cache.');
