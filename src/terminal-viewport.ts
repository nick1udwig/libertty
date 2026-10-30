import type { Terminal } from './terminal-adapter.ts';

const preserving = new WeakSet<Terminal>();
/** Synthetic scroll events during an anchored update are not user gestures. */
export function isPreservingScrollback(term: Terminal) { return preserving.has(term); }

/** Keep the visible history anchored when layout or incoming output changes.
 * Ghostty measures scroll position from the bottom and resets it on writes. */
export function preserveScrollback(term: Terminal, update: () => void) {
  const buffer = term.buffer.active;
  const top = buffer.type === 'normal' && term.getViewportY() > 0
    ? buffer.length - term.rows - term.getViewportY() : undefined;
  const nested = preserving.has(term); preserving.add(term);
  try {
    update();
    if (top !== undefined && term.buffer.active.type === 'normal')
      term.scrollToLine(term.buffer.active.length - term.rows - top);
  } finally { if (!nested) preserving.delete(term); }
}
