import type { DemoServer } from './server.ts';
import { recorder } from './recording.ts';
import { install } from './shim.ts';

// Terminal and Herdr pane frames reach the backend that the workspace document hosts.
const demo = (parent as unknown as { liberttyDemo: DemoServer }).liberttyDemo;
install(window, demo);

// Whisper in the workspace transcribes the same microphone stream the app records and shows levels for.
const devices = navigator.mediaDevices;
if (devices) {
  const open = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async constraints => { const stream = await open(constraints); demo.microphone(recorder(stream)); return stream; };
}
