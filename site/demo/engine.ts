import engineURL from 'virtual:libertty-engine';
import type { Candidate } from '../../src/protocol.ts';
import { list, normalize, stat, type Node } from './vfs.ts';

/** The real repair engine, compiled to WebAssembly, answering its filesystem questions from the demo's home directory. */
interface Exports {
  memory: WebAssembly.Memory;
  libertty_initialize(): void;
  libertty_alloc(length: number): number;
  libertty_free(pointer: number, length: number): void;
  libertty_message(pointer: number, length: number, resume: number): number;
  libertty_output_length(): number;
}
type Operation = { kind: string; [field: string]: any };
type Step = { request: number } & ({ state: 'complete'; value: any } | { state: 'error'; error: string } | { state: 'pending'; callbacks: { request: number; operations: Operation[] }[] });
export type Intent = { kind: 'shell' } | { kind: 'reading-file'; phrase: string; operand: string } | { kind: 'reading-pipeline'; phrase: string; command: string };
export interface Prepared { original: string; selected: string; candidates: Candidate[] }
export interface Context { cwd: string; commands: string[]; history: string[] }

const encoder = new TextEncoder(), decoder = new TextDecoder();
let loaded: Promise<Exports> | undefined, next = 0;
function engine() {
  return loaded ||= WebAssembly.instantiateStreaming(fetch(engineURL), {}).then(({ instance }) => {
    const exports = instance.exports as unknown as Exports;
    exports.libertty_initialize();
    return exports;
  });
}
function message(exports: Exports, value: object, resume: boolean): Step {
  const input = encoder.encode(JSON.stringify(value)), pointer = exports.libertty_alloc(input.length);
  new Uint8Array(exports.memory.buffer, pointer, input.length).set(input);
  const output = exports.libertty_message(pointer, input.length, resume ? 1 : 0), length = exports.libertty_output_length();
  const text = decoder.decode(new Uint8Array(exports.memory.buffer, output, length));
  exports.libertty_free(output, length);
  return JSON.parse(text);
}

const info = (node: Node | undefined, executable = false) => node && (!executable || node.directory || node.mode & 0o111)
  ? { file: !node.directory, directory: node.directory, executable: !node.directory && !!(node.mode & 0o111) } : null;
const entries = (path: string, limit = Infinity) => list(path).slice(0, limit).map(name => ({ name, directory: !!stat(path + '/' + name)?.directory, symlink: false }));
function fact(operation: Operation, cwd: string): unknown {
  switch (operation.kind) {
    case 'scoped': return fact(operation.operation, normalize(operation.cwd, cwd));
    case 'stat': return info(stat(normalize(operation.path, cwd)), operation.executable);
    case 'lookup': {
      const path = normalize(operation.path, cwd), node = stat(path);
      return { info: info(node), ...(node?.directory ? { listing: { version: String(node.modified), entries: entries(path), complete: true } } : {}) };
    }
    case 'entries': return entries(normalize(operation.path, cwd), operation.limit);
    case 'syntax': return true;
    case 'completion': return [];
    case 'describe': return null;
    default: throw new Error('Not available in the demo.');
  }
}

async function call<T>(operation: string, args: unknown[], cwd: string): Promise<T> {
  const exports = await engine(), request = ++next;
  let step = message(exports, { request, operation, args, now: performance.now() }, false);
  while (step.state === 'pending') {
    const replies = step.callbacks.map(callback => ({ request: callback.request, results: callback.operations.map(operation => {
      try { return { value: fact(operation, cwd) }; } catch (error) { return { error: (error as Error).message }; }
    }) }));
    step = message(exports, { request, replies, now: performance.now() }, true);
  }
  if (step.state === 'error') throw new Error(step.error);
  return step.value;
}

export function detectIntent(text: string, phrases: string[]): Promise<Intent> { return call('detectIntent', [text, phrases], '/'); }
export function alternatives(text: string, intent: Intent, context: Context): Promise<Prepared> {
  const catalog = { cwd: context.cwd, commands: context.commands, paths: [], history: context.history };
  return call('alternatives', [text, intent, catalog, { HOME: normalize('~'), PWD: context.cwd }], context.cwd);
}
