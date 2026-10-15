import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictationAudio } from '../src/dictation-audio.ts';
import { opusFrame, parseOpusFrame, MAX_OPUS_BYTES } from '../src/voxtype-audio.ts';
const frame = (seq: number, final = false) => opusFrame(seq, [new Uint8Array([248, 255, 254])], 0, final ? 1600 : undefined);
test('encoded speech survives upload and resumes from whole accepted frames or a daemon restart', () => {
  const audio = new DictationAudio(), original = Array.from({ length: 8 }, (_, i) => frame(i, i === 7));
  for (const bytes of original) audio.append(bytes);
  const sent: ArrayBuffer[] = [];
  assert.equal(audio.upload(bytes => { sent.push(bytes); return true; }), false);
  assert.equal(sent.length, 4);
  audio.resume(2);
  while (!audio.upload(bytes => { sent.push(bytes); return true; })) {}
  assert.deepEqual(sent.slice(4), original.slice(2));
  audio.resume(0);
  const replay: number[] = [];
  while (!audio.upload(bytes => { replay.push(parseOpusFrame(new Uint8Array(bytes)).sequence); return true; })) {}
  assert.deepEqual(replay, [0, 1, 2, 3, 4, 5, 6, 7]);
  audio.resume(8, true);
  assert.equal(audio.upload(() => assert.fail('A finished recording must not resend audio')), true);
});
test('failed sends retain their frame and invalid checkpoints cannot discard recorded speech', () => {
  const audio = new DictationAudio(), bytes = frame(0, true); audio.append(bytes);
  assert.equal(audio.upload(() => false), false);
  for (const count of [-1, 0.5, 2]) assert.throws(() => audio.resume(count), /checkpoint/);
  assert.throws(() => audio.resume(0, true), /checkpoint/);
  assert.equal(audio.upload(value => { assert.equal(value, bytes); return true; }), true);
  assert.throws(() => audio.append(frame(3)), /limit/);
  audio.clear(); audio.append(bytes);
});
test('retained audio remains bounded to the negotiated two MiB recording limit', () => {
  const audio = new DictationAudio(); let bytes = 0, sequence = 0;
  while (true) {
    const value = opusFrame(sequence, Array.from({ length: 5 }, () => new Uint8Array(1275)), 0);
    if (bytes + value.byteLength > MAX_OPUS_BYTES) { assert.throws(() => audio.append(value), /limit/); break; }
    audio.append(value); bytes += value.byteLength; sequence++;
  }
});
