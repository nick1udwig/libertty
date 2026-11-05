import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SuggestionInput } from '../src/suggestion-input.ts';
import { InputLine } from '../src/input-line.ts';

function fixture() {
  const surface = new EventTarget(), raw: string[] = [], dictated: unknown[] = [];
  const previous = globalThis.document;
  let ready = true;
  Object.assign(globalThis, {document: {getElementById: () => surface}});
  try {
    const capture = new SuggestionInput({} as any, {
      line: new InputLine(), state: () => ({ready, exited: false, prompt: 1}) as any,
      flushing: () => false, clear() {}, raw: data => raw.push(data),
      dictate: (...args) => dictated.push(args),
    });
    return {capture, raw, dictated, setReady: (value: boolean) => ready = value,
      dispatch(type: string, fields: object) {
        const event = Object.assign(new Event(type, {cancelable: true}), fields);
        surface.dispatchEvent(event);
        return event.defaultPrevented;
      }};
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'document');
    else globalThis.document = previous;
  }
}

test('clipboard capture repairs only single-line shell input', () => {
  const f = fixture();
  const paste = (text: string) => f.dispatch('paste', {clipboardData: {getData: () => text}});
  assert.equal(paste('Get in it.'), true);
  assert.deepEqual(f.dictated, [['Get in it.', false]]);
  assert.equal(paste('one\ntwo'), false);
  f.setReady(false);
  assert.equal(paste('literal program input'), false);
  assert.equal(f.dictated.length, 1);
});

test('keyboard and beforeinput deletion events send one terminal edit', () => {
  const f = fixture();
  f.dispatch('keydown', {key: 'Backspace'});
  f.dispatch('beforeinput', {inputType: 'deleteContentBackward'});
  assert.deepEqual(f.raw, ['\x7f']);
});

test('incremental composition streams edits without requesting repair', () => {
  const f = fixture();
  f.dispatch('compositionstart', {});
  f.dispatch('compositionupdate', {data: 'a'});
  f.dispatch('compositionupdate', {data: 'ab'});
  f.dispatch('compositionend', {data: 'ab'});
  assert.equal(f.capture.composing, false);
  assert.deepEqual(f.raw, ['a', 'b']);
  assert.deepEqual(f.dictated, []);
});
