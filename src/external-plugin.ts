import { mergeFileSnapshot, packFileSnapshot, type FileSnapshot } from './plugin-file.ts';
import type { HostProfile, TerminalTab } from './connections.ts';
import type { PluginView, TabPlugin } from './plugins.ts';
import { pluginRequest, type PluginPackage } from './plugin-package.ts';

// The opaque frame receives only a private port, a display name and its own state.
const sdk = `const mergeFileSnapshot = ${mergeFileSnapshot.toString()};` + String.raw`
(() => {
  let port, next = 0, context, visible = false;
  const pending = new Map(), listeners = new Set(); let file;
  let ready; const readyPromise = new Promise(resolve => ready = resolve);
  window.libertty = Object.freeze({
    ready: readyPromise,
    get visible() { return visible; },
    onVisibility(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async request(method, params) {
      await readyPromise;
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Plugin request timed out.')); }, 15000);
        pending.set(id, { resolve, reject, timer, method }); port.postMessage({ id, method, params });
      });
    }
  });
  window.addEventListener('message', event => {
    if (port || event.source !== parent || event.data?.type !== 'libertty-plugin-init' || !event.ports[0]) return;
    port = event.ports[0]; context = event.data.context;
    port.onmessage = ({ data }) => {
      if (data.type === 'visibility') { visible = data.visible === true; for (const fn of listeners) fn(visible); return; }
      const request = pending.get(data.id); if (!request) return;
      pending.delete(data.id); clearTimeout(request.timer);
      if (data.error) request.reject(new Error(data.error)); else { try { const result = request.method === 'file.read' ? (file = mergeFileSnapshot(file, data.result)) : data.result; request.resolve(result); } catch (error) { request.reject(error); } }
    };
    port.start(); ready(Object.freeze(context));
  });
})();
`;
export interface ExternalServices {
  connect(host: HostProfile, plugin: PluginPackage): Promise<void>;
  close(tab: TerminalTab): Promise<void>;
  read(tab: TerminalTab): Promise<FileSnapshot>;
  store(): void;
}
export function externalPlugin(pkg: PluginPackage, s: ExternalServices): TabPlugin {
  const m = pkg.manifest;
  return { id: m.id, version: m.version, name: m.name, connectLabel: m.connectLabel, icon: m.icon || '◇', panelPrefix: 'plugin-', available: host => host.kind !== 'herdr',
    connect: host => s.connect(host, pkg), close: async tab => { await s.close(tab); return true; }, mount: async tab => externalView(pkg, tab, s) };
}
function externalView(pkg: PluginPackage, tab: TerminalTab, s: ExternalServices): PluginView {
  const frame = document.createElement('iframe'); frame.id = 'plugin-' + tab.id; frame.title = pkg.manifest.name + ' · ' + tab.name;
  frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";
  frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="' + policy + '"><script>' + sdk + '</script>' + pkg.view;
  const channel = new MessageChannel(); let disposed = false, initialized = false, visible = false, active = 0;
  let file: FileSnapshot | undefined; let reads: Promise<unknown> = Promise.resolve();
  channel.port1.onmessage = async ({ data }) => {
    if (disposed || !initialized || !data || !Number.isSafeInteger(data.id) || data.id < 1) return;
    if (active >= 4) { channel.port1.postMessage({ id: data.id, error: 'Too many pending plugin requests.' }); return; }
    active++;
    try {
      const read = () => {
        const work = reads.then(async () => { const value = await s.read(tab); const packed = packFileSnapshot(file, value); file = value; return packed as FileSnapshot; });
        reads = work.catch(() => {}); return work;
      };
      const result = await pluginRequest(data.method, data.params, { read, save: state => { if (!disposed) { tab.pluginState = state; s.store(); } } });
      if (!disposed) channel.port1.postMessage({ id: data.id, result });
    } catch (error: any) { if (!disposed) channel.port1.postMessage({ id: data.id, error: error.message || 'Plugin request failed.' }); }
    finally { active--; }
  };
  frame.onload = () => {
    // A plugin navigating its frame does not receive another capability port.
    if (disposed || initialized) return; initialized = true;
    frame.contentWindow?.postMessage({ type: 'libertty-plugin-init', context: { name: tab.name, state: tab.pluginState ?? null } }, '*', [channel.port2]);
    channel.port1.postMessage({ type: 'visibility', visible });
  };
  return { element: frame, setVisible(value) { frame.hidden = !value; if (visible === value) return; visible = value; if (initialized && !disposed) channel.port1.postMessage({ type: 'visibility', visible }); },
    dispose() { disposed = true; frame.onload = null; channel.port1.close(); channel.port2.close(); frame.remove(); } };
}
