import type { CoreRuntime, CoreTerminal } from '@gespenst/core/headless';

export interface ShellSemantics {
  phase: 'prompt' | 'input' | 'output' | 'complete';
  command?: string;
  exitCode?: number;
  error?: string;
}
type Bindings = CoreRuntime['bindings'];
interface NativeTerminal { handle: number; host: { bindings: Bindings } }
interface Callbacks { semantic: number; reset: number; terminals: Map<number, TerminalSemantics> }
const callbacks = new WeakMap<Bindings, Callbacks>();
const modules = new Map<number, WebAssembly.Module>();

/** A typed WASM trampoline permits JavaScript callbacks in Ghostty's function table. */
function trampoline(arity: number, callback: (...args: number[]) => void) {
  let module = modules.get(arity);
  if (!module) {
    const type = [1, 0x60, arity, ...Array(arity).fill(0x7f), 0];
    const body = [0, ...Array.from({ length: arity }, (_, index) => [0x20, index]).flat(), 0x10, 0, 0x0b];
    module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
      1, type.length, ...type, 2, 7, 1, 1, 109, 1, 102, 0, 0, 3, 2, 1, 0,
      7, 5, 1, 1, 102, 0, 1, 10, body.length + 2, 1, body.length, ...body]));
    modules.set(arity, module);
  }
  return new WebAssembly.Instance(module, { m: { f: callback } }).exports.f;
}
function runtimeCallbacks(bindings: Bindings): Callbacks {
  let installed = callbacks.get(bindings);
  if (installed) return installed;
  const terminals = new Map<number, TerminalSemantics>(), table = bindings.exports.__indirect_function_table;
  const semantic = table.grow(2), reset = semantic + 1;
  table.set(semantic, trampoline(3, (_handle, id, event) => terminals.get(id)?.receive(event)));
  table.set(reset, trampoline(2, (_handle, id) => terminals.get(id)?.clear()));
  installed = { semantic, reset, terminals };
  callbacks.set(bindings, installed);
  return installed;
}

/** Observe native shell events without parsing or retaining the terminal byte stream. */
export class TerminalSemantics {
  private current?: Readonly<ShellSemantics>;
  private completed?: Readonly<Omit<ShellSemantics, 'phase'>>;
  private core: CoreTerminal;
  private bindings: Bindings;
  private callbacks: Callbacks;
  constructor(core: CoreTerminal) {
    this.core = core;
    this.bindings = (core as unknown as NativeTerminal).host.bindings;
    this.callbacks = runtimeCallbacks(this.bindings);
    this.callbacks.terminals.set(core.id, this);
    this.attach();
  }
  get state() { return this.current; }
  get lastCommand() { return this.completed; }
  get allowsPrediction() { return this.current?.phase !== 'output' && this.current?.phase !== 'complete'; }
  clear() { this.current = undefined; this.completed = undefined; }
  attach() {
    this.clear();
    const { bindings } = this, handle = (this.core as unknown as NativeTerminal).handle;
    for (const [name, callback] of [['SEMANTIC_PROMPT', this.callbacks.semantic], ['RESET', this.callbacks.reset]] as const)
      bindings.check(bindings.exports.ghostty_terminal_set(handle, bindings.abi.value('GhosttyTerminalOption', name), callback), 'observe shell events');
  }
  receive(pointer: number) {
    const { bindings } = this, { abi } = bindings, view = bindings.memoryView;
    const field = (name: string) => pointer + abi.field('GhosttyTerminalSemanticPrompt', name).offset;
    const kind = view.getInt32(field('kind'), true);
    const is = (name: string) => kind === abi.value('GhosttySemanticPromptKind', name);
    const string = (name: string) => {
      const value = field(name), address = view.getUint32(value + abi.field('GhosttyString', 'ptr').offset, true);
      const length = Math.min(4096, view.getUint32(value + abi.field('GhosttyString', 'len').offset, true));
      return bindings.readString(address, length) || undefined;
    };
    if (is('PROMPT_START')) {
      if (view.getInt32(field('prompt_kind'), true) === abi.value('GhosttySemanticPromptPromptKind', 'PRIMARY')) this.current = { phase: 'prompt' };
    } else if (is('INPUT_START')) this.current = { phase: 'input' };
    else if (is('OUTPUT_START')) this.current = { phase: 'output', command: string('command') };
    else if (is('COMMAND_END')) {
      this.completed = { command: this.current?.command,
        exitCode: view.getUint8(field('has_exit_code')) ? view.getInt32(field('exit_code'), true) : undefined, error: string('error') };
      this.current = { phase: 'complete', ...this.completed };
    }
  }
  dispose() { this.callbacks.terminals.delete(this.core.id); this.clear(); }
}
