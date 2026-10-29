import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalPresentation, TerminalResizeCover } from '../src/terminal-presentation.ts';

test('uncovered reconnects wait for paint and ignore obsolete reveals', () => {
  const nodes: { hidden?: boolean; append(): void; setAttribute(): void }[] = [];
  const callbacks: FrameRequestCallback[] = [];
  globalThis.document = { createElement: () => { const node = { append() {}, setAttribute() {} }; nodes.push(node); return node; } } as unknown as Document;
  globalThis.requestAnimationFrame = callback => callbacks.push(callback);
  const viewport = { parentElement: { append() {} }, setAttribute() {} } as unknown as HTMLElement;
  let ready = 0;
  const presentation = new TerminalPresentation(viewport, () => ready++);
  presentation.wait();
  assert.equal(nodes[0].hidden, true);
  assert.equal(presentation.pending, true);
  presentation.reveal();
  callbacks.shift()!(0);
  presentation.wait();
  callbacks.shift()!(0);
  assert.equal(ready, 0);
  assert.equal(presentation.pending, true);
  presentation.reveal();
  callbacks.shift()!(0); callbacks.shift()!(0);
  assert.equal(ready, 1);
  assert.equal(presentation.pending, false);
});


test('reconnect and resize covers retain both visible Gespenst canvas layers', () => {
  const previous = globalThis.document;
  const bounds = { left: 4, top: 10, bottom: 210, width: 300, height: 200 };
  const background = { width: 600, height: 400, getBoundingClientRect: () => bounds };
  const text = { ...background };
  const hidden = { ...background, getBoundingClientRect: () => ({ ...bounds, width: 0 }) };
  try {
    for (const resize of [false, true]) {
      const drawn: unknown[][] = [];
      globalThis.document = { createElement: () => ({
        style: {}, append() {}, setAttribute() {}, getContext: () => ({ drawImage: (...args: unknown[]) => drawn.push(args) }),
      }) } as unknown as Document;
      const viewport = {
        parentElement: { append() {}, getBoundingClientRect: () => bounds }, setAttribute() {},
        getBoundingClientRect: () => bounds, querySelectorAll: () => [background, hidden, text],
      } as unknown as HTMLElement;
      if (resize) new TerminalResizeCover(viewport).hold(200);
      else new TerminalPresentation(viewport).freeze();
      assert.deepEqual(drawn, [[background, 0, 0], [text, 0, 0]], 'Copy each visible layer in paint order without scaling');
    }
  } finally { globalThis.document = previous; }
});
