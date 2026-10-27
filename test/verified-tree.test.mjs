import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelMergedPullRequestRuns, verificationComplete, verifiedTree } from '../scripts/verified-tree.mjs';

test('the final gate rejects missing, cancelled or failed checks even with old markers', () => {
  const fresh = { LOOKUP: 'success', RUST: 'success', BROWSER: 'success', RELIABILITY: 'success', REQUIRED: 'true' };
  assert.equal(verificationComplete(fresh), true);
  assert.equal(verificationComplete({ ...fresh, REQUIRED: 'false', RELIABILITY: 'skipped' }), true);
  assert.equal(verificationComplete({ ...fresh, RUST: 'skipped', BROWSER: 'skipped', VERIFIED: 'true' }), true);
  assert.equal(verificationComplete({ ...fresh, RELIABILITY: 'skipped', RELIABILITY_VERIFIED: 'true' }), true);
  for (const suite of ['LOOKUP', 'RUST', 'BROWSER', 'RELIABILITY']) {
    for (const result of ['failure', 'cancelled', undefined]) {
      assert.equal(verificationComplete({ ...fresh, [suite]: result, VERIFIED: 'true', RELIABILITY_VERIFIED: 'true' }), false);
    }
    assert.equal(verificationComplete({ ...fresh, [suite]: 'skipped' }), false);
  }
});

const artifact = { name: 'verified-tree', expired: false, workflow_run: { id: 7 } };
const run = { status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml', head_sha: 'commit', repository: { id: 1 }, head_repository: { id: 1 } };
test('documentation skips accept only a successful lookup and skipped full suites', () => {
  const docs = { LOOKUP: 'success', DOCUMENTATION_ONLY: 'true', RUST: 'skipped', BROWSER: 'skipped', RELIABILITY: 'skipped' };
  assert.equal(verificationComplete(docs), true);
  for (const field of ['LOOKUP', 'RUST', 'BROWSER', 'RELIABILITY']) assert.equal(verificationComplete({ ...docs, [field]: 'failure' }), false);
});
test('reuse requires a successful supported run and its independently checked source tree', async () => {
  const lookup = async (changes = {}, sourceTree = 'tree', artifactChanges = {}) => verifiedTree(async route => {
    if (route.startsWith('actions/artifacts?')) return { total_count: 1, artifacts: [{ ...artifact, ...artifactChanges }] };
    if (route === 'actions/runs/7') return { ...run, ...changes };
    assert.equal(route, 'git/commits/commit');
    return { tree: { sha: sourceTree } };
  }, 'tree');
  assert.equal(await lookup(), true);
  assert.equal(await lookup({}, 'different-tree'), false);
  assert.equal(await lookup({ conclusion: 'failure' }), false);
  assert.equal(await lookup({ status: 'in_progress' }), false);
  assert.equal(await lookup({ path: '.github/workflows/unrelated.yml' }), false);
  assert.equal(await lookup({ head_repository: { id: 2 } }), false);
  assert.equal(await lookup({}, 'tree', { expired: true }), false);
  assert.equal(await lookup({}, 'tree', { name: 'verified-other' }), false);
});
test('reliability markers are separate and lookup follows pagination', async () => {
  let pages = 0;
  assert.equal(await verifiedTree(async route => {
    if (route.startsWith('actions/artifacts?')) {
      assert.match(route, /name=verified-tree-reliability/);
      pages++;
      return { total_count: 101, artifacts: pages === 1 ? [] : [{ ...artifact, name: 'verified-tree-reliability' }] };
    }
    return route.startsWith('git/') ? { tree: { sha: 'tree' } } : run;
  }, 'tree', true), true);
  assert.equal(pages, 2);
});
test('merge cancellation affects only unfinished CI runs for that merged pull request', async () => {
  const cancelled = [];
  await cancelMergedPullRequestRuns(async (route, method) => {
    if (method === 'POST') { cancelled.push(route); return; }
    if (route.startsWith('commits/')) return [{ number: 12, merged_at: 'today', merge_commit_sha: 'merge', head: { sha: 'head', repo: { id: 1 } } }, { number: 13, merged_at: null, merge_commit_sha: 'merge' }];
    return { total_count: 5, workflow_runs: [
      { id: 1, status: 'in_progress', pull_requests: [{ number: 12 }] },
      { id: 2, status: 'queued', pull_requests: [{ number: 12 }] },
      { id: 3, status: 'completed', pull_requests: [{ number: 12 }] },
      { id: 4, status: 'in_progress', pull_requests: [{ number: 13 }] },
      { id: 5, status: 'in_progress', pull_requests: [], head_sha: 'head', head_repository: { id: 1 } },
    ] };
  }, 'merge');
  assert.deepEqual(cancelled, ['actions/runs/1/cancel', 'actions/runs/2/cancel', 'actions/runs/5/cancel']);
});
