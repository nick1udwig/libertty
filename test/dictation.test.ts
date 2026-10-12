import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('worklet produces bounded little-endian 16k PCM across 44.1k and 48k block boundaries', () => {
  for (const rate of [44100, 48000, 16000]) {
    let Processor: any;
    const frames: any[] = [];
    vm.runInNewContext(readFileSync(new URL('../public/dictation-worklet.js', import.meta.url), 'utf8'), {
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: unknown) => frames.push(message) }; },
      sampleRate: rate, registerProcessor: (_name: string, type: any) => { Processor = type; },
    });
    const processor = new Processor();
    for (let i = 0; i < rate; i += 128) { processor.process([[new Float32Array(Math.min(128, rate - i)).fill(0.5)]]); processor.port.onmessage({ data: { type: 'consumed' } }); }
    processor.port.onmessage();
    const pcm = frames.filter(value => value !== 'flushed');
    assert.equal(pcm.reduce((sum, value) => sum + value.byteLength, 0), 32000);
    assert.ok(pcm.every(value => value.byteLength <= 3200));
    assert.equal(new DataView(pcm[0]).getInt16(0, true), 16384);
    assert.equal(frames.at(-1), 'flushed');
  }
});

test('capture boosts quiet audio without boosting silence or clipping louder speech', () => {
  function capture(amplitudes: number[]) {
    let Processor: any; const frames: ArrayBuffer[] = [];
    vm.runInNewContext(readFileSync(new URL('../public/dictation-worklet.js', import.meta.url), 'utf8'), {
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: unknown) => { if (typeof message !== 'string') frames.push(message as ArrayBuffer); } }; },
      sampleRate: 48000, registerProcessor: (_name: string, type: any) => { Processor = type; },
    });
    const processor = new Processor(); let i = 0;
    for (const amplitude of amplitudes) for (let block = 0; block < 375; block++) {
      const audio = Float32Array.from({ length: 128 }, () => Math.sin(2 * Math.PI * 440 * i++ / 48000) * amplitude);
      processor.process([[audio]]); processor.port.onmessage({ data: { type: 'consumed' } });
    }
    processor.port.onmessage();
    return frames.flatMap(frame => Array.from({ length: frame.byteLength / 2 }, (_, i) => new DataView(frame).getInt16(i * 2, true) / 32768));
  }
  const rms = (values: number[]) => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
  assert.equal(rms(capture([0])), 0);
  assert.ok(rms(capture([0.0001]).slice(-4000)) < 0.00009, 'noise floor stays unamplified');
  const quiet = rms(capture([0.01]).slice(-4000));
  assert.ok(quiet > 0.025 && quiet < 0.029, 'quiet speech receives close to 4× gain');
  const loud = capture([0.01, 0.9]);
  assert.ok(Math.max(...loud.map(Math.abs)) <= 0.951, 'sudden loud speech keeps peak headroom');
  assert.ok(rms(loud.slice(-4000)) > 0.60 && rms(loud.slice(-4000)) < 0.66, 'loud speech retains its original level');
});
