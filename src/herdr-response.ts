import { node } from './dom.ts';

interface Host { response(): Promise<{ text: string }>; notice(message: string): void }

export class HerdrResponse {
  readonly element = node('div', 'herdr-response-actions');
  private button = node('button', 'herdr-copy-response', 'Copy response');
  private pending = false;
  private disposed = false;
  private modal?: HTMLDialogElement;
  private host: Host;
  constructor(host: Host) {
    this.host = host;
    this.button.type = 'button'; this.button.title = 'Copy the latest assistant response';
    this.button.setAttribute('aria-label', 'Copy latest assistant response');
    this.button.onclick = () => void this.copy(); this.element.append(this.button);
  }
  update(available: boolean) { this.element.hidden = !available; this.button.disabled = this.pending; }
  private async copy() {
    if (this.pending || this.disposed) return;
    this.pending = this.button.disabled = true; this.button.textContent = 'Copying…';
    const response = this.host.response();
    try {
      let copied = false;
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const blob = response.then(({ text }) => new Blob([text], { type: 'text/plain' }));
        void blob.catch(() => {});
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
          copied = true;
        } catch { /* A fresh gesture in the dialog can retry a denied clipboard write. */ }
      }
      const { text } = await response;
      if (this.disposed) return;
      if (copied) this.host.notice('Agent response copied.');
      else this.show(text);
    } catch (error) {
      if (!this.disposed) this.host.notice(error instanceof Error ? error.message : 'Could not read the agent response.');
    } finally {
      this.pending = this.button.disabled = false; this.button.textContent = 'Copy response';
    }
  }
  private show(text: string) {
    this.modal?.close();
    const modal = node('dialog', 'herdr-response-dialog'), title = node('h2', '', 'Copy agent response');
    const body = node('textarea'), status = node('p', 'hint', 'Select the response to copy it, or tap Copy.'), actions = node('div', 'actions');
    const copy = node('button', '', 'Copy'), close = node('button', 'secondary', 'Close');
    title.id = 'copy-response-' + crypto.randomUUID(); modal.setAttribute('aria-labelledby', title.id);
    body.readOnly = true; body.value = text; body.setAttribute('aria-label', 'Agent response'); status.role = 'status';
    copy.type = close.type = 'button'; close.onclick = () => modal.close();
    copy.onclick = () => {
      body.focus(); body.select();
      if (!navigator.clipboard?.writeText) { status.textContent = 'Response selected; use your browser’s Copy action.'; return; }
      void navigator.clipboard.writeText(text).then(() => { this.host.notice('Agent response copied.'); modal.close(); }, () => { status.textContent = 'Response selected; use your browser’s Copy action.'; });
    };
    modal.onclose = () => { modal.remove(); if (this.modal === modal) this.modal = undefined; };
    actions.append(close, copy); modal.append(title, body, status, actions); document.body.append(modal);
    this.modal = modal; modal.showModal(); body.focus(); body.select();
  }
  dispose() { this.disposed = true; this.modal?.close(); this.element.remove(); }
}
