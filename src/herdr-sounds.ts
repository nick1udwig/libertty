import doneURL from './assets/herdr/done.mp3?url';
import requestURL from './assets/herdr/request.mp3?url';
import type { HerdrNotification } from './herdr-state.ts';

/** One workspace sound owner; inactive Herdr views must not mute notifications. */
export class HerdrSounds {
  private played = new Set<string>();
  private context?: AudioContext;
  private buffers?: Promise<Record<'done' | 'request', AudioBuffer>>;
  private focused: () => boolean;
  private emit?: (kind: 'done' | 'request') => void;
  constructor(
    focused = () => !document.hidden && document.hasFocus(),
    emit?: (kind: 'done' | 'request') => void,
  ) {
    this.focused = focused;
    this.emit = emit;
    if (emit) return;
    const unlock = () => {
      this.context ||= new AudioContext();
      void this.context.resume().catch(() => {});
      this.buffers ||= Promise.all(
        [doneURL, requestURL].map(async (url) => {
          const response = await fetch(url);
          return this.context!.decodeAudioData(await response.arrayBuffer());
        }),
      ).then(([done, request]) => ({ done, request }));
      void this.buffers.catch(() => {
        this.buffers = undefined;
      });
    };
    document.addEventListener('pointerdown', unlock, { capture: true });
    document.addEventListener('keydown', unlock, { capture: true });
  }
  play(connection: string, event: HerdrNotification) {
    const key = JSON.stringify([connection, event.terminalId, event.kind, event.sequence]);
    if (this.played.has(key)) return;
    this.played.add(key);
    if (this.played.size > 1024) this.played.delete(this.played.values().next().value!);
    if (!this.focused()) return;
    if (this.emit) {
      this.emit(event.kind);
      return;
    }
    if (!this.context || !this.buffers || this.context.state !== 'running') return;
    void this.buffers
      .then((buffers) => {
        if (!this.focused() || this.context?.state !== 'running') return;
        const source = this.context.createBufferSource();
        source.buffer = buffers[event.kind];
        source.connect(this.context.destination);
        source.start();
      })
      .catch(() => {});
  }
}
