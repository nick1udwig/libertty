import type { Flag } from './types.ts';

export interface CommandMetadata {
  flags: Record<string, Flag[]>; subcommands: Record<string, string[]>; requiredPositionals?: Record<string, number>;
  /** Request-local operand names, keyed by the preceding argument vector. */
  argumentValues?: Record<string, string[]>;
}
