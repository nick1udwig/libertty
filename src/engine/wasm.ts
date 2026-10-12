/** Memory, host callback and cancellation adapter for the Rust engine's JSON interfaces. */
import { immutableDirectoryEntries } from '../directory-data.ts';
import type { DirectoryEntry, DirectoryLookup } from '../directory-data.ts';
interface EngineExports {
  memory: WebAssembly.Memory;
  termai_alloc(length: number): number;
  termai_dispatch(pointer: number): number;
  termai_len(pointer: number): number;
  termai_free(pointer: number): void;
  termai_start(pointer: number): number;
  termai_resume(pointer: number): number;
  termai_cancel(request: number): void;
  termai_reset(): void;
  termai_initialize(): void;
  termai_context(pointer: number): number;
  termai_suggest_prepared(pointer: number): number;
  termai_directories(pointer: number): number;
}
export interface HostRequest { request: number; operations: { kind: string; [field: string]: unknown }[] }
export type HostResult = { value: unknown } | { error: string };
export type HostProvider = (request: HostRequest, signal: AbortSignal) => Promise<unknown[] | { results: HostResult[] }>;
type EngineStep<T> = { request: number } & (
  { state: 'complete'; value: T } | { state: 'error'; error: string } |
  { state: 'pending'; callbacks: HostRequest[] }
);
type DirectoryResult = HostResult | { entries: number } | { lookup: { directory: number; version: string; complete: boolean } };
type HostReply = { request: number; values: unknown[] } | { request: number; results: DirectoryResult[] } | { request: number; error: string };
type DirectoryPins = Map<DirectoryEntry[], { directory: number; entries?: DirectoryEntry[] }>;
export class WasmEngine {
  private exports: EngineExports;
  private constructor(exports: EngineExports) { this.exports = exports; }
  private nextRequest = 0;
  private active = new Map<number, AbortController>();
  private nextContext = 0;
  private prepared?: { catalog: unknown; catalogKey?: string; environment: string; context: number };
  private nextDirectory = 0;
  private directoryIds = new WeakMap<DirectoryEntry[], number>();
  private directories = new Map<number, number>();
  private encoder = new TextEncoder();
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private scratch = new Uint8Array(4096);
  static async load(url: string | URL, signal?: AbortSignal): Promise<WasmEngine> {
    signal?.throwIfAborted();
    const response = await fetch(url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error('Rust engine download failed: ' + response.status);
    const streaming = typeof WebAssembly.instantiateStreaming === 'function' && response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/wasm';
    const { instance } = streaming
      ? await WebAssembly.instantiateStreaming(response, {})
      : await WebAssembly.instantiate(await response.arrayBuffer(), {});
    return WasmEngine.fromInstance(instance, signal);
  }
  static async fromBytes(bytes: BufferSource, signal?: AbortSignal): Promise<WasmEngine> {
    signal?.throwIfAborted();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return WasmEngine.fromInstance(instance, signal);
  }
  private static fromInstance(instance: WebAssembly.Instance, signal?: AbortSignal): WasmEngine {
    const exports = instance.exports;
    if (!(exports.memory instanceof WebAssembly.Memory) ||
        ['termai_alloc', 'termai_dispatch', 'termai_len', 'termai_free', 'termai_start', 'termai_resume', 'termai_cancel', 'termai_reset', 'termai_initialize', 'termai_context', 'termai_suggest_prepared', 'termai_directories'].some(name => typeof exports[name] !== 'function')) {
      throw new Error('Incompatible Rust engine WebAssembly interface.');
    }
    signal?.throwIfAborted();
    (exports as unknown as EngineExports).termai_initialize();
    signal?.throwIfAborted();
    return new WasmEngine(exports as unknown as EngineExports);
  }
  reset() {
    for (const controller of this.active.values()) controller.abort();
    this.exports.termai_reset();
    this.prepared = undefined;
    this.directories.clear();
    this.directoryIds = new WeakMap();
  }
  call<T>(operation: string, args: unknown[], signal?: AbortSignal): T {
    signal?.throwIfAborted();
    const result = this.exchange<{ ok: boolean; value: T; error?: string }>({ operation, args }, 'termai_dispatch');
    signal?.throwIfAborted();
    if (result.ok !== true) throw new Error(result.error || 'Rust engine operation failed.');
    return result.value;
  }
  async invoke<T>(operation: string, args: unknown[], provide: HostProvider, signal?: AbortSignal): Promise<T> {
    return this.run(operation, args, provide, signal);
  }
  /** Catalog keys identify complete immutable snapshots; environment changes are checked separately. */
  async suggest<T>(input: string, catalog: unknown, environment: Record<string, string>, provide: HostProvider, signal?: AbortSignal, catalogKey?: string): Promise<T> {
    signal?.throwIfAborted();
    const encodedEnvironment = JSON.stringify(environment);
    const sameCatalog = this.prepared && (catalogKey === undefined ? this.prepared.catalog === catalog : this.prepared.catalogKey === catalogKey);
    if (!sameCatalog || this.prepared!.environment !== encodedEnvironment) {
      if (this.nextContext >= 0xffffffff) throw new Error('Rust engine context limit reached.');
      const context = ++this.nextContext;
      const reply = this.exchange<{ ok: boolean; error?: string }>({ context, catalog, environment }, 'termai_context');
      if (!reply.ok) throw new Error(reply.error || 'Rust engine context failed.');
      this.prepared = { catalog, catalogKey, environment: encodedEnvironment, context };
    }
    return this.run('suggest', [input], provide, signal, this.prepared!.context);
  }
  private async run<T>(operation: string, args: unknown[], provide: HostProvider, signal?: AbortSignal, context?: number): Promise<T> {
    signal?.throwIfAborted();
    if (this.active.size >= 32 || this.nextRequest >= 0xffffffff) throw new Error('Rust engine request limit reached.');
    const request = ++this.nextRequest;
    const controller = new AbortController();
    this.active.set(request, controller);
    const cancel = () => { controller.abort(signal?.reason); this.exports.termai_cancel(request); };
    signal?.addEventListener('abort', cancel, { once: true });
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      let step = context === undefined
        ? this.exchange<EngineStep<T>>({ request, operation, args, now: performance.now() }, 'termai_start')
        : this.exchange<EngineStep<T>>({ request, input: args[0], context, now: performance.now() }, 'termai_suggest_prepared');
      for (;;) {
        controller.signal.throwIfAborted();
        if (step.request !== request) throw new Error('Rust engine returned a mismatched request.');
        if (step.state === 'complete') return step.value;
        if (step.state === 'error') throw new Error(step.error);
        if (step.state !== 'pending' || !step.callbacks.length) throw new Error('Rust engine made no progress.');
        const replies: HostReply[] = await Promise.race([cancelled, Promise.all(step.callbacks.map(async callback => {
          try {
            const reply = await provide(callback, controller.signal);
            controller.signal.throwIfAborted();
            return Array.isArray(reply) ? { request: callback.request, values: reply } : { request: callback.request, results: reply.results };
          } catch (error) {
            controller.signal.throwIfAborted();
            return { request: callback.request, error: error instanceof Error ? error.message : 'Host callback failed.' };
          }
        }))]);
        controller.signal.throwIfAborted();
        const packed = context === undefined ? { replies } : this.packDirectories(step.callbacks, replies);
        step = this.exchange<EngineStep<T>>({ request, replies: packed.replies, directories: packed.directories, now: performance.now() }, 'termai_resume');
        if (packed.arrays) {
          if (step.state === 'error') { this.directories.clear(); this.directoryIds = new WeakMap(); }
          else this.rememberDirectories(packed.arrays);
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (abort) controller.signal.removeEventListener('abort', abort);
      this.exports.termai_cancel(request);
      this.active.delete(request);
      controller.abort();
    }
  }
  private packDirectories(callbacks: HostRequest[], replies: HostReply[]): { replies: HostReply[]; directories?: { directory: number; entries?: DirectoryEntry[] }[]; arrays?: DirectoryPins } {
    const arrays: DirectoryPins = new Map();
    let count = 0;
    const packed = replies.map((reply, index): HostReply => {
      if ('error' in reply) return reply;
      const results = 'values' in reply ? reply.values.map(value => ({ value: value ?? null })) : reply.results;
      let changed = false;
      const converted = results.map((result, position): DirectoryResult => {
        if (!('value' in result)) return result;
        const kind = callbacks[index].operations[position]?.kind;
        const listing = kind === 'lookup' && result.value && typeof result.value === 'object'
          ? (result.value as DirectoryLookup) : undefined;
        const snapshot = listing?.info === undefined ? listing?.listing : undefined;
        const entries = kind === 'entries' ? result.value : snapshot?.entries;
        if (!Array.isArray(entries) || !immutableDirectoryEntries.has(entries) ||
            (kind === 'lookup' && (!snapshot || typeof snapshot.version !== 'string' || typeof snapshot.complete !== 'boolean'))) return result;
        let pin = arrays.get(entries);
        if (!pin) {
          if (arrays.size >= 32 || count + entries.length > 30000 || this.nextDirectory >= 0xffffffff) return result;
          count += entries.length;
          const known = this.directoryIds.get(entries);
          pin = known !== undefined && this.directories.has(known) ? { directory: known } : { directory: ++this.nextDirectory, entries };
          arrays.set(entries, pin);
        }
        changed = true;
        return kind === 'entries' ? { entries: pin.directory } : { lookup: { directory: pin.directory, version: snapshot!.version, complete: snapshot!.complete } };
      });
      return changed ? { request: reply.request, results: converted } : reply;
    });
    if (!arrays.size) return { replies };
    // Import, pin, and resume in one synchronous exchange after every provider resolves.
    const directories = [...arrays.values()].sort((a, b) => a.directory - b.directory);
    return { replies: packed, directories, arrays };
  }
  private rememberDirectories(arrays: DirectoryPins) {
    for (const [entries, pin] of [...arrays].sort((a, b) => a[1].directory - b[1].directory)) {
      this.directoryIds.set(entries, pin.directory);
      this.directories.delete(pin.directory);
      this.directories.set(pin.directory, entries.length);
    }
    while (this.directories.size > 32 || [...this.directories.values()].reduce((sum, length) => sum + length, 0) > 30000) this.directories.delete(this.directories.keys().next().value!);
  }
  private exchange<T>(request: unknown, method: 'termai_dispatch' | 'termai_start' | 'termai_resume' | 'termai_context' | 'termai_suggest_prepared' | 'termai_directories'): T {
    const text = JSON.stringify(request);
    const limit = 64 * 1024 * 1024;
    if (text.length > limit) throw new Error('Engine request exceeds 64 MiB.');
    const capacity = Math.min(limit, text.length * 3);
    let scratch = this.scratch;
    if (scratch.length < capacity) {
      scratch = new Uint8Array(capacity);
      if (capacity <= 8 * 1024 * 1024) this.scratch = scratch;
    }
    const { read, written } = this.encoder.encodeInto(text, scratch);
    if (read !== text.length) throw new Error('Engine request exceeds 64 MiB.');
    const input = this.exports.termai_alloc(written);
    if (!input) throw new Error('Rust engine allocation limit reached.');
    let output = 0;
    try {
      new Uint8Array(this.exports.memory.buffer, input, written).set(scratch.subarray(0, written));
      output = this.exports[method](input);
      const length = this.exports.termai_len(output);
      if (!output || !length) throw new Error('Rust engine returned an invalid allocation.');
      const result = JSON.parse(this.decoder.decode(new Uint8Array(this.exports.memory.buffer, output, length)));
      return result as T;
    } finally {
      this.exports.termai_free(input);
      if (output) this.exports.termai_free(output);
    }
  }
}
