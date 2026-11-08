import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder, getPacketInfo } from 'libopus-wasm';
import { DictationEncoder } from '../src/dictation-encoder.ts';
import { MAX_OPUS_BYTES, opusFrame, parseOpusFrame, validateOpusFrame } from '../src/voxtype-audio.ts';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

async function encode(count: number) {
  const frames: ArrayBuffer[] = [];
  const encoder = await DictationEncoder.create(frame => frames.push(frame));
  try {
    for (let offset = 0; offset < count; offset += 1600) {
      const pcm = new ArrayBuffer(Math.min(1600, count - offset) * 2), view = new DataView(pcm);
      for (let i = 0; i < pcm.byteLength / 2; i++) view.setInt16(i * 2, Math.round(Math.sin((offset + i) * 2 * Math.PI * 440 / 16000) * 16000), true);
      encoder.audio(pcm);
    }
    encoder.finish();
    assert.throws(() => encoder.audio(new ArrayBuffer(2)));
    assert.throws(() => encoder.finish());
  } finally { encoder.close(); }
  return frames;
}

test('real Opus packets preserve exact source duration, lookahead and speech boundaries', async () => {
  for (const count of [0, 1, 319, 320, 321, 1599, 1600, 1601, 5001, 16000]) {
    const frames = await encode(count), decoder = await createDecoder({ sampleRate: 16000, channels: 1 });
    try {
      const decoded: number[] = []; let preSkip = 0;
      for (const [sequence, bytes] of frames.entries()) {
        const frame = parseOpusFrame(new Uint8Array(bytes));
        assert.equal(frame.sequence, sequence); assert.equal(frame.first, sequence === 0);
        assert.equal(frame.final, sequence === frames.length - 1);
        if (frame.first) { preSkip = frame.preSkip / 3; assert.ok(count === 0 ? preSkip === 0 : preSkip > 0); }
        for (const packet of frame.packets) {
          const info = await getPacketInfo(packet, { sampleRate: 16000 });
          assert.equal(info.channels, 1); assert.equal(info.samples, 320); assert.equal(info.durationMs, 20);
          decoded.push(...decoder.decode(packet));
        }
        if (frame.final) assert.equal(frame.totalSamples, count);
      }
      const restored = decoded.slice(preSkip, preSkip + count);
      assert.equal(restored.length, count);
      if (count >= 1600) {
        const energy = (samples: number[]) => samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
        assert.ok(energy(restored.slice(0, 160)) > 1e6, 'start of speech remains');
        assert.ok(energy(restored.slice(-160)) > 1e6, 'tail of speech remains');
      }
      if (count === 16000) assert.ok(frames.reduce((sum, frame) => sum + frame.byteLength, 0) < count * 2 * 0.2, 'wire audio is substantially smaller than PCM');
    } finally { decoder.free(); }
  }
});

test('Opus framing rejects legacy PCM, gaps in headers, truncation and trailing bytes', () => {
  assert.throws(() => parseOpusFrame(new Uint8Array(3200)));
  const valid = new Uint8Array(opusFrame(0, [new Uint8Array([1, 2, 3])], 312, 1));
  const malformed: Uint8Array[] = [valid.subarray(0, valid.length - 1), new Uint8Array([...valid, 0])];
  for (const [offset, value] of [[8, 2], [9, 7], [16, 6], [11, 1]]) { const bytes = valid.slice(); bytes[offset] = value; malformed.push(bytes); }
  for (const bytes of malformed) { assert.throws(() => parseOpusFrame(bytes)); assert.throws(() => validateOpusFrame(bytes)); }
  assert.throws(() => opusFrame(1, [], 0));
  assert.ok(MAX_OPUS_BYTES < 16000 * 2 * 300);
});

test('capture fails explicitly when its eight-chunk encoder handoff is full', () => {
  let Processor: any; const messages: any[] = [];
  vm.runInNewContext(readFileSync(new URL('../public/dictation-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: unknown) => messages.push(message) }; },
    sampleRate: 16000, registerProcessor: (_name: string, type: any) => { Processor = type; },
  });
  const processor = new Processor();
  for (let i = 0; i < 1600 * 10; i += 128) processor.process([[new Float32Array(128).fill(0.5)]]);
  assert.equal(messages.filter(value => typeof value?.byteLength === 'number').length, 8);
  assert.equal(messages.filter(value => value?.type === 'error').length, 1);
  assert.equal(processor.stopped, true);
});

test('metadata validation respects byte offsets and packet parsing borrows the original buffer', () => {
  const encoded = new Uint8Array(opusFrame(0, [new Uint8Array([1, 2]), new Uint8Array([3])], 312, 320));
  const storage = new Uint8Array(encoded.length + 7); storage.set(encoded, 4);
  const bytes = storage.subarray(4, 4 + encoded.length);
  const { packets, ...header } = parseOpusFrame(bytes);
  assert.deepEqual(validateOpusFrame(bytes), header);
  assert.deepEqual(packets.map(packet => [...packet]), [[1, 2], [3]]);
  assert.ok(packets.every(packet => packet.buffer === storage.buffer));
  assert.equal(packets[0].byteOffset, 23);
});
