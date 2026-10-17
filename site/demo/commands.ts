import { branch, log } from 'virtual:libertty-repo';
import { pager, editor } from './programs.ts';
import type { Shell } from './shell.ts';
import { bytes, changes, display, home, list, mkdir, normalize, remove, rename, stat, text, write } from './vfs.ts';

/** A full-screen program that owns the terminal until it calls the shell's finished(). */
export interface Program { start(): void; input(data: string): void; paste(text: string): void; resize(): void }
interface Context { shell: Shell; write(data: string): void; start(program: Program): void }
interface IO { args: string[]; stdin?: string; out(text: string): void; err(text: string): void; context: Context; last: boolean }
type Command = (io: IO) => number | Promise<number>;

const bold = (code: string, text: string) => `\x1b[1;${code}m${text}\x1b[0m`;
const unavailable = ['cargo', 'npm', 'npx', 'node', 'python', 'python3', 'pip', 'make', 'claude', 'codex', 'ssh', 'sudo', 'apt', 'pacman', 'brew', 'docker', 'curl', 'wget', 'rustc', 'tailscale', 'libertty', 'bash', 'sh', 'zsh', 'top', 'htop', 'tmux'];
const encoder = new TextEncoder();
function binary(data: Uint8Array) { return data.subarray(0, 8000).includes(0); }
function human(size: number) { if (size < 1024) return String(size); const units = ['K', 'M', 'G']; let value = size / 1024, unit = 0; while (value >= 1024 && unit < 2) { value /= 1024; unit++; } return (value < 10 ? value.toFixed(1) : Math.round(value)) + units[unit]; }
function date(time: number) { const d = new Date(time); return d.toLocaleString('en-US', { month: 'short' }) + ' ' + String(d.getDate()).padStart(2) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function flags(args: string[], known: string) {
  const set = new Set<string>(), rest: string[] = [];
  for (const arg of args) if (/^-[a-zA-Z]+$/.test(arg) && [...arg.slice(1)].every(flag => known.includes(flag))) for (const flag of arg.slice(1)) set.add(flag); else rest.push(arg);
  return { set, rest };
}
function name(path: string, color = true) {
  const node = stat(path), base = path.slice(path.lastIndexOf('/') + 1) || '/';
  if (!color || !node) return base;
  return node.directory ? bold('34', base) : node.mode & 0o111 ? bold('32', base) : base;
}
const visible = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '').length;
function columns(names: string[], width: number) {
  if (!names.length) return '';
  const widest = Math.max(...names.map(visible)) + 2;
  const count = Math.max(1, Math.floor(width / widest)), rows = Math.ceil(names.length / count), lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let column = 0; column * rows + row < names.length; column++) {
      const item = names[column * rows + row], last = (column + 1) * rows + row >= names.length;
      line += last ? item : item + ' '.repeat(widest - visible(item));
    }
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}
async function read(io: IO, file: string, command: string) {
  const path = normalize(file, io.context.shell.cwd), node = stat(path);
  if (!node) { io.err(`${command}: ${file}: No such file or directory\n`); return; }
  if (node.directory) { io.err(`${command}: ${file}: Is a directory\n`); return; }
  const data = await bytes(path);
  if (binary(data)) { io.err(`${command}: ${file}: binary file\n`); return; }
  return text(path);
}
async function inputs(io: IO, files: string[], command: string) {
  if (!files.length) return { texts: [io.stdin ?? ''], failed: false };
  const texts: string[] = []; let failed = false;
  for (const file of files) { const value = await read(io, file, command); if (value === undefined) failed = true; else texts.push(value); }
  return { texts, failed };
}
function walk(path: string, visit: (path: string) => void) {
  visit(path);
  if (stat(path)?.directory) for (const child of list(path)) if (child !== '.git') walk(path + '/' + child, visit);
}
function count(text: string) { return text.split('\n').length - (text.endsWith('\n') ? 1 : 0); }

const commands: Record<string, Command> = {
  help: ({ out }) => {
    out(`This demo shell runs in your browser over a copy of the libertty repository.
Files you create or edit last until you reload.

  Files     ls  cd  pwd  cat  head  tail  wc  grep  find  tree
            mkdir  touch  rm  mv  cp  echo  less  vi
  Git       git status  git log  git log --oneline  git branch  git show
  Reading   look at README.md   or   git log --oneline | look at
  Other     clear  history  whoami  hostname  date  uname

Tap the mic and say a command, such as "look at readme dot md" or "cd docs".
libertty repairs what you said with this shell's files and history.
`);
    return 0;
  },
  ls: ({ args, out, err, context }) => {
    const { set, rest } = flags(args, 'laAh1F'), cwd = context.shell.cwd;
    const targets = rest.length ? rest : ['.'];
    let status = 0; const blocks: string[] = [];
    for (const target of targets) {
      const path = normalize(target, cwd), node = stat(path);
      if (!node) { err(`ls: cannot access '${target}': No such file or directory\n`); status = 2; continue; }
      const entries = node.directory ? list(path).filter(entry => set.has('a') || set.has('A') || !entry.startsWith('.')).map(entry => path + '/' + entry) : [path];
      const labels = node.directory && set.has('a') ? ['.', '..'] : [];
      let block = targets.length > 1 && node.directory ? `${target}:\n` : '';
      if (set.has('l')) {
        const total = entries.reduce((sum, entry) => sum + Math.ceil((stat(entry)!.size) / 4096) * 4, 0);
        if (node.directory) block += `total ${total}\n`;
        for (const entry of [...labels.map(label => normalize(label, path)), ...entries]) {
          const info = stat(entry)!, mode = (info.directory ? 'd' : '-') + [6, 3, 0].map(shift => { const bits = info.mode >> shift & 7; return (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-'); }).join('');
          const label = labels[[...labels.map(label => normalize(label, path)), ...entries].indexOf(entry)] || (node.directory ? name(entry) : target);
          block += `${mode} 1 you you ${(set.has('h') ? human(info.size) : String(info.size)).padStart(set.has('h') ? 5 : 7)} ${date(info.modified)} ${label}\n`;
        }
      } else {
        const names = [...labels, ...entries.map(entry => node.directory ? name(entry) : target)];
        block += set.has('1') ? names.map(item => item + '\n').join('') : columns(names, context.shell.cols);
      }
      blocks.push(block);
    }
    out(blocks.join('\n'));
    return status;
  },
  cd: ({ args, err, context }) => {
    const shell = context.shell, target = args[0] === '-' ? shell.previous : args[0] || home;
    const path = normalize(target, shell.cwd), node = stat(path);
    if (!node) { err(`cd: ${target}: No such file or directory\n`); return 1; }
    if (!node.directory) { err(`cd: ${target}: Not a directory\n`); return 1; }
    if (args[0] === '-') context.write(display(path) + '\r\n');
    shell.previous = shell.cwd; shell.cwd = path; return 0;
  },
  pwd: ({ out, context }) => { out(context.shell.cwd + '\n'); return 0; },
  echo: ({ args, out }) => { const newline = args[0] !== '-n'; out(args.slice(newline ? 0 : 1).join(' ') + (newline ? '\n' : '')); return 0; },
  cat: async io => { const { set, rest } = flags(io.args, 'n'); const { texts, failed } = await inputs(io, rest, 'cat'); const joined = texts.join(''); io.out(set.has('n') ? joined.split('\n').map((line, index, all) => index === all.length - 1 && !line ? '' : String(index + 1).padStart(6) + '\t' + line).join('\n') : joined); return failed ? 1 : 0; },
  head: async io => {
    let lines = 10; const files: string[] = [];
    for (let i = 0; i < io.args.length; i++) { const arg = io.args[i]; if (arg === '-n') lines = Number(io.args[++i]); else if (/^-\d+$/.test(arg)) lines = Number(arg.slice(1)); else files.push(arg); }
    const { texts, failed } = await inputs(io, files, 'head');
    for (const value of texts) io.out(value.split('\n').slice(0, lines).join('\n') + '\n');
    return failed ? 1 : 0;
  },
  tail: async io => {
    let lines = 10; const files: string[] = [];
    for (let i = 0; i < io.args.length; i++) { const arg = io.args[i]; if (arg === '-n') lines = Number(io.args[++i]); else if (/^-\d+$/.test(arg)) lines = Number(arg.slice(1)); else files.push(arg); }
    const { texts, failed } = await inputs(io, files, 'tail');
    for (const value of texts) io.out(value.replace(/\n$/, '').split('\n').slice(-lines).join('\n') + '\n');
    return failed ? 1 : 0;
  },
  wc: async io => {
    const { set, rest } = flags(io.args, 'lwc'), { texts, failed } = await inputs(io, rest, 'wc');
    texts.forEach((value, index) => {
      const fields = [[set.has('l'), count(value)], [set.has('w'), value.split(/\s+/).filter(Boolean).length], [set.has('c'), encoder.encode(value).length]] as const;
      const shown = fields.some(([on]) => on) ? fields.filter(([on]) => on) : fields;
      io.out(shown.map(([, value]) => String(value).padStart(rest.length ? 7 : 0)).join(' ') + (rest[index] ? ' ' + rest[index] : '') + '\n');
    });
    return failed ? 1 : 0;
  },
  grep: async io => {
    const { set, rest } = flags(io.args, 'inrvlcR'), [pattern, ...files] = rest;
    if (pattern === undefined) { io.err('usage: grep [-inrvlc] PATTERN [FILE...]\n'); return 2; }
    let expression: RegExp;
    try { expression = new RegExp(pattern, set.has('i') ? 'i' : ''); } catch { io.err(`grep: invalid pattern\n`); return 2; }
    const sources: { label?: string; value: string }[] = [], cwd = io.context.shell.cwd;
    if (!files.length && io.stdin !== undefined) sources.push({ value: io.stdin });
    for (const file of files.length ? files : set.has('r') || set.has('R') ? ['.'] : []) {
      const root = normalize(file, cwd);
      if (stat(root)?.directory && (set.has('r') || set.has('R'))) {
        const paths: string[] = []; walk(root, path => { if (!stat(path)!.directory) paths.push(path); });
        for (const path of paths) { const data = await bytes(path); if (!binary(data)) sources.push({ label: display(path).replace(display(cwd) + '/', ''), value: await text(path) }); }
      } else { const value = await read(io, file, 'grep'); if (value !== undefined) sources.push({ label: files.length > 1 ? file : undefined, value }); }
    }
    let matched = 0;
    for (const source of sources) {
      const lines = source.value.split('\n'); let found = 0;
      lines.forEach((line, index) => {
        if (expression.test(line) === set.has('v')) return;
        found++; matched++;
        if (set.has('l') || set.has('c')) return;
        const highlighted = set.has('v') ? line : line.replace(new RegExp(expression.source, expression.flags + 'g'), match => bold('31', match));
        io.out((source.label ? `\x1b[35m${source.label}\x1b[0m\x1b[36m:\x1b[0m` : '') + (set.has('n') ? `\x1b[32m${index + 1}\x1b[0m\x1b[36m:\x1b[0m` : '') + highlighted + '\n');
      });
      if (set.has('l') && found) io.out(`\x1b[35m${source.label}\x1b[0m\n`);
      if (set.has('c')) io.out((source.label ? source.label + ':' : '') + found + '\n');
    }
    return matched ? 0 : 1;
  },
  find: ({ args, out, context }) => {
    const roots: string[] = []; let pattern: RegExp | undefined, type = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-name' || args[i] === '-iname') pattern = new RegExp('^' + args[++i].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', args[i - 1] === '-iname' ? 'i' : '');
      else if (args[i] === '-type') type = args[++i];
      else roots.push(args[i]);
    }
    for (const root of roots.length ? roots : ['.']) {
      const start = normalize(root, context.shell.cwd);
      walk(start, path => {
        const node = stat(path)!, base = path.slice(path.lastIndexOf('/') + 1);
        if (pattern && !pattern.test(base)) return;
        if (type === 'f' && node.directory || type === 'd' && !node.directory) return;
        out((root.replace(/\/$/, '') + path.slice(start.length)) + '\n');
      });
    }
    return 0;
  },
  tree: ({ args, out, context }) => {
    const root = normalize(args[0] || '.', context.shell.cwd); let folders = 0, items = 0;
    out(bold('34', args[0] || '.') + '\n');
    const draw = (path: string, prefix: string, depth: number) => {
      const entries = list(path).filter(entry => !entry.startsWith('.'));
      entries.forEach((entry, index) => {
        const child = path + '/' + entry, last = index === entries.length - 1, node = stat(child)!;
        node.directory ? folders++ : items++;
        out(prefix + (last ? '└── ' : '├── ') + name(child) + '\n');
        if (node.directory && depth < 2) draw(child, prefix + (last ? '    ' : '│   '), depth + 1);
      });
    };
    draw(root, '', 0); out(`\n${folders} directories, ${items} files (two levels shown)\n`);
    return 0;
  },
  less: async io => {
    const file = io.args.find(arg => !arg.startsWith('-'));
    const value = file ? await read(io, file, 'less') : io.stdin;
    if (value === undefined) return 1;
    if (!io.last) { io.out(value); return 0; }
    io.context.start(pager(io.context.shell, value, file || 'standard input')); return 0;
  },
  vi: async io => {
    const file = io.args.find(arg => !arg.startsWith('-') && !arg.startsWith('+'));
    const path = file ? normalize(file, io.context.shell.cwd) : undefined, node = path ? stat(path) : undefined;
    if (node?.directory) { io.err(`vi: ${file}: Is a directory\n`); return 1; }
    if (node && binary(await bytes(path!))) { io.err(`vi: ${file}: binary file\n`); return 1; }
    io.context.start(editor(io.context.shell, path, node ? await text(path!) : io.stdin ?? '', !!node)); return 0;
  },
  clear: ({ context }) => { context.write('\x1b[H\x1b[2J\x1b[3J'); return 0; },
  history: ({ out, context }) => { out(context.shell.history.map((line, index) => String(index + 1).padStart(5) + '  ' + line).join('\n') + '\n'); return 0; },
  whoami: ({ out }) => { out('you\n'); return 0; },
  hostname: ({ out }) => { out('monticello\n'); return 0; },
  uname: ({ args, out }) => { out(args.includes('-a') ? 'Linux monticello 6.17.0-libertty #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n' : 'Linux\n'); return 0; },
  date: ({ out }) => { out(new Date().toString() + '\n'); return 0; },
  true: () => 0,
  false: () => 1,
  sleep: async ({ args }) => { await new Promise(resolve => setTimeout(resolve, Math.min(10, Number(args[0]) || 0) * 1000)); return 0; },
  mkdir: ({ args, err, context }) => { let status = 0; for (const arg of args.filter(arg => arg !== '-p')) { try { mkdir(normalize(arg, context.shell.cwd)); } catch (error) { if (!args.includes('-p')) { err(`mkdir: cannot create directory '${arg}': ${(error as Error).message}\n`); status = 1; } } } return status; },
  touch: ({ args, context }) => { for (const arg of args) { const path = normalize(arg, context.shell.cwd); if (!stat(path)) write(path, ''); else stat(path)!.modified = Date.now(); } return 0; },
  rm: ({ args, err, context }) => {
    const { set, rest } = flags(args, 'rfRi'); let status = 0;
    for (const arg of rest) {
      const path = normalize(arg, context.shell.cwd), node = stat(path);
      if (!node) { if (!set.has('f')) { err(`rm: cannot remove '${arg}': No such file or directory\n`); status = 1; } continue; }
      if (node.directory && !set.has('r') && !set.has('R')) { err(`rm: cannot remove '${arg}': Is a directory\n`); status = 1; continue; }
      remove(path);
    }
    return status;
  },
  mv: ({ args, err, context }) => {
    const [from, to] = args, cwd = context.shell.cwd;
    if (!from || !to) { err('mv: missing file operand\n'); return 1; }
    let target = normalize(to, cwd); if (stat(target)?.directory) target += '/' + from.split('/').pop();
    try { rename(normalize(from, cwd), target); return 0; } catch (error) { err(`mv: cannot move '${from}': ${(error as Error).message}\n`); return 1; }
  },
  cp: async ({ args, err, context }) => {
    const [from, to] = args, cwd = context.shell.cwd;
    if (!from || !to) { err('cp: missing file operand\n'); return 1; }
    const source = normalize(from, cwd);
    if (stat(source)?.directory) { err(`cp: -r not specified; omitting directory '${from}'\n`); return 1; }
    let target = normalize(to, cwd); if (stat(target)?.directory) target += '/' + from.split('/').pop();
    try { write(target, await bytes(source)); return 0; } catch (error) { err(`cp: cannot copy '${from}': ${(error as Error).message}\n`); return 1; }
  },
  git: async io => {
    const [sub, ...rest] = io.args, cwd = io.context.shell.cwd;
    if (!cwd.startsWith(normalize('~/libertty'))) { io.err('fatal: not a git repository (or any of the parent directories): .git\n'); return 128; }
    if (sub === 'status') {
      const { modified, created } = changes();
      io.out(`On branch ${branch}\nYour branch is up to date with 'origin/${branch}'.\n\n`);
      if (!modified.length && !created.length) io.out('nothing to commit, working tree clean\n');
      if (modified.length) io.out('Changes not staged for commit:\n' + modified.map(path => `\t\x1b[31mmodified:   ${path}\x1b[0m\n`).join('') + '\n');
      if (created.length) io.out('Untracked files:\n' + created.map(path => `\t\x1b[31m${path}\x1b[0m\n`).join('') + '\n');
      return 0;
    }
    if (sub === 'branch') { io.out(`* \x1b[32m${branch}\x1b[0m\n`); return 0; }
    if (sub === 'log' || sub === 'show') {
      let limit = sub === 'show' ? 1 : log.length;
      for (let i = 0; i < rest.length; i++) { if (rest[i] === '-n') limit = Number(rest[++i]); else if (/^-\d+$/.test(rest[i])) limit = Number(rest[i].slice(1)); }
      const entries = log.slice(0, limit);
      if (rest.includes('--oneline')) { io.out(entries.map(entry => `\x1b[33m${entry.hash}\x1b[0m ${entry.subject}\n`).join('')); return 0; }
      const value = entries.map((entry, index) => `\x1b[33mcommit ${entry.hash}${index ? '' : ` (\x1b[1;36mHEAD -> \x1b[1;32m${branch}\x1b[33m)`}\x1b[0m\nAuthor: ${entry.author}\nDate:   ${new Date(entry.date).toString().slice(0, 24)}\n\n    ${entry.subject}\n${entry.body ? '\n' + entry.body.split('\n').map(line => '    ' + line).join('\n') + '\n' : ''}`).join('\n');
      if (io.last && count(value) > io.context.shell.rows) io.context.start(pager(io.context.shell, value, ''));
      else io.out(value);
      return 0;
    }
    if (sub === 'diff') return 0;
    io.err(sub ? `git ${sub} is not available in this demo. Try git status, git log or git branch.\n` : 'usage: git <command>\nThis demo supports status, log, show and branch.\n');
    return 1;
  },
  herdr: ({ out }) => { out('Herdr is already open in the Herdr tab. Swipe the tab bar to switch to it.\n'); return 0; },
  exit: ({ out }) => { out('This demo shell stays open. Close the tab or reload the page to start over.\n'); return 0; },
};
commands.more = commands.less; commands.vim = commands.nvim = commands.view = commands.nano = commands.vi;
export const commandNames = [...Object.keys(commands), 'look'].sort();

/** Split a command line into sequenced pipelines of words, honoring quotes, redirects and simple globs. */
function parse(line: string, cwd: string) {
  const sequence: { op: string; stages: { words: string[]; redirect?: { path: string; append: boolean } }[] }[] = [];
  let stage: { words: string[]; redirect?: { path: string; append: boolean } } = { words: [] }, stages = [stage], op = ';';
  let word = '', active = false, quote = '', glob = false, redirect: '' | '>' | '>>' = '';
  const finish = () => {
    if (!active) return;
    let values = [word];
    if (glob) values = expand(word, cwd);
    if (redirect) { stage.redirect = { path: values[0], append: redirect === '>>' }; redirect = ''; }
    else stage.words.push(...values);
    word = ''; active = false; glob = false;
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) { if (char === quote) quote = ''; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; active = true; continue; }
    if (char === '\\' && i + 1 < line.length) { word += line[++i]; active = true; continue; }
    if (/\s/.test(char)) { finish(); continue; }
    if (char === '>' ) { finish(); redirect = line[i + 1] === '>' ? (i++, '>>') : '>'; continue; }
    if (char === '|' && line[i + 1] !== '|') { finish(); stage = { words: [] }; stages.push(stage); continue; }
    if (char === ';' || (char === '&' && line[i + 1] === '&') || (char === '|' && line[i + 1] === '|')) {
      finish(); sequence.push({ op, stages }); op = char === ';' ? ';' : char + char; if (char !== ';') i++;
      stage = { words: [] }; stages = [stage]; continue;
    }
    if (!active && char === '~' && (line[i + 1] === undefined || line[i + 1] === '/' || /\s/.test(line[i + 1]))) { word += home; active = true; continue; }
    if (char === '*' || char === '?') glob = true;
    word += char; active = true;
  }
  finish(); sequence.push({ op, stages });
  return sequence.filter(item => item.stages.some(stage => stage.words.length));
}
function expand(pattern: string, cwd: string) {
  const slash = pattern.lastIndexOf('/'), directory = pattern.slice(0, slash + 1), base = pattern.slice(slash + 1);
  const expression = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const matches = list(normalize(directory || '.', cwd)).filter(entry => expression.test(entry) && (base.startsWith('.') || !entry.startsWith('.'))).map(entry => directory + entry);
  return matches.length ? matches : [pattern];
}

export async function run(line: string, context: Context): Promise<number> {
  let status = 0;
  for (const { op, stages } of parse(line, context.shell.cwd)) {
    if (op === '&&' && status !== 0 || op === '||' && status === 0) continue;
    let stdin: string | undefined;
    for (const [index, { words, redirect }] of stages.entries()) {
      const [name, ...args] = words, last = index === stages.length - 1 && !redirect, captured: string[] = [];
      // Like real tools writing to a pipe or file, output that does not reach the terminal carries no colors.
      const out = (value: string) => last ? context.write(value.replace(/\r?\n/g, '\r\n')) : captured.push(value.replace(/\x1b\[[0-9;]*m/g, ''));
      const err = (value: string) => context.write(value.replace(/\r?\n/g, '\r\n'));
      const command = commands[name];
      if (command) status = await command({ args, stdin, out, err, context, last });
      else if (unavailable.includes(name)) { err(`${name}: not available in this demo. Install libertty to run it on your own machine.\n`); status = 127; }
      else { err(`bash: ${name}: command not found\n`); status = 127; }
      stdin = captured.join('');
      if (redirect) {
        const path = normalize(redirect.path, context.shell.cwd);
        try { write(path, (redirect.append && stat(path) ? await text(path) : '') + stdin); } catch (error) { err(`bash: ${redirect.path}: ${(error as Error).message}\n`); status = 1; }
      }
    }
  }
  return status;
}
