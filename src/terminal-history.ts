import type { ServerMessage } from './protocol.ts';
type HistoryMessage = Extract<ServerMessage, { type: 'screen' | 'screen-delta' }>;

/** Reconstruct each connection's history from a baseline and ordered edits. */
export class TerminalHistory {
  private text = '';
  private version?: number;
  private requested = false;
  private refresh: () => void;
  constructor(refresh: () => void) { this.refresh = refresh; }
  get currentVersion() { return this.version; }
  reset() { this.text = ''; this.version = undefined; this.requested = false; }
  receive(message: HistoryMessage): string | undefined {
    if (message.type === 'screen') {
      this.text = message.text; this.version = message.version; this.requested = false;
      return this.text;
    }
    const { drop, from, tail } = message;
    if (this.requested || message.base !== this.version || ![drop, from, tail].every(value => Number.isSafeInteger(value) && value >= 0)
      || drop + from + tail > this.text.length || message.version !== message.base + 1) {
      if (!this.requested) { this.requested = true; this.refresh(); }
      return;
    }
    this.text = this.text.slice(drop, drop + from) + message.text + (tail ? this.text.slice(-tail) : '');
    this.version = message.version;
    return this.text;
  }
}
