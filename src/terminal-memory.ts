import type { CoreRuntime } from './terminal-runtime.ts';

export interface TerminalMemory {
  id: number;
  primaryBytes: number;
  alternateBytes: number;
  imageBytes: number;
  compressionSupported: boolean;
}
export interface TerminalMemoryUsage {
  wasmCapacityBytes: number;
  retainedBytes: number;
  terminals: TerminalMemory[];
}

/** On-demand accounting from the terminal handles owned by the Rust bridge. */
export function terminalMemoryUsage(runtime: CoreRuntime): TerminalMemoryUsage {
  const terminals = [...runtime.terminals.values()].map((terminal) => terminal.memoryUsage());
  return {
    wasmCapacityBytes: runtime.exports.memory.buffer.byteLength,
    retainedBytes: terminals.reduce(
      (sum, terminal) =>
        sum + terminal.primaryBytes + terminal.alternateBytes + terminal.imageBytes,
      0,
    ),
    terminals,
  };
}
