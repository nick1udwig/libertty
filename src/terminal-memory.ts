import type { CoreRuntime, CoreTerminal } from '@gespenst/core/headless';

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

/** On-demand accounting through the pinned Gespenst runtime and Ghostty ABI. */
export function terminalMemoryUsage(runtime: CoreRuntime): TerminalMemoryUsage {
  const { bindings } = runtime, { abi } = bindings;
  const terminals = (runtime as unknown as { terminals: ReadonlyMap<number, CoreTerminal> }).terminals;
  const usage = bindings.allocType('GhosttyTerminalMemoryUsage', true);
  const result: TerminalMemory[] = [];
  try {
    for (const terminal of terminals.values()) {
      const handle = (terminal as unknown as { handle: number }).handle;
      bindings.check(bindings.exports.ghostty_terminal_get(handle, abi.value('GhosttyTerminalData', 'MEMORY_USAGE'), usage.pointer), 'read terminal memory');
      const bytes = (name: string) => Number(usage.view.getBigUint64(abi.field('GhosttyTerminalMemoryUsage', name).offset, true));
      result.push({ id: terminal.id, primaryBytes: bytes('primary_resident_bytes'), alternateBytes: bytes('alternate_resident_bytes'),
        imageBytes: bytes('primary_image_bytes') + bytes('alternate_image_bytes'),
        compressionSupported: !!usage.view.getUint8(abi.field('GhosttyTerminalMemoryUsage', 'compression_supported').offset) });
    }
  } finally { usage.free(); }
  return { wasmCapacityBytes: bindings.exports.memory.buffer.byteLength,
    retainedBytes: result.reduce((sum, terminal) => sum + terminal.primaryBytes + terminal.alternateBytes + terminal.imageBytes, 0), terminals: result };
}
