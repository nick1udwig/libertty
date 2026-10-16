import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { HerdrNotifications as BrowserNotifications } from '../src/herdr-notifications.ts';

test('the push worker displays the directory and full response preview while retaining click routing', async () => {
  const handlers = new Map<string, (event: any) => void>(), shown: any[] = [];
  runInNewContext(await readFile(new URL('../public/push-sw.js', import.meta.url), 'utf8'), { URL, self: {
    location: { href: 'https://libertty.example/t/push-sw.js' },
    addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
    registration: { async showNotification(title: string, options: unknown) { shown.push({ title, options }); } },
  } });
  const tabId = randomUUID(), body = '/workspace/' + 'project-'.repeat(20) + '\nFinished 🙂 ' + 'response '.repeat(40);
  let delivered!: Promise<void>;
  handlers.get('push')!({ data: { json: () => ({ title: 'Review', body, tabId, terminalId: 'term_1' }) }, waitUntil: (work: Promise<void>) => delivered = work });
  await delivered;
  assert.ok(body.length > 200); assert.equal(shown[0].options.body, body);
  assert.equal(shown[0].options.data.tabId, tabId); assert.equal(shown[0].options.data.terminalId, 'term_1');
});

test('closing a connection during browser subscription restoration cannot register an orphan watch', async () => {
  const actions: string[] = []; let finish!: () => void;
  const manager = new BrowserNotifications(async <T>(_id: string, name: string) => { actions.push(name); return {} as T; }, () => {});
  manager.restore = () => new Promise<void>(resolve => finish = resolve); manager.device = () => 'test-device';
  const watch = manager.watch('primary', randomUUID(), '');
  const tab = randomUUID();
  // A separate live watch can still finish normally.
  finish(); await watch; actions.length = 0;
  const pending = manager.watch('primary', tab, ''); await manager.unwatch('primary', tab); finish(); await pending;
  assert.deepEqual(actions, ['api/notifications/unwatch']);
});
