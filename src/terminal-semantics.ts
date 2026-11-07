import type { CoreTerminal, Disposable, SemanticEvent } from './terminal-runtime.ts';
export interface ShellSemantics {
  phase: 'prompt' | 'input' | 'output' | 'complete';
  command?: string;
  exitCode?: number;
  error?: string;
}
/** Shell events are copied by Rust before the parser returns to JavaScript. */
export class TerminalSemantics {
  private current?: Readonly<ShellSemantics>;
  private completed?: Readonly<Omit<ShellSemantics, 'phase'>>;
  private subscriptions: Disposable[];
  constructor(core: CoreTerminal) {
    this.subscriptions = [
      core.on('semantic', (event) => this.receive(event)),
      core.on('reset', () => this.clear()),
    ];
  }
  get state() {
    return this.current;
  }
  get lastCommand() {
    return this.completed;
  }
  get allowsPrediction() {
    return this.current?.phase !== 'output' && this.current?.phase !== 'complete';
  }
  clear() {
    this.current = undefined;
    this.completed = undefined;
  }
  attach() {
    this.clear();
  }
  private receive(event: SemanticEvent) {
    if (event.kind === 1 && event.promptKind === 0) this.current = { phase: 'prompt' };
    else if (event.kind === 2) this.current = { phase: 'input' };
    else if (event.kind === 3)
      this.current = { phase: 'output', command: event.command || undefined };
    else if (event.kind === 4) {
      this.completed = {
        command: this.current?.command,
        exitCode: event.exitCode ?? undefined,
        error: event.error || undefined,
      };
      this.current = { phase: 'complete', ...this.completed };
    }
  }
  dispose() {
    for (const item of this.subscriptions) item.dispose();
    this.subscriptions = [];
    this.clear();
  }
}
