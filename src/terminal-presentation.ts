/** Copy the canvas bitmap without resampling and place it over the original, so held glyphs match the terminal pixel for pixel. */
function holdPicture(viewport: HTMLElement, layer: HTMLElement, snapshot: HTMLCanvasElement) {
  const canvas = viewport.querySelector<HTMLCanvasElement>('#terminal canvas');
  const bounds = viewport.getBoundingClientRect(), parent = viewport.parentElement!.getBoundingClientRect();
  if (!canvas?.width || !bounds.width || !bounds.height) return false;
  const source = canvas.getBoundingClientRect();
  snapshot.width = canvas.width; snapshot.height = canvas.height;
  snapshot.getContext('2d')!.drawImage(canvas, 0, 0);
  Object.assign(snapshot.style, { left: source.left - parent.left + 'px', top: source.top - bounds.top + 'px', width: source.width + 'px', height: source.height + 'px' });
  layer.style.top = bounds.top - parent.top + 'px';
  layer.style.height = bounds.height + 'px';
  layer.hidden = false;
  return true;
}

/** Hold one painted viewport while its terminal parses a fresh replay or frame. */
export class TerminalPresentation {
  private layer = document.createElement('div');
  private snapshot = document.createElement('canvas');
  private progress = document.createElement('div');
  private generation = 0;
  private held = false;
  private waiting = false;
  private viewport: HTMLElement;
  private ready: () => void;
  constructor(viewport: HTMLElement, ready: () => void = () => {}, progress = true) {
    this.viewport = viewport; this.ready = ready;
    this.layer.className = progress ? 'terminal-presentation' : 'dictation-presentation'; this.layer.hidden = true;
    this.snapshot.setAttribute('aria-hidden', 'true');
    this.progress.className = 'terminal-loading-bar'; this.progress.role = 'progressbar';
    this.progress.setAttribute('aria-label', 'Loading terminal');
    this.layer.append(this.snapshot);
    if (progress) this.layer.append(this.progress);
    viewport.parentElement!.append(this.layer);
  }
  get pending() { return this.waiting; }
  freeze(progress = true) {
    ++this.generation; this.waiting = true;
    if (this.held || !holdPicture(this.viewport, this.layer, this.snapshot)) return;
    this.progress.hidden = !progress;
    this.held = true;
    this.viewport.setAttribute('aria-busy', 'true');
  }
  wait() {
    ++this.generation; this.waiting = true;
    this.layer.hidden = true; this.held = false;
    this.snapshot.width = this.snapshot.height = 0;
    this.viewport.setAttribute('aria-busy', 'true');
  }
  reveal() {
    if (!this.waiting) return;
    const generation = this.generation;
    // Terminal writes parse synchronously, but the renderer paints on a later frame.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation !== this.generation || !this.waiting) return;
      this.layer.hidden = true; this.held = this.waiting = false;
      this.snapshot.width = this.snapshot.height = 0;
      this.viewport.setAttribute('aria-busy', 'false');
      this.ready();
    }));
  }
}

/** Keep a resized pane's previous picture at its previous bottom edge until the application's redrawn picture paints.
 * The layer is anchored to both viewport edges and the copy to the bottom, so layout keeps them aligned as the frame changes size. */
export class TerminalResizeCover {
  private layer = document.createElement('div');
  private snapshot = document.createElement('canvas');
  private generation = 0;
  private viewport: HTMLElement;
  constructor(viewport: HTMLElement) {
    this.viewport = viewport;
    this.layer.className = 'terminal-resize-cover'; this.layer.hidden = true;
    this.snapshot.setAttribute('aria-hidden', 'true');
    this.layer.append(this.snapshot); viewport.parentElement!.append(this.layer);
  }
  get held() { return !this.layer.hidden; }
  /** Fitted height is the viewport height that the canvas was last sized for. */
  hold(fittedHeight: number) {
    const canvas = this.viewport.querySelector<HTMLCanvasElement>('#terminal canvas');
    const bounds = this.viewport.getBoundingClientRect(), parent = this.viewport.parentElement!.getBoundingClientRect();
    if (this.held || !canvas?.width || !bounds.height) return;
    const source = canvas.getBoundingClientRect();
    ++this.generation;
    this.snapshot.width = canvas.width; this.snapshot.height = canvas.height;
    this.snapshot.getContext('2d')!.drawImage(canvas, 0, 0);
    Object.assign(this.layer.style, { top: bounds.top - parent.top + 'px', bottom: parent.bottom - bounds.bottom + 'px' });
    Object.assign(this.snapshot.style, { left: source.left - parent.left + 'px', bottom: fittedHeight - (source.bottom - bounds.top) + 'px', width: source.width + 'px', height: source.height + 'px' });
    this.layer.hidden = false;
  }
  reveal() {
    const generation = this.generation;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (generation === this.generation) this.release(); }));
  }
  release() { ++this.generation; this.layer.hidden = true; this.snapshot.width = this.snapshot.height = 0; }
}
