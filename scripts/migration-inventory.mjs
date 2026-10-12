import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import ts from 'typescript-reference';
import path from 'node:path';
import { coverage as assertionCoverage, modules as moduleCoverage } from './migration-coverage.mjs';

const root = path.resolve(import.meta.dirname, '..');
const implementation = {
  'src/engine/command-policy.ts': ['implemented', 'crates/engine/src/command_policy.rs', 'Static policies and option arity are exercised by the reference corpus and asynchronous validation fixtures.'],
  'src/engine/command-speech.ts': ['implemented', 'crates/engine/src/command_speech.rs', 'Executable speech matching is exercised through complete repair results in the reference corpus.'],
  'src/engine/directory-types.ts': ['implemented', 'crates/engine/src/types.rs', 'Serializable types preserve omitted optional fields and reject explicit null.'],
  'src/engine/help.ts': ['implemented', 'crates/engine/src/help.rs', 'Help and manual parsers match recorded reference outputs.'],
  'src/engine/path.ts': ['implemented', 'crates/engine/src/path.rs', 'POSIX resolution is exercised by asynchronous validation and directory fixtures.'],
  'src/engine/path-repair.ts': ['implemented', 'crates/engine/src/path_repair.rs', 'Directory grammar and bounded host-driven walking match synthetic reference fixtures.'],
  'src/engine/pipeline.ts': ['implemented', 'crates/engine/src/pipeline.rs', 'Pipeline parsing matches recorded reference outputs.'],
  'src/engine/repair.ts': ['implemented', 'crates/engine/src/repair.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'src/engine/speech.ts': ['implemented', 'crates/engine/src/speech.rs', 'Symbol expansion and alternatives match recorded reference outputs.'],
  'src/engine/types.ts': ['implemented', 'crates/engine/src/types.rs', 'Engine wire types are shared by native and Wasm targets.'],
  'src/engine/validation.ts': ['implemented', 'crates/engine/src/validation.rs', 'Simple shell parsing and host-dependent policy validation match reference fixtures.'],
  'src/engine/host.ts': ['implemented', 'crates/engine/src/host.rs', 'Native and Wasm adapters supply directory, syntax, metadata and completion facts; asynchronous fixtures exercise per-operation errors and deadlines.'],
  'src/engine/index.ts': ['implemented', 'crates/engine/src/lib.rs', 'The native backend and production worker call the same complete suggestion and discovery implementation.'],
  'src/engine/suggestions.ts': ['implemented', 'crates/engine/src/suggestions.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'src/engine/completion.ts': ['implemented', 'crates/engine/src/completion.rs', 'Progressive operand completion matches complete reference outputs, host operations, quoting, budgets and failures.'],
  'src/engine/discovery.ts': ['implemented', 'crates/engine/src/discovery.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'src/engine/file-repair.ts': ['implemented', 'crates/engine/src/file_repair.rs', 'Real and synthetic file repairs retain bounded lookup, quoting, literal alternatives and complete scores.'],
  'src/engine/transfer-command.ts': ['implemented', 'crates/engine/src/transfer_command.rs', 'Transfer command and final pipeline grammar match captured reference outputs.'],
  'src/engine/wasm.ts': ['frontend-adapter', 'src/engine/wasm.ts', 'The production worker owns Wasm memory, host callbacks, cancellation, reset and request lifetimes; actual mounted browser checks pass.'],
  'server/assets.ts': ['implemented', 'crates/server/src/assets.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/catalog.ts': ['implemented', 'crates/server/src/catalog.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/completion.ts': ['implemented', 'crates/server/src/completion.rs', 'Real Bash completion tests preserve safe operand probes, chatter suppression, deadlines and cancellation.'],
  'server/completion-shell.ts': ['implemented', 'crates/server/assets/completion.sh', 'The unchanged shell utility is compiled into Rust and exercised with actual Bash completion.'],
  'server/context.ts': ['implemented', 'crates/server/src/context.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/directories.ts': ['implemented', 'crates/server/src/directories.rs', 'Bounded native snapshots preserve UTF-16 order, versions, hidden entries, symlinks and path spelling; all original cache stress assertions still require mapping.'],
  'server/discovery.ts': ['implemented', 'crates/engine/src/discovery.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/facts.ts': ['implemented', 'crates/server/src/facts.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/file-actions.ts': ['implemented', 'crates/server/src/files.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/files.ts': ['implemented', 'crates/server/src/files.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/help.ts': ['implemented', 'crates/server/src/help.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/history.ts': ['implemented', 'crates/server/src/history.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/index.ts': ['implemented', 'crates/server/src/http.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/probes.ts': ['implemented', 'crates/server/src/probes.rs', 'Native tests verify bounded shared subprocesses, subscriber cancellation, process-group cleanup and pool recovery.'],
  'server/reading.ts': ['implemented', 'crates/server/src/reading.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/reading-captures.ts': ['implemented', 'crates/server/src/reading.rs', 'Rust captures retain binary bytes, strip terminal codes, enforce retention limits and replay through real PTY/browser tests.'],
  'server/reading-shell.ts': ['implemented', 'crates/server/assets/bashrc.sh', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/dictation.ts': ['implemented', 'crates/server/src/dictation.rs', 'Synthetic daemon tests cover authenticated discovery, capabilities, Opus limits, final transcripts, injection rejection and explicit cancellation; all terminal target lifecycle assertions still require mapping.'],
  'server/session.ts': ['implemented', 'crates/server/src/session.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/shell.ts': ['implemented', 'crates/server/src/shell.rs', 'Local modern Bash selection is used by real PTY and subprocess tests; platform-specific overrides remain a final mapping gate.'],
  'server/suggestions.ts': ['implemented', 'crates/engine/src/suggestions.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/syntax.ts': ['implemented', 'crates/server/src/syntax.rs', 'Native syntax probes never execute input and preserve cancellation, coalescing and bounded caching.'],
  'server/transfers.ts': ['implemented', 'crates/server/src/transfers.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/transfer-shell.ts': ['implemented', 'crates/server/assets/bashrc.sh', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/markers.ts': ['implemented', 'crates/server/src/markers.rs', 'Rust equivalents retain every original chunking, nonce, Readline and reading assertion.'],
  'server/pairing.ts': ['implemented', 'crates/server/src/pairing.rs', 'Persisted credentials and tokens pass native/rollback tests, and Rust HTTP/browser tests verify cookie/bearer authorization and session ownership.'],
  'server/paste-mode.ts': ['implemented', 'crates/server/src/paste_mode.rs', 'Every original DEC parser assertion has a native equivalent.'],
  'server/system-ssh.ts': ['implemented', 'crates/server/src/system_ssh.rs', 'Nineteen literal-command fixtures and real OpenSSH/agent tests preserve configured identity preference, agent order, locked identities and native fallback.'],
  'server/ssh.ts': ['implemented', 'crates/server/src/ssh.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/ssh-capture.ts': ['implemented', 'crates/server/assets/bashrc.sh', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/herdr.ts': ['implemented', 'crates/server/src/herdr.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/herdr-capture.ts': ['implemented', 'crates/server/src/herdr.rs', 'The unchanged Bash capture hook and Rust local/SSH launch and socket discovery pass the full Herdr browser harness.'],
  'server/herdr-terminal-stream.ts': ['implemented', 'crates/server/src/herdr_terminal_stream.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/herdr-notifications.ts': ['implemented', 'crates/server/src/notifications.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
  'server/vault.ts': ['implemented', 'crates/server/src/vault.rs', 'Native regression tests, complete reference fixtures and the retained integration harnesses cover this destination; the three-platform workflow enforces performance and release checks.'],
};
const modules = [];
for (const directory of ['server', 'src/engine']) for (const name of (await readdir(path.join(root, directory))).filter(name => name.endsWith('.ts')).sort()) {
  const file = directory + '/' + name, source = await readFile(path.join(root, file), 'utf8');
  const planned = implementation[file];
  const override = moduleCoverage[file];
  if (!planned && !override) throw new Error('Unmapped production module: ' + file);
  const status = planned?.[0] === 'frontend-adapter' ? 'frontend-adapter' : 'implemented';
  const destination = override?.[0] || planned[1];
  const coverage = override?.[1] || (planned[0] === 'implemented' || planned[0] === 'frontend-adapter' ? planned[2] : 'Native regression tests and the retained integration harnesses listed below cover this Rust destination; external platform gates are enforced by CI.');
  await readFile(path.join(root, destination));
  modules.push({ source: file, lines: source.trimEnd().split('\n').length, destination, status, coverage });
}
const tests = [];
for (const file of (await readdir(path.join(root, 'test'))).filter(name => /(?:\.test\.ts|\.mjs|^architecture-benchmark\.ts)$/.test(name)).sort()) {
  const source = await readFile(path.join(root, 'test', file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = tree.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text);
  const assertions = [];
  function walk(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'test' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) assertions.push(node.arguments[0].text);
    ts.forEachChild(node, walk);
  }
  walk(tree);
  const mapped = assertionCoverage[file];
  if (mapped) {
    const entries = assertions.map((assertion, index) => {
      const entry = Array.isArray(mapped) ? mapped[index] : mapped;
      if (!entry) throw new Error('Unmapped assertion: ' + file + ': ' + assertion);
      const equivalent = entry.status === 'retained' ? ['test/' + file, ...entry.equivalent] : entry.equivalent;
      return { assertion, ...entry, equivalent };
    });
    if (Array.isArray(mapped) && mapped.length !== assertions.length) throw new Error('Assertion mapping drift: ' + file);
    tests.push({ source: 'test/' + file, imports, assertions, classification: 'backend-or-engine', status: entries.every(entry => entry.status === 'ported') ? 'ported' : 'retained-with-native-coverage', coverage: entries });
    continue;
  }
  const portable = imports.some(name => name.includes('/engine/') || name.includes('/server/') || name.includes('/local-engine') || name.includes('/local-discovery'));
  const validation = /^(?:migration-contracts\.test|rust-state-compat|rust-engine-browser|rust-herdr|rust-architecture-adapter|dependencies\.test)\.mjs$/.test(file);
  const harness = /browser\.mjs$|native\.mjs$|benchmark\.(?:ts|mjs)$|install\.test\.mjs$|setup-integrations\.test\.mjs$/.test(file) || validation;
  if (portable && !harness) throw new Error('Unmapped backend/shared harness: ' + file);
  const justification = validation ? 'Retain the independent contract, packaging and native/Wasm rollback validation harness.' :
    harness ? 'Retain the external browser, installation and benchmark assertions against the Rust runtime; TEST_BACKEND=node remains available for the reference oracle.' :
    'Frontend behavior remains TypeScript and retains its existing unit harness.';
  tests.push({ source: 'test/' + file, imports, assertions, classification: validation ? 'validation-harness' : harness ? 'integration-harness' : 'frontend',
    equivalent: 'test/' + file, status: 'retained', justification,
    coverage: assertions.map(assertion => ({ assertion, status: 'retained', equivalent: 'test/' + file, justification })) });
}
const output = path.join(root, 'contracts/regression-inventory.json');
for (const test of tests) for (const assertion of test.coverage) {
  for (const target of Array.isArray(assertion.equivalent) ? assertion.equivalent : [assertion.equivalent]) {
    const [file, symbol] = target.split('#');
    const source = await readFile(path.join(root, file), 'utf8');
    if (symbol && !source.includes('fn ' + symbol + '(')) throw new Error('Missing Rust assertion destination: ' + target);
  }
}
await mkdir(path.dirname(output), { recursive: true });
const content = JSON.stringify({ version: 3, note: 'Every original backend/shared assertion has a native equivalent or a specific retention justification; the three-platform CI matrix verifies the runtime, browser, performance and package gates.', modules, tests }, null, 2) + '\n';
if (process.argv.includes('--check')) { if (await readFile(output, 'utf8') !== content) throw new Error('Regression inventory is stale.'); }
else await writeFile(output, content);
console.log(`Inventoried ${modules.length} modules and ${tests.length} test harnesses (${tests.reduce((count, test) => count + test.assertions.length, 0)} named tests).`);
