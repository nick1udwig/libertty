import { MAX_OPUS_BYTES, parseOpusFrame } from './voxtype-audio.ts';

/** Retain complete encoded frames until the recording is delivered or discarded. */
export class DictationAudio {
  private frames: ArrayBuffer[] = [];
  private bytes = 0;
  private next = 0;
  finished = false;
  append(frame: ArrayBuffer) {
    if (this.bytes + frame.byteLength > MAX_OPUS_BYTES || parseOpusFrame(new Uint8Array(frame)).sequence !== this.frames.length) throw new Error('Recording exceeded its audio limit.');
    this.frames.push(frame); this.bytes += frame.byteLength;
  }
  resume(accepted = 0, finished = false) {
    if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted > this.frames.length || finished && accepted !== this.frames.length) throw new Error('Voxtype returned an invalid audio checkpoint.');
    this.next = accepted; this.finished = finished;
  }
  upload(send: (frame: ArrayBuffer) => boolean) {
    for (let count = 0; this.next < this.frames.length && count < 4 && !this.finished; count++) {
      if (!send(this.frames[this.next])) return false;
      this.next++;
    }
    return this.next === this.frames.length;
  }
  clear() { this.frames = []; this.bytes = this.next = 0; this.finished = false; }
}
