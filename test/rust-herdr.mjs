import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { herdrFixture } from './herdr-fixture.ts';

const fixture = await herdrFixture();
const daemon = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(daemon, 'listening');
const voiceToken = 'fixture-voice-token-'.repeat(4);
await writeFile(fixture.directory + '/voice-token', voiceToken, { mode: 0o600 });
let voiceAcks = 0;
daemon.on('connection', (socket, request) => {
  assert.equal(request.headers.authorization, 'Bearer ' + voiceToken);
  socket.send(JSON.stringify({ type: 'ready', protocol: 2, sample_rate: 16000, channels: 1, format: 'opus', audio_encoding: 'opus_v1', framing: 'sequence_opus_v1', max_seconds: 300, max_encoded_bytes: 2097152, resume: true, accepted_frames: 0, finished: false }));
  socket.on('message', (bytes, binary) => {
    if (binary) return;
    const message = JSON.parse(String(bytes));
    if (message.type === 'finish') socket.send(JSON.stringify({ type: 'final', text: 'Dictated directly into Herdr' }));
    if (message.type === 'ack') voiceAcks++;
  });
});
const origin = 'http://127.0.0.1:' + (process.env.TEST_PORT || '3169');
const mount = '/terminal', base = origin + mount;
const root = new URL('../', import.meta.url).pathname;
const backend = spawn(root + 'target/debug/termai', [], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, HOST: '127.0.0.1', PORT: new URL(origin).port, TERMAI_BASE_PATH: mount,
  TERMAI_ALLOWED_HOSTS: '127.0.0.1', TERMAI_ALLOWED_ORIGINS: origin,
  TERMAI_DATA_DIR: fixture.directory + '/termai', TERMAI_NO_RC: '1', TERMAI_CWD: fixture.directory,
  HOME: fixture.directory, PATH: fixture.directory + ':' + process.env.PATH, TERMAI_TOKEN: '',
  HERDR_SOCKET_PATH: fixture.socketPath, TERMAI_PUSH_CONTACT: 'https://example.com/termai',
  TERMAI_VOXTYPE_TOKEN_FILE: fixture.directory + '/voice-token',
  TERMAI_VOXTYPE_URL: 'ws://127.0.0.1:' + daemon.address().port + '/v1/dictate',
} });
let logs = '';
backend.stdout.on('data', data => logs += data);
backend.stderr.on('data', data => logs += data);
const sockets = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (const end = Date.now() + 12000; Date.now() < end;) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Timed out: ' + label);
}
let owner;
async function request(path, input, credential = owner) {
  const response = await fetch(base + '/api/' + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, ...(credential ? { Authorization: 'Bearer ' + credential } : {}),
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return { status: response.status, value: await response.json() };
}
async function api(path, input) {
  const response = await request(path, input);
  assert.equal(response.status, 200, path + ': ' + JSON.stringify(response.value));
  return response.value;
}
async function open(terminal = '') {
  const query = terminal ? '?terminalId=' + terminal : '';
  const { ticket } = await api('herdr/ticket' + query, {});
  const inbox = [], ws = new WebSocket(base.replace('http:', 'ws:') + '/herdr/ws?ticket=' + ticket + (terminal ? '&terminalId=' + terminal : ''), { origin });
  ws.on('message', bytes => inbox.push(JSON.parse(String(bytes))));
  ws.on('error', () => {});
  sockets.push(ws);
  await once(ws, 'open');
  return { ws, inbox, resize(cols, rows, mobile = true) { ws.send(JSON.stringify({ type: 'resize', cols, rows, mobile })); } };
}
async function rejected(url) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    ws.once('open', () => { ws.close(); reject(new Error('Invalid Herdr ticket accepted')); });
    ws.once('error', error => { assert.match(error.message, /403/); resolve(); });
  });
}
try {
  await until(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } }, 'Rust backend startup');
  for (const path of ['herdr/snapshot', 'herdr/action', 'herdr/ticket', 'herdr/captured', 'notifications/key', 'notifications/subscribe', 'notifications/unsubscribe', 'notifications/unwatch', 'herdr/notifications']) {
    assert.equal((await request(path, {}, undefined)).status, 401);
  }
  const token = (await readFile(fixture.directory + '/termai/pairing-token', 'utf8')).trim();
  owner = (await request('connect', { noSession: true, token }, undefined)).value.accessToken;
  assert.equal((await request('herdr/snapshot?herdrSession=../../escape')).status, 400);
  assert.equal((await request('herdr/action', { action: 'rename', terminalId: 'missing', name: 'x' })).status, 400);
  assert.equal((await api('notifications/key')).publicKey.length, 87);
  const { ticket } = await api('herdr/ticket', {});
  const url = base.replace('http:', 'ws:') + '/herdr/ws?ticket=' + ticket;
  const single = new WebSocket(url, { origin }); await once(single, 'open'); single.close();
  await rejected(url);
  const wrong = await api('herdr/ticket?herdrSession=work', {});
  await rejected(base.replace('http:', 'ws:') + '/herdr/ws?ticket=' + wrong.ticket);

  const metadata = await open();
  await until(() => metadata.inbox.some(m => m.type === 'snapshot'), 'metadata snapshot');
  assert.equal(metadata.inbox.find(m => m.type === 'snapshot').snapshot.agents[0].name, 'api-refactor');
  await api('herdr/action', { action: 'rename', terminalId: 'term_0', name: 'API routes' });
  assert.equal(fixture.snapshot.agents[0].name, 'api-refactor');
  await until(() => metadata.inbox.some(m => m.type === 'snapshot' && m.snapshot.agents[0].name === 'API routes'), 'subscription refresh after rename');

  const desktop = await open('term_0'), phone = await open('term_0');
  await until(() => desktop.inbox.some(m => m.type === 'screen') && phone.inbox.some(m => m.type === 'screen'), 'shared terminal history');
  desktop.resize(120, 40, false); phone.resize(30, 40, false);
  desktop.ws.send(JSON.stringify({ type: 'input', data: 'desktop' }));
  phone.ws.send(JSON.stringify({ type: 'input', data: 'mobile' }));
  await until(() => fixture.actions.filter(a => a.method === 'pane.send_text').length === 2, 'simultaneous input');
  assert.deepEqual(fixture.actions.filter(a => a.method === 'pane.send_text').map(a => a.params.text).sort(), ['desktop', 'mobile']);
  assert.ok(!fixture.actions.some(a => /resize|attach/.test(a.method)));
  fixture.setScreen(0, 'One long logical line ' + 'abc'.repeat(80) + '\nHistory');
  await until(() => desktop.inbox.some(m => m.type === 'screen' && m.text.includes('History')) && phone.inbox.some(m => m.type === 'screen' && m.text.includes('History')), 'passive ANSI history');
  phone.ws.send(JSON.stringify({ type: 'command', id: 'cmd', command: 'review' }));
  await until(() => phone.inbox.some(m => m.type === 'result' && m.accepted), 'command result');
  assert.equal(fixture.actions.filter(a => a.method === 'pane.send_text').at(-1).params.text, 'review\r');
  const dictationId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  phone.ws.send(JSON.stringify({ type: 'dictation', action: 'start', id: dictationId, target: 'program', prompt: 1, revision: 2 }));
  await until(() => phone.inbox.some(m => m.type === 'dictation' && m.state === 'ready'), 'Herdr dictation ready');
  const frame = Buffer.alloc(22); frame[8] = 1; frame[9] = 3; frame.writeUInt32BE(160, 12); frame[16] = 1; frame.writeUInt16BE(3, 17); frame.set([1, 2, 3], 19);
  phone.ws.send(frame);
  phone.ws.send(JSON.stringify({ type: 'dictation', action: 'finish', id: dictationId }));
  await until(() => phone.inbox.some(m => m.type === 'pasted' && m.text === 'Dictated directly into Herdr'), 'Herdr final transcript insertion');
  await until(() => voiceAcks === 1, 'acknowledgement after remote insertion');
  assert.equal(fixture.actions.filter(a => a.method === 'pane.send_input').at(-1).params.text, 'Dictated directly into Herdr');
  phone.ws.send(JSON.stringify({ type: 'dictation', action: 'start', id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', target: 'program', prompt: 1, revision: 2 }));
  await until(() => phone.inbox.some(m => m.type === 'dictation' && m.id.startsWith('eeee') && m.state === 'error'), 'stale dictation rejected');
  phone.resize(42, 31);
  await until(() => desktop.inbox.some(m => m.width === 42 && m.height === 31), 'mobile controller frame');
  phone.resize(38, 17);
  await until(() => desktop.inbox.some(m => m.width === 38 && m.height === 17), 'controller resize');
  assert.equal(fixture.actions.filter(a => a.method === 'fixture.terminal.open' && a.params.mode === 'control').length, 1);
  const tablet = await open('term_0'); tablet.resize(65, 25);
  await until(() => phone.inbox.some(m => m.width === 65), 'newest mobile geometry');
  tablet.ws.close();
  await until(() => phone.inbox.at(-1)?.width === 38, 'geometry returns to previous mobile owner');
  phone.resize(38, 17, false);
  await until(() => desktop.inbox.at(-1)?.width === 80, 'desktop geometry restored');
  assert.ok(fixture.actions.some(a => a.method === 'fixture.terminal.release'));
  phone.resize(41, 28);
  await until(() => desktop.inbox.at(-1)?.width === 41, 'mobile controller reopened');
  desktop.ws.send(JSON.stringify({ type: 'terminal-scroll', lines: -2, column: 1, row: 2 }));
  await delay(70);
  assert.ok(!fixture.actions.some(a => a.method === 'fixture.terminal.scroll'), 'Observers cannot scroll another viewer’s controller');
  phone.ws.send(JSON.stringify({ type: 'terminal-scroll', lines: -3, column: 99, row: 99 }));
  await until(() => fixture.actions.filter(a => a.method === 'fixture.terminal.scroll').length === 3, 'wheel events preserve every line');
  const scrolling = fixture.actions.filter(a => a.method === 'fixture.terminal.scroll');
  for (const action of scrolling) assert.deepEqual(action.params, { terminalId: 'term_0', type: 'terminal.scroll', source: 'wheel', direction: 'up', lines: 1, column: 40, row: 27 });
  await fixture.setFrame(0, { type: 'terminal.frame', encoding: 'ansi', width: 41, height: 28, full: false, bytes: 'ZA==' });
  await until(() => phone.inbox.at(-1)?.full === false, 'incremental frame received');
  const joining = await open('term_0');
  await until(() => joining.inbox.some(m => m.type === 'screen'), 'new incremental-stream viewer');
  assert.ok(!joining.inbox.some(m => m.type === 'herdr-frame'), 'A partial frame cannot serve as a new baseline');
  joining.resize(41, 28);
  joining.ws.send(JSON.stringify({ type: 'herdr-frame-request' }));
  await until(() => joining.inbox.some(m => m.type === 'herdr-frame' && m.full === true && m.width === 41), 'full repaint without replacing controller');
  phone.resize(55, 25);
  await until(() => joining.inbox.at(-1)?.width === 55, 'new owner geometry');
  joining.ws.send(JSON.stringify({ type: 'herdr-frame-request' }));
  await until(() => fixture.actions.filter(a => a.method === 'fixture.terminal.resize').at(-1)?.params.cols === 55, 'repaint uses current owner geometry');
  joining.resize(41, 28, false); joining.ws.close();
  phone.resize(41, 28);
  await until(() => desktop.inbox.at(-1)?.width === 41, 'geometry settled before release');
  phone.ws.close();
  await until(() => desktop.inbox.at(-1)?.width === 80, 'mobile disconnect releases controller');
  const invalid = await open('term_0'); invalid.resize(0, 40);
  assert.equal((await once(invalid.ws, 'close'))[0], 1008);
  assert.ok(!fixture.actions.some(a => a.method === 'fixture.terminal.resize' && a.params.cols === 0));

  fixture.snapshot.agents[1].foreground_cwd = '/workspace/sub project';
  assert.equal((await request('herdr/action', { action: 'create-space', workspaceId: 'closed' })).status, 400);
  const created = await api('herdr/action', { action: 'create-space', workspaceId: 'w1', terminalId: 'term_1' });
  assert.deepEqual(fixture.actions.find(a => a.method === 'workspace.create').params, { focus: false, source_workspace_id: 'w1', cwd: '/workspace/sub project' });
  const space = (await api('herdr/snapshot')).spaces.find(s => s.id === created.workspaceId);
  assert.equal(space.cwd, '/workspace/sub project'); assert.equal(space.selectedTerminalId, created.terminalId);
  await api('herdr/action', { action: 'move-space', workspaceId: created.workspaceId, beforeWorkspaceId: 'w1' });
  assert.equal((await api('herdr/snapshot')).spaces[0].id, created.workspaceId);
  assert.equal((await request('herdr/action', { action: 'move-space', workspaceId: 'w1', beforeWorkspaceId: 'w1' })).status, 400);
  await api('herdr/action', { action: 'rename-space', workspaceId: created.workspaceId, name: 'Review' });
  assert.equal((await api('herdr/snapshot')).spaces[0].name, 'Review');
  const agent = await api('herdr/action', { action: 'create', workspaceId: created.workspaceId, kind: 'codex', name: 'Created agent' });
  assert.equal((await api('herdr/snapshot')).agents.find(a => a.terminalId === agent.terminalId).name, 'Created agent');
  fixture.rejectClose('Server refused to close pane.');
  assert.equal((await request('herdr/action', { action: 'close', terminalId: agent.terminalId })).status, 400);
  assert.ok((await api('herdr/snapshot')).terminals.some(t => t.terminalId === agent.terminalId));
  fixture.rejectClose(); await api('herdr/action', { action: 'close', terminalId: agent.terminalId });
  assert.ok((await api('herdr/snapshot')).terminals.some(t => t.terminalId === created.terminalId));
  await api('herdr/action', { action: 'close-space', workspaceId: created.workspaceId });
  assert.deepEqual(fixture.actions.filter(a => a.method === 'workspace.close').at(-1).params, { workspace_id: created.workspaceId, close_group: false });
  fixture.snapshot.agents[0].terminal_id = 'replacement'; fixture.snapshot.panes[0].terminal_id = 'replacement';
  desktop.ws.send(JSON.stringify({ type: 'input', data: 'stale-input' }));
  await until(() => desktop.inbox.some(m => m.type === 'reading-error' && /ended or moved/.test(m.message)), 'stale pane input rejected');
  assert.ok(!fixture.actions.some(a => a.method === 'pane.send_text' && a.params.text === 'stale-input'));
  const source = await api('sessions', { files: true });
  const connected = await api('herdr/connect', { source: source.id, session: '' });
  assert.equal(connected.herdrSource, source.id);
  const sourceQuery = '?herdrSource=' + source.id;
  const sourceTicket = await api('herdr/ticket' + sourceQuery, {});
  const scoped = new WebSocket(base.replace('http:', 'ws:') + '/herdr/ws' + sourceQuery + '&ticket=' + sourceTicket.ticket, { origin });
  sockets.push(scoped); await once(scoped, 'open');
  const closed = once(scoped, 'close'); await api('sessions/close?session=' + source.id, {});
  assert.equal((await closed)[0], 1000);
  assert.equal((await request('herdr/snapshot' + sourceQuery)).status, 404);
  console.log('PASS Rust Herdr HTTP/WebSocket: mounted authentication, scoped single-use tickets, subscriptions, actions, shared input, mobile geometry, releases, stale panes, and source cleanup.');
} catch (error) {
  // Redact credentials from diagnostics before returning a failing test.
  error.message += '\nBackend diagnostics: ' + logs.replace(/Pairing token: .*/g, 'Pairing token: [redacted]');
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  backend.kill('SIGTERM'); await once(backend, 'exit');
  await fixture.close();
  for (const client of daemon.clients) client.terminate();
  await new Promise(resolve => daemon.close(resolve));
}
