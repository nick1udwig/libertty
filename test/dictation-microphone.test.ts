import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microphoneRank, openMicrophone, preferredMicrophone } from '../src/dictation-microphone.ts';

const input = (deviceId: string, label: string) => ({ kind: 'audioinput' as const, deviceId, label });

test('known routes rank external inputs first and treat unrecognized inputs as Bluetooth', () => {
  for (const label of ['USB audio', 'Wired headset', 'Yeti Stereo Microphone (046d:0ab7)']) assert.equal(microphoneRank(label), 0, label);
  for (const label of ['Speakerphone', 'MacBook Pro Microphone (Built-in)', 'Microphone Array (Intel Smart Sound)', 'Microphone (Realtek(R) Audio)', 'Internal Microphone']) assert.equal(microphoneRank(label), 1, label);
  assert.equal(microphoneRank('Headset earpiece'), 2);
  for (const label of ['Bluetooth headset', 'AirPods Pro (Bluetooth)', 'Headset (WH-1000XM4 Hands-Free AG Audio)', 'Galaxy Buds2 Pro', 'Pixel Buds', 'Fake Audio Input 1', '']) assert.equal(microphoneRank(label), undefined, label);
});

test('Android routes avoid Bluetooth and prefer wired inputs over the phone', () => {
  assert.equal(preferredMicrophone([input('bt', 'Bluetooth headset'), input('ear', 'Headset earpiece'), input('speaker', 'Speakerphone')]), 'speaker');
  assert.equal(preferredMicrophone([input('bt', 'Bluetooth headset'), input('speaker', 'Speakerphone'), input('wired', 'Wired headset')]), 'wired');
  assert.equal(preferredMicrophone([input('bt', 'Bluetooth headset')]), undefined);
  assert.equal(preferredMicrophone([input('unknown', 'Yeti Stereo Microphone')]), undefined);
});

test('a safe system input wins, and aliases or other kinds are never chosen', () => {
  const devices = [input('default', 'Default - MacBook Pro Microphone (Built-in)'), input('usb', 'USB Audio Device'), input('mac', 'MacBook Pro Microphone (Built-in)')];
  assert.equal(preferredMicrophone(devices), 'mac');
  assert.equal(preferredMicrophone([input('default', 'Default - AirPods (Bluetooth)'), input('communications', 'Communications - Realtek'), input('mac', 'MacBook Pro Microphone (Built-in)'), { kind: 'audiooutput', deviceId: 'out', label: 'USB audio' }]), 'mac');
});

class Stream {
  stopped = false;
  deviceId: string;
  constructor(deviceId: string) { this.deviceId = deviceId; }
  getAudioTracks() { return [{ getSettings: () => ({ deviceId: this.deviceId }) }]; }
  getTracks() { return [{ stop: () => { this.stopped = true; } }]; }
}
function media(labels: boolean, devices = [input('bt', 'Bluetooth headset'), input('speaker', 'Speakerphone')], opened = 'default') {
  const calls: MediaStreamConstraints[] = [], streams: Stream[] = [];
  let granted = labels;
  return { calls, streams, media: {
    async enumerateDevices() { return devices.map(device => ({ ...device, label: granted ? device.label : '' })) as MediaDeviceInfo[]; },
    async getUserMedia(constraints: MediaStreamConstraints) {
      assert.ok(streams.every(stream => stream.stopped), 'Only one input is open at a time');
      calls.push(constraints); granted = true;
      const exact = ((constraints.audio as MediaTrackConstraints).deviceId as ConstrainDOMStringParameters | undefined)?.exact as string | undefined;
      const stream = new Stream(exact || opened); streams.push(stream); return stream as unknown as MediaStream;
    },
  } };
}
const deviceId = (constraints: MediaStreamConstraints) => (constraints.audio as MediaTrackConstraints).deviceId;

test('allowing Bluetooth opens the browser default input', async () => {
  const fake = media(true);
  await openMicrophone(fake.media, true);
  assert.deepEqual(fake.calls.map(deviceId), [undefined]);
});

test('named inputs open the chosen input directly', async () => {
  const fake = media(true);
  assert.equal(await openMicrophone(fake.media, false), fake.streams[0]);
  assert.deepEqual(fake.calls.map(deviceId), [{ exact: 'speaker' }]);
});

test('the first grant reads input names and then opens the chosen input', async () => {
  const fake = media(false);
  assert.equal(await openMicrophone(fake.media, false), fake.streams[1]);
  assert.deepEqual(fake.calls.map(deviceId), [undefined, { exact: 'speaker' }]);
  assert.equal(fake.streams[0].stopped, true);
});

test('the first grant keeps its stream when the browser already opened the chosen input', async () => {
  const fake = media(false, undefined, 'speaker');
  assert.equal(await openMicrophone(fake.media, false), fake.streams[0]);
  assert.equal(fake.calls.length, 1); assert.equal(fake.streams[0].stopped, false);
});

test('only unsafe inputs report how to allow them and release the first grant', async () => {
  const fake = media(false, [input('bt', 'Bluetooth headset')]);
  await assert.rejects(openMicrophone(fake.media, false), /Allow Bluetooth microphones in settings/);
  assert.equal(fake.streams[0].stopped, true);
});
