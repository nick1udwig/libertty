/** A copy of the app's microphone stream, recorded in the frame that opened it. */
export interface Recording { stop(): Promise<Blob>; cancel(): void }
export type Recorder = () => Recording | undefined;

export function recorder(stream: MediaStream): Recorder {
  return () => {
    if (!stream.getAudioTracks().some(track => track.readyState === 'live')) return;
    const copy = stream.clone(), media = new MediaRecorder(copy), chunks: Blob[] = [];
    const release = () => copy.getTracks().forEach(track => track.stop());
    media.addEventListener('dataavailable', event => chunks.push(event.data));
    media.start();
    return {
      stop: () => new Promise(resolve => {
        media.addEventListener('stop', () => { release(); resolve(new Blob(chunks, { type: media.mimeType })); }, { once: true });
        media.stop();
      }),
      cancel() { if (media.state === 'recording') media.stop(); release(); },
    };
  };
}
