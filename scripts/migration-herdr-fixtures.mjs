import { writeFile } from 'node:fs/promises';
import { herdrSession, herdrName } from '../src/herdr-protocol.ts';
import { normalizeHerdrSnapshot, herdrSocket } from '../server/herdr.ts';
import { parseHerdrCommand } from '../server/herdr-capture.ts';
import { responsePreview, notificationBody } from '../server/herdr-notification-preview.ts';
import { HerdrState } from '../src/herdr-state.ts';

const rows = [];
const record = (operation, args, invoke) => {
  try { rows.push({ operation, args, expected: { value: invoke() } }); }
  catch (error) { rows.push({ operation, args, expected: { error: error.message } }); }
};
for (const value of [null, '', 'default', 'work', 'a_B-19', '../other', 'foo/bar', '-argument', 'a b', 'x'.repeat(65), 4, true, {}]) {
  record('session', [value], () => herdrSession(value));
}
for (const value of [' API refactor ', '', ' ', 'a\nb', '\0', 'x'.repeat(101), '🙂'.repeat(50), '🙂'.repeat(51), 4, null]) {
  record('name', [value], () => herdrName(value));
}
const env = { HOME: '/home/fixture', XDG_CONFIG_HOME: '/tmp/fixture/config', HERDR_SOCKET_PATH: '/tmp/fixture/custom.sock', HERDR_CONFIG_PATH: '/tmp/ignored/config.toml', HERDR_SESSION: 'from_env' };
for (const session of ['', 'default', 'work', '../escape']) record('socket', [session, env], () => herdrSocket(session, env));
for (const command of ['herdr', 'herdr --session work', ' herdr session attach work ', '/tmp/fixture/bin/herdr', '/tmp/fixture/bin/herdr --session default', 'herdr --session a_B-19', 'herdr server', 'herdr --session ../escape', 'herdr; echo no', 'echo herdr', 'herdr --session work extra']) {
  record('parse', [command, env], () => parseHerdrCommand(command, env));
}
const base = {
  version: 'fixture', protocol: 22,
  workspaces: [{ workspace_id: 'w0', number: 1, active_tab_id: 'tab0' }, { workspace_id: 'w1', label: 'Review', active_tab_id: 'tab1', worktree: { checkout_path: '/fixture/review' } }],
  tabs: [{ tab_id: 'tab0', label: 'Fallback tab' }, { tab_id: 'tab1', label: 'Review terminal' }],
  panes: [
    { pane_id: 'p0', terminal_id: 't0', workspace_id: 'w0', tab_id: 'tab0', focused: true, label: 'API routes', title: 'Pane title', cwd: '/fixture/old', foreground_cwd: '/fixture/current', revision: 5 },
    { pane_id: 'p1', terminal_id: 't1', workspace_id: 'w1', tab_id: 'tab1', title: 'Plain shell', revision: 3 },
  ],
  agents: [{ terminal_id: 't0', pane_id: 'p0', workspace_id: 'w0', tab_id: 'tab0', name: 'agent-address', title: 'Agent title', display_agent: 'Fixture agent', agent: 'fixture', agent_status: 'working', state_change_seq: 9, completion_seq: 7, foreground_cwd: '/fixture/current' }],
};
for (const raw of [{}, { snapshot: {} }, { snapshot: { agents: [], tabs: [], workspaces: [] } }, { snapshot: base }]) {
  record('normalize', [raw], () => normalizeHerdrSnapshot(raw));
}
for (const field of ['label', 'title', 'terminal_title_stripped']) {
  const copy = structuredClone(base);
  copy.panes[0][field] = 'Selected ' + field;
  for (const earlier of ['label', 'title', 'terminal_title_stripped'].slice(0, ['label', 'title', 'terminal_title_stripped'].indexOf(field))) delete copy.panes[0][earlier];
  if (field !== 'label') delete copy.agents[0].title;
  record('normalize', [{ snapshot: copy }], () => normalizeHerdrSnapshot({ snapshot: copy }));
}
for (const status of ['idle', 'working', 'blocked', 'done', 'other', null]) {
  for (const sequence of [1, 1.0, -1, 1.5, 9007199254740992, null]) {
    const copy = structuredClone(base);
    copy.agents[0].agent_status = status;
    copy.agents[0].state_change_seq = sequence;
    copy.agents[0].completion_seq = sequence;
    record('normalize', [{ snapshot: copy }], () => normalizeHerdrSnapshot({ snapshot: copy }));
  }
}
for (const alter of [
  s => { delete s.panes; },
  s => { s.panes[0].focused = false; s.workspaces[0].active_tab_id = 'absent'; },
  s => { s.agents.push({ ...s.agents[0], terminal_id: 5 }); },
  s => { s.panes.push({ ...s.panes[0], label: 'Last pane with same id' }); },
  s => { s.agents[0].terminal_id = 'old-agent-terminal'; },
  s => { s.agents[0].workspace_id = 'missing'; delete s.agents[0].tab_id; },
  s => { s.panes = Array.from({ length: 300 }, (_, i) => ({ pane_id: 'p' + i, terminal_id: 't' + i })); s.agents = []; },
]) {
  const copy = structuredClone(base); alter(copy);
  record('normalize', [{ snapshot: copy }], () => normalizeHerdrSnapshot({ snapshot: copy }));
}
for (const screen of ['', 'Old response\n\n\x1b[32m• New response\x1b[0m\n  continues here.\n\nWorked for 12s\n\n╭─────╮\n│ › ask again │\n╰─────╯\nmodel · status', '🙂'.repeat(400), 'One\r\nTwo\n\n✻ Thinking for 20s', '│ Text painted in a box │\n│ wraps another line │\n│ ❯ next question │', '\x1b]0;title\x07• Final response\x1b[0m', '• One\n\n● Last paragraph']) {
  record('preview', [screen], () => responsePreview(screen));
}
for (const cwd of ['/fixture/project', '', '/fixture/\0x\ny\x7fz', '🙂'.repeat(300)]) {
  for (const preview of ['', 'Finished the work.']) record('body', [cwd, preview], () => notificationBody(cwd, preview));
}
const stateRows = [];
for (const checkpoint of [undefined, {}, { a: { raw: 'working', sequence: 1, working: true } }, { bad: { raw: 'wrong', sequence: 2, working: true } }]) {
  const state = new HerdrState(checkpoint), steps = [];
  for (const [status, sequence, completion] of [['working', 1], ['idle', 2], ['idle', 3], ['working', 4], ['done', 5, 5], ['blocked', 6], ['blocked', 6], ['blocked', 7], ['unknown', 8], ['idle', 1], ['done', 2, 2]]) {
    const agent = { terminalId: 'a', paneId: 'p', workspace: 'w', name: 'Fixture', kind: 'fixture', status, sequence, ...(completion === undefined ? {} : { completion }), cwd: '/fixture' };
    const notifications = state.update({ version: 'fixture', protocol: 22, agents: [agent] });
    steps.push({ snapshot: { agents: [agent] }, notifications, status: state.status(agent), attention: state.attention, checkpoint: structuredClone(state.checkpoint()) });
    if (status === 'done') steps.push({ viewed: 'a', result: state.viewed('a'), checkpoint: structuredClone(state.checkpoint()) });
  }
  stateRows.push({ ...(checkpoint ? { initial: checkpoint } : {}), steps });
}
await writeFile(new URL('../test/fixtures/rust-migration/herdr.json', import.meta.url), JSON.stringify({ reference: '455386b', rows, states: stateRows }, null, 2) + '\n');
console.log('Captured ' + rows.length + ' Herdr boundary fixtures and ' + stateRows.length + ' notification state histories.');
