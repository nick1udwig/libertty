interface Pending<T> {
  finish(value: T): void;
  fallback(): T;
}
export class PendingRequests<T> {
  private requests = new Map<string, Pending<T>>();
  get size() {
    return this.requests.size;
  }
  start(
    id: string,
    fallback: () => T,
    options: { timeout?: number; signal?: AbortSignal; cancel?(): void } = {},
  ): Promise<T> {
    if (this.requests.has(id)) throw new Error('Request ID is already pending.');
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: Pending<T> = {
        fallback,
        finish: (value) => {
          if (this.requests.get(id) !== entry) return;
          this.requests.delete(id);
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          resolve(value);
        },
      };
      const abort = () => {
        entry.finish(fallback());
        options.cancel?.();
      };
      this.requests.set(id, entry);
      if (options.timeout !== undefined) timer = setTimeout(abort, options.timeout);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
  complete(id: string, value: T) {
    this.requests.get(id)?.finish(value);
  }
  cancel(id: string) {
    const entry = this.requests.get(id);
    if (entry) entry.finish(entry.fallback());
  }
  clear() {
    for (const id of this.requests.keys()) this.cancel(id);
  }
}
