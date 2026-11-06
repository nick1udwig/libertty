import type { Terminal } from './terminal-adapter.ts';
import type { TerminalConnection, TerminalVisibility } from './terminal-lifecycle.ts';
import type { TerminalReplay } from './terminal-replay.ts';
import type { ReconnectingSocket } from './reconnecting-socket.ts';
import type { TerminalProjection } from './terminal-projection.ts';
import type { TerminalPresentation } from './terminal-presentation.ts';
import type { TerminalGestures } from './terminal-gestures.ts';
import type { HerdrLayout } from './herdr-layout.ts';
import type { ShellState } from './protocol.ts';
import { TerminalCache } from './terminal-cache.ts';
import { TerminalTranscript } from './terminal-transcript.ts';
import {
  captureNativeSnapshot,
  restoreNativeSnapshot,
  type NativeTerminalSnapshot,
} from './terminal-native-snapshot.ts';
import { paintSnapshot, terminalSnapshot, type TerminalPicture } from './terminal-snapshot.ts';
interface Host {
  term: Terminal;
  lifecycle: TerminalConnection;
  replay: TerminalReplay;
  transport: ReconnectingSocket;
  visibility: TerminalVisibility;
  projection?: TerminalProjection;
  herdrLayout: HerdrLayout;
  presentation: TerminalPresentation;
  readonly gestures: TerminalGestures;
  readonly state: ShellState;
  readonly lastOutputAt: number;
  readonly presentedAt: number;
  readonly herdrPresentation: string;
  herdrTerminal: boolean;
  herdrCore: boolean;
  cacheKey: string;
  updateRun(): void;
  connection(label: string): void;
  ready(): void;
  rendered(value: { presentation: string; cols: number; rows: number }): void;
  history(signal: AbortSignal): Promise<{ streamId: string; seq: number; text: string }>;
}
export function createRetainedOutput(
  host: Host,
  cache: Pick<TerminalCache, 'read' | 'save' | 'clear'> = new TerminalCache(),
) {
  const transcript = new TerminalTranscript();
  let cachedNative: NativeTerminalSnapshot | undefined;
  let cachedUpdated = 0,
    cachedStream = '',
    clearedScreen: string | undefined;
  // Retained output painted through the terminal itself until live output replaces it at the same distance from the bottom.
  let cachePainted = false,
    handoffPosition = 0,
    picture: TerminalPicture = { last: 0, x: 0, y: 0, cursor: false };
  // The reset that a complete replay writes over retained output, so the swap paints once.
  let handoff: string | undefined;
  // A Herdr pane that replaced retained output under a cover reveals it once its history decides the final picture.
  let herdrHandoffUntil = 0,
    herdrHandoffTimer: ReturnType<typeof setTimeout> | undefined;
  let backfillNeeded = false,
    backfill: AbortController | undefined;
  let backfillTimer: ReturnType<typeof setTimeout> | undefined;
  let transcriptTimer: ReturnType<typeof setTimeout> | undefined,
    cacheTimer: ReturnType<typeof setTimeout> | undefined;
  function observeTerminal() {
    if (cachePainted) return false;
    const snapshot = terminalSnapshot(host.term);
    if (snapshot.text === clearedScreen) return false;
    picture = snapshot.picture;
    return transcript.observe(
      snapshot.text,
      !host.term.wasmTerm?.isAlternateScreen() && (!host.herdrTerminal || host.state.ready),
    );
  }
  function saveTranscript() {
    clearTimeout(cacheTimer);
    cacheTimer = undefined;
    if (!transcript.records.length || (!host.lifecycle.synchronized && !cachePainted)) return;
    if (host.lifecycle.synchronized) observeTerminal();
    const native = cachePainted
      ? cachedNative
      : transcript.records.length === 1 &&
          transcript.records[0].text === terminalSnapshot(host.term).text
        ? captureNativeSnapshot(host.term)
        : undefined;
    void cache.save({
      native,
      key: host.cacheKey,
      version: 2,
      updated: host.lastOutputAt || cachedUpdated || Date.now(),
      stream: host.replay.stream || cachedStream,
      records: transcript.records.map((record) => ({ ...record })),
      picture,
      position: Math.floor(host.term.getViewportY()),
    });
  }
  function captureTranscript() {
    clearTimeout(transcriptTimer);
    transcriptTimer = undefined;
    if (observeTerminal()) cacheTimer ??= setTimeout(saveTranscript, 2000);
  }
  // Herdr Core usually replays live output soon after a pane is chosen, so retained output shows only when that replay is slow.
  const coreRetainedDelay = 150;
  let cachedRenderedTimer: ReturnType<typeof setTimeout> | undefined;
  function notifyCachedRendered() {
    clearTimeout(cachedRenderedTimer);
    if (
      !host.herdrTerminal ||
      !cachePainted ||
      !host.herdrPresentation ||
      !host.visibility.visible ||
      host.visibility.parked
    )
      return;
    const delay = host.herdrCore ? host.presentedAt + coreRetainedDelay - performance.now() : 0;
    if (delay > 0) cachedRenderedTimer = setTimeout(notifyCachedRendered, delay);
    else
      host.rendered({
        presentation: host.herdrPresentation,
        cols: host.term.cols,
        rows: host.term.rows,
      });
  }
  /** Show retained output with the live renderer; the next live paint or replay replaces it. */
  function paintCache(position: number, native?: NativeTerminalSnapshot) {
    const text = transcript.text();
    if (!text) return;
    host.gestures.clear();
    cachedNative = restoreNativeSnapshot(host.term, native, position) ? native : undefined;
    if (!cachedNative) paintSnapshot(host.term, text, picture, position);
    cachePainted = true;
    host.projection?.invalidate();
    host.herdrLayout.uncover();
    if (host.presentation.pending) host.presentation.wait();
    host.updateRun();
    notifyCachedRendered();
  }
  /** A handshake in progress is neither live nor lost, so its replay is never covered by retained output. */
  function disconnected() {
    return (
      host.transport.socket?.readyState !== WebSocket.OPEN ||
      (host.lifecycle.synchronized && !host.transport.healthy)
    );
  }
  /** Only a dropped or stalled connection shows retained output for a scroll that the live terminal cannot serve locally. */
  function showRetained(lines: number) {
    if (host.gestures.text) return;
    captureTranscript();
    paintCache(Math.floor(host.term.getViewportY()));
    if (!cachePainted) return;
    // The next connection replays the whole stream over retained output.
    if (!host.herdrTerminal) {
      host.replay.reset();
    }
    host.term.scrollLines(lines);
  }
  /** Cover retained output with its exact picture while a Herdr paint replaces it, since a native grid can precede the history projection. */
  function coverRetained() {
    if (!cachePainted || !host.presentation.pending) return false;
    host.presentation.freeze(false);
    return true;
  }
  function livePainted(position: number, covered: boolean) {
    if (!cachePainted) return;
    if (host.projection?.stale) {
      if (covered) host.presentation.wait();
      return;
    }
    cachePainted = false;
    cachedNative = undefined;
    if (covered) herdrHandoffUntil = Date.now() + 1500;
    if (position) host.term.scrollToLine(position);
  }
  /** Hold the painted picture while the terminal changes, unless it already shows retained output. */
  function hold() {
    if (cachePainted) host.presentation.wait();
    else host.presentation.freeze();
  }
  /** Retained output stays on screen, as a preserved picture, until a frame after Herdr's redraw barrier replaces it. */
  function layout(options: Parameters<HerdrLayout['set']>[0]) {
    host.herdrLayout.set(cachePainted ? { ...options, preserve: true, cover: false } : options);
  }
  function scheduleTranscript() {
    transcriptTimer ??= setTimeout(captureTranscript, host.transport.backgroundDelay);
  }
  host.term.onScroll(() => {
    if (cachePainted) cacheTimer ??= setTimeout(saveTranscript, 1000);
  });
  async function restore() {
    const saved = await cache.read(host.cacheKey);
    if (!saved || (host.replay.stream && saved.stream !== host.replay.stream)) return;
    const current = transcript.records.map((record) => ({ ...record }));
    transcript.restore(saved.records);
    if (host.lastOutputAt || host.lifecycle.streamStarted) {
      for (const record of current) {
        if (record.kind === 'gap') transcript.gap(record.text, record.at);
        else transcript.observe(record.text, record.kind === 'history', record.at);
      }
      saveTranscript();
      return;
    }
    cachedUpdated = saved.updated;
    cachedStream = saved.stream;
    picture = saved.picture;
    paintCache(saved.position, saved.native);
    // A working connection replaces retained output without announcing a reconnect.
    if (!navigator.onLine) host.connection('Offline');
    host.ready();
  }
  function flushTranscript() {
    captureTranscript();
    saveTranscript();
  }
  window.addEventListener('pagehide', flushTranscript);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushTranscript();
  });
  function cancelBackfill() {
    clearTimeout(backfillTimer);
    backfillTimer = undefined;
    backfill?.abort();
    backfill = undefined;
  }
  function scheduleBackfill() {
    if (
      host.herdrTerminal ||
      !backfillNeeded ||
      backfill ||
      backfillTimer ||
      !host.lifecycle.synchronized ||
      !host.visibility.visible ||
      document.hidden
    )
      return;
    backfillTimer = setTimeout(() => {
      backfillTimer = undefined;
      if (!host.lifecycle.synchronized || !host.visibility.visible || document.hidden) return;
      if (host.transport.backgroundDelay > 1500 && Date.now() - host.lastOutputAt < 1000) {
        scheduleBackfill();
        return;
      }
      const controller = (backfill = new AbortController()),
        expected = host.replay.stream;
      const timeout = setTimeout(() => controller.abort(), 15000);
      void host
        .history(controller.signal)
        .then((result) => {
          if (
            controller.signal.aborted ||
            expected !== host.replay.stream ||
            result.streamId !== expected
          )
            return;
          captureTranscript();
          transcript.backfill(result.text);
          saveTranscript();
          backfillNeeded = false;
        })
        .catch(() => {})
        .finally(() => {
          clearTimeout(timeout);
          if (backfill === controller) backfill = undefined;
        });
    }, host.transport.backgroundDelay);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelBackfill();
    else scheduleBackfill();
  });
  window.addEventListener('pagehide', cancelBackfill);

  return {
    restore,
    captureTranscript,
    scheduleTranscript,
    scheduleBackfill,
    cancelBackfill,
    flushTranscript,
    paintCache,
    showRetained,
    coverRetained,
    livePainted,
    hold,
    layout,
    disconnected,
    notifyCachedRendered,
    get cachedUpdated() {
      return cachedUpdated;
    },
    get cachePainted() {
      return cachePainted;
    },
    get handoff() {
      return handoff;
    },
    changeStream(stream: string) {
      const changed = !!(
        (host.replay.stream && host.replay.stream !== stream) ||
        (cachedStream && cachedStream !== stream)
      );
      if (changed) {
        transcript.restore([]);
        cachedStream = '';
      }
      host.replay.stream = stream;
      return changed;
    },
    beginReplay(changed: boolean) {
      if (!changed && !cachePainted) captureTranscript();
      transcript.gap('The connection resumed from a screen snapshot; older output may be missing.');
      backfillNeeded = true;
      handoffPosition = Math.floor(host.term.getViewportY());
      host.replay.reset();
      if (cachePainted) handoff = '\x1bc\x1b[3J';
    },
    appendNotice(text: string) {
      if (handoff === undefined) host.term.write(text);
      else handoff += text;
    },
    restorePosition() {
      if (handoffPosition) host.term.scrollToLine(handoffPosition);
      handoffPosition = 0;
    },
    completeReplay() {
      handoff = undefined;
      cachePainted = false;
      cachedNative = undefined;
    },
    disconnect() {
      cancelBackfill();
      flushTranscript();
      handoffPosition = 0;
      herdrHandoffUntil = 0;
      clearTimeout(herdrHandoffTimer);
      if (handoff !== undefined) {
        handoff = undefined;
        host.replay.reset();
      }
    },
    deferReveal(callback: () => void) {
      clearTimeout(herdrHandoffTimer);
      if (herdrHandoffUntil > Date.now() && !host.projection?.hasHistory) {
        herdrHandoffTimer = setTimeout(callback, herdrHandoffUntil - Date.now());
        return true;
      }
      herdrHandoffUntil = 0;
      return false;
    },
    clear() {
      cancelBackfill();
      backfillNeeded = false;
      transcript.restore([]);
      clearedScreen = terminalSnapshot(host.term).text;
      cachedStream = '';
      void cache.clear(host.cacheKey);
    },
  };
}
