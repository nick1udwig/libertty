import ts from 'typescript';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { boundaries, lifecycle } from './boundaries.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const sources = ['src/protocol.ts', 'src/facts.ts', 'src/file-protocol.ts', 'src/transfer-protocol.ts', 'src/herdr-protocol.ts',
  'src/engine/types.ts', 'src/engine/help.ts', 'src/engine/command-policy.ts', 'src/engine/directory-types.ts', 'src/connections.ts'];
const program = ts.createProgram(sources.map(file => path.join(root, file)), { strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true });
const checker = program.getTypeChecker();
const definitions = {}, named = new Map(), declarations = new Map();
for (const file of sources) for (const node of program.getSourceFile(path.join(root, file)).statements) {
  if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) continue;
  if (!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
  if (node.name.text === 'DirectoryHost') continue; // Functions use HostRequest/HostReply.
  if (file === 'src/connections.ts' && !['KeyReference', 'KeyInfo', 'KnownHost', 'SSHConnection'].includes(node.name.text)) continue;
  const type = checker.getTypeAtLocation(node);
  if (!named.has(type)) { named.set(type, node.name.text); declarations.set(node.name.text, type); }
}
const ref = name => ({ $ref: '#/$defs/' + name });
function schema(type, inline = false) {
  if (!inline && named.has(type)) return ref(named.get(type));
  if (type.flags & ts.TypeFlags.StringLiteral) return { const: type.value, type: 'string' };
  if (type.flags & ts.TypeFlags.NumberLiteral) return { const: type.value, type: 'number' };
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: type.intrinsicName === 'true', type: 'boolean' };
  if (type.flags & ts.TypeFlags.String) return { type: 'string' };
  if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
  if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
  if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) throw new Error('Unspecified boundary: ' + checker.typeToString(type));
  if (type.isUnion()) {
    const variants = type.types.filter(part => !(part.flags & ts.TypeFlags.Undefined)).map(part => schema(part));
    if (variants.length === 1) return variants[0];
    return { anyOf: variants };
  }
  if (checker.isArrayType(type)) return { type: 'array', items: schema(checker.getTypeArguments(type)[0]) };
  const properties = {}, required = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration || property.declarations?.[0];
    const value = checker.getTypeOfSymbolAtLocation(property, declaration);
    if (value.getCallSignatures().length) throw new Error('Callback requires the async host protocol: ' + property.name);
    properties[property.name] = schema(value);
    if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
  }
  const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  return { type: 'object', ...(Object.keys(properties).length ? { properties } : {}), ...(required.length ? { required } : {}), additionalProperties: index ? schema(index) : true };
}
for (const [name, type] of declarations) definitions[name] = schema(type, true);
const string = { type: 'string' }, boolean = { type: 'boolean' }, integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: true });
definitions.Error = object({ error: string, needsSecret: boolean, fingerprint: string, changed: boolean }, ['error']);
definitions.Ok = object({ ok: { const: true } });
definitions.ConnectRequest = object({ token: string, session: { anyOf: [string, { type: 'null' }] }, noSession: boolean }, []);
definitions.ConnectReply = object({ state: ref('ShellState'), accessToken: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['accessToken']);
definitions.SuggestRequest = object({ text: { type: 'string', maxLength: 2000, 'x-utf16MaxLength': 2000 } });
definitions.SuggestReply = object({ candidates: { type: 'array', items: ref('Candidate'), maxItems: 4 }, source: string, cwd: string });
definitions.ContextRequest = object({ kind: { const: 'context' }, known: string, paths: boolean }, ['kind']);
definitions.FactsRequest = object({ key: string, operations: { type: 'array', items: ref('Fact'), minItems: 1, maxItems: 64 } });
definitions.FactsReply = { type: 'array', items: ref('FactValue'), minItems: 1, maxItems: 64 };
definitions.SessionsRequest = object({ name: string, ssh: ref('SSHConnection'), files: boolean }, []);
definitions.SessionReply = object({ id: string, name: string, state: ref('ShellState') });
definitions.TicketReply = object({ ticket: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
definitions.PairingsData = object({ version: { const: 1 }, tokenHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, credentials: { type: 'array', maxItems: 256, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } } });
const requestId = { type: 'integer', minimum: 1, maximum: 0xffffffff };
definitions.Environment = { type: 'object', additionalProperties: string };
definitions.EngineToken = object({ value: string, quoted: boolean });
const array = items => ({ type: 'array', items });
const nullable = value => ({ anyOf: [value, { type: 'null' }] });
const tuple = (items, minimum = items.length) => ({ type: 'array', prefixItems: items, minItems: minimum, items: ref('Json'), 'x-trailingArguments': 'ignored for compatibility with JavaScript callbacks' });
const catalog = ref('Catalog'), metadata = ref('CommandMetadata'), flags = array(ref('Flag')), candidates = array(ref('Candidate')), environment = ref('Environment');
const operations = {};
function operation(name, args, response, minimum = args.length, asynchronous = false) { operations[name] = { args: tuple(args, minimum), response, asynchronous }; }
for (const name of ['tokens', 'symbolAlternatives', 'simpleWords', 'directoryInput', 'pipelineParts', 'transferAction', 'downloadPipeline', 'flagsFromHelp', 'commandsFromManual', 'hasCommandSlot']) {
  operation(name, [string], name === 'tokens' ? array(ref('EngineToken')) : name === 'flagsFromHelp' ? flags : name === 'commandsFromManual' ? array(string) : name === 'hasCommandSlot' ? boolean : ref('Json'));
}
operation('shellQuote', [string], string);
operation('similarity', [string, string], { type: 'number' });
operation('matches', [array(ref('EngineToken')), integer, array(string), integer, nullable(boolean)], ref('Json'), 4);
for (const name of ['commandNames', 'discoveryTargets']) operation(name, [string, catalog], array(string));
operation('discoveryTarget', [string, catalog], string);
operation('repair', [string, catalog, nullable(flags), nullable(metadata)], candidates, 2);
operation('expandSymbols', [string, nullable(boolean)], string, 1);
operation('historyCandidates', [string, catalog], candidates);
operation('commandsFromHelp', [string, nullable(string)], array(string), 1);
operation('requiredFromHelp', [string, string], nullable(integer));
operation('optionArity', [string, flags], nullable(boolean));
for (const name of ['suggest', 'suggestWithStage']) operation(name, [string, catalog, environment, nullable(boolean)], name === 'suggest' ? candidates : object({ candidates, source: { enum: ['history', 'cache', 'schema', 'discovery', 'directory'] } }), 3, true);
operation('discover', [string, catalog, environment], object({ metadata, scriptFlags: flags }, ['metadata']), 3, true);
operation('cachedMetadata', [catalog, environment], metadata, 2, true);
operation('prewarmTargets', [catalog, environment], array(string), 2, true);
operation('markWarmed', [string, catalog, environment], { type: 'null' }, 3, true);
operation('seedMetadata', [catalog, environment, metadata], { type: 'null' }, 3, true);
operation('repairInputFile', [string, catalog, string, nullable(string)], nullable(candidates), 3, true);
operation('repairDirectory', [string, catalog, string], nullable(candidates), 3, true);
operation('completeArguments', [string, catalog, metadata, nullable(flags), nullable(boolean)], candidates, 3, true);
operation('candidateValid', [string, ref('Candidate'), catalog, environment, metadata, nullable(flags)], boolean, 5, true);
definitions.EngineRequest = { anyOf: Object.entries(operations).map(([name, operation]) => object({ operation: { const: name }, args: operation.args })) };
definitions.AsyncEngineRequest = { anyOf: Object.entries(operations).map(([name, operation]) => object({ request: requestId, operation: { const: name }, args: operation.args, now: { type: 'number', minimum: 0 } })) };
definitions.PreparedEngineContext = object({ context: requestId, catalog, environment });
definitions.PreparedEngineRequest = object({ request: requestId, context: requestId, input: string, now: { type: 'number', minimum: 0 } });
definitions.EngineDirectoryPins = object({ request: requestId, directories: { type: 'array', maxItems: 32, 'x-totalEntries': 30000, items: object({ directory: requestId, entries: { ...array(ref('DirectoryEntry')), maxItems: 30000 } }, ['directory']) } });
definitions.EngineDirectoryReference = object({ directory: requestId, version: string, complete: boolean });
definitions.EngineOperationReply = { anyOf: Object.entries(operations).map(([name, operation]) => object({ operation: { const: name }, value: operation.response })) };
definitions.HostRequest = object({ request: requestId, operations: { type: 'array', items: ref('Fact'), minItems: 1, maxItems: 64 } });
definitions.HostResult = { anyOf: [object({ value: ref('FactValue') }), object({ error: string }), object({ entries: requestId }), object({ lookup: ref('EngineDirectoryReference') })] };
definitions.HostReply = { anyOf: [object({ request: requestId, values: { type: 'array', items: ref('FactValue'), minItems: 1, maxItems: 64 } }),
  object({ request: requestId, results: { type: 'array', items: ref('HostResult'), minItems: 1, maxItems: 64 } })] };
definitions.HostError = object({ request: requestId, error: string });
definitions.HostCancel = object({ request: requestId, cancel: { const: true } });
definitions.EngineResume = object({ request: requestId, replies: { type: 'array', items: { anyOf: [ref('HostReply'), ref('HostError')] }, maxItems: 64 }, now: { type: 'number', minimum: 0 } });
definitions.EngineStep = { anyOf: [object({ request: requestId, state: { const: 'pending' }, callbacks: { type: 'array', items: ref('HostRequest') } }),
  object({ request: requestId, state: { const: 'complete' }, value: ref('Json') }), object({ request: { ...requestId, minimum: 0 }, state: { const: 'error' }, error: string })] };
const http = boundaries(definitions);

// These bounds belong to the wire, independently of Rust's machine integer width.
function bounds(node, field) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'number' && ['seq', 'firstSeq', 'prompt', 'revision', 'inputRevision', 'promptRevision', 'cursor', 'sequence', 'completion', 'size', 'mode'].includes(field)) Object.assign(node, integer);
  if (node.type === 'number' && ['cols', 'rows'].includes(field)) Object.assign(node, { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
  if (node.type === 'number' && field === 'exitCode') Object.assign(node, { type: 'integer', minimum: 0, maximum: 255 });
  if (node.type === 'string' && field === 'path') Object.assign(node, { maxLength: 4096, 'x-utf16MaxLength': 4096, pattern: '^[^\\u0000]*$' });
  for (const [name, value] of Object.entries(node.properties || {})) bounds(value, name);
  for (const value of node.anyOf || []) bounds(value, field);
  if (node.items) bounds(node.items);
}
Object.values(definitions).forEach(value => bounds(value));
Object.values(operations).forEach(value => { value.args.prefixItems.forEach(item => bounds(item)); bounds(value.response); });
for (const variant of definitions.Fact.anyOf) {
  const kind = variant.properties.kind.const;
  if (variant.properties.path) Object.assign(variant.properties.path, { pattern: '^/[^\\u0000]*$' });
  if (kind === 'entries') Object.assign(variant.properties.limit, { type: 'integer', minimum: 1, maximum: 10000 });
  if (kind === 'directory') Object.assign(variant.properties.version, { maxLength: 256, 'x-utf16MaxLength': 256 });
  if (variant.properties.command) Object.assign(variant.properties.command, { maxLength: 4000, 'x-utf16MaxLength': 4000, pattern: '^[^\\u0000-\\u001f\\u007f]*$' });
  if (kind === 'help') Object.assign(variant.properties.route, { maxItems: 3, items: { type: 'string', pattern: '^[a-zA-Z][A-Za-z0-9_-]*$' } });
}
definitions.HerdrClientMessage = JSON.parse(JSON.stringify(definitions.ClientMessage));
for (const variant of definitions.HerdrClientMessage.anyOf) if (variant.properties.type.const === 'resize') for (const name of ['cols', 'rows']) Object.assign(variant.properties[name], { minimum: 1, maximum: 1000 });
const output = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://libertty.local/contracts/migration-v1',
  title: 'Libertty migration contracts', description: 'Reference wire types; optional fields are omitted, and explicit null is accepted only where declared.', $defs: definitions };
await mkdir(path.join(root, 'contracts'), { recursive: true });
const content = JSON.stringify(output, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(path.join(root, 'contracts/schemas.json'), 'utf8') !== content) throw new Error('Schemas are stale; run npm run migration:schemas.');
  if (await readFile(path.join(root, 'contracts/http.json'), 'utf8') !== JSON.stringify(http, null, 2) + '\n') throw new Error('HTTP inventory is stale.');
  if (await readFile(path.join(root, 'contracts/ws-lifecycle.json'), 'utf8') !== JSON.stringify(lifecycle, null, 2) + '\n') throw new Error('WebSocket lifecycle inventory is stale.');
  if (await readFile(path.join(root, 'contracts/engine-operations.json'), 'utf8') !== JSON.stringify({ version: 1, operations }, null, 2) + '\n') throw new Error('Engine operation contracts are stale.');
} else {
  await writeFile(path.join(root, 'contracts/schemas.json'), content);
  await writeFile(path.join(root, 'contracts/http.json'), JSON.stringify(http, null, 2) + '\n');
  await writeFile(path.join(root, 'contracts/ws-lifecycle.json'), JSON.stringify(lifecycle, null, 2) + '\n');
  await writeFile(path.join(root, 'contracts/engine-operations.json'), JSON.stringify({ version: 1, operations }, null, 2) + '\n');
}
console.log(`Verified ${Object.keys(definitions).length} boundary schemas.`);
