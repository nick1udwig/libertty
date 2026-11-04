/** One finger position along the scroll axis. */
export interface ScrollSample {
  y: number;
  at: number;
}

/** Release speed fits finger motion from this many milliseconds before the last move. */
const velocityWindow = 100;
/** A finger that rested this many milliseconds before lifting releases without momentum. */
const stoppedAfter = 40;
/** Coalesced events closer than this many milliseconds still count as this far apart. */
const shortestInterval = 8;
/** Fastest release speed in pixels per millisecond, so a coalesced jump cannot fling through all history. */
const fastestRelease = 8;
/** Momentum keeps 1/e of its speed after this many milliseconds, close to iOS normal deceleration. */
export const momentumDecay = 500;

/** Keeps the finger samples that a later release can still use. */
export function recordScrollSample(samples: ScrollSample[], y: number, at: number) {
  samples.push({ y, at });
  while (samples.length > 2 && at - samples[0]!.at > velocityWindow) samples.shift();
}

/** Estimates finger speed in pixels per millisecond with a least-squares fit, so one slow final event does not stop a fling. */
export function releaseVelocity(samples: readonly ScrollSample[], at: number) {
  const last = samples[samples.length - 1];
  if (!last || at - last.at > stoppedAfter) return 0;
  const recent = samples.filter((sample) => last.at - sample.at <= velocityWindow);
  if (recent.length < 2) return 0;
  const first = recent[0]!;
  if (last.at - first.at < shortestInterval)
    return clampVelocity((last.y - first.y) / shortestInterval);
  const time = recent.reduce((sum, sample) => sum + sample.at, 0) / recent.length;
  const position = recent.reduce((sum, sample) => sum + sample.y, 0) / recent.length;
  let covariance = 0,
    variance = 0;
  for (const sample of recent) {
    covariance += (sample.at - time) * (sample.y - position);
    variance += (sample.at - time) ** 2;
  }
  return clampVelocity(covariance / variance);
}

function clampVelocity(velocity: number) {
  return Math.max(-fastestRelease, Math.min(fastestRelease, velocity));
}
