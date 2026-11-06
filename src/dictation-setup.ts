import type { ShellState } from './protocol.ts';
import type { Notify } from './notice-model.ts';

interface SetupHost {
  api<T>(path: string, data?: unknown): Promise<T>;
  state(): ShellState;
  prepare(): void;
  focus(): void;
  notice: Notify;
  key: string;
}
export class DictationSetup {
  available = false;
  private dialog = document.createElement('dialog');
  private online = false;
  private visible = true;
  private offered = false;
  private installed?: boolean;
  private daemonAvailable?: boolean;
  private unavailableReason?: string;
  private polling = false;
  private lastPoll = -Infinity;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private installPrompt?: number;
  private host: SetupHost;
  private active: () => boolean;
  private changed: () => void;
  constructor(host: SetupHost, active: () => boolean, changed: () => void) {
    this.host = host;
    this.active = active;
    this.changed = changed;
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
    document.addEventListener('visibilitychange', () => {
      this.pause();
      if (!document.hidden) void this.poll(!this.available);
    });
  }
  pause() {
    clearTimeout(this.pollTimer);
  }
  connected(online: boolean) {
    const changed = this.online !== online;
    this.online = online;
    if (!online) {
      this.pause();
      if (!this.active()) this.available = false;
      this.dialog.close();
    } else if (changed) void this.poll(true);
  }
  visibility(visible: boolean) {
    this.visible = visible;
    if (!visible) {
      this.pause();
      this.dialog.close();
    } else void this.poll(!this.available);
  }
  private save(value: string) {
    try {
      localStorage.setItem('libertty.voxtype:' + this.host.key, value);
    } catch {}
  }
  prompt() {
    const state = this.host.state();
    const installed =
      this.installPrompt !== undefined && state.ready && state.prompt !== this.installPrompt;
    if (installed) this.installPrompt = undefined;
    if (state.ready) void this.poll(installed);
    this.offer();
  }
  async poll(force = false) {
    if (!this.online || !this.visible || document.hidden || this.polling || this.active()) return;
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
      if (retry && this.online && this.visible && !document.hidden && !this.active())
        this.pollTimer = setTimeout(() => void this.poll(true), 15000);
      this.changed();
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
}
