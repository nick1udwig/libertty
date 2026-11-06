import type { Notify } from './notice-model.ts';
import { DictationWakeLock, dictationWakeEnvironment } from './dictation-wake-lock.ts';

interface CaptureEvents {
  started(): void;
  level(pcm: ArrayBuffer): void;
  frame(frame: ArrayBuffer): void;
  flushed(): void;
  finish(): void;
  failed(message: string): void;
  changed(): void;
  notice: Notify;
}

export class DictationCapture {
  private phase: 'starting' | 'recording' | 'finishing' | 'idle' = 'starting';
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: AudioWorkletNode;
  private encoder?: Worker;
  private encoderPending = 0;
  private encoderStartupCancel?: () => void;
  private generation = 0;
  private audioTimer?: ReturnType<typeof setTimeout>;
  private captureTimer?: ReturnType<typeof setInterval>;
  private capturePaused = false;
  private captureInterrupted = false;
  private lastAudio = 0;
  private captureRecovering = false;
  private captureRecoveryAttempted = false;
  private captureRestarted = false;
  private captureRecoveryDeadline = 0;
  private wakeLock: DictationWakeLock;
  private events: CaptureEvents;

  constructor(events: CaptureEvents) {
    this.events = events;
    this.wakeLock = new DictationWakeLock(dictationWakeEnvironment(), (message) =>
      events.notice(message, 'warning'),
    );
  }
  get paused() {
    return this.capturePaused;
  }
  async start() {
    if (this.phase === 'idle') return;
    const generation = this.generation;
    this.wakeLock.start();
    this.audioTimer = setTimeout(
      () =>
        this.captureFailed(
          'Microphone audio did not start. Check microphone permission and try again.',
        ),
      15000,
    );
    try {
      // Request microphone access and resume audio within the same user gesture.
      const context = (this.context = new AudioContext());
      const microphone = this.microphone(generation);
      const [stream] = await Promise.all([
        microphone,
        context.resume(),
        this.startEncoder(generation),
      ]);
      if (generation !== this.generation || !stream) return;
      context.addEventListener('statechange', () => {
        if (generation === this.generation) this.checkCapture();
      });
      await context.audioWorklet.addModule(new URL('dictation-worklet.js', document.baseURI).href);
      if (generation !== this.generation) return;
      this.source = context.createMediaStreamSource(stream);
      this.processor = new AudioWorkletNode(context, 'dictation-pcm');
      this.processor.addEventListener('processorerror', () => {
        if (generation === this.generation)
          this.captureFailed('Microphone audio processing stopped. Please try dictating again.');
      });
      this.processor.port.onmessage = (event) => {
        if (generation !== this.generation) return;
        if (event.data?.type === 'error') {
          this.captureFailed(event.data.message);
          return;
        }
        if (event.data === 'flushed') {
          this.encoder!.postMessage({ type: 'finish' });
          this.releaseAudio();
        } else {
          this.lastAudio = Date.now();
          this.checkCapture();
          if (generation !== this.generation) return;
          this.events.level(event.data);
          if (++this.encoderPending > 8) {
            this.captureFailed('Audio encoding is too slow. Please try again.');
            return;
          }
          this.encoder!.postMessage({ type: 'audio', pcm: event.data }, [event.data]);
        }
      };
      this.phase = 'recording';
      this.events.started();
      if (generation !== this.generation) return;
      this.source.connect(this.processor);
      this.processor.connect(context.destination);
      this.lastAudio = Date.now();
      this.capturePaused = this.captureInterrupted = false;
      this.captureTimer = setInterval(() => this.checkCapture(), 1000);
      this.checkCapture();
      if (generation !== this.generation) return;

      clearTimeout(this.audioTimer);
      this.audioTimer = setTimeout(() => this.events.finish(), 299000);
      // Permission prompts or device startup can suspend an already resumed context.
      await context.resume();
      if (generation !== this.generation) return;
      this.events.changed();
    } catch (error) {
      if (generation === this.generation) {
        this.captureFailed((error as Error).message);
      }
    }
  }
  private async microphone(generation: number): Promise<MediaStream | undefined> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('The microphone stopped before recording started.');
    }
    const previous = this.stream;
    this.stream = stream;
    previous?.getTracks().forEach((track) => track.stop());
    track.addEventListener('ended', () => {
      if (generation === this.generation && stream === this.stream)
        this.captureFailed(
          'Microphone access ended. Recording stopped; check microphone permission and try again.',
        );
    });
    track.addEventListener('mute', () => {
      if (generation === this.generation && stream === this.stream) this.checkCapture();
    });
    track.addEventListener('unmute', () => {
      if (generation === this.generation && stream === this.stream) this.checkCapture();
    });
    return stream;
  }
  private async recoverCapture() {
    const generation = this.generation,
      context = this.context;
    if (!context) return;
    this.captureRecovering = this.captureRecoveryAttempted = true;
    try {
      if (context.state !== 'running') await context.resume();
      if (generation !== this.generation || this.phase !== 'recording') return;
      if (Date.now() - this.lastAudio > 2500 && !this.captureRestarted) {
        this.captureRestarted = true;
        const stream = await this.microphone(generation);
        if (generation !== this.generation || !stream) return;
        if (this.phase !== 'recording') {
          this.releaseAudio();
          return;
        }
        this.source?.disconnect();
        this.source = context.createMediaStreamSource(stream);
        this.source.connect(this.processor!);
        await context.resume();
      }
    } catch {
      if (generation === this.generation)
        this.captureFailed(
          'Microphone audio could not resume. Recording stopped; try again with the screen on.',
        );
    } finally {
      if (generation === this.generation) this.captureRecovering = false;
    }
  }
  private startEncoder(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const encoder = (this.encoder = new Worker(
        new URL('./dictation-encoder.worker.ts', import.meta.url),
        { type: 'module' },
      ));
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error('Audio encoder did not become ready.'));
      }, 10000);
      this.encoderStartupCancel = () => {
        clearTimeout(timer);
        resolve();
      };
      const fail = (message: string) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(message));
        else if (generation === this.generation) {
          this.captureFailed(message);
        }
      };
      encoder.onerror = () => fail('Could not encode dictation.');
      encoder.onmessage = (event) => {
        if (generation !== this.generation) {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (event.data.type === 'ready') {
          clearTimeout(timer);
          this.encoderStartupCancel = undefined;
          ready = true;
          resolve();
        } else if (event.data.type === 'consumed') {
          this.encoderPending--;
          this.processor?.port.postMessage({ type: 'consumed' });
        } else if (event.data.type === 'error') fail(event.data.message);
        else if (event.data.type === 'audio') {
          try {
            this.events.frame(event.data.frame);
          } catch (error) {
            fail((error as Error).message);
            return;
          }
        } else if (event.data.type === 'flushed') {
          this.dispose();
          this.events.flushed();
        }
      };
    });
  }
  private releaseAudio() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.source?.disconnect();
    this.source = undefined;
    this.processor?.disconnect();
    this.processor = undefined;
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
  private captureFailed(message: string) {
    if (this.phase === 'idle') return;
    this.dispose();
    this.events.failed(message);
  }
  checkCapture() {
    if (this.phase !== 'recording') return;
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState === 'ended' || this.context?.state === 'closed') {
      this.captureFailed('Microphone audio stopped. Keep the screen on and try dictating again.');
      return;
    }
    const paused =
      track.muted || this.context?.state !== 'running' || Date.now() - this.lastAudio > 2500;
    if (paused && !document.hidden) {
      this.captureRecoveryDeadline ||= Date.now() + 7000;
      if (Date.now() > this.captureRecoveryDeadline) {
        this.captureFailed(
          'Microphone audio did not start or resume. Check the selected microphone and try again.',
        );
        return;
      }
      if (!this.captureRecovering && !this.captureRecoveryAttempted) void this.recoverCapture();
    }
    if (!paused || document.hidden) this.captureRecoveryDeadline = 0;
    if (!paused) this.captureRecoveryAttempted = false;
    if (paused === this.capturePaused) return;
    this.capturePaused = paused;
    if (paused) {
      this.captureInterrupted = true;
      this.events.notice(
        'Microphone audio paused. Unlock or return to this tab to resume; speech during the pause may be missing.',
        'warning',
      );
    } else if (this.captureInterrupted)
      this.events.notice(
        'Microphone audio resumed. Speech during the pause may be missing.',
        'info',
      );
    this.events.changed();
  }
  finish() {
    if (this.phase !== 'recording') return;
    this.phase = 'finishing';
    this.wakeLock.stop();
    clearInterval(this.captureTimer);
    clearTimeout(this.audioTimer);
    this.processor!.port.postMessage('flush');
  }
  dispose() {
    if (this.phase === 'idle') return;
    this.phase = 'idle';
    ++this.generation;
    this.wakeLock.dispose();
    clearInterval(this.captureTimer);
    clearTimeout(this.audioTimer);
    this.encoderStartupCancel?.();
    this.encoderStartupCancel = undefined;
    this.encoder?.terminate();
    this.encoder = undefined;
    this.releaseAudio();
  }
}
