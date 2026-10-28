/** Continue the same gesture locally when a remote scroll cannot respond promptly. */
export class TerminalScrollFallback {
  private timer?: ReturnType<typeof setTimeout>;
  private lines = 0;
  private readonly fallback: (lines: number) => void;
  constructor(fallback: (lines: number) => void) { this.fallback = fallback; }
  move(lines: number, available: boolean) {
    this.lines += lines;
    if (!available) { this.expire(); return true; }
    this.timer ??= setTimeout(() => this.expire(), 200);
    return false;
  }
  updated() { clearTimeout(this.timer); this.timer = undefined; this.lines = 0; }
  private expire() { const lines = this.lines; this.updated(); if (lines) this.fallback(lines); }
}
