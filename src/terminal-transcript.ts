import { plainText } from './terminal-snapshot.ts';
export interface TranscriptRecord { id: number; at: number; kind: 'history' | 'excerpt' | 'gap'; text: string }
const maximumText = 512 * 1024, maximumRecords = 64;

/** Retain observed output separately from terminal resets and full-screen redraws. */
export class TerminalTranscript {
  records: TranscriptRecord[] = [];
  private sequence = 0;
  observe(text: string, continuous: boolean, at = Date.now()) {
    text = text.slice(-maximumText);
    if (!text.trim()) return false;
    const previous = this.records.at(-1), before = this.records.at(-2);
    // Output that resumes where the record before a gap ended proves that nothing was missed.
    if (previous?.kind === 'gap' && before && (before.text === text || continuous && before.kind === 'history' && this.extend(before, text, at, true))) {
      this.records.splice(-1, 1); this.trim(); return true;
    }
    if (previous?.text === text) return false;
    if (continuous && previous?.kind === 'history') {
      if (this.extend(previous, text, at)) { this.trim(); return true; }
      this.gap('Output between these history samples may be missing.', at);
    }
    this.records.push({ id: ++this.sequence, at, kind: continuous ? 'history' : 'excerpt', text });
    this.trim(); return true;
  }
  /** Extend normal scrollback when the new sample continues it; across a gap, a short record cannot prove continuity. */
  private extend(previous: TranscriptRecord, text: string, at: number, strict = false) {
    const complete = previous.text.slice(0, previous.text.lastIndexOf('\n') + 1);
    if ((!strict || previous.text.split('\n').length > 3) && (text.startsWith(previous.text) || complete && text.startsWith(complete))) {
      previous.text = text; previous.at = at; return true;
    }
    const first = text.slice(0, text.indexOf('\n') + 1);
    if (!first) return false;
    let offset = previous.text.indexOf(first), attempts = 0;
    while (offset >= 0 && attempts++ < 8) {
      const overlap = previous.text.slice(offset);
      if ((!offset || previous.text[offset - 1] === '\n') && overlap.split('\n').length > 3 && text.startsWith(overlap)) {
        previous.text += text.slice(overlap.length); previous.at = at; return true;
      }
      offset = previous.text.indexOf(first, offset + 1);
    }
    return false;
  }
  /** Plain server history extends the latest styled record from four shared rows, keeping its styles. */
  backfill(text: string) {
    const previous = this.records.at(-1);
    if (previous?.kind === 'history') {
      const styled = previous.text.split('\n'), plain = styled.map(plainText), server = text.split('\n'), rows = Math.min(4, plain.length);
      for (let first = 0; first + rows <= plain.length && first < 64; first++) {
        const run = plain.slice(first, first + rows);
        for (let at = server.length - rows; at >= 0; at--) {
          if (server[at] !== run[0] || !run.every((row, index) => server[at + index] === row)) continue;
          previous.text = [...server.slice(0, at), ...styled.slice(first)].join('\n'); this.trim(); return;
        }
      }
    }
    this.observe(text, true);
  }
  gap(text: string, at = Date.now()) {
    if (!this.records.length || this.records.at(-1)?.kind === 'gap') return;
    this.records.push({ id: ++this.sequence, at, kind: 'gap', text }); this.trim();
  }
  restore(records: TranscriptRecord[]) {
    this.records = records.map(record => ({ ...record }));
    this.sequence = Math.max(0, ...records.map(record => record.id)); this.trim();
  }
  private trim() {
    let length = this.records.reduce((sum, record) => sum + record.text.length, 0);
    while (this.records.length > 1 && (length > maximumText || this.records.length > maximumRecords)) length -= this.records.shift()!.text.length;
    if (this.records[0]) this.records[0].text = this.records[0].text.slice(-maximumText);
  }
  text() {
    return this.records.map((record, index) => record.kind === 'gap' ? '[…]' :
      (record.kind === 'excerpt' && index && this.records[index - 1].kind !== 'gap' ? '[…]\n' : '') + record.text).join('\n');
  }
}
