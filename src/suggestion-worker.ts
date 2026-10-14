import { requestJSON } from './api.ts';
import type { Candidate } from './protocol.ts';

// Interpretation and dependent facts stay together on the backend.
// The Wasm engine remains available to tools and parity tests without adding RPC waves to dictation.
const active = new Map<number, AbortController>();
self.onmessage = async (event: MessageEvent<{ id: number; text?: string; endpoint?: string; authorization?: string; cancel?: boolean; prompt?: number; reset?: boolean; type?: string }>) => {
  const { id, text, endpoint, authorization, cancel, prompt, reset, type } = event.data;
  if (type) return;
  if (reset) { for (const controller of active.values()) controller.abort(); return; }
  if (cancel) { active.get(id)?.abort(); return; }
  if (typeof text !== 'string' || text.length > 2000 || !endpoint) {
    self.postMessage({ id, error: 'Keep a command under 2,000 characters.' }); return;
  }
  for (const controller of active.values()) controller.abort();
  const controller = new AbortController(); active.set(id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
  try {
    const result = await requestJSON<Candidate[]>(new URL(endpoint), { kind: 'repair', text, prompt }, { token: authorization, signal });
    signal.throwIfAborted();
    self.postMessage({ id, candidates: result as Candidate[] });
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ id, error: error instanceof Error ? error.message : 'Repair failed.' });
  } finally { active.delete(id); }
};
