import type { HerdrAgent, HerdrSpace } from './herdr-protocol.ts';

function program(value: string): string {
  const name = value.trim().replace(/^.*[/\\]/, '').replace(/^-/, '');
  if (/^(?:bash|zsh|fish|sh|dash|ksh|nu|pwsh|powershell|terminal|shell|)$/i.test(name)) return 'Shell';
  if (/^(?:claude-code|claude)$/i.test(name)) return 'Claude';
  if (/^codex$/i.test(name)) return 'Codex';
  return name;
}

function folder(path: string, space: HerdrSpace): string {
  const cwd = path.replace(/\/$/, ''), base = (space.checkoutPath || space.cwd).replace(/\/$/, '');
  if (base && cwd === base) return '';
  if (base && cwd.startsWith(base + '/')) return cwd.slice(base.length + 1);
  const parts = cwd.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : cwd;
}

function title(terminal: HerdrAgent, space: HerdrSpace): string {
  if (terminal.label) return terminal.label;
  const name = terminal.name.trim();
  const shellPath = name.match(/^[^\s@:]+@[^\s:]+:\s*((?:\/|~(?:\/|$)).*)$/)?.[1];
  const path = shellPath || (/^(?:\/|~(?:\/|$))/.test(name) ? name : '');
  const namedProgram = /^(?:bash|zsh|fish|sh|dash|ksh|nu|pwsh|powershell|shell|codex|claude-code|claude)$/i.test(name);
  const app = program(terminal.kind === 'Terminal' && namedProgram ? name : terminal.kind);
  const generic = path || !name || name === space.name || namedProgram || name.toLowerCase() === terminal.kind.toLowerCase() || /^(?:Agent|Terminal)$/i.test(name);
  if (!generic) return name;
  const directory = folder(terminal.cwd || path, space);
  return (app || 'Terminal') + (directory ? ' · ' + directory : '');
}

/** Keep task and custom titles intact while compacting shell paths and distinguishing identical panes. */
export function paneTitles(space: HerdrSpace, terminals: HerdrAgent[]): Map<string, string> {
  const panes = space.terminalIds.map(id => terminals.find(terminal => terminal.terminalId === id)).filter(terminal => !!terminal);
  const titles = panes.map(terminal => title(terminal, space));
  const counts = new Map<string, number>(), seen = new Map<string, number>();
  for (const name of titles) counts.set(name, (counts.get(name) || 0) + 1);
  return new Map(panes.map((terminal, index) => {
    const name = titles[index], number = (seen.get(name) || 0) + 1;
    seen.set(name, number);
    return [terminal.terminalId, counts.get(name)! > 1 ? number + ' · ' + name : name];
  }));
}
