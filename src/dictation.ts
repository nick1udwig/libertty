import { MAX_AUDIO_SAMPLES, MAX_OPUS_BYTES } from './voxtype-audio.ts';
import { DictationCapture } from './dictation-capture.ts';
import { DictationDelivery } from './dictation-delivery.ts';
import { DictationAudio } from './dictation-audio.ts';
import { sameInputContext, type InputContext } from './unsent-input.ts';
import type { ClientMessage, ShellState } from './protocol.ts';
import { dictationTarget } from './protocol.ts';
import type { Notify } from './notice-model.ts';
import './dictation.css';
import { DictationView } from './dictation-view.ts';

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
  private button = this.view.button;
  private cancelButton = this.view.cancel;
  private dialog = document.createElement('dialog');
  private available = false;
  private online = false;
  private visible = true;
  private phase: 'idle' | 'starting' | 'recording' | 'finishing' | 'retry' = 'idle';
  private capture?: DictationCapture;
  private id = '';
  private finishPending = false;
  private offered = false;
  private installed?: boolean;
  private daemonAvailable?: boolean;
  private unavailableReason?: string;
  private polling = false;
  private lastPoll = -Infinity;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private installPrompt?: number;
  private delivery = new DictationDelivery((message) => this.retain(message));
  private captureFlushed = false;
  private audio = new DictationAudio();
  private inputContext?: InputContext;
  private host: Host;
  constructor(host: Host) {
    this.host = host;
    window.addEventListener('pagehide', () => {
      this.cancel();
      clearTimeout(this.pollTimer);
    });
    this.cancelButton.onclick = () => this.cancel();
    this.dialog.id = 'dictation-install';
    this.dialog.innerHTML =
      '<h2>Dictate with Voxtype Mobile</h2><p data-explanation>Install the daemon on your backend to dictate directly into this terminal.</p><p>Install pastes the command into your session. Review it and press Enter to run it.</p><label class="setting-toggle"><input type="checkbox"><span>Do not show again</span></label><div class="run-row"><button type="button" class="secondary-button" data-later>Not now</button><button type="button" class="run-button" data-install>Install</button></div>';
    const dismiss = () => {
      if (this.dialog.querySelector('input')!.checked) this.save('dismissed');
      this.dialog.close();
    };
    this.dialog.querySelector<HTMLButtonElement>('[data-later]')!.onclick = dismiss;
    this.dialog.addEventListener('cancel', dismiss);
    this.dialog.querySelector<HTMLButtonElement>('[data-install]')!.onclick = async () => {
      const button = this.dialog.querySelector<HTMLButtonElement>('[data-install]')!;
      button.disabled = true;
      try {
        this.host.prepare();
        const state = this.host.state();
        await this.host.api('/api/dictation/install', {
          prompt: state.prompt,
          revision: state.inputRevision,
        });
        this.installPrompt = state.prompt;
        dismiss();
        this.host.focus();
        this.host.notice('Install command pasted. Review it, then press Enter to run it.', 'info');
      } catch (error) {
        this.host.notice((error as Error).message);
      } finally {
        button.disabled = false;
      }
    };
    document.body.append(this.dialog);
    this.render();
    let press:
      | {
          x: number;
          y: number;
          left: number;
          top: number;
          at: number;
          active: boolean;
          dragged: boolean;
        }
      | undefined;
    this.button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.button.setPointerCapture(event.pointerId);
      const bounds = this.button.getBoundingClientRect();
      press = {
        x: event.clientX,
        y: event.clientY,
        left: bounds.left,
        top: bounds.top,
        at: performance.now(),
        active: this.phase !== 'idle',
        dragged: false,
      };
      if (this.phase === 'idle') void this.start();
    });
    this.button.addEventListener('pointermove', (event) => {
      if (!press) return;
      const dx = event.clientX - press.x,
        dy = event.clientY - press.y;
      if (!press.dragged && Math.hypot(dx, dy) < 8) return;
      if (!press.dragged && !press.active) this.cancel();
      press.dragged = true;
      this.view.position(press.left + dx, press.top + dy);
    });
    this.button.addEventListener('pointerup', () => {
      if (!press) return;
      if (!press.dragged && (press.active || performance.now() - press.at >= 300)) this.finish();
      if (press.dragged) this.view.remember();
      press = undefined;
    });
    // Android can cancel the touch when the screen locks. Keep the recording active;
    // a later tap or the cancel button still lets the user finish or discard it.
    this.button.addEventListener('pointercancel', () => {
      if (press?.dragged) this.view.remember();
      press = undefined;
    });
    this.button.addEventListener('click', (event) => {
      if (event.detail === 0) {
        if (this.phase === 'idle') void this.start();
        else this.finish();
      }
    });
    document.addEventListener('visibilitychange', () => {
      clearTimeout(this.pollTimer);
      if (!document.hidden) {
        void this.poll(!this.available);
        if (this.phase === 'recording') {
          this.capture?.checkCapture();
        }
      }
    });
  }
  private save(value: string) {
    try {
      localStorage.setItem('libertty.voxtype:' + this.host.key, value);
    } catch {}
  }
  get active() {
    return this.phase !== 'idle';
  }
  connected(online: boolean) {
    if (!online) clearTimeout(this.pollTimer);
    const changed = this.online !== online;
    if (!online && this.active && this.delivery.state !== 'retained') {
      const context = this.host.context();
      if (context && this.inputContext && sameInputContext(this.inputContext, context))
        this.inputContext = context;
      this.delivery.disconnect();
      if (changed) this.host.notice('Recording is retained while the terminal reconnects.', 'info');
    }
    this.online = online;
    if (!online) {
      if (!this.active) this.available = false;
      this.dialog.close();
    } else if (this.delivery.state === 'offline' && this.active && this.phase !== 'starting')
      this.resume();
    else if (changed) void this.poll(true);
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
    const state = this.host.state();
    const installed =
      this.installPrompt !== undefined && state.ready && state.prompt !== this.installPrompt;
    if (installed) this.installPrompt = undefined;
    if (state.ready) void this.poll(installed);
    this.offer();
  }
  visibility(visible: boolean) {
    this.visible = visible;
    if (!visible) {
      clearTimeout(this.pollTimer);
      this.cancel();
      this.dialog.close();
    } else void this.poll(!this.available);
    this.render();
  }
  private async poll(force = false) {
    if (!this.online || !this.visible || document.hidden || this.polling || this.phase !== 'idle')
      return;
    if (!force && Date.now() - this.lastPoll < 60000) return;
    clearTimeout(this.pollTimer);
    this.lastPoll = Date.now();
    this.polling = true;
    let retry = true;
    try {
      const status = await this.host.api<{
        installed: boolean;
        available: boolean;
        reason?: string;
      }>('/api/dictation');
      if (!this.online || !this.visible) return;
      this.installed = status.installed;
      this.daemonAvailable = status.available;
      retry = !status.available;
      this.unavailableReason = status.reason;
      this.available =
        status.available &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof AudioWorkletNode !== 'undefined' &&
        typeof Worker !== 'undefined' &&
        typeof WebAssembly !== 'undefined';
      if (status.available) this.dialog.close();
      this.offer();
    } catch {
      this.available = false;
    } finally {
      this.polling = false;
      if (retry && this.online && this.visible && !document.hidden && this.phase === 'idle')
        this.pollTimer = setTimeout(() => void this.poll(true), 15000);
      this.render();
    }
  }
  private offer() {
    // Only an explicit dismissal suppresses setup help.
    let suppressed = false;
    try {
      suppressed = localStorage.getItem('libertty.voxtype:' + this.host.key) === 'dismissed';
    } catch {}
    if (
      this.daemonAvailable !== false ||
      !this.online ||
      !this.visible ||
      document.hidden ||
      suppressed ||
      this.offered ||
      !this.host.state().ready ||
      document.querySelector('dialog[open]')
    )
      return;
    this.dialog.querySelector('h2')!.textContent = this.installed
      ? 'Enable Voxtype dictation'
      : 'Dictate with Voxtype Mobile';
    this.dialog.querySelector('[data-explanation]')!.textContent = this.installed
      ? this.unavailableReason ||
        'Voxtype is installed, but its dictation API is unavailable. It may need an update or restart.'
      : 'Install the daemon on your backend to dictate directly into this terminal.';
    this.offered = true;
    this.dialog.showModal();
  }
  private render() {
    this.view.update(
      this.phase,
      (this.active || (this.available && this.online)) && this.visible,
      this.capture?.paused || false,
    );
  }
  private async start() {
    void this.poll(true);
    if (!this.online || !this.available || !dictationTarget(this.host.state())) {
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
        this.audio.resume(resume?.acceptedFrames, resume?.finished);
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
  private upload() {
    if (this.delivery.state !== 'uploading' || !this.online) return;
    let uploaded: boolean;
    try {
      uploaded = this.audio.upload((frame) => this.host.audio(frame));
    } catch (error) {
      this.retain((error as Error).message);
      return;
    }
    if (!uploaded) this.delivery.uploadLater(() => this.upload());
    else if (this.captureFlushed) {
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
    if (this.online) void this.poll(!this.available);
  }
}
