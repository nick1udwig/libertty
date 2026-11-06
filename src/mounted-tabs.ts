import type { PluginView } from './plugins.ts';

interface MountedTab {
  controller: AbortController;
  mounting?: Promise<void>;
  view?: PluginView;
}

export class MountedTabs {
  private entries = new Map<string, MountedTab>();
  private mounted = new Map<string, PluginView>();
  readonly views: ReadonlyMap<string, PluginView> = this.mounted;

  frame(id: string) {
    const terminal = this.mounted.get(id)?.terminal;
    return terminal?.retain ? terminal.frame : undefined;
  }

  *frames(): IterableIterator<[string, HTMLIFrameElement]> {
    for (const id of this.mounted.keys()) {
      const frame = this.frame(id);
      if (frame) yield [id, frame];
    }
  }

  mount(
    id: string,
    create: (signal: AbortSignal) => Promise<PluginView>,
    active: () => boolean,
    attach: (view: PluginView) => void,
  ): Promise<void> {
    const existing = this.entries.get(id);
    if (existing) return existing.mounting || Promise.resolve();
    const entry: MountedTab = { controller: new AbortController() };
    this.entries.set(id, entry);
    const signal = entry.controller.signal;
    const work = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return create(signal);
      })
      .then((view) => {
        if (signal.aborted || !active()) {
          view.dispose();
          return;
        }
        entry.view = view;
        this.mounted.set(id, view);
        attach(view);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        this.unmount(id);
        throw error;
      })
      .finally(() => {
        entry.mounting = undefined;
        if (!entry.view && this.entries.get(id) === entry) this.entries.delete(id);
      });
    entry.mounting = work;
    return work;
  }

  unmount(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.mounted.delete(id);
    entry.controller.abort();
    entry.view?.navigation?.element.remove();
    entry.view?.dispose();
  }
}
