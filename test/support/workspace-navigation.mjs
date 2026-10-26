import assert from 'node:assert/strict';
import { requestTimeout } from '../../src/api.ts';

export async function showTerminalTabs(page) {
  const toggle = page.locator('.herdr-tabs-toggle:visible');
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.locator('#terminal-tabs-drawer').evaluate(async drawer => {
    const header = drawer.querySelector('.terminal-header');
    await Promise.all([...drawer.getAnimations(), ...(header?.getAnimations() || [])].map(animation => animation.finished.catch(() => {})));
  });
}
export async function connectSSH(page) {
  const url = new URL('api/sessions', page.url());
  const connected = page.waitForResponse(response => response.url() === url.href && response.request().method() === 'POST' && response.status() !== 409, {
    timeout: requestTimeout(url) * 2,
  });
  const [response] = await Promise.all([connected, page.locator('#ssh-connect').click()]);
  const result = await response.json();
  assert.equal(response.ok(), true, JSON.stringify(result));
  assert.equal(typeof result.id, 'string', 'SSH connection creates a session');
  await page.locator('#ssh-dialog').waitFor({ state: 'hidden' });
  return result.id;
}
