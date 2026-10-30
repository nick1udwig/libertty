import { GHOSTTY_BUILD } from '@gespenst/core/headless';
import type { Terminal } from './terminal-adapter.ts';

import { nativeTerminalSnapshot, type NativeTerminalSnapshot } from './terminal-cache.ts';
export type { NativeTerminalSnapshot } from './terminal-cache.ts';

export function captureNativeSnapshot(term: Terminal): NativeTerminalSnapshot | undefined {
  try {
    return nativeTerminalSnapshot({ build: GHOSTTY_BUILD.sha256, cols: term.cols, rows: term.rows, bytes: term.wasmTerm!.core.snapshot() });
  } catch { return; }
}

/** Restore only matching geometry so cached state cannot resize the live viewport. */
export function restoreNativeSnapshot(term: Terminal, value: unknown, position: number): boolean {
  const snapshot = nativeTerminalSnapshot(value);
  if (!snapshot || snapshot.build !== GHOSTTY_BUILD.sha256 || snapshot.cols !== term.cols || snapshot.rows !== term.rows) return false;
  try {
    term.wasmTerm!.restore(snapshot.bytes);
    term.scrollToLine(position);
    return true;
  } catch { return false; }
}
