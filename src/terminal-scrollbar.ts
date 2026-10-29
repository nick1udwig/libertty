import type { Terminal } from './terminal-adapter.ts';
import { terminalContact } from './terminal-contact.ts';

/** A screen-edge scrollbar that shares the terminal's scrollback and focus policy. */
export class TerminalScrollbar {
  private track = document.createElement('div');
  private thumb = document.createElement('div');
  private drag?: { offset: number };
  private thumbHeight = 0;
  private travel = 0;
  private maximum = 0;
  private previous = '';

  constructor(term: Terminal, begin: () => void) {
    const element = term.element!;
    this.track.className = 'terminal-scrollbar'; this.track.tabIndex = 0;
    this.track.setAttribute('role', 'scrollbar');
    this.track.setAttribute('aria-label', 'Terminal history');
    this.track.setAttribute('aria-orientation', 'vertical');
    this.track.setAttribute('aria-controls', element.id);
    this.track.setAttribute('aria-valuemin', '0');
    this.thumb.className = 'terminal-scrollbar-thumb';
    this.track.append(this.thumb); element.append(this.track);
    const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
    const render = () => {
      const container = element.parentElement;
      if (container?.id === 'terminal-viewport') this.track.style.right = `${Math.max(0, element.clientWidth - container.clientWidth - container.scrollLeft)}px`;
      const maximum = term.buffer.active.type === 'normal' ? Math.max(0, term.buffer.active.length - term.rows) : 0;
      const height = element.clientHeight, viewport = term.getViewportY();
      const state = `${maximum}:${height}:${term.rows}:${viewport}`;
      if (state === this.previous) return;
      this.previous = state; this.maximum = maximum;
      this.track.hidden = maximum === 0;
      this.thumbHeight = Math.min(height, Math.max(24, height * term.rows / (maximum + term.rows)));
      this.travel = height - this.thumbHeight;
      this.thumb.style.height = `${this.thumbHeight}px`;
      this.thumb.style.transform = `translateY(${maximum ? this.travel * (1 - viewport / maximum) : 0}px)`;
      this.track.setAttribute('aria-valuemax', String(maximum));
      this.track.setAttribute('aria-valuenow', String(Math.round(maximum - viewport)));
    };
    const position = (y: number) => {
      if (!this.drag || !this.travel) return;
      const top = this.track.getBoundingClientRect().top;
      const fraction = Math.max(0, Math.min(1, (y - top - this.drag.offset) / this.travel));
      term.scrollToLine(this.maximum * (1 - fraction));
    };
    const release = () => { this.drag = undefined; this.track.classList.remove('dragging'); };
    terminalContact(this.track, {
      down: ({ y, button }) => {
        if (button !== 0) return false;
        begin(); render();
        const thumb = this.thumb.getBoundingClientRect();
        const inside = y >= thumb.top && y <= thumb.bottom;
        this.drag = { offset: inside ? y - thumb.top : this.thumbHeight / 2 };
        this.track.classList.add('dragging');
        if (!inside) position(y);
        return true;
      },
      move: ({ y }) => position(y), up: release, cancel: release,
    });
    for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu'])
      this.track.addEventListener(type, stop, { passive: false });
    this.track.addEventListener('keydown', event => {
      const amount = { ArrowUp: -1, ArrowDown: 1, PageUp: -term.rows, PageDown: term.rows }[event.key];
      if (amount === undefined && !['Home', 'End'].includes(event.key)) return;
      stop(event); begin();
      if (event.key === 'Home') term.scrollToTop();
      else if (event.key === 'End') term.scrollToBottom();
      else term.scrollLines(amount!);
    });
    term.onRender(render);
    term.onScroll(render); term.onResize(render);
    const resize = new ResizeObserver(render); resize.observe(element);
    const container = element.parentElement; container?.addEventListener('scroll', render);
    window.addEventListener('pagehide', event => { if (!event.persisted) { resize.disconnect(); container?.removeEventListener('scroll', render); } });
    render();
  }
}
