import { Application, Signal, createEncoder, type OpusEncoderHandle } from 'libopus-wasm';
import { AUDIO_PROFILE, MAX_AUDIO_SAMPLES, MAX_OPUS_BYTES, opusFrame } from './voxtype-audio.ts';

/** One codec state per recording; bounded 20 ms input and 100 ms packet batch. */
export class DictationEncoder {
  private samples = new Int16Array(AUDIO_PROFILE.frameSamples);
  private sampleCount = 0;
  private totalSamples = 0;
  private encodedSamples = 0;
  private packets: Uint8Array[] = [];
  private sequence = 0;
  private bytes = 0;
  private finished = false;
  private codec: OpusEncoderHandle;
  private emit: (frame: ArrayBuffer) => void;
  private constructor(codec: OpusEncoderHandle, emit: (frame: ArrayBuffer) => void) {
    this.codec = codec;
    this.emit = emit;
  }
  static async create(emit: (frame: ArrayBuffer) => void) {
    const codec = await createEncoder({
      sampleRate: AUDIO_PROFILE.sampleRate,
      channels: AUDIO_PROFILE.channels,
      frameSize: AUDIO_PROFILE.frameSamples,
      application: Application.Voip,
      bitrate: 24000,
      signal: Signal.Voice,
      complexity: 5,
      vbr: true,
      vbrConstraint: true,
      dtx: false,
      fec: false,
    });
    if (
      !Number.isInteger(codec.getLookahead()) ||
      codec.getLookahead() < 0 ||
      codec.getLookahead() > 1280
    ) {
      codec.free();
      throw new Error('Unsupported Opus encoder delay.');
    }
    return new DictationEncoder(codec, emit);
  }
  audio(pcm: ArrayBuffer) {
    if (
      this.finished ||
      !pcm.byteLength ||
      pcm.byteLength % 2 ||
      pcm.byteLength > AUDIO_PROFILE.frameSamples * AUDIO_PROFILE.batchPackets * 2 ||
      this.totalSamples + pcm.byteLength / 2 > MAX_AUDIO_SAMPLES
    )
      throw new Error('Recording exceeded the audio limit.');
    const view = new DataView(pcm);
    this.totalSamples += pcm.byteLength / 2;
    for (let i = 0; i < pcm.byteLength; i += 2) {
      this.samples[this.sampleCount++] = view.getInt16(i, true);
      if (this.sampleCount === AUDIO_PROFILE.frameSamples) this.encode();
    }
  }
  private encode() {
    this.packets.push(this.codec.encode(this.samples, { maxPacketBytes: 1275 }));
    this.encodedSamples += AUDIO_PROFILE.frameSamples;
    this.sampleCount = 0;
    this.samples.fill(0);
    if (this.packets.length === AUDIO_PROFILE.batchPackets) this.flush();
  }
  private flush(final = false) {
    const frame = opusFrame(
      this.sequence++,
      this.packets,
      this.totalSamples ? this.codec.getLookahead() * 3 : 0,
      final ? this.totalSamples : undefined,
    );
    this.packets = [];
    this.bytes += frame.byteLength;
    if (this.bytes > MAX_OPUS_BYTES) throw new Error('Recording exceeded the encoded audio limit.');
    this.emit(frame);
  }
  finish() {
    if (this.finished) throw new Error('Audio encoder already finished.');
    this.finished = true;
    // Include the actual lookahead, so the daemon can trim without losing speech.
    if (this.totalSamples)
      while (this.encodedSamples < this.totalSamples + this.codec.getLookahead()) this.encode();
    this.flush(true);
    this.close();
  }
  close() {
    if (this.codec) {
      this.codec.free();
      this.finished = true;
    }
  }
}
