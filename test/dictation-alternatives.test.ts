import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInline } from './support/inline-fixture.ts';
import { InputLine } from '../src/input-line.ts';

const repaired = (original: string, selected: string) => ({ accepted: true, candidates: selected === original ? [] : [{ command: selected, score: 100, changes: [] }], original, selected, revision: 1, prompt: 1 });
function fixture() {
  const replacements: string[] = [], requests: string[] = [], input: string[] = [], executed: string[] = [];
  const line = new InputLine(); line.reset();
  const inline = Object.assign(createInline({ state: () => ({ prompt: 1, ready: true, exited: false }) }), {
    line, generation: 0, literal: '', speech: '', choices: [], autoOpen: true, tapToSend: false,
    status: {}, render() {}, armInput() {}, term: { focus() {} },
    host: {
      state: () => ({ prompt: 1, ready: true, exited: false }),
      replace: async (text: string) => { replacements.push(text); return true; },
      // The backend applies its top hit and reports the alternatives in one repair transaction.
      repair: async (text: string) => { requests.push(text); return repaired(text, 'git init'); },
      raw: (text: string) => input.push(text), execute: (text: string) => executed.push(text),
    },
  });
  return { inline, line, replacements, requests, input, executed };
}

test('backend dictation uses the same top-hit and original/alternate flow without repasting its transcript', async () => {
  const f = fixture();
  await f.inline.externalPaste('Get in it.', false, true);
  assert.deepEqual(f.requests, ['Get in it.']);
  assert.deepEqual(f.replacements, [], 'The backend already applied its top hit');
  assert.deepEqual(f.input, []); assert.deepEqual(f.executed, []);
  assert.equal(f.inline.literal, 'Get in it.'); assert.equal(f.inline.selected, 'git init');
  assert.deepEqual(f.inline.choices, ['git init']); assert.equal(f.inline.open, true);
  await f.inline.choose('Get in it.');
  assert.deepEqual(f.replacements, ['Get in it.']);
  f.inline.tapToSend = true; await f.inline.choose('git init');
  assert.deepEqual(f.executed, ['git init']);
});

test('backend dictation includes existing prefix/suffix and obeys collapsed-alternatives setting', async () => {
  const f = fixture(); f.line.reset('echo  tail'); f.line.cursor = 5; f.inline.autoOpen = false;
  await f.inline.externalPaste('hello', false, true);
  assert.deepEqual(f.requests, ['echo hello tail']); assert.equal(f.inline.literal, 'echo hello tail');
  assert.equal(f.inline.open, false);
});

test('unchanged and failed repairs never resend an already-applied transcript', async () => {
  for (const failure of [false, true]) {
    const f = fixture();
    f.inline.host.repair = async (text: string) => { if (failure) throw new Error('offline'); return repaired(text, text); };
    await f.inline.externalPaste('hello', false, true);
    assert.deepEqual(f.replacements, []); assert.deepEqual(f.input, []);
    assert.equal(f.line.text, 'hello'); assert.equal(f.inline.literal, 'hello');
  }
});

test('installer and unknown shell buffers stay out of dictation repairs; long transcripts are not duplicated', async () => {
  const f = fixture();
  await f.inline.externalPaste('bash installer', true);
  assert.deepEqual(f.requests, []); assert.equal(f.line.text, 'bash installer');
  f.line.known = false; await f.inline.externalPaste('hello', false, true);
  assert.deepEqual(f.requests, []);
  f.line.reset(); await f.inline.externalPaste('x'.repeat(2001), false, true);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.input, []); assert.equal(f.line.text.length, 2001);
});

test('editing while backend dictation alternatives load invalidates the late repair', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.inline.host.repair = () => new Promise(resolve => finish = resolve);
  const pending = f.inline.externalPaste('Get in it.', false, true);
  f.inline.clear(); finish(repaired('Get in it.', 'git init'));
  await pending; assert.deepEqual(f.replacements, []);
});

test('backend program dictation leaves the applied transcript alone and never requests alternatives', async () => {
  const f = fixture();
  f.inline.host.state = () => ({ prompt: 1, ready: false, exited: false, inputTarget: 'program' });
  await f.inline.externalPaste('Get in it.', false, true);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.replacements, []);
  assert.deepEqual(f.input, []); assert.deepEqual(f.executed, []);
  assert.equal(f.inline.line.known, false); assert.equal(f.inline.literal, '');
});

test('failed backend repairs leave the original choice available without duplicating input', () => {
  const f = fixture();
  f.inline.backendLoading('echo original');
  f.inline.backendResult({ ...repaired('echo original', 'echo original'), accepted: false, error: 'Input snapshot unavailable.' });
  assert.equal(f.inline.literal, 'echo original');
  assert.equal(f.inline.selected, 'echo original');
  assert.equal(f.inline.loading, false);
  assert.equal(f.inline.open, true);
  assert.deepEqual(f.replacements, []);
  assert.deepEqual(f.input, []);
  f.inline.clear();
  f.inline.backendResult({ ...repaired('echo original', 'echo original'), accepted: false, error: 'Terminal input changed.' });
  assert.equal(f.inline.literal, '', 'A rejected stale repair cannot restore cleared alternatives');
  f.line.reset('echo  tail'); f.line.cursor = 5;
  f.inline.backendLoading('voice');
  f.inline.backendResult({ ...repaired('echo voice tail', 'echo voice tail'), accepted: false, error: 'Repair timed out.' });
  assert.equal(f.line.cursor, 10, 'A failed repair keeps the insertion point before the suffix');
});

test('a failed backend snapshot cannot offer a partial transcript as the entire command', () => {
  const f = fixture();
  f.line.known = false;
  f.inline.backendLoading('voice');
  f.inline.backendResult({ ...repaired('', ''), accepted: false, error: 'Input snapshot unavailable.' });
  assert.equal(f.inline.literal, '');
  f.inline.backendLoading('voice');
  f.inline.backendResult({ ...repaired('echo prefix voice tail', 'echo prefix voice tail'), accepted: false, error: 'Repair timed out.' });
  assert.equal(f.inline.literal, 'echo prefix voice tail');
  assert.equal(f.inline.selected, 'echo prefix voice tail');
  assert.equal(f.line.known, false, 'The next edit must recover the authoritative cursor');
});

test('successive repairs ignore an older result after a new prompt and transcript', async () => {
  const f = fixture();
  const replies: Array<(value: any) => void> = [];
  const signals: AbortSignal[] = [];
  f.inline.host.repair = (_text: string, _intent: unknown, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise(resolve => replies.push(resolve));
  };
  const first = f.inline.externalPaste('first', false, true);
  f.inline.onState({prompt: 2, ready: true, exited: false, inputRevision: 0, promptRevision: 0});
  f.inline.host.state = () => ({prompt: 2, ready: true, exited: false});
  const second = f.inline.externalPaste('second', false, true);
  replies[1]({...repaired('second', 'echo second'), prompt: 2});
  await second;
  replies[0](repaired('first', 'echo first'));
  await first;
  assert.equal(signals[0].aborted, true);
  assert.equal(f.inline.literal, 'second');
  assert.equal(f.inline.selected, 'echo second');
  assert.deepEqual(f.replacements, []);
  assert.deepEqual(f.executed, []);
});

test('backend action metadata remains authoritative after reading preferences change', async () => {
  const f = fixture();
  f.inline.phrases = ['inspect'];
  f.inline.backendResult({...repaired('look at readme', 'look at README.md'), actions: {
    'look at README.md': {kind: 'reading-file', phrase: 'look at', operand: 'README.md'},
  }});
  await f.inline.choose('look at README.md');
  assert.deepEqual(f.executed, ['look at README.md']);
  assert.deepEqual(f.replacements, []);
});
