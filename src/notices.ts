import './notices.css';
import { node } from './dom.ts';
import { closeIcon } from './icons.ts';
import { NoticeModel, urgent, type Notice, type NoticeInput, type NoticeKind } from './notice-model.ts';

type Edge = 'corner' | 'left' | 'right';
interface Placement { edge: Edge; y: number }
const placementKey = 'libertty.noticeOrb';
const kindNames: Record<NoticeKind, string> = { progress: 'In progress', error: 'Error', warning: 'Warning', info: 'Info', done: 'Done' };

function loadPlacement(): Placement {
  try {
    const value = JSON.parse(localStorage.getItem(placementKey) || 'null');
    if (['left', 'right'].includes(value?.edge) && Number.isFinite(value.y)) return { edge: value.edge, y: Math.min(1, Math.max(0, value.y)) };
  } catch { /* A missing or blocked store keeps the corner. */ }
  return { edge: 'corner', y: 0 };
}

/** The orb's own label names its mark, so only marks beside text are labelled. */
function mark(kind: NoticeKind, labelled = true) {
  const element = node('span', 'notice-mark');
  element.dataset.kind = kind;
  if (labelled) { element.role = 'img'; element.ariaLabel = kindNames[kind]; }
  return element;
}

/** A plain confirmation lets touches through, so it never blocks the terminal beneath it, and leaves on its own. */
const passive = (notice: Notice) => notice.key === undefined && ['done', 'info'].includes(notice.kind) && !notice.actions.length;
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** One orb owns every notice: new ones unfurl beside it, and tapping it lists current and earlier notices. */
export class NoticeCenter {
  readonly orb = node('button', 'notice-orb');
  private model = new NoticeModel(() => this.schedule());
  private ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private center = node('span', 'notice-orb-mark');
  private badge = node('span', 'notice-badge');
  private bubble = node('div', 'notice-pop notice-bubble');
  private panel = node('section', 'notice-pop notice-panel');
  private open = false;
  private shown?: Notice;
  private placement = loadPlacement();
  private drag?: { pointer: number; x: number; y: number; moved: boolean };
  private swipe?: { pointer: number; x: number; y: number; dx: number; moved: boolean };
  private dragged = false;
  private queued = false;

  constructor(root: HTMLElement = document.body) {
    this.orb.type = 'button'; this.orb.id = 'notice-orb'; this.orb.hidden = true;
    this.orb.setAttribute('aria-controls', 'notice-panel'); this.orb.setAttribute('aria-expanded', 'false');
    this.ring.setAttribute('class', 'notice-ring'); this.ring.setAttribute('viewBox', '0 0 44 44'); this.ring.setAttribute('aria-hidden', 'true');
    this.ring.innerHTML = '<circle cx="22" cy="22" r="21"/>';
    this.badge.setAttribute('aria-hidden', 'true');
    this.orb.append(this.ring, this.center, this.badge);
    this.bubble.id = 'notice-bubble'; this.bubble.hidden = true;
    this.panel.id = 'notice-panel'; this.panel.hidden = true; this.panel.ariaLabel = 'Notices';
    root.append(this.orb, this.bubble, this.panel);

    this.orb.onclick = () => { if (this.dragged) this.dragged = false; else this.toggle(); };
    this.orb.addEventListener('pointerdown', event => {
      this.dragged = false;
      if (event.button !== 0) return;
      // Capture at once so a quick flick that leaves the orb still drags it.
      this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; this.orb.setPointerCapture(event.pointerId);
    });
    this.orb.addEventListener('pointermove', event => this.moveOrb(event));
    this.orb.addEventListener('pointerup', event => this.dropOrb(event));
    this.orb.addEventListener('pointercancel', () => { this.drag = undefined; this.orb.classList.remove('dragging'); this.applyPlacement(); });
    this.bubble.addEventListener('pointerdown', event => this.startSwipe(event));
    this.bubble.addEventListener('pointermove', event => this.moveSwipe(event));
    this.bubble.addEventListener('pointerup', event => this.endSwipe(event));
    this.bubble.addEventListener('pointercancel', () => this.resetSwipe());
    // A press or keyboard focus holds a notice; hover does not, because a resting cursor would hold it forever.
    for (const type of ['pointerdown', 'focusin']) this.bubble.addEventListener(type, () => { if (this.shown) this.model.hold(this.shown); });
    for (const type of ['pointerup', 'pointercancel', 'focusout']) this.bubble.addEventListener(type, () => { if (this.shown) this.model.resume(this.shown); });
    for (const element of [this.orb, this.bubble, this.panel]) element.addEventListener('keydown', event => this.key(event));
    document.addEventListener('pointerdown', event => {
      if (this.open && !this.panel.contains(event.target as Node) && !this.orb.contains(event.target as Node)) this.toggle(false);
    }, true);
    // Taps inside a terminal frame never reach this document, but they move focus away from it.
    window.addEventListener('blur', () => { if (this.open) this.toggle(false); });
    window.addEventListener('resize', () => { this.applyPlacement(); this.position(); });
    this.applyPlacement(); this.render();
  }

  notify(input: NoticeInput) { this.model.notify(input); }
  /** Show a condition until it clears; an error or warning unfurls when it appears or changes. */
  set(key: string, input?: NoticeInput) { this.model.set(key, input); }

  toggle(open = !this.open) {
    if (open === this.open) return;
    this.open = open;
    if (this.model.presented) this.model.fold(); else this.render();
  }

  /** Draw once after a burst of changes, such as a tab switch, so layout is read once. */
  private schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; this.render(); });
  }

  private render() {
    const model = this.model, { strongest, progress, unread } = model, edge = this.placement.edge;
    this.orb.hidden = !model.active && !this.open;
    this.orb.dataset.edge = edge;
    this.orb.dataset.states = [...model.states.keys()].join(' ');
    this.orb.classList.toggle('progress', progress);
    this.orb.setAttribute('aria-expanded', String(this.open));
    this.center.replaceChildren(...(strongest ? [mark(strongest.kind, false)] : progress && edge !== 'corner' ? [mark('progress', false)] : []));
    this.badge.textContent = String(unread); this.badge.hidden = unread < 2;
    const states = [...model.states.values()].map(notice => notice.message);
    this.orb.ariaLabel = ['Notices', ...states, model.events.length ? model.events.length + ' unread' : ''].filter(Boolean).join('. ');

    const presented = this.open ? undefined : model.presented;
    if (presented !== this.shown) {
      // A notice that leaves the bubble while held must keep its lifetime.
      if (this.shown) this.model.resume(this.shown);
      this.shown = presented; this.resetSwipe();
      // The bubble is its own live region, so its role is set before its new content shows.
      if (presented) {
        this.bubble.role = urgent(presented.kind) ? 'alert' : 'status';
        this.bubble.classList.toggle('notice-passive', passive(presented));
        this.bubble.replaceChildren(this.item(presented, true));
      }
      this.bubble.hidden = !presented;
    }
    this.panel.hidden = !this.open;
    if (this.open) this.renderPanel();
    this.position();
  }

  /** A state can only be put away from the bubble, because the list shows whatever is still true. */
  private item(notice: Notice, bubble = false) {
    const item = node('div', 'notice-item'), body = node('div', 'notice-body');
    item.dataset.kind = notice.kind;
    body.append(node('p', 'notice-text', notice.message));
    if (notice.source) body.append(node('p', 'notice-meta', notice.source));
    item.append(mark(notice.kind), body);
    if (bubble ? !passive(notice) : notice.key === undefined) {
      const close = node('button', 'notice-close');
      close.type = 'button'; close.innerHTML = closeIcon;
      close.ariaLabel = notice.key === undefined ? 'Dismiss' : 'Hide';
      close.onclick = () => this.model.dismiss(notice);
      item.append(close);
    }
    if (notice.actions.length) {
      const actions = node('div', 'notice-actions');
      for (const action of notice.actions) {
        const control = node('button', 'notice-action', action.label);
        control.type = 'button';
        control.onclick = () => { if (notice.key === undefined) this.model.dismiss(notice); action.run(); };
        actions.append(control);
      }
      item.append(actions);
    }
    return item;
  }

  private renderPanel() {
    const model = this.model, header = node('header'), clear = node('button', 'notice-clear', 'Clear');
    clear.type = 'button'; clear.onclick = () => this.model.clear();
    clear.hidden = !model.events.length && !model.history.length;
    header.append(node('h2', '', 'Notices'), clear);
    this.panel.replaceChildren(header);
    const current = model.current;
    if (current.length) this.panel.append(node('p', 'notice-section', 'Now'), ...current.map(notice => this.item(notice)));
    if (model.history.length) {
      if (current.length) this.panel.append(node('hr'));
      this.panel.append(node('p', 'notice-section', 'Earlier'), ...model.history.map(notice => {
        const row = node('div', 'notice-earlier'), stamp = node('time', '', time(notice.at));
        stamp.dateTime = new Date(notice.at).toISOString();
        row.append(mark(notice.kind), node('span', 'notice-text', notice.message), stamp);
        return row;
      }));
    }
    if (!current.length && !model.history.length) this.panel.append(node('p', 'notice-empty', 'Nothing needs you.'));
  }

  /** Point the bubble and the list at the orb from whichever edge it rests on. */
  private position() {
    if (this.orb.hidden) return;
    const orb = this.orb.getBoundingClientRect(), edge = this.placement.edge, height = innerHeight;
    const centerX = orb.left + orb.width / 2, centerY = orb.top + orb.height / 2;
    for (const pop of [this.bubble, this.panel]) {
      if (pop.hidden) continue;
      const style = pop.style;
      pop.dataset.edge = edge;
      style.left = style.right = style.top = style.maxHeight = '';
      if (edge === 'corner') {
        const right = Math.max(8, innerWidth - orb.right - 2);
        style.right = right + 'px'; style.top = orb.bottom + 12 + 'px'; style.maxHeight = height - orb.bottom - 24 + 'px';
        style.setProperty('--notch', Math.max(12, innerWidth - right - centerX - 7) + 'px');
      } else {
        if (edge === 'left') style.left = orb.right + 12 + 'px'; else style.right = innerWidth - orb.left + 12 + 'px';
        const top = Math.max(8, Math.min(centerY - 28, height - pop.offsetHeight - 8));
        style.top = top + 'px'; style.maxHeight = height - 16 + 'px';
        style.setProperty('--notch', Math.max(12, Math.min(centerY - top - 7, pop.offsetHeight - 26)) + 'px');
      }
    }
  }

  private applyPlacement() {
    const { edge, y } = this.placement;
    this.orb.dataset.edge = edge;
    this.orb.style.left = this.orb.style.right = '';
    this.orb.style.top = edge === 'corner' ? '' : Math.max(8, Math.min(y * innerHeight - 28, innerHeight - 64)) + 'px';
  }

  private moveOrb(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
      drag.moved = true; this.orb.classList.add('dragging');
      this.toggle(false); this.model.fold();
    }
    this.orb.style.left = event.clientX - this.orb.offsetWidth / 2 + 'px'; this.orb.style.right = 'auto';
    this.orb.style.top = event.clientY - this.orb.offsetHeight / 2 + 'px';
  }

  /** Release near the top right corner to return there, or anywhere else to park on the nearer side. */
  private dropOrb(event: PointerEvent) {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag?.moved || drag.pointer !== event.pointerId) return;
    this.dragged = true; this.orb.classList.remove('dragging');
    const corner = event.clientX > innerWidth - 96 && event.clientY < 120;
    this.placement = corner ? { edge: 'corner', y: 0 } : { edge: event.clientX < innerWidth / 2 ? 'left' : 'right', y: Math.min(0.9, Math.max(0.05, event.clientY / innerHeight)) };
    try { if (corner) localStorage.removeItem(placementKey); else localStorage.setItem(placementKey, JSON.stringify(this.placement)); }
    catch { /* The orb returns to the corner next time. */ }
    this.applyPlacement(); this.render();
  }

  private startSwipe(event: PointerEvent) {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    this.swipe = { pointer: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, moved: false };
  }

  private moveSwipe(event: PointerEvent) {
    const swipe = this.swipe;
    if (!swipe || swipe.pointer !== event.pointerId) return;
    swipe.dx = event.clientX - swipe.x;
    if (!swipe.moved && Math.abs(swipe.dx) > 10 && Math.abs(swipe.dx) > Math.abs(event.clientY - swipe.y)) { swipe.moved = true; this.bubble.setPointerCapture(event.pointerId); }
    if (!swipe.moved) return;
    this.bubble.style.transform = `translateX(${swipe.dx}px)`;
    this.bubble.style.opacity = String(Math.max(0.2, 1 - Math.abs(swipe.dx) / 240));
  }

  /** Swipe sideways to dismiss, or up to put the notice away. */
  private endSwipe(event: PointerEvent) {
    const swipe = this.swipe, shown = this.shown;
    if (!swipe || swipe.pointer !== event.pointerId) return;
    this.resetSwipe();
    if (!shown) return;
    if (swipe.moved && Math.abs(swipe.dx) > 80) this.model.dismiss(shown);
    else if (!swipe.moved && event.clientY - swipe.y < -40) this.model.fold(shown);
  }

  private resetSwipe() {
    this.swipe = undefined;
    this.bubble.style.transform = this.bubble.style.opacity = '';
  }

  private key(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (this.open) { this.toggle(false); this.orb.focus(); }
    else if (this.shown) this.model.dismiss(this.shown);
    else return;
    event.preventDefault(); event.stopPropagation();
  }
}
