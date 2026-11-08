export type DeliveryState =
  | 'idle'
  | 'offline'
  | 'connecting'
  | 'uploading'
  | 'awaiting-result'
  | 'retained';

type Timer = 'ready' | 'upload' | 'result';
export interface DeliveryClock {
  after(delay: number, callback: () => void): () => void;
}
const clock: DeliveryClock = {
  after(delay, callback) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

/** Delivery attempts own their deadlines and reject events outside their state. */
export class DictationDelivery {
  private current: DeliveryState = 'idle';
  private timers = new Map<Timer, () => void>();
  private timeout: (message: string) => void;
  private clock: DeliveryClock;
  constructor(timeout: (message: string) => void, timerClock: DeliveryClock = clock) {
    this.timeout = timeout;
    this.clock = timerClock;
  }
  get state() {
    return this.current;
  }
  private clear(...names: Timer[]) {
    for (const name of names) {
      this.timers.get(name)?.();
      this.timers.delete(name);
    }
  }
  private schedule(name: Timer, delay: number, callback: () => void) {
    this.clear(name);
    const cancel = this.clock.after(delay, () => {
      if (this.timers.get(name) !== cancel) return;
      this.timers.delete(name);
      callback();
    });
    this.timers.set(name, cancel);
  }
  connect(sent: boolean) {
    this.clear('ready', 'upload');
    this.current = sent ? 'connecting' : 'offline';
    if (sent)
      this.schedule('ready', 10000, () =>
        this.timeout('Voxtype did not become ready; the recording is retained for retry.'),
      );
  }
  disconnect() {
    if (this.current === 'idle' || this.current === 'retained') return;
    this.clear('ready', 'upload');
    this.current = 'offline';
  }
  ready(finished = false) {
    if (this.current !== 'connecting') return false;
    this.clear('ready');
    this.current = finished ? 'awaiting-result' : 'uploading';
    return true;
  }
  completing() {
    if (this.current === 'retained' || this.current === 'idle') return;
    this.schedule('result', 480000, () =>
      this.timeout('Dictation timed out; the recording is retained for retry.'),
    );
  }
  uploadLater(callback: () => void) {
    if (this.current === 'uploading') this.schedule('upload', 10, callback);
  }
  uploaded() {
    if (this.current !== 'uploading') return;
    this.clear('upload');
    this.current = 'awaiting-result';
  }
  acceptsResult() {
    return this.current === 'awaiting-result';
  }
  retain() {
    this.clear('ready', 'upload', 'result');
    this.current = 'retained';
  }
  cancel() {
    this.clear('ready', 'upload', 'result');
    this.current = 'idle';
  }
}
