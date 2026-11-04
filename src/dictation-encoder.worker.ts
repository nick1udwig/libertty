import { DictationEncoder } from './dictation-encoder.ts';
const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
let encoder: DictationEncoder | undefined;
function fail(error: unknown) {
  encoder?.close();
  encoder = undefined;
  scope.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : 'Could not encode dictation.',
  });
}
void DictationEncoder.create((frame) => scope.postMessage({ type: 'audio', frame }, [frame])).then(
  (value) => {
    encoder = value;
    scope.postMessage({ type: 'ready' });
  },
  fail,
);
scope.onmessage = (event) => {
  try {
    if (!encoder) throw new Error('Audio encoder is unavailable.');
    if (event.data.type === 'audio') {
      encoder.audio(event.data.pcm);
      scope.postMessage({ type: 'consumed' });
    } else if (event.data.type === 'finish') {
      encoder.finish();
      encoder = undefined;
      scope.postMessage({ type: 'flushed' });
    } else throw new Error('Invalid audio encoder message.');
  } catch (error) {
    fail(error);
  }
};
