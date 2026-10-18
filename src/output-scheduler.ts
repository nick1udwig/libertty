export interface OutputClock {
  now(): number;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  timer(callback: () => void, delay: number): number;
  cancelTimer(id: number): void;
}
const browserClock: OutputClock = {
  now: () => performance.now(), frame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
  timer: (callback, delay) => window.setTimeout(callback, delay), cancelTimer: id => window.clearTimeout(id),
};

/** Coalesce passive updates without scheduling work when nothing changes. */
export class OutputScheduler {
  private frame?: number;
  private timer?: number;
  private pending = false;
  private lastFlush = -Infinity;
  private activeUntil: number;
  private flush: () => void;
  private visible: () => boolean;
  private immediate: boolean;
  private clock: OutputClock;
  constructor(flush: () => void, visible: () => boolean, immediate = false, clock = browserClock) {
    this.flush = flush; this.visible = visible; this.immediate = immediate; this.clock = clock; this.activeUntil = clock.now() + 5000;
  }
  get interactive() { return this.clock.now() < this.activeUntil; }
  activity() {
    this.activeUntil = this.clock.now() + 5000;
    if (this.pending) { this.cancel(); this.request(); }
  }
  request() {
    if (this.pending || !this.visible()) return;
    this.pending = true;
    if (this.immediate && this.interactive) { this.run(); return; }
    const wait = this.interactive ? 0 : Math.max(0, this.lastFlush + 50 - this.clock.now());
    const frame = () => { this.timer = undefined; if (this.visible()) this.frame = this.clock.frame(() => this.run()); else this.cancel(); };
    if (wait) this.timer = this.clock.timer(frame, wait); else frame();
  }
  private run() {
    this.frame = this.timer = undefined; this.pending = false;
    if (!this.visible()) return;
    this.lastFlush = this.clock.now(); this.flush();
  }
  cancel() {
    if (this.frame !== undefined) this.clock.cancelFrame(this.frame);
    if (this.timer !== undefined) this.clock.cancelTimer(this.timer);
    this.frame = this.timer = undefined; this.pending = false;
  }
}
