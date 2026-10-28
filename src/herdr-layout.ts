/** The mobile Herdr layout handshake: after a geometry change the pane stays covered until Herdr's redraw barrier passes and a full frame at the new size paints. */
export class HerdrLayout {
  /** Waiting for a frame at the requested geometry. */
  pending = false;
  /** A full frame at the requested geometry has arrived. */
  matched = false;
  barrierReady = true;
  /** The last certified picture stays visible while the new layout redraws. */
  preserve = false;
  /** A certified mobile picture is on screen. */
  rendered = false;
  private frame = 0;
  private viewport: HTMLElement;
  constructor(viewport: HTMLElement) { this.viewport = viewport; }
  /** Start waiting for a layout, covering the pane unless its picture is preserved. */
  set({ pending, preserve = this.preserve, cover = pending && !preserve, barrierReady = false }: { pending: boolean; preserve?: boolean; cover?: boolean; barrierReady?: boolean }) {
    this.cancel();
    this.pending = pending; this.matched = false; this.preserve = preserve; this.barrierReady = barrierReady;
    this.viewport.classList.toggle('awaiting-herdr-layout', cover);
  }
  /** Retained output stays visible while the handshake waits for its first live frame. */
  uncover() { this.viewport.classList.remove('awaiting-herdr-layout'); }
  /** A desktop layout needs no handshake and has no certified mobile picture. */
  desktop() {
    this.rendered = false; this.preserve = false;
    if (this.pending) { this.pending = false; this.viewport.classList.remove('awaiting-herdr-layout'); }
  }
  /** A preserved picture is not replaced until the redraw barrier passes. */
  get holding() { return this.pending && this.preserve && !this.barrierReady; }
  /** Accept a frame while pending; only a full frame at the requested size matches. */
  accept(sized: boolean, full: boolean) {
    if (!sized) { this.matched = false; this.cancel(); return false; }
    if (!this.matched && !full) return false;
    this.matched = true; return true;
  }
  get ready() { return !this.frame && this.pending && this.matched && this.barrierReady; }
  /** Uncover the pane two frames later, unless the layout or the conditions changed meanwhile. */
  reveal(current: () => boolean, revealed: () => void) {
    const finish = () => {
      this.frame = 0;
      if (!current() || !this.pending || !this.matched || !this.barrierReady) return;
      this.pending = false; this.preserve = false; this.rendered = true; this.viewport.classList.remove('awaiting-herdr-layout');
      revealed();
    };
    this.frame = requestAnimationFrame(() => { this.frame = requestAnimationFrame(finish); });
  }
  cancel() { cancelAnimationFrame(this.frame); this.frame = 0; }
}
