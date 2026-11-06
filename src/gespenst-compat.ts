import type { GespenstTerminal } from '@gespenst/core';
import type {
  CoreRuntime,
  CoreTerminal,
  RenderFrame,
  ViewportSnapshot,
} from '@gespenst/core/headless';

/** Private access for the pinned renderer; dependency upgrades must pass the compatibility tests. */
export const gespenstVersion = '0.2.0';
export type Frame = RenderFrame | ViewportSnapshot;
export type ScreenMetrics = {
  width: number;
  height: number;
  cellHeight: number;
  devicePixelRatio: number;
};
export interface LocalBackend {
  terminal: CoreTerminal;
  pointer(input: Parameters<GespenstTerminal['sendPointer']>[0]): void;
  retained: { runtime: CoreRuntime; changed(): void };
  pipeline: { host: { schedule(callback: () => void): void }; scheduleRender(): Promise<void> };
  painter: {
    blinkTimer: ReturnType<typeof setInterval>;
    focused: boolean;
    render(frame: Frame): void | Promise<void>;
    setFocused(focused: boolean): void;
    paint(frame: ViewportSnapshot, damage: ReadonlySet<number>): void;
    resize(metrics: ScreenMetrics): void;
    metrics: ScreenMetrics;
    background: {
      resize(width: number, height: number): void;
      render(
        frame: ViewportSnapshot,
        metrics: ScreenMetrics,
        blinkVisible: boolean,
        focused: boolean,
      ): void;
    };
  };
}

interface LocalView {
  backend: LocalBackend;
  resizeObserver: ResizeObserver;
  layout: { metrics: { devicePixelRatio: number } };
}
interface NativeTerminal {
  handle: number;
  host: { bindings: CoreRuntime['bindings'] };
  themeAlpha?: ReadonlyMap<string, number>;
}
function requireShape(condition: unknown, part: string): asserts condition {
  if (!condition) throw new Error(`Unsupported Gespenst ${gespenstVersion} internals: ${part}.`);
}
export function localBackend(view: GespenstTerminal): LocalBackend {
  const local = view as unknown as LocalView;
  const backend = local.backend;
  requireShape(
    backend?.terminal &&
      backend.retained?.runtime &&
      typeof backend.retained.changed === 'function' &&
      typeof backend.pipeline?.host?.schedule === 'function' &&
      typeof backend.pipeline.scheduleRender === 'function' &&
      typeof backend.pointer === 'function',
    'local backend',
  );
  const painter = backend.painter;
  requireShape(
    painter &&
      typeof painter.render === 'function' &&
      typeof painter.paint === 'function' &&
      typeof painter.resize === 'function' &&
      typeof painter.setFocused === 'function' &&
      typeof painter.background?.render === 'function' &&
      typeof painter.background.resize === 'function' &&
      painter.metrics &&
      painter.blinkTimer !== undefined,
    'painter',
  );
  requireShape(typeof local.resizeObserver?.disconnect === 'function', 'resize observer');
  requireShape(
    Number.isFinite(local.layout?.metrics.devicePixelRatio) &&
      local.layout.metrics.devicePixelRatio > 0,
    'layout',
  );
  terminalABI(backend.terminal);
  return backend;
}
export function controlLocalRenderer(
  view: GespenstTerminal,
  schedule: (callback: () => void) => void,
) {
  const local = view as unknown as LocalView;
  local.resizeObserver.disconnect();
  clearInterval(local.backend.painter.blinkTimer);
  local.backend.pipeline.host.schedule = schedule;
}
export function rendererPixelRatio(view?: GespenstTerminal): number {
  return (view as unknown as LocalView | undefined)?.layout?.metrics.devicePixelRatio ?? 1;
}
export function terminalHasTransparency(core: CoreTerminal): boolean {
  return !!(core as unknown as NativeTerminal).themeAlpha?.size;
}
export function terminalABI(core: CoreTerminal) {
  const native = core as unknown as NativeTerminal;
  requireShape(
    Number.isInteger(native.handle) &&
      native.handle > 0 &&
      native.host?.bindings?.abi &&
      typeof native.host.bindings.exports?.ghostty_terminal_get === 'function' &&
      typeof native.host.bindings.exports.ghostty_terminal_set === 'function',
    'terminal ABI',
  );
  return { handle: native.handle, bindings: native.host.bindings };
}
export function runtimeTerminals(runtime: CoreRuntime): ReadonlyMap<number, CoreTerminal> {
  const terminals = (runtime as unknown as { terminals: ReadonlyMap<number, CoreTerminal> })
    .terminals;
  requireShape(terminals instanceof Map, 'runtime terminals');
  return terminals;
}
