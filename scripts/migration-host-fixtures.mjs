// Independent TypeScript oracle for asynchronous engine operations and their host facts.
import { candidateValid } from '../src/engine/validation.ts';
import { repairDirectory } from '../src/engine/path-repair.ts';
import { repairInputFile } from '../src/engine/file-repair.ts';
import { completeArguments } from '../src/engine/completion.ts';
import { suggest } from '../src/engine/suggestions.ts';
import { Discovery } from '../src/engine/discovery.ts';
import { downloadPipeline, transferAction } from '../src/engine/transfer-command.ts';
import { writeFile } from 'node:fs/promises';
import path from 'node:path/posix';

const files = new Map([
  ['/fixture', 'directory'], ['/fixture/docs', 'directory'], ['/fixture/docs/My Notes.txt', 'file'],
  ['/fixture/actual file.txt', 'file'], ['/fixture/script.py', 'file'], ['/fixture/tool', 'executable'],
  ['/fixture/Documents', 'directory'], ['/fixture/Documents/Café 🌍', 'directory'],
  ['/fixture/Work', 'directory'], ['/fixture/Work/termai', 'directory'], ['/fixture/Work/termai/src', 'directory'],
  ['/fixture/link', 'symlink'], ['/fixture/link/termai', 'directory'], ['/fixture/blocked', 'file'],
]);
function info(file) {
  file = path.resolve(file);
  const type = files.get(file);
  return type ? { file: type === 'file' || type === 'executable', directory: type === 'directory' || type === 'symlink', executable: type === 'executable', spelling: file } : undefined;
}
function entries(file) {
  const prefix = file === '/' ? '/' : file + '/';
  return [...files].filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
    .map(([name, type]) => ({ name: name.slice(prefix.length), directory: type === 'directory', symlink: type === 'symlink' }));
}
const fixtures = [];
const flag = (name, takesValue = false) => ({ name, takesValue });
const help = new Map([
  ['orchard', { flags: [flag('--verbose'), flag('--project', true)], subcommands: ['workspace', 'account'] }],
  ['orchard workspace', { flags: [flag('--region', true)], subcommands: ['inspect', 'list'] }],
  ['orchard workspace inspect', { flags: [flag('--details'), flag('--json')], subcommands: [], required: 1 }],
  ['orchard workspace list', { flags: [flag('--json')], subcommands: [] }],
  ['orchard account', { flags: [], subcommands: ['list'] }],
  ['orchard account list', { flags: [flag('--json')], subcommands: [] }],
  ['git', { flags: [], subcommands: ['commit', 'checkout', 'fetch', 'dangerous', 'c', 'evil'], aliases: { c: 'commit', evil: '!touch never' }, safeSubcommands: ['commit', 'checkout', 'fetch'] }],
  ['manual', { flags: [flag('--help')], subcommands: ['show', 'delete'], probeSubcommands: ['show'] }],
  ['manual show', { flags: [flag('--details')], subcommands: [] }],
]);
async function record(operation, args, failure) {
  const facts = new Map();
  async function fact(operation, result) {
    const reply = failure?.(operation) ? { error: 'Synthetic host failure.' } : { value: result ?? null };
    const key = JSON.stringify(operation);
    const previous = facts.get(key);
    if (previous && JSON.stringify(previous.reply) !== JSON.stringify(reply)) throw new Error('Unstable synthetic host fact.');
    facts.set(key, { operation, reply });
    if ('error' in reply) throw new Error(reply.error);
    return result;
  }
  const host = {
    stat: (file, _signal, executable = true) => fact({ kind: 'stat', path: file, executable }, info(file)),
    entries: (file, limit) => fact({ kind: 'entries', path: file, limit }, entries(file).slice(0, limit)),
    lookup: file => fact({ kind: 'lookup', path: file }, info(file) ? { info: info(file) } :
      { listing: { version: 'synthetic-v1', complete: true, entries: entries(path.dirname(file)) } }),
    syntax: command => fact({ kind: 'syntax', command }, !command.includes('unfinished') && !command.endsWith('&&')),
    complete: words => fact({ kind: 'completion', words }, words.slice(0, 2).join(' ') === 'git checkout'
      ? ['feature/demo', 'main', 'release', 'Café 🌍'].filter(name => name.startsWith(words.at(-1)))
      : words.slice(0, 2).join(' ') === 'git fetch'
        ? (words.length === 3 ? ['origin', 'upstream'] : ['feature/demo', 'main']).filter(name => name.startsWith(words.at(-1))) : []),
    help: (command, route) => fact({ kind: 'help', command, route }, help.get([command, ...route].join(' ')) || { flags: [], subcommands: [] }),
    describe: command => fact({ kind: 'describe', command }, command.startsWith('python3 script.py') ? [flag('--output', true), flag('--dry-run')] : undefined),
  };
  let expected;
  try {
    const discovery = new Discovery(host);
    const signal = AbortSignal.timeout(10000);
    let result;
    switch (operation) {
      case 'candidateValid': result = await candidateValid(...args.slice(0, 5), host, args[5] ?? undefined, signal); break;
      case 'repairDirectory': result = await repairDirectory(...args, host, signal); break;
      case 'repairInputFile': result = await repairInputFile(...args.slice(0, 3), host, signal, args[3] ?? args[0]); break;
      case 'completeArguments': result = await completeArguments(...args.slice(0, 3), host, signal, args[3] ?? undefined); break;
      case 'discover': result = await discovery.discover(...args, signal); break;
      case 'suggest': result = await suggest(...args.slice(0, 3), discovery, host, undefined, signal); break;
      case 'suggestWithStage': {
        let source = 'schema'; const candidates = await suggest(...args.slice(0, 3), discovery, host, stage => { source = stage; }, signal);
        result = { candidates, source }; break;
      }
      case 'transferAction': result = transferAction(args[0]); break;
      case 'downloadPipeline': result = downloadPipeline(args[0]); break;
      default: throw new Error('Unknown oracle operation.');
    }
    expected = { value: result ?? null };
  } catch (error) { expected = { error: error.message }; }
  fixtures.push({ operation, args, facts: [...facts.values()], expected });
}
const catalog = { cwd: '/fixture', commands: ['git', 'cat', 'getent', 'ls', 'echo', 'printf', 'grep', 'rg', 'sed', 'awk', 'python3', 'download', 'upload', 'cd', 'pushd', 'vim', '_git_init', 'orchard', 'manual'], functions: ['_git_init'], paths: [], history: [] };
const metadata = { flags: { getent: [{ name: '--help', takesValue: false }], rg: [{ name: '-e', takesValue: true }] }, subcommands: {}, requiredPositionals: { getent: 1, rg: 2 } };
const commands = ['git init', '_git_init', 'nonexistentcommand', 'git nonsense', 'git status --oneline', 'git commit --message',
  'git commit -m hello', 'ls --all=foo', 'cat missing.txt', "cat 'actual file.txt'", 'getent', 'getent --help',
  'cd docs', 'cd blocked', 'cd docs Work', 'cat -', 'download -', 'download', 'download docs', 'download script.py',
  'upload docs', 'upload blocked', 'git -C Work add termai', 'git -C Work add missing', 'python3 script.py', 'python3 missing.py',
  'python3 -c print', 'python3 script.py --help', 'echo $(touch never)', 'echo "unfinished', 'echo hi &&',
  './tool', './script.py', 'vim missing.txt', 'echo "🌍"', "cat '~/missing.txt'", 'cat ~/docs/My\\ Notes.txt',
  'ls -al', 'ls -Z', 'cat -- docs/My\\ Notes.txt', 'git status --short=invalid'];
for (const command of commands) for (const changed of [false, true]) await record('candidateValid', ['Get in it.', { command, score: 100, changes: changed ? ['File → repaired'] : [] }, catalog, { HOME: '/fixture' }, metadata, null]);
await record('candidateValid', ['cat docs/My Notes.txt', { command: "cat 'docs/My Notes.txt'", score: 100, changes: [] }, catalog, { HOME: '/fixture' }, metadata, null], operation => operation.kind === 'syntax');
await record('candidateValid', ['cat docs/My Notes.txt', { command: "cat 'docs/My Notes.txt'", score: 100, changes: [] }, catalog, { HOME: '/fixture' }, metadata, null], operation => operation.kind === 'stat');
for (const input of ['cd docs', 'cd doxs', 'cd Documens', 'cd Documents/Café 🌍', "cd 'Documents/Café 🌍'", 'cd docs/missing',
  'cd Work/termai/src', 'cd work/termai/src', 'cd ../fixture/docs', 'cd ./docs', 'cd /fixture/docs', 'cd ~/Work/termai',
  'cd ~/termai', 'cd ~/blocked', 'cd ~/missing', 'cd ~', 'cd /', 'cd blocked', "cd 'doxs'", 'cd -P docs',
  'cd -- docs', 'upload doxs', 'pushd docu', 'cd link/termai', 'echo docs', 'cd -', 'cd $HOME/docs', 'cd docs; touch invalid']) {
  await record('repairDirectory', [input, catalog, '/fixture']);
}
await record('repairDirectory', ['cd docs', catalog, '/fixture'], operation => operation.kind === 'lookup');
await record('repairDirectory', ['cd docs', { ...catalog, commands: [] }, '/fixture']);
await record('repairDirectory', ['cd ~/docs', catalog, '']);
for (const input of ['download script.py', 'download scrpt.py', 'download docs/My Notes.txt', 'download docs slash My Notes dot txt',
  'download doc/My Notes.txt', 'download doxs/My Notes.txt', 'download --file script.py', 'download -- script.py',
  'download --file -- script.py', 'download ~/docs/My Notes.txt', 'download /fixture/script.py', 'download ../fixture/script.py',
  'download docs', 'download missing', "download 'script.py'", "download 'scrpt.py'", 'download -bad', 'download $HOME/file',
  'cat docs/My Notes.txt', 'cat docs slash My Notes dot txt', "cat 'docs/My Notes.txt'", 'cat docs / My Notes.txt', 'cat script.py',
  'download "script.py"', 'download foo\\bar', 'download ~/missing', 'download /', 'download ~', 'download docs/../script.py']) {
  await record('repairInputFile', [input, catalog, '/fixture']);
}
for (const input of ['git checkout feature dem', 'git checkout featre/demo', 'git checkout main', 'git checkout f e a t u r e slash demo',
  'git checkout "mian"', 'git fetch orign mian', 'git fetch upstream main', 'git checkout dash b new-name', 'git -C Work checkout mian',
  'echo arbitrary', 'printf arbitrary', 'grep patern', 'rg -e pattern target', 'sed program', 'awk program', 'cat actual']) {
  await record('completeArguments', [input, catalog, { flags: {}, subcommands: {}, requiredPositionals: {} }]);
}
for (const input of ['orchard', 'orchard workspace inspect target --details', 'orchard work space in spect target dash details',
  'orchard --project project workspace list', 'orchard workspace nonsense', 'orchard account list', 'orchard "workspace" inspect target',
  'git c dash message hello', 'git evil', 'git dangerous', 'manual show', 'manual delete', 'python3 script.py --output x',
  'python3 missing.py', 'echo hi; touch never', '', 'orchard workspace inspect extra more', 'orchard -- workspace inspect']) {
  await record('discover', [input, catalog, { HOME: '/fixture', PWD: '/fixture', TERMAI_TOKEN: 'synthetic-only', PATH: '/fixture/bin' }]);
}
const inputs = ['Get in it.', 'git status dash short', 'git commit dash message "hello world"', 'ls dash l', 'python3 script dot py dash dry run',
  'orchard work space in spect target dash details', 'orchard workspace list dash json', 'manual show dash details',
  'cat actual file dot txt', 'cat docs slash My Notes dot txt', 'download docs slash My Notes dot txt', 'git checkout featre/demo',
  'git fetch orign mian', 'cd doxs', 'cd Documents slash Café 🌍', 'cd Work slash termai slash src', 'upload docu',
  'git status pipe cat', 'git status pipe download report dot txt', 'echo hi semicolon git status', 'echo hi semi colon ls',
  'echo hi mic git status', 'echo dollar HOME', 'echo asterisk', 'echo "Café 🌍"', 'cat /fixture/actual file dot txt',
  'cat missing', 'echo unfinished', '', 'nonexistentcommand', 'git nonsense', 'git status --short', 'git checkout main',
  'git checkout "Café 🌍"', 'git checkout dash b demo', 'git add scrpt.py', 'ls docs', 'cd ~', 'cat script.py',
  'download script.py', 'echo hi | cat | cat', 'git status && echo hi', 'git evil', 'manual delete'];
for (const input of inputs) for (const historical of [false, true]) {
  await record('suggestWithStage', [input, { ...catalog, history: historical ? ['git init', 'git status --short', 'git commit -m "hello world"', 'orchard workspace list --json'] : [], historyCwds: historical ? { 'git init': '/fixture' } : {} }, { HOME: '/fixture' }]);
}
for (const kind of ['stat', 'lookup', 'entries', 'syntax', 'help', 'describe', 'completion']) {
  for (const input of ['orchard workspace inspect target dash details', 'cat actual file dot txt', 'python3 script dot py dash dry run', 'git checkout featre/demo', 'cd doxs']) {
    await record('suggest', [input, catalog, { HOME: '/fixture' }], operation => operation.kind === kind);
  }
}
for (const input of ['upload docs', 'download script.py', "'download' script.py", 'Download script.py', 'git status | download',
  'git status | Download "report.txt"', 'echo "x | download"', 'echo x || download', 'echo x |& download', 'echo x | download --file',
  'echo x | download foo bar', 'echo x | download "-file"', 'echo $(x) | download', 'echo {x | download', 'echo x pipe download report dot txt']) {
  await record('transferAction', [input]); await record('downloadPipeline', [input]);
}
await writeFile(new URL('../test/fixtures/rust-migration/host.json', import.meta.url), JSON.stringify({ version: 1, reference: '455386bc9443e778f381e1eeaf37cec5a35c2f75', fixtures }, null, 2) + '\n');
console.log(`Captured ${fixtures.length} asynchronous reference fixtures with synthetic host facts.`);
