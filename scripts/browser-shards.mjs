export function browserShard(cases, value) {
  if (!value) return cases;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count || count > cases.length) {
    throw new Error('BROWSER_SHARD must be k/n with 1 <= k <= n <= the harness count.');
  }
  const shards = Array.from({ length: count }, () => ({ seconds: 0, cases: [] }));
  for (const entry of [...cases].sort((a, b) => b[2] - a[2])) {
    const shard = shards.reduce((best, candidate) => candidate.seconds < best.seconds ? candidate : best);
    shard.cases.push(entry);
    shard.seconds += entry[2];
  }
  return shards[index - 1].cases;
}
