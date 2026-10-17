import type { HerdrAgent, HerdrSnapshot, HerdrSpace, HerdrStatus } from '../../src/herdr-protocol.ts';
import { wrap } from './programs.ts';
import type { Peer } from './shell.ts';
import { listen, type Listening } from './speech.ts';
import { home } from './vfs.ts';

/** A scripted Herdr server: agent panes replay sessions modeled on libertty's own development, and answer what visitors type. */
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`, bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dot = (color = '') => color ? `\x1b[${color}m●\x1b[0m` : '●';
const tool = (name: string, detail: string) => `${dot('32')} ${bold(name)}(${detail})`;
const user = (text: string) => `\x1b[48;5;237m\x1b[38;5;252m> ${text}\x1b[0m`;
const spinner = ['✻', '✳', '✢', '·', '✢', '✳'];
const keys = /\x1b\[200~[\s\S]*?\x1b\[201~|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[@-~]|\x1b|[\s\S]/g;
const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const reply = 'This is a recorded session in the libertty demo, so I can\'t change files from here. Install libertty and connect Herdr to steer your own agents from your phone: curl -fsSL https://install.libertty.sh | bash';

interface Choice { title: string; detail: string[]; options: string[]; answer(index: number): void }
class Pane {
  cols = 48; rows = 30; revision = 0; version = 0;
  lines: string[]; input = ''; cursor = 0; busy = ''; started = 0; choice?: Choice; selected = 0;
  peers = new Set<Peer>(); footer: string;
  private dictation?: { id: string; listening: Listening };
  private timer?: ReturnType<typeof setInterval>;
  readonly agent: HerdrAgent; readonly herdr: Herdr; readonly prompt: string;
  constructor(agent: HerdrAgent, herdr: Herdr, lines: string[], footer: string, prompt = '> ') { this.agent = agent; this.herdr = herdr; this.lines = lines; this.footer = footer; this.prompt = prompt; }

  status(status: HerdrStatus) { this.herdr.status(this.agent.terminalId, status); }
  work(label: string, seconds: number, finish: () => void) {
    this.busy = label; this.started = Date.now(); this.status('working');
    clearInterval(this.timer); this.timer = setInterval(() => this.render(), 250);
    setTimeout(() => { clearInterval(this.timer); this.busy = ''; finish(); this.render(); }, seconds * 1000);
    this.render();
  }
  /** Lines arrive one at a time while the agent works, the way a live session streams. */
  stream(lines: string[], gap: number, finish: () => void) {
    let index = 0;
    const step = () => { if (index >= lines.length) { finish(); return; } this.lines.push(lines[index++]); this.render(); setTimeout(step, gap); };
    step();
  }
  submit(text: string) {
    if (!text.trim() || this.busy || this.choice) return;
    this.lines.push('', user(text));
    this.work('Thinking…', 3, () => { this.lines.push('', `${dot()} ${reply}`); this.status('done'); });
  }
  key(key: string) {
    if (this.choice) {
      const choice = this.choice;
      if (key === '\x1b[A' || key === 'k') this.selected = Math.max(0, this.selected - 1);
      else if (key === '\x1b[B' || key === 'j') this.selected = Math.min(choice.options.length - 1, this.selected + 1);
      else if (/^[1-9]$/.test(key) && Number(key) <= choice.options.length) { this.choice = undefined; choice.answer(Number(key) - 1); }
      else if (key === '\r') { this.choice = undefined; choice.answer(this.selected); }
      else if (key === '\x1b') { this.choice = undefined; choice.answer(choice.options.length - 1); }
      this.render(); return;
    }
    if (key.startsWith('\x1b[200~')) this.insert(key.slice(6, -6).replace(/[\r\n]+/g, ' '));
    else if (key === '\r') { const text = this.input; this.input = ''; this.cursor = 0; this.submit(text); }
    else if (key === '\x7f' || key === '\b') { if (this.cursor) { this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor); this.cursor--; } }
    else if (key === '\x1b[D') this.cursor = Math.max(0, this.cursor - 1);
    else if (key === '\x1b[C') this.cursor = Math.min(this.input.length, this.cursor + 1);
    else if (key === '\x01' || key === '\x1b[H') this.cursor = 0;
    else if (key === '\x05' || key === '\x1b[F') this.cursor = this.input.length;
    else if (key === '\x15' || key === '\x03') { this.input = ''; this.cursor = 0; }
    else if (key >= ' ' && !key.startsWith('\x1b')) { this.insert(key); return; }
    this.render();
  }
  insert(text: string) { this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor); this.cursor += text.length; this.render(); }

  /** The screen as rows of at most `cols` cells, plus where the cursor sits. */
  private screen() {
    const rows = this.lines.flatMap(line => wrap(line, this.cols)), rule = dim('─'.repeat(this.cols));
    if (this.busy) rows.push('', `\x1b[38;5;209m${spinner[Math.floor(Date.now() / 250) % spinner.length]} ${this.busy}\x1b[0m ${dim(`(${Math.floor((Date.now() - this.started) / 1000)}s · esc to interrupt)`)}`);
    let cursor: [number, number] | undefined;
    if (this.choice) {
      const width = this.cols - 2, pad = (text: string, raw = text) => '│ ' + text + ' '.repeat(Math.max(0, width - 2 - raw.length)) + ' │';
      rows.push('', '╭' + '─'.repeat(width) + '╮', pad(bold(this.choice.title), this.choice.title));
      for (const line of this.choice.detail) rows.push(pad('  ' + line.slice(0, width - 4), '  ' + line.slice(0, width - 4)));
      rows.push(pad(''), pad('Do you want to proceed?'));
      this.choice.options.forEach((option, index) => {
        const raw = `${index === this.selected ? '❯' : ' '} ${index + 1}. ${option}`.slice(0, width - 2);
        rows.push(pad(index === this.selected ? `\x1b[36m${raw}\x1b[0m` : raw, raw));
      });
      rows.push('╰' + '─'.repeat(width) + '╯');
    } else {
      const field = wrap(this.prompt + this.input, this.cols), at = this.prompt.length + this.cursor;
      rows.push('', rule);
      cursor = [rows.length + Math.floor(at / this.cols), at % this.cols];
      rows.push(...field, rule);
    }
    rows.push(dim(this.footer));
    return { rows, cursor };
  }
  render(peer?: Peer) {
    const { rows, cursor } = this.screen(), top = Math.max(0, rows.length - this.rows);
    const visible = rows.slice(top), point = cursor && cursor[0] >= top ? `\x1b[${cursor[0] - top + 1};${cursor[1] + 1}H\x1b[?25h` : '\x1b[?25l';
    const utf8 = new TextEncoder().encode('\x1b[H\x1b[2J' + visible.join('\r\n') + point);
    let binary = ''; for (const byte of utf8) binary += String.fromCharCode(byte);
    const screen = { type: 'screen', text: rows.join('\n') + '\n', version: ++this.version };
    const frame = { type: 'herdr-frame', width: this.cols, height: this.rows, full: true, bytes: btoa(binary) };
    for (const target of peer ? [peer] : this.peers) { target.send(screen); target.send(frame); }
  }

  attach(peer: Peer) {
    this.peers.add(peer);
    peer.send({ type: 'state', state: { cwd: this.agent.cwd, inputRevision: this.revision, promptRevision: 0, ready: false, prompt: 0, exited: false, inputTarget: 'program' } });
  }
  detach(peer: Peer) { this.peers.delete(peer); if (!this.peers.size) { this.dictation?.listening.cancel(); this.dictation = undefined; } }
  message(peer: Peer, message: any) {
    switch (message.type) {
      case 'ping': peer.send({ type: 'pong' }); return;
      case 'resize': this.cols = Math.max(20, message.cols); this.rows = Math.max(6, message.rows); this.render(); return;
      case 'herdr-frame-request': this.render(peer); return;
      case 'input': this.revision++; for (const key of String(message.data).match(keys) || []) this.key(key); return;
      case 'paste': this.revision++; this.insert(message.text); return;
      case 'dictation-paste':
        this.revision++;
        if (message.replace) { this.input = message.text; this.cursor = this.input.length; this.render(); } else this.insert(message.text);
        peer.send({ type: 'pasted', text: message.text, replace: !!message.replace, prompt: message.prompt, revision: this.revision });
        return;
      case 'command':
        peer.send({ type: 'result', id: message.id, accepted: true });
        this.revision++; this.input = ''; this.cursor = 0; this.submit(message.command); return;
      case 'repair': peer.send({ type: 'repair-result', id: message.id, prompt: message.prompt, revision: this.revision, accepted: false, original: message.text, selected: message.text, candidates: [] }); return;
      case 'dictation': void this.dictate(peer, message); return;
    }
  }
  private async dictate(peer: Peer, message: { id: string; action: string }) {
    if (message.action === 'start') {
      this.dictation?.listening.cancel(); this.dictation = { id: message.id, listening: listen() };
      peer.send({ type: 'dictation', id: message.id, state: 'ready' }); return;
    }
    const dictation = this.dictation;
    if (!dictation || dictation.id !== message.id) return;
    this.dictation = undefined;
    if (message.action === 'cancel') { dictation.listening.cancel(); return; }
    const text = (await dictation.listening.finish()).replace(/[\x00-\x1f\x7f]/g, '');
    if (text) {
      this.revision++; this.insert(text);
      peer.send({ type: 'pasted', text, replace: false, source: 'dictation', repairing: false, prompt: 0, revision: this.revision });
    }
    peer.send({ type: 'dictation', id: dictation.id, state: 'done' });
  }
}

export class Herdr {
  private sequence = 10;
  private viewers = new Set<Peer>();
  readonly spaces: HerdrSpace[];
  readonly panes = new Map<string, Pane>();
  constructor() {
    const worktrees = home + '/.herdr/worktrees/libertty/';
    const space = (id: string, name: string, cwd: string, repo?: { key: string; name: string; linked: boolean }): HerdrSpace =>
      ({ id, name, terminalIds: [], cwd, ...(repo ? { repoKey: repo.key, repoName: repo.name, linkedWorktree: repo.linked, checkoutPath: cwd } : {}) });
    const libertty = { key: 'libertty', name: 'libertty', linked: true };
    this.spaces = [
      space('w-libertty', 'libertty', home + '/libertty', { ...libertty, linked: false }),
      space('w-1776', 'feat-1776-theme', worktrees + 'feat-1776-theme', libertty),
      space('w-webpage', 'feat-webpage', worktrees + 'feat-webpage', libertty),
      space('w-daylight', 'daylight-colors', worktrees + 'daylight-colors', libertty),
      space('w-voxtype', 'voxtype-mobile', home + '/voxtype-mobile'),
    ];
    const claudeFooter = '  ⏵⏵ auto mode on (shift+tab to cycle)', codexFooter = '  gpt-5-codex high · ~/libertty · ? for shortcuts';
    const add = (id: string, spaceId: string, name: string, kind: string, status: HerdrStatus, lines: string[], footer: string, prompt?: string) => {
      const owner = this.spaces.find(item => item.id === spaceId)!;
      owner.terminalIds.push(id); owner.selectedTerminalId ||= id;
      const agent: HerdrAgent = { terminalId: id, paneId: 'p-' + id, workspace: owner.name, workspaceId: spaceId, tabId: 'tab-' + id, name, kind, status, sequence: ++this.sequence, cwd: owner.cwd! };
      const pane = new Pane(agent, this, lines, footer, prompt); this.panes.set(id, pane); return pane;
    };

    const theme = add('t-1776', 'w-1776', 'claude', 'claude', 'blocked', [
      user('Make a new theme for the newly rebranded libertty called 1776. A patriotic American theme, practical to use, without sacrificing red, white and blue. Propose three mock designs.'),
      '', `${dot()} Theme lives in src/theme.ts + src/tokens.css; I'm drafting three palettes, checking their contrast, and building a visual mock page.`,
      '', tool('Bash', 'cat src/theme.ts && cat src/tokens.css'), `  ⎿  import type { ITheme } from 'ghostty-web';`, dim('     … +71 lines (ctrl+o to expand)'),
      '', `${dot()} I've put three mock designs for the 1776 theme on one page:`, '  A · Old Glory: deep navy, star-white text, red accent.', '  B · Declaration: iron-gall ink on parchment.', '  C · Star-Spangled: the flag laid out as an interface.',
      '', user('i really like A & C. can we do a theme like C but light & light'),
      '', `${dot()} Added D · Star-Spangled Light: a white canvas, pale blue bars, Old Glory Blue text and Old Glory Red buttons.`,
      '', user('ship A as 1776'),
      '', `${dot()} Implementing A as the 1776 theme now.`,
      '', tool('Update', 'src/tokens.css'), '  ⎿  Added 12 lines',
      `\x1b[48;5;22m      46 +/* 1776 is a navy theme with star-white text */\x1b[0m`, `\x1b[48;5;22m      47 +:root[data-theme="1776"]{\x1b[0m`, `\x1b[48;5;22m      48 +  --bg:#0b1430;--surface:#101b3b;\x1b[0m`, dim('     … +9 lines (ctrl+o to expand)'),
      '', tool('Update', 'src/theme.ts'), '  ⎿  Added 7 lines, removed 1 line',
      '', tool('Bash', 'npm run ci:quick'), '  ⎿  \x1b[32m✔\x1b[0m 102 tests passed (4.2s)',
      '', `${dot()} Quick checks passed. The full verify:local suite is next.`,
    ], claudeFooter);
    theme.choice = { title: 'Bash command', detail: ['npm run verify:local', 'Run the full local verification suite'], options: ['Yes', 'Yes, and don\'t ask again for npm run', 'No, and tell Claude what to do differently'], answer: index => {
      if (index === 2) { theme.lines.push('', `${dot()} Okay, I won't run it. What should I do instead?`); theme.status('idle'); return; }
      theme.lines.push('', tool('Bash', 'npm run verify:local'));
      theme.work('Verifying…', 14, () => {});
      theme.stream(['  ⎿  PASS workspace: terminal-first, settings pane and shared preferences', '     PASS Herdr shell dictation: alternatives, scoped repair', '     PASS files: browsing, uploads and downloads', '     PASS Herdr reader: typed and dictated files', '     \x1b[32m✔\x1b[0m 24 suites passed · exit=0',
        '', tool('Bash', 'git commit -m "add 1776 theme"'), '  ⎿  [feat/1776-theme e6dc63f] add 1776 theme', '      8 files changed, 29 insertions(+), 5 deletions(-)'], 1500, () => {
        theme.lines.push('', `${dot()} Shipped A as 1776 in e6dc63f. Full local verification passed and the working tree is clean.`, '', dim('Worked for 22m 16s')); theme.status('done');
      });
    } };

    const webpage = add('t-webpage', 'w-webpage', 'claude', 'claude', 'working', [
      user('lets design a webpage for this project. it should be a preview of using the app, with a phone on desktop and just the screen on mobile.'),
      '', `${dot()} I'll start by getting oriented in the repo and the referenced artifact.`,
      '', tool('Bash', 'ls && cat README.md'), dim('  ⎿  … +150 lines (ctrl+o to expand)'),
      '', `${dot()} The frontend speaks plain JSON when no binary subprotocol is negotiated, so an in-page backend can drive the real terminal, Herdr, files and reader code.`,
      '', tool('Write', 'site/demo/shell.ts'), '  ⎿  Wrote 214 lines',
      '', tool('Bash', 'cargo build -p libertty-engine-wasm --target wasm32-unknown-unknown'), '  ⎿  Finished `release` profile [optimized] in 30.93s',
    ], claudeFooter);
    webpage.work('Building the site…', 45, () => {
      webpage.lines.push('', `${dot()} The site builds into dist-site/ with the real app, the repair engine in WebAssembly and a copy of this repository.`, '', dim('Worked for 3h 41m')); webpage.status('done');
    });

    add('t-daylight', 'w-daylight', 'codex', 'codex', 'done', [
      user('master failed ci. diagnose and fix'),
      '', `• Ran ${'\x1b[34mgit\x1b[0m'} status --short && git log -1`, dim('  └ Acknowledge Herdr history repaints after resizing'),
      '', '• Added /tmp/termai-ci-fix-commit.txt (+4 -0)', '\x1b[48;5;22m    1 +Acknowledge Herdr history repaints after resizing\x1b[0m',
      '', '• Fixed the release CI failure in local commit \x1b[32m433f5f3\x1b[0m.', '  Herdr resizing could leave its iframe inert because a repaint acknowledgement was missing.', '  Added the acknowledgement and regression coverage.',
      '', dim('Worked for 22m 16s • 10:25 AM'),
    ], codexFooter, '› ');
    add('t-voxtype', 'w-voxtype', 'codex', 'codex', 'idle', [
      user('add a wake lock while recording so android keeps the mic open'),
      '', '• Edited src/recorder.rs (+18 -2)', '• Ran cargo test', dim('  └ test result: ok. 41 passed'),
      '', '• Recording now holds a partial wake lock and releases it when the stream ends.',
    ], codexFooter, '› ');
    add('t-shell', 'w-libertty', 'bash', 'shell', 'idle', ['\x1b[32m~/libertty\x1b[0m $ git worktree list',
      `${home}/libertty                                      1f9124b [master]`, `${worktrees}feat-1776-theme  e6dc63f [feat/1776-theme]`, `${worktrees}feat-webpage     1f9124b [feat/webpage]`, `${worktrees}daylight-colors  433f5f3 [daylight-colors]`,
    ], 'This pane replays a recording. Use the terminal tab for a live shell.', '\x1b[32m~/libertty\x1b[0m $ ');
  }

  snapshot(): HerdrSnapshot {
    const agents = [...this.panes.values()].map(pane => ({ ...pane.agent }));
    return { version: '0.9.3', protocol: 1, agents, terminals: agents, spaces: this.spaces.map(space => ({ ...space, terminalIds: [...space.terminalIds] })) };
  }
  status(terminalId: string, status: HerdrStatus) {
    const agent = this.panes.get(terminalId)!.agent;
    if (agent.status === status) return;
    agent.status = status; agent.sequence = ++this.sequence;
    if (status === 'done') agent.completion = agent.sequence;
    this.broadcast();
  }
  rename(terminalId: string | undefined, workspaceId: string | undefined, name: string) {
    if (terminalId && this.panes.has(terminalId)) this.panes.get(terminalId)!.agent.name = name;
    const space = this.spaces.find(space => space.id === workspaceId);
    if (space) { space.name = name; for (const pane of this.panes.values()) if (pane.agent.workspaceId === space.id) pane.agent.workspace = name; }
    this.broadcast();
  }
  private broadcast() { const snapshot = this.snapshot(); for (const viewer of this.viewers) viewer.send({ type: 'snapshot', snapshot }); }
  view(peer: Peer) { this.viewers.add(peer); peer.send({ type: 'snapshot', snapshot: this.snapshot() }); return { message(message: any) { if (message?.type === 'ping') peer.send({ type: 'pong' }); }, close: () => this.viewers.delete(peer) }; }
  pane(peer: Peer, terminalId: string) {
    const pane = this.panes.get(terminalId);
    if (!pane) { peer.close(1000, 'Herdr terminal ended'); return { message() {}, close() {} }; }
    pane.attach(peer);
    return { message: (message: any) => pane.message(peer, message), close: () => pane.detach(peer) };
  }
  ticket() { return { ticket: hex(32) }; }
}
