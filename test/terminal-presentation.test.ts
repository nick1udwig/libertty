import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalPresentation } from '../src/terminal-presentation.ts';

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
