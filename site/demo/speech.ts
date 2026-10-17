import type { Recorder, Recording } from './recording.ts';

/** Stands in for Voxtype: Whisper transcribes the microphone audio the app records, inside the browser. */

// The model downloads on the first dictation, while the visitor is still speaking.
let worker: Worker | undefined, requests = 0;
const pending = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();
function transcribe(audio?: Float32Array): Promise<string> {
  if (!worker) {
    worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; text?: string; error?: string }>) => {
      const request = pending.get(event.data.id); pending.delete(event.data.id);
      if (event.data.error) request?.reject(new Error(event.data.error)); else request?.resolve(event.data.text || '');
    };
  }
  const id = ++requests;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker!.postMessage({ id, audio }, audio ? [audio.buffer] : []); });
}

// The app opens the microphone in a terminal frame, which records the same stream it shows levels for.
let microphone: Recorder | undefined;
export function microphoneOpened(record: Recorder) { microphone = record; }

/** Decode the recording at the 16 kHz mono rate Whisper expects. */
async function samples(recording: Blob): Promise<Float32Array> {
  if (!recording.size) return new Float32Array();
  const audio = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await recording.arrayBuffer());
  return audio.getChannelData(0).slice();
}
// Whisper marks silence and noise with bracketed tags and ends sentences with a period, which a command line does not want.
const clean = (text: string) => text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!]$/, '');

export interface Listening { finish(): Promise<string>; cancel(): void }
export function listen(): Listening {
  void transcribe().catch(() => {});
  let recording: Recording | undefined, failure = 'The microphone is not available.';
  try { recording = microphone?.(); } catch (error) { failure = 'The microphone could not record: ' + (error as Error).message; }
  return {
    async finish() {
      if (!recording) throw new Error(failure);
      const audio = await samples(await recording.stop());
      if (audio.length < 1600) throw new Error('No speech was heard.');
      const text = clean(await transcribe(audio));
      if (!text) throw new Error('No speech was heard.');
      return text;
    },
    cancel() { recording?.cancel(); },
  };
}
