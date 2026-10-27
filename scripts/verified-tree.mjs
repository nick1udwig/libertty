import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verificationComplete(env) {
  const passed = (result, marker) => result === 'success' || result === 'skipped' && marker === 'true';
  return env.LOOKUP === 'success' && passed(env.RUST, env.VERIFIED) && passed(env.BROWSER, env.VERIFIED)
    && (env.REQUIRED === 'false' || passed(env.RELIABILITY, env.RELIABILITY_VERIFIED));
}

export async function verifiedTree(api, tree, reliability = false) {
  const name = 'verified-' + tree + (reliability ? '-reliability' : '');
  for (let page = 1; ; page++) {
    const listing = await api(`actions/artifacts?name=${name}&per_page=100&page=${page}`);
    for (const artifact of listing.artifacts) {
      if (artifact.expired || artifact.name !== name) continue;
      const run = await api('actions/runs/' + artifact.workflow_run.id);
      if (run.status !== 'completed' || run.conclusion !== 'success') continue;
      if (!['.github/workflows/ci.yml', '.github/workflows/release.yml'].includes(run.path)) continue;
      if (!run.repository?.id || run.head_repository?.id !== run.repository.id) continue;
      const commit = await api('git/commits/' + run.head_sha);
      if (commit.tree.sha === tree) return true;
    }
    if (page * 100 >= listing.total_count) return false;
  }
}

export async function cancelMergedPullRequestRuns(api, sha) {
  const pulls = await api('commits/' + sha + '/pulls?per_page=100');
  const matches = pulls.filter(pull => pull.merged_at && pull.merge_commit_sha === sha);
  for (const pull of matches) {
    if (!pull.head?.sha) continue;
    for (let page = 1; ; page++) {
      const listing = await api(`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100&page=${page}`);
      for (const run of listing.workflow_runs) {
        const related = run.pull_requests.some(candidate => candidate.number === pull.number) || pull.head.repo?.id && pull.head.sha === run.head_sha && pull.head.repo.id === run.head_repository?.id;
        if (run.status === 'completed' || !related) continue;
        try { await api('actions/runs/' + run.id + '/cancel', 'POST'); }
        catch (error) { if (error.status !== 409) throw error; }
      }
      if (page * 100 >= listing.total_count) break;
    }
  }
}

async function main() {
  if (process.argv[2] === 'gate') {
    if (!verificationComplete(process.env)) throw new Error('Required verification did not pass.');
    return;
  }
  const api = async (route, method = 'GET') => {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${route}`, {
      method, signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + process.env.GH_TOKEN, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub API ${method} ${route}: ${response.status}`), { status: response.status });
    return response.status === 204 ? undefined : response.json();
  };
  if (process.argv[2] === 'cancel') return cancelMergedPullRequestRuns(api, process.env.GITHUB_SHA);
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  let verified = false, reliability = false;
  if (process.env.VERIFY_FORCE !== 'true') {
    try {
      verified = await verifiedTree(api, tree);
      reliability = process.env.VERIFY_RELIABILITY === 'true' && await verifiedTree(api, tree, true);
    } catch (error) { console.warn('Verification lookup unavailable; running checks: ' + error.message); verified = false; reliability = false; }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `tree=${tree}\nverified=${verified}\nreliability=${reliability}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
