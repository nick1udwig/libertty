import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { quickTests } from '../scripts/quick-tests.mjs';
import { unitTestFiles } from '../scripts/unit-files.mjs';

test('quick checks and remaining unit tests partition all current unit files without gaps', () => {
  const files = readdirSync(new URL('./', import.meta.url));
  const all = unitTestFiles(files), remaining = unitTestFiles(files, true);
  assert.equal(new Set(quickTests).size, quickTests.length);
  assert.ok(quickTests.every(file => all.includes(file)));
  assert.ok(remaining.every(file => !quickTests.includes(file)));
  assert.deepEqual([...quickTests, ...remaining].sort(), all);
  assert.ok(!all.includes('install.test.mjs') && !all.includes('setup-integrations.test.mjs'));
});
test('new unit files join the full and remaining suites automatically', () => {
  assert.deepEqual(unitTestFiles(['new.test.ts', 'new.test.mjs', 'support.mjs'], true), ['new.test.mjs', 'new.test.ts']);
});
