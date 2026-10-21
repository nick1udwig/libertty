import { OSC8LinkProvider, UrlRegexProvider, type Terminal } from 'ghostty-web';

function browserLink(text: string): string | undefined {
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch { /* Incomplete URLs are ordinary terminal text. */ }
}

/** Resolve a web link synchronously so opening it retains the tap's user activation. */
export function terminalLinkAt(term: Pick<Terminal, 'buffer' | 'wasmTerm'>, col: number, row: number): string | undefined {
  const buffer = term.buffer.active, line = buffer.getLine(row);
  if (!line || col < 0 || col >= line.length) return;
  let explicit: string | undefined;
  new OSC8LinkProvider(term).provideLinks(row, links => {
    explicit = links?.find(link => col >= link.range.start.x && col <= link.range.end.x)?.text;
  });
  if (explicit !== undefined) return browserLink(explicit);

  const continues = (at: number) => {
    const next = buffer.getLine(at);
    if (next?.isWrapped) return true;
    if (at <= 0 || at >= (term.wasmTerm?.getScrollbackLength() ?? 0) || buffer.type === 'alternate') return false;
    // The pinned adapter omits scrollback wrap flags, so check occupied row edges there.
    const previous = buffer.getLine(at - 1);
    return (previous?.getCell(previous.length - 1)?.getCodepoint() ?? 0) > 32 && (next?.getCell(0)?.getCodepoint() ?? 0) > 32;
  };

  // Ghostty's regex provider scans one row, so join wrapped rows before detecting URLs.
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
  const logicalLine = {
    length: codepoints.length,
    getCell: (x: number) => ({ getCodepoint: () => codepoints[x] }),
  };
  let result: string | undefined;
  new UrlRegexProvider({ buffer: { active: { getLine: () => logicalLine } } }).provideLinks(0, links => {
    const link = links?.find(link => offset >= link.range.start.x && offset <= link.range.end.x);
    if (link) result = browserLink(link.text);
  });
  return result;
}
