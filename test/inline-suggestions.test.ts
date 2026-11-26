import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInline } from './support/inline-fixture.ts';
import { InputLine } from '../src/input-line.ts';

function fixture() {
  let acknowledge!: (accepted: boolean) => void;
  const acknowledgement = new Promise<boolean>(resolve => acknowledge = resolve);
  const replacements: string[] = [];
  const inline = Object.assign(createInline({ state: () => ({ prompt: 1, ready: true, exited: false }) }), {
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
  assert.deepEqual(g.inline.choices.filter((choice: any) => !choice.literal).map((choice: any) => choice.text), ['git init']);
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
  assert.deepEqual(f.inline.choices.filter((choice: any) => !choice.literal).map((choice: any) => choice.text), ['look at git diff']);
  assert.deepEqual(executed, []);
  await f.inline.choose('choice-0');
  assert.deepEqual(executed, ['look at git diff']);
});

function choiceFixture() {
  const f = fixture();
  f.inline.tapToSend = false;
  f.inline.literal = 'original';
  f.inline.selected = 'original';
  f.inline.line.reset('original');
  f.inline.choices = [{ id: 'alternate', text: 'replacement', action: { kind: 'shell' }, literal: false }];
  return f;
}

test('alternate replacement commits the tracked line only after acknowledgement', async () => {
  for (const accepted of [true, false]) {
    const f = choiceFixture();
    const pending = f.inline.choose('alternate');
    assert.equal(f.inline.line.text, 'original');
    assert.equal(f.inline.selected, 'original');
    assert.equal(f.inline.predictionReady, false);
    f.acknowledge(accepted);
    await pending;
    assert.equal(f.inline.line.known, accepted);
    assert.equal(f.inline.line.text, accepted ? 'replacement' : 'original');
    assert.equal(f.inline.predictionReady, accepted);
  }
});

test('typing during alternate replacement follows the acknowledged line', async () => {
  const f = choiceFixture(), sent: string[] = [];
  f.inline.host.raw = (text: string) => sent.push(text);
  const pending = f.inline.choose('alternate');
  assert.equal(f.inline.raw('x'), false);
  assert.equal(f.inline.raw('y'), false);
  assert.deepEqual(sent, []);
  f.acknowledge(true);
  await pending;
  assert.deepEqual(sent, ['xy']);
  assert.equal(f.inline.line.text, 'replacementxy');
  assert.equal(f.inline.predictionReady, true);
});

test('a failed replacement invalidates prediction without an unhandled rejection', async () => {
  const f = choiceFixture();
  f.inline.host.replace = async () => { throw new Error('Disconnected'); };
  await f.inline.choose('alternate');
  assert.equal(f.inline.line.text, 'original');
  assert.equal(f.inline.predictionReady, false);
});

test('a late replacement cannot consume a newer operation or its queued input', async () => {
  const f = choiceFixture(), sent: string[] = [], replies: ((accepted: boolean) => void)[] = [];
  let prompt = 1;
  f.inline.host.state = () => ({ prompt, ready: true, exited: false, inputRevision: prompt, promptRevision: prompt });
  f.inline.host.raw = (text: string) => sent.push(text);
  f.inline.host.replace = () => new Promise(resolve => replies.push(resolve));
  const old = f.inline.choose('alternate');
  f.inline.raw('old');
  prompt = 2;
  f.inline.onState(f.inline.host.state());
  f.inline.choices = [{ id: 'new', text: 'new', action: { kind: 'shell' }, literal: false }];
  const current = f.inline.choose('new');
  f.inline.raw(' input');
  replies[0](true);
  await old;
  assert.deepEqual(sent, []);
  assert.equal(f.inline.line.text, '');
  replies[1](true);
  await current;
  assert.deepEqual(sent, [' input']);
  assert.equal(f.inline.line.text, 'new input');
});

test('cancelled repair does not restore its literal into a later prompt', async () => {
  const f = fixture();
  let prompt = 1, finish!: (result: any) => void;
  f.inline.host.state = () => ({ prompt, ready: true, exited: false, inputRevision: prompt, promptRevision: prompt });
  f.inline.host.repair = () => new Promise(resolve => finish = resolve);
  const pending = f.inline.dictate('old literal', false);
  f.inline.raw('old input');
  prompt = 2;
  f.inline.onState(f.inline.host.state());
  finish({ accepted: false });
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.replacements, []);
  assert.equal(f.inline.line.text, '');
  assert.equal(f.inline.predictionReady, true);
});

test('typing during failed-repair restoration shares the pending replacement', async () => {
  const f = fixture(), sent: string[] = [];
  f.inline.host.repair = async () => { throw new Error('Unavailable'); };
  f.inline.host.raw = (text: string) => sent.push(text);
  const pending = f.inline.dictate('original', false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.replacements, ['original']);
  assert.equal(f.inline.raw(' input'), false);
  f.acknowledge(true);
  await pending;
  assert.deepEqual(f.replacements, ['original']);
  assert.deepEqual(sent, [' input']);
  assert.equal(f.inline.line.text, 'original input');
  assert.equal(f.inline.open, false);
});
