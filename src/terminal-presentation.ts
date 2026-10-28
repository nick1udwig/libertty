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
  /** A handoff from retained output to its live replay shows no progress, so the swap is not noticeable. */
  freeze(progress = true) {
    ++this.generation; this.waiting = true;
    if (this.held) return;
    this.progress.hidden = !progress;
    const canvas = this.viewport.querySelector<HTMLCanvasElement>('#terminal canvas');
    const bounds = this.viewport.getBoundingClientRect();
    if (!canvas?.width || !bounds.width || !bounds.height) return;
    const source = canvas.getBoundingClientRect(), scale = devicePixelRatio || 1;
    this.snapshot.width = Math.ceil(bounds.width * scale); this.snapshot.height = Math.ceil(bounds.height * scale);
    const context = this.snapshot.getContext('2d')!;
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg'); context.fillRect(0, 0, this.snapshot.width, this.snapshot.height);
    context.drawImage(canvas, (source.left - bounds.left) * scale, (source.top - bounds.top) * scale, source.width * scale, source.height * scale);
    this.layer.style.top = bounds.top - this.viewport.parentElement!.getBoundingClientRect().top + 'px';
    this.layer.style.height = bounds.height + 'px';
    this.layer.hidden = false; this.held = true;
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
