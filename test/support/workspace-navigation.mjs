export async function showTerminalTabs(page) {
  const toggle = page.locator('.herdr-tabs-toggle:visible');
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
