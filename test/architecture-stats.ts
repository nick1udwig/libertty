export interface LatencyStatistics {
  median: number;
  p95: number;
  lower95?: number;
  upper95?: number;
}

/** Distribution-free median bounds from binomial order statistics. */
export function latencyStatistics(samples: number[]): LatencyStatistics {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Latency samples must be finite, nonnegative, and nonempty.');
  const values = [...samples].sort((a, b) => a - b), n = values.length;
  const left = values[Math.floor((n - 1) / 2)], right = values[Math.floor(n / 2)];
  const result: LatencyStatistics = { median: left + (right - left) / 2, p95: values[Math.ceil(n * 0.95) - 1] };
  let logMass = -n * Math.LN2, tail = 0, bound = -1;
  for (let k = 0; k < n / 2; k++) {
    tail += Math.exp(logMass);
    if (tail > 0.025) break;
    bound = k;
    logMass += Math.log(n - k) - Math.log(k + 1);
  }
  // Fewer than six samples cannot provide finite two-sided 95% bounds.
  if (bound >= 0) { result.lower95 = values[bound]; result.upper95 = values[n - bound - 1]; }
  return result;
}

export function latencyRegressed(after: LatencyStatistics, before: LatencyStatistics, absoluteAllowance: number, relativeAllowance = 0.2): boolean {
  return (after.lower95 ?? after.median) > (before.upper95 ?? before.median) + Math.max(absoluteAllowance, before.median * relativeAllowance);
}
