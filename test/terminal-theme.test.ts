import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor } from '../src/terminal-theme.ts';
test('terminal colors accept whitespace, case-insensitive functions and percentages', () => {
  assert.deepEqual(parseColor(' \t#abc\n'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('RGB(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor(' RgBa(100%, 50%, 0%, 25%) '), { r: 255, g: 128, b: 0, a: 0.25 });
  assert.deepEqual(parseColor('rgb(100% 0% 25% / 50%)'), { r: 255, g: 0, b: 64, a: 0.5 });
});
