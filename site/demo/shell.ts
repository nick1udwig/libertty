import type { ShellState } from '../../src/protocol.ts';
import { readingPipeline, readingRequest } from '../../src/reading-request.ts';
import { commandNames, run, type Program } from './commands.ts';
import { flow } from './programs.ts';
import { alternatives, detectIntent, type Intent } from './engine.ts';
import { listen, type Listening } from './speech.ts';
import { display, list, normalize, repo, stat } from './vfs.ts';

/** A browser terminal attachment, speaking the backend's JSON terminal protocol. */
export interface Peer { send(message: object): void; close(code?: number, reason?: string): void }
const keys = /\x1b\[200~[\s\S]*?\x1b\[201~|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[@-~]|\x1b[\s\S]?|[\s\S]/g;
const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
export const captures = new Map<string, { name: string; data: string; exitCode: number }>();

export class Shell {
  readonly stream = hex(16);
  cwd = repo; previous = repo; cols = 48; rows = 40;
  private seq = 0; private first = 1; private log: { seq: number; data: string }[] = [];
  private peer?: Peer;
  private state: ShellState = { cwd: repo, inputRevision: 0, promptRevision: 0, ready: false, prompt: 0, exited: false };
  private line = ''; private cursor = 0; private row = 0;
  history = ['git log --oneline', 'cat Cargo.toml', 'vi README.md', 'look at README.md', 'cd docs && ls'];
  private recall = -1; private draft = '';
  private program?: Program;
  private dictation?: { id: string; listening: Listening; prompt: number; revision: number; target: string; phrases: string[] };
  private repairs = new Set<string>();

  private greeted = false;
  // The welcome waits for the terminal's first size, so it wraps to the screen it appears on.
  private greet() {
    this.greeted = true;
    const green = (text: string) => `\x1b[32m${text.replaceAll(' ', '\u00a0')}\x1b[0m`;
    this.write(flow(`\x1b[1mWelcome to the libertty demo.\x1b[0m
This shell runs in your browser on a copy of the libertty repository.

Try ${green('ls')}, ${green('vi README.md')} or ${green('look at README.md')}. Tap the mic and say a command, or type ${green('help')}.

\x1b[2mDictation here runs a small speech model in your browser, so it is slow and less accurate. The real app transcribes on your computer running libertty, with a larger model that is far faster and more accurate.\x1b[0m

`, this.cols).replace(/\n/g, '\r\n'));
    this.prompt();
  }
  get current() { return { ...this.state, cwd: this.cwd }; }
  write(data: string) {
    const seq = ++this.seq; this.log.push({ seq, data });
    if (this.log.length > 4000) this.first = this.log.shift()!.seq + 1;
    this.peer?.send({ type: 'output', seq, data });
  }
  private sendState() { this.state.cwd = this.cwd; this.peer?.send({ type: 'state', state: this.current }); }

  attach(peer: Peer, after: number, stream: string | null) {
    this.peer?.close(4001, 'This shell was opened in another tab.');
    this.peer = peer;
    const reset = stream !== this.stream || after > this.seq;
    const from = reset ? 0 : after;
    peer.send({ type: 'hello', engine: 'server', reset, truncated: from + 1 < this.first, firstSeq: this.first, lastSeq: this.seq, streamId: this.stream });
    peer.send({ type: 'state', state: this.current });
    for (const item of this.log) if (item.seq > from) peer.send({ type: 'output', ...item });
  }
  detach(peer: Peer) { if (this.peer === peer) { this.peer = undefined; this.dictation?.listening.cancel(); this.dictation = undefined; } }

  message(message: any) {
    switch (message.type) {
      case 'ping': this.peer?.send({ type: 'pong' }); return;
      case 'resize': this.cols = Math.max(10, message.cols); this.rows = Math.max(4, message.rows); if (!this.greeted) this.greet(); this.program?.resize(); return;
      case 'input': this.state.inputRevision++; this.input(message.data); return;
      case 'paste': this.insert(message.text); return;
      case 'replace': return this.replace(message);
      case 'command': return this.command(message);
      case 'input-line': this.peer?.send({ type: 'input-line', id: message.id, prompt: this.state.prompt, revision: this.state.inputRevision, ...(this.state.ready ? { text: this.line, cursor: this.cursor } : {}) }); return;
      case 'repair': void this.repair(message.id, message.text, message.intent || { kind: 'shell' }, message.prompt, message.revision, false); return;
      case 'repair-cancel': this.repairs.delete(message.id); return;
      case 'dictation': return this.dictate(message);
    }
  }

  // Line editing follows Readline's defaults for the keys the app's shortcut bar sends.
  private input(data: string) {
    if (this.program) { this.program.input(data); return; }
    if (!this.state.ready) return;
    for (const key of data.match(keys) || []) {
      if (key.startsWith('\x1b[200~')) this.insert(key.slice(6, -6).replace(/[\r\n]+/g, ' '));
      else if (key === '\r' || key === '\n') { void this.submit(); return; }
      else if (key === '\x7f' || key === '\b') { if (this.cursor) { this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor); this.cursor--; this.render(); } }
      else if (key === '\x1b[3~' || key === '\x04') { if (this.cursor < this.line.length) { this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1); this.render(); } }
      else if (key === '\x1b[D' || key === '\x02') { if (this.cursor) { this.cursor--; this.render(); } }
      else if (key === '\x1b[C' || key === '\x06') { if (this.cursor < this.line.length) { this.cursor++; this.render(); } }
      else if (['\x01', '\x1b[H', '\x1b[1~', '\x1bOH'].includes(key)) { this.cursor = 0; this.render(); }
      else if (['\x05', '\x1b[F', '\x1b[4~', '\x1bOF'].includes(key)) { this.cursor = this.line.length; this.render(); }
      else if (key === '\x1b[A' || key === '\x10') this.browse(1);
      else if (key === '\x1b[B' || key === '\x0e') this.browse(-1);
      else if (key === '\x15') { this.line = this.line.slice(this.cursor); this.cursor = 0; this.render(); }
      else if (key === '\x0b') { this.line = this.line.slice(0, this.cursor); this.render(); }
      else if (key === '\x17') { const start = this.line.slice(0, this.cursor).replace(/\S+\s*$/, '').length; this.line = this.line.slice(0, start) + this.line.slice(this.cursor); this.cursor = start; this.render(); }
      else if (key === '\x03') { this.end(); this.write('^C\r\n'); this.prompt(); return; }
      else if (key === '\x0c') { this.write('\x1b[H\x1b[2J'); this.row = 0; this.render(true); }
      else if (key === '\t') this.complete();
      else if (key >= ' ' && !key.startsWith('\x1b')) this.insert(key);
    }
  }
  private insert(text: string) {
    if (this.program) { this.program.paste(text); return; }
    this.line = this.line.slice(0, this.cursor) + text + this.line.slice(this.cursor); this.cursor += text.length;
    this.render();
  }
  private browse(direction: number) {
    if (this.recall === -1) this.draft = this.line;
    const index = Math.max(-1, Math.min(this.history.length - 1, this.recall + direction));
    if (index === this.recall) return;
    this.recall = index; this.line = index === -1 ? this.draft : this.history[this.history.length - 1 - index]; this.cursor = this.line.length; this.render();
  }
  private complete() {
    const before = this.line.slice(0, this.cursor), word = before.match(/\S*$/)![0], first = !before.slice(0, -word.length || undefined).trim();
    const slash = word.lastIndexOf('/'), directory = normalize(word.slice(0, slash + 1) || '.', this.cwd), stem = word.slice(slash + 1);
    const names = first && slash < 0 ? commandNames.filter(name => name.startsWith(stem))
      : list(directory).filter(name => name.startsWith(stem) && (stem.startsWith('.') || !name.startsWith('.'))).map(name => name + (stat(directory + '/' + name)?.directory ? '/' : ''));
    if (!names.length) return;
    let shared = names[0];
    for (const name of names) while (!name.startsWith(shared)) shared = shared.slice(0, -1);
    if (shared.length > stem.length) this.insert(shared.slice(stem.length) + (names.length === 1 && !shared.endsWith('/') ? ' ' : ''));
    else if (names.length > 1) { this.end(); this.write('\r\n' + names.join('  ') + '\r\n'); this.row = 0; this.render(true); }
  }
  private get promptText() { return `\x1b[32m${display(this.cwd)}\x1b[0m $ `; }
  private get promptWidth() { return display(this.cwd).length + 3; }
  /** Redraw the prompt line from its start, then place the cursor, accounting for soft wraps. */
  private render(fresh = false) {
    const total = this.promptWidth + this.line.length, target = this.promptWidth + this.cursor;
    let out = fresh ? '' : (this.row ? `\x1b[${this.row}A` : '') + '\r';
    out += this.promptText + this.line + '\x1b[J';
    if (total && total % this.cols === 0) out += ' \b';
    const end = Math.floor(total / this.cols), row = Math.floor(target / this.cols), column = target % this.cols;
    out += '\r' + (end > row ? `\x1b[${end - row}A` : '') + (column ? `\x1b[${column}C` : '');
    this.row = row; this.write(out);
  }
  private end() { const end = Math.floor((this.promptWidth + this.line.length) / this.cols); if (end > this.row) this.write(`\x1b[${end - this.row}B`); this.row = 0; }
  private prompt() {
    this.line = ''; this.cursor = 0; this.row = 0; this.recall = -1;
    this.state.prompt++; this.state.promptRevision = this.state.inputRevision; this.state.ready = true; this.state.inputTarget = 'shell';
    this.sendState(); this.render(true);
  }
  private async submit() {
    const command = this.line.trim();
    this.end(); this.write('\r\n');
    this.state.ready = false; this.state.inputTarget = undefined; this.sendState();
    if (command && this.history.at(-1) !== command) this.history.push(command);
    if (command) await this.execute(command);
    if (!this.program) this.prompt();
  }
  private async execute(command: string) {
    const reading = readingRequest(command, ['look at']), pipeline = readingPipeline(command, ['look at']);
    if (reading && !pipeline) {
      const path = normalize(reading.path, this.cwd), node = stat(path);
      if (!node) this.write(`look at: ${reading.path}: No such file or directory\r\n`);
      else if (node.directory) this.write(`look at: ${reading.path}: Is a directory\r\n`);
      else this.peer?.send({ type: 'reading-file', path });
      return;
    }
    const output: string[] = [];
    const result = await run(pipeline ? pipeline.command : command, {
      shell: this, write: pipeline ? data => output.push(data.replace(/\x1b\[[0-9;]*m/g, '')) : data => this.write(data),
      start: program => { this.program = program; this.state.inputTarget = 'program'; this.sendState(); program.start(); },
    });
    if (pipeline) {
      const id = hex(16); captures.set(id, { name: pipeline.command, data: output.join('').replace(/\r\n/g, '\n'), exitCode: result });
      this.peer?.send({ type: 'reading-capture', id, name: pipeline.command, exitCode: result });
    }
  }
  /** Full-screen programs hand the terminal back here when they exit. */
  finished() { this.program = undefined; this.prompt(); }
  busy(program: Program) { return this.program === program; }

  private replace(message: { id: string; text: string; prompt: number; revision: number }) {
    const accepted = this.state.ready && message.prompt === this.state.prompt && message.revision === this.state.inputRevision;
    if (accepted) { this.state.inputRevision++; this.line = message.text; this.cursor = this.line.length; this.render(); }
    this.peer?.send({ type: 'edit-result', id: message.id, accepted, revision: this.state.inputRevision });
  }
  private command(message: { id: string; command: string; prompt: number }) {
    const accepted = this.state.ready && message.prompt === this.state.prompt;
    this.peer?.send({ type: 'result', id: message.id, accepted, ...(accepted ? {} : { message: 'The prompt changed before the command was sent.' }) });
    if (!accepted) return;
    this.line = message.command; this.cursor = this.line.length; this.render(); void this.submit();
  }
  private async repair(id: string, text: string, intent: Intent, prompt: number, revision: number, dictated: boolean) {
    const current = () => this.state.ready && this.state.prompt === prompt && this.state.inputRevision === revision;
    const reply = { id, prompt, revision, accepted: false, original: text, selected: text, candidates: [] as unknown[], ...(dictated ? { source: 'dictation' } : {}) };
    if (!current()) { this.peer?.send({ ...reply, type: 'repair-result', revision: this.state.inputRevision, prompt: this.state.prompt }); return; }
    this.repairs.add(id);
    let error: string | undefined;
    try { Object.assign(reply, await alternatives(text, intent, { cwd: this.cwd, commands: commandNames, history: this.history })); }
    catch (failure) { error = (failure as Error).message; }
    reply.accepted = this.repairs.delete(id) && current() && !error;
    if (reply.accepted) { this.state.inputRevision++; this.line = reply.selected; this.cursor = this.line.length; this.render(); }
    this.peer?.send({ ...reply, type: 'repair-result', revision: this.state.inputRevision, ...(error ? { error } : {}) });
  }
  private async dictate(message: { id: string; action: string; prompt?: number; revision?: number; target?: string; readingPhrases?: string[] }) {
    if (message.action === 'start') {
      this.dictation?.listening.cancel();
      this.dictation = { id: message.id, listening: listen(), prompt: message.prompt ?? this.state.prompt, revision: message.revision ?? this.state.inputRevision, target: message.target || 'shell', phrases: message.readingPhrases || ['look at'] };
      this.peer?.send({ type: 'dictation', id: message.id, state: 'ready' });
      return;
    }
    const dictation = this.dictation;
    if (!dictation || dictation.id !== message.id) return;
    this.dictation = undefined;
    if (message.action === 'cancel') { dictation.listening.cancel(); return; }
    let text: string;
    try { text = (await dictation.listening.finish()).replace(/[\x00-\x1f\x7f]/g, ''); }
    catch (error) { this.peer?.send({ type: 'dictation', id: dictation.id, state: 'error', message: (error as Error).message }); return; }
    const target = this.state.ready ? 'shell' : this.program ? 'program' : undefined;
    if (text && (target !== dictation.target || this.state.inputRevision !== dictation.revision || (target === 'shell' && this.state.prompt !== dictation.prompt))) {
      this.peer?.send({ type: 'dictation', id: dictation.id, state: 'error', message: 'The terminal changed during dictation. No text was inserted.' });
      return;
    }
    if (text) {
      const empty = this.state.inputRevision === this.state.promptRevision;
      this.state.inputRevision++; this.insert(text);
      this.peer?.send({ type: 'pasted', text, replace: false, source: 'dictation', repairing: target === 'shell', prompt: dictation.prompt, revision: this.state.inputRevision });
      if (target === 'shell') {
        const original = empty ? text : this.line;
        void detectIntent(original, dictation.phrases).then(intent => this.repair(hex(16), original, intent, this.state.prompt, this.state.inputRevision, true));
      }
    }
    this.peer?.send({ type: 'dictation', id: dictation.id, state: 'done' });
  }
}
