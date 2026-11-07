import { workspaceMessage, type TerminalEvents } from './frame-protocol.ts';
import { TerminalConnection, TerminalVisibility } from './terminal-lifecycle.ts';
import { requestJSON } from './api.ts';
import { saved } from './persistence.ts';
import { wireProtocols, encodeWire, encodeAudio } from './wire.ts';
import { fileClient, saveDownload } from './file-client.ts';
import { transferView } from './transfer-view.ts';
import { imagePicker, uploadImage } from './image-upload.ts';
import { Terminal, FitAddon } from './terminal-adapter.ts';
import './terminal-surface.css';
import type { ClientMessage, ServerMessage, ShellState, RepairResult } from './protocol.ts';
import './style.css';
import { backendAccess, rememberBackendAccess, forgetBackendAccess } from './backend-access.ts';
import { Queue } from './queue.ts';
import { PendingRequests } from './pending-requests.ts';
import { TerminalReplay } from './terminal-replay.ts';
import { dictationTarget } from './protocol.ts';
import { SentInput, UnsentInput, type InputContext } from './unsent-input.ts';
import { applyTheme, terminalThemes, watchSystemTheme } from './theme.ts';
import { adaptDarkAppColors } from './terminal-colors.ts';
import { ReconnectingSocket, stalledLabel } from './reconnecting-socket.ts';
import { HerdrLayout } from './herdr-layout.ts';
import { nativeSession, herdrSessionAdapter } from './terminal-session.ts';
import { TerminalGestures } from './terminal-gestures.ts';
import { terminalLinkAt } from './terminal-links.ts';
import { TerminalFocus } from './terminal-focus.ts';
import { preserveScrollback } from './terminal-viewport.ts';
import { TerminalEcho } from './predicted-echo.ts';
import { terminalCacheKey } from './terminal-cache.ts';
import { createRetainedOutput } from './retained-output.ts';
import { TerminalHistory } from './terminal-history.ts';
import { TerminalProjection } from './terminal-projection.ts';
import { TerminalPresentation, TerminalResizeCover } from './terminal-presentation.ts';
import { TerminalRendering } from './terminal-rendering.ts';
import { OutputScheduler } from './output-scheduler.ts';
import { mergeHerdrFrames, type HerdrFrameMessage } from './terminal-frame-batch.ts';
import { DictationControl } from './dictation.ts';
import { InlineSuggestions } from './inline-suggestions.ts';
import { ShortcutBar } from './shortcut-bar.ts';
import { defaults, validateShortcuts } from './shortcuts.ts';
import {
  readingPhrases,
  readingRequest,
  readingPipeline,
  type ReadingOpen,
} from './reading-request.ts';
import { remoteActions, type NoticeKind, type Notify, type RemoteNotice } from './notice-model.ts';
import { NoticeCenter } from './notices.ts';
const params = new URLSearchParams(location.search);
const embedded = params.get('embedded') === '1' && parent !== window;
const baseURL = new URL(params.get('backend') || document.baseURI);
const session = params.get('session') || 'default';
const herdrTerminal = params.get('herdrTerminal');
const herdrCore = params.get('herdrCore') === '1';
let herdrReady = false;
let herdrPresentation = '';
const lifecycle = new TerminalConnection();
const visibility = new TerminalVisibility(
  !!herdrTerminal,
  embedded,
  !!herdrTerminal && params.get('herdrPreview') === '1',
  {
    foreground: () => transport.foreground(),
    suspend: () => transport.suspend(),
    expire: () => {
      if (!dictation.active) {
        inline.suspend();
        transport.suspend();
      }
    },
  },
);
let accessToken: string | undefined = backendAccess(baseURL.href);
let authorized = false,
  directAttempt = false;
const backgroundGrace = 20000;
const keepingGeometry = () => !document.hidden || !transport.backgroundExpired;
const native = nativeSession(baseURL, session);
const sessionAdapter = herdrTerminal
  ? herdrSessionAdapter(baseURL, herdrTerminal, {
      core: herdrCore,
      session: params.get('herdrSession'),
      source: params.get('herdrSource'),
    })
  : native;
const endpoint = native.endpoint;
const herdrEndpoint = sessionAdapter.endpoint;
function sessionInputState() {
  return {
    hasState: lifecycle.hasState,
    ready: herdrReady,
    layoutPending: herdrLayout.pending,
    parked: visibility.parked,
    identity: state.inputContext,
    stream: replay.stream,
    after: replay.after,
    target: replay.target,
  };
}
function notify<K extends keyof TerminalEvents>(
  type: K,
  ...args: {} extends TerminalEvents[K] ? [data?: TerminalEvents[K]] : [data: TerminalEvents[K]]
) {
  const data = args[0];
  if (embedded) parent.postMessage({ type, session, ...data }, location.origin);
}
if (embedded) document.documentElement.classList.add('embedded-terminal');
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const transport = new ReconnectingSocket({
  available: () =>
    (keepingGeometry() || dictation.active) && visibility.available(dictation.active),
  protocols: wireProtocols,
  checkpoint: () => sentInput.pending,
  stalled: (lastContact) => connection(stalledLabel(lastContact)),
  prepare: prepareConnection,
  open: socketOpened,
  message: socketMessage,
  close: socketClosed,
  error: connectionError,
});
let state: ShellState = {
  cwd: '',
  inputRevision: 0,
  promptRevision: 0,
  ready: false,
  prompt: 0,
  exited: false,
};
const replay = new TerminalReplay();
let lastOutputAt = 0;
let capturedConnection: string | undefined;
let pendingCommand: { id: string } | undefined;
const edits = new PendingRequests<boolean>();
const inputLines = new PendingRequests<{ text: string; cursor: number } | undefined>();
const repairs = new PendingRequests<RepairResult>();
const unsentInput = new UnsentInput();
// Numbered keys let a replacement connection resend exactly the ones its predecessor never delivered.
const inputClient = crypto.randomUUID(),
  sentInput = new SentInput();
// Only a backend that reports delivered keys accepts numbered ones.
let inputSeq = 0,
  numberedInput = false;
let confirmedInput = 0;
let disconnectedContext: InputContext | undefined;
const shortcutBar = new ShortcutBar({
  container: $('shortcut-buttons'),
  execute,
  input: rawInput,
  focus: () => term.focus(),
  attachImages: () => images.click(),
  save: (value) => persist('shortcuts', value),
  changed: updateRun,
  published: () => publishShortcuts(),
});
function persist(key: string, value: unknown) {
  try {
    localStorage.setItem('libertty.' + key, JSON.stringify(value));
  } catch {
    toast('Browser storage is unavailable. ' + 'Settings will last for this page only.', 'warning');
  }
}
const transfersSeen = new Set<string>();
let shortcutState = '';
let uploadingImage = false;
let dictationWaiting = false;
const queue = replay.queue;
let frameQueued = false;
let outputFrame = 0;
const pendingFrames = new Queue<{ socket: WebSocket | undefined; frame: HerdrFrameMessage }>();
const frameScheduler = new OutputScheduler(
  drainHerdrFrames,
  () => visibility.visible && !document.hidden && !visibility.parked,
  true,
);
function scheduleDrain() {
  if (!visibility.visible || document.hidden || visibility.parked) return;
  frameQueued = true;
  outputFrame = requestAnimationFrame(drain);
}
// An embedded terminal sends notices to the workspace, which returns these action ids.
const noticeActions = { redraw: () => rawInput('\x0c'), reconnect: () => transport.activity() };
type TerminalAction = { id: keyof typeof noticeActions; label: string };
const runTerminalAction = (id: string) => {
  if (Object.hasOwn(noticeActions, id)) noticeActions[id as TerminalAction['id']]();
};
const notices = embedded ? undefined : new NoticeCenter();
const localNotice = (notice: RemoteNotice) => ({
  ...notice,
  actions: remoteActions(notice, runTerminalAction),
});
let connectionStatus = 'null';
let connectionReason = '';
function toast(message: string, kind: NoticeKind = 'error', actions: TerminalAction[] = []) {
  const notice = { message, kind, actions };
  if (embedded) notify('terminal-notice', notice);
  else notices!.notify(localNotice(notice));
}
/** Terminal parts without frame actions show plain notices. */
const plainToast: Notify = (message, kind) => toast(message, kind);
function connection(label: string, online = false) {
  if (online) connectionReason = '';
  $('connection-label').textContent = label;
  const updated =
    lastOutputAt || retained.cachedUpdated
      ? ` · last output ${new Date(lastOutputAt || retained.cachedUpdated).toLocaleTimeString()}`
      : '';
  // The workspace reports an ended embedded terminal itself, so only a standalone terminal shows that state.
  const status: RemoteNotice | undefined =
    online ||
    ['Connecting', 'Locked', 'Other tab'].includes(label) ||
    (embedded && label === 'Session ended')
      ? undefined
      : label === 'Session ended'
        ? {
            message: 'This terminal has ended. Open its saved host to reconnect.',
            kind: 'error',
            actions: [],
          }
        : {
            message: label.startsWith('Connection stalled')
              ? label
              : 'Reconnecting' + (connectionReason ? ' · ' + connectionReason : updated),
            kind: 'progress',
            actions: [{ id: 'reconnect', label: 'Retry now' }],
          };
  const serialized = JSON.stringify(status ?? null);
  if (serialized !== connectionStatus) {
    connectionStatus = serialized;
    if (embedded) notify('terminal-status', { status });
    else notices!.set('connection', status && localNotice(status));
  }
  updateRun();
}
function updateRun() {
  const available =
    (state.ready || herdrReady) &&
    !state.exited &&
    transport.socket?.readyState === WebSocket.OPEN &&
    !pendingCommand &&
    !presentation.pending;
  $('shell-status').textContent = state.exited ? 'Exited' : state.ready ? 'At prompt' : 'Running';
  for (const button of document.querySelectorAll<HTMLButtonElement>('.command-shortcut'))
    button.disabled = !available;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.image-upload'))
    button.disabled = !canUploadImage();
  $<HTMLButtonElement>('terminal-enter').disabled = !canSendReturn();
  publishShortcuts(available);
}
function publishShortcuts(
  available = (state.ready || herdrReady) &&
    !state.exited &&
    transport.socket?.readyState === WebSocket.OPEN &&
    !pendingCommand &&
    !presentation.pending,
) {
  if (!embedded) return;
  const snapshot = {
      shortcuts: shortcutBar.shortcuts,
      ctrl: shortcutBar.ctrl,
      available,
      imageAvailable: canUploadImage(),
      returnAvailable: canSendReturn(),
    },
    serialized = JSON.stringify(snapshot);
  if (serialized === shortcutState) return;
  shortcutState = serialized;
  notify('terminal-shortcuts', snapshot);
}
async function api<T>(url: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  return requestJSON<T>(endpoint(url), data, { token: () => accessToken, signal });
}
function send(message: ClientMessage): boolean {
  if (
    ['paste', 'replace', 'command', 'dictation-paste', 'input-line', 'repair'].includes(
      message.type,
    )
  )
    echo.cancel();
  if (
    (message.type === 'dictation' && message.action === 'start') ||
    message.type === 'dictation-paste'
  ) {
    message.readingPhrases = readingPhrases(saved<unknown>('readingPhrases', null));
  }
  if (transport.socket?.readyState !== WebSocket.OPEN) return false;
  transport.socket.send(encodeWire(message));
  return true;
}
// Ghostty fixes its ANSI palette when the terminal is created, so a theme change reloads this document and replays the session.
const terminalTheme = applyTheme();
// Chromium can report a different system appearance while leaving a page, so only a change that lasts reloads it.
let themeChange: ReturnType<typeof setTimeout> | undefined;
function applyTerminalTheme() {
  clearTimeout(themeChange);
  themeChange = setTimeout(() => {
    if (applyTheme() !== terminalTheme) location.reload();
  }, 250);
}
watchSystemTheme(applyTerminalTheme);
const fontSizeInput = $<HTMLInputElement>('font-size');
try {
  const stored = JSON.parse(localStorage.getItem('libertty.fontSizePt') || 'null');
  if (typeof stored === 'number') fontSizeInput.value = String(stored);
} catch {
  /* Use the default when storage is unavailable or stale. */
}
if (!fontSizeInput.checkValidity()) fontSizeInput.value = fontSizeInput.defaultValue;
const fontFamily = getComputedStyle(document.documentElement).fontFamily;
// Load the font before the terminal measures cells.
await document.fonts.load(`14px ${fontFamily}`).catch(() => {});
const term = new Terminal({
  fontSize: (fontSizeInput.valueAsNumber * 4) / 3,
  fontFamily,
  scrollback: 5000,
  cursorBlink: true,
  smoothScrollDuration: 0,
  theme: terminalThemes[terminalTheme],
});
const rendering = new TerminalRendering(term);
await term.open($('terminal'));
rendering.attach();
if (terminalTheme === 'paper' || terminalTheme === 'flag')
  adaptDarkAppColors(term, terminalThemes[terminalTheme]);
const focus = new TerminalFocus(term);
const fit = new FitAddon();
term.loadAddon(fit);
const history = new TerminalHistory(() => send({ type: 'herdr-frame-request' }));
let deferredScreen: string | undefined;
const projection = sessionAdapter.projected
  ? new TerminalProjection(term, term.ghostty!)
  : undefined;
const terminalViewport = $('terminal-viewport');
const herdrLayout = new HerdrLayout(terminalViewport);
const echo = new TerminalEcho(term, $('terminal'));
const presentation = new TerminalPresentation(terminalViewport, () => {
  updateRun();
  synchronizeInput();
});

const cacheKey = terminalCacheKey(
  baseURL.href,
  herdrTerminal ? (herdrCore ? 'core:' : '') + (params.get('herdrSession') || '') : session,
  herdrTerminal || '',
  params.get('herdrSource') || '',
  params.get('herdrPane') || '',
);
let presentedAt = 0;
const retained = createRetainedOutput({
  term,
  lifecycle,
  replay,
  transport,
  visibility,
  projection,
  herdrLayout,
  presentation,
  get gestures() {
    return gestures;
  },
  get state() {
    return state;
  },
  get lastOutputAt() {
    return lastOutputAt;
  },
  get presentedAt() {
    return presentedAt;
  },
  get herdrPresentation() {
    return herdrPresentation;
  },
  herdrTerminal: !!herdrTerminal,
  herdrCore,
  cacheKey,
  updateRun,
  connection,
  ready: () => notify('terminal-ready'),
  rendered: (value) => notify('terminal-rendered', value),
  history: (signal) => api('/api/terminal/history', undefined, signal),
});
void retained.restore();
function inputContext(): InputContext | undefined {
  const target = dictationTarget(state);
  if (!target || state.exited || capturedConnection) return;
  const context: InputContext = {
    session: baseURL.href + ':' + session + ':' + (herdrTerminal || ''),
    connection: lifecycle.epoch,
    prompt: state.prompt,
    revision: state.inputRevision,
    target,
  };
  return sessionAdapter.inputContext(context, sessionInputState(), () => {
    const buffer = term.buffer.active,
      lines: string[] = [];
    for (let row = Math.max(0, buffer.length - 1000); row < buffer.length; row++) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) || '';
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.at(-1) === '') lines.pop();
    return JSON.stringify([lines, buffer.cursorX, buffer.cursorY, term.cols]);
  });
}
function synchronizeInput() {
  if (presentation.pending || queue.length || !sessionAdapter.synchronized(sessionInputState()))
    return;
  if (unsentInput.length) {
    const context = inputContext();
    if (!context) return;
    const pending = unsentInput.take(context);
    if (pending) for (const data of pending) rawInput(data);
    else toast('Queued input belongs to a changed prompt and was not sent.', 'warning');
  }
  if (lifecycle.synchronize()) {
    disconnectedContext = undefined;
    dictation.connected(true);
  }
  retained.scheduleBackfill();
}
function revealReplay() {
  if (
    (!herdrTerminal || herdrCore) &&
    lifecycle.hasState &&
    retained.handoff === undefined &&
    transport.socket?.readyState === WebSocket.OPEN &&
    replay.complete
  ) {
    retained.restorePosition();
    presentation.reveal();
    synchronizeInput();
    if (herdrCore) {
      notifyHerdrSizing();
      scheduleHerdrRendered();
    }
  }
}
const mobileViewport = matchMedia('(pointer: coarse) and (max-width: 1024px)');
function mobileTerminal() {
  return sessionAdapter.mobile(mobileViewport.matches);
}
function refreshHerdrFrame() {
  if (herdrReady && transport.socket?.readyState === WebSocket.OPEN && projection?.requestFrame())
    send({ type: 'herdr-frame-request' });
}
// Resizes and screen updates check the layout often, so it is read again only when settings change.
let fullWidthLayout = saved<string>('herdrLayout', '') === 'full-width';
function fullWidth() {
  return sessionAdapter.projected && !mobileTerminal() && fullWidthLayout;
}
// Keep output outside UI state. Ghostty parses synchronously; its callback is an rAF.
function drain() {
  frameQueued = false;
  if (!visibility.visible || document.hidden || visibility.parked) return;
  // Retained output stays readable until the complete replay replaces it in a single paint.
  if (retained.handoff !== undefined && replay.received < (replay.target ?? 0)) return;
  const { chunks, sequence: last } = replay.take(retained.handoff !== undefined ? Infinity : 65536);
  if (retained.handoff !== undefined) {
    gestures.clear();
    term.scrollToBottom();
    term.write(retained.handoff + chunks.join(''));
    retained.completeReplay();
    replay.after = last;
    retained.restorePosition();
    if (chunks.length) {
      lastOutputAt = Date.now();
      retained.scheduleTranscript();
    }
  } else if (chunks.length) {
    preserveScrollback(term, () => term.write(chunks.join('')));
    replay.after = last;
    lastOutputAt = Date.now();
    retained.scheduleTranscript();
    echo.output();
  }
  // Acknowledge only what this socket delivered, including duplicates of output painted earlier.
  replay.acknowledge((seq) => send({ type: 'ack', seq }));
  inline.refresh();
  if (queue.length) scheduleDrain();
  else revealReplay();
}
// A resized mobile Herdr pane keeps its previous picture at its previous bottom edge until Herdr redraws the application, instead of painting the stale canvas and a local reflow first.
const resizeCover = new TerminalResizeCover(terminalViewport);
let fittedHeight = 0,
  resizeTarget = '',
  resizeCoverTimer: ReturnType<typeof setTimeout> | undefined;
function canCoverResize() {
  return (
    !!fittedHeight &&
    mobileTerminal() &&
    lifecycle.synchronized &&
    herdrLayout.rendered &&
    !presentation.pending &&
    !retained.cachePainted &&
    !visibility.parked &&
    visibility.visible
  );
}
function coverResize() {
  if (!canCoverResize()) return;
  const dimensions = fit.proposeDimensions();
  if (!dimensions || (dimensions.cols === term.cols && dimensions.rows === term.rows)) return;
  resizeTarget = dimensions.cols + 'x' + dimensions.rows;
  resizeCover.hold(fittedHeight);
  clearTimeout(resizeCoverTimer);
  resizeCoverTimer = setTimeout(releaseResizeCover, 3000);
}
function releaseResizeCover() {
  clearTimeout(resizeCoverTimer);
  resizeCover.release();
}
function sizeTerminal() {
  if (visibility.parked) {
    if (!herdrCore && !mobileTerminal() && herdrReady)
      send({ type: 'resize', cols: term.cols, rows: term.rows, mobile: false });
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
      element.style.width =
        Math.max(terminalViewport.clientWidth, nativeCols * metrics.width + 8 + 15) + 'px';
    } else {
      element.style.width = '100%';
      terminalViewport.scrollLeft = 0;
    }
    // FitAddon caches its last fit and cannot account for a manual native-width
    // resize. Use its public measurements for both modes, with one resize owner.
    const dimensions = fit.proposeDimensions();
    const nextCols = wide ? projection?.nativeColumns || 80 : dimensions?.cols;
    if (dimensions && nextCols && (term.cols !== nextCols || term.rows !== dimensions.rows)) {
      discardHerdrFrames();
      if (mobileTerminal()) {
        // Keep a certified mobile view and its focused textarea visible while
        // keyboard geometry redraws; hiding the input would dismiss the IME.
        retained.layout({ pending: true, preserve: herdrLayout.preserve || herdrLayout.rendered });
      }
      preserveScrollback(term, () => term.resize(nextCols, dimensions.rows));
      // A resize scrolls retained rows like live output, so repaint them with their original layout.
      if (retained.cachePainted) retained.paintCache(Math.floor(term.getViewportY()));
      notifyHerdrSizing();
    }
    fittedHeight = terminalViewport.clientHeight;
    if (projection?.resize(mobileTerminal())) scheduleHerdrRendered();
    // Herdr resolves the selected pane asynchronously after the WS upgrade.
    // Send geometry only after its state acknowledges that the handler is ready.
    if (!herdrTerminal || herdrReady)
      send(
        sessionAdapter.resize(
          term.cols,
          term.rows,
          mobileTerminal() && visibility.visible && keepingGeometry(),
        ),
      );
    inline.refresh();
    refreshHerdrFrame();
  } catch {
    /* hidden during layout */
  }
}
fontSizeInput.oninput = async () => {
  if (
    !fontSizeInput.checkValidity() ||
    (fontSizeInput.valueAsNumber * 4) / 3 === term.options.fontSize
  )
    return;
  await term.setFontSize((fontSizeInput.valueAsNumber * 4) / 3);
  sizeTerminal();
  persist('fontSizePt', fontSizeInput.valueAsNumber);
};
fontSizeInput.onchange = () => {
  fontSizeInput.value = String((term.options.fontSize! * 3) / 4);
};
let resizeFrame = 0;
new ResizeObserver(() => {
  coverResize();
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(sizeTerminal);
}).observe(terminalViewport);
mobileViewport.addEventListener('change', sizeTerminal);
function viewport() {
  document.documentElement.style.setProperty(
    '--app-height',
    `${window.visualViewport?.height || window.innerHeight}px`,
  );
}
window.visualViewport?.addEventListener('resize', viewport);
window.addEventListener('resize', viewport);
viewport();
function rawInput(data: string, source?: string) {
  terminalActivity();
  if (herdrCore && source === 'mouse') {
    if (
      presentation.pending ||
      herdrLayout.pending ||
      capturedConnection ||
      !herdrReady ||
      !visibility.visible ||
      document.hidden ||
      transport.socket?.readyState !== WebSocket.OPEN ||
      !lifecycle.hasState
    )
      return;
    if (send({ type: 'input', data })) state.inputRevision++;
    return;
  }
  if (['\x1b[I', '\x1b[O'].includes(data)) {
    if (!presentation.pending) send({ type: 'input', data });
    return;
  }
  if (capturedConnection) {
    toast('Finish opening the connection first.', 'warning');
    return;
  }
  data = shortcutBar.modify(data);
  if (
    presentation.pending ||
    (herdrTerminal && (!herdrReady || herdrLayout.pending)) ||
    transport.socket?.readyState !== WebSocket.OPEN ||
    !lifecycle.hasState
  ) {
    const context = unsentInput.context || disconnectedContext || inputContext();
    if (!unsentInput.add(data, context)) toast('Input could not be queued for this terminal.');
    return;
  }
  const predict = inline.predictionReady && !queue.length && !herdrLayout.pending;
  if (!inline.raw(data)) {
    echo.cancel();
    return;
  }
  const context = numberedInput && !herdrTerminal ? inputContext() : undefined,
    seq = numberedInput ? inputSeq + 1 : undefined;
  if (send({ type: 'input', data, ...(seq ? { seq } : {}) })) {
    if (seq) {
      inputSeq = seq;
      sentInput.add(seq, data, context);
    }
    term.scrollToBottom();
    echo.input(data, state, predict);
    state.inputRevision++;
  } else if (!unsentInput.add(data, disconnectedContext || inputContext()))
    toast('Input could not be queued for this terminal.');
}
function replaceLine(text: string): Promise<boolean> {
  if (
    capturedConnection ||
    !state.ready ||
    state.exited ||
    transport.socket?.readyState !== WebSocket.OPEN
  )
    return Promise.resolve(false);
  const id = crypto.randomUUID();
  const result = edits.start(id, () => false, { timeout: 5000 });
  if (!send({ type: 'replace', text, id, prompt: state.prompt, revision: state.inputRevision }))
    edits.cancel(id);
  state.inputRevision++;
  term.scrollToBottom();
  return result;
}
const inline = new InlineSuggestions(term, {
  state: () => state,
  replace: replaceLine,
  repair: (text, intent, signal) => {
    if (
      capturedConnection ||
      !state.ready ||
      state.exited ||
      transport.socket?.readyState !== WebSocket.OPEN
    )
      return Promise.reject(new Error('Terminal input changed.'));
    const id = crypto.randomUUID(),
      prompt = state.prompt,
      revision = state.inputRevision;
    const result = repairs.start(
      id,
      () => ({
        id,
        accepted: false,
        candidates: [],
        original: text,
        selected: text,
        prompt,
        revision,
      }),
      { signal, timeout: 15000, cancel: () => send({ type: 'repair-cancel', id }) },
    );
    if (!signal.aborted && !send({ type: 'repair', id, text, intent, prompt, revision }))
      repairs.cancel(id);
    return result;
  },
  ...(herdrTerminal
    ? {
        dictate: (text: string, applied: boolean, replace: boolean) => {
          if (
            !send({
              type: 'dictation-paste',
              text,
              applied,
              replace,
              prompt: state.prompt,
              revision: state.inputRevision,
            })
          )
            inline.disconnect();
        },
      }
    : {}),
  readLine: () => {
    const id = crypto.randomUUID(),
      prompt = state.prompt,
      revision = state.inputRevision;
    const result = inputLines.start(id, () => undefined, { timeout: 3000 });
    if (!send({ type: 'input-line', id, prompt, revision })) inputLines.cancel(id);
    return result;
  },
  raw: rawInput,
  execute,
});
const dictation = new DictationControl({
  api,
  send,
  state: () => state,
  context: inputContext,
  key: baseURL.href,
  audio: (data) => {
    if (
      !transport.socket ||
      transport.socket.readyState !== WebSocket.OPEN ||
      transport.socket.bufferedAmount > 256 * 1024
    )
      return false;
    transport.socket.send(encodeAudio(data));
    return true;
  },
  prepare: () => inline.prepareExternalPaste(),
  waiting: (active) => {
    dictationWaiting = active;
    inline.dictationPending(active);
    updateRun();
  },
  notice: plainToast,
  focus: () => term.focus(),
});
function showReading(
  request: { path: string } | { capture: string; name: string; exitCode: number },
) {
  if (embedded) {
    notify('reading-open', request);
    return;
  }
  const workspace = new URL('.', document.baseURI);
  sessionStorage.setItem(
    'libertty.pendingReading:' + workspace.pathname,
    JSON.stringify({
      ...request,
      session,
      backendUrl: baseURL.href,
      ...(herdrTerminal
        ? {
            herdrTerminal,
            herdrCore,
            herdrSession: params.get('herdrSession') || '',
            herdrSource: params.get('herdrSource') || '',
          }
        : {}),
    }),
  );
  location.assign(workspace.href);
}
term.onData(rawInput);
function canUploadImage() {
  return (
    !presentation.pending &&
    !uploadingImage &&
    !capturedConnection &&
    !state.exited &&
    (!herdrTerminal || herdrReady) &&
    transport.socket?.readyState === WebSocket.OPEN
  );
}
function canSendReturn() {
  return (
    !dictationWaiting &&
    !pendingCommand &&
    !presentation.pending &&
    !capturedConnection &&
    !state.exited &&
    (!herdrTerminal || herdrReady) &&
    transport.socket?.readyState === WebSocket.OPEN
  );
}
function sendReturn() {
  if (canSendReturn()) rawInput('\r');
}
$('terminal-enter').addEventListener('pointerdown', (event) => event.preventDefault());
$('terminal-enter').onclick = sendReturn;
const images = imagePicker((files) => void attachImages(files));
document.body.append(images);
async function attachImages(files: File[]) {
  if (!canUploadImage()) {
    toast('Connect to the terminal before attaching an image.', 'warning');
    return;
  }
  const socket = transport.socket!,
    abort = new AbortController();
  socket.addEventListener('close', () => abort.abort(), { once: true, signal: abort.signal });
  uploadingImage = true;
  updateRun();
  try {
    for (const file of files) {
      toast('Uploading ' + file.name + '…', 'info');
      const path = await uploadImage(
        herdrTerminal ? herdrEndpoint('api/herdr/images/upload') : endpoint('api/images/upload'),
        accessToken,
        file,
        abort.signal,
      );
      if (transport.socket !== socket || socket.readyState !== WebSocket.OPEN)
        throw new Error(
          'The terminal retained.disconnected. Attach the image again after reconnecting.',
        );
      inline.prepareExternalPaste();
      if (herdrTerminal) {
        send({ type: 'paste', text: path });
        state.inputRevision++;
      } else term.paste(path);
    }
    toast(`${files.length} image${files.length === 1 ? '' : 's'} attached.`, 'done');
    term.focus();
  } catch (error: any) {
    toast(
      abort.signal.aborted
        ? 'The terminal retained.disconnected. Attach the image again after reconnecting.'
        : error.message,
    );
  } finally {
    abort.abort();
    uploadingImage = false;
    updateRun();
  }
}
$('customize-shortcuts').onclick = () => {
  $<HTMLDialogElement>('options-dialog').close();
  shortcutBar.edit();
  $<HTMLDialogElement>('shortcuts-dialog').showModal();
};
shortcutBar.render();
function applySettings() {
  fullWidthLayout = saved<string>('herdrLayout', '') === 'full-width';
  try {
    applyTerminalTheme();
    const font = JSON.parse(localStorage.getItem('libertty.fontSizePt') || '10');
    if (typeof font === 'number') {
      fontSizeInput.value = String(font);
      fontSizeInput.dispatchEvent(new Event('input'));
    }
    for (const [id, value] of [
      [
        'auto-alternatives',
        localStorage.getItem('libertty.autoAlternatives') !== 'false' &&
          localStorage.getItem('libertty.justRun') !== 'true',
      ],
      ['tap-alternate-send', localStorage.getItem('libertty.tapAlternateSend') !== 'false'],
    ] as const) {
      const setting = $<HTMLInputElement>(id);
      if (setting.checked !== value) {
        setting.checked = value;
        setting.dispatchEvent(new Event('change'));
      }
    }
    shortcutBar.replace(
      validateShortcuts(
        JSON.parse(localStorage.getItem('libertty.shortcuts') || JSON.stringify(defaults)),
      ),
    );
    inline.setReadingPhrases(saved<unknown>('readingPhrases', null));
    sizeTerminal();
  } catch {
    /* Keep valid settings if stored data is unavailable or malformed. */
  }
}
window.addEventListener('storage', (event) => {
  if (
    event.key === null ||
    [
      'libertty.herdrLayout',
      'libertty.fontSizePt',
      'libertty.autoAlternatives',
      'libertty.tapAlternateSend',
      'libertty.shortcuts',
      'libertty.readingPhrases',
      'libertty.justRun',
      'libertty.theme',
    ].includes(event.key)
  )
    applySettings();
});
function copyTerminalText(text: string) {
  // Clipboard access needs a focused document. Focus the frame itself without
  // enabling its textarea or opening the software keyboard after a gesture.
  window.focus();
  return navigator.clipboard.writeText(text);
}
const gestures = new TerminalGestures(term, {
  focus,
  notice: plainToast,
  link: (col, row) => terminalLinkAt(term, col, row, projection?.clickable),
  pan: {
    enabled: () => fullWidth() && terminalViewport.scrollWidth > terminalViewport.clientWidth,
    move: (pixels) => {
      terminalViewport.scrollLeft += pixels;
    },
  },
  scroll: {
    enabled: () =>
      visibility.visible &&
      !document.hidden &&
      !capturedConnection &&
      !retained.cachePainted &&
      ((term.buffer.active.length <= term.rows &&
        ((mobileTerminal() && !visibility.parked && state.terminalScroll === true) ||
          ((!herdrTerminal || herdrCore) && !!term.wasmTerm?.isAlternateScreen()))) ||
        (retained.disconnected() && term.getViewportY() >= term.buffer.active.length - term.rows)),
    move: (lines, x, y) => {
      if (lines > 0 && term.buffer.active.length > term.rows) {
        term.scrollLines(lines);
        return;
      }
      // A slow but working link waits for the application instead of switching to retained output.
      if (retained.disconnected()) {
        if (lines < 0) retained.showRetained(lines);
        return;
      }
      if (
        !lifecycle.synchronized ||
        !transport.healthy ||
        presentation.pending ||
        herdrLayout.pending
      )
        return;
      retained.captureTranscript();
      const bounds = term.screen!.getBoundingClientRect();
      const column = Math.max(
        0,
        Math.min(term.cols - 1, Math.floor(((x - bounds.left) * term.cols) / bounds.width)),
      );
      const row = Math.max(
        0,
        Math.min(term.rows - 1, Math.floor(((y - bounds.top) * term.rows) / bounds.height)),
      );
      if (herdrTerminal && !herdrCore)
        send({ type: 'terminal-scroll', lines: Math.max(-100, Math.min(100, lines)), column, row });
      else {
        const terminal = term.wasmTerm!,
          button = lines < 0 ? 64 : 65;
        const tracking = [1000, 1002, 1003].some((mode) => terminal.getMode(mode));
        const data = !tracking
          ? lines < 0
            ? '\x1b[A'
            : '\x1b[B'
          : terminal.getMode(1006)
            ? `\x1b[<${button};${column + 1};${row + 1}M`
            : terminal.getMode(1015)
              ? `\x1b[${button + 32};${column + 1};${row + 1}M`
              : '\x1b[M' +
                String.fromCharCode(
                  button + 32,
                  Math.min(255, column + 33),
                  Math.min(255, row + 33),
                );
        rawInput(data.repeat(Math.min(100, Math.abs(lines))), 'mouse');
      }
    },
  },
  tap: (x, y) => {
    transport.activity();
    if (presentation.pending || queue.length || capturedConnection || retained.cachePainted) return;
    if (!herdrTerminal || state.ready) {
      inline.moveCursor(x, y);
      return;
    }
    if (
      !herdrReady ||
      (!herdrCore && !mobileTerminal()) ||
      herdrLayout.pending ||
      visibility.parked ||
      !visibility.visible ||
      document.hidden
    )
      return;
    const bounds = term.screen!.getBoundingClientRect();
    const column = Math.floor(((x - bounds.left) * term.cols) / bounds.width),
      row = Math.floor(((y - bounds.top) * term.rows) / bounds.height);
    if (herdrCore) {
      term.click(column, row);
      return;
    }
    const cell = projection?.nativeCell(column, row);
    if (cell && send({ type: 'terminal-click', ...cell, cols: term.cols, rows: term.rows }))
      state.inputRevision++;
  },
  copy: copyTerminalText,
  render: () => rendering.flush(),
});

async function socketURL(signal: AbortSignal) {
  if (lastOutputAt || retained.cachePainted) presentation.wait();
  else presentation.freeze();
  const socketURL = sessionAdapter.socketEndpoint();
  replay.opened();
  if (herdrTerminal) {
    sizeTerminal();
    const geometry = {
      cols: term.cols,
      rows: term.rows,
      mobile: mobileTerminal() && visibility.visible && keepingGeometry(),
    };
    herdrLayout.rendered = false;
    retained.layout({
      pending: geometry.mobile,
      preserve: !!lastOutputAt,
      cover: geometry.mobile && !visibility.parked && !lastOutputAt,
    });
    const result = await requestJSON<{ ticket: string }>(
      herdrEndpoint('api/herdr/ticket'),
      geometry,
      { token: () => accessToken, signal },
    );
    socketURL.searchParams.set('ticket', result.ticket);
  } else if (baseURL.origin !== location.origin)
    socketURL.searchParams.set(
      'ticket',
      (await api<{ ticket: string }>('/api/ticket', {}, signal)).ticket,
    );
  socketURL.protocol = baseURL.protocol === 'https:' ? 'wss:' : 'ws:';
  socketURL.searchParams.set('after', String(replay.cursor));
  socketURL.searchParams.set('client', inputClient);
  if (replay.stream) socketURL.searchParams.set('stream', replay.stream);
  return socketURL;
}
async function prepareConnection(signal: AbortSignal, token?: string) {
  directAttempt =
    !token && (herdrTerminal ? !!accessToken : authorized && baseURL.origin === location.origin);
  if (directAttempt) return socketURL(signal);
  const result = await api<{ state?: ShellState; accessToken: string }>(
    '/api/connect',
    { ...(herdrTerminal ? { noSession: true } : { session }), ...(token ? { token } : {}) },
    signal,
  );
  signal.throwIfAborted();
  authorized = true;
  if (result.state) state = result.state;
  accessToken = result.accessToken;
  notify('terminal-authorized', { accessToken });
  rememberBackendAccess(baseURL.href, accessToken);
  $<HTMLInputElement>('token').value = '';
  $<HTMLDialogElement>('login-dialog').close();
  $('login-error').textContent = '';
  return socketURL(signal);
}
function socketOpened() {
  discardHerdrFrames();
  lifecycle.opened();
  numberedInput = false;
  history.reset();
  deferredScreen = undefined;
  if (herdrTerminal) {
    herdrReady = false;
    state.inputRevision = 0;
    state.inputTarget = undefined;
    connection('Connecting');
  } else {
    connection('Connected', true);
    notify('terminal-ready');
  }
  sizeTerminal();
  if (visibility.parked) send({ type: 'herdr-active', active: false });
}
function revealHerdrLayout() {
  if (!herdrLayout.ready) return;
  const socket = transport.socket;
  const presentation = herdrPresentation;
  const cols = term.cols,
    rows = term.rows;
  projection?.paintBaseline();
  herdrLayout.reveal(
    () =>
      transport.socket === socket &&
      presentation === herdrPresentation &&
      term.cols === cols &&
      term.rows === rows &&
      !visibility.parked,
    () => {
      send({ type: 'herdr-frame-request' });
      notifyHerdrRendered(presentation);
    },
  );
}
function notifyHerdrRendered(presentationId = herdrPresentation) {
  if (!herdrLayout.pending && !visibility.parked && presentationId === herdrPresentation) {
    applyDeferredScreen();
    if (retained.deferReveal(() => notifyHerdrRendered(presentationId))) return;
    presentation.reveal(() =>
      notify('terminal-rendered', {
        presentation: presentationId,
        cols: term.cols,
        rows: term.rows,
      }),
    );
    synchronizeInput();
    if (resizeCover.held && resizeTarget === term.cols + 'x' + term.rows) {
      clearTimeout(resizeCoverTimer);
      resizeCover.reveal();
    }
  }
}
function notifyHerdrSizing() {
  if (herdrTerminal)
    notify('terminal-sizing', {
      presentation: herdrPresentation,
      cols: term.cols,
      rows: term.rows,
    });
}
function scheduleHerdrRendered() {
  const presentation = herdrPresentation,
    socket = transport.socket;
  requestAnimationFrame(() => {
    if (transport.socket === socket) notifyHerdrRendered(presentation);
  });
}
function applyDeferredScreen() {
  if (
    deferredScreen === undefined ||
    herdrLayout.pending ||
    visibility.parked ||
    !visibility.visible ||
    document.hidden
  )
    return;
  const position = Math.floor(term.getViewportY()),
    covered = retained.coverRetained();
  projection?.update(deferredScreen);
  deferredScreen = undefined;
  retained.livePainted(position, covered);
  retained.scheduleTranscript();
}
function discardHerdrFrames() {
  frameScheduler.cancel();
  for (const pending of pendingFrames)
    if (pending.socket === transport.socket) send({ type: 'ack', seq: pending.frame.seq });
  pendingFrames.clear();
}
function drainHerdrFrames() {
  if (herdrLayout.pending || presentation.pending) {
    discardHerdrFrames();
    return;
  }
  const frames = [...pendingFrames]
    .filter((pending) => pending.socket === transport.socket)
    .map((pending) => pending.frame);
  pendingFrames.clear();
  try {
    for (const frame of mergeHerdrFrames(frames)) paintHerdrFrame(frame);
  } catch (error) {
    connectionError(error);
    transport.socket?.close(4002, 'Invalid terminal frame');
  }
}
function paintHerdrFrame(message: HerdrFrameMessage) {
  try {
    if (document.hidden || !visibility.visible || visibility.parked || herdrLayout.holding) return;
    if (
      herdrLayout.pending &&
      !herdrLayout.accept(message.width === term.cols && message.height === term.rows, message.full)
    )
      return;
    const position = Math.floor(term.getViewportY()),
      covered = retained.coverRetained();
    if (projection?.frame(message) && !herdrLayout.pending) scheduleHerdrRendered();
    retained.livePainted(position, covered);
    lastOutputAt = Date.now();
    retained.scheduleTranscript();
    revealHerdrLayout();
    if (fullWidth()) sizeTerminal();
    refreshHerdrFrame();
  } finally {
    echo.output();
    send({ type: 'ack', seq: message.seq });
  }
}
type Handlers = {
  [K in ServerMessage['type']]: (message: Extract<ServerMessage, { type: K }>) => void;
};
function screenMessage(message: Extract<ServerMessage, { type: 'screen' | 'screen-delta' }>) {
  const text = history.receive(message);
  if (text === undefined) return;
  deferredScreen = text;
  lastOutputAt = Date.now();
  if (document.hidden || !visibility.visible || herdrLayout.pending || visibility.parked) return;
  applyDeferredScreen();
  echo.output();
  if (fullWidth()) sizeTerminal();
  refreshHerdrFrame();
  scheduleHerdrRendered();
}
function capturedMessage(
  message: Extract<ServerMessage, { type: 'ssh-command' | 'herdr-command' }>,
) {
  capturedConnection = message.id;
  inline.disconnect();
  if (embedded) notify(message.type, { id: message.id, command: message.command });
  else if (message.type === 'herdr-command') {
    const workspace = new URL('.', document.baseURI);
    try {
      sessionStorage.setItem(
        'libertty.pendingHerdr:' + workspace.pathname,
        JSON.stringify({ id: message.id, session, backendUrl: baseURL.href }),
      );
      location.assign(workspace.href);
    } catch {
      void api('/api/herdr/captured', { id: message.id, action: 'native' })
        .then(() => api('/api/herdr/captured', { id: message.id, action: 'ack' }))
        .catch((error) => toast(error.message));
    }
  } else
    void api('/api/ssh/captured', { id: message.id, action: 'native' })
      .then(() => api('/api/ssh/captured', { id: message.id, action: 'ack' }))
      .catch((error) => toast(error.message));
}
const handlers: Handlers = {
  'herdr-layout': (message) => {
    discardHerdrFrames();
    if (visibility.parked) return;
    if (message.cols !== term.cols || message.rows !== term.rows || !mobileTerminal()) return;
    retained.layout({ pending: true, barrierReady: message.ready });
  },
  'herdr-frame': (message) => {
    if (document.hidden || !visibility.visible || visibility.parked || herdrLayout.holding) {
      send({ type: 'ack', seq: message.seq });
      return;
    }
    if (herdrLayout.pending || presentation.pending || !herdrReady) {
      discardHerdrFrames();
      paintHerdrFrame(message);
      return;
    }
    pendingFrames.push({ socket: transport.socket, frame: message });
    if (pendingFrames.length > 2) {
      frameScheduler.cancel();
      drainHerdrFrames();
    } else frameScheduler.request();
  },
  screen: screenMessage,
  'screen-delta': screenMessage,
  'input-line': (message) => {
    const intact =
      message.prompt === state.prompt && message.revision === state.inputRevision && state.ready;
    inputLines.complete(
      message.id,
      intact && typeof message.text === 'string' && typeof message.cursor === 'number'
        ? { text: message.text, cursor: message.cursor }
        : undefined,
    );
  },
  'repair-result': (message) => {
    const intact = message.prompt === state.prompt && state.ready && !state.exited;
    if (
      intact &&
      message.accepted &&
      [state.inputRevision, state.inputRevision + 1].includes(message.revision)
    )
      state.inputRevision = message.revision;
    else if (message.accepted) message.accepted = false;
    if (message.source === 'dictation') {
      if (intact && message.revision === state.inputRevision) inline.backendResult(message);
    } else repairs.complete(message.id, message);
    if (message.accepted) term.scrollToBottom();
  },
  pasted: (message) => {
    if (message.prompt === state.prompt && message.revision === state.inputRevision + 1) {
      state.inputRevision = message.revision;
      term.scrollToBottom();
      if (message.repairing) inline.backendLoading(message.text, !!herdrTerminal);
      else
        inline.externalPaste(
          message.text,
          message.replace,
          message.source === 'dictation',
          !!herdrTerminal,
        );
    } else inline.disconnect();
  },
  transfer: (message) => {
    if (transfersSeen.has(message.request.id)) return;
    transfersSeen.add(message.request.id);
    if (transfersSeen.size > 256) transfersSeen.delete(transfersSeen.values().next().value!);
    transferView(
      message.request,
      fileClient(
        baseURL.href,
        session,
        () => accessToken,
        async () => {
          throw new Error('Reconnect to this backend and try again.');
        },
      ),
      () => api('/api/files/transfer', { id: message.request.id, action: 'ack' }),
      () =>
        saveDownload(
          baseURL.href,
          () => api('/api/files/transfer', { id: message.request.id, action: 'download' }),
          message.request.name,
        ),
    );
  },
  dictation: (message) =>
    dictation.event(message.id, message.state, message.message, message.resume),
  'reading-file': (message) => showReading({ path: message.path }),
  'reading-capture': (message) =>
    showReading({ capture: message.id, name: message.name, exitCode: message.exitCode }),
  'reading-error': (message) => {
    inline.dictationPending(false);
    toast(message.message);
  },
  'ssh-command': capturedMessage,
  'herdr-command': capturedMessage,
  'ssh-released': (message) => {
    if (capturedConnection === message.id) capturedConnection = undefined;
  },
  'input-ack': (message) => {
    if (typeof message.seq === 'number' && message.seq > confirmedInput) {
      confirmedInput = message.seq;
      transport.confirmed();
    }
    if (numberedInput) {
      if (typeof message.seq === 'number') sentInput.confirm(message.seq);
      return;
    }
    // Keys the previous connection never delivered rejoin the unsent queue under the context they were typed in.
    numberedInput = true;
    const pending = sentInput.settle(message.seq);
    if (
      pending &&
      (!pending.complete ||
        !unsentInput.prepend(pending.data, pending.context || disconnectedContext))
    )
      toast('Keys typed before the connection dropped were not delivered.');
  },
  hello: (message) => {
    replay.target = message.lastSeq;
    const changedStream = retained.changeStream(message.streamId);
    lifecycle.hello();
    // Reset through the terminal parser. Ghostty's reset() frees native memory
    // still referenced by its input and selection handlers.
    if (message.reset) {
      retained.beginReplay(changedStream);
      inline.disconnect();
      if (retained.cachePainted) {
        presentation.wait();
        if (!frameQueued) scheduleDrain();
      } else {
        presentation.freeze();
        term.clearSelection();
        term.scrollToBottom();
        term.write('\x1bc\x1b[3J');
      }
    }
    if (message.truncated) {
      const notice =
        '\r\n\x1b[33mOlder output is unavailable. Ctrl-L redraws the current program.\x1b[0m\r\n';
      retained.appendNotice(notice);
      toast('Reconnected with limited scrollback. Use Ctrl-L to redraw if needed.', 'info', [
        { id: 'redraw', label: 'Redraw' },
      ]);
    }
  },
  output: (message) => {
    // Output over retained rows is replayed after the next reset instead.
    if (retained.cachePainted && retained.handoff === undefined) return;
    replay.receive(message);
    if (!frameQueued) scheduleDrain();
  },
  state: (message) => {
    const initial = lifecycle.receivedState();
    transport.ready();
    if (herdrTerminal) {
      herdrReady = true;
      sizeTerminal();
      connection('Connected', true);
      notify('terminal-ready');
    }
    // A state acknowledgement can arrive after newer local keystrokes were
    // sent. Keep their optimistic revision until the backend catches up.
    if (!initial)
      message.state.inputRevision = Math.max(state.inputRevision, message.state.inputRevision);
    state = message.state;
    notify('terminal-state', { state });
    $('cwd').textContent = state.cwd;
    $('cwd').title = state.cwd;
    dictation.prompt();
    updateRun();
    inline.onState(state);
    echo.state(state);
    revealReplay();
    synchronizeInput();
  },
  'edit-result': (message) => {
    edits.complete(message.id, message.accepted);

    if (!message.accepted) state.inputRevision = message.revision;
  },
  result: (message) => {
    if (pendingCommand?.id !== message.id) return;
    pendingCommand = undefined;
    if (!message.accepted) toast(message.message || 'Command was not sent.');
    updateRun();
  },
  pong: () => {},
};
function socketMessage(event: MessageEvent) {
  const message: ServerMessage =
    typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  (handlers[message.type] as ((message: ServerMessage) => void) | undefined)?.(message);
}
function socketClosed(event?: CloseEvent) {
  retained.disconnect();
  releaseResizeCover();
  discardHerdrFrames();
  if (directAttempt && !lifecycle.hasState) authorized = false;
  visibility.closed();
  disconnectedContext = inputContext() || disconnectedContext;
  dictation.connected(false);
  lifecycle.closed();
  echo.reset();
  presentation.wait();
  herdrReady = false;
  if (event?.code === 4001 || state.exited) inline.disconnect();
  else inline.suspend();
  edits.clear();
  inputLines.clear();
  repairs.clear();
  // Never resend uncertain input or an uncertain command automatically.
  if (pendingCommand) {
    pendingCommand = undefined;
    toast('Connection lost before acknowledgement. Check the terminal before running again.');
  }
  if ((event?.code === 1011 || event?.code === 1013) && event.reason)
    connectionReason = event.reason;
  if (event?.code === 4001) {
    unsentInput.clear();
    sentInput.clear();
    disconnectedContext = undefined;
    dictation.cancel();
    connection('Other tab');
    toast(event.reason, 'warning');
    return false;
  }
  if (herdrTerminal && event?.code === 1000 && event.reason === 'Herdr terminal ended') {
    inline.disconnect();
    connection('Session ended');
    notify('terminal-ended');
    return false;
  }
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
    if (embedded) {
      notify('terminal-locked', { accessToken: attemptedAccessToken });
      return false;
    }
    const dialog = $<HTMLDialogElement>('login-dialog');
    if (!dialog.open) dialog.showModal();
    if (token) $('login-error').textContent = 'That token did not match.';
    return false;
  } else if (error.status === 404) {
    inline.disconnect();
    connection(embedded ? 'Connecting' : 'Session ended');
    notify('terminal-ended');
    return false;
  }
  connection('Offline');
  return true;
}
const connect = (token?: string) => transport.connect(token);
document.addEventListener('terminal-can-evict', (event) => {
  (event as CustomEvent<{ allowed: boolean }>).detail.allowed =
    !unsentInput.length &&
    !sentInput.pending &&
    !uploadingImage &&
    !dictation.active &&
    !pendingCommand &&
    !capturedConnection &&
    !repairs.size &&
    !edits.size &&
    !inputLines.size &&
    !document.querySelector('dialog[open]');
});
function terminalActivity() {
  transport.activity();
  rendering.activity();
  frameScheduler.activity();
}
document.addEventListener('pointerdown', terminalActivity, { passive: true });
document.addEventListener('wheel', terminalActivity, { passive: true });
$('login-form').onsubmit = (e) => {
  e.preventDefault();
  void connect($<HTMLInputElement>('token').value);
};
transport.follow({
  grace: backgroundGrace,
  hidden: () => {
    echo.cancel();
    cancelAnimationFrame(outputFrame);
    frameQueued = false;
    discardHerdrFrames();
    releaseResizeCover();
    if (herdrTerminal && !visibility.parked) {
      retained.layout({
        pending: mobileTerminal(),
        preserve: true,
        barrierReady: herdrLayout.barrierReady,
      });
      send({ type: 'herdr-active', active: false });
    }
  },
  shown: () => {
    rendering.activity();
    frameScheduler.activity();
    if (herdrTerminal && visibility.visible && !visibility.parked)
      send({ type: 'herdr-active', active: true });
    sizeTerminal();
    if ((queue.length || retained.handoff !== undefined) && !frameQueued) scheduleDrain();
    revealReplay();
  },
  expired: () => {
    if (herdrTerminal) send({ type: 'resize', cols: term.cols, rows: term.rows, mobile: false });
    if (dictation.active) return false;
    inline.suspend();
  },
});

function execute(command: string) {
  if (
    presentation.pending ||
    capturedConnection ||
    (!state.ready && !herdrReady) ||
    state.exited ||
    pendingCommand ||
    transport.socket?.readyState !== WebSocket.OPEN
  ) {
    toast('Wait for terminal input before running a command.', 'warning');
    return;
  }
  if (!command.trim() || /[\x00-\x1f\x7f]/.test(command)) {
    toast('Use one command line at a time.', 'warning');
    return;
  }
  if (
    herdrTerminal &&
    state.ready &&
    (readingRequest(command, ['look at']) || readingPipeline(command, ['look at']))
  ) {
    const context = state.inputContext;
    inline.disconnect();
    // Clear the submitted line before the reader runs so later typing is preserved.
    send({ type: 'input', data: '\x07\x05\x15' });
    state.inputRevision++;
    const controller = new AbortController(),
      socket = transport.socket;
    socket.addEventListener('close', () => controller.abort(), {
      once: true,
      signal: controller.signal,
    });
    pendingCommand = { id: crypto.randomUUID() };
    updateRun();
    void requestJSON<ReadingOpen>(
      herdrEndpoint('api/herdr/reading'),
      { terminalId: herdrTerminal, command, context, cwd: state.cwd },
      { token: () => accessToken, signal: controller.signal, timeout: 35000 },
    )
      .then((request) => {
        if (transport.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        showReading(request);
      })
      .catch((error) => {
        if (!controller.signal.aborted) toast(error.message);
      })
      .finally(() => {
        controller.abort();
        pendingCommand = undefined;
        updateRun();
      });
    return;
  }
  inline.disconnect();
  const id = crypto.randomUUID();
  pendingCommand = { id };
  if (!send({ type: 'command', command, prompt: state.prompt, id })) {
    pendingCommand = undefined;
    toast('Disconnected. The command was not sent.');
  } else {
    if (herdrReady) state.inputRevision++;
    term.scrollToBottom();
  }
  updateRun();
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close]'))
  button.onclick = () => $<HTMLDialogElement>(button.dataset.close!).close();
$('menu-button').onclick = () => $<HTMLDialogElement>('options-dialog').showModal();
async function copySelection(text = gestures.text) {
  if (!text) {
    toast('Select terminal text first.', 'warning');
    return;
  }
  try {
    await copyTerminalText(text);
    toast('Selection copied.', 'done');
  } catch {
    toast('Clipboard is unavailable in this browser context.');
  }
}
$('copy-selection').onclick = () => void copySelection();
$('new-shell').onclick = async () => {
  if (herdrTerminal) return;
  if (
    !state.exited &&
    !confirm(
      'End the current session and start a new shell? Running programs in this session will stop.',
    )
  )
    return;
  try {
    inline.disconnect();
    transport.suspend();
    await api('/api/new', {});
    retained.clear();
    replay.reset();
    replay.stream = '';
    unsentInput.clear();
    sentInput.clear();
    disconnectedContext = undefined;
    pendingCommand = undefined;
    $<HTMLDialogElement>('options-dialog').close();
    await connect();
  } catch (error: any) {
    toast(error.message);
    void connect();
  }
};
if (!embedded && import.meta.env.PROD && 'serviceWorker' in navigator)
  navigator.serviceWorker
    .register(new URL('sw.js', document.baseURI), {
      scope: new URL('.', document.baseURI).pathname,
    })
    .catch(() => {});
if (embedded) {
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== location.origin) return;
    const data = workspaceMessage(event.data);
    if (!data) return;
    if (data.type === 'shortcut-host') {
      document.documentElement.classList.add('hosted-shortcuts');
      shortcutState = '';
      publishShortcuts();
      sizeTerminal();
    }
    if (data.type === 'terminal-shortcut' && visibility.visible && !visibility.parked) {
      shortcutBar.press(data.index, data.kind, data.value);
    }
    if (data.type === 'terminal-return' && visibility.visible && !visibility.parked) sendReturn();
    if (data.type === 'terminal-images' && visibility.visible && !visibility.parked)
      void attachImages(data.files);
    if (data.type === 'herdr-present' && herdrTerminal) {
      discardHerdrFrames();
      rendering.activity();
      frameScheduler.activity();
      releaseResizeCover();
      retained.hold();
      herdrPresentation = data.presentation;
      presentedAt = performance.now();
      herdrLayout.cancel();
      notifyHerdrSizing();
      retained.notifyCachedRendered();
      return;
    }
    if (data.type === 'herdr-resize-cover' && herdrTerminal) {
      // The workspace resizes this pane after the reply, so the stale canvas never paints before the cover.
      if (canCoverResize() && !resizeCover.held) {
        resizeTarget = '';
        resizeCover.hold(fittedHeight);
        clearTimeout(resizeCoverTimer);
        resizeCoverTimer = setTimeout(() => {
          if (!resizeTarget) releaseResizeCover();
        }, 500);
      }
      notify('herdr-resize-ready');
      return;
    }
    if (data.type === 'authorize') {
      visibility.authorize();
      accessToken = data.accessToken;
      void transport.connect(undefined, true);
    }
    if (data.type === 'recovery-failed') connection('Session ended');
    if (data.type === 'notice-action') runTerminalAction(data.id);
    if (data.type === 'herdr-park' && herdrTerminal) {
      const parked = data.parked === true;
      if (!visibility.park(parked)) return;
      dictation.visibility(!parked && visibility.visible);
      if (parked) {
        retained.flushTranscript();
        releaseResizeCover();
        gestures.cancelGesture();
        discardHerdrFrames();
      }
      rendering.setVisible(!parked && visibility.visible);
      send({ type: 'herdr-active', active: !parked });
      if (!parked) {
        const cols = term.cols,
          rows = term.rows;
        sizeTerminal();
        const preserve = data.preserve === true && cols === term.cols && rows === term.rows;
        herdrLayout.rendered = preserve && mobileTerminal();
        retained.layout({ pending: mobileTerminal(), preserve });
        send({ type: 'herdr-frame-request' });
        retained.notifyCachedRendered();
        if (herdrCore) revealReplay();
      }
      return;
    }
    if (data.type === 'tab-visibility') {
      visibility.setVisible(data.visible);
      if (!visibility.visible) {
        retained.cancelBackfill();
        retained.flushTranscript();
        releaseResizeCover();
        gestures.cancelGesture();
        retained.hold();
        discardHerdrFrames();
      } else {
        rendering.activity();
        frameScheduler.activity();
      }
      rendering.setVisible(visibility.visible && !visibility.parked);
      if (!visibility.visible && herdrTerminal && !herdrCore)
        retained.layout({ pending: true, preserve: false, barrierReady: herdrLayout.barrierReady });
      dictation.visibility(visibility.visible);
      cancelAnimationFrame(outputFrame);
      frameQueued = false;
      if (queue.length || retained.handoff !== undefined) scheduleDrain();
      if (visibility.visible) {
        sizeTerminal();
        shortcutState = '';
        publishShortcuts();
        revealReplay();
        retained.notifyCachedRendered();
      }
    }
    if (data.type === 'tab-visibility') visibility.updateTransport(data.active === true);
    if (data.type === 'settings-changed') applySettings();
    if (data.type === 'settings-action') $(data.action).click();
    if (data.type === 'focus-terminal') {
      sizeTerminal();
      term.focus();
    }
  });
  notify('terminal-loaded');
} else void connect();
if (herdrTerminal) $('new-shell').hidden = true;

window.addEventListener(
  'pagehide',
  () => {
    if (herdrTerminal) transport.suspend();
    visibility.dispose();
    projection?.dispose();
  },
  { once: true },
);
