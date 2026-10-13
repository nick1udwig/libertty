import type { Flag } from './types.ts';
export interface Help { flags: Flag[]; subcommands: string[]; required?: number; safeSubcommands?: string[]; probeSubcommands?: string[]; aliases?: Record<string, string>; version?: string }
