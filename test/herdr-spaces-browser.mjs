import { launchBrowser, freePort, delay, until as wait } from './support/browser.mjs';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import pty from 'node-pty';
import { herdrRequest, herdrSnapshot } from './support/herdr.ts';

const fixturePort3174 = await freePort();

const root = new URL('../', import.meta.url).pathname, dir = await realpath(await mkdtemp('/tmp/libertty-herdr-spaces-'));
const target = { session: '', socketPath: dir + '/herdr.sock' }, base = 'http://127.0.0.1:' + fixturePort3174;
const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir + '/config', XDG_DATA_HOME: dir + '/data', XDG_STATE_HOME: dir + '/state', HERDR_SOCKET_PATH: target.socketPath, HERDR_SESSION: '', HERDR_ENV: '', SHELL: '/bin/bash', TERM: 'xterm-256color' };
let herdr, desktop, backend, browser;
try {
  await mkdir(dir + '/alpha', { recursive: true }); await mkdir(dir + '/beta project');
  execFileSync('git', ['init', '-b', 'main', dir + '/alpha'], { stdio: 'ignore' });
  await writeFile(dir + '/alpha/tracked.txt', 'Original content');
  execFileSync('git', ['-C', dir + '/alpha', 'add', 'tracked.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir + '/alpha', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir + '/alpha', 'switch', '-c', 'review/existing'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir + '/alpha', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Existing branch commit'], { stdio: 'ignore' });
  const existingBranchCommit = execFileSync('git', ['-C', dir + '/alpha', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', dir + '/alpha', 'switch', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir + '/alpha', 'branch', 'review/other'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir + '/alpha', 'worktree', 'add', '-b', 'existing-review', dir + '/existing-review'], { stdio: 'ignore' });
  herdr = spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', ['server'], { cwd: dir, env, stdio: 'ignore' });
  await wait(async () => { try { await herdrSnapshot(target); return true; } catch { return false; } }, 'isolated Herdr');
  desktop = pty.spawn(process.env.HERDR_BINARY || '/usr/bin/herdr', [], { cwd: dir, env, cols: 150, rows: 45, name: 'xterm-256color' }); desktop.onData(() => {});
  await wait(async () => (await herdrSnapshot(target)).spaces.length > 0, 'desktop startup workspace');
  const startupSpaces = (await herdrSnapshot(target)).spaces;
  const alpha = (await herdrRequest(target, 'workspace.create', { cwd: dir + '/alpha', label: 'Alpha', focus: false })).workspace.workspace_id;
  const beta = (await herdrRequest(target, 'workspace.create', { cwd: dir + '/beta project', label: 'Beta', focus: false })).workspace.workspace_id;
  // The desktop can create its initial workspace before either fixture request.
  for (const space of startupSpaces) await herdrRequest(target, 'workspace.close', { workspace_id: space.id, close_group: false });
  backend = spawn(process.env.TEST_EXECUTABLE || root + 'target/debug/libertty', [], { cwd: root, env: { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(fixturePort3174), LIBERTTY_BASE_PATH: '/', LIBERTTY_ALLOWED_HOSTS: '127.0.0.1', LIBERTTY_ALLOWED_ORIGINS: base, LIBERTTY_DATA_DIR: dir + '/libertty', LIBERTTY_TOKEN: '', LIBERTTY_NO_RC: '1', LIBERTTY_CWD: dir }, stdio: 'ignore' });
  await wait(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'isolated backend');
  const token = (await readFile(dir + '/libertty/pairing-token', 'utf8')).trim();
  browser = await launchBrowser({ args: ['--use-gl=angle', '--use-angle=gl'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    localStorage.setItem('libertty.voxtype:' + location.origin + '/', 'dismissed');
    if (!localStorage.getItem('libertty.tabs')) {
      const id = crypto.randomUUID();
      localStorage.setItem('libertty.hosts', JSON.stringify([{ id: 'herdr-native', name: 'Herdr', kind: 'herdr', backendId: 'primary' }]));
      localStorage.setItem('libertty.tabs', JSON.stringify([{ id, session: 'default', name: 'Herdr', pluginId:'herdr',pluginVersion:'1', backendId: 'primary', hostId: 'herdr-native' }]));
      localStorage.setItem('libertty.activeTab', JSON.stringify(id));
    }
    // Reordering and stacking need the manual order, because status lanes pause dragging.
    if (!localStorage.getItem('libertty.herdrStripOrder')) localStorage.setItem('libertty.herdrStripOrder', JSON.stringify('manual'));
    document.addEventListener('pointerdown', event => { window.__touchSource = event.target.closest('.herdr-agent-tab')?.dataset.terminal || event.target.id; }, true);
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator('#backend-token').fill(token); await page.locator('#backend-login-form button[type=submit]').click();
  page.setDefaultTimeout(15000);
  // Herdr reports a repository once it has a worktree, and from then on its checkouts share one chip.
  assert.equal((await herdrSnapshot(target)).spaces.find(space => space.id === alpha).repoKey, undefined, 'A repository without worktrees keeps its own space chip');
  let alphaRepo = 'space:' + alpha;
  const inAlpha = new Set([alpha]);
  const chip = id => inAlpha.has(id) ? alphaRepo : 'space:' + id;
  const tab = id => page.locator('.herdr-agent-strip:visible .herdr-agent-tab[data-terminal="' + chip(id) + '"]');
  await tab(alpha).waitFor(); await tab(beta).waitFor();
  assert.equal(await page.locator('#add-tab').count(), 0, 'The duplicate terminal plus is removed');
  const toggle = page.locator('.herdr-agent-strip:visible .herdr-tabs-toggle');
  const cdp = await context.newCDPSession(page), touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x, y, id: 1 }] });
  const swipeBounds = async locator => {
    let rect;
    await wait(async () => { rect = await locator.boundingBox(); return !!rect; }, 'visible swipe target after snapshot refresh');
    return rect;
  };
  const swipeNavigation = async (locator, dx, dy, cancel = false) => {
    const rect = await swipeBounds(locator), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await touch('touchStart', x, y);
    for (const fraction of [.2, .4, .6, 1]) {
      await touch('touchMove', x + dx * fraction, y + dy * fraction);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    await touch(cancel ? 'touchCancel' : 'touchEnd');
  };
  await page.locator('.herdr-terminal').waitFor({ state: 'visible' });
  const sampleDrawer = async () => page.evaluate(() => {
    window.__drawerPaints = [];
    const generation = window.__drawerSample = (window.__drawerSample || 0) + 1, deadline = performance.now() + 1000;
    const sample = () => {
      if (generation !== window.__drawerSample) return;
      const frame = document.querySelector('.herdr-terminal'), drawer = document.querySelector('#terminal-tabs-drawer');
      window.__drawerPaints.push({ terminal: frame.getBoundingClientRect().height, drawer: drawer.getBoundingClientRect().height });
      if (performance.now() < deadline) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const assertDrawer = async () => {
    const paints = await page.evaluate(() => window.__drawerPaints);
    const moving = paints.filter(paint => paint.drawer > 0 && paint.drawer < 44);
    assert.ok(moving.length > 1, 'The drawer moves across multiple paints');
    assert.equal(new Set(moving.map(paint => paint.terminal)).size, 1, 'The terminal keeps one height throughout the drawer animation');
  };
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Herdr starts with one navigation row');
  await wait(async () => await page.locator('#terminal-tabs-drawer').evaluate(el => el.getBoundingClientRect().height) === 0, 'terminal row collapsed');
  assert.equal(await page.locator('#terminal-tabs-drawer').evaluate(el => el.inert), true);
  await sampleDrawer(); await toggle.click();
  await wait(async () => await page.locator('#terminal-tabs-drawer').evaluate(el => el.getBoundingClientRect().height) === 44, 'terminal row revealed');
  const rows = await page.evaluate(() => ({ terminals: document.querySelector('#terminal-header').getBoundingClientRect().bottom, herdr: document.querySelector('.herdr-agent-strip:not([hidden])').getBoundingClientRect().top }));
  assert.equal(rows.terminals, rows.herdr, 'The terminal row opens directly above Herdr');
  assert.equal(await toggle.getAttribute('aria-label'), 'Hide terminal tabs');
  await assertDrawer();
  await page.screenshot({ path: '/tmp/libertty-herdr-tabs-expanded.png' });
  await sampleDrawer(); await toggle.click();
  await wait(async () => await page.locator('#terminal-tabs-drawer').evaluate(el => el.getBoundingClientRect().height) === 0, 'terminal row tucked behind Herdr');
  await assertDrawer();
  await page.screenshot({ path: '/tmp/libertty-herdr-tabs-collapsed.png' });
  const drawerHeight = () => page.locator('#terminal-tabs-drawer').evaluate(el => el.getBoundingClientRect().height);
  const selectedBeforeSwipe = await page.locator('.herdr-agent-strip:visible [aria-selected=true]').getAttribute('data-terminal');
  const swipeTab = tab(selectedBeforeSwipe === chip(beta) ? alpha : beta);
  const tabsBeforeSwipe = await page.locator('#tabs [role=tab]').count();
  const partialSwipe = async (expanded, cancel) => {
    const rect = await swipeBounds(swipeTab), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const geometry = () => page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const drawer = box('#terminal-tabs-drawer'), header = box('#terminal-header'), strip = box('.herdr-agent-strip:not([hidden])');
      return { height: drawer.height, drawerTop: drawer.top, headerTop: header.top, stripTop: strip.top, terminal: box('.herdr-terminal').height };
    });
    const before = await geometry(), direction = expanded ? 1 : -1;
    await touch('touchStart', x, y);
    for (const distance of [12, 24, 16]) {
      await touch('touchMove', x, y + distance * direction);
      const expected = expanded ? 44 - distance : distance;
      await wait(async () => Math.abs((await geometry()).height - expected) < 1, 'drawer follows the finger before release');
      const current = await geometry();
      assert.equal(current.stripTop, before.stripTop, 'Herdr stays stationary while the terminal strip slides behind it');
      assert.equal(current.headerTop, current.drawerTop, 'The terminal row emerges directly from the clipping edge without a second translation');
      assert.equal(current.terminal, before.terminal, 'Dragging never resizes the live terminal');
    }
    if (!expanded) await page.screenshot({ path: '/tmp/libertty-herdr-tabs-dragging.png' });
    await touch(cancel ? 'touchCancel' : 'touchEnd');
    await wait(async () => await drawerHeight() === (expanded ? 44 : 0), 'short or cancelled drag restores its starting state');
    await wait(async () => await page.locator('.herdr-navigation-resizing').count() === 0, 'drag releases its terminal geometry hold');
  };
  await partialSwipe(false, false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await partialSwipe(false, false);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await swipeNavigation(swipeTab, 0, 60); await delay(250);
  assert.equal(await drawerHeight(), 0, 'Downward swipes keep hidden tabs hidden');
  await swipeNavigation(swipeTab, 0, -18); await delay(250);
  assert.equal(await drawerHeight(), 0, 'Small vertical movements do not open the drawer');
  await swipeNavigation(swipeTab, 0, -70, true); await delay(250);
  assert.equal(await drawerHeight(), 0, 'Cancelled swipes do not open the drawer');
  await sampleDrawer(); await swipeNavigation(swipeTab, 0, -70);
  await wait(async () => await drawerHeight() === 44, 'upward Herdr swipe reveals terminal tabs');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true'); await assertDrawer();
  await partialSwipe(true, true);
  assert.equal(await page.locator('.herdr-agent-strip:visible [aria-selected=true]').getAttribute('data-terminal'), selectedBeforeSwipe, 'Swiping an unselected space does not select it');
  assert.equal(await page.locator('.herdr-tab-menu:visible').count(), 0, 'Swiping opens no hold menu');
  await swipeNavigation(swipeTab, 0, -70); await delay(250);
  assert.equal(await drawerHeight(), 44, 'Upward swipes keep revealed tabs visible');
  await sampleDrawer(); await swipeNavigation(swipeTab, 0, 60);
  await wait(async () => await drawerHeight() === 0, 'downward Herdr swipe hides terminal tabs');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); await assertDrawer();
  await swipeNavigation(toggle, 0, -70);
  await wait(async () => await drawerHeight() === 44, 'swiping the arrow reveals tabs without also clicking it');
  await swipeNavigation(page.locator('#tabs .tab-close').first(), 0, 60);
  await wait(async () => await drawerHeight() === 0, 'downward terminal-tab swipe hides terminal tabs');
  assert.equal(await page.locator('#tabs [role=tab]').count(), tabsBeforeSwipe, 'Swiping a close button does not close a terminal tab');
  await swipeNavigation(toggle, 0, -70);
  await wait(async () => await drawerHeight() === 44, 'reveal terminal header for another swipe');
  await swipeNavigation(page.locator('#terminal-back'), 0, 60);
  await wait(async () => await drawerHeight() === 0, 'downward header swipe hides terminal tabs');
  assert.equal(await page.locator('#workspace-navigation').isVisible(), true, 'Swiping the back button does not leave Herdr');
  await swipeTab.press('Enter');
  await wait(async () => await page.locator('.herdr-agent-strip:visible [aria-selected=true]').getAttribute('data-terminal') !== selectedBeforeSwipe, 'keyboard activation still selects a space after swiping');
  await page.locator('.herdr-agent-strip:visible .herdr-agent-tab[data-terminal="' + selectedBeforeSwipe + '"]').click();
  await page.evaluate(() => document.fonts.ready);
  const order = async () => (await herdrSnapshot(target)).spaces.map(space => space.id);
  const stripOrder = () => page.locator('.herdr-agent-strip:visible .herdr-agent-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.terminal));
  const bounds = async id => {
    let rect;
    await wait(async () => {
      rect = await tab(id).evaluate(tab => {
        const strip = tab.closest('.herdr-agent-strip');
        if (!strip || !tab.isConnected) return null;
        const area = strip.getBoundingClientRect(), initial = tab.getBoundingClientRect();
        if (initial.left < area.left) strip.scrollLeft += initial.left - area.left;
        if (initial.right > area.right) strip.scrollLeft += initial.right - area.right;
        const rect = tab.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      return rect !== null;
    }, 'space bounds after subscription refresh');
    return rect;
  };
  const drag = async (source, target, position, cancel = false) => {
    const { from, to } = await page.evaluate(([source, target]) => {
      const bounds = id => { const rect = document.querySelector('.herdr-agent-tab[data-terminal="' + CSS.escape(id) + '"]').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; };
      return { from: bounds(source), to: bounds(target) };
    }, [chip(source), chip(target)]);
    await touch('touchStart', from.x + from.width / 2, from.y + from.height / 2);
    assert.equal(await page.evaluate(() => window.__touchSource), chip(source), 'The native touch starts on the intended space');
    await delay(500); await touch('touchMove', to.x + to.width * position, to.y + to.height / 2);
    const preview = page.locator('.herdr-drop-indicator:visible');
    const mode = position < .25 ? 'before' : position > .75 ? 'after' : 'group';
    assert.equal(await preview.getAttribute('data-drop'), mode);
    assert.equal(await preview.textContent(), mode === 'group' ? 'Group here' : 'Drop here');
    const marker = await preview.boundingBox();
    assert.ok(marker.height >= 80 && marker.y < to.y - 40, 'Space drop preview is visible above the finger');
    await page.screenshot({ path: root + '.test-artifacts/herdr-space-drop-' + mode + '.png' });
    await touch(cancel ? 'touchCancel' : 'touchEnd');
    assert.equal(await page.locator('.herdr-drop-indicator:visible').count(), 0, 'Drop preview clears after release or cancellation');
  };
  await tab(beta).click(); await page.getByRole('button', { name: 'Create space', exact: true }).click();
  await wait(async () => (await order()).length === 3, 'one-tap space creation');
  assert.equal(await page.locator('.herdr-tab-menu:visible, dialog:visible').count(), 0, 'Plus has no menu or form');
  const created = (await order()).find(id => id !== alpha && id !== beta);
  await tab(created).waitFor(); await wait(async () => await tab(created).getAttribute('aria-selected') === 'true', 'new space selected after creation returns');
  const snapshot = await herdrSnapshot(target), newSpace = snapshot.spaces.find(space => space.id === created);
  assert.equal(newSpace.cwd, dir + '/beta project', 'The selected space supplies the directory');
  assert.equal(await page.locator('.herdr-terminal').getAttribute('data-terminal'), newSpace.selectedTerminalId);
  await drag(alpha, created, .9);
  await wait(async () => JSON.stringify(await order()) === JSON.stringify([beta, created, alpha]), 'edge drop reorders the native spaces');
  await wait(async () => JSON.stringify(await stripOrder()) === JSON.stringify([beta, created, alpha].map(chip)), 'strip receives the native order');
  assert.equal(await page.locator('.herdr-space-stack').count(), 0);
  await drag(alpha, beta, .5);
  await page.locator('.herdr-space-stack').waitFor();
  assert.deepEqual(await page.locator('.herdr-space-stack .herdr-agent-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.terminal)), [chip(beta), chip(alpha)]);
  await page.screenshot({ path: '/tmp/libertty-herdr-spaces.png' });
  await page.getByRole('button', { name: 'Collapse space stack', exact: true }).click(); assert.equal(await tab(alpha).isVisible(), false);
  await page.reload(); await tab(beta).waitFor(); assert.equal(await tab(alpha).isVisible(), false, 'Stack and collapsed state survive reload');
  await page.getByRole('button', { name: 'Expand space stack', exact: true }).click(); await tab(alpha).waitFor();
  const before = await order(); await drag(alpha, created, .1, true); await delay(120);
  assert.deepEqual(await order(), before, 'Cancelling a drag cannot reorder or unstack'); assert.equal(await page.locator('.herdr-space-stack').count(), 1);
  await drag(alpha, created, .1); await wait(async () => (await page.locator('.herdr-space-stack').count()) === 0, 'edge drop extracts a space from its stack');
  await tab(beta).click();
  await wait(async () => await tab(beta).getAttribute('aria-selected') === 'true', 'selected Beta space');
  const tree = page.locator('.herdr-tree:visible'), bridge = page.locator('.herdr-tree-bridge:visible');
  // Snapshots re-render the strip and tree, so a measurement can briefly find a replaced element.
  const box = async locator => { let rect; await wait(async () => !!(rect = await locator.boundingBox()), 'element bounds'); return rect; };
  const press = async (locator, duration = 500) => { const rect = await box(locator); await touch('touchStart', rect.x + rect.width / 2, rect.y + rect.height / 2); await delay(duration); await touch('touchEnd'); };
  const rect = await bounds(beta); await touch('touchStart', rect.x + rect.width / 2, rect.y + rect.height / 2);
  assert.equal(await page.evaluate(() => window.__touchSource), chip(beta)); await delay(500); await touch('touchEnd');
  await tree.waitFor();
  const treeBounds = await box(tree), chipBounds = await box(tab(beta)), bridgeBounds = await box(bridge);
  assert.ok(treeBounds.y + treeBounds.height < chipBounds.y, 'The space tree opens upward above its chip');
  assert.ok(Math.abs(bridgeBounds.x - chipBounds.x) < 1 && Math.abs(bridgeBounds.width - chipBounds.width) < 1 && bridgeBounds.y <= treeBounds.y + treeBounds.height && bridgeBounds.y + bridgeBounds.height >= chipBounds.y, 'The bridge joins the tree to its chip');
  assert.equal(await tab(beta).evaluate(el => el.classList.contains('herdr-tree-anchor')), true);
  await page.screenshot({ path: root + '.test-artifacts/herdr-space-tree-beta.png' });
  // Holding a name renames it in place, and the tree stays open afterwards.
  await press(tree.getByRole('button', { name: 'Open Beta, the current space. Hold to rename.', exact: true }));
  const spaceName = tree.getByLabel('Space name', { exact: true }); await spaceName.fill('Review'); await spaceName.press('Enter');
  await wait(async () => (await herdrSnapshot(target)).spaces.find(space => space.id === beta)?.name === 'Review', 'shared space rename');
  await tree.getByRole('button', { name: 'Open Review, the current space. Hold to rename.', exact: true }).waitFor();
  const betaPane = (await herdrSnapshot(target)).spaces.find(space => space.id === beta).terminalIds[0];
  await press(tree.locator('.herdr-pane[data-terminal="' + betaPane + '"] .herdr-pane-focus'));
  const paneName = tree.getByLabel('Pane name', { exact: true }); await paneName.fill('Review shell'); await paneName.press('Escape');
  assert.equal(await tree.count(), 1, 'Escape cancels a rename without closing the tree');
  await press(tree.locator('.herdr-pane[data-terminal="' + betaPane + '"] .herdr-pane-focus'));
  await paneName.fill('Review shell'); await tree.getByRole('button', { name: 'Save name', exact: true }).click();
  await wait(async () => (await herdrSnapshot(target)).terminals.find(terminal => terminal.terminalId === betaPane)?.name === 'Review shell', 'shared pane rename');
  await page.keyboard.press('Escape'); await tab(beta).click(); await tree.waitFor();
  const hold = async id => {
    if (await page.locator('.herdr-tab-menu:visible').count()) await page.keyboard.press('Escape');
    const rect = await bounds(id); await touch('touchStart', rect.x + rect.width / 2, rect.y + rect.height / 2); await delay(500); await touch('touchEnd'); await tree.waitFor();
  };
  const treeAction = name => tree.getByRole('button', { name, exact: true }).click();
  const selected = () => page.locator('.herdr-agent-strip:visible [aria-selected=true]').getAttribute('data-terminal');
  const dismissMenu = async (x, y) => {
    await touch('touchStart', x, y); await touch('touchEnd');
    assert.equal(await page.locator('.herdr-tab-menu:visible').count(), 0, 'Tapping outside closes the space tree');
    assert.equal(await page.locator('.herdr-menu-backdrop:visible').count(), 0, 'Dismissal restores access to the screen');
    assert.equal(await bridge.count(), 0, 'Dismissal removes the bridge');
  };
  const terminalBounds = await page.locator('.herdr-terminal:visible').boundingBox();
  await dismissMenu(terminalBounds.x + terminalBounds.width / 2, terminalBounds.y + 20);
  for (const target of [() => bounds(beta), () => toggle.boundingBox()]) {
    await hold(beta);
    const rect = await target(); await dismissMenu(rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert.equal(await selected(), chip(beta), 'The dismissing tap does not activate another control');
  }
  // Tapping another chip while a tree is open moves the tree to that chip without selecting it.
  await hold(beta); const alphaRect = await bounds(alpha);
  await touch('touchStart', alphaRect.x + alphaRect.width / 2, alphaRect.y + alphaRect.height / 2); await touch('touchEnd');
  await wait(async () => await tab(alpha).evaluate(el => el.classList.contains('herdr-tree-anchor')), 'the tree moves to the tapped chip');
  assert.equal(await tree.count(), 1); assert.equal(await tab(beta).evaluate(el => el.classList.contains('herdr-tree-anchor')), false);
  assert.equal(await selected(), chip(beta), 'Moving the tree keeps the selection');
  await page.keyboard.press('Escape');
  await hold(beta); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.herdr-menu-backdrop:visible').count(), 0, 'Escape also removes the dismissal layer');
  const swipeTree = async distance => {
    const grab = await box(tree.locator('.herdr-tree-grabber')), x = grab.x + grab.width / 2, y = grab.y + grab.height / 2;
    await touch('touchStart', x, y);
    for (const fraction of [.25, .5, 1]) await touch('touchMove', x, y + distance * fraction);
    await touch('touchEnd');
  };
  await hold(beta); await swipeTree(30);
  assert.equal(await tree.count(), 1, 'A short swipe returns the tree');
  await swipeTree(120); await wait(async () => await tree.count() === 0, 'swiping down dismisses the tree');
  assert.equal(await selected(), chip(beta), 'Swiping the tree away keeps the selection');
  await hold(alpha); await treeAction('New worktree'); await page.getByLabel('Branch', { exact: true }).waitFor();
  const branch = page.getByRole('combobox', { name: 'Branch', exact: true }), branchList = page.getByRole('listbox', { name: 'Existing branches', exact: true });
  await branchList.getByRole('option', { name: 'review/existing', exact: true }).waitFor();
  assert.equal(await branchList.getByRole('option', { name: 'main Already checked out', exact: true }).isDisabled(), true);
  await branch.fill('REVIEW/');
  assert.deepEqual(await branchList.getByRole('option').allTextContents(), ['review/existing', 'review/other'], 'Existing branches filter as the user types, ignoring case');
  await branch.fill('review/ex'); await branch.press('ArrowDown'); await branch.press('Enter');
  assert.equal(await branch.inputValue(), 'review/existing');
  assert.equal(await branch.getAttribute('aria-expanded'), 'false');
  await branch.fill('main');
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).isDisabled(), true, 'A checked-out branch cannot create a second checkout');
  await branch.fill('review/'); await page.screenshot({ path: root + '.test-artifacts/herdr-worktree-branch-suggestions.png' });
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await selected(), chip(beta), 'Cancelling on an inactive held space preserves selection');
  await hold(beta); await treeAction('New worktree'); await page.locator('.herdr-space-action .form-error').filter({ hasText: /Git|repo/i }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await selected(), chip(beta), 'Discovery failure preserves selection');
  const alphaBefore = (await herdrSnapshot(target)).spaces.find(space => space.id === alpha);
  await hold(alpha); await treeAction('Split a pane in Alpha');
  let splitRequests = 0;
  await page.route('**/api/herdr/action*', async route => {
    if (route.request().postDataJSON()?.action !== 'split') return route.continue();
    splitRequests++; await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Split refused; retry on this host.' }) });
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Split', exact: true }).click();
  await page.locator('.herdr-space-action .form-error').filter({ hasText: 'Split refused' }).waitFor();
  assert.equal(await selected(), chip(beta), 'Split errors preserve the active space');
  await page.unroute('**/api/herdr/action*');
  await page.route('**/api/herdr/action*', async route => {
    if (route.request().postDataJSON()?.action !== 'split') return route.continue();
    splitRequests++; await delay(300); await route.continue();
  });
  await page.getByLabel('Split direction').selectOption('down');
  await page.locator('.herdr-space-action form').evaluate(form => { form.requestSubmit(); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await page.locator('.herdr-space-action').waitFor({ state: 'detached' });
  assert.equal(splitRequests, 2, 'Only one successful split request despite duplicate form submission');
  await page.unroute('**/api/herdr/action*');
  const alphaSplit = (await herdrSnapshot(target)).spaces.find(space => space.id === alpha);
  assert.equal(alphaSplit.terminalIds.length, alphaBefore.terminalIds.length + 1, 'A real split is created in the held space');
  assert.equal(await selected(), chip(beta), 'Splitting an inactive held space preserves selection');
  await tab(alpha).click(); await tab(alpha).click(); await tree.waitFor();
  const newPane = alphaSplit.terminalIds.find(id => !alphaBefore.terminalIds.includes(id));
  await tree.locator('.herdr-pane[data-terminal="' + newPane + '"] .herdr-pane-focus').click();
  await wait(async () => await page.locator('.herdr-terminal:visible').getAttribute('data-terminal') === newPane, 'new split is accessible in the tree');
  await tab(beta).click(); await hold(alpha); await treeAction('New worktree');
  await page.getByLabel('Branch', { exact: true }).fill('mobile-review');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('.herdr-space-action').waitFor({ state: 'detached' });
  const worktreeSpace = (await herdrSnapshot(target)).spaces.find(space => !before.includes(space.id) && space.id !== created);
  assert.ok(worktreeSpace, 'Worktree creation adds a shared native space');
  assert.ok(worktreeSpace.repoKey?.endsWith('/alpha/.git'), 'The worktree reports its repository');
  await wait(async () => (await herdrSnapshot(target)).spaces.find(space => space.id === alpha).repoKey === worktreeSpace.repoKey, 'root checkout joins its repository');
  alphaRepo = 'repo:' + worktreeSpace.repoKey; inAlpha.add(worktreeSpace.id);
  assert.match(execFileSync('git', ['-C', dir + '/alpha', 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }), /refs\/heads\/mobile-review/);
  // The worktree joins the repository chip, which names its current checkout.
  await wait(async () => await selected() === alphaRepo, 'new worktree selected in its repository chip');
  assert.equal(await page.locator('.herdr-agent-strip:visible .herdr-agent-tab[data-terminal^="space:' + worktreeSpace.id + '"]').count(), 0, 'The worktree has no chip of its own');
  assert.equal(await tab(alpha).locator('.herdr-repo-name').textContent(), 'alpha · 2');
  assert.equal(await tab(alpha).locator('.herdr-agent-name').textContent(), worktreeSpace.name);
  await tab(alpha).click(); await tree.waitFor();
  assert.deepEqual(await tree.locator('.herdr-tree-node').evaluateAll(nodes => nodes.map(node => [node.dataset.space, node.parentElement.classList.contains('herdr-tree-kids')])), [[alpha, false], [worktreeSpace.id, true]], 'The tree nests the worktree under its root checkout');
  await page.screenshot({ path: root + '.test-artifacts/herdr-space-tree.png' });
  await treeAction('Split a pane in ' + worktreeSpace.name);
  await page.getByRole('dialog').getByRole('button', { name: 'Split', exact: true }).click();
  await page.locator('.herdr-space-action').waitFor({ state: 'detached' });
  const worktreeSplit = (await herdrSnapshot(target)).spaces.find(space => space.id === worktreeSpace.id);
  assert.equal(worktreeSplit.terminalIds.length, worktreeSpace.terminalIds.length + 1, 'A real split is created in the worktree space');
  assert.equal(await selected(), alphaRepo, 'Splitting preserves the active repository');
  const worktreePane = worktreeSplit.terminalIds.find(id => !worktreeSpace.terminalIds.includes(id));
  await tab(alpha).click(); await tree.locator('.herdr-pane[data-terminal="' + worktreePane + '"] .herdr-pane-focus').click();
  await wait(async () => await page.locator('.herdr-terminal:visible').getAttribute('data-terminal') === worktreePane, 'worktree split is accessible in the tree');
  // Closing a pane keeps the tree open and the selection in the same space.
  await tab(alpha).click(); await tree.locator('.herdr-pane[data-terminal="' + worktreePane + '"] .herdr-pane-close').click();
  await wait(async () => !(await herdrSnapshot(target)).spaces.find(space => space.id === worktreeSpace.id).terminalIds.includes(worktreePane), 'pane closed on the server');
  await wait(async () => await tree.locator('.herdr-pane[data-terminal="' + worktreePane + '"]').count() === 0, 'closed pane leaves the tree');
  assert.equal(await tree.count(), 1, 'Closing a pane keeps the tree open');
  await wait(async () => await page.locator('.herdr-terminal:visible').getAttribute('data-terminal') === worktreeSpace.terminalIds[0], 'selection stays in the worktree space');
  const closeFromTree = async space => {
    if (!await tree.count()) await hold(space.id);
    await tree.locator('.herdr-tree-node[data-space="' + space.id + '"] > .herdr-tree-head .herdr-tree-close').click();
    return page.getByRole('dialog', { name: 'Close ' + space.name + '?' });
  };
  const closing = await closeFromTree(worktreeSpace);
  assert.match(await closing.textContent(), /The checkout stays on disk/);
  await closing.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok((await order()).includes(worktreeSpace.id), 'Cancelling the close dialog keeps the worktree space');
  const deleteFromTree = async space => (await closeFromTree(space)).getByRole('button', { name: 'Delete checkout…', exact: true }).click();
  await deleteFromTree(worktreeSpace);
  const deletion = page.getByRole('dialog', { name: 'Delete worktree checkout?' });
  const checkout = worktreeSpace.checkoutPath;
  assert.ok(checkout && checkout !== dir + '/alpha');
  assert.equal(await deletion.locator('.herdr-checkout-path').textContent(), checkout);
  assert.match(await deletion.textContent(), /The branch is not deleted\. The Herdr workspace will close\./);
  const forceDelete = deletion.getByRole('button', { name: 'Force delete', exact: true });
  assert.equal(await forceDelete.isVisible(), false, 'Force deletion is unavailable before a force-required refusal');
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await access(checkout);
  assert.ok((await order()).includes(worktreeSpace.id), 'Cancel preserves the checkout and workspace');
  await writeFile(checkout + '/uncommitted.txt', 'Keep this change');
  await writeFile(checkout + '/tracked.txt', 'Modified content');
  await deleteFromTree(worktreeSpace);
  const denyDelete = async route => {
    if (route.request().postDataJSON()?.action !== 'delete-worktree') return route.continue();
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Permission denied while deleting checkout.' }) });
  };
  await page.route('**/api/herdr/action*', denyDelete);
  await deletion.getByRole('button', { name: 'Delete worktree checkout', exact: true }).click();
  await deletion.locator('.form-error').filter({ hasText: 'Permission denied' }).waitFor();
  assert.equal(await forceDelete.isVisible(), false, 'Unrelated errors do not offer force deletion');
  await page.unroute('**/api/herdr/action*', denyDelete);
  await deletion.getByRole('button', { name: 'Delete worktree checkout', exact: true }).click();
  await deletion.locator('.form-error').filter({ hasText: /--force/ }).waitFor();
  await forceDelete.waitFor({ state: 'visible' });
  assert.match(await deletion.textContent(), /Force delete permanently discards modified and untracked files/);
  await access(checkout + '/uncommitted.txt');
  assert.equal(await readFile(checkout + '/tracked.txt', 'utf8'), 'Modified content');
  assert.ok((await order()).includes(worktreeSpace.id), 'Refused deletion preserves the workspace');
  const modalBounds = await deletion.boundingBox();
  for (const button of await deletion.getByRole('button').all()) {
    const bounds = await button.boundingBox();
    assert.ok(bounds.x >= modalBounds.x && bounds.x + bounds.width <= modalBounds.x + modalBounds.width, 'Deletion buttons fit the mobile dialog');
  }
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await access(checkout + '/uncommitted.txt');
  await deleteFromTree(worktreeSpace);
  assert.equal(await forceDelete.isVisible(), false, 'Reopening the dialog requires a fresh force-required refusal');
  await deletion.getByRole('button', { name: 'Delete worktree checkout', exact: true }).click();
  await forceDelete.waitFor({ state: 'visible' });
  let deletes = 0;
  await page.route('**/api/herdr/action*', async route => {
    if (route.request().postDataJSON()?.action !== 'delete-worktree') return route.continue();
    assert.equal(route.request().postDataJSON().force, true, 'Only an explicit Force delete submits force');
    deletes++; await delay(300); await route.continue();
  });
  await deletion.locator('form').evaluate(form => {
    const submitter = [...form.querySelectorAll('button')].find(button => button.textContent === 'Force delete');
    form.requestSubmit(submitter); form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
  });
  await deletion.waitFor({ state: 'detached' });
  assert.equal(deletes, 1, 'Duplicate force submits remove the checkout once');
  await page.unroute('**/api/herdr/action*');
  assert.equal(await access(checkout).then(() => true, () => false), false, 'Deletion removes the checkout folder');
  assert.equal((await order()).includes(worktreeSpace.id), false, 'Deletion closes the Herdr workspace');
  execFileSync('git', ['-C', dir + '/alpha', 'show-ref', '--verify', 'refs/heads/mobile-review']);
  await tab(beta).click();
  await wait(async () => await page.locator('.herdr-terminal:visible').getAttribute('data-terminal') === (await herdrSnapshot(target)).spaces.find(space => space.id === beta).selectedTerminalId, 'Beta terminal presented after checkout deletion');
  const added = async previous => { let space; await wait(async () => { space = (await herdrSnapshot(target)).spaces.find(space => !previous.includes(space.id)); return !!space; }, 'new worktree space'); inAlpha.add(space.id); return space; };
  let previous = await order();
  await hold(alpha); await treeAction('New worktree'); await branch.fill('review/ex');
  await branchList.getByRole('option', { name: 'review/existing', exact: true }).click();
  assert.equal(await branch.inputValue(), 'review/existing');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('.herdr-space-action').waitFor({ state: 'detached' });
  const existingBranchSpace = await added(previous);
  assert.equal(execFileSync('git', ['-C', existingBranchSpace.checkoutPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), existingBranchCommit, 'Selecting a suggestion checks out the existing branch commit rather than recreating it from HEAD');
  await deleteFromTree(existingBranchSpace);
  await page.getByRole('dialog', { name: 'Delete worktree checkout?' }).getByRole('button', { name: 'Delete worktree checkout', exact: true }).click();
  await page.locator('.herdr-space-action').waitFor({ state: 'detached' });
  previous = await order();
  await hold(alpha); await treeAction('Open worktree…');
  await page.getByLabel('Worktree', { exact: true }).selectOption(dir + '/existing-review');
  await page.getByRole('dialog').getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('.herdr-space-action').waitFor({ state: 'detached' });
  const openedSpace = await added(previous);
  assert.equal((await herdrSnapshot(target)).spaces.find(space => space.id === openedSpace.id)?.cwd, dir + '/existing-review');
  await tab(created).click(); await wait(async () => await tab(created).getAttribute('aria-selected') === 'true', 'selected created space');
  const closingTerminal = (await herdrSnapshot(target)).terminals.find(terminal => terminal.workspaceId === created)?.terminalId;
  await wait(async () => await page.locator('.herdr-terminal:visible').count() === 1 && await page.locator('.herdr-terminal:visible').getAttribute('data-terminal') === closingTerminal, 'created pane rendered before holding its tab');
  const createdSpace = (await herdrSnapshot(target)).spaces.find(space => space.id === created);
  await (await closeFromTree(createdSpace)).getByRole('button', { name: 'Close space', exact: true }).click();
  await wait(async () => !(await order()).includes(created), 'close removes the native space');
  const navigationSpaces = [];
  // Spaces outside Git keep separate chips, so these overflow the strip.
  for (let i = 0; i < 6; i++) navigationSpaces.push((await herdrRequest(target, 'workspace.create', { cwd: dir + '/beta project', label: 'Navigation ' + i, focus: false })).workspace.workspace_id);
  await wait(async () => await page.locator('.herdr-agent-strip:visible .herdr-agent-tab').count() >= 8, 'overflowing Herdr strip');
  const scrolled = await page.locator('.herdr-agent-strip:visible').evaluate(strip => {
    strip.scrollLeft = strip.scrollWidth;
    return strip.querySelector('.herdr-tabs-toggle').getBoundingClientRect().right <= strip.getBoundingClientRect().left;
  });
  assert.equal(scrolled, true, 'The up/down button scrolls offscreen with the Herdr tabs');
  for (const id of navigationSpaces) await herdrRequest(target, 'workspace.close', { workspace_id: id, close_group: false });
  await page.getByRole('button', { name: 'Show terminal tabs', exact: true }).click();
  await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#herdr-strip').inputValue(), 'spaces'); await page.locator('#herdr-strip').selectOption('agents'); await page.reload(); await page.getByRole('button', { name: 'Show terminal tabs', exact: true }).click(); await page.locator('#terminal-back').click(); await page.locator('#nav-settings').click();
  assert.equal(await page.locator('#herdr-strip').inputValue(), 'agents', 'Explicit agent mode survives reload');
  assert.deepEqual(errors, []);
  console.log('PASS: Herdr and terminal-strip swipes reveal/hide tabs without accidental clicks or intermediate terminal resizes; real Herdr worktrees group under their repository chip, whose attached tree renames, splits, closes, creates and opens checkouts and panes while preserving selection, rejecting duplicate submissions and keeping reorder/stacks.');
} catch (error) {
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: '/tmp/libertty-herdr-spaces-failure.png' }).catch(() => {}); throw error;
} finally {
  await browser?.close(); if (backend) { const exited = once(backend, 'exit'); backend.kill(); await exited; }
  const stopped = herdr && herdr.exitCode === null && herdr.signalCode === null ? once(herdr, 'exit') : null;
  desktop?.kill(); await herdrRequest(target, 'server.stop').catch(() => {}); herdr?.kill(); await stopped;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
