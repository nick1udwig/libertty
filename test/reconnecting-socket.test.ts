import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ReconnectingSocket } from '../src/reconnecting-socket.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext) {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: MessageEvent) => void;
    onclose?: (event: CloseEvent) => void;
    autoPong = true;
    sent: string[] = [];
    send(data: string) { this.sent.push(data); if (this.autoPong) this.message('{"type":"pong"}'); }
    url: URL;
    constructor(url: URL) { this.url = url; sockets.push(this); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data: string) { this.onmessage?.({ data } as MessageEvent); }
    closed(code = 1006) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let available = true, opens = 0, closes = 0;
  const messages: string[] = [], errors: unknown[] = [], signals: AbortSignal[] = [], tokens: (string | undefined)[] = [];
  const url = new URL('ws://localhost/ws');
  const behavior = {
    prepare: async (_signal: AbortSignal, _token?: string) => url,
    close: (_event?: CloseEvent) => true,
    stalled: [] as number[],
    heartbeat: true,
    error: (_error: unknown) => true,
  };
  const connection = new ReconnectingSocket({
    heartbeat: () => behavior.heartbeat,
    stalled: seconds => behavior.stalled.push(seconds),
    available: () => available,
    prepare: (signal, token) => { signals.push(signal); tokens.push(token); return behavior.prepare(signal, token); },
    open: () => { opens++; },
    message: event => { messages.push(event.data); if (event.data === 'state') connection.ready(); },
    close: event => { closes++; return behavior.close(event); },
    error: error => { errors.push(error); return behavior.error(error); },
  });
  t.after(() => { available = false; connection.suspend(); globalThis.WebSocket = original; });
  return { connection, sockets, behavior, url, signals, tokens, messages, errors,
    visible: (value: boolean) => { available = value; }, counts: () => ({ opens, closes }) };
}

// Let asynchronous authorization finish after advancing the mocked timers.
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('a stalled authorization is aborted and retried even if it ignores cancellation', async t => {
  const f = fixture(t), pending = deferred<URL>();
  f.behavior.prepare = () => pending.promise;
  const first = f.connection.connect();
  t.mock.timers.tick(15000);
  assert.equal(f.signals[0].aborted, true);
  assert.equal(f.errors.length, 1);
  f.behavior.prepare = async () => f.url;
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.sockets.length, 1);
  pending.resolve(new URL('ws://localhost/obsolete-ticket')); await first;
  assert.equal(f.sockets.length, 1, 'a late ticket cannot replace the current socket');
  assert.equal(f.connection.socket, f.sockets[0]);
});

test('a stalled WebSocket handshake is replaced and its late callbacks are ignored', async t => {
  const f = fixture(t);
  await f.connection.connect();
  const stale = f.sockets[0];
  t.mock.timers.tick(15000);
  assert.equal(stale.readyState, 2);
  t.mock.timers.tick(1000); await flush();
  const current = f.sockets[1]; current.open(); current.message('state');
  stale.open(); stale.message('obsolete state'); stale.closed();
  assert.equal(f.connection.socket, current);
  assert.deepEqual(f.counts(), { opens: 1, closes: 1 });
  assert.deepEqual(f.messages, ['state']);
  t.mock.timers.tick(60000); await flush();
  assert.equal(f.sockets.length, 2);
});

test('an open socket without terminal state still times out and retains retry backoff', async t => {
  const f = fixture(t);
  await f.connection.connect(); f.sockets[0].open();
  t.mock.timers.tick(15000);
  t.mock.timers.tick(1000); await flush(); f.sockets[1].open();
  t.mock.timers.tick(15000);
  t.mock.timers.tick(1499); await flush();
  assert.equal(f.sockets.length, 2);
  t.mock.timers.tick(1); await flush();
  f.sockets[2].open(); f.sockets[2].message('state'); f.sockets[2].closed();
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.sockets.length, 4, 'receiving state resets the retry delay');
});

test('duplicate connect events do not create competing handshakes or remove the deadline', async t => {
  const f = fixture(t);
  await f.connection.connect(); await f.connection.connect(); await f.connection.resume();
  assert.equal(f.sockets.length, 1);
  t.mock.timers.tick(15000);
  assert.equal(f.errors.length, 1);
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.sockets.length, 2);
});

test('backgrounding cancels a pending request and foreground recovery ignores its late rejection', async t => {
  const f = fixture(t), pending = deferred<URL>();
  f.behavior.prepare = () => pending.promise;
  const first = f.connection.connect();
  f.visible(false); f.connection.suspend();
  assert.equal(f.signals[0].aborted, true);
  f.behavior.prepare = async () => f.url;
  f.visible(true); await f.connection.resume(true);
  pending.reject(Object.assign(new Error('obsolete credential'), { status: 401 })); await first;
  assert.equal(f.errors.length, 0, 'obsolete authorization must not lock the new connection');
  assert.equal(f.sockets.length, 1);
});

test('foreground recovery starts immediately while the previous socket is still closing', async t => {
  const f = fixture(t);
  await f.connection.connect(); const stale = f.sockets[0]; stale.open(); stale.message('state');
  f.visible(false); f.connection.suspend();
  assert.equal(stale.readyState, 2);
  f.visible(true); await f.connection.resume(true);
  assert.equal(f.sockets.length, 2, 'no close event or retry timer is required');
  stale.closed();
  assert.equal(f.connection.socket, f.sockets[1]);
});

test('network recovery replaces a socket that still appears open', async t => {
  const f = fixture(t);
  await f.connection.connect(); f.sockets[0].open(); f.sockets[0].message('state');
  await f.connection.resume(true);
  assert.equal(f.sockets[0].readyState, 1, 'keep the old connection through the replacement handshake');
  assert.equal(f.connection.socket, f.sockets[1]);
  f.sockets[1].open();
  assert.equal(f.sockets[0].readyState, 2);
  assert.deepEqual(f.counts(), { opens: 2, closes: 1 });
});

test('retryable failures wait for visibility and never overlap foreground recovery', async t => {
  const f = fixture(t);
  f.behavior.prepare = async () => { throw new Error('offline'); };
  await f.connection.connect();
  f.visible(false); t.mock.timers.tick(1000); await flush();
  assert.equal(f.signals.length, 1);
  f.visible(true); f.behavior.prepare = async () => f.url;
  await f.connection.resume(true); f.sockets[0].open(); f.sockets[0].message('state');
  t.mock.timers.tick(60000); await flush();
  assert.equal(f.sockets.length, 1);
});

test('locked and ended sessions stop automatic retries until explicitly authorized', async t => {
  const f = fixture(t);
  f.behavior.error = () => false;
  for (const status of [401, 404]) {
    f.behavior.prepare = async () => { throw Object.assign(new Error('terminal unavailable'), { status }); };
    await f.connection.connect();
    t.mock.timers.tick(60000); await flush(); await f.connection.resume(true);
    assert.equal(f.sockets.length, status === 401 ? 0 : 1);
    f.behavior.prepare = async () => f.url;
    await f.connection.connect('fresh pairing');
    assert.equal(f.tokens.at(-1), 'fresh pairing');
    f.connection.suspend();
  }
});

test('another-tab close stops reconnecting instead of reclaiming the terminal', async t => {
  const f = fixture(t);
  f.behavior.close = event => event?.code !== 4001;
  await f.connection.connect(); f.sockets[0].closed(4001);
  t.mock.timers.tick(60000); await flush(); await f.connection.resume(true);
  assert.equal(f.sockets.length, 1);
  await f.connection.connect();
  assert.equal(f.sockets.length, 2);
});

// A link can stop carrying data while WebSocket still reports OPEN.
test('silent stalls retain the screen connection until a replacement opens', async t => {
  const f = fixture(t);
  await f.connection.connect(); const old = f.sockets[0]; old.open(); old.message('state'); old.autoPong = false;
  t.mock.timers.tick(2000); await flush();
  assert.deepEqual(old.sent, ['{"type":"ping"}']);
  t.mock.timers.tick(2000); await flush();
  assert.deepEqual(f.behavior.stalled, [4]);
  assert.equal(f.sockets.length, 2);
  assert.equal(old.readyState, 1);
  assert.equal(f.connection.healthy, false);
  old.message('obsolete state'); old.closed(4001);
  assert.deepEqual(f.messages, ['state']);
  f.sockets[1].open(); f.sockets[1].message('state');
  assert.equal(old.readyState, 2);
  assert.equal(f.connection.healthy, true);
});

test('incoming traffic prevents false stalls and heartbeat replies stay internal', async t => {
  const f = fixture(t);
  await f.connection.connect(); const socket = f.sockets[0]; socket.open(); socket.message('state');
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(2000); await flush(); }
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.messages, ['state']);
  assert.deepEqual(f.behavior.stalled, []);
  f.connection.suspend();
  t.mock.timers.tick(60000); await flush();
  assert.equal(f.sockets.length, 1);
});

test('live output and repeated state updates cannot conceal missing heartbeat replies', async t => {
  const f = fixture(t);
  await f.connection.connect(); const socket = f.sockets[0]; socket.open(); socket.message('state'); socket.autoPong = false;
  for (let i = 0; i < 4; i++) {
    socket.message('live output'); socket.message('state');
    t.mock.timers.tick(1000); await flush();
  }
  assert.deepEqual(socket.sent, ['{"type":"ping"}']);
  assert.deepEqual(f.behavior.stalled, [4]);
  assert.equal(f.sockets.length, 2);
});

test('a reply queued behind arriving output gets the full deadline without concealing a lost return path', async t => {
  const f = fixture(t);
  await f.connection.connect(); const socket = f.sockets[0]; socket.open(); socket.message('state'); socket.autoPong = false;
  for (let i = 0; i < 19; i++) { socket.message('bulk output'); t.mock.timers.tick(500); await flush(); }
  assert.deepEqual(socket.sent, ['{"type":"ping"}']);
  assert.deepEqual(f.behavior.stalled, [], 'output still arriving explains a delayed reply');
  socket.message('bulk output'); t.mock.timers.tick(500); await flush();
  assert.deepEqual(f.behavior.stalled, [10]);
  assert.equal(f.sockets.length, 2);
});

test('measured slow round trips extend the reply deadline on quiet links', async t => {
  const f = fixture(t);
  await f.connection.connect(); const socket = f.sockets[0]; socket.open(); socket.message('state'); socket.autoPong = false;
  const pong = () => socket.message('{"type":"pong"}');
  t.mock.timers.tick(2000); await flush();
  t.mock.timers.tick(1000); await flush(); pong();
  t.mock.timers.tick(2000); await flush();
  t.mock.timers.tick(2500); await flush(); pong();
  t.mock.timers.tick(2500); await flush();
  assert.equal(socket.sent.length, 3);
  t.mock.timers.tick(4000); await flush(); pong();
  assert.deepEqual(f.behavior.stalled, [], 'a four-second reply matches this link');
  assert.equal(f.sockets.length, 1);
  assert.deepEqual(f.messages, ['state'], 'replies stay internal');
});

test('typing or tapping retries immediately during backoff without overlapping attempts', async t => {
  const f = fixture(t);
  f.behavior.prepare = async () => { throw new Error('offline'); };
  await f.connection.connect();
  f.behavior.prepare = async () => f.url;
  f.connection.activity(); f.connection.activity(); await flush();
  assert.equal(f.sockets.length, 1);
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.sockets.length, 1);
});

test('older servers without heartbeat support never receive unsupported messages', async t => {
  const f = fixture(t); f.behavior.heartbeat = false;
  await f.connection.connect(); const socket = f.sockets[0]; socket.open(); socket.message('state');
  t.mock.timers.tick(60000); await flush();
  assert.deepEqual(socket.sent, []);
  assert.equal(f.sockets.length, 1);
});
