import { requestJSON } from './api.ts';
import { saved } from './persistence.ts';
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
import { ReconnectingSocket, stalledLabel } from './reconnecting-socket.ts';
import { HerdrLayout } from './herdr-layout.ts';
import { TerminalGestures } from './terminal-gestures.ts';
import { terminalLinkAt } from './terminal-links.ts';
import { TerminalFocus } from './terminal-focus.ts';
import { preserveScrollback } from './terminal-viewport.ts';
import { TerminalEcho } from './predicted-echo.ts';
import { TerminalCache, terminalCacheKey } from './terminal-cache.ts';
import { TerminalTranscript } from './terminal-transcript.ts';
import { paintSnapshot, terminalSnapshot, type TerminalPicture } from './terminal-snapshot.ts';
import { TerminalHistory } from './terminal-history.ts';
import { TerminalProjection } from './terminal-projection.ts';
import { TerminalPresentation, TerminalResizeCover } from './terminal-presentation.ts';
import { TerminalRendering } from './terminal-rendering.ts';
import { OutputScheduler } from './output-scheduler.ts';
import { mergeHerdrFrames, type HerdrFrameMessage } from './terminal-frame-batch.ts';
import { DictationControl } from './dictation.ts';
import { InlineSuggestions } from './inline-suggestions.ts';
import { shortcutEditor } from './shortcut-editor.ts';
import { defaults, keySequence, validateShortcuts, type Shortcut } from './shortcuts.ts';
import { readingPhrases, readingRequest, readingPipeline, type ReadingOpen } from './reading-request.ts';
import type { NoticeInput, NoticeKind } from './notice-model.ts';
import { NoticeCenter } from './notices.ts';
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
// Cached Herdr metadata mounts a preview that cannot connect until the workspace verifies its pane.
let herdrPreview = !!herdrTerminal && params.get('herdrPreview') === '1';
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
  available: () => !herdrPreview && (keepingGeometry() || dictation.active) && (herdrTerminal ? tabVisible && !(herdrParked && herdrDormant) : tabVisible || !tabExpired || dictation.active),
  protocols: wireProtocols,
  checkpoint: () => sentInput.pending,
  stalled: lastContact => connection(stalledLabel(lastContact)),
  prepare: prepareConnection, open: socketOpened, message: socketMessage, close: socketClosed, error: connectionError,
});
let state: ShellState = { cwd: '', inputRevision: 0, promptRevision: 0, ready: false, prompt: 0, exited: false };
let after = 0;
// The replay cursor covers queued output too, so a replacement socket never resends what is already held.
let received = 0, socketSeq = 0, ackedSeq = 0;
let streamId = '';
let lastOutputAt = 0;
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
  const stored = localStorage.getItem('libertty.shortcuts');
  if (stored) shortcuts = validateShortcuts(JSON.parse(stored));
} catch { /* Use defaults when storage is unavailable or stale. */ }
function persist(key: string, value: unknown) {
  try { localStorage.setItem('libertty.' + key, JSON.stringify(value)); } catch { toast('Browser storage is unavailable. ' +
    'Settings will last for this page only.', 'warning'); }
}
const transfersSeen = new Set<string>();
let ctrl = false;
let shortcutState = '';
let uploadingImage = false;
let dictationWaiting = false;
const queue = new Queue<Extract<ServerMessage, { type: 'output' }>>();
let frameQueued = false;
let tabVisible = true, outputFrame = 0;
// A workspace tab connects when first shown and keeps its socket for the background grace after it is hidden.
let tabSeen = !embedded, tabExpired = false, tabTimer: ReturnType<typeof setTimeout> | undefined;
const pendingFrames = new Queue<{ socket: WebSocket | undefined; frame: HerdrFrameMessage }>();
const frameScheduler = new OutputScheduler(drainHerdrFrames, () => tabVisible && !document.hidden && !herdrParked, true);
function scheduleDrain() { if (!tabVisible || document.hidden || herdrParked) return; frameQueued = true; outputFrame = requestAnimationFrame(drain); }
// An embedded terminal sends notices to the workspace, which returns these action ids.
const noticeActions = { redraw: () => rawInput('\x0c'), reconnect: () => transport.activity() };
type NoticeActionId = keyof typeof noticeActions;
const notices = embedded ? undefined : new NoticeCenter();
let connectionStatus = 'null';
function noticeInput(message: string, kind: NoticeKind, actions: Partial<Record<NoticeActionId, string>>): NoticeInput {
  return { message, kind, actions: Object.entries(actions).map(([id, label]) => ({ label, run: noticeActions[id as NoticeActionId] })) };
}
function toast(message: string, kind: NoticeKind = 'error', actions: Partial<Record<NoticeActionId, string>> = {}) {
  if (embedded) notify('terminal-notice', { message, kind, actions: Object.entries(actions).map(([id, label]) => ({ id, label })) });
  else notices!.notify(noticeInput(message, kind, actions));
}
function connection(label: string, online = false) {
  $('connection-label').textContent = label;
  const updated = lastOutputAt || cachedUpdated ? ` · last output ${new Date(lastOutputAt || cachedUpdated).toLocaleTimeString()}` : '';
  const status = online || ['Connecting', 'Locked', 'Other tab'].includes(label) ? undefined
    : label === 'Session ended' ? { message: 'This terminal has ended. Open its saved host to reconnect.', kind: 'error' as const, actions: {} }
    : { message: label.startsWith('Connection stalled') ? label : 'Reconnecting' + updated, kind: 'progress' as const, actions: { reconnect: 'Retry now' } };
  const serialized = JSON.stringify(status ?? null);
  if (serialized !== connectionStatus) {
    connectionStatus = serialized;
    if (embedded) notify('terminal-status', { status: status && { ...status, actions: Object.entries(status.actions).map(([id, label]) => ({ id, label })) } });
    else notices!.set('connection', status && noticeInput(status.message, status.kind, status.actions), status?.kind === 'error');
  }
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
    message.readingPhrases = readingPhrases(saved<unknown>('readingPhrases', null));
  }
  if (transport.socket?.readyState !== WebSocket.OPEN) return false;
  transport.socket.send(encodeWire(message)); return true;
}
// Ghostty fixes its ANSI palette when the terminal is created, so a theme change reloads this document and replays the session.
const terminalTheme = applyTheme();
// Chromium can report a different system appearance while leaving a page, so only a change that lasts reloads it.
let themeChange: ReturnType<typeof setTimeout> | undefined;
function applyTerminalTheme() {
  clearTimeout(themeChange);
  themeChange = setTimeout(() => { if (applyTheme() !== terminalTheme) location.reload(); }, 250);
}
watchSystemTheme(applyTerminalTheme);
const fontSizeInput = $<HTMLInputElement>('font-size');
try {
  const stored = JSON.parse(localStorage.getItem('libertty.fontSizePt') || 'null');
  if (typeof stored === 'number') fontSizeInput.value = String(stored);
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
const transcript = new TerminalTranscript();
const cache = new TerminalCache();
const cacheKey = terminalCacheKey(baseURL.href, herdrTerminal ? params.get('herdrSession') || '' : session, herdrTerminal || '', params.get('herdrSource') || '', params.get('herdrPane') || '');
let cachedUpdated = 0, cachedStream = '', clearedScreen: string | undefined, streamStarted = false;
// Retained output painted through the terminal itself until live output replaces it at the same distance from the bottom.
let cachePainted = false, handoffPosition = 0, picture: TerminalPicture = { last: 0, x: 0, y: 0, cursor: false };
// The reset that a complete replay writes over retained output, so the swap paints once.
let handoff: string | undefined;
// A Herdr pane that replaced retained output under a cover reveals it once its history decides the final picture.
let herdrHandoffUntil = 0, herdrHandoffTimer: ReturnType<typeof setTimeout> | undefined;
let backfillNeeded = false, backfill: AbortController | undefined;
let backfillTimer: ReturnType<typeof setTimeout> | undefined;
let transcriptTimer: ReturnType<typeof setTimeout> | undefined, cacheTimer: ReturnType<typeof setTimeout> | undefined;
function observeTerminal() {
  if (cachePainted) return false;
  const snapshot = terminalSnapshot(term);
  if (snapshot.text === clearedScreen) return false;
  picture = snapshot.picture;
  return transcript.observe(snapshot.text, !term.wasmTerm?.isAlternateScreen() && (!herdrTerminal || state.ready));
}
function saveTranscript() {
  clearTimeout(cacheTimer); cacheTimer = undefined;
  if (!transcript.records.length || !synchronizedConnection && !cachePainted) return;
  if (synchronizedConnection) observeTerminal();
  void cache.save({ key: cacheKey, version: 2, updated: lastOutputAt || cachedUpdated || Date.now(), stream: streamId || cachedStream,
    records: transcript.records.map(record => ({ ...record })), picture, position: Math.floor(term.getViewportY()) });
}
function captureTranscript() {
  clearTimeout(transcriptTimer); transcriptTimer = undefined;
  if (observeTerminal()) cacheTimer ??= setTimeout(saveTranscript, 2000);
}
function notifyCachedRendered() {
  if (herdrTerminal && cachePainted && herdrPresentation && tabVisible && !herdrParked) notify('terminal-rendered', { presentation: herdrPresentation, cols: term.cols, rows: term.rows });
}
/** Show retained output with the live renderer; the next live paint or replay replaces it. */
function paintCache(position: number) {
  const text = transcript.text();
  if (!text) return;
  gestures.clear(); paintSnapshot(term, text, picture, position);
  cachePainted = true; projection?.invalidate(); herdrLayout.uncover();
  if (presentation.pending) presentation.wait();
  updateRun(); notifyCachedRendered();
}
/** A handshake in progress is neither live nor lost, so its replay is never covered by retained output. */
function disconnected() { return transport.socket?.readyState !== WebSocket.OPEN || synchronizedConnection && !transport.healthy; }
/** Only a dropped or stalled connection shows retained output for a scroll that the live terminal cannot serve locally. */
function showRetained(lines: number) {
  if (gestures.text) return;
  captureTranscript(); paintCache(Math.floor(term.getViewportY()));
  if (!cachePainted) return;
  // The next connection replays the whole stream over retained output.
  if (!herdrTerminal) { after = received = 0; queue.clear(); }
  term.scrollLines(lines);
}
/** Cover retained output with its exact picture while a Herdr paint replaces it, since a native grid can precede the history projection. */
function coverRetained() {
  if (!cachePainted || !presentation.pending) return false;
  presentation.freeze(false); return true;
}
function livePainted(position: number, covered: boolean) {
  if (!cachePainted) return;
  if (projection?.stale) { if (covered) presentation.wait(); return; }
  cachePainted = false; if (covered) herdrHandoffUntil = Date.now() + 1500;
  if (position) term.scrollToLine(position);
}
/** Hold the painted picture while the terminal changes, unless it already shows retained output. */
function hold() { if (cachePainted) presentation.wait(); else presentation.freeze(); }
/** Retained output stays on screen, as a preserved picture, until a frame after Herdr's redraw barrier replaces it. */
function layout(options: Parameters<HerdrLayout['set']>[0]) { herdrLayout.set(cachePainted ? { ...options, preserve: true, cover: false } : options); }
function scheduleTranscript() { transcriptTimer ??= setTimeout(captureTranscript, transport.backgroundDelay); }
term.onScroll(() => { if (cachePainted) cacheTimer ??= setTimeout(saveTranscript, 1000); });
void cache.read(cacheKey).then(saved => {
  if (!saved || streamId && saved.stream !== streamId) return;
  const current = transcript.records.map(record => ({ ...record }));
  transcript.restore(saved.records);
  if (lastOutputAt || streamStarted) {
    for (const record of current) { if (record.kind === 'gap') transcript.gap(record.text, record.at); else transcript.observe(record.text, record.kind === 'history', record.at); }
    saveTranscript(); return;
  }
  cachedUpdated = saved.updated; cachedStream = saved.stream; picture = saved.picture;
  paintCache(saved.position);
  // A working connection replaces retained output without announcing a reconnect.
  if (!navigator.onLine) connection('Offline');
  notify('terminal-ready');
});
function flushTranscript() { captureTranscript(); saveTranscript(); }
window.addEventListener('pagehide', flushTranscript);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushTranscript(); });
function cancelBackfill() { clearTimeout(backfillTimer); backfillTimer = undefined; backfill?.abort(); backfill = undefined; }
function scheduleBackfill() {
  if (herdrTerminal || !backfillNeeded || backfill || backfillTimer || !synchronizedConnection || !tabVisible || document.hidden) return;
  backfillTimer = setTimeout(() => {
    backfillTimer = undefined;
    if (!synchronizedConnection || !tabVisible || document.hidden) return;
    if (transport.backgroundDelay > 1500 && Date.now() - lastOutputAt < 1000) { scheduleBackfill(); return; }
    const controller = backfill = new AbortController(), expected = streamId;
    const timeout = setTimeout(() => controller.abort(), 15000);
    void api<{ streamId: string; seq: number; text: string }>('/api/terminal/history', undefined, controller.signal).then(result => {
      if (controller.signal.aborted || expected !== streamId || result.streamId !== expected) return;
      captureTranscript(); transcript.backfill(result.text); saveTranscript(); backfillNeeded = false;
    }).catch(() => {}).finally(() => { clearTimeout(timeout); if (backfill === controller) backfill = undefined; });
  }, transport.backgroundDelay);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelBackfill(); else scheduleBackfill(); });
window.addEventListener('pagehide', cancelBackfill);
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
    else toast('Queued input belongs to a changed prompt and was not sent.', 'warning');
  }
  if (!synchronizedConnection) { synchronizedConnection = true; disconnectedContext = undefined; dictation.connected(true); }
  scheduleBackfill();
}
function revealReplay() {
  if (!herdrTerminal && replayState && handoff === undefined && transport.socket?.readyState === WebSocket.OPEN && !queue.length && after >= (replayTarget ?? after)) {
    if (handoffPosition) { term.scrollToLine(handoffPosition); handoffPosition = 0; }
    presentation.reveal(); synchronizeInput();
  }
}
const mobileViewport = matchMedia('(pointer: coarse) and (max-width: 1024px)');
function mobileTerminal() { return !!herdrTerminal && mobileViewport.matches; }
function refreshHerdrFrame() {
  if (herdrReady && transport.socket?.readyState === WebSocket.OPEN && projection?.requestFrame()) send({ type: 'herdr-frame-request' });
}
// Resizes and screen updates check the layout often, so it is read again only when settings change.
let fullWidthLayout = saved<string>('herdrLayout', '') === 'full-width';
function fullWidth() { return !!herdrTerminal && !mobileTerminal() && fullWidthLayout; }
// Keep output outside UI state. Ghostty parses synchronously; its callback is an rAF.
function drain() {
  frameQueued = false;
  if (!tabVisible || document.hidden || herdrParked) return;
  // Retained output stays readable until the complete replay replaces it in a single paint.
  if (handoff !== undefined && received < (replayTarget ?? 0)) return;
  let budget = 0, last = after;
  const chunks: string[] = [];
  while (queue.length && (handoff !== undefined || budget < 65536)) {
    const item = queue.shift()!;
    if (item.seq <= last) continue;
    chunks.push(item.data); last = item.seq; budget += item.data.length;
  }
  if (handoff !== undefined) {
    gestures.clear(); term.scrollToBottom(); term.write(handoff + chunks.join(''));
    handoff = undefined; cachePainted = false; after = last;
    if (handoffPosition) { term.scrollToLine(handoffPosition); handoffPosition = 0; }
    if (chunks.length) { lastOutputAt = Date.now(); scheduleTranscript(); }
  } else if (chunks.length) {
    preserveScrollback(term, () => term.write(chunks.join(''))); after = last;
    lastOutputAt = Date.now(); scheduleTranscript(); echo.output();
  }
  // Acknowledge only what this socket delivered, including duplicates of output painted earlier.
  const acknowledged = Math.min(after, socketSeq);
  if (acknowledged > ackedSeq && send({ type: 'ack', seq: acknowledged })) ackedSeq = acknowledged;
  inline.refresh();
  if (queue.length) scheduleDrain();
  else revealReplay();
}
// A resized mobile Herdr pane keeps its previous picture at its previous bottom edge until Herdr redraws the application, instead of painting the stale canvas and a local reflow first.
const resizeCover = new TerminalResizeCover(terminalViewport);
let fittedHeight = 0, resizeTarget = '', resizeCoverTimer: ReturnType<typeof setTimeout> | undefined;
function canCoverResize() { return !!fittedHeight && mobileTerminal() && synchronizedConnection && herdrLayout.rendered && !presentation.pending && !cachePainted && !herdrParked && tabVisible; }
function coverResize() {
  if (!canCoverResize()) return;
  const dimensions = fit.proposeDimensions();
  if (!dimensions || dimensions.cols === term.cols && dimensions.rows === term.rows) return;
  resizeTarget = dimensions.cols + 'x' + dimensions.rows; resizeCover.hold(fittedHeight);
  clearTimeout(resizeCoverTimer); resizeCoverTimer = setTimeout(releaseResizeCover, 3000);
}
function releaseResizeCover() { clearTimeout(resizeCoverTimer); resizeCover.release(); }
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
        layout({ pending: true, preserve: herdrLayout.preserve || herdrLayout.rendered });
      }
      preserveScrollback(term, () => term.resize(nextCols, dimensions.rows));
      // A resize scrolls retained rows like live output, so repaint them with their original layout.
      if (cachePainted) paintCache(Math.floor(term.getViewportY()));
      notifyHerdrSizing();
    }
    fittedHeight = terminalViewport.clientHeight;
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
new ResizeObserver(() => { coverResize(); cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(sizeTerminal); }).observe(terminalViewport);
mobileViewport.addEventListener('change', sizeTerminal);
function viewport() { document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`); }
window.visualViewport?.addEventListener('resize', viewport); window.addEventListener('resize', viewport); viewport();
function rawInput(data: string) {
  terminalActivity();
  if (['\x1b[I', '\x1b[O'].includes(data)) { if (!presentation.pending) send({ type: 'input', data }); return; }
  if (capturedConnection) { toast('Finish opening the connection first.', 'warning'); return; }
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
  if (!canUploadImage()) { toast('Connect to the terminal before attaching an image.', 'warning'); return; }
  const socket = transport.socket!, abort = new AbortController();
  socket.addEventListener('close', () => abort.abort(), { once: true, signal: abort.signal });
  uploadingImage = true; updateRun();
  try {
    for (const file of files) {
      toast('Uploading ' + file.name + '…', 'info');
      const path = await uploadImage(herdrTerminal ? herdrEndpoint('api/herdr/images/upload') : endpoint('api/images/upload'), accessToken, file, abort.signal);
      if (transport.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('The terminal disconnected. Attach the image again after reconnecting.');
      inline.prepareExternalPaste();
      if (herdrTerminal) { send({ type: 'paste', text: path }); state.inputRevision++; }
      else term.paste(path);
    }
    toast(`${files.length} image${files.length === 1 ? '' : 's'} attached.`, 'done'); term.focus();
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
  fullWidthLayout = saved<string>('herdrLayout', '') === 'full-width';
  try {
    applyTerminalTheme();
    const font = JSON.parse(localStorage.getItem('libertty.fontSizePt') || '10');
    if (typeof font === 'number') { fontSizeInput.value = String(font); fontSizeInput.dispatchEvent(new Event('input')); }
    for (const [id, value] of [['auto-alternatives', localStorage.getItem('libertty.autoAlternatives') !== 'false' && localStorage.getItem('libertty.justRun') !== 'true'], ['tap-alternate-send', localStorage.getItem('libertty.tapAlternateSend') !== 'false']] as const) {
      const setting = $<HTMLInputElement>(id); if (setting.checked !== value) { setting.checked = value; setting.dispatchEvent(new Event('change')); }
    }
    const next = validateShortcuts(JSON.parse(localStorage.getItem('libertty.shortcuts') || JSON.stringify(defaults)));
    if (JSON.stringify(next) !== JSON.stringify(shortcuts)) { shortcuts = next; setCtrl(false); renderShortcuts(); }
    inline.setReadingPhrases(saved<unknown>('readingPhrases', null));
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
  focus, notice: toast,
  link: (col, row) => terminalLinkAt(term, col, row, projection?.clickable),
  pan: { enabled: () => fullWidth() && terminalViewport.scrollWidth > terminalViewport.clientWidth, move: pixels => { terminalViewport.scrollLeft += pixels; } },
  scroll: {
    enabled: () => tabVisible && !document.hidden && !capturedConnection && !cachePainted && (term.buffer.active.length <= term.rows && (mobileTerminal() && !herdrParked && state.terminalScroll === true || !herdrTerminal && !!term.wasmTerm?.isAlternateScreen())
      || disconnected() && term.getViewportY() >= term.buffer.active.length - term.rows),
    move: (lines, x, y) => {
      if (lines > 0 && term.buffer.active.length > term.rows) { term.scrollLines(lines); return; }
      // A slow but working link waits for the application instead of switching to retained output.
      if (disconnected()) { if (lines < 0) showRetained(lines); return; }
      if (!synchronizedConnection || !transport.healthy || presentation.pending || herdrLayout.pending) return;
      captureTranscript();
      const bounds = term.element!.querySelector('canvas')!.getBoundingClientRect();
      const column = Math.max(0, Math.min(term.cols - 1, Math.floor((x - bounds.left) * term.cols / bounds.width)));
      const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - bounds.top) * term.rows / bounds.height)));
      if (herdrTerminal) send({ type: 'terminal-scroll', lines: Math.max(-100, Math.min(100, lines)), column, row });
      else {
        const terminal = term.wasmTerm!, button = lines < 0 ? 64 : 65;
        const tracking = [1000, 1002, 1003].some(mode => terminal.getMode(mode));
        const data = !tracking ? lines < 0 ? '\x1b[A' : '\x1b[B'
          : terminal.getMode(1006) ? `\x1b[<${button};${column + 1};${row + 1}M`
          : terminal.getMode(1015) ? `\x1b[${button + 32};${column + 1};${row + 1}M`
          : '\x1b[M' + String.fromCharCode(button + 32, Math.min(255, column + 33), Math.min(255, row + 33));
        rawInput(data.repeat(Math.min(100, Math.abs(lines))));
      }
    },
  },
  tap: (x, y) => {
    transport.activity();
    if (presentation.pending || queue.length || capturedConnection || cachePainted) return;
    if (!herdrTerminal || state.ready) { inline.moveCursor(x, y); return; }
    if (!herdrReady || !mobileTerminal() || herdrLayout.pending || herdrParked || !tabVisible || document.hidden) return;
    const bounds = term.element!.querySelector('canvas')!.getBoundingClientRect();
    const column = Math.floor((x - bounds.left) * term.cols / bounds.width), row = Math.floor((y - bounds.top) * term.rows / bounds.height);
    const cell = projection?.nativeCell(column, row);
    if (cell && send({ type: 'terminal-click', ...cell, cols: term.cols, rows: term.rows })) state.inputRevision++;
  }, copy: copyTerminalText,
});

async function socketURL(signal: AbortSignal) {
  if (lastOutputAt || cachePainted) presentation.wait(); else presentation.freeze();
  const socketURL = herdrTerminal ? herdrEndpoint('herdr/ws') : endpoint('ws');
  socketSeq = ackedSeq = 0;
  if (herdrTerminal) {
    sizeTerminal();
    const geometry = { cols: term.cols, rows: term.rows, mobile: mobileTerminal() && tabVisible && keepingGeometry() };
    herdrLayout.rendered = false; layout({ pending: geometry.mobile, preserve: !!lastOutputAt, cover: geometry.mobile && !herdrParked && !lastOutputAt });
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
    clearTimeout(herdrHandoffTimer);
    if (herdrHandoffUntil > Date.now() && !projection?.hasHistory) { herdrHandoffTimer = setTimeout(() => notifyHerdrRendered(presentationId), herdrHandoffUntil - Date.now()); return; }
    herdrHandoffUntil = 0;
    presentation.reveal(); synchronizeInput();
    if (resizeCover.held && resizeTarget === term.cols + 'x' + term.rows) { clearTimeout(resizeCoverTimer); resizeCover.reveal(); }
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
  const position = Math.floor(term.getViewportY()), covered = coverRetained();
  projection?.update(deferredScreen); deferredScreen = undefined; livePainted(position, covered); scheduleTranscript();
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
    const position = Math.floor(term.getViewportY()), covered = coverRetained();
    if (projection?.frame(message) && !herdrLayout.pending) scheduleHerdrRendered();
    livePainted(position, covered); lastOutputAt = Date.now(); scheduleTranscript();
    revealHerdrLayout();
    if (fullWidth()) sizeTerminal(); refreshHerdrFrame();
  } finally { echo.output(); send({ type: 'ack', seq: message.seq }); }
}
type Handlers = { [K in ServerMessage['type']]: (message: Extract<ServerMessage, { type: K }>) => void };
function screenMessage(message: Extract<ServerMessage, { type: 'screen' | 'screen-delta' }>) {
  const text = history.receive(message);
  if (text === undefined) return;
  deferredScreen = text; lastOutputAt = Date.now();
  if (document.hidden || !tabVisible || herdrLayout.pending || herdrParked) return;
  applyDeferredScreen(); echo.output(); if (fullWidth()) sizeTerminal(); refreshHerdrFrame(); scheduleHerdrRendered();
}
function capturedMessage(message: Extract<ServerMessage, { type: 'ssh-command' | 'herdr-command' }>) {
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
}
const handlers: Handlers = {
  'herdr-layout': message => {
    discardHerdrFrames();
    if (herdrParked) return;
    if (message.cols !== term.cols || message.rows !== term.rows || !mobileTerminal()) return;
    layout({ pending: true, barrierReady: message.ready });
  },
  'herdr-frame': message => {
    if (document.hidden || !tabVisible || herdrParked || herdrLayout.holding) { send({ type: 'ack', seq: message.seq }); return; }
    if (herdrLayout.pending || presentation.pending || !herdrReady) { discardHerdrFrames(); paintHerdrFrame(message); return; }
    pendingFrames.push({ socket: transport.socket, frame: message });
    if (pendingFrames.length > 2) { frameScheduler.cancel(); drainHerdrFrames(); } else frameScheduler.request();
  },
  'screen': screenMessage,
  'screen-delta': screenMessage,
  'input-line': message => {
    const intact = message.prompt === state.prompt && message.revision === state.inputRevision && state.ready;
    inputLines.get(message.id)?.(intact && typeof message.text === 'string' && typeof message.cursor === 'number' ? { text: message.text, cursor: message.cursor } : undefined);
    inputLines.delete(message.id);
  },
  'repair-result': message => {
    const intact = message.prompt === state.prompt && state.ready && !state.exited;
    if (intact && message.accepted && [state.inputRevision, state.inputRevision + 1].includes(message.revision)) state.inputRevision = message.revision;
    else if (message.accepted) message.accepted = false;
    if (message.source === 'dictation') {
      if (intact && message.revision === state.inputRevision) inline.backendResult(message);
    } else repairs.get(message.id)?.(message);
    if (message.accepted) term.scrollToBottom();
  },
  'pasted': message => {
    if (message.prompt === state.prompt && message.revision === state.inputRevision + 1) {
      state.inputRevision = message.revision;
      term.scrollToBottom();
      if (message.repairing) inline.backendLoading(message.text, !!herdrTerminal);
      else inline.externalPaste(message.text, message.replace, message.source === 'dictation', !!herdrTerminal);
    }
    else inline.disconnect();
  },
  'transfer': message => {
    if (transfersSeen.has(message.request.id)) return;
    transfersSeen.add(message.request.id); if (transfersSeen.size > 256) transfersSeen.delete(transfersSeen.values().next().value!);
    transferView(message.request, fileClient(baseURL.href, session, () => accessToken, async () => { throw new Error('Reconnect to this backend and try again.'); }),
      () => api('/api/files/transfer', { id: message.request.id, action: 'ack' }),
      () => saveDownload(baseURL.href, () => api('/api/files/transfer', { id: message.request.id, action: 'download' }), message.request.name));
  },
  'dictation': message => dictation.event(message.id, message.state, message.message, message.resume),
  'reading-file': message => showReading({ path: message.path }),
  'reading-capture': message => showReading({ capture: message.id, name: message.name, exitCode: message.exitCode }),
  'reading-error': message => { inline.dictationPending(false); toast(message.message); },
  'ssh-command': capturedMessage,
  'herdr-command': capturedMessage,
  'ssh-released': message => { if (capturedConnection === message.id) capturedConnection = undefined; },
  'input-ack': message => {
    if (typeof message.seq === 'number' && message.seq > confirmedInput) { confirmedInput = message.seq; transport.confirmed(); }
    if (numberedInput) { if (typeof message.seq === 'number') sentInput.confirm(message.seq); return; }
    // Keys the previous connection never delivered rejoin the unsent queue under the context they were typed in.
    numberedInput = true;
    const pending = sentInput.settle(message.seq);
    if (pending && (!pending.complete || !unsentInput.prepend(pending.data, pending.context || disconnectedContext))) toast('Keys typed before the connection dropped were not delivered.');
  },
  'hello': message => {
    replayTarget = message.lastSeq;
    const changedStream = !!(streamId && streamId !== message.streamId || cachedStream && cachedStream !== message.streamId);
    if (changedStream) { transcript.restore([]); cachedStream = ''; }
    streamId = message.streamId; streamStarted = true;
    // Reset through the terminal parser. Ghostty's reset() frees native memory
    // still referenced by its input and selection handlers.
    if (message.reset) {
      if (!changedStream && !cachePainted) captureTranscript();
      transcript.gap('The connection resumed from a screen snapshot; older output may be missing.'); backfillNeeded = true;
      handoffPosition = Math.floor(term.getViewportY()); queue.clear(); after = received = 0; inline.disconnect();
      if (cachePainted) { handoff = '\x1bc\x1b[3J'; presentation.wait(); if (!frameQueued) scheduleDrain(); }
      else { presentation.freeze(); term.clearSelection(); term.scrollToBottom(); term.write('\x1bc\x1b[3J'); }
    }
    if (message.truncated) {
      const notice = '\r\n\x1b[33mOlder output is unavailable. Ctrl-L redraws the current program.\x1b[0m\r\n';
      if (handoff === undefined) term.write(notice); else handoff += notice;
      toast('Reconnected with limited scrollback. Use Ctrl-L to redraw if needed.', 'info', { redraw: 'Redraw' });
    }
  },
  'output': message => {
    // Output over retained rows is replayed after the next reset instead.
    if (cachePainted && handoff === undefined) return;
    socketSeq = Math.max(socketSeq, message.seq);
    if (message.seq > received) { queue.push(message); received = message.seq; }
    if (!frameQueued) scheduleDrain();
  },
  'state': message => {
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
  },
  'edit-result': message => {
    edits.get(message.id)?.(message.accepted); edits.delete(message.id);
    if (!message.accepted) state.inputRevision = message.revision;
  },
  'result': message => {
    if (pendingCommand?.id !== message.id) return;
    pendingCommand = undefined;
    if (!message.accepted) toast(message.message || 'Command was not sent.');
    updateRun();
  },
  'pong': () => {},
};
function socketMessage(event: MessageEvent) {
  const message: ServerMessage = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  (handlers[message.type] as ((message: ServerMessage) => void) | undefined)?.(message);
}
function socketClosed(event?: CloseEvent) {
  cancelBackfill(); flushTranscript(); releaseResizeCover();
  discardHerdrFrames();
  if (directAttempt && !replayState) authorized = false;
  herdrDormant = herdrParked;
  disconnectedContext = inputContext() || disconnectedContext;
  dictation.connected(false); synchronizedConnection = false; streamStarted = false; handoffPosition = 0; herdrHandoffUntil = 0; clearTimeout(herdrHandoffTimer);
  // An unfinished replay leaves retained output in place, so the next connection replays from the start.
  if (handoff !== undefined) { handoff = undefined; queue.clear(); after = received = 0; }
  echo.reset();
  presentation.wait(); replayState = false;
  herdrReady = false;
  if (event?.code === 4001 || state.exited) inline.disconnect(); else inline.suspend();
  for (const resolve of edits.values()) resolve(false); edits.clear();
  for (const resolve of inputLines.values()) resolve(); inputLines.clear();
  for (const [id, resolve] of repairs) resolve({ id, accepted: false, candidates: [], original: '', selected: '', prompt: state.prompt, revision: state.inputRevision }); repairs.clear();
  // Never resend uncertain input or an uncertain command automatically.
  if (pendingCommand) { pendingCommand = undefined; toast('Connection lost before acknowledgement. Check the terminal before running again.'); }
  if ((event?.code === 1011 || event?.code === 1013) && event.reason) toast(event.reason);
  if (event?.code === 4001) { unsentInput.clear(); sentInput.clear(); disconnectedContext = undefined; dictation.cancel(); connection('Other tab'); toast(event.reason, 'warning'); return false; }
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
  discardHerdrFrames(); releaseResizeCover();
  if (herdrTerminal && !herdrParked) {
    layout({ pending: mobileTerminal(), preserve: true, barrierReady: herdrLayout.barrierReady });
    send({ type: 'herdr-active', active: false });
  }
}, shown: () => {
  rendering.activity(); frameScheduler.activity();
  if (herdrTerminal && tabVisible && !herdrParked) send({ type: 'herdr-active', active: true });
  sizeTerminal(); if ((queue.length || handoff !== undefined) && !frameQueued) scheduleDrain(); revealReplay();
},
  expired: () => {
    if (herdrTerminal) send({ type: 'resize', cols: term.cols, rows: term.rows, mobile: false });
    if (dictation.active) return false;
    inline.suspend();
  } });

function execute(command: string) {
  if (presentation.pending || capturedConnection || !state.ready && !herdrReady || state.exited || pendingCommand || transport.socket?.readyState !== WebSocket.OPEN) { toast('Wait for terminal input before running a command.', 'warning'); return; }
  if (!command.trim() || /[\x00-\x1f\x7f]/.test(command)) { toast('Use one command line at a time.', 'warning'); return; }
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
  if (!text) { toast('Select terminal text first.', 'warning'); return; }
  try { await copyTerminalText(text); toast('Selection copied.', 'done'); } catch { toast('Clipboard is unavailable in this browser context.'); }
}
$('copy-selection').onclick = () => void copySelection();
$('new-shell').onclick = async () => {
  if (herdrTerminal) return;
  if (!state.exited && !confirm('End the current session and start a new shell? Running programs in this session will stop.')) return;
  try {
    inline.disconnect();
    transport.suspend();
    await api('/api/new', {}); transcript.restore([]); clearedScreen = terminalSnapshot(term).text; cachedStream = ''; void cache.clear(cacheKey); after = received = 0; streamId = ''; queue.clear(); unsentInput.clear(); sentInput.clear(); disconnectedContext = undefined; pendingCommand = undefined;
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
      releaseResizeCover(); hold();
      herdrPresentation = event.data.presentation; herdrLayout.cancel();
      notifyHerdrSizing(); notifyCachedRendered();
      return;
    }
    if (event.data?.type === 'herdr-resize-cover' && herdrTerminal) {
      // The workspace resizes this pane after the reply, so the stale canvas never paints before the cover.
      if (canCoverResize() && !resizeCover.held) {
        resizeTarget = ''; resizeCover.hold(fittedHeight);
        clearTimeout(resizeCoverTimer); resizeCoverTimer = setTimeout(() => { if (!resizeTarget) releaseResizeCover(); }, 500);
      }
      notify('herdr-resize-ready'); return;
    }
    if (event.data?.type === 'authorize') { herdrPreview = false; accessToken = event.data.accessToken; void transport.connect(undefined, true); }
    if (event.data?.type === 'recovery-failed') connection('Session ended');
    if (event.data?.type === 'notice-action' && Object.hasOwn(noticeActions, event.data.id)) noticeActions[event.data.id as NoticeActionId]();
    if (event.data?.type === 'herdr-park' && herdrTerminal) {
      const parked = event.data.parked === true;
      if (herdrParked === parked) return;
      herdrParked = parked; dictation.visibility(!parked && tabVisible);
      if (parked) { flushTranscript(); releaseResizeCover(); gestures.cancelGesture(); discardHerdrFrames(); }
      rendering.setVisible(!parked && tabVisible);
      clearTimeout(parkTimer);
      if (parked) parkTimer = setTimeout(() => { if (herdrParked) { herdrDormant = true; transport.suspend(); } }, inactiveGrace);
      // The tab-visibility message that follows an unpark reconnects a dormant pane.
      if (!parked) herdrDormant = false;
      send({ type:'herdr-active', active:!parked });
      if (!parked) {
        const cols = term.cols, rows = term.rows; sizeTerminal();
        const preserve = event.data.preserve === true && cols === term.cols && rows === term.rows;
        herdrLayout.rendered = preserve && mobileTerminal(); layout({ pending: mobileTerminal(), preserve });
        send({ type:'herdr-frame-request' }); notifyCachedRendered();
      }
      return;
    }
    if (event.data?.type === 'tab-visibility') { tabVisible = event.data.visible; if (!tabVisible) { cancelBackfill(); flushTranscript(); releaseResizeCover(); gestures.cancelGesture(); hold(); discardHerdrFrames(); } else { rendering.activity(); frameScheduler.activity(); } rendering.setVisible(tabVisible && !herdrParked); if (!tabVisible && herdrTerminal) layout({ pending: true, preserve: false, barrierReady: herdrLayout.barrierReady }); dictation.visibility(tabVisible); cancelAnimationFrame(outputFrame); frameQueued = false; if (queue.length || handoff !== undefined) scheduleDrain(); if (tabVisible) { sizeTerminal(); shortcutState = ''; publishShortcuts(); revealReplay(); notifyCachedRendered(); } }
    if (event.data?.type === 'tab-visibility' && herdrTerminal) {
      if (!tabVisible) transport.suspend();
      else transport.foreground();
    } else if (event.data?.type === 'tab-visibility') {
      clearTimeout(tabTimer);
      // The workspace's selected tab counts as shown while another page covers it.
      tabSeen ||= tabVisible || event.data.active === true;
      if (tabVisible) { tabExpired = false; transport.foreground(); }
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
