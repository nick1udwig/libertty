export interface TranscriptRecord { id: number; at: number; kind: 'history' | 'excerpt' | 'gap'; text: string }
const maximumText = 512 * 1024, maximumRecords = 64;

/** Retain observed output separately from terminal resets and full-screen redraws. */
export class TerminalTranscript {
  records: TranscriptRecord[] = [];
  private sequence = 0;
  observe(text: string, continuous: boolean, at = Date.now()) {
    text = text.slice(-maximumText);
    if (!text.trim()) return false;
    const previous = this.records.at(-1);
    if (previous?.text === text) return false;
    if (continuous && previous?.kind === 'history') {
      const complete = previous.text.slice(0, previous.text.lastIndexOf('\n') + 1);
      if (text.startsWith(previous.text) || complete && text.startsWith(complete)) {
        previous.text = text; previous.at = at; this.trim(); return true;
      }
      const first = text.slice(0, text.indexOf('\n') + 1);
      if (first) {
        let offset = previous.text.indexOf(first), attempts = 0;
        while (offset >= 0 && attempts++ < 8) {
          const overlap = previous.text.slice(offset);
          if ((!offset || previous.text[offset - 1] === '\n') && overlap.split('\n').length > 3 && text.startsWith(overlap)) {
            previous.text += text.slice(overlap.length); previous.at = at; this.trim(); return true;
          }
          offset = previous.text.indexOf(first, offset + 1);
        }
      }
      this.gap('Output between these history samples may be missing.', at);
    }
    this.records.push({ id: ++this.sequence, at, kind: continuous ? 'history' : 'excerpt', text });
    this.trim(); return true;
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
    return this.records.map(record => record.kind === 'gap' ? `[${record.text}]` :
      `[${record.kind === 'excerpt' ? 'Observed screen; gaps may exist' : 'Terminal history'} · ${new Date(record.at).toLocaleString()}]\n${record.text}`).join('\n\n');
  }
}
