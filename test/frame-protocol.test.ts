import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalMessage, workspaceMessage } from '../src/frame-protocol.ts';

test('frame commands reject malformed payloads before changing terminal state', () => {
  for (const value of [
    null,
    { type: 'unknown' },
    { type: 'authorize', accessToken: 42 },
    { type: 'tab-visibility', visible: 'false' },
    { type: 'herdr-park', parked: true, preserve: 'true' },
    { type: 'terminal-shortcut', index: -1, kind: 'keys', value: 'Enter' },
    { type: 'terminal-images', files: [{}] },
    { type: 'settings-action', action: 'delete' },
  ]) assert.equal(workspaceMessage(value), undefined);
  for (const value of [
    { type: 'authorize' },
    { type: 'authorize', accessToken: 'a'.repeat(64) },
    { type: 'tab-visibility', visible: false, active: true },
    { type: 'terminal-shortcut', index: 0, kind: 'keys', value: 'Enter' },
    { type: 'terminal-images', files: [new File(['image'], 'image.png')] },
  ]) assert.deepEqual(workspaceMessage(value), value);
});

test('terminal events require session identity and valid geometry and state', () => {
  const state = { cwd: '/tmp', ready: true, exited: false, prompt: 1, promptRevision: 2, inputRevision: 3 };
  for (const value of [
    { type: 'terminal-loaded' },
    { type: 'terminal-rendered', session: 's', presentation: 'p', cols: 0, rows: 24 },
    { type: 'terminal-state', session: 's', state: { ...state, ready: 'true' } },
    { type: 'terminal-state', session: 's', state: { ...state, inputTarget: {} } },
    { type: 'reading-open', session: 's', path: '\0' },
  ]) assert.equal(terminalMessage(value), undefined);
  for (const value of [
    { type: 'terminal-loaded', session: 's' },
    { type: 'terminal-rendered', session: 's', presentation: 'p', cols: 80, rows: 24 },
    { type: 'terminal-state', session: 's', state },
    { type: 'reading-open', session: 's', path: '/tmp/file.txt' },
  ]) assert.deepEqual(terminalMessage(value), value);
});

test('terminal notices normalize actions and preserve status clearing', () => {
  assert.deepEqual(terminalMessage({ type: 'terminal-notice', session: 's', message: 'Retry', actions: [{ id: 'r', label: 'Retry' }, { id: {} }] }), {
    type: 'terminal-notice', session: 's', message: 'Retry', kind: 'error', actions: [{ id: 'r', label: 'Retry' }],
  });
  assert.deepEqual(terminalMessage({ type: 'terminal-status', session: 's' }), {
    type: 'terminal-status', session: 's', status: undefined,
  });
});
