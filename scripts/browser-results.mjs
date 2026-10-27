export async function retryHarness(run, retries) {
  if (![0, 1].includes(retries)) throw new Error('BROWSER_RETRIES must be 0 or 1.');
  const attempts = [];
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const result = await run(attempt);
    attempts.push({ ...result, attempt });
    if (result.passed) return { status: attempt === 1 ? 'pass' : 'flaky', attempts };
  }
  return { status: 'fail', attempts };
}

export function browserSummary(results) {
  const rows = results.flatMap(result => result.attempts.map(attempt =>
    `| ${result.file}${result.variant ? ' (' + result.variant + ')' : ''} | ${result.shard} | ${result.iteration} | ${attempt.attempt} | ${attempt.passed ? 'pass' : 'fail'} | ${attempt.seconds} | ${result.status} |`));
  return ['## Browser results', '', '| Harness | Shard | Repeat | Attempt | Result | Seconds | Final |',
    '| --- | --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}
