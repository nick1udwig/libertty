interface ScreenLock extends EventTarget { released: boolean; release(): Promise<void> }
interface WakeEnvironment {
  document: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  navigator: { wakeLock?: { request(type: 'screen'): Promise<ScreenLock> } };
}

/** Request from the visible same-origin outer document, including embedded panes. */
export function dictationWakeEnvironment(): WakeEnvironment {
  try { if (window.top) return { document: window.top.document, navigator: window.top.navigator }; } catch { /* Cross-origin embeds use their delegated permissions. */ }
  return { document, navigator };
}

export class DictationWakeLock {
  private active = false;
  private pending = false;
  private generation = 0;
  private warned = false;
  private lock?: ScreenLock;
  private environment: WakeEnvironment;
  private notice: (message: string) => void;
  private visibility = () => { if (!this.environment.document.hidden) void this.acquire(); };
  constructor(environment: WakeEnvironment, notice: (message: string) => void) {
    this.environment = environment; this.notice = notice;
    environment.document.addEventListener('visibilitychange', this.visibility);
  }
  start() { this.active = true; this.warned = false; ++this.generation; void this.acquire(); }
  stop() {
    this.active = false; ++this.generation;
    const lock = this.lock; this.lock = undefined;
    if (lock && !lock.released) void lock.release().catch(() => {});
  }
  private warn() {
    if (!this.active || this.warned) return;
    this.warned = true; this.notice('Cannot keep the screen awake. Keep it on while dictating; locking may interrupt audio.');
  }
  private async acquire() {
    if (!this.active || this.pending || this.lock || this.environment.document.hidden) return;
    if (!this.environment.navigator.wakeLock) { this.warn(); return; }
    this.pending = true; const generation = this.generation;
    try {
      const lock = await this.environment.navigator.wakeLock.request('screen');
      if (!this.active || generation !== this.generation || this.environment.document.hidden) { if (!lock.released) await lock.release(); return; }
      if (lock.released) { this.warn(); return; }
      this.lock = lock;
      lock.addEventListener('release', () => {
        if (this.lock !== lock) return;
        this.lock = undefined;
        if (!this.environment.document.hidden) this.warn();
      }, { once: true });
    } catch { if (generation === this.generation) this.warn(); }
    finally { this.pending = false; if (this.active && generation !== this.generation) void this.acquire(); }
  }
  dispose() { this.stop(); this.environment.document.removeEventListener('visibilitychange', this.visibility); }
}
