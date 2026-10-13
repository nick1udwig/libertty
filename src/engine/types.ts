export type ValueKind = 'text' | 'path' | 'directory' | 'inputFile' | 'outputPath' | 'choice';
export interface ValueSchema { minimum: number; maximum?: number; kind: ValueKind; choices?: string[] }
export interface Flag { name: string; takesValue: boolean; optionalValue?: boolean; value?: ValueSchema }
export interface Catalog {
  cwd: string; commands: string[]; paths: string[]; history: string[];
  functions?: string[];
  historyCwds?: Record<string, string>;
}
export interface Candidate { command: string; score: number; changes: string[]; literal?: boolean }
