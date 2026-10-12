import test from 'node:test';
import assert from 'node:assert/strict';
import { compoundRepairRecommended } from '../src/compound-repair.ts';
import type { Snapshot } from '../src/facts.ts';
test('dependent repairs require advertised capability and keep simple inputs local', () => {
  const snapshot = { compoundRepair: true } as Snapshot;
  for (const input of ['Python three hello world dot py myarg food', 'Orchard work space recon cile target VALUE', 'cat ~/docs/my notes dot txt']) {
    assert.equal(compoundRepairRecommended(input, snapshot), true);
    assert.equal(compoundRepairRecommended(input, {} as Snapshot), false);
  }
  for (const input of ['Get in it.', 'Git commit -m "exact message"', 'LSL', 'cd git/pebble-agent']) assert.equal(compoundRepairRecommended(input, snapshot), false);
});
