import type { ServerMessage } from './protocol.ts';
import { DirectoryCache, DirectoryChanged } from './directory-cache.ts';
import { WasmEngine, type HostProvider } from './engine/wasm.ts';
import engineUrl from './engine/termai-engine.wasm?url';
import type { Candidate } from './protocol.ts';
import { ContextCache, RemoteHost, type FactTransport } from './remote-host.ts';

let context = new ContextCache();
let directories = new DirectoryCache();
const syntaxCache = new Map<string, boolean>();
let engine: Promise<WasmEngine> | undefined;
const rust = () => engine ||= WasmEngine.load(engineUrl);
const active = new Map<number, AbortController>();
self.onmessage = async (event: MessageEvent<{ id: number; text?: string; endpoint?: string; authorization?: string; cancel?: boolean; prompt?: number; reset?: boolean } | Extract<ServerMessage, { type: 'context' }>>) => {
  if ('type' in event.data) {
    context.accept(event.data.context);
    for (const item of event.data.directories) directories.remember(item.path, item.snapshot);
    return;
  }
  if (event.data.reset) {
    for (const controller of active.values()) controller.abort();
    void engine?.then(engine => engine.reset(), () => {});
    syntaxCache.clear();
    context = new ContextCache(); directories = new DirectoryCache(); return;
  }
  const { id, text, endpoint, authorization, cancel, prompt } = event.data;
  if (cancel) { active.get(id)?.abort(); return; }
  if (typeof text !== 'string' || text.length > 2000 || !endpoint) {
    self.postMessage({ id, error: 'Keep a command under 2,000 characters.' }); return;
  }
  // Only one foreground repair can be useful in this terminal.
  for (const controller of active.values()) controller.abort();
  const controller = new AbortController(); active.set(id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
  const transport: FactTransport = async <T>(body: unknown, signal: AbortSignal): Promise<T> => {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}) }, body: JSON.stringify(body), signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Host facts unavailable.');
    return value;
  };
  try {
    const search = async (snapshot: Awaited<ReturnType<ContextCache['get']>>) => {
      const engine = await rust(); signal.throwIfAborted();
      for (let attempt = 0; ; attempt++) {
        const host = new RemoteHost(transport, snapshot, signal, syntaxCache, directories);
        try {
          let changed: DirectoryChanged | undefined;
          const provide: HostProvider = async (callback, abort) => ({ results: await Promise.all(callback.operations.map(async operation => {
            try {
              abort.throwIfAborted();
              let value: unknown;
              switch (operation.kind) {
                case 'stat': value = await host.stat(operation.path as string); break;
                case 'lookup': value = await host.lookup(operation.path as string); break;
                case 'entries': value = await host.entries(operation.path as string, operation.limit as number); break;
                case 'syntax': value = await host.syntax(operation.command as string); break;
                case 'completion': value = await host.complete(operation.words as string[], AbortSignal.any([abort, AbortSignal.timeout(Math.max(0, Math.ceil(operation.timeoutMs as number)))])); break;
                case 'help': value = await host.help(operation.command as string, operation.route as string[]); break;
                case 'describe': value = await host.describe(operation.command as string); break;
                default: throw new Error('Unknown Rust host operation.');
              }
              abort.throwIfAborted(); return { value: value ?? null };
            } catch (error) {
              if (error instanceof DirectoryChanged) changed = error;
              abort.throwIfAborted(); return { error: error instanceof Error ? error.message : 'Host facts unavailable.' };
            }
          })) });
          let candidates: Candidate[];
          try { candidates = await engine.suggest<Candidate[]>(text, snapshot.catalog, { HOME: snapshot.home, HOST_CONTEXT: snapshot.discoveryKey }, provide, signal, snapshot.catalogKey); }
          catch (error) { throw changed || error; }
          if (changed) throw changed;
          await host.verify();
          return candidates;
        } catch (error) { if (!(error instanceof DirectoryChanged) || attempt >= 2) throw error; }
      }
    };
    // The pushed context has command names and history but skips the expensive
    // SSH path scan. Try it first; only collect every path when it cannot help.
    const light = await context.get(transport, signal, false, prompt);
    let candidates = await search(light);
    if (candidates.every(candidate => candidate.literal) && !(await rust()).call('directoryInput', [text], signal)) {
      try {
        const rich = await context.get(transport, AbortSignal.any([signal, AbortSignal.timeout(3000)]), true, prompt);
        candidates = await search(rich);
      } catch (error) { if (signal.aborted) throw error; }
    }
    self.postMessage({ id, candidates });
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ id, error: error instanceof Error ? error.message : 'Repair failed.' });
  } finally { active.delete(id); }
};
