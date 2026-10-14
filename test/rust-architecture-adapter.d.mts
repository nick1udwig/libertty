import type { Catalog, Candidate } from '../src/engine/types.ts';
export function rustArchitectureAdapter(catalog: Catalog, environment: Record<string, string>): Promise<{
  initializationMs: number;
  reset(): Promise<void>;
  native(text: string, signal?: AbortSignal): Promise<{ candidates: Candidate[]; elapsedMs: number }>;
  dispose(): Promise<void>;
}>;
