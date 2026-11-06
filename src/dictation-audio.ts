import { MAX_OPUS_BYTES, parseOpusFrame } from './voxtype-audio.ts';

/** Retain complete encoded frames until the recording is delivered or discarded. */
export class DictationAudio {
  private frames: ArrayBuffer[] = [];
  private bytes = 0;
  private next = 0;
  private forwarded = 0;
  private window = Infinity;
  private maxBytes: number = MAX_OPUS_BYTES;
  finished = false;
  append(frame: ArrayBuffer) {
    if (
      this.bytes + frame.byteLength > MAX_OPUS_BYTES ||
      parseOpusFrame(new Uint8Array(frame)).sequence !== this.frames.length
    )
      throw new Error('Recording exceeded its audio limit.');
    this.frames.push(frame);
    this.bytes += frame.byteLength;
  }
  limit(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 17 || bytes > MAX_OPUS_BYTES)
      throw new Error('Invalid encoded audio limit.');
    if (this.bytes > bytes) throw new Error('Recording exceeds the daemon audio limit.');
    this.maxBytes = bytes;
  }
  resume(accepted = 0, finished = false, window?: number) {
    if (
      (window !== undefined && (!Number.isSafeInteger(window) || window < 1 || window > 64)) ||
      !Number.isSafeInteger(accepted) ||
      accepted < 0 ||
      accepted > this.frames.length ||
      (finished && accepted !== this.frames.length)
    )
      throw new Error('Voxtype returned an invalid audio checkpoint.');
    this.window = window ?? Infinity;
    this.forwarded = this.next = accepted;
    this.finished = finished;
  }
  acknowledge(forwarded: number) {
    if (!Number.isSafeInteger(forwarded) || forwarded < this.forwarded || forwarded > this.next)
      throw new Error('Invalid dictation upload acknowledgement.');
    this.forwarded = forwarded;
  }
  get waitingForCredit() {
    return (
      Number.isFinite(this.window) &&
      (this.next >= this.forwarded + this.window ||
        (this.next === this.frames.length && this.forwarded < this.next))
    );
  }
  upload(send: (frame: ArrayBuffer) => boolean) {
    if (this.bytes > this.maxBytes) throw new Error('Recording exceeds the daemon audio limit.');
    for (let count = 0; this.next < this.frames.length && count < 4 && !this.finished; count++) {
      if (this.next >= this.forwarded + this.window) return false;
      if (!send(this.frames[this.next])) return false;
      this.next++;
    }
    return this.next === this.frames.length && !this.waitingForCredit;
  }
  clear() {
    this.frames = [];
    this.maxBytes = MAX_OPUS_BYTES;
    this.bytes = this.next = this.forwarded = 0;
    this.window = Infinity;
    this.finished = false;
  }
}
