/** Common dismissal and keyboard navigation for workspace popup menus. */
export function menuEvents(menu: HTMLElement, anchor: () => HTMLElement | undefined, close: (focus?: boolean) => void) {
  menu.onkeydown = event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close(true); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target as Node) && !anchor()?.contains(event.target as Node)) close();
  });
  window.addEventListener('resize', () => close());
}
