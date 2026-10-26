import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const directory = process.env.TEST_DIAGNOSTICS_DIR || path.join(root, '.test-artifacts/browser', path.basename(process.argv[1], '.mjs') + '-' + process.pid);
const tracked = new WeakSet();

async function bounded(action) {
  let timer;
  try { return await Promise.race([action(), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
  catch (error) { return { error: String(error) }; }
  finally { clearTimeout(timer); }
}

export function trackBrowser(browser) {
  if (tracked.has(browser)) return browser;
  tracked.add(browser);
  let count = 0;
  const contexts = new Map();
  async function trackContext(context) {
    if (contexts.has(context)) return context;
    const target = path.join(directory, 'context-' + ++count);
    await mkdir(target, { recursive: true });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const pages = new Map();
    const trackPage = page => {
      if (pages.has(page)) return;
      const prefix = path.join(target, 'page-' + (pages.size + 1)), events = [];
      const record = value => { events.push(value); if (events.length > 200) events.shift(); };
      page.on('console', message => record({ type: message.type(), text: message.text() }));
      page.on('pageerror', error => record({ type: 'pageerror', text: error.stack || String(error) }));
      page.on('requestfailed', request => record({ type: 'requestfailed', url: request.url(), error: request.failure() }));
      page.on('crash', () => record({ type: 'crash' }));
      let saved;
      const save = () => saved ??= (async () => {
        const frames = [];
        for (const frame of page.frames()) frames.push(await bounded(() => frame.evaluate(() => {
          const terminal = window.__testTerminal || window.__terminal;
          return {
            url: location.href, state: window.__testShellState || window.__shellState || window.__state,
            afterPrompt: window.__testAfterPrompt, visibility: document.visibilityState,
            activeElement: document.activeElement?.outerHTML.slice(0, 1000),
            text: document.body?.innerText.slice(0, 20000),
            copies: window.__copies || window.__clipboardWrites, touches: window.__nativeTouches,
            inputs: window.__inputs || window.__sent?.slice(-80),
            selection: getSelection()?.toString(),
            terminal: terminal && { rows: terminal.rows, cols: terminal.cols, scroll: terminal.getViewportY(), selection: terminal.getSelection() },
          };
        })));
        await bounded(() => page.screenshot({ path: prefix + '.png', timeout: 3000 }));
        await writeFile(prefix + '.json', JSON.stringify({ events, frames }, null, 2) + '\n');
      })();
      pages.set(page, save);
      const close = page.close.bind(page);
      page.close = async (...args) => { await save(); return close(...args); };
    };
    context.on('page', trackPage);
    context.pages().forEach(trackPage);
    let saved;
    const save = () => saved ??= (async () => {
      await Promise.allSettled([...pages.values()].map(savePage => savePage()));
      await bounded(() => context.tracing.stop({ path: path.join(target, 'trace.zip') }));
    })();
    contexts.set(context, save);
    const close = context.close.bind(context);
    context.close = async (...args) => { await save(); return close(...args); };
    return context;
  }
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => trackContext(await newContext(...args));
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    await trackContext(page.context());
    return page;
  };
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    await Promise.allSettled([...contexts.values()].map(save => save()));
    return close(...args);
  };
  return browser;
}
