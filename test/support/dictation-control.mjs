import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const { DictationDelivery } = await import(pathToFileURL(root + '/src/dictation-delivery.ts'));
const audioProfile = await import(pathToFileURL(root + '/src/voxtype-audio.ts'));
const { DictationAudio } = await import(pathToFileURL(root + '/src/dictation-audio.ts'));
const { opusFrame } = await import(pathToFileURL(root + '/src/voxtype-audio.ts'));
class Element {
  checked = false;
  addEventListener() {}
  querySelector() { return new Element(); }
  close() {}
}
class View {
  button = new Element();
  cancel = new Element();
  update() {}
  level() {}
}
class Capture {
  constructor(events) { this.events = events; }
  async start() { this.events.started(); }
  finish() {
    queueMicrotask(() => {
      this.events.frame(opusFrame(0, [new Uint8Array([248, 255, 254])], 0, 1600));
      this.events.flushed();
    });
  }
  limit() {}
  dispose() {}
}
let nextTimer = 0;
const timers = new Map();
const context = createContext({
  document: { hidden: false, createElement: () => new Element(), addEventListener() {}, body: { append() {} }, querySelector: () => null },
  window: { addEventListener() {} },
  crypto: { randomUUID: () => 'recording-' + nextTimer },
  setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
  clearTimeout: id => timers.delete(id),
});
const definitions = {
  './dictation-delivery.ts': { DictationDelivery },
  './voxtype-audio.ts': audioProfile,
  './dictation-capture.ts': { DictationCapture: Capture },
  './dictation-audio.ts': { DictationAudio },
  './unsent-input.ts': { sameInputContext: () => true },
  './protocol.ts': { dictationTarget: () => 'shell' },
  './dictation.css': {},
  './dictation-view.ts': { DictationView: View },
};
const source = stripTypeScriptTypes(await readFile(root + '/src/dictation.ts', 'utf8'));
const module = new SourceTextModule(source, { context });
await module.link(name => {
  const exports = definitions[name];
  return new SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
});
await module.evaluate();
const sent = [], audio = [];
const control = new module.namespace.DictationControl({
  key: 'review', state: () => ({ ready: true, prompt: 1, inputRevision: 1 }), context: () => ({}),
  prepare() {}, focus() {}, notice() {}, waiting() {},
  api: async () => ({ installed: true, available: true }),
  send: message => { sent.push(message); return true; },
  audio: frame => { audio.push(frame); return true; },
});
control.delivery = new DictationDelivery(message => control.retain(message), { after(delay, callback) { const id = ++nextTimer; timers.set(id, { callback, delay }); return () => timers.delete(id); } });
control.online = true;
control.available = true;
control.poll = async () => {};
await control.start();
control.event(control.id, 'ready', undefined, { acceptedFrames: 0, finished: false });
control.finish();
await new Promise(resolve => queueMicrotask(resolve));
assert.ok([...timers.values()].some(timer => timer.delay === 480000));
control.retain('simulated failure');
assert.equal(control.phase, 'retry');
const beforeLateReady = audio.length;
control.event(control.id, 'ready', undefined, { acceptedFrames: 0, finished: false });
assert.equal(audio.length, beforeLateReady);
assert.equal(control.phase, 'retry');
control.finish();
control.event(control.id, 'ready', undefined, { acceptedFrames: 0, finished: false });
assert.equal(control.phase, 'finishing');
assert.equal(control.delivery.state, 'awaiting-result');
assert.equal([...timers.values()].some(timer => timer.delay === 480000), true);
control.cancel();
assert.equal(timers.size, 0);
