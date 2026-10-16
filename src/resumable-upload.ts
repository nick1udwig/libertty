/** One upload attempt: the body is written at `offset`, and the reply names the finished file or the bytes that arrived. */
export type UploadAttempt = (offset: number, body: Blob) => Promise<{ received?: number; name?: string }>;
/** Send a file, continuing after an interruption from the bytes the backend already holds. */
export async function uploadResumable(send: UploadAttempt, file: Blob, signal: AbortSignal, { attempts = 6, delay = 1000 } = {}) {
  let offset = 0, probe = false;
  for (let failures = 0; ;) {
    try {
      // After a failure an empty attempt learns how many bytes the backend holds.
      const reply = await send(probe ? 0 : offset, probe ? new Blob() : file.slice(offset));
      if (reply.name !== undefined) return;
      if (!probe && reply.received === offset) throw new Error('The upload stopped before any bytes arrived.');
      offset = reply.received ?? 0; probe = false;
    } catch (error) {
      signal.throwIfAborted();
      if ((error as { status?: number }).status || ++failures >= attempts) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(8000, delay * 2 ** (failures - 1)));
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      probe = true;
    }
  }
}
