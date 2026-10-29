import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal } from 'ghostty-web';
import { terminalSnapshot, invalidateSnapshot } from '../src/terminal-snapshot.ts';

test('snapshots reuse unchanged rows and refresh content, geometry and colors', () => {
  let reads = 0;
  const cell = { codepoint: 65, width: 1, flags: 1, fg_r: 255, fg_g: 255, fg_b: 255, bg_r: 0, bg_g: 0, bg_b: 0, grapheme_len: 0 };
  const foreground = { r: 255, g: 255, b: 255 };
  const native = { cols: 2, rows: 1, getColors: () => ({ foreground }), getScrollbackLength: () => 0, getCursor: () => ({ x: 0, y: 0, visible: true }), getViewport: () => { reads++; return [cell, cell]; } };
  const term = { wasmTerm: native, buffer: { active: { type: 'normal' } } } as unknown as Terminal;
  const first = terminalSnapshot(term);
  assert.equal(first.text, '\x1b[0;1mAA\x1b[0m');
  assert.equal(terminalSnapshot(term), first);
  assert.equal(reads, 1);
  cell.codepoint = 66; invalidateSnapshot(term);
  assert.match(terminalSnapshot(term).text, /BB/);
  native.cols = 1;
  assert.match(terminalSnapshot(term).text, /mB\x1b/);
  foreground.r = 0;
  assert.match(terminalSnapshot(term).text, /38;2;255;255;255/);
  assert.equal(reads, 4);
});
