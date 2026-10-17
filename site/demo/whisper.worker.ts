// Whisper loads and runs here, so the app's audio encoder on the main thread never falls behind.
const library = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
const model = 'onnx-community/whisper-tiny.en';
type Transcriber = (audio: Float32Array) => Promise<{ text: string }>;
let transcriber: Promise<Transcriber> | undefined;
const load = () => transcriber ??= import(/* @vite-ignore */ library)
  .then(({ pipeline }) => pipeline('automatic-speech-recognition', model, { dtype: 'q8' }) as Promise<Transcriber>)
  .catch(error => { transcriber = undefined; throw error; });

const scope = globalThis as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<{ id: number; audio?: Float32Array }>) => void) | null };
scope.onmessage = async event => {
  const { id, audio } = event.data;
  let run: Transcriber;
  try { run = await load(); } catch (error) { scope.postMessage({ id, error: 'The speech model could not load: ' + (error as Error).message }); return; }
  try { scope.postMessage({ id, text: audio ? (await run(audio)).text : '' }); }
  catch (error) { scope.postMessage({ id, error: 'Transcription failed: ' + (error as Error).message }); }
};
