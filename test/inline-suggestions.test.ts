import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InlineSuggestions } from '../src/inline-suggestions.ts';
import { InputLine } from '../src/input-line.ts';

function fixture() {
  let acknowledge!: (accepted: boolean) => void;
  const acknowledgement = new Promise<boolean>(resolve => acknowledge = resolve);
  const replacements: string[] = [];
  const inline = Object.assign(Object.create(InlineSuggestions.prototype), {
    generation: 0, literal: '', speech: '', choices: [], autoOpen: true, line: new InputLine(), status: {}, render() {}, armInput() {},
    host: {
      state: () => ({ prompt: 1, ready: true }),
      replace: (text: string) => { replacements.push(text); return replacements.length === 1 ? acknowledgement : Promise.resolve(true); },
    },
  });
  return { inline, acknowledge, replacements };
}

test('layout refreshes coalesce per frame and clearing an empty menu does not render', () => {
  const previousRequest = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0, positioned = 0, rendered = 0;
  globalThis.requestAnimationFrame = callback => { callbacks.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => { callbacks.delete(id); };
  try {
    const { inline } = fixture();
    inline.position = () => positioned++;
    inline.render = () => rendered++;
    inline.clear(); assert.equal(rendered, 0);
    inline.literal = 'git init';
    inline.refresh(); inline.refresh(); inline.refresh();
    assert.equal(callbacks.size, 1);
    const callback = callbacks.get(next)!; callbacks.delete(next); callback(0);
    assert.equal(positioned, 1);
    inline.refresh(); inline.clear();
    assert.equal(callbacks.size, 0);
    assert.equal(rendered, 1);
  } finally {
    if (previousRequest) globalThis.requestAnimationFrame = previousRequest; else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (previousCancel) globalThis.cancelAnimationFrame = previousCancel; else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});

test('fused repair avoids separate replacements and cancellation waits for its authoritative result', async () => {
  const f = fixture();
  const sent: string[] = [], raw: string[] = [];
  let finish!: (result: any) => void;
  f.inline.host.repair = (text: string, intent: any, signal: AbortSignal) => {
    sent.push(text); assert.equal(intent.kind, 'shell');
    signal.addEventListener('abort', () => sent.push('cancel'));
    return new Promise(resolve => finish = resolve);
  };
  f.inline.host.raw = (input: string) => raw.push(input);
  const pending = f.inline.dictate('Get in it.', false);
  assert.deepEqual(f.replacements, []);
  assert.equal(f.inline.raw('x'), false);
  assert.deepEqual(sent, ['Get in it.', 'cancel']);
  assert.deepEqual(f.replacements, [], 'Wait for the transaction result before restoring at its resulting revision');
  finish({ accepted: false, candidates: [], original: 'Get in it.', selected: 'Get in it.', revision: 0, prompt: 1 });
  await pending; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.replacements, ['Get in it.']);
  f.acknowledge(true); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(raw, ['x']);
  const g = fixture();
  g.inline.host.repair = async () => ({ accepted: true, candidates: [{ command: 'git init', changes: [], score: 100 }], original: 'Get in it.', selected: 'git init', revision: 1, prompt: 1 });
  await g.inline.dictate('Get in it.', false);
  assert.deepEqual(g.replacements, []);
  assert.deepEqual(g.inline.choices, ['git init']);
  assert.equal(g.inline.selected, 'git init');
});

test('reader alternatives from a repair execute only after selection', async () => {
  const f = fixture(), executed: string[] = [];
  f.inline.phrases = ['look at'];
  f.inline.host.repair = async (text: string, intent: any) => {
    assert.deepEqual(intent, { kind: 'reading-file', phrase: 'look at', operand: 'get diff' });
    return { accepted: true, candidates: [{ command: 'look at git diff', changes: [], score: 100 }], original: text, selected: text, revision: 1, prompt: 1 };
  };
  f.inline.host.execute = (text: string) => executed.push(text);
  await f.inline.dictate('look at get diff', false);
  assert.deepEqual(f.inline.choices, ['look at git diff']);
  assert.deepEqual(executed, []);
  await f.inline.choose('look at git diff');
  assert.deepEqual(executed, ['look at git diff']);
});
