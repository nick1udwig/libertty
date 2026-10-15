import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(import.meta.dirname, '..', process.env.WIRE_RESULTS_DIR || '.test-artifacts');
for (const [file, profile, variant] of [['transport-selected-fast-final.json','fast','gzip-fast'], ['transport-selected-constrained.json','mobile','gzip'], ['transport-selected-lossy.json','lossy','gzip']]) {
  const { rows } = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  const find = (name, mode) => { const row = rows.find(r => r.profile === profile && r.case === name && r.variant === mode); assert.ok(row, profile + '/' + name + '/' + mode); return row; };
  for (const name of ['typing','random']) {
    const before = find(name,'json'), after = find(name,variant);
    const allowance = (name === 'typing' ? Math.max(1,before.p95Ms*.2) : Math.max(2,before.p95Ms*.05)) + (profile === 'lossy' ? 200 : 0);
    assert.ok(after.p95Ms <= before.p95Ms + allowance, `${profile}/${name}: ${after.p95Ms.toFixed(2)} > ${(before.p95Ms + allowance).toFixed(2)} ms`);
    console.log(`${profile}/${name}: p95 ${before.p95Ms.toFixed(2)} → ${after.p95Ms.toFixed(2)} ms`);
  }
  if (profile !== 'fast') for (const name of ['logs','ansi']) {
    const before = find(name,'json'), after = find(name,variant);
    assert.ok(after.medianMs <= before.medianMs*.75, `${profile}/${name} bulk latency budget`);
    console.log(`${profile}/${name}: median ${before.medianMs.toFixed(2)} → ${after.medianMs.toFixed(2)} ms`);
  }
  if (profile === 'lossy') for (const mode of ['json', variant]) {
    assert.ok(find('typing', mode).stalls > 0, 'The lossy profile must exercise outages');
    assert.ok(find('random', mode).losses > 0, 'The lossy profile must exercise retransmissions');
  }
}
