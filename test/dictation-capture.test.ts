import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DictationCapture } from '../src/dictation-capture.ts';
import { DictationAudio } from '../src/dictation-audio.ts';
import { opusFrame } from '../src/voxtype-audio.ts';

const encoded = opusFrame(0, [new Uint8Array([248, 255, 254])], 0, 1600);
function environment(t: TestContext, delayed = false) {
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false, stops: 0, stop() { this.readyState = 'ended'; this.stops++; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let grant!: (stream: unknown) => void;
  const permission = delayed ? new Promise(resolve => { grant = resolve; }) : Promise.resolve(stream);
  let context!: Context, worker!: Encoder, processor!: Processor;
  class Context extends EventTarget {
    state = 'running';
    closes = 0;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    constructor() { super(); context = this; }
    async resume() { this.state = 'running'; }
    async close() { this.closes++; this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Processor extends EventTarget {
    port = {
      onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
      postMessage: (data: unknown) => {
        if (data === 'flush') queueMicrotask(() => this.port.onmessage?.({ data: 'flushed' }));
      },
    };
    constructor() { super(); processor = this; }
    connect() {}
    disconnect() {}
  }
  class Encoder {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    stops = 0;
    constructor() { worker = this; queueMicrotask(() => this.emit({ type: 'ready' })); }
    emit(data: unknown) { this.onmessage?.({ data }); }
    postMessage(data: { type: string }) {
      if (data.type === 'finish') queueMicrotask(() => {
        this.emit({ type: 'audio', frame: encoded });
        this.emit({ type: 'flushed' });
      });
    }
    terminate() { this.stops++; }
  }
  const values = {
    navigator: { mediaDevices: { getUserMedia: () => permission } },
    document: Object.assign(new EventTarget(), { hidden: false, baseURI: 'https://example.test/' }),
    window: { top: null }, AudioContext: Context, AudioWorkletNode: Processor, Worker: Encoder,
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  return { track, get context() { return context; }, get worker() { return worker; }, get processor() { return processor; }, grant: () => grant(stream) };
}
const events = () => ({ started() {}, level() {}, frame() {}, flushed() {}, finish() {}, changed() {}, notice() {}, failed: (message: string) => assert.fail(message) });

test('capture disposal releases a microphone granted after cancellation', async t => {
  const env = environment(t, true);
  const capture = new DictationCapture({ ...events(), started: () => assert.fail('cancelled start') });
  const starting = capture.start();
  capture.dispose(); capture.dispose();
  env.grant();
  await starting;
  assert.equal(env.track.stops, 1);
  assert.equal(env.context.closes, 1);
  assert.equal(env.worker.stops, 1);
});

test('flushing releases capture resources while encoded audio remains available for retry', async t => {
  const env = environment(t), audio = new DictationAudio();
  let flushed!: () => void;
  const finished = new Promise<void>(resolve => { flushed = resolve; });
  const capture = new DictationCapture({ ...events(), frame: frame => audio.append(frame), flushed });
  t.after(() => capture.dispose());
  await capture.start();
  capture.finish();
  await finished;
  capture.dispose();
  assert.equal(env.track.stops, 1);
  assert.equal(env.context.closes, 1);
  assert.equal(env.worker.stops, 1);
  env.worker.emit({ type: 'audio', frame: encoded });
  env.processor.port.onmessage?.({ data: new ArrayBuffer(16) });
  for (let attempt = 0; attempt < 2; attempt++) {
    audio.resume(0);
    const sent: ArrayBuffer[] = [];
    assert.equal(audio.upload(frame => { sent.push(frame); return true; }), true);
    assert.deepEqual(sent, [encoded]);
  }
});

test('negotiated sample limits trim the last chunk and finish without exceeding duration', async t => {
  const env = environment(t);
  let count = 0, finishes = 0;
  const capture = new DictationCapture({ ...events(), level: pcm => count += pcm.byteLength / 2, finish: () => finishes++ });
  t.after(() => capture.dispose());
  await capture.start();
  capture.limit(100);
  env.processor.port.onmessage?.({ data: new ArrayBuffer(3200) });
  assert.equal(count, 100);
  assert.equal(finishes, 1);
  env.processor.port.onmessage?.({ data: new ArrayBuffer(3200) });
  assert.equal(count, 100);
  assert.throws(() => capture.limit(99), /duration/);
});

test('capture transfers an unclipped PCM buffer after reading its level', async t => {
  const env = environment(t), pcm = new ArrayBuffer(3200);
  new DataView(pcm).setInt16(0, 1234, true);
  let levelRead = false;
  const capture = new DictationCapture({ ...events(), level: value => {
    assert.equal(value, pcm);
    assert.equal(new DataView(value).getInt16(0, true), 1234);
    levelRead = true;
  } });
  t.after(() => capture.dispose());
  await capture.start();
  env.worker.postMessage = (data: any) => {
    assert.equal(levelRead, true);
    assert.equal(data.pcm, pcm);
    const delivered = structuredClone(data, { transfer: [data.pcm] });
    assert.equal(new DataView(delivered.pcm).getInt16(0, true), 1234);
  };
  env.processor.port.onmessage?.({ data: pcm });
  assert.equal(pcm.byteLength, 0);
});
