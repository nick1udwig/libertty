import type { ClientMessage, ShellState } from './protocol.ts';
import { dictationTarget } from './protocol.ts';
import './dictation.css';
import { DictationView } from './dictation-view.ts';
import { DictationWakeLock, dictationWakeEnvironment } from './dictation-wake-lock.ts';

interface Host {
  api<T>(path: string, data?: unknown): Promise<T>;
  send(message: ClientMessage): boolean;
  audio(data: ArrayBuffer): boolean;
  state(): ShellState;
  prepare(): void;
  notice(message: string): void;
  focus(): void;
  key: string;
}
export class DictationControl {
  private view = new DictationView();
  private button = this.view.button;
  private cancelButton = this.view.cancel;
  private dialog = document.createElement('dialog');
  private available = false;
  private online = false;
  private visible = true;
  private phase: 'idle' | 'starting' | 'recording' | 'finishing' = 'idle';
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: AudioWorkletNode;
  private encoder?: Worker;
  private encoderPending = 0;
  private encoderStartupCancel?: () => void;
  private generation = 0;
  private id = '';
  private finishPending = false;
  private offered = false;
  private installed?: boolean;
  private daemonAvailable?: boolean;
  private unavailableReason?: string;
  private polling = false;
  private audioTimer?: ReturnType<typeof setTimeout>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private uploadTimer?: ReturnType<typeof setTimeout>;
  private daemonReady = false;
  private captureFlushed = false;
  private pendingAudio: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private host: Host;
  private wakeLock: DictationWakeLock;
  private capturePaused = false;
  private captureInterrupted = false;
  private lastAudio = 0;
  private captureRecovering = false;
  private captureRecoveryAttempted = false;
  private captureRestarted = false;
  private captureRecoveryDeadline = 0;
  private captureTimer?: ReturnType<typeof setInterval>;
  constructor(host: Host) {
    this.host = host;
    this.wakeLock = new DictationWakeLock(dictationWakeEnvironment(), message => host.notice(message));
    window.addEventListener('pagehide', () => { this.cancel(); this.wakeLock.stop(); });
    this.cancelButton.onclick = () => this.cancel();
    this.dialog.id = 'dictation-install';
    this.dialog.innerHTML = '<h2>Dictate with Voxtype Mobile</h2><p data-explanation>Install the daemon on your backend to dictate directly into this terminal.</p><p>Install pastes the command into your session. Review it and press Enter to run it.</p><label class="setting-toggle"><input type="checkbox"><span>Do not show again</span></label><div class="run-row"><button type="button" class="secondary-button" data-later>Not now</button><button type="button" class="run-button" data-install>Install</button></div>';
    const dismiss = () => { if (this.dialog.querySelector('input')!.checked) this.save('dismissed'); this.dialog.close(); };
    this.dialog.querySelector<HTMLButtonElement>('[data-later]')!.onclick = dismiss;
    this.dialog.addEventListener('cancel', dismiss);
    this.dialog.querySelector<HTMLButtonElement>('[data-install]')!.onclick = async () => {
      const button = this.dialog.querySelector<HTMLButtonElement>('[data-install]')!; button.disabled = true;
      try {
        this.host.prepare();
        const state = this.host.state();
        await this.host.api('/api/dictation/install', { prompt: state.prompt, revision: state.inputRevision });
        dismiss(); this.host.focus(); this.host.notice('Install command pasted. Review it, then press Enter to run it.');
      } catch (error) { this.host.notice((error as Error).message); } finally { button.disabled = false; }
    };
    document.body.append(this.dialog);
    this.render();
    let press: { x: number; y: number; left: number; top: number; at: number; active: boolean; dragged: boolean } | undefined;
    this.button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); this.button.setPointerCapture(event.pointerId);
      const bounds = this.button.getBoundingClientRect();
      press = { x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top, at: performance.now(), active: this.phase !== 'idle', dragged: false };
      if (this.phase === 'idle') void this.start();
    });
    this.button.addEventListener('pointermove', event => {
      if (!press) return;
      const dx = event.clientX - press.x, dy = event.clientY - press.y;
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
    this.button.addEventListener('pointercancel', () => { if (press?.dragged) this.view.remember(); press = undefined; });
    this.button.addEventListener('click', event => { if (event.detail === 0) { if (this.phase === 'idle') void this.start(); else this.finish(); } });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        void this.poll();
        if (this.phase === 'recording') {
          this.checkCapture();
        }
      }
    });
    setInterval(() => void this.poll(), 15000);
  }
  private save(value: string) { try { localStorage.setItem('termai.voxtype:' + this.host.key, value); } catch {} }
  get active() { return this.phase !== 'idle'; }
  connected(online: boolean) { this.online = online; if (!online) { this.available = false; if (this.active) this.host.notice('Connection lost during dictation. Recording stopped.'); this.cancel(); this.dialog.close(); } else void this.poll(); this.render(); }
  prompt() { this.offer(); }
  visibility(visible: boolean) { this.visible = visible; if (!visible) { this.cancel(); this.dialog.close(); } else void this.poll(); this.render(); }
  private async poll() {
    if (!this.online || !this.visible || document.hidden || this.polling || this.phase !== 'idle') return;
    this.polling = true;
    try {
      const status = await this.host.api<{ installed: boolean; available: boolean; reason?: string }>('/api/dictation');
      if (!this.online || !this.visible) return;
      this.installed = status.installed;
      this.daemonAvailable = status.available;
      this.unavailableReason = status.reason;
      this.available = status.available && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined' && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
      if (status.available) this.dialog.close();
      this.offer();
    } catch { this.available = false; }
    finally { this.polling = false; this.render(); }
  }
  private offer() {
    // Old versions saved "installed" merely on finding a token or binary. Only
    // an explicit dismissal should hide help when the API cannot actually be used.
    let suppressed = false; try { suppressed = localStorage.getItem('termai.voxtype:' + this.host.key) === 'dismissed'; } catch {}
    if (this.daemonAvailable !== false || !this.online || !this.visible || document.hidden || suppressed || this.offered || !this.host.state().ready || document.querySelector('dialog[open]')) return;
    this.dialog.querySelector('h2')!.textContent = this.installed ? 'Enable Voxtype dictation' : 'Dictate with Voxtype Mobile';
    this.dialog.querySelector('[data-explanation]')!.textContent = this.installed
      ? this.unavailableReason || 'Voxtype is installed, but its dictation API is unavailable. It may need an update or restart.'
      : 'Install the daemon on your backend to dictate directly into this terminal.';
    this.offered = true; this.dialog.showModal();
  }
  private render() { this.view.update(this.phase, this.available && this.online && this.visible, this.capturePaused); }
  private async start() {
    if (!this.online || !this.available || !dictationTarget(this.host.state())) { this.host.notice('Wait for terminal input before dictating.'); return; }
    const generation = ++this.generation; this.id = crypto.randomUUID(); this.phase = 'starting'; this.finishPending = false; this.render();
    this.wakeLock.start();
    this.audioTimer = setTimeout(() => this.captureFailed('Microphone audio did not start. Check microphone permission and try again.'), 15000);
    try {
      // Request microphone access and resume audio within the same user gesture.
      const context = this.context = new AudioContext();
      const microphone = this.microphone(generation);
      const [stream] = await Promise.all([microphone, context.resume(), this.startEncoder(generation)]);
      if (generation !== this.generation || !stream) return;
      context.addEventListener('statechange', () => { if (generation === this.generation) this.checkCapture(); });
      await context.audioWorklet.addModule(new URL('dictation-worklet.js', document.baseURI).href);
      if (generation !== this.generation) return;
      this.source = context.createMediaStreamSource(stream);
      this.processor = new AudioWorkletNode(context, 'dictation-pcm');
      this.processor.addEventListener('processorerror', () => { if (generation === this.generation) this.captureFailed('Microphone audio processing stopped. Please try dictating again.'); });
      this.processor.port.onmessage = event => {
        if (generation !== this.generation) return;
        if (event.data?.type === 'error') { this.host.notice(event.data.message); this.cancel(); return; }
        if (event.data === 'flushed') { this.encoder!.postMessage({ type: 'finish' }); this.releaseAudio(); }
        else {
          this.lastAudio = Date.now(); this.checkCapture();
          this.view.level(event.data);
          if (++this.encoderPending > 8) { this.host.notice('Audio encoding is too slow. Please try again.'); this.cancel(); return; }
          this.encoder!.postMessage({ type: 'audio', pcm: event.data }, [event.data]);
        }
      };
      this.host.prepare();
      const state = this.host.state();
      if (!this.host.send({ type: 'dictation', id: this.id, action: 'start', prompt: state.prompt, revision: state.inputRevision, target: dictationTarget(state) })) throw new Error('The terminal is disconnected.');
      // Capture immediately, including speech while waiting for daemon admission.
      this.phase = 'recording'; this.source.connect(this.processor); this.processor.connect(context.destination);
      this.lastAudio = Date.now(); this.capturePaused = this.captureInterrupted = false;
      this.captureTimer = setInterval(() => this.checkCapture(), 1000); this.checkCapture();
      this.readyTimer = setTimeout(() => { this.host.notice('Voxtype did not become ready.'); this.cancel(); }, 10000);
      clearTimeout(this.audioTimer);
      this.audioTimer = setTimeout(() => this.finish(), 299000);
      // Permission prompts or device startup can suspend an already resumed context.
      await context.resume();
      if (generation !== this.generation) return;
      if (this.finishPending) this.finish();
      this.render();
    } catch (error) { if (generation === this.generation) { this.host.notice((error as Error).message); this.cancel(); } }
  }
  private async microphone(generation: number): Promise<MediaStream | undefined> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') { stream.getTracks().forEach(track => track.stop()); throw new Error('The microphone stopped before recording started.'); }
    const previous = this.stream; this.stream = stream;
    previous?.getTracks().forEach(track => track.stop());
    track.addEventListener('ended', () => { if (generation === this.generation && stream === this.stream) this.captureFailed('Microphone access ended. Recording stopped; check microphone permission and try again.'); });
    track.addEventListener('mute', () => { if (generation === this.generation && stream === this.stream) this.checkCapture(); });
    track.addEventListener('unmute', () => { if (generation === this.generation && stream === this.stream) this.checkCapture(); });
    return stream;
  }
  private async recoverCapture() {
    const generation = this.generation, context = this.context;
    if (!context) return;
    this.captureRecovering = this.captureRecoveryAttempted = true;
    try {
      if (context.state !== 'running') await context.resume();
      if (generation !== this.generation || this.phase !== 'recording') return;
      if (Date.now() - this.lastAudio > 2500 && !this.captureRestarted) {
        this.captureRestarted = true;
        const stream = await this.microphone(generation);
        if (generation !== this.generation || !stream) return;
        if (this.phase !== 'recording') { this.releaseAudio(); return; }
        this.source?.disconnect(); this.source = context.createMediaStreamSource(stream); this.source.connect(this.processor!);
        await context.resume();
      }
    } catch { if (generation === this.generation) this.captureFailed('Microphone audio could not resume. Recording stopped; try again with the screen on.'); }
    finally { if (generation === this.generation) this.captureRecovering = false; }
  }
  private startEncoder(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const encoder = this.encoder = new Worker(new URL('./dictation-encoder.worker.ts', import.meta.url), { type: 'module' });
      let ready = false;
      const timer = setTimeout(() => { reject(new Error('Audio encoder did not become ready.')); }, 10000);
      this.encoderStartupCancel = () => { clearTimeout(timer); resolve(); };
      const fail = (message: string) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(message));
        else if (generation === this.generation) { this.host.notice(message); this.cancel(); }
      };
      encoder.onerror = () => fail('Could not encode dictation.');
      encoder.onmessage = event => {
        if (generation !== this.generation) { clearTimeout(timer); resolve(); return; }
        if (event.data.type === 'ready') { clearTimeout(timer); this.encoderStartupCancel = undefined; ready = true; resolve(); }
        else if (event.data.type === 'consumed') { this.encoderPending--; this.processor?.port.postMessage({ type: 'consumed' }); }
        else if (event.data.type === 'error') fail(event.data.message);
        else if (event.data.type === 'audio') {
          this.pendingAudio.push(event.data.frame); this.pendingBytes += event.data.frame.byteLength;
          if (this.pendingBytes > 256 * 1024) { fail('Connection is too slow for dictation. Please try again.'); return; }
          this.upload();
        } else if (event.data.type === 'flushed') { this.encoder?.terminate(); this.encoder = undefined; this.captureFlushed = true; this.upload(); }
      };
    });
  }
  event(id: string, state: 'ready' | 'done' | 'error', message?: string) {
    if (id !== this.id || this.phase === 'idle') return;
    if (state === 'ready') {
      clearTimeout(this.readyTimer); this.daemonReady = true; this.upload();
    } else { if (message) this.host.notice(message); this.cancel(false); }
    this.render();
  }
  private upload() {
    clearTimeout(this.uploadTimer);
    if (!this.daemonReady || this.phase === 'idle') return;
    let sent = 0;
    while (this.pendingAudio.length && sent++ < 4) {
      const bytes = this.pendingAudio[0];
      if (!this.host.audio(bytes)) break;
      this.pendingAudio.shift(); this.pendingBytes -= bytes.byteLength;
    }
    if (this.pendingAudio.length) this.uploadTimer = setTimeout(() => this.upload(), 10);
    else if (this.captureFlushed) { this.captureFlushed = false; if (!this.host.send({ type: 'dictation', id: this.id, action: 'finish' })) this.cancel(); }
  }
  private finish() {
    if (this.phase === 'starting') { this.finishPending = true; return; }
    if (this.phase !== 'recording') return;
    if (this.capturePaused) { this.captureFailed('Recording was interrupted. Keep the screen on and try dictating again.'); return; }
    this.phase = 'finishing'; this.wakeLock.stop(); clearInterval(this.captureTimer); clearTimeout(this.audioTimer); this.processor!.port.postMessage('flush');
    this.audioTimer = setTimeout(() => { this.host.notice('Dictation timed out.'); this.cancel(); }, 180000);
    this.render();
  }
  private releaseAudio() { this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined; this.source?.disconnect(); this.processor?.disconnect(); void this.context?.close().catch(() => {}); this.context = undefined; }
  private captureFailed(message: string) { if (!this.active) return; this.host.notice(message); this.cancel(); }
  private checkCapture() {
    if (this.phase !== 'recording') return;
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState === 'ended' || this.context?.state === 'closed') { this.captureFailed('Microphone audio stopped. Keep the screen on and try dictating again.'); return; }
    const paused = track.muted || this.context?.state !== 'running' || Date.now() - this.lastAudio > 2500;
    if (paused && !document.hidden) {
      this.captureRecoveryDeadline ||= Date.now() + 7000;
      if (Date.now() > this.captureRecoveryDeadline) { this.captureFailed('Microphone audio did not start or resume. Check the selected microphone and try again.'); return; }
      if (!this.captureRecovering && !this.captureRecoveryAttempted) void this.recoverCapture();
    }
    if (!paused || document.hidden) this.captureRecoveryDeadline = 0;
    if (!paused) this.captureRecoveryAttempted = false;
    if (paused === this.capturePaused) return;
    this.capturePaused = paused;
    if (paused) { this.captureInterrupted = true; this.host.notice('Microphone audio paused. Unlock or return to this tab to resume; speech during the pause may be missing.'); }
    else if (this.captureInterrupted) this.host.notice('Microphone audio resumed. Speech during the pause may be missing.');
    this.render();
  }
  cancel(notify = true) {
    ++this.generation;
    this.wakeLock.stop(); clearInterval(this.captureTimer); this.capturePaused = this.captureInterrupted = false;
    this.captureRecovering = this.captureRecoveryAttempted = this.captureRestarted = false;
    this.captureRecoveryDeadline = 0;
    if (notify && this.phase !== 'idle') this.host.send({ type: 'dictation', id: this.id, action: 'cancel' });
    this.encoderStartupCancel?.(); this.encoderStartupCancel = undefined;
    this.encoder?.terminate(); this.encoder = undefined; this.encoderPending = 0;
    this.releaseAudio(); clearTimeout(this.audioTimer); clearTimeout(this.readyTimer); clearTimeout(this.uploadTimer);
    this.pendingAudio = []; this.pendingBytes = 0; this.daemonReady = this.captureFlushed = false;
    this.phase = 'idle'; this.render();
  }
}
