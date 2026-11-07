import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor } from '../src/terminal-theme.ts';
test('terminal colors accept whitespace, case-insensitive functions and percentages', () => {
  assert.deepEqual(parseColor(' \t#abc\n'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('RGB(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor(' RgBa(100%, 50%, 0%, 25%) '), { r: 255, g: 128, b: 0, a: 0.25 });
  assert.deepEqual(parseColor('rgb(100% 0% 25% / 50%)'), { r: 255, g: 0, b: 64, a: 0.5 });
});
test('terminal colors round valid channels and reject invalid components', () => {
  assert.deepEqual(parseColor({ r: 1.6, g: 2.4, b: 3.5 }), { r: 2, g: 2, b: 4, a: 1 });
  assert.deepEqual(parseColor('rgba(1.6, 2.4, 3.5, .25)'), { r: 2, g: 2, b: 4, a: .25 });
  for (const color of ['rgb(% 0 0)', 'rgb(256,0,0)', 'rgb(-1,0,0)', 'rgb(101% 0% 0%)', 'rgba(1,2,3,2)', 'rgba(1,2,3)', 'rgb(1,,2,3)', 'rgb(1 2 3 4)', 'rgb(1 2 3 / / .5)', { r: NaN, g: 0, b: 0 }, { r: Infinity, g: 0, b: 0 }, { r: -0.1, g: 0, b: 0 }, { r: 0, g: 0, b: 0, a: NaN }])
    assert.throws(() => parseColor(color), TypeError);
});
