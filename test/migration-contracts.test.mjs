import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import ts from 'typescript-reference';
import { HERDR_SHELL } from '../server/herdr-capture.ts';
import { SSH_WRAPPER_CHECK } from '../server/ssh-capture.ts';
import { TRANSFER_SHELL } from '../server/transfer-shell.ts';
import { READING_SHELL } from '../server/reading-shell.ts';
import { HISTORY_SHELL } from '../server/history-shell.ts';
import { HISTORY_ENTRIES } from '../server/history.ts';
import { COMPLETION_SNAPSHOT, COMPLETION_SCRIPT } from '../server/completion.ts';
import { pairingPage } from '../server/pairing-page.ts';

const schemas = JSON.parse(await readFile(new URL('../contracts/schemas.json', import.meta.url), 'utf8'));
const http = JSON.parse(await readFile(new URL('../contracts/http.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat('uri', value => { try { return !!new URL(value).protocol; } catch { return false; } });
ajv.addKeyword({ keyword: 'x-utf16MaxLength', type: 'string', schemaType: 'number', validate: (limit, value) => value.length <= limit });
ajv.addKeyword({ keyword: 'x-utf8MaxBytes', type: 'string', schemaType: 'number', validate: (limit, value) => Buffer.byteLength(value) <= limit });
ajv.addKeyword({ keyword: 'x-decodedBytes', type: 'string', schemaType: 'number', validate: (length, value) => Buffer.from(value, 'base64').length === length });
const validate = name => ajv.compile({ $defs: schemas.$defs, $ref: '#/$defs/' + name });

test('Rust embeds the exact reference Bash utilities covered by the retained shell harnesses', async () => {
  const source = await readFile(new URL('../server/session.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('session.ts', source, ts.ScriptTarget.Latest, true);
  let initializer;
  for (const statement of tree.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) if (declaration.name.getText(tree) === 'RC') initializer = declaration.initializer.getText(tree);
  }
  assert.ok(initializer, 'Reference RC template must exist');
  const scope = { HERDR_SHELL, SSH_WRAPPER_CHECK, TRANSFER_SHELL, READING_SHELL, HISTORY_SHELL, HISTORY_ENTRIES, COMPLETION_SNAPSHOT };
  const reference = Function(...Object.keys(scope), 'return ' + initializer)(...Object.values(scope));
  assert.equal(await readFile(new URL('../crates/server/assets/bashrc.sh', import.meta.url), 'utf8'), reference);
  assert.equal(await readFile(new URL('../crates/server/assets/completion.sh', import.meta.url), 'utf8'), COMPLETION_SCRIPT);
  assert.equal(await readFile(new URL('../crates/server/assets/pairing.html', import.meta.url), 'utf8'), pairingPage('__TERMAI_PUBLIC_BASE__'));
});

test('all migration schemas compile and every API route has a resolvable request, response and error contract', async () => {
  for (const name of Object.keys(schemas.$defs)) validate(name);
  const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
  const endpoints = [...source.matchAll(/url\.pathname === '(\/[^']+)'/g)].map(match => match[1]);
  for (const path of new Set(endpoints)) assert.ok(http.routes.some(route => route.path === path), 'Missing HTTP contract: ' + path);
  const seen = new Set();
  for (const route of http.routes) {
    const key = route.method + ' ' + route.path; assert.ok(!seen.has(key), 'Duplicate HTTP contract: ' + key); seen.add(key);
    for (const schema of [route.request, route.response, route.error, route.query].filter(Boolean)) ajv.compile({ $defs: schemas.$defs, ...schema });
  }
  for (const socket of http.sockets) {
    for (const schema of [socket.client, socket.server]) ajv.compile({ $defs: schemas.$defs, ...schema });
    const [file, pointer] = socket.lifecycle.split('#/');
    const lifecycle = JSON.parse(await readFile(new URL('../contracts/' + file, import.meta.url), 'utf8'))[pointer];
    assert.ok(lifecycle.authentication); assert.ok(lifecycle.encodings);
    for (const transition of lifecycle.transitions || []) {
      for (const state of transition.from) assert.ok(lifecycle.states.includes(state));
      if (transition.to) assert.ok(lifecycle.states.includes(transition.to));
      if (transition.shellState) assert.ok(lifecycle.shellStates.includes(transition.shellState));
    }
  }
});

test('request contracts reject malformed objects, UTF-16 overflow, invalid fact variants and numeric bounds', () => {
  const suggest = validate('SuggestRequest');
  assert.ok(suggest({ text: 'echo hello', future: true })); assert.ok(suggest({ text: '🌍'.repeat(1000) }));
  for (const body of [null, [], 'text', {}, { text: 1 }, { text: '🌍'.repeat(1001) }]) assert.equal(suggest(body), false, JSON.stringify(body));
  const facts = validate('FactsRequest');
  assert.ok(facts({ key: 'context', operations: [{ kind: 'entries', path: '/fixture', limit: 10000 }, { kind: 'stat', path: '/fixture/file' }] }));
  for (const operations of [[], Array(65).fill({ kind: 'stat', path: '/' }), [null], [{ kind: 'exec', command: 'touch file' }],
    [{ kind: 'stat', path: 'relative' }], [{ kind: 'stat', path: '/bad\0path' }], [{ kind: 'entries', path: '/', limit: 0 }],
    [{ kind: 'entries', path: '/', limit: 10001 }], [{ kind: 'entries', path: '/', limit: 1.5 }], [{ kind: 'help', command: 'tool', route: ['unknown;command'] }],
    [{ kind: 'syntax', command: 'echo\ncontrol' }]]) assert.equal(facts({ key: 'context', operations }), false, JSON.stringify(operations));
});

test('optional properties remain distinct from null and file editing measures encoded bytes', () => {
  const candidate = validate('Candidate');
  assert.ok(candidate({ command: 'ls', score: 100, changes: [] })); assert.ok(candidate({ command: 'ls', score: 0, changes: [], literal: true }));
  assert.equal(candidate({ command: 'ls', score: 100, changes: [], literal: null }), false);
  const file = validate('FileInfo'); assert.ok(file({ file: true, directory: false, executable: false })); assert.equal(file({ file: true, directory: false, executable: false, spelling: null }), false);
  const action = validate('FileActionRequest');
  assert.ok(action({ action: 'write', path: '/fixture', text: '🌍'.repeat(8192), version: 'hash' }));
  assert.equal(action({ action: 'write', path: '/fixture', text: '🌍'.repeat(8193), version: 'hash' }), false);
  assert.equal(action({ action: 'delete', paths: [] }), false);
});

test('persisted pairing credentials require hashed version-one records and bounded arrays', () => {
  const pairings = validate('PairingsData');const hash = 'a'.repeat(64);
  assert.ok(pairings({ version: 1, tokenHash: hash, credentials: [hash] }));
  for (const value of [{}, { version: 2, tokenHash: hash, credentials: [] }, { version: 1, tokenHash: 'pairing-token', credentials: [] },
    { version: 1, tokenHash: hash, credentials: Array(257).fill(hash) }, { version: 1, tokenHash: hash, credentials: [null] }]) assert.equal(pairings(value), false);
});

test('synthetic saved data and asynchronous native/Wasm messages obey their contracts', async () => {
  const state = JSON.parse(await readFile(new URL('./fixtures/rust-migration/state.json', import.meta.url), 'utf8'));
  assert.equal(state.synthetic, true);
  assert.ok(validate('VaultData')(state.vault.data));
  assert.ok(validate('PairingsData')(state.pairing.data));
  const request = validate('AsyncEngineRequest');
  assert.ok(request({ request: 1, operation: 'tokens', args: ['echo hello'], now: 0 }));
  assert.equal(request({ request: 0, operation: 'tokens', args: ['echo hello'], now: 0 }), false);
  assert.equal(request({ request: 1, operation: 'candidateValid', args: [], now: 0 }), false);
  assert.equal(request({ request: 1, operation: 'unknown', args: [], now: 0 }), false);
  const reply = validate('HostReply');
  assert.ok(reply({ request: 1, values: [true, null] }));
  assert.ok(reply({ request: 1, results: [{ value: true }, { error: 'Host denied.' }] }));
  assert.equal(reply({ request: 1, values: [undefined] }), false);
  assert.ok(reply({ request: 1, results: [{ entries: 2 }, { lookup: { directory: 3, version: 'v1', complete: true } }] }));
  assert.equal(reply({ request: 1, results: [{ entries: 0 }] }), false);
  const pins = validate('EngineDirectoryPins');
  assert.ok(pins({ request: 1, directories: [{ directory: 2, entries: [{ name: '🌍', directory: true, symlink: false }] }, { directory: 3 }] }));
  for (const directories of [[{ directory: 0 }], [{ directory: 2, entries: null }], Array(33).fill({ directory: 2 })]) assert.equal(pins({ request: 1, directories }), false);
  const fact = validate('Fact');
  const engineRequest = validate('EngineRequest'), engineReply = validate('EngineOperationReply');
  for (const name of ['engine', 'host', 'native-host']) {
    const corpus = JSON.parse(await readFile(new URL('./fixtures/rust-migration/' + name + '.json', import.meta.url), 'utf8'));
    for (const row of corpus.fixtures) {
      assert.ok(engineRequest({ operation: row.operation, args: row.args }), JSON.stringify(engineRequest.errors));
      if (!row.expected?.error) assert.ok(engineReply({ operation: row.operation, value: name === 'engine' ? row.result : row.expected.value }), JSON.stringify({ operation: row.operation, errors: engineReply.errors }));
      for (const item of row.facts || []) assert.ok(fact(item.operation), JSON.stringify(item.operation));
    }
  }
});
