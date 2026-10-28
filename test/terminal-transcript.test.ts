import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalTranscript } from '../src/terminal-transcript.ts';

test('normal history retains rolling lines and updates an unfinished line', () => {
  const transcript = new TerminalTranscript();
  transcript.observe('one\ntwo\nthree\nfour\nfive', true, 1);
  transcript.observe('one\ntwo\nthree\nfour\nfive updated', true, 2);
  transcript.observe('two\nthree\nfour\nfive updated\nsix', true, 3);
  assert.equal(transcript.records.length, 1);
  assert.equal(transcript.records[0].text, 'one\ntwo\nthree\nfour\nfive updated\nsix');
  assert.equal(transcript.observe(transcript.records[0].text, true), false);
});
test('full-screen redraws remain separate observed excerpts and missing history is explicit', () => {
  const transcript = new TerminalTranscript();
  transcript.observe('agent answer A', false, 1);
  transcript.observe('agent answer B', false, 2);
  assert.deepEqual(transcript.records.map(record => record.kind), ['excerpt', 'excerpt']);
  assert.match(transcript.text(), /gaps may exist/);
  transcript.observe('shell output', true, 3);
  transcript.observe('unrelated output', true, 4);
  assert.equal(transcript.records.at(-2)?.kind, 'gap');
  const ids = transcript.records.map(record => record.id);
  assert.equal(new Set(ids).size, ids.length);
});
test('retained output is bounded and restoring it keeps record identities', () => {
  const transcript = new TerminalTranscript();
  for (let i = 0; i < 100; i++) transcript.observe(String(i) + 'x'.repeat(20000), false, i);
  assert.ok(transcript.records.length <= 64);
  assert.ok(transcript.records.reduce((sum, record) => sum + record.text.length, 0) <= 512 * 1024);
  const restored = new TerminalTranscript(); restored.restore(transcript.records);
  const last = restored.records.at(-1)!.id;
  restored.observe('next', false);
  assert.equal(restored.records.at(-1)!.id, last + 1);
  assert.equal(transcript.records.at(-1)!.id, last);
});

test('backfill extends a snapshot without discarding the archive before a recovery gap', () => {
  const transcript = new TerminalTranscript();
  transcript.observe('before outage', true, 1);
  transcript.gap('Recovery gap', 2);
  transcript.observe('newest output', true, 3);
  transcript.backfill('missed output\nnewest output');
  assert.equal(transcript.records.length, 3);
  assert.equal(transcript.records[0].text, 'before outage');
  assert.equal(transcript.records[2].text, 'missed output\nnewest output');
});
