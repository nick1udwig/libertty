import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyRegressionInventory } from '../scripts/regression-inventory.mjs';

test('quick inventory checks reject missing harnesses and changed Rust test declarations', async t => {
  const directory = await mkdtemp('/tmp/termai-inventory-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = pathToFileURL(directory + '/');
  await mkdir(new URL('contracts/', root));
  await mkdir(new URL('crates/server/src/', root), { recursive: true });
  const rust = 'crates/server/src/example.rs', browser = 'test/browser.mjs';
  const source = '#[test]\nfn initial() {}\n#[tokio::test]\nasync fn async_case() {}\n';
  await writeFile(new URL(rust, root), source);
  const inventory = { modules: [{ source: rust }], tests: [
    { source: rust, owner: 'rust', assertions: ['initial', 'async_case'] },
    { source: browser, owner: 'integration', assertions: [] },
  ] };
  await writeFile(new URL('contracts/regression-inventory.json', root), JSON.stringify(inventory));
  await verifyRegressionInventory(root, [browser, rust]);
  for (const files of [[browser], [rust], [browser, rust, 'test/support/navigation.mjs'], [browser, rust, 'crates/server/src/new.rs']]) {
    await assert.rejects(verifyRegressionInventory(root, files), /Regression inventory is stale/);
  }
  await writeFile(new URL(rust, root), source + '#[test]\nfn new_regression() {}\n');
  await assert.rejects(verifyRegressionInventory(root, [browser, rust]), /Regression inventory is stale/);
  inventory.tests[0].assertions.push('new_regression');
  await writeFile(new URL('contracts/regression-inventory.json', root), JSON.stringify(inventory));
  await verifyRegressionInventory(root, [browser, rust]);
});
