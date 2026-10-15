import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const binary = process.env.HERDR_BINARY || 'herdr';
const snapshot = JSON.parse(execFileSync(binary, ['api', 'snapshot'], { encoding: 'utf8' })).result.snapshot;
const pane = process.env.HISTORY_PANE || snapshot.panes.find(pane => pane.agent_status === 'working' && pane.agent)?.pane_id;
if (!pane) throw new Error('Select a running agent with HISTORY_PANE.');
const samples = [], count = Number(process.env.HISTORY_SAMPLES || 67);
let previous;
for (let i = 0; i < count; i++) {
  const began = performance.now();
  const text = execFileSync(binary, ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '1000', '--format', 'ansi'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const json = JSON.stringify({ type: 'screen', text });
  let prefix = 0;
  if (previous) while (prefix < Math.min(previous.length, text.length) && previous[prefix] === text[prefix]) prefix++;
  samples.push({ changed: text !== previous, textBytes: Buffer.byteLength(text), jsonBytes: Buffer.byteLength(json), gzipBytes: gzipSync(json, { level: 1 }).length, prefixDeltaBytes: Buffer.byteLength(text.slice(prefix)), readMs: performance.now() - began });
  previous = text;
  await new Promise(resolve => setTimeout(resolve, 150));
}
const changed = samples.filter(sample => sample.changed);
const sum = key => changed.reduce((total, sample) => total + sample[key], 0);
const report = { measuredAt: new Date().toISOString(), samples: samples.length, changed: changed.length, fullBytes: sum('jsonBytes'), gzipBytes: sum('gzipBytes'), prefixDeltaBytes: sum('prefixDeltaBytes'), minMessageBytes: Math.min(...samples.map(sample => sample.jsonBytes)), maxMessageBytes: Math.max(...samples.map(sample => sample.jsonBytes)), samplesDetail: samples };
await mkdir('.test-artifacts', { recursive: true });
await writeFile('.test-artifacts/herdr-history-measurement.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, samplesDetail: undefined }));
