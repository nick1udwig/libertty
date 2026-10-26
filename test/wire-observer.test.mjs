import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installWireObserver } from './wire-observer.mjs';

test('shell readiness waits for complete Readline mode sequences on the current connection', async () => {
  const window = {};
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = Socket.OPEN;
    url = 'ws://localhost/ws?session=fixture';
  }
  await installWireObserver({ addInitScript({ content }) {
    runInNewContext(content, { window, WebSocket: Socket, TextEncoder, TextDecoder, URL });
  } });
  const first = new window.WebSocket(), second = new window.WebSocket();
  const message = async (socket, data) => {
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    await new Promise(setImmediate);
  };
  const state = (socket, prompt, ready = true) => message(socket, { type: 'state', state: { prompt, ready } });
  const output = (socket, data) => message(socket, { type: 'output', data });
  await state(first, 1);
  assert.equal(window.__testReadlineReady, false, 'A prompt marker does not prove raw input is ready');
  await output(first, '\x1b[?200');
  assert.equal(window.__testReadlineReady, false);
  await output(first, '4h');
  assert.equal(window.__testReadlineReady, true, 'Readline can enable input across output frames');
  await state(first, 1);
  assert.equal(window.__testReadlineReady, true, 'Repeated state reports preserve the current input mode');
  await output(first, '\x1b[?2004l');
  assert.equal(window.__testReadlineReady, false, 'Running commands disable Readline input');
  await state(first, 2);
  assert.equal(window.__testReadlineReady, false);
  await output(first, '\x1b[?2004h');
  assert.equal(window.__testReadlineReady, true);
  await state(second, 2);
  assert.equal(window.__testReadlineReady, true, 'Resuming the same prompt retains its confirmed input mode');
  await output(first, '\x1b[?2004l');
  assert.equal(window.__testReadlineReady, true, 'Old connections cannot change resumed input');
  await state(second, 3);
  assert.equal(window.__testReadlineReady, false, 'A newer prompt must enable its own input');
  await output(first, '\x1b[?2004h');
  assert.equal(window.__testReadlineReady, false, 'Old connections cannot authorize new input');
  await output(second, '\x1b[?2004h');
  assert.equal(window.__testReadlineReady, true);
  await state(second, 3, false);
  assert.equal(window.__testReadlineReady, false);
  await state(second, 3);
  await output(second, '\x1b[?2004h');
  const other = new window.WebSocket(); other.url = 'ws://localhost/ws?session=other';
  await state(other, 3);
  assert.equal(window.__testReadlineReady, false, 'Another session cannot inherit the old input mode');
  await output(other, '\x1b[?200');
  const resumed = new window.WebSocket(); resumed.url = other.url;
  await state(resumed, 3);
  await output(resumed, '4h');
  assert.equal(window.__testReadlineReady, true, 'A mode sequence can finish after reconnecting to the same shell');
});
