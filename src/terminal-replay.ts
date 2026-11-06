import { Queue } from './queue.ts';
import type { ServerMessage } from './protocol.ts';
type Output = Extract<ServerMessage, { type: 'output' }>;
export class TerminalReplay {
  readonly queue = new Queue<Output>();
  after = 0;
  received = 0;
  target: number | undefined;
  stream = '';
  private socketSequence = 0;
  private acknowledged = 0;
  get cursor() {
    return Math.max(this.after, this.received);
  }
  get complete() {
    return !this.queue.length && this.after >= (this.target ?? this.after);
  }
  opened() {
    this.socketSequence = this.acknowledged = 0;
  }
  receive(message: Output) {
    this.socketSequence = Math.max(this.socketSequence, message.seq);
    if (message.seq > this.received) {
      this.queue.push(message);
      this.received = message.seq;
    }
  }
  take(limit = 65536) {
    let bytes = 0,
      sequence = this.after;
    const chunks: string[] = [];
    while (this.queue.length && bytes < limit) {
      const item = this.queue.shift()!;
      if (item.seq <= sequence) continue;
      chunks.push(item.data);
      sequence = item.seq;
      bytes += item.data.length;
    }
    return { chunks, sequence };
  }
  reset() {
    this.after = this.received = 0;
    this.queue.clear();
  }
  acknowledge(send: (sequence: number) => boolean) {
    const sequence = Math.min(this.after, this.socketSequence);
    if (sequence > this.acknowledged && send(sequence)) this.acknowledged = sequence;
  }
}
