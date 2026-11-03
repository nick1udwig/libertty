import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { launchBrowser, freePort, until, pair, waitForBackend } from './support/browser.mjs';
import { showTerminalTabs } from './support/workspace-navigation.mjs';
import { WebSocket } from 'ws';
import { decodeWire } from '../src/wire.ts';
import ssh2 from 'ssh2';
import { sshdPath, sshdConfig } from './support/sshd.mjs';
import { fingerprint } from './support/ssh-key.ts';
import { assertPaneStack, assertPaneTitleRoom } from './support/herdr-tree.mjs';

const root = await mkdtemp(join(tmpdir(), 'libertty-core-'));
const hc = process.env.LIBERTTY_HC_BINARY || 'hc';
const coreSession = 'libertty-integration';
const env = {
  ...process.env,
  HOME: root,
  SHELL: '/bin/bash',
  XDG_RUNTIME_DIR: join(root, 'runtime'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_STATE_HOME: join(root, 'state'),
  HC_SESSION: coreSession,
  LIBERTTY_HC_BINARY: hc,
};
await mkdir(env.XDG_RUNTIME_DIR);
execFileSync('git', ['init', '-q', root]);
execFileSync('git', [
  '-C',
  root,
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '--allow-empty',
  '-qm',
  'Initial fixture',
]);
const port = await freePort(),
  base = `http://127.0.0.1:${port}/`;
const token = 'herdr-core-test-pairing-token-123456789';
let backend,
  browser,
  sshd,
  logs = '',
  bearer;
const sockets = [];
async function api(path, body, credential = bearer) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: base.slice(0, -1),
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
function route(path, terminal) {
  return (
    `api/herdr/${path}?` +
    new URLSearchParams({
      herdrCore: '1',
      herdrSession: coreSession,
      ...(terminal ? { terminalId: terminal } : {}),
    })
  );
}
async function connectSocket(terminal, source) {
  const { ticket } = await api(
    route('ticket', terminal) + (source ? '&herdrSource=' + source : ''),
    terminal ? { cols: 80, rows: 24, mobile: true } : {},
  );
  const ws = new WebSocket(
    base.replace('http', 'ws') +
      'herdr/ws?' +
      new URLSearchParams({
        herdrCore: '1',
        herdrSession: coreSession,
        ticket,
        ...(source ? { herdrSource: source } : {}),
        ...(terminal ? { terminalId: terminal } : {}),
      }),
    { origin: base.slice(0, -1) },
  );
  sockets.push(ws);
  const messages = [];
  ws.on('message', async (data, binary) => {
    const message = await decodeWire(
      binary
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data.toString(),
    );
    messages.push(message);
    if (message.type === 'output') ws.send(JSON.stringify({ type: 'ack', seq: message.seq }));
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, messages };
}
try {
  backend = spawn(new URL('../target/debug/libertty', import.meta.url).pathname, [], {
    env: {
      ...env,
      HOST: '127.0.0.1',
      PORT: String(port),
      LIBERTTY_ALLOWED_HOSTS: '127.0.0.1',
      LIBERTTY_DATA_DIR: join(root, 'data'),
      LIBERTTY_CWD: root,
      LIBERTTY_NO_RC: '1',
      LIBERTTY_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (b) => (logs += b));
  backend.stderr.on('data', (b) => (logs += b));
  await waitForBackend(base, backend);
  bearer = await pair(base, token);
  const empty = await api(route('snapshot'));
  assert.deepEqual(empty.spaces, []);
  const created = await api(route('action'), { action: 'create-space' });
  assert.ok(created.workspaceId);
  assert.ok(created.terminalId);
  const snapshot = await api(route('snapshot'));
  assert.equal(snapshot.spaces.length, 1);
  assert.equal(snapshot.terminals.length, 1);
  assert.equal(snapshot.spaces[0].repoName, basename(root));
  assert.equal(
    snapshot.spaces[0].name,
    execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
  );
  const metadata = await connectSocket();
  await until(() => metadata.messages.some((m) => m.type === 'snapshot'), 'metadata');
  execFileSync('git', ['-C', root, 'switch', '-qc', 'core-label-update']);
  await until(
    () =>
      metadata.messages.some((m) => m.snapshot?.spaces.some((s) => s.name === 'core-label-update')),
    'branch labels refresh without a core event',
  );
  const directory = join(root, 'other-repo');
  await mkdir(directory);
  execFileSync('git', ['init', '-qb', 'side-branch', directory]);
  execFileSync('git', [
    '-C',
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'Nested fixture',
  ]);
  const moving = await connectSocket(created.terminalId);
  await until(() => moving.messages.some((m) => m.type === 'output'), 'directory test shell');
  moving.ws.send(JSON.stringify({ type: 'input', data: `cd '${directory}'\r` }));
  await until(
    () =>
      metadata.messages.some((m) =>
        m.snapshot?.spaces.some((s) => s.repoName === 'other-repo' && s.name === 'side-branch'),
      ),
    'labels follow terminal directory',
  );
  metadata.messages.length = 0;
  moving.ws.send(JSON.stringify({ type: 'input', data: `cd '${root}'\r` }));
  await until(
    () =>
      metadata.messages.some((m) =>
        m.snapshot?.spaces.some(
          (s) => s.repoName === basename(root) && s.name === 'core-label-update',
        ),
      ),
    'labels return to original checkout',
  );
  moving.ws.close();

  await api(route('action'), {
    action: 'rename-space',
    workspaceId: created.workspaceId,
    name: 'Core workspace',
  });
  await until(
    () =>
      metadata.messages.some((m) => m.snapshot?.spaces.some((s) => s.name === 'Core workspace')),
    'document event',
  );
  const terminal = await connectSocket(created.terminalId);
  await until(() => terminal.messages.some((m) => m.type === 'output'), 'terminal replay');
  terminal.ws.send(JSON.stringify({ type: 'input', data: "printf 'CORE_%s\\n' STREAM\r" }));
  await until(
    () =>
      terminal.messages
        .filter((m) => m.type === 'output')
        .map((m) => m.data)
        .join('')
        .includes('CORE_STREAM'),
    'terminal input',
  );
  terminal.ws.close();
  const reopened = await connectSocket(created.terminalId);
  await until(
    () =>
      reopened.messages
        .filter((m) => m.type === 'output')
        .map((m) => m.data)
        .join('')
        .includes('CORE_STREAM'),
    'terminal survives detach',
  ).catch((error) => {
    console.error(JSON.stringify(reopened.messages));
    throw error;
  });
  await until(
    () => reopened.messages.some((m) => m.type === 'state' && m.state.ready),
    'core shell facts',
  );
  const shellState = reopened.messages.filter((m) => m.type === 'state').at(-1).state;
  const capture = await api(route('reading'), {
    terminalId: created.terminalId,
    command: 'look at printf CORE_READER',
    context: shellState.inputContext,
    cwd: shellState.cwd,
  });
  const read = await fetch(new URL(route('reading/capture') + '&id=' + capture.capture, base), {
    headers: { Authorization: 'Bearer ' + bearer },
  });
  assert.equal(read.ok, true);
  assert.equal(await read.text(), 'CORE_READER');
  const wrongBackend = await fetch(
    new URL(
      route('reading/capture').replace('herdrCore=1', 'herdrCore=0') + '&id=' + capture.capture,
      base,
    ),
    { headers: { Authorization: 'Bearer ' + bearer } },
  );
  assert.equal(wrongBackend.status, 404, 'Reader captures retain their backend');
  reopened.ws.send(
    JSON.stringify({ type: 'command', id: 'stale-command', command: 'false', prompt: 0 }),
  );
  await until(
    () => reopened.messages.some((m) => m.type === 'result' && m.id === 'stale-command'),
    'stale command response',
  );
  assert.equal(
    reopened.messages.find((m) => m.type === 'result' && m.id === 'stale-command').accepted,
    false,
  );

  reopened.ws.send(
    JSON.stringify({
      type: 'repair',
      id: 'cancelled-repair',
      text: 'echo cancelled',
      prompt: shellState.prompt,
      revision: shellState.inputRevision,
    }),
  );
  reopened.ws.send(JSON.stringify({ type: 'repair-cancel', id: 'cancelled-repair' }));
  await until(
    () => reopened.messages.some((m) => m.type === 'repair-result' && m.id === 'cancelled-repair'),
    'cancelled repair response',
  );
  assert.equal(
    reopened.messages.find((m) => m.type === 'repair-result' && m.id === 'cancelled-repair')
      .accepted,
    false,
  );
  const command = "printf 'DICTATED_%s\\n' CORE";
  reopened.ws.send(
    JSON.stringify({
      type: 'dictation-paste',
      text: command,
      applied: false,
      replace: false,
      prompt: shellState.prompt,
      revision: shellState.inputRevision,
    }),
  );
  await until(
    () => reopened.messages.some((m) => m.type === 'repair-result' && m.id !== 'cancelled-repair'),
    'dictation alternatives',
    30000,
  );
  const repaired = reopened.messages.filter((m) => m.type === 'repair-result').at(-1);
  assert.equal(repaired.accepted, true, JSON.stringify(repaired));
  reopened.ws.send(
    JSON.stringify({
      type: 'command',
      id: 'execute-dictation',
      command: repaired.selected,
      prompt: shellState.prompt,
    }),
  );
  await until(
    () => reopened.messages.some((m) => m.type === 'result' && m.id === 'execute-dictation'),
    'dictated command',
  );
  assert.equal(
    reopened.messages.find((m) => m.type === 'result' && m.id === 'execute-dictation').accepted,
    true,
  );
  await until(
    () =>
      reopened.messages
        .filter((m) => m.type === 'output')
        .map((m) => m.data)
        .join('')
        .includes('DICTATED_CORE'),
    'dictated terminal input',
  );
  reopened.ws.close();
  const split = await api(route('action'), {
    action: 'split',
    workspaceId: created.workspaceId,
    terminalId: created.terminalId,
    direction: 'right',
  });
  assert.notEqual(split.terminalId, created.terminalId);
  await api(route('action'), {
    action: 'rename',
    terminalId: split.terminalId,
    name: 'Second terminal',
  });
  assert.ok((await api(route('snapshot'))).terminals.some((t) => t.name === 'Second terminal'));
  await api(route('action'), { action: 'close', terminalId: split.terminalId });
  assert.equal((await api(route('snapshot'))).terminals.length, 1);
  const extra = await api(route('action'), {
    action: 'create',
    workspaceId: created.workspaceId,
    kind: 'shell',
    name: 'Named terminal',
  });
  assert.equal(
    (await api(route('snapshot'))).terminals.find((t) => t.terminalId === extra.terminalId)?.name,
    'Named terminal',
  );
  await api(route('action'), { action: 'close', terminalId: extra.terminalId });
  const subdirectory = join(directory, 'nested');
  await mkdir(subdirectory);
  const changed = await api(route('action'), {
    action: 'split',
    workspaceId: created.workspaceId,
    terminalId: created.terminalId,
    direction: 'right',
  });
  const changedSocket = await connectSocket(changed.terminalId);
  await until(() => changedSocket.messages.some(m => m.type === 'output'), 'moving pane ready');
  changedSocket.ws.send(JSON.stringify({ type: 'input', data: `cd '${subdirectory}'\r` }));
  await until(async () => (await api(route('snapshot'))).terminals.some(t => t.terminalId === changed.terminalId && t.cwd === subdirectory), 'second pane changes repository');
  const changedSource = { workspaceId: created.workspaceId, terminalId: changed.terminalId };
  const changedListing = await api(route('action'), { action: 'list-worktrees', ...changedSource });
  assert.equal(changedListing.source.repo_root, directory, 'Listing uses the selected pane CWD, including subdirectories');
  const changedWorktree = await api(route('action'), { action: 'new-worktree', ...changedSource, branch: 'cwd-test' });
  const changedCheckout = execFileSync('git', ['-C', directory, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  assert.match(changedCheckout, /refs\/heads\/cwd-test/, 'Creation uses the new repository');
  await api(route('action'), { action: 'close', terminalId: changed.terminalId });
  changedSocket.ws.close();
  await assert.rejects(() => api(route('action'), { action: 'list-worktrees', ...changedSource }), /Choose a live terminal/);
  const linkedSource = { workspaceId: changedWorktree.workspaceId, terminalId: changedWorktree.terminalId };
  const linkedListing = await api(route('action'), { action: 'list-worktrees', ...linkedSource });
  assert.equal(linkedListing.source.repo_root, directory, 'Linked checkouts resolve their parent without an open main checkout');
  const firstCheckout = linkedListing.worktrees.find(w => w.branch === 'cwd-test');
  assert.ok(firstCheckout);
  const sibling = await api(route('action'), { action: 'new-worktree', ...linkedSource, branch: 'cwd-sibling' });
  const siblingListing = await api(route('action'), { action: 'list-worktrees', ...linkedSource });
  const siblingCheckout = siblingListing.worktrees.find(w => w.branch === 'cwd-sibling');
  assert.ok(siblingCheckout);
  assert.equal(siblingCheckout.open_workspace_id, sibling.workspaceId);
  assert.equal(siblingCheckout.path, join(root, '.herdr/worktrees/other-repo/cwd-sibling'), 'Linked creation uses the parent repository name');
  await api(route('action'), { action: 'close-space', workspaceId: sibling.workspaceId });
  const reopenedSibling = await api(route('action'), { action: 'open-worktree', ...linkedSource, path: siblingCheckout.path });
  assert.ok(reopenedSibling.workspaceId);
  await api(route('action'), { action: 'delete-worktree', workspaceId: reopenedSibling.workspaceId, path: siblingCheckout.path, force: false });
  await api(route('action'), { action: 'delete-worktree', workspaceId: changedWorktree.workspaceId, path: firstCheckout.path, force: false });
  const worktree = await api(route('action'), {
    action: 'new-worktree',
    workspaceId: created.workspaceId,
    branch: 'core-test',
  });
  const listing = await api(route('action'), {
    action: 'list-worktrees',
    workspaceId: created.workspaceId,
  });
  const checkout = listing.worktrees.find((w) => w.branch === 'core-test');
  assert.ok(checkout);
  assert.equal(checkout.open_workspace_id, worktree.workspaceId);
  await api(route('action'), {
    action: 'move-space',
    workspaceId: worktree.workspaceId,
    beforeWorkspaceId: created.workspaceId,
  });
  assert.equal((await api(route('snapshot'))).spaces[0].id, worktree.workspaceId);
  await api(route('action'), { action: 'close-space', workspaceId: worktree.workspaceId });
  const opened = await api(route('action'), {
    action: 'open-worktree',
    workspaceId: created.workspaceId,
    path: checkout.path,
  });
  await api(route('action'), {
    action: 'delete-worktree',
    workspaceId: opened.workspaceId,
    path: checkout.path,
    force: false,
  });
  assert.ok(
    !(
      await api(route('action'), { action: 'list-worktrees', workspaceId: created.workspaceId })
    ).worktrees.some((w) => w.path === checkout.path),
  );
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519'),
    identity = ssh2.utils.generateKeyPairSync('ed25519', {
      cipher: 'aes256-ctr',
      passphrase: 'fixture-passphrase',
    }),
    sshPort = await freePort();
  await writeFile(join(root, 'host'), hostKey.private, { mode: 0o600 });
  await writeFile(join(root, 'authorized'), identity.public + '\n');
  const config = await sshdConfig(root, sshPort, {
    env: {
      HOME: root,
      PATH: process.env.PATH,
      XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
      XDG_STATE_HOME: env.XDG_STATE_HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    },
  });
  sshd = spawn(sshdPath(), ['-D', '-e', '-f', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  sshd.stderr.on('data', (b) => (logs += b));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const source = await api('api/sessions', {
    files: true,
    name: 'Core SSH',
    ssh: {
      host: '127.0.0.1',
      port: sshPort,
      username: userInfo().username,
      privateKey: identity.private,
      passphrase: 'fixture-passphrase',
      trust: fingerprint(ssh2.utils.parseKey(hostKey.private).getPublicSSH()),
    },
  });
  await api('api/herdr/connect', { core: true, source: source.id, session: coreSession });
  assert.equal(
    (await api(route('snapshot') + '&herdrSource=' + source.id)).spaces[0].name,
    'Core workspace',
  );
  const remote = await connectSocket(created.terminalId, source.id);
  await until(() => remote.messages.some((m) => m.type === 'output'), 'SSH core stream');
  const other = await pair(base, token);
  const denied = await fetch(new URL(route('snapshot') + '&herdrSource=' + source.id, base), {
    headers: { Authorization: 'Bearer ' + other },
  });
  assert.equal(denied.status, 404, 'SSH core connections stay owner-scoped');
  await api('api/sessions/close?session=' + source.id, {});
  await until(() => remote.ws.readyState === WebSocket.CLOSED, 'SSH connection cleanup');
  assert.equal(
    (await api(route('snapshot'))).terminals.length,
    1,
    'Closing SSH leaves core work running',
  );
  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await context.route('**/assets/terminal-*.js', async (route) => {
    const response = await route.fetch(),
      original = await response.text();
    const body = original.replace(
      /new ([\w$]+)\(\{fontSize:/,
      'window.__testTerminal=new $1({fontSize:',
    );
    await route.fulfill({ response, body });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('#backend-token').fill(token);
  await page.locator('#backend-login-form button[type=submit]').click();
  await page.locator('#terminal-stack > iframe').first().waitFor();
  await showTerminalTabs(page);
  await page.locator('#terminal-back').click();
  await page.getByRole('button', { name: /^Terminals for This machine / }).click();
  await page.getByRole('menuitem', { name: 'Connect Herdr Core', exact: true }).click();
  await page.locator('#plugin-herdr-session').fill(coreSession);
  await page.locator('#plugin-connect-form button[type=submit]').click();
  await page
    .locator('.herdr-agent-strip:visible')
    .getByText('Core workspace', { exact: true })
    .waitFor();
  const selectedLabel = page.locator(
    '.herdr-agent-strip:visible .herdr-agent-tab[aria-selected=true] .herdr-space-label',
  );
  assert.equal(await selectedLabel.locator('.herdr-repo-name').textContent(), basename(root));
  assert.equal(await selectedLabel.locator('.herdr-agent-name').textContent(), 'Core workspace');

  async function ready() {
    await until(async () => {
      const handle = await page.locator('.herdr-terminal').first().elementHandle();
      const frame = await handle?.contentFrame();
      return (
        frame &&
        frame.evaluate(
          () =>
            document.querySelector('#connection-label')?.textContent === 'Connected' &&
            !frameElement.inert &&
            frameElement.style.visibility !== 'hidden',
        )
      );
    }, 'visible core terminal');
    return (await page.locator('.herdr-terminal').first().elementHandle()).contentFrame();
  }
  let frame = await ready();
  await frame.locator('#terminal textarea').focus();
  await page.keyboard.type("printf 'BROWSER_%s\\n' CORE");
  await page.keyboard.press('Enter');
  await until(
    () =>
      frame.evaluate(() => {
        const b = window.__testTerminal?.buffer.active;
        return (
          b &&
          Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true))
            .join('\n')
            .includes('BROWSER_CORE')
        );
      }),
    'browser input',
  );
  await page.reload();
  frame = await ready();
  await until(
    () =>
      frame.evaluate(() => {
        const b = window.__testTerminal?.buffer.active;
        return (
          b &&
          Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true))
            .join('\n')
            .includes('BROWSER_CORE')
        );
      }),
    'reloaded output',
  );
  assert.equal((await api(route('snapshot'))).terminals.length, 1, 'Reload keeps shared work');
  await page.setViewportSize({ width: 430, height: 700 });
  await until(
    () =>
      frame.evaluate(
        () =>
          !document.querySelector('#terminal-viewport').classList.contains('awaiting-herdr-layout'),
      ),
    'mobile resize',
  );
  await until(
    () =>
      frame.evaluate(() => {
        const t = window.__testTerminal,
          b = t?.buffer.active;
        return (
          b &&
          Array.from({ length: t.rows }, (_, i) =>
            b.getLine(t.getViewportY() + i)?.translateToString(true),
          )
            .join('\n')
            .includes('BROWSER_CORE')
        );
      }),
    'resized visible output',
  );
  await mkdir('.test-artifacts', { recursive: true });
  await page.screenshot({ path: '.test-artifacts/herdr-core-mobile.png' });
  const treeSplit = await api(route('action'), { action:'split', workspaceId:created.workspaceId, terminalId:created.terminalId, direction:'right' });
  await page.locator('.herdr-agent-strip:visible .herdr-agent-tab[aria-selected=true]').click();
  const paneGroup = page.locator('.herdr-tree:visible .herdr-tree-panes').first();
  await until(() => paneGroup.locator('.herdr-pane').count().then(count => count === 2), 'tree panes');
  await until(async () => (await paneGroup.locator('.herdr-pane-name').allTextContents()).join('|') === '1 · Shell|2 · Shell', 'duplicate shells have distinct compact titles');
  const liveTitle = 'Review the nested backend shutdown and reconnect behavior';
  const titled = await connectSocket(created.terminalId);
  await until(() => titled.messages.some(m => m.type === 'output'), 'title writer ready');
  titled.ws.send(JSON.stringify({ type: 'input', data: `printf '\\033]2;${liveTitle}\\007'; read -r\r` }));
  await until(() => paneGroup.locator('.herdr-pane-name').allTextContents().then(names => names.includes(liveTitle)), 'live OSC title replaces the generic shell name');
  await assertPaneStack(paneGroup);
  await assertPaneTitleRoom(paneGroup, true);
  await page.screenshot({path:'.test-artifacts/herdr-core-tree.png'});
  const taskTitle = 'Inspect reconnect cleanup';
  titled.ws.send(JSON.stringify({ type: 'input', data: `\rprintf '\\033]7501;state=working:app=codex:title=${Buffer.from(taskTitle).toString('base64')}\\007'\r` }));
  await until(() => paneGroup.locator('.herdr-pane-name').allTextContents().then(names => names.includes(taskTitle)), 'agent task titles take precedence over OSC shell titles');
  await api(route('action'), { action:'rename', terminalId:created.terminalId, name:'bash' });
  await until(() => paneGroup.locator('.herdr-pane-name').allTextContents().then(names => names.includes('bash')), 'explicit pane names are preserved');
  const renamed = (await api(route('snapshot'))).terminals.find(t => t.terminalId === created.terminalId);
  assert.equal(renamed.label, 'bash');
  assert.equal(renamed.name, 'bash');
  titled.ws.close();
  const selectedSocket = await connectSocket(treeSplit.terminalId);
  await until(() => selectedSocket.messages.some(m => m.type === 'output'), 'selected pane ready');
  selectedSocket.ws.send(JSON.stringify({ type: 'input', data: `cd '${subdirectory}'\r` }));
  await until(async () => (await api(route('snapshot'))).terminals.some(t => t.terminalId === treeSplit.terminalId && t.cwd === subdirectory), 'selected pane enters another repository');
  await paneGroup.locator('.herdr-pane[data-terminal=' + JSON.stringify(treeSplit.terminalId) + '] .herdr-pane-focus').click();
  await page.locator('.herdr-agent-strip:visible .herdr-agent-tab[aria-selected=true]').click();
  await page.getByRole('button', { name: 'New worktree', exact: true }).click();
  await until(async () => (await page.locator('.herdr-space-action').textContent()).includes(' · ' + directory), 'worktree dialog follows selected pane');
  await page.getByRole('combobox', { name: 'Branch', exact: true }).fill('browser-linked');
  const creationResponse = page.waitForResponse(response => response.url().includes('/api/herdr/action') && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'new-worktree');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const browserCreation = await creationResponse;
  assert.equal(browserCreation.ok(), true);
  assert.equal(browserCreation.request().postDataJSON().terminalId, treeSplit.terminalId);
  const browserLinked = await browserCreation.json();
  await until(async () => await page.locator('.herdr-space-action').count() === 0, 'created worktree selected');
  const unselectedChip = page.locator('.herdr-agent-strip:visible .herdr-agent-tab[aria-selected=false]');
  await until(async () => await unselectedChip.count() === 1 && await unselectedChip.locator('.herdr-agent-name').textContent() === basename(root), 'unselected repository shows its directory instead of its space name');
  assert.equal(await unselectedChip.locator('.herdr-space-label').count(), 0, 'Unselected repositories use one label');
  assert.equal(await selectedLabel.locator('.herdr-repo-name').textContent(), 'other-repo');
  assert.equal(await selectedLabel.locator('.herdr-agent-name').textContent(), 'browser-linked');
  await page.screenshot({ path: '.test-artifacts/herdr-core-strip-labels.png' });
  await api(route('action'), { action: 'close-space', workspaceId: created.workspaceId });
  selectedSocket.ws.close();
  await until(async () => await page.locator('.herdr-terminal:visible').getAttribute('data-terminal') === browserLinked.terminalId && await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').count() === 1, 'only linked checkout remains');
  await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').click();
  for (const name of ['New worktree', 'Open worktree…']) {
    await page.getByRole('button', { name, exact: true }).click();
    await until(async () => (await page.locator('.herdr-space-action').textContent()).includes(' · ' + directory), 'linked checkout resolves parent for ' + name);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (name === 'New worktree') await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').click();
  }
  assert.deepEqual(errors, []);
  await browser.close();
  browser = undefined;
  await api(route('action'), { action: 'close-space', workspaceId: browserLinked.workspaceId });
  assert.equal((await api(route('snapshot'))).spaces.length, 0);
  console.log(
    'Herdr Core: metadata, creation, split, rename, worktrees, close, raw input, dictation alternatives, SSH ownership, detach, mobile UI and reload passed.',
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  for (const ws of sockets) ws.terminate();
  await browser?.close();
  backend?.kill();
  sshd?.kill();
  try {
    execFileSync(hc, ['server', 'stop'], { env, stdio: 'ignore', timeout: 10000 });
  } catch {}
}
