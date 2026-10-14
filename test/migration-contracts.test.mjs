import { execFileSync } from 'node:child_process';
import { rustExample } from './support/rust-example.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';

const schemas = JSON.parse(await readFile(new URL('../contracts/schemas.json', import.meta.url), 'utf8'));
const http = JSON.parse(await readFile(new URL('../contracts/http.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat('uri', value => { try { return !!new URL(value).protocol; } catch { return false; } });
ajv.addKeyword({ keyword: 'x-utf16MaxLength', type: 'string', schemaType: 'number', validate: (limit, value) => value.length <= limit });
ajv.addKeyword({ keyword: 'x-utf8MaxBytes', type: 'string', schemaType: 'number', validate: (limit, value) => Buffer.byteLength(value) <= limit });
ajv.addKeyword({ keyword: 'x-decodedBytes', type: 'string', schemaType: 'number', validate: (length, value) => Buffer.from(value, 'base64').length === length });
const validate = name => ajv.compile({ $defs: schemas.$defs, $ref: '#/$defs/' + name });

test('Rust shell utilities and pairing assets match their declared byte checksums', async () => {
  const assets = JSON.parse(await readFile(new URL('../contracts/assets.json', import.meta.url), 'utf8'));
  for (const [file, digest] of Object.entries(assets)) {
    assert.equal(createHash('sha256').update(await readFile(new URL('../'+file, import.meta.url))).digest('hex'), digest, file);
  }
});

test('all migration schemas compile and every API route has a resolvable request, response and error contract', async () => {
  for (const name of Object.keys(schemas.$defs)) validate(name);
  const source = await readFile(new URL('../crates/server/src/http/routes.rs', import.meta.url), 'utf8');
  const endpoints = [...source.matchAll(/\.route\(\s*"(\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(endpoints.length >= 35, 'The Axum route table must be covered');
  for (const path of new Set(endpoints)) assert.ok([...http.routes,...http.sockets].some(route => route.path === path), 'Missing HTTP contract: ' + path);
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

test('request contracts reject malformed objects, UTF-16 overflow, numeric bounds', () => {
  const suggest = validate('SuggestRequest');
  assert.ok(suggest({ text: 'echo hello', future: true })); assert.ok(suggest({ text: '🌍'.repeat(1000) }));
  for (const body of [null, [], 'text', {}, { text: 1 }, { text: '🌍'.repeat(1001) }]) assert.equal(suggest(body), false, JSON.stringify(body));

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

test('Herdr space action contracts include splits and worktrees with scoped operands', () => {
  const action = validate('HerdrActionRequest');
  for (const direction of ['right', 'down']) assert.ok(action({ action: 'split', workspaceId: 'w1', terminalId: 'term_0', direction }));
  assert.ok(action({ action: 'list-worktrees', workspaceId: 'w1' }));
  assert.ok(action({ action: 'new-worktree', workspaceId: 'w1', branch: 'review/mobile' }));
  assert.ok(action({ action: 'open-worktree', workspaceId: 'w1', path: '/worktrees/review' }));
  for (const force of [undefined, false, true]) assert.ok(action({ action: 'delete-worktree', workspaceId: 'w1', path: '/worktrees/review', ...(force === undefined ? {} : { force }) }));
  for (const force of ['true', 1, null]) assert.equal(action({ action: 'delete-worktree', workspaceId: 'w1', path: '/worktrees/review', force }), false);
  assert.equal(action({ action: 'delete-worktree', workspaceId: 'w1', force: true }), false);
  for (const input of [{ action: 'split', workspaceId: 'w1', direction: 'right' }, { action: 'split', workspaceId: 'w1', terminalId: 'term_0', direction: 'left' }, { action: 'new-worktree', branch: 'review' }, { action: 'open-worktree', workspaceId: 'w1' }]) assert.equal(action(input), false);
});

test('Herdr worktree reply contracts validate branch suggestions', () => {
  const check = validate('HerdrWorktrees');
  const reply = { source: { repo_name: 'fixture', repo_root: '/fixture' }, worktrees: [], branches: ['main', 'review/existing'] };
  assert.ok(check(reply));
  assert.ok(check({ ...reply, branches: undefined }));
  for (const branches of [null, 'main', [1], [{}]]) assert.equal(check({ ...reply, branches }), false);
});

test('persisted pairing credentials require hashed version-one records and bounded arrays', () => {
  const pairings = validate('PairingsData');const hash = 'a'.repeat(64);
  assert.ok(pairings({ version: 1, tokenHash: hash, credentials: [hash] }));
  for (const value of [{}, { version: 2, tokenHash: hash, credentials: [] }, { version: 1, tokenHash: 'pairing-token', credentials: [] },
    { version: 1, tokenHash: hash, credentials: Array(257).fill(hash) }, { version: 1, tokenHash: hash, credentials: [null] }]) assert.equal(pairings(value), false);
});

test('asynchronous native engine messages obey their contracts', () => {
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
});

test('the Rust client parser accepts every declared client message and rejects malformed field types', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const samples = [
    { type: 'repair', id, text: 'echo 🌍', prompt: 1, revision: 2 },
    { type: 'repair-cancel', id }, { type: 'input-line', id, prompt: 1, revision: 2 },
    { type: 'dictation', id, action: 'start', target: 'program', prompt: 1, revision: 2 },
    { type: 'input', data: '\u001b[A' }, { type: 'paste', text: '🌍' },
    { type: 'dictation-paste', text: 'hello', applied: false, replace: false, prompt: 1, revision: 2 },
    { type: 'replace', id, text: 'echo', prompt: 1, revision: 2 },
    { type: 'command', id, command: 'echo', prompt: 1 },
    { type: 'resize', cols: 80, rows: 24, mobile: true },
    { type: 'terminal-scroll', lines: -2, column: 0, row: 0 },
    { type: 'herdr-frame-request' }, { type: 'herdr-active', active: true }, { type: 'ack', seq: Number.MAX_SAFE_INTEGER },
  ];
  const declared = schemas.$defs.ClientMessage.anyOf.map(variant => variant.properties.type.const).sort();
  assert.deepEqual(samples.map(sample => sample.type).sort(), declared);
  const check = validate('ClientMessage');
  const cases = samples.map(value => ({ value: { ...value, future: true }, accepted: true }));
  for (const sample of samples) for (const [field, value] of Object.entries(sample)) {
    if (field !== 'type' && field !== 'target') cases.push({ value: { ...sample, [field]: typeof value === 'string' ? {} : 'invalid' }, accepted: false });
  }
  for (const { value, accepted } of cases) assert.equal(check(value), accepted, JSON.stringify(value));
  const actual = execFileSync(rustExample('protocol_check'), { input: cases.map(test => JSON.stringify(test.value)).join('\n') + '\n', encoding: 'utf8' }).trim().split('\n').map(value => value === 'true');
  assert.deepEqual(actual, cases.map(test => test.accepted));
});
