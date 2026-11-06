// Begin generated dictation profile.
const AUDIO_PROFILE = {"protocol":2,"sampleRate":16000,"channels":1,"frameSamples":320,"batchPackets":5,"maxSeconds":300,"maxEncodedBytes":2097152,"maxFrames":15002};
// End generated dictation profile.
// Streaming mono downsampling, retaining fractional sample coverage across blocks.
class DictationPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / AUDIO_PROFILE.sampleRate;
    this.chunkSamples = AUDIO_PROFILE.frameSamples * AUDIO_PROFILE.batchPackets;
    this.remaining = this.ratio; this.sum = 0;
    this.samples = []; this.stopped = false; this.gain = 1; this.power = 0; this.pending = 0;
    this.port.onmessage = event => {
      if (event?.data?.type === 'consumed') { this.pending = Math.max(0, this.pending - 1); return; }
      this.flush(); this.stopped = true; this.port.postMessage('flushed');
    };
  }
  flush() {
    if (!this.samples.length || this.stopped) return;
    if (this.pending >= 8) { this.samples = []; this.stopped = true; this.port.postMessage({ type: 'error', message: 'Audio encoding is too slow. Please try again.' }); return; }
    this.pending++;
    const bytes = new ArrayBuffer(this.samples.length * 2), view = new DataView(bytes);
    this.samples.forEach((value, index) => view.setInt16(index * 2, value, true));
    this.samples = []; this.port.postMessage(bytes, [bytes]);
  }
  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    // Lift quiet speech by at most 12 dB. Keep the noise floor and already loud
    // recordings unchanged, and reserve peak headroom before PCM conversion.
    let power = 0, peak = 0;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      power += value * value; peak = Math.max(peak, Math.abs(value));
    }
    const seconds = channels[0].length / sampleRate;
    this.power += (power / channels[0].length - this.power) * (1 - Math.exp(-seconds / 0.1));
    const rms = Math.sqrt(this.power);
    const target = rms >= 0.003 ? Math.max(1, Math.min(4, 0.063 / rms)) : 1;
    this.gain += (target - this.gain) * (1 - Math.exp(-seconds / 0.12));
    this.gain = Math.min(this.gain, Math.max(1, peak ? 0.95 / peak : 4));
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      value *= this.gain;
      let weight = 1;
      while (weight > 1e-8) {
        const used = Math.min(weight, this.remaining);
        this.sum += value * used; this.remaining -= used; weight -= used;
        if (this.remaining < 1e-8) {
          const normalized = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.samples.push(Math.round(normalized * (normalized < 0 ? 32768 : 32767)));
          this.sum = 0; this.remaining = this.ratio;
          if (this.samples.length >= this.chunkSamples) { this.flush(); if (this.stopped) return false; }
        }
      }
    }
    return true;
  }
}
registerProcessor('dictation-pcm', DictationPCM);
