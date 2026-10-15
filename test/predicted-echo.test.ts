import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EchoPrediction } from '../src/predicted-echo.ts';
import type { ShellState } from '../src/protocol.ts';

function fixture() {
  const screen = { cols: 40, x: 2, row: 10, cells: ['$', ' ', ...Array(38).fill(' ')], visible: true };
  const state: ShellState = { cwd: '/', inputRevision: 0, promptRevision: 0, ready: true, prompt: 1, exited: false, inputTarget: 'shell' };
  let prediction: { x: number; row: number; text: string } | undefined;
  const echo = new EchoPrediction(() => screen, value => { prediction = value ? { x: value.x, row: value.row, text: value.text } : undefined; });
  echo.state(state);
  return { screen, state, echo, painted: () => prediction };
}
test('predicted characters appear immediately and authoritative output confirms each prefix once', () => {
  const f = fixture();
  f.echo.input('abc', f.state, true);
  assert.deepEqual(f.painted(), { x: 2, row: 10, text: 'abc' });
  assert.equal(f.screen.cells[2], ' ', 'Prediction never writes to the terminal buffer');
  f.screen.cells[2] = 'a'; f.screen.x = 3; f.echo.reconcile();
  assert.equal(f.painted()?.text, 'bc');
  assert.equal(f.painted()?.x, 3);
  f.screen.cells.splice(3, 2, 'b', 'c'); f.screen.x = 5; f.echo.reconcile();
  assert.equal(f.painted(), undefined);
  f.echo.input('d', f.state, true);
  assert.equal(f.painted()?.text, 'd');
});
test('unexpected output disables prediction until a new prompt without replaying input', () => {
  const f = fixture();
  f.echo.input('abc', f.state, true);
  f.screen.cells[2] = 'X'; f.screen.x = 3; f.echo.reconcile();
  assert.equal(f.painted(), undefined);
  f.echo.input('more', f.state, true);
  assert.equal(f.painted(), undefined);
  f.state.prompt++; f.echo.input('new', f.state, true);
  assert.equal(f.painted()?.text, 'new');
  f.state.ready = false; f.echo.state(f.state);
  assert.equal(f.painted(), undefined);
});
test('controls, unknown edits, wrapping, programs, scrolling and stale prompts suppress predictions', () => {
  for (const scenario of ['control', 'unknown', 'wrap', 'program', 'scroll', 'revision', 'resize']) {
    const f = fixture();
    if (scenario === 'wrap') f.screen.x = 39;
    if (scenario === 'program') f.state.inputTarget = 'program';
    if (scenario === 'scroll') f.screen.visible = false;
    if (scenario === 'revision') { f.state.prompt++; f.state.inputRevision = 1; }
    f.echo.input(scenario === 'control' ? '\x7f' : 'x', f.state, scenario !== 'unknown');
    if (scenario === 'resize') { f.screen.cols = 30; f.echo.reconcile(); }
    assert.equal(f.painted(), undefined, scenario);
  }
});
