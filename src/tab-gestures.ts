interface TabGestures {
  select(): void; hold(): void; drag?(clientX: number): void;
  finish?(): void; scroll?: HTMLElement; dragging?(): void;
  drop?(clientX: number): void;
}
/** Swiping scrolls the strip; holding opens actions and allows reordering. */
export function tabGestures(element: HTMLElement, actions: TabGestures) {
  let press: { id: number; x: number; y: number; scroll: number; held: boolean; dragged: boolean; moved: boolean } | undefined;
  let timer: ReturnType<typeof setTimeout>, suppress = false;
  const finish = () => {
    clearTimeout(timer); if (press) suppress = press.held || press.moved;
    element.classList.remove('dragging'); press = undefined; actions.finish?.();
  };
  element.addEventListener('pointerdown', event => {
    const button = (event.target as HTMLElement).closest('button');
    if (event.button !== 0 || button && button !== element) return;
    suppress = false; press = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: actions.scroll?.scrollLeft || 0, held: false, dragged: false, moved: false };
    element.setPointerCapture(event.pointerId);
    timer = setTimeout(() => { if (press && !press.moved) { press.held = true; suppress = true; actions.hold(); } }, 450);
  });
  element.addEventListener('pointermove', event => {
    if (!press || event.pointerId !== press.id) return;
    const dx = event.clientX - press.x, dy = event.clientY - press.y;
    if (Math.hypot(dx, dy) < 8 && !press.dragged) return;
    if (event.defaultPrevented && !press.held) { press.moved = true; clearTimeout(timer); return; }
    if (press.held && actions.drag) {
      event.preventDefault();
      clearTimeout(timer); press.moved = true;
      if (!press.dragged) { press.dragged = true; element.classList.add('dragging'); actions.dragging?.(); }
      actions.drag(event.clientX);
      // Reordering reparents the element, which can release pointer capture.
      if (element.isConnected) element.setPointerCapture(event.pointerId);
      return;
    }
    press.moved = true; clearTimeout(timer);
    if (actions.scroll && Math.abs(dx) >= Math.abs(dy)) { event.preventDefault(); actions.scroll.scrollLeft = press.scroll - dx; }
  });
  element.addEventListener('pointerup', event => { if (press?.id !== event.pointerId) return; if (press.dragged) actions.drop?.(event.clientX); finish(); });
  element.addEventListener('pointercancel', finish);
  element.addEventListener('click', event => { if (suppress && event.detail) { event.preventDefault(); event.stopPropagation(); suppress = false; return; } suppress = false; actions.select(); });
  element.addEventListener('contextmenu', event => { event.preventDefault(); actions.hold(); });
  element.addEventListener('keydown', event => {
    if (event.key === 'F10' && event.shiftKey || event.key === 'ContextMenu') { event.preventDefault(); actions.hold(); }
  });
}

/** Vertical swipes on either navigation strip share the terminal drawer controls. */
export function tabStripSwipes(element: HTMLElement, context: () => unknown, swipe: (up: boolean) => void) {
  let press: { id: number; x: number; y: number; started: number; context: unknown; axis?: 'vertical' | 'other' } | undefined;
  let suppressClick = false;
  element.addEventListener('pointerdown', event => {
    suppressClick = false; press = undefined;
    if (!event.isPrimary) return;
    const current = context();
    if (event.pointerType === 'mouse' || event.button !== 0 || !current) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, started: performance.now(), context: current };
  }, true);
  element.addEventListener('pointermove', event => {
    if (!press || press.id !== event.pointerId) return;
    const dx = event.clientX - press.x, dy = event.clientY - press.y;
    if (!press.axis && Math.hypot(dx, dy) >= 8) {
      press.axis = performance.now() - press.started < 450 && Math.abs(dy) > Math.abs(dx) * 1.25 ? 'vertical' : 'other';
    }
    if (press.axis === 'vertical') event.preventDefault();
  }, true);
  element.addEventListener('pointerup', event => {
    if (!press || press.id !== event.pointerId) return;
    const current = press; press = undefined;
    if (current.axis !== 'vertical') return;
    event.preventDefault(); suppressClick = true;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (Math.abs(dy) >= 28 && Math.abs(dy) > Math.abs(dx) * 1.25) {
      queueMicrotask(() => { if (context() === current.context) swipe(dy < 0); });
    }
  }, true);
  element.addEventListener('pointercancel', () => { press = undefined; }, true);
  element.addEventListener('click', event => {
    if (suppressClick && event.detail) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
  }, true);
}
