import { requestJSON } from './api.ts';
import { wireProtocols, encodeWire, encodeAudio, constrainedLink } from './wire.ts';
import { fileClient, saveDownload } from './file-client.ts';
import { transferView } from './transfer-view.ts';
import { imagePicker, uploadImage } from './image-upload.ts';
import { Ghostty, Terminal, FitAddon } from 'ghostty-web';
import type { ClientMessage, ServerMessage, ShellState, RepairResult } from './protocol.ts';
import './style.css';
import { backendAccess, rememberBackendAccess, forgetBackendAccess } from './backend-access.ts';
import { Queue } from './queue.ts';
import { dictationTarget } from './protocol.ts';
import { SentInput, UnsentInput, type InputContext } from './unsent-input.ts';
import { applyTheme, terminalThemes, watchSystemTheme } from './theme.ts';
import { adaptDarkAppColors } from './terminal-colors.ts';
import { ReconnectingSocket } from './reconnecting-socket.ts';
import { HerdrLayout } from './herdr-layout.ts';
import { TerminalGestures } from './terminal-gestures.ts';
import { terminalLinkAt } from './terminal-links.ts';
import { TerminalFocus } from './terminal-focus.ts';
import { preserveScrollback } from './terminal-viewport.ts';
import { TerminalEcho } from './predicted-echo.ts';
import { TerminalHistory } from './terminal-history.ts';
import { TerminalProjection } from './terminal-projection.ts';
import { TerminalPresentation } from './terminal-presentation.ts';
import { TerminalRendering } from './terminal-rendering.ts';
import { OutputScheduler } from './output-scheduler.ts';
import { mergeHerdrFrames, type HerdrFrameMessage } from './terminal-frame-batch.ts';
import { DictationControl } from './dictation.ts';
import { InlineSuggestions } from './inline-suggestions.ts';
import { shortcutEditor } from './shortcut-editor.ts';
import { defaults, keySequence, validateShortcuts, type Shortcut } from './shortcuts.ts';
import { readingPhrases, readingRequest, readingPipeline, type ReadingOpen } from './reading-request.ts';
const params = new URLSearchParams(location.search);
const embedded = params.get('embedded') === '1' && parent !== window;
const baseURL = new URL(params.get('backend') || document.baseURI);
const session = params.get('session') || 'default';
const herdrTerminal = params.get('herdrTerminal');
let herdrReady = false;
let herdrParked = false;
// A parked Herdr pane that loses its connection waits until it is shown, so the visible pane reconnects alone.
let herdrDormant = false;
let herdrPresentation = '';
let accessToken: string | undefined = backendAccess(baseURL.href);
let authorized = false, directAttempt = false;
const backgroundGrace = 20000;
const inactiveGrace = 2000;
let parkTimer: ReturnType<typeof setTimeout> | undefined;
const keepingGeometry = () => !document.hidden || !transport.backgroundExpired;
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
  available: () => (keepingGeometry() || dictation.active) && (herdrTerminal ? tabVisible && !(herdrParked && herdrDormant) : tabVisible || !tabExpired || dictation.active) && navigator.onLine,
  protocols: wireProtocols,
  checkpoint: () => sentInput.pending,
  stalled: seconds => connection(`Connection stalled · last contact ${seconds}s ago`),
  prepare: prepareConnection, open: socketOpened, message: socketMessage, close: socketClosed, error: connectionError,
});
let state: ShellState = { cwd: '', inputRevision: 0, promptRevision: 0, ready: false, prompt: 0, exited: false };
let after = 0;
// The replay cursor covers queued output too, so a replacement socket never resends what is already held.
let received = 0, socketSeq = 0, ackedSeq = 0;
let streamId = '';
let capturedConnection: string | undefined;
let pendingCommand: { id: string } | undefined;
const edits = new Map<string, (accepted: boolean) => void>();
const inputLines = new Map<string, (line?: { text: string; cursor: number }) => void>();
const repairs = new Map<string, (result: RepairResult) => void>();
const unsentInput = new UnsentInput();
// Numbered keys let a replacement connection resend exactly the ones its predecessor never delivered.
const inputClient = crypto.randomUUID(), sentInput = new SentInput();
// Only a backend that reports delivered keys accepts numbered ones.
let inputSeq = 0, numberedInput = false;
let confirmedInput = 0;
let disconnectedContext: InputContext | undefined;
let connectionEpoch = 0, synchronizedConnection = false;
let shortcuts: Shortcut[] = structuredClone(defaults);
try {
  const saved = localStorage.getItem('libertty.shortcuts');
  if (saved) shortcuts = validateShortcuts(JSON.parse(saved));
} catch { /* Use defaults when storage is unavailable or stale. */ }
function persist(key: string, value: unknown) {
  try { localStorage.setItem('libertty.' + key, JSON.stringify(value)); } catch { toast('Browser storage is unavailable. ' +
    'Settings will last for this page only.'); }
}
const transfersSeen = new Set<string>();
let ctrl = false;
let shortcutState = '';
let uploadingImage = false;
let dictationWaiting = false;
let toastTimer: ReturnType<typeof setTimeout>;
const queue = new Queue<Extract<ServerMessage, { type: 'output' }>>();
let frameQueued = false;
let tabVisible = true, outputFrame = 0;
// A workspace tab connects when first shown and keeps its socket for the background grace after it is hidden.
let tabSeen = !embedded, tabExpired = false, tabTimer: ReturnType<typeof setTimeout> | undefined;
const pendingFrames = new Queue<{ socket: WebSocket | undefined; frame: HerdrFrameMessage }>();
const frameScheduler = new OutputScheduler(drainHerdrFrames, () => tabVisible && !document.hidden && !herdrParked, true);
function scheduleDrain() { if (!tabVisible || document.hidden || herdrParked) return; frameQueued = true; outputFrame = requestAnimationFrame(drain); }
function toast(message: string) {
  if (embedded) { notify('terminal-notice', { message }); return; }
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}
function connection(label: string, online = false) {
  $('connection-label').textContent = label;
  $('reconnect-banner').textContent = label === 'Session ended' ? 'This terminal has ended; open its saved host to reconnect.' : label.startsWith('Connection stalled') ? label : 'Reconnecting to your terminal…';
  $('reconnect-banner').hidden = online || label === 'Connecting' || label === 'Locked';
  updateRun();
}
function updateRun() {
  const available = (state.ready || herdrReady) && !state.exited && transport.socket?.readyState === WebSocket.OPEN && !pendingCommand && !presentation.pending;
  $('shell-status').textContent = state.exited ? 'Exited' : state.ready ? 'At prompt' : 'Running';
  for (const button of document.querySelectorAll<HTMLButtonElement>('.command-shortcut')) button.disabled = !available;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.image-upload')) button.disabled = !canUploadImage();
  $<HTMLButtonElement>('terminal-enter').disabled = !canSendReturn();
  publishShortcuts(available);
}
function publishShortcuts(available = (state.ready || herdrReady) && !state.exited && transport.socket?.readyState === WebSocket.OPEN && !pendingCommand && !presentation.pending) {
  if (!embedded) return;
  const snapshot = { shortcuts, ctrl, available, imageAvailable: canUploadImage(), returnAvailable: canSendReturn() }, serialized = JSON.stringify(snapshot);
  if (serialized === shortcutState) return;
  shortcutState = serialized; notify('terminal-shortcuts', snapshot);
}
async function api<T>(url: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  return requestJSON<T>(endpoint(url), data, { token: () => accessToken, signal });
}
function send(message: ClientMessage): boolean {
  if (['paste', 'replace', 'command', 'dictation-paste', 'input-line', 'repair'].includes(message.type)) echo.cancel();
  if ((message.type === 'dictation' && message.action === 'start') || message.type === 'dictation-paste') {
    try { message.readingPhrases = readingPhrases(JSON.parse(localStorage.getItem('libertty.readingPhrases') || 'null')); } catch { message.readingPhrases = ['look at']; }
  }
  if (transport.socket?.readyState !== WebSocket.OPEN) return false;
  transport.socket.send(encodeWire(message)); return true;
}
// Ghostty fixes its ANSI palette when the terminal is created, so a theme change reloads this document and replays the session.
const terminalTheme = applyTheme();
function applyTerminalTheme() { if (applyTheme() !== terminalTheme) location.reload(); }
watchSystemTheme(applyTerminalTheme);
const fontSizeInput = $<HTMLInputElement>('font-size');
try {
  const saved = JSON.parse(localStorage.getItem('libertty.fontSizePt') || 'null');
  if (typeof saved === 'number') fontSizeInput.value = String(saved);
} catch { /* Use the default when storage is unavailable or stale. */ }
if (!fontSizeInput.checkValidity()) fontSizeInput.value = fontSizeInput.defaultValue;
const fontFamily = getComputedStyle(document.documentElement).fontFamily;
// Load the font before Ghostty measures cells, in parallel with its WASM.
const [ghostty] = await Promise.all([Ghostty.load(), document.fonts.load(`14px ${fontFamily}`).catch(() => {})]);
const term = new Terminal({ ghostty, fontSize: fontSizeInput.valueAsNumber * 4 / 3, fontFamily,
  scrollback: 5000, cursorBlink: true, smoothScrollDuration: 0,
  theme: terminalThemes[terminalTheme] });
const rendering = new TerminalRendering(term);
term.open($('terminal'));
rendering.attach();
if (terminalTheme === 'paper' || terminalTheme === 'flag') adaptDarkAppColors(term.renderer as unknown as Parameters<typeof adaptDarkAppColors>[0], terminalThemes[terminalTheme]);
const focus = new TerminalFocus(term);
const fit = new FitAddon(); term.loadAddon(fit);
const history = new TerminalHistory(() => send({ type: 'herdr-frame-request' }));
let deferredScreen: string | undefined;
const projection = herdrTerminal ? new TerminalProjection(term, ghostty) : undefined;
const terminalViewport = $('terminal-viewport');
const herdrLayout = new HerdrLayout(terminalViewport);
const echo = new TerminalEcho(term, $('terminal'));
const presentation = new TerminalPresentation(terminalViewport, () => {
  updateRun();
  synchronizeInput();
});
let replayTarget: number | undefined, replayState = false;
function inputContext(): InputContext | undefined {
  const target = dictationTarget(state);
  if (!target || state.exited || capturedConnection) return;
  const context: InputContext = { session: baseURL.href + ':' + session + ':' + (herdrTerminal || ''), connection: connectionEpoch, prompt: state.prompt, revision: state.inputRevision, target };
  if (!herdrTerminal) {
    if (!streamId || !replayState) return;
    return { ...context, stream: streamId };
  }
  if (!state.inputContext) return;
  context.identity = state.inputContext;
  if (target === 'shell') {
    const buffer = term.buffer.active, lines: string[] = [];
    for (let row = Math.max(0, buffer.length - 1000); row < buffer.length; row++) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) || '';
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
    }
    while (lines.at(-1) === '') lines.pop();
    context.picture = JSON.stringify([lines, buffer.cursorX, buffer.cursorY, term.cols]);
  }
  return context;
}
function synchronizeInput() {
  if (!replayState || presentation.pending || queue.length || !herdrTerminal && after < (replayTarget ?? after)
    || herdrTerminal && (!herdrReady || herdrLayout.pending || herdrParked || state.inputContext === undefined)) return;
  if (unsentInput.length) {
    const context = inputContext();
    if (!context) return;
    const pending = unsentInput.take(context);
    if (pending) for (const data of pending) rawInput(data);
    else toast('Queued input belongs to a changed prompt and was not sent.');
  }
  if (!synchronizedConnection) { synchronizedConnection = true; disconnectedContext = undefined; dictation.connected(true); }
}
function revealReplay() {
  if (!herdrTerminal && replayState && transport.socket?.readyState === WebSocket.OPEN && !queue.length && after >= (replayTarget ?? after)) {
    presentation.reveal(); synchronizeInput();
  }
}
const mobileViewport = matchMedia('(pointer: coarse) and (max-width: 1024px)');
function mobileTerminal() { return !!herdrTerminal && mobileViewport.matches; }
function refreshHerdrFrame() {
  if (herdrReady && transport.socket?.readyState === WebSocket.OPEN && projection?.requestFrame()) send({ type: 'herdr-frame-request' });
}
function fullWidth() { try { return !!herdrTerminal && !mobileTerminal() && JSON.parse(localStorage.getItem('libertty.herdrLayout') || 'null') === 'full-width'; } catch { return false; } }
// Keep output outside UI state. Ghostty parses synchronously; its callback is an rAF.
function drain() {
  frameQueued = false;
  if (!tabVisible || document.hidden || herdrParked) return;
  let budget = 0, last = after;
  const chunks: string[] = [];
  while (queue.length && budget < 65536) {
    const item = queue.shift()!;
    if (item.seq <= last) continue;
    chunks.push(item.data); last = item.seq; budget += item.data.length;
  }
  if (chunks.length) {
    preserveScrollback(term, () => term.write(chunks.join(''))); after = last;
    echo.output();
  }
  // Acknowledge only what this socket delivered, including duplicates of output painted earlier.
  const acknowledged = Math.min(after, socketSeq);
  if (acknowledged > ackedSeq && send({ type: 'ack', seq: acknowledged })) ackedSeq = acknowledged;
  inline.refresh();
  if (queue.length) scheduleDrain();
  else revealReplay();
}
function sizeTerminal() {
  if (herdrParked) {
    if (!mobileTerminal() && herdrReady) send({ type:'resize', cols:term.cols, rows:term.rows, mobile:false });
    return;
  }
  try {
    const wide = fullWidth();
    if (!mobileTerminal()) herdrLayout.desktop();
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
      discardHerdrFrames();
      if (mobileTerminal()) {
        // Keep a certified mobile view and its focused textarea visible while
        // keyboard geometry redraws; hiding the input would dismiss the IME.
        herdrLayout.set({ pending: true, preserve: herdrLayout.preserve || herdrLayout.rendered });
      }
      preserveScrollback(term, () => term.resize(nextCols, dimensions.rows));
      notifyHerdrSizing();
    }
    if (projection?.resize(mobileTerminal())) scheduleHerdrRendered();
    // Herdr resolves the selected pane asynchronously after the WS upgrade.
    // Send geometry only after its state acknowledges that the handler is ready.
    if (!herdrTerminal || herdrReady) send({ type: 'resize', cols: term.cols, rows: term.rows, ...(herdrTerminal ? { mobile: mobileTerminal() && tabVisible && keepingGeometry() } : {}) }); inline.refresh();
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
  terminalActivity();
  if (['\x1b[I', '\x1b[O'].includes(data)) { if (!presentation.pending) send({ type: 'input', data }); return; }
  if (capturedConnection) { toast('Finish opening the connection first.'); return; }
  if (ctrl) { if (/^[a-zA-Z]$/.test(data)) data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64); setCtrl(false); }
  if (presentation.pending || herdrTerminal && (!herdrReady || herdrLayout.pending) || transport.socket?.readyState !== WebSocket.OPEN || !replayState) {
    const context = unsentInput.context || disconnectedContext || inputContext();
    if (!unsentInput.add(data, context)) toast('Input could not be queued for this terminal.');
    return;
  }
  const predict = inline.predictionReady && !queue.length && !herdrLayout.pending;
  if (!inline.raw(data)) { echo.cancel(); return; }
  const context = numberedInput && !herdrTerminal ? inputContext() : undefined, seq = numberedInput ? inputSeq + 1 : undefined;
  if (send({ type: 'input', data, ...(seq ? { seq } : {}) })) {
    if (seq) { inputSeq = seq; sentInput.add(seq, data, context); }
    term.scrollToBottom(); echo.input(data, state, predict); state.inputRevision++;
  }
  else if (!unsentInput.add(data, disconnectedContext || inputContext())) toast('Input could not be queued for this terminal.');
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
const inline = new InlineSuggestions(term, { state: () => state, replace: replaceLine,
  repair: (text, intent, signal) => {
    if (capturedConnection || !state.ready || state.exited || transport.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Terminal input changed.'));
    const id = crypto.randomUUID(), prompt = state.prompt, revision = state.inputRevision;
    return new Promise(resolve => {
      const cancel = () => send({ type: 'repair-cancel', id });
      const finish = (result: RepairResult) => { signal.removeEventListener('abort', cancel); repairs.delete(id); resolve(result); };
      repairs.set(id, finish); signal.addEventListener('abort', cancel, { once: true });
      if (!send({ type: 'repair', id, text, intent, prompt, revision })) finish({ id, accepted: false, candidates: [], original: text, selected: text, prompt, revision });
    });
  },
  ...(herdrTerminal ? { dictate: (text: string, applied: boolean, replace: boolean) => { if (!send({ type: 'dictation-paste', text, applied, replace, prompt: state.prompt, revision: state.inputRevision })) inline.disconnect(); } } : {}),
  readLine: () => {
    const id = crypto.randomUUID(), prompt = state.prompt, revision = state.inputRevision;
    return new Promise(resolve => {
      const timer = setTimeout(() => { inputLines.delete(id); resolve(undefined); }, 3000);
      inputLines.set(id, line => { clearTimeout(timer); resolve(line); });
      if (!send({ type: 'input-line', id, prompt, revision })) { inputLines.get(id)?.(); inputLines.delete(id); }
    });
  },
  raw: rawInput, execute });
const dictation = new DictationControl({ api, send, state: () => state, context: inputContext, key: baseURL.href,
  audio: data => { if (!transport.socket || transport.socket.readyState !== WebSocket.OPEN || transport.socket.bufferedAmount > 256 * 1024) return false; transport.socket.send(encodeAudio(data)); return true; },
  prepare: () => inline.prepareExternalPaste(), waiting: active => { dictationWaiting = active; inline.dictationPending(active); updateRun(); }, notice: toast, focus: () => term.focus() });
function showReading(request: { path: string } | { capture: string; name: string; exitCode: number }) {
  if (embedded) { notify('reading-open', request); return; }
  const workspace = new URL('.', document.baseURI);
  sessionStorage.setItem('libertty.pendingReading:' + workspace.pathname, JSON.stringify({ ...request, session, backendUrl: baseURL.href, ...(herdrTerminal ? { herdrTerminal, herdrSession: params.get('herdrSession') || '', herdrSource: params.get('herdrSource') || '' } : {}) }));
  location.assign(workspace.href);
}
term.onData(rawInput);
function setCtrl(value: boolean) { ctrl = value; for (const button of document.querySelectorAll('[data-modifier]')) button.setAttribute('aria-pressed', String(value)); publishShortcuts(); }
function canUploadImage() { return !presentation.pending && !uploadingImage && !capturedConnection && !state.exited && (!herdrTerminal || herdrReady) && transport.socket?.readyState === WebSocket.OPEN; }
function canSendReturn() { return !dictationWaiting && !pendingCommand && !presentation.pending && !capturedConnection && !state.exited && (!herdrTerminal || herdrReady) && transport.socket?.readyState === WebSocket.OPEN; }
function sendReturn() { if (canSendReturn()) rawInput('\r'); }
$('terminal-enter').addEventListener('pointerdown', event => event.preventDefault());
$('terminal-enter').onclick = sendReturn;
const images = imagePicker(files => void attachImages(files)); document.body.append(images);
async function attachImages(files: File[]) {
  if (!canUploadImage()) { toast('Connect to the terminal before attaching an image.'); return; }
  const socket = transport.socket!, abort = new AbortController();
  socket.addEventListener('close', () => abort.abort(), { once: true, signal: abort.signal });
  uploadingImage = true; updateRun();
  try {
    for (const file of files) {
      toast('Uploading ' + file.name + '…');
      const path = await uploadImage(herdrTerminal ? herdrEndpoint('api/herdr/images/upload') : endpoint('api/images/upload'), accessToken, file, abort.signal);
      if (transport.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('The terminal disconnected. Attach the image again after reconnecting.');
      inline.prepareExternalPaste();
      if (herdrTerminal) { send({ type: 'paste', text: path }); state.inputRevision++; }
      else term.paste(path);
    }
    toast(`${files.length} image${files.length === 1 ? '' : 's'} attached.`); term.focus();
  } catch (error: any) { toast(abort.signal.aborted ? 'The terminal disconnected. Attach the image again after reconnecting.' : error.message); }
  finally { abort.abort(); uploadingImage = false; updateRun(); }
}
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
  const image = document.createElement('button'); image.type = 'button'; image.className = 'image-upload'; image.textContent = 'Image'; image.setAttribute('aria-label', 'Attach images'); image.onclick = () => images.click(); $('shortcut-buttons').append(image);
  updateRun();
}
const prepareEditor = shortcutEditor(() => shortcuts, value => { shortcuts = value; persist('shortcuts', shortcuts); setCtrl(false); renderShortcuts(); }, () => $<HTMLDialogElement>('shortcuts-dialog').close());
$('customize-shortcuts').onclick = () => { $<HTMLDialogElement>('options-dialog').close(); prepareEditor(); $<HTMLDialogElement>('shortcuts-dialog').showModal(); };
renderShortcuts();
function applySettings() {
  try {
    applyTerminalTheme();
    const font = JSON.parse(localStorage.getItem('libertty.fontSizePt') || '10');
    if (typeof font === 'number') { fontSizeInput.value = String(font); fontSizeInput.dispatchEvent(new Event('input')); }
    for (const [id, value] of [['auto-alternatives', localStorage.getItem('libertty.autoAlternatives') !== 'false' && localStorage.getItem('libertty.justRun') !== 'true'], ['tap-alternate-send', localStorage.getItem('libertty.tapAlternateSend') !== 'false']] as const) {
      const setting = $<HTMLInputElement>(id); if (setting.checked !== value) { setting.checked = value; setting.dispatchEvent(new Event('change')); }
    }
    const next = validateShortcuts(JSON.parse(localStorage.getItem('libertty.shortcuts') || JSON.stringify(defaults)));
    if (JSON.stringify(next) !== JSON.stringify(shortcuts)) { shortcuts = next; setCtrl(false); renderShortcuts(); }
    inline.setReadingPhrases(JSON.parse(localStorage.getItem('libertty.readingPhrases') || 'null'));
    sizeTerminal();
  } catch { /* Keep valid settings if stored data is unavailable or malformed. */ }
}
window.addEventListener('storage', event => { if (event.key === null || ['libertty.herdrLayout', 'libertty.fontSizePt', 'libertty.autoAlternatives', 'libertty.tapAlternateSend', 'libertty.shortcuts', 'libertty.readingPhrases', 'libertty.justRun', 'libertty.theme'].includes(event.key)) applySettings(); });
function copyTerminalText(text: string) {
  // Clipboard access needs a focused document. Focus the frame itself without
  // enabling its textarea or opening the software keyboard after a gesture.
  window.focus(); return navigator.clipboard.writeText(text);
}
const gestures = new TerminalGestures(term, {
  focus,
  link: (col, row) => terminalLinkAt(term, col, row, projection?.clickable),
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
  tap: (x, y) => {
    transport.activity();
    if (presentation.pending || queue.length || capturedConnection) return;
    if (!herdrTerminal || state.ready) { inline.moveCursor(x, y); return; }
    if (!herdrReady || !mobileTerminal() || herdrLayout.pending || herdrParked || !tabVisible || document.hidden) return;
    const bounds = term.element!.querySelector('canvas')!.getBoundingClientRect();
    const column = Math.floor((x - bounds.left) * term.cols / bounds.width), row = Math.floor((y - bounds.top) * term.rows / bounds.height);
    const cell = projection?.nativeCell(column, row);
    if (cell && send({ type: 'terminal-click', ...cell, cols: term.cols, rows: term.rows })) state.inputRevision++;
  }, copy: copyTerminalText,
});

async function socketURL(signal: AbortSignal) {
  presentation.freeze();
  const socketURL = herdrTerminal ? herdrEndpoint('herdr/ws') : endpoint('ws');
  socketSeq = ackedSeq = 0;
  if (herdrTerminal) {
    sizeTerminal();
    const geometry = { cols: term.cols, rows: term.rows, mobile: mobileTerminal() && tabVisible && keepingGeometry() };
    herdrLayout.rendered = false; herdrLayout.set({ pending: geometry.mobile, preserve: false, cover: geometry.mobile && !herdrParked });
    const result = await requestJSON<{ ticket: string }>(herdrEndpoint('api/herdr/ticket'), geometry, { token: () => accessToken, signal });
    socketURL.searchParams.set('ticket', result.ticket);
  } else if (baseURL.origin !== location.origin) socketURL.searchParams.set('ticket', (await api<{ ticket: string }>('/api/ticket', {}, signal)).ticket);
  socketURL.protocol = baseURL.protocol === 'https:' ? 'wss:' : 'ws:'; socketURL.searchParams.set('after', String(Math.max(after, received)));
  socketURL.searchParams.set('client', inputClient);
  if (streamId) socketURL.searchParams.set('stream', streamId);
  return socketURL;
}
async function prepareConnection(signal: AbortSignal, token?: string) {
  directAttempt = !token && (herdrTerminal ? !!accessToken : authorized && baseURL.origin === location.origin);
  if (directAttempt) return socketURL(signal);
  const result = await api<{ state?: ShellState; accessToken: string }>('/api/connect', { ...(herdrTerminal ? { noSession: true } : { session }), ...(token ? { token } : {}) }, signal);
  signal.throwIfAborted();
  authorized = true;
  if (result.state) state = result.state; accessToken = result.accessToken; notify('terminal-authorized', { accessToken });
  rememberBackendAccess(baseURL.href, accessToken);
  $<HTMLInputElement>('token').value = '';
  $<HTMLDialogElement>('login-dialog').close(); $('login-error').textContent = '';
  return socketURL(signal);
}
function socketOpened() {
  discardHerdrFrames();
  connectionEpoch++; synchronizedConnection = false; numberedInput = false;
  history.reset();
  deferredScreen = undefined;
  replayState = false;
  if (herdrTerminal) { herdrReady = false; state.inputRevision = 0; state.inputTarget = undefined; connection('Connecting'); }
  else { connection('Connected', true); notify('terminal-ready'); }
  sizeTerminal();
  if (herdrParked) send({ type:'herdr-active', active:false });
}
function revealHerdrLayout() {
  if (!herdrLayout.ready) return;
  const socket = transport.socket;
  const presentation = herdrPresentation;
  const cols = term.cols, rows = term.rows;
  projection?.paintBaseline();
  herdrLayout.reveal(() => transport.socket === socket && presentation === herdrPresentation && term.cols === cols && term.rows === rows && !herdrParked,
    () => { send({ type:'herdr-frame-request' }); notifyHerdrRendered(presentation); });
}
function notifyHerdrRendered(presentationId = herdrPresentation) {
  if (!herdrLayout.pending && !herdrParked && presentationId === herdrPresentation) {
    applyDeferredScreen();
    presentation.reveal(); synchronizeInput();
    notify('terminal-rendered', { presentation: presentationId, cols:term.cols, rows:term.rows });
  }
}
function notifyHerdrSizing() {
  if (herdrTerminal) notify('terminal-sizing', { presentation:herdrPresentation, cols:term.cols, rows:term.rows });
}
function scheduleHerdrRendered() {
  const presentation = herdrPresentation, socket = transport.socket;
  requestAnimationFrame(() => { if (transport.socket === socket) notifyHerdrRendered(presentation); });
}
function applyDeferredScreen() {
  if (deferredScreen === undefined || herdrLayout.pending || herdrParked || !tabVisible || document.hidden) return;
  projection?.update(deferredScreen); deferredScreen = undefined;
}
function discardHerdrFrames() {
  frameScheduler.cancel();
  for (const pending of pendingFrames) if (pending.socket === transport.socket) send({ type: 'ack', seq: pending.frame.seq });
  pendingFrames.clear();
}
function drainHerdrFrames() {
  if (herdrLayout.pending || presentation.pending) { discardHerdrFrames(); return; }
  const frames = [...pendingFrames].filter(pending => pending.socket === transport.socket).map(pending => pending.frame);
  pendingFrames.clear();
  try { for (const frame of mergeHerdrFrames(frames)) paintHerdrFrame(frame); }
  catch (error) { connectionError(error); transport.socket?.close(4002, 'Invalid terminal frame'); }
}
function paintHerdrFrame(message: HerdrFrameMessage) {
  try {
    if (document.hidden || !tabVisible || herdrParked || herdrLayout.holding) return;
    if (herdrLayout.pending && !herdrLayout.accept(message.width === term.cols && message.height === term.rows, message.full)) return;
    if (projection?.frame(message) && !herdrLayout.pending) scheduleHerdrRendered();
    revealHerdrLayout();
    if (fullWidth()) sizeTerminal(); refreshHerdrFrame();
  } finally { echo.output(); send({ type: 'ack', seq: message.seq }); }
}
function socketMessage(event: MessageEvent) {
  const message: ServerMessage = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  if (message.type === 'herdr-layout') {
    discardHerdrFrames();
    if (herdrParked) return;
    if (message.cols !== term.cols || message.rows !== term.rows || !mobileTerminal()) return;
    herdrLayout.set({ pending: true, barrierReady: message.ready });
    return;
  }
  if (message.type === 'herdr-frame') {
    if (document.hidden || !tabVisible || herdrParked || herdrLayout.holding) { send({ type: 'ack', seq: message.seq }); return; }
    if (herdrLayout.pending || presentation.pending || !herdrReady) { discardHerdrFrames(); paintHerdrFrame(message); return; }
    pendingFrames.push({ socket: transport.socket, frame: message });
    if (pendingFrames.length > 2) { frameScheduler.cancel(); drainHerdrFrames(); } else frameScheduler.request();
    return;
  }
  if (message.type === 'screen' || message.type === 'screen-delta') {
    const text = history.receive(message);
    if (text === undefined) return;
    deferredScreen = text;
    if (document.hidden || !tabVisible || herdrLayout.pending || herdrParked) return;
    applyDeferredScreen(); echo.output(); if (fullWidth()) sizeTerminal(); refreshHerdrFrame(); scheduleHerdrRendered(); return;
  }
  if (message.type === 'input-line') {
    const intact = message.prompt === state.prompt && message.revision === state.inputRevision && state.ready;
    inputLines.get(message.id)?.(intact && typeof message.text === 'string' && typeof message.cursor === 'number' ? { text: message.text, cursor: message.cursor } : undefined);
    inputLines.delete(message.id); return;
  }
  if (message.type === 'repair-result') {
    const intact = message.prompt === state.prompt && state.ready && !state.exited;
    if (intact && message.accepted && [state.inputRevision, state.inputRevision + 1].includes(message.revision)) state.inputRevision = message.revision;
    else if (message.accepted) message.accepted = false;
    if (message.source === 'dictation') {
      if (intact && message.revision === state.inputRevision) inline.backendResult(message);
    } else repairs.get(message.id)?.(message);
    if (message.accepted) term.scrollToBottom();
    return;
  }
  if (message.type === 'pasted') {
    if (message.prompt === state.prompt && message.revision === state.inputRevision + 1) {
      state.inputRevision = message.revision;
      term.scrollToBottom();
      if (message.repairing) inline.backendLoading(message.text, !!herdrTerminal);
      else inline.externalPaste(message.text, message.replace, message.source === 'dictation', !!herdrTerminal);
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
  if (message.type === 'dictation') { dictation.event(message.id, message.state, message.message, message.resume); return; }
  if (message.type === 'reading-file') {
    showReading({ path: message.path });
  } else if (message.type === 'reading-capture') {
    showReading({ capture: message.id, name: message.name, exitCode: message.exitCode });
  } else if (message.type === 'reading-error') {
    inline.dictationPending(false);
    toast(message.message);
  } else if (message.type === 'ssh-command' || message.type === 'herdr-command') {
    capturedConnection = message.id; inline.disconnect();
    if (embedded) notify(message.type, { id: message.id, command: message.command });
    else if (message.type === 'herdr-command') {
      const workspace = new URL('.', document.baseURI);
      try {
        sessionStorage.setItem('libertty.pendingHerdr:' + workspace.pathname, JSON.stringify({ id: message.id, session, backendUrl: baseURL.href }));
        location.assign(workspace.href);
      } catch {
        void api('/api/herdr/captured', { id: message.id, action: 'native' }).then(() => api('/api/herdr/captured', { id: message.id, action: 'ack' })).catch(error => toast(error.message));
      }
    }
    else void api('/api/ssh/captured', { id: message.id, action: 'native' }).then(() => api('/api/ssh/captured', { id: message.id, action: 'ack' })).catch(error => toast(error.message));
  } else if (message.type === 'ssh-released') {
    if (capturedConnection === message.id) capturedConnection = undefined;
  } else if (message.type === 'input-ack') {
    if (typeof message.seq === 'number' && message.seq > confirmedInput) { confirmedInput = message.seq; transport.confirmed(); }
    if (numberedInput) { if (typeof message.seq === 'number') sentInput.confirm(message.seq); return; }
    // Keys the previous connection never delivered rejoin the unsent queue under the context they were typed in.
    numberedInput = true;
    const pending = sentInput.settle(message.seq);
    if (pending && (!pending.complete || !unsentInput.prepend(pending.data, pending.context || disconnectedContext))) toast('Keys typed before the connection dropped were not delivered.');
  } else if (message.type === 'hello') {
    replayTarget = message.lastSeq;
    streamId = message.streamId;
    // Reset through the terminal parser. Ghostty's reset() frees native memory
    // still referenced by its input and selection handlers.
    if (message.reset) { presentation.freeze(); queue.clear(); after = received = 0; inline.disconnect(); term.clearSelection(); term.scrollToBottom(); term.write('\x1bc\x1b[3J'); }
    if (message.truncated) {
      term.write('\r\n\x1b[33mOlder output is unavailable. Ctrl-L redraws the current program.\x1b[0m\r\n');
      toast('Reconnected with limited scrollback. Use Ctrl-L to redraw if needed.');
    }
  } else if (message.type === 'output') {
    socketSeq = Math.max(socketSeq, message.seq);
    if (message.seq > received) { queue.push(message); received = message.seq; }
    if (!frameQueued) scheduleDrain();
  } else if (message.type === 'state') {
    const initial = !replayState;
    replayState = true;
    transport.ready();
    if (herdrTerminal) { herdrReady = true; sizeTerminal(); connection('Connected', true); notify('terminal-ready'); }
    // A state acknowledgement can arrive after newer local keystrokes were
    // sent. Keep their optimistic revision until the backend catches up.
    if (!initial) message.state.inputRevision = Math.max(state.inputRevision, message.state.inputRevision);
    state = message.state; notify('terminal-state', { state }); $('cwd').textContent = state.cwd; $('cwd').title = state.cwd;
    dictation.prompt();
    updateRun();
    inline.onState(state); echo.state(state);
    revealReplay(); synchronizeInput();
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
  discardHerdrFrames();
  if (directAttempt && !replayState) authorized = false;
  herdrDormant = herdrParked;
  disconnectedContext = inputContext() || disconnectedContext;
  dictation.connected(false); synchronizedConnection = false;
  echo.reset();
  presentation.freeze(); replayState = false;
  herdrReady = false;
  if (event?.code === 4001 || state.exited) inline.disconnect(); else inline.suspend();
  for (const resolve of edits.values()) resolve(false); edits.clear();
  for (const resolve of inputLines.values()) resolve(); inputLines.clear();
  for (const [id, resolve] of repairs) resolve({ id, accepted: false, candidates: [], original: '', selected: '', prompt: state.prompt, revision: state.inputRevision }); repairs.clear();
  // Never resend uncertain input or an uncertain command automatically.
  if (pendingCommand) { pendingCommand = undefined; toast('Connection lost before acknowledgement. Check the terminal before running again.'); }
  if (event?.code === 4001) { unsentInput.clear(); sentInput.clear(); disconnectedContext = undefined; dictation.cancel(); connection('Other tab'); toast(event.reason); return false; }
  if (herdrTerminal && event?.code === 1000 && event.reason === 'Herdr terminal ended') { inline.disconnect(); connection('Session ended'); notify('terminal-ended'); return false; }
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
document.addEventListener('terminal-can-evict', event => {
  (event as CustomEvent<{ allowed: boolean }>).detail.allowed = !unsentInput.length && !sentInput.pending && !uploadingImage
    && !dictation.active && !pendingCommand && !capturedConnection && !repairs.size && !edits.size && !inputLines.size && !document.querySelector('dialog[open]');
});
function terminalActivity() { transport.activity(); rendering.activity(); frameScheduler.activity(); }
document.addEventListener('pointerdown', terminalActivity, { passive: true });
document.addEventListener('wheel', terminalActivity, { passive: true });
$('login-form').onsubmit = e => { e.preventDefault(); void connect($<HTMLInputElement>('token').value); };
transport.follow({ grace: backgroundGrace, hidden: () => {
  echo.cancel(); cancelAnimationFrame(outputFrame); frameQueued = false;
  discardHerdrFrames();
  if (herdrTerminal && !herdrParked) {
    herdrLayout.set({ pending: mobileTerminal(), preserve: true, barrierReady: herdrLayout.barrierReady });
    send({ type: 'herdr-active', active: false });
  }
}, shown: () => {
  rendering.activity(); frameScheduler.activity();
  if (herdrTerminal && tabVisible && !herdrParked) send({ type: 'herdr-active', active: true });
  sizeTerminal(); if (queue.length && !frameQueued) scheduleDrain(); revealReplay();
},
  expired: () => {
    if (herdrTerminal) send({ type: 'resize', cols: term.cols, rows: term.rows, mobile: false });
    if (dictation.active) return false;
    inline.suspend();
  } });

function execute(command: string) {
  if (presentation.pending || capturedConnection || !state.ready && !herdrReady || state.exited || pendingCommand || transport.socket?.readyState !== WebSocket.OPEN) { toast('Wait for terminal input before running a command.'); return; }
  if (!command.trim() || /[\x00-\x1f\x7f]/.test(command)) { toast('Use one command line at a time.'); return; }
  if (herdrTerminal && state.ready && (readingRequest(command, ['look at']) || readingPipeline(command, ['look at']))) {
    const context = state.inputContext;
    inline.disconnect();
    // Clear the submitted line before the reader runs so later typing is preserved.
    send({ type: 'input', data: '\x07\x05\x15' }); state.inputRevision++;
    const controller = new AbortController(), socket = transport.socket;
    socket.addEventListener('close', () => controller.abort(), { once: true, signal: controller.signal });
    pendingCommand = { id: crypto.randomUUID() }; updateRun();
    void requestJSON<ReadingOpen>(herdrEndpoint('api/herdr/reading'), { terminalId: herdrTerminal, command, context, cwd: state.cwd }, { token: () => accessToken, signal: controller.signal, timeout: 35000 }).then(request => {
      if (transport.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      showReading(request);
    }).catch(error => { if (!controller.signal.aborted) toast(error.message); }).finally(() => {
      controller.abort(); pendingCommand = undefined; updateRun();
    });
    return;
  }
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
    inline.disconnect();
    transport.suspend();
    await api('/api/new', {}); after = received = 0; streamId = ''; queue.clear(); unsentInput.clear(); sentInput.clear(); disconnectedContext = undefined; pendingCommand = undefined;
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
    if (event.data?.type === 'terminal-return' && tabVisible && !herdrParked) sendReturn();
    if (event.data?.type === 'terminal-images' && tabVisible && !herdrParked && Array.isArray(event.data.files) && event.data.files.every((file: unknown) => file instanceof File)) void attachImages(event.data.files);
    if (event.data?.type === 'herdr-present' && herdrTerminal && typeof event.data.presentation === 'string') {
      discardHerdrFrames(); rendering.activity(); frameScheduler.activity();
      presentation.freeze();
      herdrPresentation = event.data.presentation; herdrLayout.cancel();
      notifyHerdrSizing();
      return;
    }
    if (event.data?.type === 'authorize') { accessToken = event.data.accessToken; void transport.connect(undefined, true); }
    if (event.data?.type === 'recovery-failed') connection('Session ended');
    if (event.data?.type === 'herdr-park' && herdrTerminal) {
      const parked = event.data.parked === true;
      if (herdrParked === parked) return;
      herdrParked = parked; dictation.visibility(!parked && tabVisible);
      if (parked) discardHerdrFrames();
      rendering.setVisible(!parked && tabVisible);
      clearTimeout(parkTimer);
      if (parked) parkTimer = setTimeout(() => { if (herdrParked) { herdrDormant = true; transport.suspend(); } }, inactiveGrace);
      // The tab-visibility message that follows an unpark reconnects a dormant pane.
      if (!parked) herdrDormant = false;
      send({ type:'herdr-active', active:!parked });
      if (!parked) {
        const cols = term.cols, rows = term.rows; sizeTerminal();
        const preserve = event.data.preserve === true && cols === term.cols && rows === term.rows;
        herdrLayout.rendered = preserve && mobileTerminal(); herdrLayout.set({ pending: mobileTerminal(), preserve });
        send({ type:'herdr-frame-request' });
      }
      return;
    }
    if (event.data?.type === 'tab-visibility') { tabVisible = event.data.visible; if (!tabVisible) { presentation.freeze(); discardHerdrFrames(); } else { rendering.activity(); frameScheduler.activity(); } rendering.setVisible(tabVisible && !herdrParked); if (!tabVisible && herdrTerminal) herdrLayout.set({ pending: true, preserve: false, barrierReady: herdrLayout.barrierReady }); dictation.visibility(tabVisible); cancelAnimationFrame(outputFrame); frameQueued = false; if (queue.length) scheduleDrain(); if (tabVisible) { sizeTerminal(); shortcutState = ''; publishShortcuts(); revealReplay(); } }
    if (event.data?.type === 'tab-visibility' && herdrTerminal) {
      if (!tabVisible) transport.suspend();
      else void transport.resume(transport.socket?.readyState !== WebSocket.OPEN);
    } else if (event.data?.type === 'tab-visibility') {
      clearTimeout(tabTimer);
      // The workspace's selected tab counts as shown while another page covers it.
      tabSeen ||= tabVisible || event.data.active === true;
      if (tabVisible) { tabExpired = false; void transport.resume(!transport.healthy); }
      else if (!tabSeen) tabExpired = true;
      else tabTimer = setTimeout(() => { tabExpired = true; if (!dictation.active) { inline.suspend(); transport.suspend(); } }, inactiveGrace);
    }
    if (event.data?.type === 'settings-changed') applySettings();
    if (event.data?.type === 'settings-action' && ['new-shell', 'copy-selection'].includes(event.data.action)) $(event.data.action).click();
    if (event.data?.type === 'focus-terminal') { sizeTerminal(); term.focus(); }
  });
  notify('terminal-loaded');
} else void connect();
if (herdrTerminal) $('new-shell').hidden = true;

window.addEventListener('pagehide', () => { if (herdrTerminal) transport.suspend(); projection?.dispose(); }, { once: true });
