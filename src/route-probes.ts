export async function probeRoutes<T, R>(
  candidates: readonly T[],
  probe: (candidate: T, signal: AbortSignal) => Promise<R | undefined>,
  signal: AbortSignal,
): Promise<R[]> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const stop = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), 8000);
  const results: { index: number; value: R }[] = [];
  let next = 0;
  let stopped!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  stop.addEventListener('abort', stopped, { once: true });
  try {
    const workers = Array.from({ length: Math.min(3, candidates.length) }, async () => {
      while (!stop.aborted && next < candidates.length) {
        const index = next++;
        try {
          const value = await probe(candidates[index], stop);
          if (!stop.aborted && value !== undefined) results.push({ index, value });
        } catch {
          // An unavailable route does not prevent other candidates from being measured.
        }
      }
    });
    await Promise.race([Promise.all(workers), cancelled]);
    signal.throwIfAborted();
    return results.sort((a, b) => a.index - b.index).map((result) => result.value);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', stopped);
    deadline.abort();
  }
}
