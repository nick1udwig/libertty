import { abortableDelay } from './abortable-delay.ts';

/** Fetch a download ticket's bytes, resuming with a range request after an interruption or a stall. */
export interface ResumableOptions {
  size: number;
  signal: AbortSignal;
  progress(received: number): void;
  /** Abandon an attempt that delivers nothing for this long, since a dead link may never report an error. */
  stall?: number;
  attempts?: number;
  /** The first pause between attempts, which doubles up to eight seconds. */
  delay?: number;
}
const flushBytes = 8 << 20;
class Final extends Error {}
export async function fetchResumable(url: URL, { size, signal, progress, stall = 20000, attempts = 6, delay = 1000 }: ResumableOptions): Promise<Blob> {
  // Bytes move into Blob parts as they arrive, so the browser can spool large files instead of holding a chunk array.
  const parts: Blob[] = [];
  let chunks: Uint8Array[] = [], buffered = 0, received = 0;
  const flush = () => { if (chunks.length) parts.push(new Blob(chunks as BlobPart[])); chunks = []; buffered = 0; };
  for (let attempt = 1; ; attempt++) {
    const quiet = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => { clearTimeout(timer); timer = setTimeout(() => quiet.abort(new DOMException('Download stalled.', 'TimeoutError')), stall); };
    try {
      watch();
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([signal, quiet.signal]), ...(received ? { headers: { Range: `bytes=${received}-` } } : {}) });
      if (received && response.status === 200) { parts.length = 0; chunks = []; buffered = 0; received = 0; }
      else if (response.status !== (received ? 206 : 200)) {
        await response.body?.cancel();
        throw new Final(response.status === 409 ? 'The file changed during the download. Download it again.' : 'Download failed. Try downloading the file again.');
      }
      const reader = response.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        watch();
        if (done) break;
        chunks.push(value); buffered += value.length; received += value.length; progress(received);
        if (buffered >= flushBytes) flush();
      }
      clearTimeout(timer);
      if (received < size) throw new Error('Download ended early.');
      flush();
      return new Blob(parts);
    } catch (error) {
      clearTimeout(timer);
      signal.throwIfAborted();
      if (error instanceof Final) throw error;
      if (attempt >= attempts) throw new Error('Download interrupted. Check your connection and try again.');
      await abortableDelay(Math.min(8000, delay * 2 ** (attempt - 1)), signal);
    }
  }
}
