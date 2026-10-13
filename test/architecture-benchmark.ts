/** Four-way engine comparison using real host facts and a JSON transport with injected RTT.
 * Idle pushes are measured separately from foreground time; this is not a phone CPU profile. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { compoundRepairRecommended } from '../src/compound-repair.ts';
import { rustArchitectureAdapter } from './rust-architecture-adapter.mjs';
import { latencyStatistics, latencyRegressed, type LatencyStatistics } from './architecture-stats.ts';
import type { Catalog } from '../src/protocol.ts';

const shared = process.env.BENCH_SUITE === 'shared';
const variants = [
  { name: 'master before', ref: process.env.BENCH_BEFORE_MASTER || '0e0646c', client: false, optimized: true },
  { name: 'master after', ref: process.env.BENCH_AFTER || '.', client: false, optimized: true },
  { name: 'experiment before', ref: process.env.BENCH_BEFORE_CLIENT || '0e0646c', client: true, optimized: true },
  { name: 'experiment after', ref: process.env.BENCH_AFTER || '.', client: true, optimized: true },
];
const rtts = (process.env.BENCH_RTT || '0,50,150').split(',').map(Number);
const repeats = Number(process.env.BENCH_REPEATS || 3);
// Sub-millisecond CPU medians need more samples than the injected-RTT cases.
const cpuRepeats = Number(process.env.BENCH_CPU_REPEATS || 31);
const coldRepeats = Number(process.env.BENCH_COLD_REPEATS || repeats);
if (!Number.isInteger(coldRepeats) || coldRepeats < 1) throw new Error('Cold repeats must be a positive integer.');
const temp = await mkdtemp(path.join(os.tmpdir(), 'termai-architecture-'));
const cwd = path.join(temp, 'fixture');
const delay = (ms: number) => ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounded = (value: number) => +value.toFixed(2);
const cases = [
  ['history', 'Get in it.'], ['schema', 'Git commit -m "exact message"'], ['flags', 'LSL'],
  ['python', 'Python three hello world dot py myarg food'], ['nested help', 'Orchard work space recon cile target VALUE'],
  ['directory', 'Cd ~ fas get fas pebble agent'], ['exact directory', 'cd git/pebble-agent'],
  ['large directory', 'cd big/wor kspace'], ['referenced file', 'cat ~/docs/my notes dot txt'],
] as const;
const selectedCases = process.env.BENCH_CASES?.split(',');
if (selectedCases?.some(name => !cases.some(([label]) => label === name))) throw new Error('Unknown benchmark case.');
const rows: { variant: string; case: string; rtt: number; coldMs: number; warmMs: number; coldRequests: number; warmRequests: number; [key: string]: unknown }[] = [];
const measurements = new WeakMap<object, { cold: number; warm: LatencyStatistics }>();
let comparisons = 0;
const rustPeers: (Awaited<ReturnType<typeof rustArchitectureAdapter>> | undefined)[] = [];
try {
  await mkdir(cwd);
  await mkdir(path.join(cwd, 'git', 'pebble-agent'), { recursive: true });
  await mkdir(path.join(cwd, 'docs'));
  await mkdir(path.join(cwd, 'big', 'workspace'), { recursive: true });
  for (let start = 0; start < 2000; start += 50) await Promise.all(Array.from({ length: 50 }, (_, i) => writeFile(path.join(cwd, 'big', `artifact${start + i}.txt`), '')));
  await writeFile(path.join(cwd, 'docs', 'My Notes.txt'), 'notes');
  await writeFile(path.join(cwd, 'hello_world.py'), "import argparse\np=argparse.ArgumentParser()\np.add_argument('--myarg')\n");
  await writeFile(path.join(cwd, 'orchard'), `#!/bin/sh
case "$*" in
 '--help') printf 'Commands:\\n  workspace    Workspaces\\n';;
 'workspace --help') printf 'Commands:\\n  reconcile    Reconcile workspace\\n';;
 'workspace reconcile --help') printf '  --target NAME  Destination\\n';;
 *) exit 1;;
esac
`, { mode: 0o700 });
  const catalog: Catalog = { cwd, commands: ['git', 'ls', 'cd', 'cat', 'echo', 'python3', 'orchard', ...Array.from({ length: 3000 }, (_, i) => `program${i}`)],
    paths: ['hello_world.py', 'docs/', 'git/', 'big/'], history: [...Array.from({ length: 4999 }, (_, i) => `program${i % 3000} argument${i}`), 'git init'] };
  const env = { HOME: cwd, PATH: cwd + ':/usr/bin:/bin' };
  const loaded = [];
  for (const variant of variants) {
    const root = path.join(temp, variant.name.replaceAll(' ', '-')); await mkdir(root);
    const revision = variant.ref === '.' ? 'working tree' : execFileSync('git', ['rev-parse', variant.ref], { encoding: 'utf8' }).trim();
    if (variant.ref === '.') {
      for (const name of ['src', 'package.json']) await cp(new URL('../' + name, import.meta.url), path.join(root, name), { recursive: true });
    } else {
      const archive = execFileSync('git', ['archive', revision, 'server', 'src', 'package.json'], { maxBuffer: 10 * 1024 * 1024 });
      execFileSync('tar', ['-x', '-C', root], { input: archive });
    }
    const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
    // Archived reference revisions remain available from Git for comparisons.
    // The working tree runs exclusively through native Rust and its Wasm build.
    const rust = variant.ref === '.';
    const engine = rust ? undefined : await load(variant.client ? 'src/engine/suggestions.ts' : 'server/suggestions.ts');
    const discovery = rust ? undefined : await load(variant.client ? 'src/engine/discovery.ts' : 'server/discovery.ts');
    const modules = variant.client ? {
      ...await load('src/remote-host.ts'), ...await load('src/directory-cache.ts'),
      ...(rust ? await load('src/engine/wasm.ts') : { ...await load('server/facts.ts'), ...await load('server/help.ts'), ...await load('server/directories.ts'), ...await load('src/engine/path-repair.ts') }),
    } : {};
    loaded.push({ ...variant, revision, engine, discovery, modules, rust });
  }
  if (process.env.BENCH_REVERSE === '1') loaded.reverse();
  for (const variant of loaded) {
    const adapter = variant.rust ? await rustArchitectureAdapter(catalog, env, variant.client, variant.modules.WasmEngine) : undefined;
    rustPeers.push(adapter);
    Object.assign(variant, { adapter });
  }
  for (const rtt of rtts) for (const [name, text] of cases.filter(([name]) => !selectedCases || selectedCases.includes(name))) {
    const warmRepeats = rtt === 0 ? Math.max(repeats, cpuRepeats) : repeats;
    let expected: unknown;
    for (const variant of loaded) {
      const coldTimes: number[] = [], coldCounts: number[] = [], coldSizes: number[] = [];
      // Recreate application caches for each cold trial; report the first call separately.
      for (let coldTrial = 0; coldTrial < coldRepeats; coldTrial++) {
        const m = variant.modules;
        const rust = (variant as typeof variant & { adapter?: Awaited<ReturnType<typeof rustArchitectureAdapter>> }).adapter;
        await rust?.reset();
        const help = variant.client && !rust ? new m.HelpProvider() : undefined;
        const source = { state: { cwd, prompt: 1, ready: true, exited: false }, catalog: async (includePaths = true) => includePaths ? catalog : { ...catalog, paths: [] }, environment: async () => env, help };
        const facts = variant.client ? rust || new m.Facts(source) : undefined;
        const cache = variant.client ? new m.ContextCache() : undefined;
        const syntax = new Map<string, boolean>(), directories = variant.client && variant.optimized ? new m.DirectoryCache() : undefined;
        let host: any, requests = 0, bytes = 0, hostMs = 0, pushKey: string | undefined, pushDirectoryVersion: string | undefined;
        const discovery = rust ? { dispose() {} } : variant.client ? new variant.discovery!.Discovery({ help: (command: string, route: string[]) => host.help(command, route), describe: (command: string) => host.describe(command) }) : new variant.discovery!.Discovery();
        const transport = async (body: any, signal: AbortSignal) => {
          requests++; bytes += Buffer.byteLength(JSON.stringify(body));
          await delay(rtt / 2);
          const start = performance.now();
          const result = body.kind === 'context' ? await facts.context(body.known, body.paths !== false) : await facts.read(body.key, body.operations, signal);
          hostMs += performance.now() - start;
          const wire = JSON.stringify(result); bytes += Buffer.byteLength(wire);
          await delay(rtt / 2); return JSON.parse(wire);
        };
        const times: number[] = [], counts: number[] = [], sizes: number[] = [], hostTimes: number[] = [], idleBytes: number[] = [], idleTimes: number[] = [];
        const nativeEngineTimes: number[] = [];
        let nativeDelegated = false;
        try {
          for (let i = 0; i <= (coldTrial === coldRepeats - 1 ? warmRepeats : 0); i++) {
            // Model an already delivered periodic idle push for warm optimized-client trials.
            // Both its host time and wire bytes are recorded outside the foreground interval.
            if (i && variant.client && variant.optimized) {
              const start = performance.now();
              const context = await facts.context(pushKey, false); pushKey = context.catalogKey;
              const snapshot = rust ? await rust.directory(cwd) : await m.directorySnapshot(cwd, 10000);
              const prefetch = snapshot.version === pushDirectoryVersion ? [] : [{ path: cwd, snapshot }]; pushDirectoryVersion = snapshot.version;
              const wire = JSON.stringify({ context, directories: prefetch });
              idleBytes.push(Buffer.byteLength(wire));
              const pushed = JSON.parse(wire); cache.accept(pushed.context);
              for (const entry of pushed.directories) directories.remember(entry.path, entry.snapshot);
              idleTimes.push(performance.now() - start);
            }
            requests = bytes = hostMs = 0;
            const begin = performance.now(), signal = AbortSignal.timeout(5000);
            let actual;
            if (!variant.client) {
              requests = 1; await delay(rtt / 2);
              const start = performance.now();
              if (rust) {
                const reply = await rust.native(text, signal); actual = reply.candidates; nativeEngineTimes.push(reply.elapsedMs);
              } else actual = await variant.engine!.suggest(text, catalog, env, discovery, undefined, signal);
              hostMs = performance.now() - start;
              bytes = Buffer.byteLength(JSON.stringify({ text })) + Buffer.byteLength(JSON.stringify({ candidates: actual }));
              await delay(rtt / 2);
            } else {
              const includePaths = !(rust && compoundRepairRecommended(text, { compoundRepair: true } as any)) && (!variant.optimized || !(rust ? rust.directoryInput(text) : m.directoryInput(text)));
              const snapshot = await cache.get(transport, signal, includePaths, variant.optimized ? 1 : undefined);
              if (rust && compoundRepairRecommended(text, snapshot)) {
                nativeDelegated = true;
                requests++; bytes += Buffer.byteLength(JSON.stringify({ kind: 'repair', key: snapshot.key, catalogKey: snapshot.catalogKey, text }));
                await delay(rtt / 2); const start = performance.now();
                actual = await rust.repair(text,snapshot,signal); hostMs += performance.now()-start;
                bytes += Buffer.byteLength(JSON.stringify(actual)); await delay(rtt / 2);
              } else for (let attempt = 0; ; attempt++) {
                host = new m.RemoteHost(transport, snapshot, signal, syntax, directories);
                try {
                  const requestHost = host;
                  const metadata = (discovery as any).forHost ? (discovery as any).forHost({ help: (command: string, route: string[]) => requestHost.help(command, route), describe: (command: string) => requestHost.describe(command) }) : discovery;
                  actual = rust ? await rust.suggest(text, snapshot, host, signal) : await variant.engine!.suggest(text, snapshot.catalog, { HOME: snapshot.home, HOST_CONTEXT: snapshot.discoveryKey }, metadata, host, undefined, signal);
                  if (variant.optimized) await host.verify();
                  break;
                } catch (error) { if (!variant.optimized || !(error instanceof m.DirectoryChanged) || attempt >= 2) throw error; }
              }
            }
            times.push(performance.now() - begin); counts.push(requests); sizes.push(bytes); hostTimes.push(hostMs);
            if (expected === undefined) expected = actual;
            assert.deepEqual(actual, expected, `${variant.name}: ${name}, RTT=${rtt}, iteration=${i}`); comparisons++;
          }
          coldTimes.push(times[0]); coldCounts.push(counts[0]); coldSizes.push(sizes[0]);
          if (coldTrial < coldRepeats - 1) continue;
          const row = { variant: variant.name, case: name, rtt, coldMs: rounded(median(coldTimes)), firstColdMs: rounded(coldTimes[0]), coldSamplesMs: coldTimes.map(rounded), warmMs: rounded(median(times.slice(1))), warmSamplesMs: times.slice(1).map(rounded), coldRequests: Math.max(...coldCounts), warmRequests: median(counts.slice(1)), coldBytes: median(coldSizes), warmBytes: median(sizes.slice(1)), warmHostMs: rounded(median(hostTimes.slice(1))), engine: rust ? variant.client ? nativeDelegated ? 'rust-client-native' : 'rust-wasm' : 'rust-native' : 'typescript', initializationMs: rust?.initializationMs || 0, idlePushBytesTotal: idleBytes.reduce((a, b) => a + b, 0), idlePushHostMsTotal: rounded(idleTimes.reduce((a, b) => a + b, 0)) };
          const warm = latencyStatistics(times.slice(1));
          measurements.set(row, { cold: median(coldTimes), warm });
          Object.assign(row, { warmRepeats, warmP95Ms: rounded(warm.p95), ...(warm.lower95 !== undefined ? { warmMedian95Ms: [rounded(warm.lower95), rounded(warm.upper95!)] } : {}), ...(nativeEngineTimes.length ? { nativeEngineWarmMs: rounded(median(nativeEngineTimes.slice(1))), nativeEngineWarmP95Ms: rounded(latencyStatistics(nativeEngineTimes.slice(1)).p95) } : {}) });
          rows.push(row); console.log(JSON.stringify(row));
        } finally { discovery.dispose(); help?.dispose(); }
      }
    }
  }
  await mkdir(new URL('../.test-artifacts/', import.meta.url), { recursive: true });
  const output = process.env.BENCH_OUTPUT || new URL('../.test-artifacts/architecture-benchmark.json', import.meta.url);
  await writeFile(output, JSON.stringify({ revisions: loaded.map(({ name, revision }) => ({ name, revision })), repeats, cpuRepeats, coldRepeats, comparisons, runtime: process.version, platform: `${process.platform}/${process.arch}`, rows }, null, 2));
  const confirm = new Set<string>();
  if (shared) for (const mode of ['master', 'experiment']) for (const after of rows.filter(row => row.variant === mode + ' after')) {
    const before = rows.find(row => row.variant === mode + ' before' && row.case === after.case && row.rtt === after.rtt)!;
    assert.ok(after.coldRequests <= before.coldRequests, `${mode}: ${after.case} gained cold requests`);
    assert.ok(after.warmRequests <= before.warmRequests, `${mode}: ${after.case} gained warm requests`);
    {
      const a = measurements.get(after)!, b = measurements.get(before)!;
      assert.ok(a.cold <= b.cold + Math.max(10, b.cold * 0.2), `${mode}: ${after.case} RTT=${after.rtt} coldMs regressed (${before.coldMs} -> ${after.coldMs})`);
      if (latencyRegressed(a.warm, b.warm, 0.15)) {
        const message = `${mode}: ${after.case} RTT=${after.rtt} warm median regression (${before.warmMs} -> ${after.warmMs})`;
        // Samples within one cohort cannot detect scheduling or JIT drift between variants.
        // Require a fresh counterbalanced cohort before rejecting sub-millisecond CPU timings.
        if (after.rtt === 0 && !process.env.BENCH_CONFIRM) { confirm.add(after.case); console.log('Confirming in reversed order: ' + message); }
        else assert.fail(message);
      }
    }
  }
  if (confirm.size) {
    await Promise.all(rustPeers.map(peer => peer?.dispose())); rustPeers.length = 0;
    const confirmation = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: 'inherit', env: { ...process.env, BENCH_RTT: '0', BENCH_CASES: [...confirm].join(','),
        BENCH_REVERSE: process.env.BENCH_REVERSE === '1' ? '0' : '1', BENCH_CONFIRM: '1',
        BENCH_OUTPUT: fileURLToPath(new URL('../.test-artifacts/architecture-confirmation.json', import.meta.url)) },
    });
    if (confirmation.error) throw confirmation.error;
    assert.equal(confirmation.status, 0, 'The reversed-order cohort must pass the same performance and correctness budgets.');
  }
} finally { await Promise.all(rustPeers.map(peer => peer?.dispose())); await rm(temp, { recursive: true, force: true }); }
