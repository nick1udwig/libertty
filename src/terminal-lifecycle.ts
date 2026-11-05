/** Connection progress is independent of whether its view is visible. */
export class TerminalConnection {
  private phase: 'disconnected' | 'opening' | 'replaying' | 'synchronized' = 'disconnected';
  private generation = 0;
  private started = false;
  get epoch() {
    return this.generation;
  }
  get hasState() {
    return this.phase === 'replaying' || this.phase === 'synchronized';
  }
  get synchronized() {
    return this.phase === 'synchronized';
  }
  get streamStarted() {
    return this.started;
  }
  opened() {
    this.generation++;
    this.phase = 'opening';
  }
  hello() {
    this.started = true;
  }
  receivedState() {
    const initial = !this.hasState;
    if (!this.synchronized) this.phase = 'replaying';
    return initial;
  }
  synchronize() {
    if (!this.hasState || this.synchronized) return false;
    this.phase = 'synchronized';
    return true;
  }
  closed() {
    this.phase = 'disconnected';
    this.started = false;
  }
}

interface VisibilityHost {
  foreground(): void;
  suspend(): void;
  expire(): void;
}
/** Own the grace periods for hidden tabs and parked Herdr panes. */
export class TerminalVisibility {
  private shown = true;
  private seen: boolean;
  private expired = false;
  private parkState: 'active' | 'parked' | 'dormant' = 'active';
  private preview: boolean;
  private tabTimer?: ReturnType<typeof setTimeout>;
  private parkTimer?: ReturnType<typeof setTimeout>;
  private herdr: boolean;
  private host: VisibilityHost;
  private grace: number;
  constructor(
    herdr: boolean,
    embedded: boolean,
    preview: boolean,
    host: VisibilityHost,
    grace = 2000,
  ) {
    this.herdr = herdr;
    this.host = host;
    this.grace = grace;
    this.seen = !embedded;
    this.preview = preview;
  }
  get visible() {
    return this.shown;
  }
  get parked() {
    return this.parkState !== 'active';
  }
  available(recording: boolean) {
    return (
      !this.preview &&
      (this.herdr
        ? this.shown && this.parkState !== 'dormant'
        : this.shown || !this.expired || recording)
    );
  }
  authorize() {
    this.preview = false;
  }
  closed() {
    if (this.parked) this.parkState = 'dormant';
  }
  park(parked: boolean) {
    if (this.parked === parked) return false;
    clearTimeout(this.parkTimer);
    this.parkState = parked ? 'parked' : 'active';
    if (parked)
      this.parkTimer = setTimeout(() => {
        this.parkState = 'dormant';
        this.host.suspend();
      }, this.grace);
    return true;
  }
  setVisible(visible: boolean) {
    this.shown = visible;
  }
  /** Apply transport effects after the view has handled its visibility change. */
  updateTransport(active: boolean) {
    if (this.herdr) {
      if (this.shown) this.host.foreground();
      else this.host.suspend();
      return;
    }
    clearTimeout(this.tabTimer);
    this.seen ||= this.shown || active;
    if (this.shown) {
      this.expired = false;
      this.host.foreground();
    } else if (!this.seen) this.expired = true;
    else
      this.tabTimer = setTimeout(() => {
        this.expired = true;
        this.host.expire();
      }, this.grace);
  }
  dispose() {
    clearTimeout(this.tabTimer);
    clearTimeout(this.parkTimer);
  }
}
