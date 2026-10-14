/** Hold one painted viewport while its terminal parses a fresh replay or frame. */
export class TerminalPresentation {
  private layer = document.createElement('div');
  private snapshot = document.createElement('canvas');
  private progress = document.createElement('div');
  private generation = 0;
  private held = false;
  private viewport: HTMLElement;
  private ready: () => void;
  constructor(viewport: HTMLElement, ready: () => void = () => {}) {
    this.viewport = viewport; this.ready = ready;
    this.layer.className = 'terminal-presentation'; this.layer.hidden = true;
    this.snapshot.setAttribute('aria-hidden', 'true');
    this.progress.className = 'terminal-loading-bar'; this.progress.role = 'progressbar';
    this.progress.setAttribute('aria-label', 'Loading terminal');
    this.layer.append(this.snapshot, this.progress); viewport.parentElement!.append(this.layer);
  }
  get pending() { return this.held; }
  freeze() {
    ++this.generation;
    if (this.held) return;
    const canvas = this.viewport.querySelector<HTMLCanvasElement>('#terminal canvas');
    const bounds = this.viewport.getBoundingClientRect();
    if (!canvas?.width || !bounds.width || !bounds.height) return;
    const source = canvas.getBoundingClientRect(), scale = devicePixelRatio || 1;
    this.snapshot.width = Math.ceil(bounds.width * scale); this.snapshot.height = Math.ceil(bounds.height * scale);
    const context = this.snapshot.getContext('2d')!;
    context.fillStyle = '#0c1310'; context.fillRect(0, 0, this.snapshot.width, this.snapshot.height);
    context.drawImage(canvas, (source.left - bounds.left) * scale, (source.top - bounds.top) * scale, source.width * scale, source.height * scale);
    this.layer.style.height = bounds.height + 'px';
    this.layer.hidden = false; this.held = true;
    this.viewport.setAttribute('aria-busy', 'true');
  }
  reveal() {
    if (!this.held) return;
    const generation = this.generation;
    // Terminal writes parse synchronously, but the renderer paints on a later frame.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation !== this.generation || !this.held) return;
      this.layer.hidden = true; this.held = false;
      this.snapshot.width = this.snapshot.height = 0;
      this.viewport.setAttribute('aria-busy', 'false');
      this.ready();
    }));
  }
}
