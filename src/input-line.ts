/** Track only edits we can explain. Completion/history/unknown escape sequences suspend
 * repairs until a new prompt, rather than guessing at the shell's editable buffer. */
export class InputLine {
  text = '';
  cursor = 0;
  known = false;
  reset(text = '') {
    this.text = text;
    this.cursor = text.length;
    this.known = true;
  }
  insert(text: string) {
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
  }
  feed(data: string) {
    if (!this.known) return;
    if (/^[^\x00-\x1f\x7f]+$/.test(data)) {
      this.insert(data);
      return;
    }
    const before = this.text.slice(0, this.cursor),
      after = this.text.slice(this.cursor);
    if (data === '\x7f' || data === '\b') {
      this.cursor -= Array.from(before).at(-1)?.length || 0;
      this.text = this.text.slice(0, this.cursor) + after;
    } else if (data === '\x1b[D' || data === '\x02')
      this.cursor -= Array.from(before).at(-1)?.length || 0;
    else if (data === '\x1b[C' || data === '\x06') this.cursor += Array.from(after)[0]?.length || 0;
    else if (data === '\x01' || data === '\x1b[H') this.cursor = 0;
    else if (data === '\x05' || data === '\x1b[F') this.cursor = this.text.length;
    else if (data === '\x15') {
      this.text = after;
      this.cursor = 0;
    } else if (data === '\x0b') this.text = before;
    else if (data === '\x1b[3~')
      this.text = before + after.slice(Array.from(after)[0]?.length || 0);
    else this.known = false;
  }
}
