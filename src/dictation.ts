import { MAX_AUDIO_SAMPLES, MAX_OPUS_BYTES } from './voxtype-audio.ts';
import { DictationCapture } from './dictation-capture.ts';
import { DictationDelivery } from './dictation-delivery.ts';
import { DictationAudio } from './dictation-audio.ts';
import { sameInputContext, type InputContext } from './unsent-input.ts';
import type { ClientMessage, ShellState } from './protocol.ts';
import { dictationTarget } from './protocol.ts';
import type { Notify } from './notice-model.ts';
import './dictation.css';
import { DictationSetup } from './dictation-setup.ts';
import { DictationView, type DictationPhase } from './dictation-view.ts';

interface Host {
  api<T>(path: string, data?: unknown): Promise<T>;
  send(message: ClientMessage): boolean;
  audio(data: ArrayBuffer): boolean;
  state(): ShellState;
  prepare(): void;
  notice: Notify;
  focus(): void;
  waiting?(active: boolean): void;
  key: string;
  context(): InputContext | undefined;
}
export class DictationControl {
  private view = new DictationView();
  private setup: DictationSetup;
  private online = false;
  private visible = true;
  private phase: DictationPhase = 'idle';
  private capture?: DictationCapture;
  private id = '';
  private finishPending = false;
  private delivery = new DictationDelivery((message) => this.retain(message));
  private captureFlushed = false;
  private audio = new DictationAudio();
  private inputContext?: InputContext;
  private host: Host;
  constructor(host: Host) {
    this.host = host;
    this.setup = new DictationSetup(
      host,
      () => this.active,
      () => this.render(),
    );
    window.addEventListener('pagehide', () => {
      this.cancel();
      this.setup.pause();
    });
    this.view.bind({
      active: () => this.active,
      start: () => this.start(),
      finish: () => this.finish(),
      cancel: () => this.cancel(),
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.phase === 'recording') this.capture?.checkCapture();
    });
    this.render();
  }
  get active() {
    return this.phase !== 'idle';
  }
  connected(online: boolean) {
    const changed = this.online !== online;
    if (!online && this.active && this.delivery.state !== 'retained') {
      const context = this.host.context();
      if (context && this.inputContext && sameInputContext(this.inputContext, context))
        this.inputContext = context;
      this.delivery.disconnect();
      if (changed) this.host.notice('Recording is retained while the terminal reconnects.', 'info');
    }
    this.online = online;
    this.setup.connected(online);
    if (online && this.delivery.state === 'offline' && this.active && this.phase !== 'starting')
      this.resume();
    this.render();
  }
  private resume() {
    const context = this.host.context();
    if (!this.inputContext || !context || !sameInputContext(this.inputContext, context)) {
      this.retain('Input changed; the recording is retained for retry or cancellation.');
      return;
    }
    this.inputContext = context;
    this.sendStart();
  }
  private sendStart() {
    const state = this.host.state();
    const sent =
      this.online &&
      this.host.send({
        type: 'dictation',
        id: this.id,
        action: 'start',
        prompt: state.prompt,
        revision: state.inputRevision,
        target: dictationTarget(state),
      });
    this.delivery.connect(sent);
  }

  private retain(message: string) {
    if (!this.active) return;
    this.host.notice(message);
    this.delivery.retain();
    this.host.send({ type: 'dictation', id: this.id, action: 'cancel' });
    if (this.phase === 'recording') this.finish();
    else if (this.phase === 'starting') this.finishPending = true;
    if (this.captureFlushed) {
      this.phase = 'retry';
      this.host.waiting?.(false);
    }
    this.render();
  }
  private retry() {
    if (!this.online || !dictationTarget(this.host.state())) {
      this.host.notice(
        'Wait for the terminal to reconnect before retrying the retained recording.',
        'warning',
      );
      return;
    }
    this.id = crypto.randomUUID();
    this.inputContext = this.host.context();
    this.phase = 'finishing';
    this.host.prepare();
    this.host.waiting?.(true);
    this.sendStart();
    this.delivery.completing();
    this.render();
  }
  prompt() {
    this.setup.prompt();
  }
  visibility(visible: boolean) {
    this.visible = visible;
    this.setup.visibility(visible);
    if (!visible) this.cancel();
    this.render();
  }
  private render() {
    this.view.update(
      this.phase,
      (this.active || (this.setup.available && this.online)) && this.visible,
      this.capture?.paused || false,
    );
  }
  private async start() {
    void this.setup.poll(true);
    if (!this.online || !this.setup.available || !dictationTarget(this.host.state())) {
      this.host.notice('Wait for terminal input before dictating.', 'warning');
      return;
    }
    this.id = crypto.randomUUID();
    this.inputContext = this.host.context();
    this.phase = 'starting';
    this.finishPending = false;
    this.render();
    const capture = new DictationCapture({
      started: () => {
        this.host.prepare();
        if (this.online) this.inputContext = this.host.context();
        this.sendStart();
        this.phase = 'recording';
      },
      level: (pcm) => this.view.level(pcm),
      frame: (frame) => {
        this.audio.append(frame);
        this.upload();
      },
      flushed: () => {
        this.captureFlushed = true;
        if (this.delivery.state === 'retained') {
          this.phase = 'retry';
          this.host.waiting?.(false);
          this.render();
        } else this.upload();
      },
      finish: () => this.finish(),
      failed: (message) => {
        this.host.notice(message);
        this.cancel();
      },
      changed: () => this.render(),
      notice: this.host.notice,
    });
    this.capture = capture;
    await capture.start();
    if (this.capture !== capture) return;
    if (this.finishPending) this.finish();
    this.render();
  }
  event(
    id: string,
    state: 'ready' | 'done' | 'error',
    message?: string,
    resume?: {
      acceptedFrames: number;
      finished: boolean;
      uploadWindow?: number;
      maxSamples?: number;
      maxEncodedBytes?: number;
    },
  ) {
    if (
      id !== this.id ||
      this.phase === 'idle' ||
      this.delivery.state === 'retained' ||
      this.delivery.state === 'offline'
    )
      return;
    if (state === 'ready') {
      if (!this.delivery.ready(resume?.finished)) return;
      try {
        this.audio.limit(resume?.maxEncodedBytes ?? MAX_OPUS_BYTES);
        this.capture?.limit(resume?.maxSamples ?? MAX_AUDIO_SAMPLES);
        this.audio.resume(resume?.acceptedFrames, resume?.finished, resume?.uploadWindow);
      } catch (error) {
        this.retain((error as Error).message);
        return;
      }
      this.upload();
    } else if (state === 'error')
      this.retain(message || 'Dictation failed; the recording is retained for retry.');
    else if (this.delivery.acceptsResult()) this.cancel(false);
    this.render();
  }
  progress(id: string, forwarded: number) {
    if (id !== this.id || this.delivery.state !== 'uploading' || !this.online) return;
    try {
      this.audio.acknowledge(forwarded);
    } catch (error) {
      this.retain((error as Error).message);
      return;
    }
    this.upload();
  }
  private upload() {
    if (this.delivery.state !== 'uploading' || !this.online) return;
    let uploaded: boolean;
    try {
      uploaded = this.audio.upload((frame) => this.host.audio(frame));
    } catch (error) {
      this.retain((error as Error).message);
      return;
    }
    if (!uploaded) {
      if (!this.audio.waitingForCredit) this.delivery.uploadLater(() => this.upload());
    } else if (this.captureFlushed) {
      if (this.host.send({ type: 'dictation', id: this.id, action: 'finish' }))
        this.delivery.uploaded();
      else this.delivery.uploadLater(() => this.upload());
    }
  }

  private finish() {
    if (this.phase === 'retry') {
      this.retry();
      return;
    }
    if (this.phase === 'starting') {
      this.finishPending = true;
      return;
    }
    if (this.phase !== 'recording') return;
    if (this.capture?.paused) {
      this.host.notice('Recording was interrupted. Keep the screen on and try dictating again.');
      this.cancel();
      return;
    }
    this.phase = 'finishing';
    this.capture?.finish();
    this.host.waiting?.(true);
    this.delivery.completing();
    this.render();
  }
  cancel(notify = true) {
    if (notify && this.phase !== 'idle')
      this.host.send({ type: 'dictation', id: this.id, action: 'cancel' });
    this.capture?.dispose();
    this.capture = undefined;
    this.delivery.cancel();
    this.audio.clear();
    this.inputContext = undefined;
    this.captureFlushed = false;
    this.phase = 'idle';
    this.render();
    this.host.waiting?.(false);
    if (this.online) void this.setup.poll(!this.setup.available);
  }
}
