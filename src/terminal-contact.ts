export interface TerminalContact {
  x: number;
  y: number;
  at: number;
  pointerType: string;
  button: number;
}

interface Handlers {
  accepts?(target: EventTarget | null): boolean;
  down(contact: TerminalContact): boolean;
  move(contact: TerminalContact): void;
  up(contact: TerminalContact): void;
  cancel(): void;
}

const stop = (event: Event) => {
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
};

/** Feed one gesture from either event stream. A browser can cancel pointer
 * capture while continuing to deliver touches to their original target. */
export function terminalContact(element: HTMLElement, handlers: Handlers) {
  let active: { source: 'pointer' | 'touch'; id: number; pointerType: string } | undefined;
  let blocked = false;
  const accepts = (target: EventTarget | null) => handlers.accepts?.(target) ?? true;
  const pointer = (event: PointerEvent): TerminalContact => ({
    x: event.clientX,
    y: event.clientY,
    at: event.timeStamp,
    pointerType: event.pointerType,
    button: event.button,
  });
  const touch = (event: TouchEvent, point: Touch): TerminalContact => ({
    x: point.clientX,
    y: point.clientY,
    at: event.timeStamp,
    pointerType: 'touch',
    button: 0,
  });
  const cancel = () => {
    if (active) {
      active = undefined;
      handlers.cancel();
    }
  };
  element.addEventListener(
    'pointerdown',
    (event) => {
      if (!accepts(event.target)) return;
      if (
        event.pointerType === 'touch' &&
        (blocked || (active?.source === 'touch' && event.isPrimary))
      ) {
        stop(event);
        return;
      }
      if (!event.isPrimary) {
        stop(event);
        cancel();
        return;
      }
      if (!handlers.down(pointer(event))) return;
      stop(event);
      active = { source: 'pointer', id: event.pointerId, pointerType: event.pointerType };
      if (event.isTrusted) {
        // Legacy touch events retain their target even when capture is unavailable.
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          /* Browser already cancelled the pointer. */
        }
      }
    },
    { capture: true },
  );
  element.addEventListener(
    'pointermove',
    (event) => {
      if (active?.source === 'touch' && event.pointerType === 'touch') {
        stop(event);
        return;
      }
      if (active?.source !== 'pointer' || event.pointerId !== active.id) return;
      stop(event);
      handlers.move(pointer(event));
    },
    { capture: true },
  );
  element.addEventListener(
    'pointerup',
    (event) => {
      if (active?.source === 'touch' && event.pointerType === 'touch') {
        stop(event);
        return;
      }
      if (active?.source !== 'pointer' || event.pointerId !== active.id) return;
      stop(event);
      active = undefined;
      handlers.up(pointer(event));
    },
    { capture: true },
  );
  const pointerCancel = (event: PointerEvent) => {
    if (active?.source === 'touch' && event.pointerType === 'touch') {
      stop(event);
      return;
    }
    if (active?.source !== 'pointer' || event.pointerId !== active.id) return;
    stop(event);
    cancel();
  };
  element.addEventListener('pointercancel', pointerCancel, { capture: true });
  element.addEventListener('lostpointercapture', pointerCancel, { capture: true });
  element.addEventListener(
    'touchstart',
    (event) => {
      if (!accepts(event.target)) return;
      stop(event);
      if (event.touches.length !== 1 || blocked) {
        blocked = true;
        cancel();
        return;
      }
      const point = event.touches[0];
      // Adopt the pointer's press without restarting its hold timer or selecting
      // twice. Touch now owns movement and release, including after pointercancel.
      if (active?.source === 'pointer' && active.pointerType === 'touch') {
        active = { source: 'touch', id: point.identifier, pointerType: 'touch' };
        return;
      }
      if (active?.source === 'touch' && active.id === point.identifier) return;
      if (handlers.down(touch(event, point)))
        active = { source: 'touch', id: point.identifier, pointerType: 'touch' };
    },
    { passive: false, capture: true },
  );
  element.addEventListener(
    'touchmove',
    (event) => {
      if (!accepts(event.target) && active?.source !== 'touch') return;
      stop(event);
      if (active?.source !== 'touch') return;
      const point = Array.from(event.touches).find((point) => point.identifier === active!.id);
      if (point) handlers.move(touch(event, point));
    },
    { passive: false, capture: true },
  );
  element.addEventListener(
    'touchend',
    (event) => {
      if (!accepts(event.target) && active?.source !== 'touch') return;
      stop(event);
      if (!event.touches.length) blocked = false;
      if (active?.source !== 'touch') return;
      const point = Array.from(event.changedTouches).find(
        (point) => point.identifier === active!.id,
      );
      if (point) {
        active = undefined;
        handlers.up(touch(event, point));
      }
    },
    { passive: false, capture: true },
  );
  element.addEventListener(
    'touchcancel',
    (event) => {
      if (!accepts(event.target) && active?.source !== 'touch') return;
      stop(event);
      if (!event.touches.length) blocked = false;
      cancel();
    },
    { passive: false, capture: true },
  );
}
