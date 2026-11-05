import { InlineSuggestions } from '../../src/inline-suggestions.ts';

/** Construct the production controller with inert browser surfaces for lifecycle tests. */
export function createInline(host: any) {
  const node = () => Object.assign(new EventTarget(), {
    hidden: false, checked: false, style: {}, parentElement: { append() {} },
    append() {}, setAttribute() {}, contains() { return false; },
    getBoundingClientRect() { return { width: 0, height: 0 }; },
    querySelectorAll() { return []; }, querySelector() { return undefined; },
  });
  const globals = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  Object.assign(globalThis, {
    document: Object.assign(new EventTarget(), {getElementById: node, createElement: node}),
    window: {}, ResizeObserver: class { observe() {} },
  });
  try {
    const term: any = { onCursorMove() {}, onScroll() {}, focus() {}, buffer: { active: { cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0 } } };
    const inline = new InlineSuggestions(term, host);
    Object.assign(inline, { render() {}, armInput() {}, pendingPresentation: undefined });
    return inline as any;
  } finally {
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) Reflect.deleteProperty(globalThis, key);
      else Reflect.set(globalThis, key, value);
    }
  }
}
