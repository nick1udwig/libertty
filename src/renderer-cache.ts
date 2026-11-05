/** One workspace budget for native terminal and Herdr pane renderers. */
export class RendererCache<T> {
  private entries = new Map<T, { canEvict(): boolean; dispose(): void }>();
  private capacity: number;
  constructor(capacity = 4) {
    this.capacity = capacity;
  }
  retain(key: T, entry: { canEvict(): boolean; dispose(): void }) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.trim();
  }
  touch(key: T) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
  }
  release(key: T) {
    this.entries.delete(key);
  }
  trim() {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (entry.canEvict()) {
        this.entries.delete(key);
        entry.dispose();
      }
    }
  }
}
export const terminalRenderers = new RendererCache<HTMLIFrameElement>();
