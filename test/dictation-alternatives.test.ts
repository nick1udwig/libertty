import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InlineSuggestions } from '../src/inline-suggestions.ts';
import { InputLine } from '../src/input-line.ts';

const repaired = (original: string, selected: string) => ({ accepted: true, candidates: selected === original ? [] : [{ command: selected, score: 100, changes: [] }], original, selected, revision: 1, prompt: 1 });
function fixture() {
  const replacements: string[] = [], requests: string[] = [], input: string[] = [], executed: string[] = [];
  const line = new InputLine(); line.reset();
  const inline = Object.assign(Object.create(InlineSuggestions.prototype), {
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
