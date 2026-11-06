import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MountedTabs } from '../src/mounted-tabs.ts';
import type { PluginView } from '../src/plugins.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function view() {
  let disposals = 0;
  const frame = {} as HTMLIFrameElement;
  const plugin: PluginView = {
    element: frame,
    terminal: { frame, frames: [frame], retain: true },
    setVisible() {},
    dispose() { disposals++; },
  };
  return { plugin, frame, get disposals() { return disposals; } };
}

test('mounts coalesce and release their frame and resources exactly once', async () => {
  const mounts = new MountedTabs(), pending = deferred<PluginView>(), created = view();
  let calls = 0, signal: AbortSignal | undefined, attached = 0;
  const create = (abort: AbortSignal) => { calls++; signal = abort; return pending.promise; };
  const first = mounts.mount('tab', create, () => true, () => { attached++; });
  assert.equal(mounts.mount('tab', create, () => true, () => {}), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(mounts.frame('tab'), undefined);
  pending.resolve(created.plugin);
  await first;
  assert.equal(attached, 1);
  assert.equal(mounts.frame('tab'), created.frame);
  assert.deepEqual([...mounts.frames()], [['tab', created.frame]]);
  mounts.unmount('tab'); mounts.unmount('tab');
  assert.equal(signal?.aborted, true);
  assert.equal(created.disposals, 1);
  assert.equal(mounts.views.size, 0);
  assert.deepEqual([...mounts.frames()], []);
});

test('a late mount cannot attach or dispose a replacement with the same tab ID', async () => {
  const mounts = new MountedTabs(), pending = deferred<PluginView>(), old = view(), replacement = view();
  const first = mounts.mount('tab', () => pending.promise, () => true, () => assert.fail('stale attachment'));
  await Promise.resolve();
  mounts.unmount('tab');
  await mounts.mount('tab', async () => replacement.plugin, () => true, () => {});
  pending.resolve(old.plugin);
  await first;
  assert.equal(old.disposals, 1);
  assert.equal(replacement.disposals, 0);
  assert.equal(mounts.views.get('tab'), replacement.plugin);
  assert.equal(mounts.frame('tab'), replacement.frame);
  mounts.unmount('tab');
  assert.equal(replacement.disposals, 1);
});

test('cancelled mounts stop before creation and failed attachments can be retried', async () => {
  const mounts = new MountedTabs();
  const cancelled = mounts.mount('tab', async () => { assert.fail('cancelled creation'); }, () => true, () => {});
  mounts.unmount('tab');
  await cancelled;
  const failed = view();
  await assert.rejects(mounts.mount('tab', async () => failed.plugin, () => true, () => { throw new Error('attach failed'); }), /attach failed/);
  assert.equal(failed.disposals, 1);
  assert.equal(mounts.views.size, 0);
  const retry = view();
  await mounts.mount('tab', async () => retry.plugin, () => true, () => {});
  assert.equal(mounts.views.get('tab'), retry.plugin);
});

test('a tab removed during creation releases the unattached view', async () => {
  const mounts = new MountedTabs(), created = view();
  await mounts.mount('closed', async () => created.plugin, () => false, () => assert.fail('closed attachment'));
  assert.equal(created.disposals, 1);
  assert.equal(mounts.views.size, 0);
});
