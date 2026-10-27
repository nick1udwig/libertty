import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { browserGroups, expandBrowserCases, expandBrowserNames } from '../scripts/browser-groups.mjs';

test('every legacy suite selects distinct existing scenarios', () => {
  const children = Object.values(browserGroups).flat();
  assert.equal(new Set(children).size, children.length);
  for (const [suite, cases] of Object.entries(browserGroups)) {
    assert.ok(existsSync(new URL('./' + suite, import.meta.url)));
    assert.ok(cases.length >= 2 && cases.length <= 3);
    assert.deepEqual(expandBrowserNames([suite]), cases);
    for (const file of cases) assert.ok(existsSync(new URL('./' + file, import.meta.url)), file);
  }
});
test('scenario expansion retains case environments and unsplit variants', () => {
  const overrides = { TEST_BASE_PATH: '/terminal' }, plain = {}, gzip = { TEST_WIRE: 'gzip' };
  const cases = expandBrowserCases([['browser.mjs', overrides], ['scroll.mjs', plain], ['scroll.mjs', gzip]]);
  assert.deepEqual(cases.slice(0, 3).map(([file]) => file), browserGroups['browser.mjs']);
  assert.ok(cases.slice(0, 3).every(([, env]) => env === overrides));
  assert.deepEqual(cases.slice(3), [['scroll.mjs', plain], ['scroll.mjs', gzip]]);
  assert.equal(expandBrowserNames(undefined), undefined);
});
