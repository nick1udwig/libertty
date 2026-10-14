export async function showTerminalTabs(page) {
  const toggle = page.locator('.herdr-tabs-toggle:visible');
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.locator('#terminal-tabs-drawer').evaluate(async drawer => {
    const header = drawer.querySelector('.terminal-header');
    await Promise.all([...drawer.getAnimations(), ...(header?.getAnimations() || [])].map(animation => animation.finished.catch(() => {})));
  });
}
