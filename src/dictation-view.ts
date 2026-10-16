import { dictationLayout, dictationLevel } from './dictation-layout.ts';

export class DictationView {
  button = document.createElement('button');
  cancel = document.createElement('button');
  private panel = document.createElement('div');
  private activity = document.createElement('div');
  private meter: SVGElement;
  private label = document.createElement('span');
  private levels = Array<number>(11).fill(0);
  private drawn = Array<number>(11).fill(0);
  private frame = 0;
  private lastDraw = 0;
  private expanded = false;
  private waiting = false;
  private fraction = [1, .26];
  private fullHeight = 0;
  private lastWidth = 0;
  constructor() {
    this.button.className = 'dictation-mic'; this.button.id = 'libertty-dictation'; this.button.type = 'button'; this.button.hidden = true;
    this.button.innerHTML = '<span class="dictation-microphone-icon"></span><svg class="dictation-check" viewBox="0 0 48 48"><path d="M17.5 24 22 28.5 31 19.5"/></svg><svg class="dictation-dots" viewBox="0 0 48 48"><circle cx="17" cy="24" r="1.6"/><circle cx="24" cy="24" r="1.6"/><circle cx="31" cy="24" r="1.6"/></svg>';
    for (const icon of this.button.children) icon.setAttribute('aria-hidden', 'true');
    this.cancel.className = 'dictation-cancel'; this.cancel.type = 'button';
    this.cancel.setAttribute('aria-label', 'Cancel dictation');
    this.cancel.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="m18.5 18.5 11 11m0-11-11 11"/></svg>';
    this.panel.className = 'dictation-panel'; this.panel.hidden = true;
    this.activity.className = 'dictation-activity'; this.activity.setAttribute('role', 'status');
    this.activity.innerHTML = '<svg viewBox="0 0 92 48" aria-hidden="true">' + Array.from({ length: 11 }, (_, i) => `<line x1="${21 + i * 5}" x2="${21 + i * 5}" y1="24" y2="24.01"/>`).join('') + '</svg>';
    this.meter = this.activity.querySelector('svg')!;
    this.label.hidden = true; this.activity.append(this.label);
    this.panel.append(this.cancel, this.activity); document.body.append(this.panel, this.button);
    try {
      const value = JSON.parse(localStorage.getItem('libertty.micPositionFraction') || 'null');
      if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v))) this.fraction = value.map(v => Math.max(0, Math.min(1, v)));
    } catch {}
    window.visualViewport?.addEventListener('resize', () => this.layout());
    window.addEventListener('resize', () => this.layout());
    this.layout();
  }
  private bounds() {
    // The terminal iframe already excludes the workspace header/system insets.
    const width = window.visualViewport?.width || innerWidth;
    const height = (window.visualViewport?.height || innerHeight) - (document.querySelector('.input-dock')?.getBoundingClientRect().height || 0);
    this.fullHeight = width === this.lastWidth ? Math.max(this.fullHeight, height) : height;
    this.lastWidth = width;
    return { width, height };
  }
  private layout(x?: number, y?: number) {
    const { width, height } = this.bounds();
    const p = dictationLayout(x ?? 12 + this.fraction[0] * Math.max(0, width - 72), y ?? 12 + this.fraction[1] * Math.max(0, this.fullHeight - 72), width, height);
    this.button.style.left = p.bx + 'px'; this.button.style.top = p.by + 'px';
    this.panel.style.left = p.px + 'px'; this.panel.style.top = p.py + 'px';
    this.panel.classList.toggle('panel-right', !p.panelOnLeft);
    return p;
  }
  position(x: number, y: number) { this.layout(x, y); }
  remember() {
    const { width } = this.bounds();
    this.fraction = [(this.button.offsetLeft - 12) / Math.max(1, width - 72), (this.button.offsetTop - 12) / Math.max(1, this.fullHeight - 72)];
    try { localStorage.setItem('libertty.micPositionFraction', JSON.stringify(this.fraction)); } catch {}
  }
  update(phase: string, visible: boolean, paused = false) {
    const expanded = phase !== 'idle'; this.waiting = phase === 'finishing' || phase === 'retry';
    this.button.hidden = !visible; this.panel.hidden = !visible || !expanded;
    this.button.classList.toggle('recording', expanded); this.button.classList.toggle('waiting', this.waiting);
    this.button.classList.toggle('paused', paused);
    this.button.setAttribute('aria-label', 'Libertty dictation microphone');
    this.button.setAttribute('aria-description', paused ? 'Audio capture paused. Unlock or return to resume, or cancel dictation.' : !expanded ? 'Dictate: hold and release, or tap to start and stop. Drag to move.' : phase === 'retry' ? 'Retry retained dictation at the current prompt, or drag to move.' : this.waiting ? 'Transcribing. Drag to move.' : 'Stop dictation. Drag to move.');
    this.button.setAttribute('aria-pressed', String(expanded));
    this.activity.setAttribute('aria-label', paused ? 'Audio capture paused' : this.waiting ? 'Transcribing' : 'Microphone activity');
    this.label.textContent = phase === 'retry' ? 'Tap to retry' : paused ? 'Audio paused' : 'Transcribing…'; this.label.hidden = !this.waiting && !paused; this.meter.style.display = this.waiting || paused ? 'none' : '';
    if (!expanded) { cancelAnimationFrame(this.frame); this.frame = 0; this.lastDraw = 0; this.levels.fill(0); this.drawn.fill(0); this.paint(performance.now()); }
    if (this.expanded !== expanded) {
      // Reflow the panel without moving the microphone out from under the finger.
      this.layout(this.button.hidden ? parseFloat(this.button.style.left) : this.button.offsetLeft, this.button.hidden ? parseFloat(this.button.style.top) : this.button.offsetTop);
      this.expanded = expanded;
    }
  }
  level(bytes: ArrayBuffer) {
    if (this.waiting) return;
    this.levels.shift(); this.levels.push(dictationLevel(bytes));
    if (!this.frame) this.frame = requestAnimationFrame(at => this.paint(at));
  }
  private paint(at: number) {
    this.frame = 0;
    const blend = this.lastDraw ? Math.min(1, (at - this.lastDraw) / 70) : 1; this.lastDraw = at;
    let moving = false;
    for (let i = 0; i < 11; i++) {
      this.drawn[i] += (this.levels[i] - this.drawn[i]) * blend;
      moving ||= Math.abs(this.levels[i] - this.drawn[i]) > .005;
      const bar = Math.max(.01, this.drawn[i] * 22), line = this.meter.children[i];
      line.setAttribute('y1', String(24 - bar / 2)); line.setAttribute('y2', String(24 + bar / 2));
    }
    if (moving && !this.waiting) this.frame = requestAnimationFrame(at => this.paint(at));
  }
}
