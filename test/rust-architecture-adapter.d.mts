import type { Catalog, Candidate } from '../src/engine/types.ts';
import type { WasmEngine } from '../src/engine/wasm.ts';
export function rustArchitectureAdapter(catalog: Catalog, environment: Record<string, string>, client: boolean, bridge?: typeof WasmEngine): Promise<{
  initializationMs: number;
  directoryInput(text: string): unknown;
  reset(): Promise<void>;
  context(known: string | undefined, paths: boolean): Promise<any>;
  read(key: string, operations: any[], signal?: AbortSignal): Promise<any>;
  directory(directory: string): Promise<any>;
  native(text: string, signal?: AbortSignal): Promise<{ candidates: Candidate[]; elapsedMs: number }>;
  repair(text: string, snapshot: any, signal?: AbortSignal): Promise<Candidate[]>;
  suggest(text: string, snapshot: any, host: any, signal: AbortSignal): Promise<Candidate[]>;
  dispose(): Promise<void>;
}>;
