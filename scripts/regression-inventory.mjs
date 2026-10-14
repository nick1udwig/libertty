import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export function rustTestNames(source) {
  return [...source.matchAll(/#\[(?:tokio::)?test\][\s\S]*?\bfn\s+(\w+)\s*\(/g)].map(match => match[1]);
}

// Check harness coverage and Rust test declarations without installing TypeScript.
// The generator's --check also verifies JavaScript test titles using its AST parser.
export async function verifyRegressionInventory(root, files) {
  const inventory = JSON.parse(await readFile(new URL('contracts/regression-inventory.json', root), 'utf8'));
  const stale = 'Regression inventory is stale; run npm run migration:inventory and commit the result.';
  const modules = files.filter(file => /^crates\/.*\/src\/.*\.rs$/.test(file)).sort();
  assert.deepEqual(inventory.modules, modules.map(source => ({ source })), stale);
  const rust = (await Promise.all(files.filter(file => /^crates\/.*\/(?:src|tests)\/.*\.rs$/.test(file)).sort().map(async source => ({
    source, owner: 'rust', assertions: rustTestNames(await readFile(new URL(source, root), 'utf8')),
  })))).filter(entry => entry.assertions.length);
  const browser = files.filter(file => /^test\/.*\.(?:test\.ts|mjs)$/.test(file)).sort().map(source => ({
    source, owner: source.endsWith('.test.ts') ? 'frontend' : 'integration',
  }));
  assert.deepEqual(inventory.tests.map(({ source, owner }) => ({ source, owner })), [...rust, ...browser].map(({ source, owner }) => ({ source, owner })), stale);
  assert.deepEqual(inventory.tests.filter(entry => entry.owner === 'rust'), rust, stale);
}
