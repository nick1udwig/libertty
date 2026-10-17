import type { DemoServer } from './server.ts';
import { install } from './shim.ts';

// Terminal and Herdr pane frames reach the backend that the workspace document hosts.
install(window, (parent as unknown as { liberttyDemo: DemoServer }).liberttyDemo);

// The browser's speech recognition transcribes here, and phones give the microphone to one listener at a time.
// The app's recorder therefore gets a silent stream, which keeps its capture checks satisfied without holding the microphone.
if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
  const context = new AudioContext(), source = context.createConstantSource(), destination = context.createMediaStreamDestination();
  source.offset.value = 0; source.connect(destination); source.start();
  await context.resume().catch(() => {});
  // Stopping the track is how the app releases the microphone, so it also closes this audio graph.
  for (const track of destination.stream.getAudioTracks()) { const stop = track.stop.bind(track); track.stop = () => { stop(); void context.close(); }; }
  return destination.stream;
};
