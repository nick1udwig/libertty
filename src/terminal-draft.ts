import { sameInputContext, type InputContext } from './unsent-input.ts';

type Status = 'draft' | 'pending' | 'delivered' | 'uncertain';
interface SavedDraft { key: string; text: string; updated: number; status: Status; context?: InputContext }
const storageKey = 'libertty.terminal-drafts', maximumDraft = 16000;
export function retainedDrafts(value: unknown, now = Date.now()): SavedDraft[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is SavedDraft => !!entry && typeof entry.key === 'string' && entry.key.length <= 4096
    && typeof entry.text === 'string' && entry.text.length <= maximumDraft && Number.isFinite(entry.updated)
    && now - entry.updated < 7 * 86400000 && entry.updated <= now + 60000
    && ['draft', 'pending', 'delivered', 'uncertain'].includes(entry.status)
    && (!entry.context || typeof entry.context === 'object' && typeof entry.context.session === 'string'
      && ['shell', 'program'].includes(entry.context.target) && Number.isSafeInteger(entry.context.prompt)
      && Number.isSafeInteger(entry.context.revision) && Number.isSafeInteger(entry.context.connection)))
    .sort((a, b) => b.updated - a.updated).slice(0, 16);
}
export function draftTargetMatches(before?: InputContext, after?: InputContext, picture = true) {
  return !!before && !!after && sameInputContext(before, after)
    && (!picture || before.target !== 'shell' || !before.identity || before.picture === after.picture);
}
function savedDrafts() {
  const raw = localStorage.getItem(storageKey);
  return retainedDrafts(raw && raw.length <= 1024 * 1024 ? JSON.parse(raw) : []);
}

/** Local editing never sends keys or retries a delivery without an explicit action. */
export class TerminalDraft {
  readonly element = document.createElement('section');
  readonly input = document.createElement('textarea');
  private status = document.createElement('p');
  private insert = document.createElement('button');
  private review = document.createElement('button');
  private phase: Status = 'draft';
  private context?: InputContext;
  private timer?: ReturnType<typeof setTimeout>;
  private delivery = 0;
  private storageFailed = false;
  private dirty = false;
  private flush = () => this.persist();
  private hidden = () => { if (document.hidden) this.persist(); };
  private key: string;
  private current: (picture?: boolean) => InputContext | undefined;
  private send: (text: string, context: InputContext) => Promise<boolean | undefined>;
  constructor(parent: HTMLElement, key: string, current: (picture?: boolean) => InputContext | undefined,
    send: (text: string, context: InputContext) => Promise<boolean | undefined>) {
    this.key = key; this.current = current; this.send = send;
    this.element.className = 'terminal-draft'; this.element.hidden = true; this.element.setAttribute('aria-label', 'Local draft');
    const title = document.createElement('strong'); title.textContent = 'Local draft';
    this.input.maxLength = maximumDraft; this.input.placeholder = 'Write here, even while offline'; this.input.setAttribute('aria-label', 'Draft text');
    this.input.spellcheck = true; this.input.autocapitalize = 'off';
    this.status.role = 'status';
    this.insert.textContent = 'Insert draft'; this.insert.onclick = () => { void this.deliver(); };
    this.review.textContent = 'Use current input target'; this.review.onclick = () => { this.context = this.current(true); this.phase = 'draft'; this.dirty = true; this.persist(); this.refresh(); };
    const close = document.createElement('button'); close.textContent = 'Close draft'; close.onclick = () => this.hide();
    const clear = document.createElement('button'); clear.textContent = 'Clear draft'; clear.onclick = () => { if (this.phase === 'pending') return; this.input.value = ''; this.context = this.current(true); this.phase = 'draft'; this.dirty = true; this.persist(); this.refresh(); };
    const actions = document.createElement('div'); actions.append(this.insert, this.review, clear, close);
    this.element.append(title, this.input, this.status, actions); parent.append(this.element);
    this.input.oninput = () => { this.dirty = true; this.phase = 'draft'; clearTimeout(this.timer); this.timer = setTimeout(() => this.persist(), 250); this.refresh(); };
    this.restore();
    window.addEventListener('pagehide', this.flush);
    document.addEventListener('visibilitychange', this.hidden);
  }
  private restore() {
    try {
      const saved = savedDrafts().find(entry => entry.key === this.key);
      this.input.value = saved?.text || ''; this.context = saved?.context; this.phase = saved?.status === 'pending' ? 'uncertain' : saved?.status || 'draft';
    } catch { this.storageFailed = true; }
  }
  show() {
    this.persist(); if (this.phase !== 'pending') this.restore();
    if (!this.input.value && this.phase === 'draft') this.context = this.current(true);
    this.element.hidden = false; this.refresh(); this.input.focus();
  }
  hide() { this.persist(); this.element.hidden = true; }
  refresh() {
    if (this.element.hidden) return;
    const current = this.current(), matches = draftTargetMatches(this.context, current, false);
    this.input.readOnly = this.phase === 'pending';
    this.insert.disabled = !this.input.value || !matches || this.phase !== 'draft';
    this.review.hidden = !current || this.phase === 'pending' || this.phase === 'delivered' || matches && this.phase !== 'uncertain';
    this.status.textContent = this.phase === 'pending' ? 'Pending · waiting for the terminal.'
      : this.phase === 'delivered' ? 'Delivered to the terminal · use Enter to submit.'
      : this.phase === 'uncertain' ? 'Delivery was not confirmed · check the terminal before trying again.'
      : !current ? 'Local draft · waiting for an input connection.'
      : !matches ? 'The input target changed · review it before inserting.'
      : `${current.target === 'shell' ? 'Shell' : 'Running program'} · edit locally, then insert when ready.`;
    if (this.storageFailed) this.status.textContent += ' Browser storage is unavailable; keep this tab open.';
  }
  disconnected() {
    if (this.phase === 'pending') { this.delivery++; this.phase = 'uncertain'; this.dirty = true; this.persist(); }
    this.refresh();
  }
  dispose() { this.disconnected(); this.persist(); clearTimeout(this.timer); window.removeEventListener('pagehide', this.flush); document.removeEventListener('visibilitychange', this.hidden); }
  private persist() {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    try {
      const entries = savedDrafts().filter(entry => entry.key !== this.key);
      if (this.input.value) entries.unshift({ key: this.key, text: this.input.value, updated: Date.now(), status: this.phase, context: this.context });
      localStorage.setItem(storageKey, JSON.stringify(retainedDrafts(entries))); this.storageFailed = false; this.dirty = false;
    } catch { this.storageFailed = true; }
  }
  private async deliver() {
    const current = this.current(true);
    if (!this.input.value || this.phase !== 'draft' || !current || !draftTargetMatches(this.context, current)) { this.context = undefined; this.refresh(); return; }
    const generation = ++this.delivery;
    this.phase = 'pending'; this.dirty = true; this.persist(); this.refresh();
    let result: boolean | undefined;
    try { result = await this.send(this.input.value, current); } catch { result = undefined; }
    if (generation !== this.delivery) return;
    this.phase = result === true ? 'delivered' : result === false ? 'draft' : 'uncertain';
    if (result === false) this.context = undefined;
    this.dirty = true; this.persist(); this.refresh();
  }
}
