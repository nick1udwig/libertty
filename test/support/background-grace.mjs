// Keep real timers running and expose only the twenty-second background deadline.
export async function installBackgroundGrace(context) {
  await context.addInitScript(() => {
    const schedule = window.setTimeout;
    window.__backgroundDeadlines = [];
    window.setTimeout = (callback, delay, ...args) => {
      const id = schedule(callback, delay, ...args);
      if (delay === 20000) window.__backgroundDeadlines.push({ id, callback: () => callback(...args) });
      return id;
    };
    window.__expireBackground = () => {
      const deadline = window.__backgroundDeadlines.pop();
      if (!deadline) throw new Error('No twenty-second background grace was scheduled');
      clearTimeout(deadline.id); deadline.callback();
    };
  });
}
