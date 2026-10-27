import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserSummary, retryHarness } from '../scripts/browser-results.mjs';

test('a retry pass is flaky and retains the failed attempt', async () => {
  const result = await retryHarness(async attempt => ({ passed: attempt === 2, seconds: attempt, diagnostics: 'attempt-' + attempt }), 1);
  assert.equal(result.status, 'flaky');
  assert.deepEqual(result.attempts.map(attempt => attempt.passed), [false, true]);
  assert.equal(result.attempts[0].diagnostics, 'attempt-1');
  const summary = browserSummary([{ ...result, file: 'example.mjs', shard: '2/4', iteration: 1 }]);
  assert.match(summary, /example.mjs \| 2\/4 \| 1 \| 1 \| fail \| 1 \| flaky/);
  assert.match(summary, /example.mjs \| 2\/4 \| 1 \| 2 \| pass \| 2 \| flaky/);
});
test('strict checks never retry and exhausted retries fail', async () => {
  let calls = 0;
  const fail = async () => { calls++; return { passed: false, seconds: 1 }; };
  assert.equal((await retryHarness(fail, 0)).status, 'fail');
  assert.equal(calls, 1);
  assert.equal((await retryHarness(fail, 1)).status, 'fail');
  assert.equal(calls, 3);
  assert.equal((await retryHarness(async () => ({ passed: true }), 1)).attempts.length, 1);
  await assert.rejects(retryHarness(fail, 2), /BROWSER_RETRIES/);
});
