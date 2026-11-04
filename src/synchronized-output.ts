/** A program that never ends a synchronized update still paints after this many milliseconds. */
export const synchronizedLimit = 1000;

/** Defers paints while a program's synchronized update (DEC mode 2026) is open, so a redraw split across messages never shows half drawn. */
export class SynchronizedOutput {
  private since?: number;
  private now: () => number;
  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }
  /** Whether the paint must wait for the update to end. */
  hold(open: boolean) {
    if (!open) {
      this.since = undefined;
      return false;
    }
    this.since ??= this.now();
    return this.now() - this.since < synchronizedLimit;
  }
}
