import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeWire, encodeWire, encodeAudio, wireProtocols, BINARY_PROTOCOL, GZIP_PROTOCOL, GZIP_FAST_PROTOCOL, constrainedLink } from '../src/wire.ts';
const envelope = (kind: number, bytes: Uint8Array) => { const value = new Uint8Array(bytes.length + 4); value.set([84, 77, 1, kind]); value.set(bytes, 4); return value.buffer; };
test('wire decoder preserves compressed Unicode output, raw ANSI frames and legacy JSON', async () => {
  const payload = new Uint8Array(8 + new TextEncoder().encode('こんにちは\x1b[0m\r\n').length);
  new DataView(payload.buffer).setFloat64(0, Number.MAX_SAFE_INTEGER, true); payload.set(new TextEncoder().encode('こんにちは\x1b[0m\r\n'), 8);
  const expected = { type: 'output', seq: Number.MAX_SAFE_INTEGER, data: 'こんにちは\x1b[0m\r\n' };
  assert.deepEqual(await decodeWire(envelope(1, payload)), expected);
  assert.deepEqual(await decodeWire(envelope(129, gzipSync(payload))), expected);
  assert.deepEqual(await decodeWire(JSON.stringify(expected)), expected);
  const frame = await decodeWire(envelope(2, new Uint8Array([40, 0, 30, 0, 1, 0, 27, 255])));
  assert.deepEqual(frame, { type: 'herdr-frame', width: 40, height: 30, full: true, bytes: new Uint8Array([0, 27, 255]) });
});
test('compact client controls keep sequence, geometry, input and audio distinct', () => {
  const input = encodeWire({ type: 'input', data: '世界\r' }, BINARY_PROTOCOL) as ArrayBuffer;
  assert.equal(new TextDecoder().decode(new Uint8Array(input).subarray(4)), '世界\r');
  const ack = encodeWire({ type: 'ack', seq: Number.MAX_SAFE_INTEGER }, GZIP_FAST_PROTOCOL) as ArrayBuffer;
  assert.equal(new DataView(ack).getFloat64(4, true), Number.MAX_SAFE_INTEGER);
  assert.deepEqual(new Uint8Array(encodeWire({ type: 'resize', cols: 40, rows: 30, mobile: true }, BINARY_PROTOCOL) as ArrayBuffer), new Uint8Array([84, 77, 1, 5, 40, 0, 30, 0, 1]));
  assert.deepEqual(encodeAudio(new Uint8Array([0, 255]), BINARY_PROTOCOL), new Uint8Array([84, 77, 1, 6, 0, 255]));
  assert.equal(encodeWire({ type: 'input', data: 'legacy' }, ''), '{"type":"input","data":"legacy"}');
  const numbered = new Uint8Array(encodeWire({ type: 'input', data: '界', seq: 7 }, BINARY_PROTOCOL) as ArrayBuffer);
  assert.deepEqual([...numbered.subarray(0, 4)], [84, 77, 1, 8]);
  assert.equal(new DataView(numbered.buffer).getFloat64(4, true), 7); assert.equal(new TextDecoder().decode(numbered.subarray(12)), '界');
  assert.equal(typeof encodeWire({ type: 'resize', cols: 1.5, rows: 30 }, BINARY_PROTOCOL), 'string');
});
test('malformed headers, sequences, UTF-8 and compressed streams reject without poisoning later messages', async () => {
  for (const bytes of [new Uint8Array([84, 77, 2, 0]), new Uint8Array([84, 77, 1, 7]), new Uint8Array([84, 77, 1, 128, 255])]) await assert.rejects(decodeWire(bytes.buffer));
  const payload = new Uint8Array(9); new DataView(payload.buffer).setFloat64(0, NaN, true);
  await assert.rejects(decodeWire(envelope(1, payload)), /sequence/);
  new DataView(payload.buffer).setFloat64(0, 1, true); payload[8] = 255;
  await assert.rejects(decodeWire(envelope(1, payload)), /encoded data/);
  assert.deepEqual(await decodeWire('{"type":"state"}'), { type: 'state' });
});
test('compression negotiation uses capability and connection profile', () => {
  assert.deepEqual(wireProtocols(undefined), []);
  assert.equal(constrainedLink({ effectiveType: '3g' }), true);
  assert.equal(constrainedLink({ downlink: 1 }), true);
  assert.equal(constrainedLink({ effectiveType: '4g', downlink: 50 }), false);
  assert.deepEqual(wireProtocols([BINARY_PROTOCOL]), [BINARY_PROTOCOL]);
  assert.ok(wireProtocols([BINARY_PROTOCOL, GZIP_PROTOCOL, GZIP_FAST_PROTOCOL]).includes(BINARY_PROTOCOL));
});

test('acknowledged frames retain their sequence through binary and gzip encoding', async () => {
  const payload = new Uint8Array(16); const view = new DataView(payload.buffer);
  view.setFloat64(0, Number.MAX_SAFE_INTEGER, true); view.setUint16(8, 40, true); view.setUint16(10, 30, true);
  payload.set([1, 27, 0, 255], 12);
  const expected = { type: 'herdr-frame', seq: Number.MAX_SAFE_INTEGER, width: 40, height: 30, full: true, bytes: new Uint8Array([27, 0, 255]) };
  assert.deepEqual(await decodeWire(envelope(7, payload)), expected);
  assert.deepEqual(await decodeWire(envelope(135, gzipSync(payload))), expected);
  view.setFloat64(0, -1, true);
  await assert.rejects(decodeWire(envelope(7, payload)), /sequence/);
});
