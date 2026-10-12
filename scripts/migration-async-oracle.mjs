// Record real host facts while running unchanged TypeScript regression assertions.
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript-reference';

const scope = new AsyncLocalStorage();
const fixtures = new Map();
const asyncOperations = new Set(['suggest', 'candidateValid', 'repairDirectory', 'repairInputFile', 'completeArguments']);
async function fact(operation, call) {
  const trace = scope.getStore();
  if (!trace) return call();
  let reply;
  try { const value = await call(); reply = { value: value ?? null }; return value; }
  catch (error) { reply = { error: error instanceof Error ? error.message : String(error) }; throw error; }
  finally {
    const key = JSON.stringify(operation), old = trace.facts.get(key);
    if (old && JSON.stringify(old.reply) !== JSON.stringify(reply)) trace.unstable = true;
    trace.facts.set(key, { operation, reply });
  }
}
function hostAdapter(host) {
  const wrapped = { ...host };
  for (const kind of ['stat', 'lookup', 'entries', 'syntax', 'complete']) {
    if (typeof host[kind] !== 'function') continue;
    wrapped[kind] = (...args) => fact(kind === 'stat' ? { kind, path: args[0], executable: args[2] ?? true }
      : kind === 'entries' ? { kind, path: args[0], limit: args[1] }
        : kind === 'lookup' ? { kind, path: args[0] }
          : kind === 'complete' ? { kind: 'completion', words: args[0] } : { kind, command: args[0] }, () => host[kind](...args));
  }
  return wrapped;
}
globalThis.__termaiRecordDiscoveryIO = io => !io ? io : {
  ...io,
  help: (...args) => fact({ kind: 'help', command: args[0], route: args[1] }, () => io.help(...args)),
  describe: (...args) => fact({ kind: 'describe', command: args[0] }, () => io.describe(...args)),
};
globalThis.__termaiAsyncReference = async (operation, original, args) => {
  if (scope.getStore()) return original(...args);
  const trace = { facts: new Map(), unstable: false, custom: false };
  let wireArgs, metadata, expected, source = 'schema';
  const call = [...args];
  if (operation === 'suggest') {
    wireArgs = args.slice(0, 3); wireArgs.push(!!args[4].complete);
    metadata = args[3].cached(args[1], args[2]);
    call[4] = hostAdapter(args[4]);
    call[5] = stage => { source = stage; args[5]?.(stage); };
    call[3] = { ...args[3], cached: (...values) => args[3].cached(...values), discover: async (...values) => {
      const before = trace.facts.size;
      const result = await args[3].discover(...values);
      if (trace.facts.size === before && !trace.facts.has(JSON.stringify({ kind: 'help', command: values[0].split(' ')[0], route: [] }))) trace.custom = true;
      return result;
    } };
  } else if (operation === 'discover') {
    wireArgs = args.slice(0, 3);
  } else if (operation === 'candidateValid') {
    wireArgs = [...args.slice(0, 5), args[6] ?? null]; call[5] = hostAdapter(args[5]);
  } else {
    wireArgs = args.slice(0, 3); call[3] = hostAdapter(args[3]);
    if (operation === 'completeArguments') wireArgs.push(args[5] ?? null, !!args[3].complete);
    if (operation === 'repairInputFile') wireArgs.push(args[5] ?? args[0]);
  }
  try {
    const value = await scope.run(trace, () => original(...call));
    expected = { value: operation === 'suggest' ? { candidates: value, source } : value ?? null };
    return value;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') trace.unstable = true;
    expected = { error: error instanceof Error ? error.message : String(error) }; throw error;
  } finally {
    if (!trace.unstable && !trace.custom) {
      const envIndex = operation === 'suggest' || operation === 'candidateValid' || operation === 'discover' ? 2 + (operation === 'candidateValid' ? 1 : 0) : -1;
      if (envIndex >= 0) wireArgs[envIndex] = { ...(args[envIndex].HOME ? { HOME: args[envIndex].HOME } : {}), PATH: '/fixture/bin:/usr/bin:/bin' };
      const row = { operation: operation === 'suggest' ? 'suggestWithStage' : operation, args: wireArgs, ...(metadata ? { metadata } : {}), facts: [...trace.facts.values()], expected };
      const wire = JSON.stringify(row).replaceAll(/\/tmp\/termai-[A-Za-z0-9_-]+/g, '/tmp/fixture');
      // Keep large catalogs in this corpus; they were excluded by the pure recorder.
      if (wire.length <= 16 * 1024 * 1024) fixtures.set(wire, JSON.parse(wire));
    }
  }
};
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.includes('/src/engine/') || !url.endsWith('.ts')) return loaded;
  const source = String(loaded.source), tree = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true);
  const edits = [], wrappers = [];
  for (const node of tree.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && asyncOperations.has(node.name.text) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const name = node.name.text, exported = node.modifiers.find(m => m.kind === ts.SyntaxKind.ExportKeyword);
      edits.push([node.name.getStart(tree), node.name.end, '__reference_' + name], [exported.getStart(tree), exported.end, '']);
      wrappers.push(`export function ${name}(...args: any[]): any { return globalThis.__termaiAsyncReference('${name}', __reference_${name}, args); }`);
    }
    if (ts.isClassDeclaration(node) && node.name?.text === 'Discovery') {
      for (const member of node.members) if (ts.isMethodDeclaration(member) && member.name.getText(tree) === 'discover' && member.body) {
        edits.push([member.name.getStart(tree), member.name.end, '__reference_discover']);
        edits.push([member.body.getStart(tree) + 1, member.body.getStart(tree) + 1, 'io = globalThis.__termaiRecordDiscoveryIO(io);']);
        edits.push([node.end - 1, node.end - 1, "discover(...args: any[]): any { return globalThis.__termaiAsyncReference('discover', this.__reference_discover.bind(this), args); }"]);
      }
    }
  }
  let transformed = source;
  for (const [start, end, replacement] of edits.sort((a,b) => b[0]-a[0])) transformed = transformed.slice(0,start)+replacement+transformed.slice(end);
  return { ...loaded, source: transformed + '\n' + wrappers.join('\n') };
} });
process.on('exit', () => {
  if (!process.env.TERMAI_ASYNC_ORACLE_DIR) return;
  mkdirSync(process.env.TERMAI_ASYNC_ORACLE_DIR, { recursive: true });
  writeFileSync(path.join(process.env.TERMAI_ASYNC_ORACLE_DIR, process.pid + '.json'), JSON.stringify([...fixtures.values()]));
});
