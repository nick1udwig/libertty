import { wireProtocols, encodeWire, encodeAudio, constrainedLink } from './wire.ts';
import { fileClient, saveDownload } from './file-client.ts';
import { transferView } from './transfer-view.ts';
import { Ghostty, Terminal, FitAddon } from 'ghostty-web';
import type { ClientMessage, ServerMessage, ShellState } from './protocol.ts';
import './style.css';
import { backendAccess, rememberBackendAccess, forgetBackendAccess } from './backend-access.ts';
import { Queue } from './queue.ts';
import { ReconnectingSocket } from './reconnecting-socket.ts';
import { TerminalGestures } from './terminal-gestures.ts';
import { TerminalFocus } from './terminal-focus.ts';
import { preserveScrollback } from './terminal-viewport.ts';
import { TerminalProjection } from './terminal-projection.ts';
import { DictationControl } from './dictation.ts';
import { SuggestionClient } from './suggestion-client.ts';
import { InlineSuggestions } from './inline-suggestions.ts';
import { shortcutEditor } from './shortcut-editor.ts';
import { defaults, keySequence, validateShortcuts, type Shortcut } from './shortcuts.ts';
import { readingPhrases } from './reading-request.ts';
const params = new URLSearchParams(location.search);
const embedded = params.get('embedded') === '1' && parent !== window;
const baseURL = new URL(params.get('backend') || document.baseURI);
const session = params.get('session') || 'default';
const herdrTerminal = params.get('herdrTerminal');
let herdrReady = false;
let herdrLayoutPending = false, herdrLayoutMatched = false, herdrLayoutFrame = 0, herdrMobileRendered = false;
let herdrBarrier = false, herdrBarrierReady = true, herdrParkable = false, herdrParked = false, herdrPreserve = false;
let herdrPresentation = '';
let offeredWire: string[] | undefined;
let accessToken: string | undefined = backendAccess(baseURL.href);
function endpoint(name: string) { const url = new URL(name.replace(/^\//, ''), baseURL); if (session !== 'default') url.searchParams.set('session', session); return url; }
function herdrEndpoint(name: string) {
  const url = new URL(name, baseURL);
  for (const key of ['herdrSession', 'herdrSource']) if (params.get(key)) url.searchParams.set(key, params.get(key)!);
  if (herdrTerminal) url.searchParams.set('terminalId', herdrTerminal);
  return url;
}
function notify(type: string, data: object = {}) { if (embedded) parent.postMessage({ type, session, ...data }, location.origin); }
if (embedded) document.documentElement.classList.add('embedded-terminal');
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const transport = new ReconnectingSocket({
  available: () => !document.hidden && (!herdrTerminal || tabVisible) && navigator.onLine,
  protocols: () => wireProtocols(offeredWire),
  prepare: prepareConnection, open: socketOpened, message: socketMessage, close: socketClosed, error: connectionError,
});
let state: ShellState = { cwd: '', inputRevision: 0, promptRevision: 0, ready: false, prompt: 0, exited: false };
let after = 0;
let streamId = '';
let capturedConnection: string | undefined;
let pendingCommand: { id: string } | undefined;
const edits = new Map<string, (accepted: boolean) => void>();
const inputLines = new Map<string, (line?: { text: string; cursor: number }) => void>();
let shortcuts: Shortcut[] = structuredClone(defaults);
try {
  const saved = localStorage.getItem('termai.shortcuts');
  if (saved) shortcuts = validateShortcuts(JSON.parse(saved));
} catch { /* Use defaults when storage is unavailable or stale. */ }
function persist(key: string, value: unknown) {
  try { localStorage.setItem('termai.' + key, JSON.stringify(value)); } catch { toast('Browser storage is unavailable. Settings will last for this page only.'); }
}
const transfersSeen = new Set<string>();
let ctrl = false;
let shortcutState = '';
let toastTimer: ReturnType<typeof setTimeout>;
const queue = new Queue<Extract<ServerMessage, { type: 'output' }>>();
let frameQueued = false;
let tabVisible = true, outputFrame = 0, outputTimer: ReturnType<typeof setTimeout>;
function scheduleDrain() { frameQueued = true; if (embedded && !tabVisible) outputTimer = setTimeout(drain, 16); else outputFrame = requestAnimationFrame(drain); }
function toast(message: string) {
  if (embedded) { notify('terminal-notice', { message }); return; }
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}
function connection(label: string, online = false) {
  $('connection-label').textContent = label;
  $('reconnect-banner').textContent = label === 'Session ended' ? 'This terminal has ended. Open its saved host to reconnect.' : 'Reconnecting to your terminal…';
  $('reconnect-banner').hidden = online || label === 'Connecting' || label === 'Locked';
  updateRun();
}
function updateRun() {
  const available = (state.ready || herdrReady) && !state.exited && transport.socket?.readyState === WebSocket.OPEN && !pendingCommand;
  $('shell-status').textContent = state.exited ? 'Exited' : state.ready ? 'At prompt' : 'Running';
  for (const button of document.querySelectorAll<HTMLButtonElement>('.command-shortcut')) button.disabled = !available;
  publishShortcuts(available);
}
function publishShortcuts(available = (state.ready || herdrReady) && !state.exited && transport.socket?.readyState === WebSocket.OPEN && !pendingCommand) {
  if (!embedded) return;
  const snapshot = { shortcuts, ctrl, available }, serialized = JSON.stringify(snapshot);
  if (serialized === shortcutState) return;
  shortcutState = serialized; notify('terminal-shortcuts', snapshot);
}
async function api<T>(url: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint(url), { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { ...(constrainedLink() ? { 'X-Termai-Link': 'constrained' } : {}), ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed'), { status: response.status });
  return result;
}
function send(message: ClientMessage): boolean {
  if (transport.socket?.readyState !== WebSocket.OPEN) return false;
  transport.socket.send(encodeWire(message, transport.socket.protocol)); return true;
}
const fontSizeInput = $<HTMLInputElement>('font-size');
try {
  const saved = JSON.parse(localStorage.getItem('termai.fontSizePt') || 'null');
  if (typeof saved === 'number') fontSizeInput.value = String(saved);
} catch { /* Use the default when storage is unavailable or stale. */ }
if (!fontSizeInput.checkValidity()) fontSizeInput.value = fontSizeInput.defaultValue;
const fontFamily = getComputedStyle(document.documentElement).fontFamily;
// Load the font before Ghostty measures cells, in parallel with its WASM.
const [ghostty] = await Promise.all([Ghostty.load(), document.fonts.load(`14px ${fontFamily}`).catch(() => {})]);
const term = new Terminal({ ghostty, fontSize: fontSizeInput.valueAsNumber * 4 / 3, fontFamily,
  scrollback: 5000, cursorBlink: true, smoothScrollDuration: 0,
  theme: { background: '#0c1310', foreground: '#d7e6d9', cursor: '#bbf6b4', selectionBackground: '#3c6242', green: '#bbf6b4', cyan: '#9bcec3', blue: '#92b8d6', yellow: '#e5cf91', red: '#e6a68b' } });
term.open($('terminal'));
const focus = new TerminalFocus(term);
const fit = new FitAddon(); term.loadAddon(fit);
const projection = herdrTerminal ? new TerminalProjection(term, ghostty) : undefined;
const terminalViewport = $('terminal-viewport');
const mobileViewport = matchMedia('(pointer: coarse) and (max-width: 1024px)');
function mobileTerminal() { return !!herdrTerminal && mobileViewport.matches; }
function refreshHerdrFrame() {
  if (herdrReady && transport.socket?.readyState === WebSocket.OPEN && projection?.requestFrame()) send({ type: 'herdr-frame-request' });
}
function fullWidth() { try { return !!herdrTerminal && !mobileTerminal() && JSON.parse(localStorage.getItem('termai.herdrLayout') || 'null') === 'full-width'; } catch { return false; } }
// Keep output outside UI state. Ghostty parses synchronously; its callback is an rAF.
function drain() {
  frameQueued = false;
  let budget = 0, last = after;
  const chunks: string[] = [];
  while (queue.length && budget < 65536) {
    const item = queue.shift()!;
    if (item.seq <= last) continue;
    chunks.push(item.data); last = item.seq; budget += item.data.length;
  }
  if (chunks.length) {
    preserveScrollback(term, () => term.write(chunks.join(''))); after = last;
    send({ type: 'ack', seq: after });
  }
  inline.refresh();
  if (queue.length) scheduleDrain();
}
function sizeTerminal() {
  if (herdrParked) {
    if (!mobileTerminal() && herdrReady) send({ type:'resize', cols:term.cols, rows:term.rows, mobile:false });
    return;
  }
  try {
    const wide = fullWidth();
    if (!mobileTerminal()) { herdrMobileRendered = false; herdrPreserve = false; }
    if (herdrLayoutPending && !mobileTerminal()) { herdrLayoutPending = false; terminalViewport.classList.remove('awaiting-herdr-layout'); }
    terminalViewport.classList.toggle('full-width', wide);
    const element = $('terminal');
    if (wide) {
      const nativeCols = projection?.nativeColumns || 80;
      const metrics = term.renderer!.getMetrics();
      element.style.width = Math.max(terminalViewport.clientWidth, nativeCols * metrics.width + 8 + 15) + 'px';
    } else { element.style.width = '100%'; terminalViewport.scrollLeft = 0; }
    // FitAddon caches its last fit and cannot account for a manual native-width
    // resize. Use its public measurements for both modes, with one resize owner.
    const dimensions = fit.proposeDimensions();
    const nextCols = wide ? projection?.nativeColumns || 80 : dimensions?.cols;
    if (dimensions && nextCols && (term.cols !== nextCols || term.rows !== dimensions.rows)) {
      if (mobileTerminal()) {
        // Keep a certified mobile view and its focused textarea visible while
        // keyboard geometry redraws; hiding the input would dismiss the IME.
        herdrPreserve ||= herdrMobileRendered;
        cancelAnimationFrame(herdrLayoutFrame); herdrLayoutFrame = 0; herdrLayoutPending = true; herdrLayoutMatched = false;
        herdrBarrierReady = !herdrBarrier; terminalViewport.classList.toggle('awaiting-herdr-layout', !herdrPreserve);
      }
      preserveScrollback(term, () => term.resize(nextCols, dimensions.rows));
      notifyHerdrSizing();
    }
    projection?.resize(mobileTerminal());
    // Herdr resolves the selected pane asynchronously after the WS upgrade.
    // Send geometry only after its state acknowledges that the handler is ready.
    if (!herdrTerminal || herdrReady) send({ type: 'resize', cols: term.cols, rows: term.rows, ...(herdrTerminal ? { mobile: mobileTerminal() && tabVisible && !document.hidden } : {}) }); inline.refresh();
    refreshHerdrFrame();
  } catch { /* hidden during layout */ }
}
fontSizeInput.oninput = () => {
  if (!fontSizeInput.checkValidity() || fontSizeInput.valueAsNumber * 4 / 3 === term.options.fontSize) return;
  term.options.fontSize = fontSizeInput.valueAsNumber * 4 / 3;
  sizeTerminal();
  persist('fontSizePt', fontSizeInput.valueAsNumber);
};
fontSizeInput.onchange = () => { fontSizeInput.value = String(term.options.fontSize! * 3 / 4); };
let resizeFrame = 0;
new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(sizeTerminal); }).observe(terminalViewport);
mobileViewport.addEventListener('change', sizeTerminal);
function viewport() { document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`); }
window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport();
function rawInput(data: string) {
  if (herdrTerminal && !herdrReady) { toast('Connecting to the agent. Input was not sent.'); return; }
  if (capturedConnection) { toast('Finish opening the connection first.'); return; }
  if (ctrl) { if (/^[a-zA-Z]$/.test(data)) data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64); setCtrl(false); }
  if (!inline.raw(data)) return;
  if (send({ type: 'input', data })) { state.inputRevision++; term.scrollToBottom(); }
  else toast('Disconnected. Input was not sent.');
}
function replaceLine(text: string): Promise<boolean> {
  if (capturedConnection || !state.ready || state.exited || transport.socket?.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { edits.delete(id); resolve(false); }, 5000);
    edits.set(id, accepted => { clearTimeout(timer); resolve(accepted); });
    send({ type: 'replace', text, id, prompt: state.prompt, revision: state.inputRevision });
    state.inputRevision++; term.scrollToBottom();
  });
}
const suggestions = new SuggestionClient(baseURL.href, session, () => accessToken);
const inline = new InlineSuggestions(term, { latencyKey: baseURL.href, state: () => state, replace: replaceLine,
  readLine: () => {
    const id = crypto.randomUUID(), prompt = state.prompt, revision = state.inputRevision;
    return new Promise(resolve => {
      const timer = setTimeout(() => { inputLines.delete(id); resolve(undefined); }, 3000);
      inputLines.set(id, line => { clearTimeout(timer); resolve(line); });
      if (!send({ type: 'input-line', id, prompt, revision })) { inputLines.get(id)?.(); inputLines.delete(id); }
    });
  },
  suggest: (text, signal) => suggestions.suggest(text, signal), raw: rawInput, execute });
const dictation = new DictationControl({ api, send, state: () => state, key: baseURL.href,
  audio: data => { if (!transport.socket || transport.socket.readyState !== WebSocket.OPEN || transport.socket.bufferedAmount > 256 * 1024) return false; transport.socket.send(encodeAudio(data, transport.socket.protocol)); return true; },
  prepare: () => inline.prepareExternalPaste(), notice: toast, focus: () => term.focus() });
function showReading(request: { path: string } | { capture: string; name: string; exitCode: number }) {
  if (embedded) { notify('reading-open', request); return; }
  const workspace = new URL('.', document.baseURI);
  sessionStorage.setItem('termai.pendingReading:' + workspace.pathname, JSON.stringify({ ...request, session, backendUrl: baseURL.href }));
  location.assign(workspace.href);
}
term.onData(rawInput);
function setCtrl(value: boolean) { ctrl = value; for (const button of document.querySelectorAll('[data-modifier]')) button.setAttribute('aria-pressed', String(value)); publishShortcuts(); }
function renderShortcuts() {
  $('shortcut-buttons').replaceChildren();
  for (const shortcut of shortcuts) {
    const button = document.createElement('button');
    button.textContent = shortcut.label; button.title = shortcut.value;
    button.classList.toggle('command-shortcut', shortcut.kind === 'command');
    if (shortcut.kind === 'keys' && shortcut.value === 'Ctrl') { button.dataset.modifier = ''; button.setAttribute('aria-pressed', String(ctrl)); }
    button.addEventListener('pointerdown', e => e.preventDefault());
    button.onclick = () => {
      if (shortcut.kind === 'command') { execute(shortcut.value); return; }
      if (shortcut.value === 'Ctrl') { setCtrl(!ctrl); term.focus(); return; }
      rawInput(keySequence(shortcut.value)); term.focus();
    };
    $('shortcut-buttons').append(button);
  }
  updateRun();
}
const prepareEditor = shortcutEditor(() => shortcuts, value => { shortcuts = value; persist('shortcuts', shortcuts); setCtrl(false); renderShortcuts(); }, () => $<HTMLDialogElement>('shortcuts-dialog').close());
$('customize-shortcuts').onclick = () => { $<HTMLDialogElement>('options-dialog').close(); prepareEditor(); $<HTMLDialogElement>('shortcuts-dialog').showModal(); };
renderShortcuts();
function applySettings() {
  try {
    const font = JSON.parse(localStorage.getItem('termai.fontSizePt') || '10');
    if (typeof font === 'number') { fontSizeInput.value = String(font); fontSizeInput.dispatchEvent(new Event('input')); }
    for (const [id, value] of [['auto-alternatives', localStorage.getItem('termai.autoAlternatives') !== 'false' && localStorage.getItem('termai.justRun') !== 'true'], ['tap-alternate-send', localStorage.getItem('termai.tapAlternateSend') !== 'false']] as const) {
      const setting = $<HTMLInputElement>(id); if (setting.checked !== value) { setting.checked = value; setting.dispatchEvent(new Event('change')); }
    }
    const next = validateShortcuts(JSON.parse(localStorage.getItem('termai.shortcuts') || JSON.stringify(defaults)));
    if (JSON.stringify(next) !== JSON.stringify(shortcuts)) { shortcuts = next; setCtrl(false); renderShortcuts(); }
    inline.setReadingPhrases(JSON.parse(localStorage.getItem('termai.readingPhrases') || 'null'));
    sizeTerminal();
  } catch { /* Keep valid settings if stored data is unavailable or malformed. */ }
}
window.addEventListener('storage', event => { if (event.key === null || ['termai.herdrLayout', 'termai.fontSizePt', 'termai.autoAlternatives', 'termai.tapAlternateSend', 'termai.shortcuts', 'termai.readingPhrases', 'termai.justRun'].includes(event.key)) applySettings(); });
function copyTerminalText(text: string) {
  // Clipboard access needs a focused document. Focus the frame itself without
  // enabling its textarea or opening the software keyboard after a gesture.
  window.focus(); return navigator.clipboard.writeText(text);
}
const gestures = new TerminalGestures(term, {
  focus,
  pan: { enabled: () => fullWidth() && terminalViewport.scrollWidth > terminalViewport.clientWidth, move: pixels => { terminalViewport.scrollLeft += pixels; } },
  scroll: {
    enabled: () => mobileTerminal() && herdrReady && state.terminalScroll === true && tabVisible && !document.hidden && term.buffer.active.length <= term.rows,
    move: (lines, x, y) => {
      const bounds = term.element!.querySelector('canvas')!.getBoundingClientRect();
      const column = Math.max(0, Math.min(term.cols - 1, Math.floor((x - bounds.left) * term.cols / bounds.width)));
      const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - bounds.top) * term.rows / bounds.height)));
      send({ type: 'terminal-scroll', lines: Math.max(-100, Math.min(100, lines)), column, row });
    },
  },
  tap: (x, y) => { if (!queue.length && !capturedConnection) inline.moveCursor(x, y); }, copy: copyTerminalText,
});

async function socketURL(signal: AbortSignal) {
  const socketURL = herdrTerminal ? herdrEndpoint('herdr/ws') : endpoint('ws');
  if (herdrTerminal) {
    sizeTerminal();
    const geometry = { cols: term.cols, rows: term.rows, mobile: mobileTerminal() && tabVisible && !document.hidden };
    cancelAnimationFrame(herdrLayoutFrame); herdrLayoutFrame = 0; herdrLayoutMatched = false;
    herdrPreserve = false; herdrMobileRendered = false;
    herdrLayoutPending = geometry.mobile;
    terminalViewport.classList.toggle('awaiting-herdr-layout', herdrLayoutPending && !herdrParked);
    const response = await fetch(herdrEndpoint('api/herdr/ticket'), { method: 'POST', credentials: 'same-origin', headers: { ...(constrainedLink() ? { 'X-Termai-Link': 'constrained' } : {}), ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(geometry), signal });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    herdrBarrier = result.redrawBarrier === true; herdrBarrierReady = !herdrBarrier; herdrParkable = result.parkViews === true;
    socketURL.searchParams.set('ticket', result.ticket); offeredWire = result.wire;
  } else if (baseURL.origin !== location.origin) socketURL.searchParams.set('ticket', (await api<{ ticket: string }>('/api/ticket', {}, signal)).ticket);
  socketURL.protocol = baseURL.protocol === 'https:' ? 'wss:' : 'ws:'; socketURL.searchParams.set('after', String(after));
  if (streamId) socketURL.searchParams.set('stream', streamId);
  return socketURL;
}
async function prepareConnection(signal: AbortSignal, token?: string) {
  const result = await api<{ state?: ShellState; accessToken: string; wire?: string[] }>('/api/connect', { ...(herdrTerminal ? { noSession: true } : { session }), ...(token ? { token } : {}) }, signal);
  signal.throwIfAborted(); offeredWire = result.wire;
  if (result.state) state = result.state; accessToken = result.accessToken; notify('terminal-authorized', { accessToken });
  rememberBackendAccess(baseURL.href, accessToken);
  $<HTMLInputElement>('token').value = '';
  $<HTMLDialogElement>('login-dialog').close(); $('login-error').textContent = '';
  return socketURL(signal);
}
function socketOpened() {
  if (herdrTerminal) { herdrReady = false; state.inputRevision = 0; state.inputTarget = undefined; connection('Connecting'); }
  else { connection('Connected', true); notify('terminal-ready'); dictation.connected(true); }
  sizeTerminal();
  if (herdrParked && herdrParkable) send({ type:'herdr-active', active:false });
}
function revealHerdrLayout() {
  if (herdrLayoutFrame || !herdrLayoutPending || !herdrLayoutMatched || !herdrBarrierReady) return;
  const socket = transport.socket;
  const presentation = herdrPresentation;
  const cols = term.cols, rows = term.rows;
  projection?.paintBaseline();
  const reveal = () => {
    herdrLayoutFrame = 0;
    if (transport.socket !== socket || presentation !== herdrPresentation || term.cols !== cols || term.rows !== rows || !herdrLayoutPending || !herdrLayoutMatched || !herdrBarrierReady || herdrParked) return;
    herdrLayoutPending = false; herdrPreserve = false; herdrMobileRendered = true; terminalViewport.classList.remove('awaiting-herdr-layout');
    send({ type:'herdr-frame-request' }); notifyHerdrRendered(presentation);
  };
  herdrLayoutFrame = requestAnimationFrame(() => { herdrLayoutFrame = requestAnimationFrame(reveal); });
}
function notifyHerdrRendered(presentation = herdrPresentation) {
  if (!herdrLayoutPending && !herdrParked && presentation === herdrPresentation) notify('terminal-rendered', { presentation, cols:term.cols, rows:term.rows });
}
function notifyHerdrSizing() {
  if (herdrTerminal) notify('terminal-sizing', { presentation:herdrPresentation, cols:term.cols, rows:term.rows });
}
function scheduleHerdrRendered() {
  const presentation = herdrPresentation, socket = transport.socket;
  requestAnimationFrame(() => { if (transport.socket === socket) notifyHerdrRendered(presentation); });
}
function socketMessage(event: MessageEvent) {
  const message: ServerMessage = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  if (message.type === 'herdr-layout') {
    if (herdrParked) return;
    if (message.cols !== term.cols || message.rows !== term.rows || !mobileTerminal()) return;
    cancelAnimationFrame(herdrLayoutFrame); herdrLayoutFrame = 0;
    herdrLayoutPending = true; herdrBarrierReady = message.ready; herdrLayoutMatched = false;
    terminalViewport.classList.toggle('awaiting-herdr-layout', !herdrPreserve);
    return;
  }
  if (message.type === 'herdr-frame') {
    if (herdrParked || herdrLayoutPending && herdrPreserve && !herdrBarrierReady) return;
    if (herdrLayoutPending) {
      if (message.width !== term.cols || message.height !== term.rows) {
        herdrLayoutMatched = false; cancelAnimationFrame(herdrLayoutFrame); herdrLayoutFrame = 0; return;
      }
      if (!herdrLayoutMatched && !message.full) return;
      herdrLayoutMatched = true;
    }
    if (projection?.frame(message) && !herdrLayoutPending) scheduleHerdrRendered();
    revealHerdrLayout();
    if (fullWidth()) sizeTerminal(); refreshHerdrFrame(); return;
  }
  if (message.type === 'screen') { if (herdrLayoutPending || herdrParked) return; projection?.update(message.text); if (fullWidth()) sizeTerminal(); refreshHerdrFrame(); scheduleHerdrRendered(); return; }
  if (message.type === 'input-line') {
    const intact = message.prompt === state.prompt && message.revision === state.inputRevision && state.ready;
    inputLines.get(message.id)?.(intact && typeof message.text === 'string' && typeof message.cursor === 'number' ? { text: message.text, cursor: message.cursor } : undefined);
    inputLines.delete(message.id); return;
  }
  if (message.type === 'pasted') {
    if (message.prompt === state.prompt && message.revision === state.inputRevision + 1) {
      state.inputRevision = message.revision;
      term.scrollToBottom();
      inline.externalPaste(message.text, message.replace, message.source === 'dictation');
    }
    else inline.disconnect();
    return;
  }
  if (message.type === 'transfer') {
    if (transfersSeen.has(message.request.id)) return;
    transfersSeen.add(message.request.id); if (transfersSeen.size > 256) transfersSeen.delete(transfersSeen.values().next().value!);
    transferView(message.request, fileClient(baseURL.href, session, () => accessToken, async () => { throw new Error('Reconnect to this backend and try again.'); }),
      () => api('/api/files/transfer', { id: message.request.id, action: 'ack' }),
      () => saveDownload(baseURL.href, () => api('/api/files/transfer', { id: message.request.id, action: 'download' }), message.request.name));
    return;
  }
  if (message.type === 'dictation') { dictation.event(message.id, message.state, message.message); return; }
  if (message.type === 'reading-file') {
    showReading({ path: message.path });
  } else if (message.type === 'reading-capture') {
    showReading({ capture: message.id, name: message.name, exitCode: message.exitCode });
  } else if (message.type === 'reading-error') {
    toast(message.message);
  } else if (message.type === 'ssh-command' || message.type === 'herdr-command') {
    capturedConnection = message.id; inline.disconnect();
    if (embedded) notify(message.type, { id: message.id, command: message.command });
    else if (message.type === 'herdr-command') {
      const workspace = new URL('.', document.baseURI);
      try {
        sessionStorage.setItem('termai.pendingHerdr:' + workspace.pathname, JSON.stringify({ id: message.id, session, backendUrl: baseURL.href }));
        location.assign(workspace.href);
      } catch {
        void api('/api/herdr/captured', { id: message.id, action: 'native' }).then(() => api('/api/herdr/captured', { id: message.id, action: 'ack' })).catch(error => toast(error.message));
      }
    }
    else void api('/api/ssh/captured', { id: message.id, action: 'native' }).then(() => api('/api/ssh/captured', { id: message.id, action: 'ack' })).catch(error => toast(error.message));
  } else if (message.type === 'ssh-released') {
    if (capturedConnection === message.id) capturedConnection = undefined;
  } else if (message.type === 'hello') {
    suggestions.setMode(message.engine);
    inline.setLatencyProfile(baseURL.href + ':' + message.engine);
    streamId = message.streamId;
    // Reset through the terminal parser. Ghostty's reset() frees native memory
    // still referenced by its input and selection handlers.
    if (message.reset) { queue.clear(); after = 0; inline.disconnect(); term.clearSelection(); term.scrollToBottom(); term.write('\x1bc\x1b[3J'); }
    if (message.truncated) {
      term.write('\r\n\x1b[33mOlder output is unavailable. Ctrl-L redraws the current program.\x1b[0m\r\n');
      toast('Reconnected with limited scrollback. Use Ctrl-L to redraw if needed.');
    }
  } else if (message.type === 'output') {
    if (message.seq > after) queue.push(message);
    if (!frameQueued) scheduleDrain();
  } else if (message.type === 'state') {
    transport.ready();
    if (herdrTerminal) { herdrReady = true; sizeTerminal(); connection('Connected', true); notify('terminal-ready', { retainGeometry: herdrParkable }); dictation.connected(true); }
    // A state acknowledgement can arrive after newer local keystrokes were
    // sent. Keep their optimistic revision until the backend catches up.
    message.state.inputRevision = Math.max(state.inputRevision, message.state.inputRevision);
    state = message.state; notify('terminal-state', { state }); $('cwd').textContent = state.cwd; $('cwd').title = state.cwd;
    dictation.prompt();
    updateRun();
    inline.onState(state); suggestions.onState(state.prompt);
  } else if (message.type === 'context') {
    if (message.context.prompt === state.prompt && state.ready) suggestions.updateContext(message);
  } else if (message.type === 'edit-result') {
    edits.get(message.id)?.(message.accepted); edits.delete(message.id);
    if (!message.accepted) state.inputRevision = message.revision;
  } else if (message.type === 'result' && pendingCommand?.id === message.id) {
    pendingCommand = undefined;
    if (!message.accepted) toast(message.message || 'Command was not sent.');
    updateRun();
  }

}
function socketClosed(event?: CloseEvent) {
  herdrReady = false;
  if (event?.code === 4001 || state.exited) inline.disconnect(); else inline.suspend(); suggestions.disconnect();
  dictation.connected(false);
  for (const resolve of edits.values()) resolve(false); edits.clear();
  for (const resolve of inputLines.values()) resolve(); inputLines.clear();
  // Never resend uncertain input or an uncertain command automatically.
  if (pendingCommand) { pendingCommand = undefined; toast('Connection lost before acknowledgement. Check the terminal before running again.'); }
  if (event?.code === 4001) { connection('Other tab'); toast(event.reason); return false; }
  if (embedded && state.exited) return false; // The workspace is replacing this finished shell.
  connection('Reconnecting');
  return true;
}
function connectionError(error: any, token?: string) {
  if (error.status === 401) {
    const attemptedAccessToken = accessToken;
    accessToken = undefined;
    if (backendAccess(baseURL.href) === attemptedAccessToken) forgetBackendAccess(baseURL.href);
    connection('Locked');
    if (embedded) { notify('terminal-locked', { accessToken: attemptedAccessToken }); return false; }
    const dialog = $<HTMLDialogElement>('login-dialog');
    if (!dialog.open) dialog.showModal();
    if (token) $('login-error').textContent = 'That token did not match.';
    return false;
  } else if (error.status === 404) { inline.disconnect(); connection(embedded ? 'Connecting' : 'Session ended'); notify('terminal-ended'); return false; }
  connection('Offline');
  return true;
}
const connect = (token?: string) => transport.connect(token);
$('login-form').onsubmit = e => { e.preventDefault(); void connect($<HTMLInputElement>('token').value); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Dictation may keep the transport alive through lock; geometry still
    // belongs to the desktop while this pane is no longer visible.
    if (herdrTerminal) send({ type: 'resize', cols: term.cols, rows: term.rows, mobile: false });
    // Keep both audio transport and shell input context while dictating through lock.
    if (!dictation.active) { inline.suspend(); transport.suspend(); }
  }
  else { void transport.resume(transport.socket?.readyState !== WebSocket.OPEN); sizeTerminal(); }
});
window.addEventListener('online', () => void transport.resume(true));
window.addEventListener('offline', () => transport.suspend());

function execute(command: string) {
  if (capturedConnection || !state.ready && !herdrReady || state.exited || pendingCommand || transport.socket?.readyState !== WebSocket.OPEN) { toast('Wait for terminal input before running a command.'); return; }
  if (!command.trim() || /[\x00-\x1f\x7f]/.test(command)) { toast('Use one command line at a time.'); return; }
  inline.disconnect();
  const id = crypto.randomUUID(); pendingCommand = { id };
  if (!send({ type: 'command', command, prompt: state.prompt, id })) { pendingCommand = undefined; toast('Disconnected. The command was not sent.'); }
  else { if (herdrReady) state.inputRevision++; term.scrollToBottom(); }
  updateRun();
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close]')) button.onclick = () => $<HTMLDialogElement>(button.dataset.close!).close();
$('menu-button').onclick = () => $<HTMLDialogElement>('options-dialog').showModal();
async function copySelection(text = gestures.text) {
  if (!text) { toast('Select terminal text first.'); return; }
  try { await copyTerminalText(text); toast('Selection copied.'); } catch { toast('Clipboard is unavailable in this browser context.'); }
}
$('copy-selection').onclick = () => void copySelection();
$('new-shell').onclick = async () => {
  if (herdrTerminal) return;
  if (!state.exited && !confirm('End the current session and start a new shell? Running programs in this session will stop.')) return;
  try {
    inline.disconnect(); suggestions.disconnect();
    transport.suspend();
    await api('/api/new', {}); after = 0; queue.clear(); pendingCommand = undefined;
    $<HTMLDialogElement>('options-dialog').close(); await connect();
  } catch (error: any) { toast(error.message); void connect(); }
};
if (!embedded && import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: new URL('.', document.baseURI).pathname }).catch(() => {});
if (embedded) {
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin) return;
    if (event.data?.type === 'shortcut-host') { document.documentElement.classList.add('hosted-shortcuts'); shortcutState = ''; publishShortcuts(); sizeTerminal(); }
    if (event.data?.type === 'terminal-shortcut' && tabVisible && !herdrParked) {
      const index = event.data.index, shortcut = shortcuts[index];
      if (Number.isInteger(index) && shortcut && shortcut.kind === event.data.kind && shortcut.value === event.data.value) $('shortcut-buttons').querySelectorAll<HTMLButtonElement>('button')[index]?.click();
    }
    if (event.data?.type === 'herdr-present' && herdrTerminal && typeof event.data.presentation === 'string') {
      herdrPresentation = event.data.presentation; cancelAnimationFrame(herdrLayoutFrame); herdrLayoutFrame = 0;
      notifyHerdrSizing();
      return;
    }
    if (event.data?.type === 'authorize') { accessToken = event.data.accessToken; void transport.connect(undefined, true); }
    if (event.data?.type === 'recovery-failed') connection('Session ended');
    if (event.data?.type === 'herdr-park' && herdrTerminal) {
      const parked = event.data.parked === true;
      if (herdrParked === parked) return;
      herdrParked = parked; dictation.visibility(!parked && tabVisible);
      if (herdrParkable) send({ type:'herdr-active', active:!parked });
      if (!parked) {
        const cols = term.cols, rows = term.rows; sizeTerminal();
        herdrPreserve = event.data.preserve === true && cols === term.cols && rows === term.rows;
        herdrMobileRendered = herdrPreserve && mobileTerminal();
        herdrLayoutPending = mobileTerminal(); herdrLayoutMatched = false;
        herdrBarrierReady = !herdrBarrier; terminalViewport.classList.toggle('awaiting-herdr-layout', herdrLayoutPending && !herdrPreserve);
        send({ type:'herdr-frame-request' });
      }
      return;
    }
    if (event.data?.type === 'tab-visibility') { tabVisible = event.data.visible; if (!tabVisible && herdrTerminal) { herdrPreserve = false; herdrLayoutPending = true; herdrLayoutMatched = false; terminalViewport.classList.add('awaiting-herdr-layout'); } dictation.visibility(tabVisible); cancelAnimationFrame(outputFrame); clearTimeout(outputTimer); frameQueued = false; if (queue.length) scheduleDrain(); if (tabVisible) { sizeTerminal(); shortcutState = ''; publishShortcuts(); } }
    if (event.data?.type === 'tab-visibility' && herdrTerminal) {
      if (!tabVisible) transport.suspend();
      else void transport.resume(transport.socket?.readyState !== WebSocket.OPEN);
    }
    if (event.data?.type === 'settings-changed') applySettings();
    if (event.data?.type === 'settings-action' && ['new-shell', 'copy-selection'].includes(event.data.action)) $(event.data.action).click();
    if (event.data?.type === 'focus-terminal') { sizeTerminal(); term.focus(); }
  });
  notify('terminal-loaded');
} else void connect();
if (herdrTerminal) $('new-shell').hidden = true;

window.addEventListener('pagehide', () => { if (herdrTerminal) transport.suspend(); projection?.dispose(); }, { once: true });
