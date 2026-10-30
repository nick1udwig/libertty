import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ghostty } from '../src/terminal-core.ts';
import { Terminal } from '../src/terminal-adapter.ts';
import { terminalLinkAt } from '../src/terminal-links.ts';

const ghostty = await Ghostty.load({
  wasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-vt.wasm', import.meta.url)),
  callbacksWasm: await readFile(new URL('../node_modules/@gespenst/core/dist/ghostty-callbacks.wasm', import.meta.url)),
});

function terminal(rows: { text: string; wrapped?: boolean; uri?: string }[]) {
  const lines = rows.map(row => ({
    isWrapped: !!row.wrapped, length: Array.from(row.text).length,
    getCell: (col: number) => col < Array.from(row.text).length ? {
      getCodepoint: () => Array.from(row.text)[col].codePointAt(0)!,
      getHyperlinkId: () => row.uri ? 1 : 0,
    } : undefined,
  }));
  return {
    buffer: { active: { getLine: (row: number) => lines[row] } },
    wasmTerm: {
      getScrollbackLength: () => 1,
      getHyperlinkUri: (row: number) => rows[row + 1]?.uri || null,
      getScrollbackHyperlinkUri: (row: number) => rows[row]?.uri || null,
    },
  } as unknown as Parameters<typeof terminalLinkAt>[0];
}

test('web URLs open without sentence punctuation or adjacent ordinary text', () => {
  const text = 'See https://example.com/path?q=1#part. Done';
  const term = terminal([{ text }]);
  assert.equal(terminalLinkAt(term, 4, 0), 'https://example.com/path?q=1#part');
  assert.equal(terminalLinkAt(term, 30, 0), 'https://example.com/path?q=1#part');
  for (const col of [0, text.indexOf('. Done'), text.indexOf('Done'), -1, 100]) assert.equal(terminalLinkAt(term, col, 0), undefined);
  assert.equal(terminalLinkAt(term, 0, 100), undefined);
});

test('URL punctuation preserves balanced path brackets and excludes surrounding punctuation', () => {
  const text = 'See (https://example.com/a_(b)).';
  const term = terminal([{ text }]);
  assert.equal(terminalLinkAt(term, 5, 0), 'https://example.com/a_(b)');
  assert.equal(terminalLinkAt(term, text.indexOf('(b)') + 2, 0), 'https://example.com/a_(b)');
  for (const col of [4, text.length - 2, text.length - 1]) assert.equal(terminalLinkAt(term, col, 0), undefined);
});

test('every wrapped URL segment resolves to the complete link without joining hard line breaks', () => {
  const term = terminal([
    { text: 'https://example.com/' },
    { text: 'a/long/path?q=1', wrapped: true },
    { text: '#fragment', wrapped: true },
    { text: 'separate-output' },
  ]);
  for (const [col, row] of [[0, 0], [10, 0], [3, 1], [4, 2]])
    assert.equal(terminalLinkAt(term, col, row), 'https://example.com/a/long/path?q=1#fragment');
  assert.equal(terminalLinkAt(term, 0, 3), undefined);
});

test('real terminal URLs remain complete when wrapped rows enter scrollback', () => {
  const url = 'https://example.com/a/long/path?q=1#fragment';
  for (const cols of [7, 20, 40]) for (const trailing of ['', '\r\nnext', '\r\nnext\r\nend', '\r\n'.repeat(8)]) {
    const term = new Terminal({ cols, rows: 3 });
    term.wasmTerm = ghostty.createTerminal(cols, 3);
    try {
      term.wasmTerm.write(url + trailing);
      for (let offset = 0; offset < url.length; offset++)
        assert.equal(terminalLinkAt(term, offset % cols, Math.floor(offset / cols)), url, `URL cell ${offset} at width ${cols} with ${JSON.stringify(trailing)}`);
    } finally { term.wasmTerm.free(); }
  }
});

test('short hard lines in real terminal history do not extend a URL', () => {
  const term = new Terminal({ cols: 40, rows: 3 });
  term.wasmTerm = ghostty.createTerminal(40, 3);
  try {
    term.wasmTerm.write('before\r\nhttps://example.com/path\r\nseparate-output\r\n' + '\r\n'.repeat(5));
    assert.equal(terminalLinkAt(term, 0, 0), undefined);
    assert.equal(terminalLinkAt(term, 0, 1), 'https://example.com/path');
    assert.equal(terminalLinkAt(term, 0, 2), undefined);
  } finally { term.wasmTerm.free(); }
});

test('native screen repaints resolve wrapped GitHub links without wrap flags', () => {
  const url = 'https://github.com/nick1udwig/libertty/pull/new/feat/links-work-across-linebreaks';
  const prefix = 'remote:      ', text = prefix + url;
  for (const cols of [40, 52, 70]) {
    const term = new Terminal({ cols, rows: 12 });
    term.wasmTerm = ghostty.createTerminal(cols, 12);
    try {
      // Match the full-frame reset in TerminalProjection before painting absolute rows.
      term.wasmTerm.write('\x1bc\x1b[2J\x1b[H');
      for (let offset = 0; offset < text.length; offset += cols)
        term.wasmTerm.write('\x1b[' + (Math.floor(offset / cols) + 1) + ';1H' + text.slice(offset, offset + cols));
      assert.equal(term.wasmTerm.getScrollbackLength(), 0);
      for (let offset = prefix.length; offset < text.length; offset++) {
        const row = Math.floor(offset / cols);
        assert.equal(term.buffer.active.getLine(row)?.isWrapped, false);
        assert.equal(terminalLinkAt(term, offset % cols, row, true), url, `Native URL cell ${offset} at width ${cols}`);
      }
      assert.equal(terminalLinkAt(term, 0, 0, true), undefined);
    } finally { term.wasmTerm.free(); }
  }
});

test('wide-cell padding and emoji before a link preserve cell coordinates', () => {
  const term = terminal([{ text: '界\0😀\0 https://example.com' }]);
  assert.equal(terminalLinkAt(term, 5, 0), 'https://example.com/');
  assert.equal(terminalLinkAt(term, 23, 0), 'https://example.com/');
  assert.equal(terminalLinkAt(term, 4, 0), undefined);
});

test('labeled hyperlinks resolve their destination in live output and scrollback', () => {
  const term = terminal([{ text: 'Older link', uri: 'https://example.com/older' }, { text: 'New link', uri: 'http://example.com/new' }]);
  assert.equal(terminalLinkAt(term, 2, 0), 'https://example.com/older');
  assert.equal(terminalLinkAt(term, 2, 1), 'http://example.com/new');
});

test('real OSC 8 links resolve destinations in live output and scrollback', () => {
  const term = new Terminal({ cols: 40, rows: 3 });
  term.wasmTerm = ghostty.createTerminal(40, 3);
  try {
    term.wasmTerm.write('\x1b]8;;https://example.com/older\x07Older link\x1b]8;;\x07\r\n');
    term.wasmTerm.write('\x1b]8;;https://example.com/new\x07New link\x1b]8;;\x07');
    assert.equal(terminalLinkAt(term, 2, 0), 'https://example.com/older');
    assert.equal(terminalLinkAt(term, 2, 1), 'https://example.com/new');
    term.wasmTerm.write('\r\n'.repeat(5));
    assert.equal(terminalLinkAt(term, 2, 0), 'https://example.com/older');
    assert.equal(terminalLinkAt(term, 2, 1), 'https://example.com/new');
  } finally { term.wasmTerm.free(); }
});

test('terminal text cannot activate non-web schemes or override an explicit unsafe hyperlink', () => {
  for (const uri of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/readme', 'mailto:me@example.com', 'relative', 'https://']) {
    const term = terminal([{ text: 'https://example.com', uri }]);
    assert.equal(terminalLinkAt(term, 1, 0), undefined);
  }
  assert.equal(terminalLinkAt(terminal([{ text: 'ssh://example.com' }]), 1, 0), undefined);
});


test('cleared row tails stop URLs even when the following row retains a wrap flag', () => {
  const term = terminal([
    { text: 'https://example.com/path    ' },
    { text: 'separate-output', wrapped: true },
  ]);
  for (const nativeFrame of [false, true]) {
    assert.equal(terminalLinkAt(term, 0, 0, nativeFrame), 'https://example.com/path');
    assert.equal(terminalLinkAt(term, 0, 1, nativeFrame), undefined);
  }
});
