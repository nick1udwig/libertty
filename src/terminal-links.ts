import type { Terminal } from './terminal-adapter.ts';

function browserLink(text: string): string | undefined {
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch { /* Incomplete URLs are ordinary terminal text. */ }
}

/** Resolve a web link synchronously so opening it retains the tap's user activation. */
export function terminalLinkAt(term: Pick<Terminal, 'buffer' | 'wasmTerm'>, col: number, row: number, nativeFrame = false): string | undefined {
  const buffer = term.buffer.active, line = buffer.getLine(row);
  if (!line || col < 0 || col >= line.length) return;
  if (line.getCell(col)?.getHyperlinkId()) {
    const scrollback = term.wasmTerm?.getScrollbackLength() ?? 0;
    const uri = row < scrollback ? term.wasmTerm?.getScrollbackHyperlinkUri(row, col) : term.wasmTerm?.getHyperlinkUri(row - scrollback, col);
    return uri ? browserLink(uri) : undefined;
  }

  const continues = (at: number) => {
    if (at <= 0) return false;
    const previous = buffer.getLine(at - 1), next = buffer.getLine(at);
    const occupiedEdges = (previous?.getCell(previous.length - 1)?.getCodepoint() ?? 0) > 32
      && (next?.getCell(0)?.getCodepoint() ?? 0) > 32;
    // Repainted rows can retain stale wrap flags after an application clears their tail.
    return occupiedEdges && (next?.isWrapped || nativeFrame);
  };

  // Join wrapped rows before detecting URLs.
  let first = row;
  while (first > 0 && continues(first)) first--;
  const codepoints: number[] = [];
  let offset = col;
  for (let at = first; ; at++) {
    const part = buffer.getLine(at);
    if (!part) break;
    if (at === row) offset += codepoints.length;
    for (let x = 0; x < part.length; x++) {
      const codepoint = part.getCell(x)?.getCodepoint() || 32;
      // Keep one UTF-16 character per cell, including wide-cell padding and emoji before a URL.
      codepoints.push(codepoint > 0xffff ? 32 : codepoint);
    }
    if (!continues(at + 1)) break;
  }
  const text = codepoints.map(codepoint => String.fromCharCode(codepoint)).join('');
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let candidate = match[0].replace(/[.,;:!?]+$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (candidate.endsWith(close) && candidate.split(close).length > candidate.split(open).length) candidate = candidate.slice(0, -1);
    }
    if (offset >= match.index && offset < match.index + candidate.length) return browserLink(candidate);
  }
}
