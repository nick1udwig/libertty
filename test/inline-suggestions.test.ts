import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InlineSuggestions } from '../src/inline-suggestions.ts';
import { InputLine } from '../src/input-line.ts';

function fixture(command: string) {
  let acknowledge!: (accepted: boolean) => void;
  const acknowledgement = new Promise<boolean>(resolve => acknowledge = resolve);
  const replacements: string[] = [];
  let requested = false;
  const inline = Object.assign(Object.create(InlineSuggestions.prototype), {
    generation: 0, literal: '', speech: '', choices: [], autoOpen: true, line: new InputLine(), status: {}, render() {}, armInput() {},
    host: {
      state: () => ({ prompt: 1, ready: true }),
      replace: (text: string) => { replacements.push(text); return replacements.length === 1 ? acknowledgement : Promise.resolve(true); },
      suggest: async () => { requested = true; return { candidates: [{ command, score: 100, changes: [] }] }; },
    },
  });
  return { inline, acknowledge, replacements, requested: () => requested };
}

test('fast suggestions replace the shell line once without flashing the transcript', async () => {
  const f = fixture('git init');
  const pending = f.inline.dictate('Get in it.', false);
  assert.equal(f.requested(), true);
  assert.deepEqual(f.replacements, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.replacements, ['git init']);
  assert.equal(f.inline.loading, true);
  f.acknowledge(true); await pending;
  assert.equal(f.inline.loading, false);
  assert.deepEqual(f.replacements, ['git init']);
});

test('layout refreshes coalesce per frame and clearing an empty menu does not render', () => {
  const previousRequest = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0, positioned = 0, rendered = 0;
  globalThis.requestAnimationFrame = callback => { callbacks.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => { callbacks.delete(id); };
  try {
    const { inline } = fixture('git init');
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

test('unchanged suggestions avoid a second replacement; rejected and superseded edits stay untouched', async () => {
  const unchanged = fixture('echo hello');
  const pending = unchanged.inline.dictate('echo hello', false);
  unchanged.acknowledge(true); await pending;
  assert.deepEqual(unchanged.replacements, ['echo hello']);
  for (const accepted of [false, true]) {
    const f = fixture('git init');
    const pending = f.inline.dictate('Get in it.', false);
    if (accepted) f.inline.clear();
    else await new Promise(resolve => setImmediate(resolve));
    f.acknowledge(accepted); await pending;
    assert.deepEqual(f.replacements, accepted ? [] : ['git init']);
    assert.equal(f.inline.controller.signal.aborted, true);
  }
});

test('reader command alternatives use the command engine and execute only after selection', async () => {
  const f = fixture('unused'), queries: string[] = [], executed: string[] = [];
  f.inline.phrases = ['look at'];
  f.inline.host.suggest = async (query: string) => {
    queries.push(query);
    return { candidates: query.startsWith('cat ') ? [{ command: query, literal: true, score: 0, changes: [] }] : [{ command: 'git diff', score: 100, changes: [] }] };
  };
  f.inline.host.execute = (text: string) => executed.push(text);
  const pending = f.inline.dictate('look at get diff', false);
  f.acknowledge(true); await pending;
  assert.deepEqual(queries, ['cat get diff', 'get diff']);
  assert.deepEqual(f.inline.choices, ['look at git diff']);
  assert.deepEqual(executed, []);
  await f.inline.choose('look at git diff');
  assert.deepEqual(executed, ['look at git diff']);
});


test('slow suggestions keep the transcript out of the entry until the final replacement', async () => {
  const f = fixture('git init');
  let finish!: (value: any) => void;
  f.inline.host.suggest = () => new Promise(resolve => finish = resolve);
  const pending = f.inline.dictate('Get in it.', false);
  await new Promise(resolve => setTimeout(resolve, 520));
  assert.equal(f.inline.loading, true);
  assert.deepEqual(f.replacements, []);
  f.acknowledge(true); finish({ candidates: [{ command: 'git init', score: 100, changes: [] }] }); await pending;
  assert.deepEqual(f.replacements, ['git init']);
  assert.equal(f.inline.loading, false);
});

test('typing while suggestions load preserves the pending transcript and ignores late repairs', async () => {
  const f = fixture('git init');
  let finish!: (value: any) => void; const input: string[] = [];
  f.inline.host.suggest = () => new Promise(resolve => finish = resolve);
  f.inline.host.raw = (data: string) => input.push(data);
  const pending = f.inline.dictate('Get in it.', false);
  assert.equal(f.inline.raw('x'), false); assert.equal(f.inline.raw('y'), false);
  assert.deepEqual(f.replacements, ['Get in it.']);
  f.acknowledge(true); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(input, ['xy']);
  finish({ candidates: [{ command: 'git init', score: 100, changes: [] }] }); await pending;
  assert.deepEqual(f.replacements, ['Get in it.']);
});

test('fused repair avoids separate replacements and cancellation waits for its authoritative result', async () => {
  const f = fixture('git init');
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
  const g = fixture('git init');
  g.inline.host.repair = async () => ({ accepted: true, candidates: [{ command: 'git init', changes: [], score: 100 }], original: 'Get in it.', selected: 'git init', revision: 1, prompt: 1 });
  await g.inline.dictate('Get in it.', false);
  assert.deepEqual(g.replacements, []);
  assert.deepEqual(g.inline.choices, ['git init']);
  assert.equal(g.inline.selected, 'git init');
});
