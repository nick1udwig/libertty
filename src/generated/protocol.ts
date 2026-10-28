// Generated from the Rust wire types by `npm run bindings`; do not edit.

export type Candidate = { command: string, score: number, /** User-facing explanations of each change. */ changes: string[], literal?: boolean, };

export type Catalog = { cwd: string, commands: Array<string>, paths: Array<string>, history: Array<string>, functions?: Array<string>, historyCwds?: { [key in string]: string }, };

export type ClientMessage = { "type": "ping", checkpoint?: boolean, }
  | { "type": "draft" } & Draft
  | { "type": "repair" } & RepairRequest
  | { "type": "repair-cancel", id: string, }
  | { "type": "dictation" } & DictationRequest
  | { "type": "ack", seq: number, }
  | { "type": "resize", cols: number, rows: number, mobile?: boolean, }
  | { "type": "input", data: string, /** Numbers keys per browser terminal so a reconnect can resend them exactly once. */ seq?: number, }
  | { "type": "paste", text: string, }
  | { "type": "replace", text: string, id: string, prompt: number, revision: number, }
  | { "type": "command", command: string, id: string, prompt?: number, }
  | { "type": "input-line", id: string, prompt: number, revision: number, }
  | { "type": "herdr-frame-request" }
  | { "type": "herdr-active", active: boolean, }
  | { "type": "terminal-scroll", lines: number, column: number, row: number, }
  | { "type": "terminal-click", column: number, row: number, cols: number, rows: number, }
  | { "type": "dictation-paste", text: string, applied: boolean, replace: boolean, prompt: number, revision: number, readingPhrases?: string[], };

export type DictationAction = "start" | "finish" | "cancel";

export type DictationCheckpoint = { acceptedFrames: number, finished: boolean, };

export type DictationRequest = { id: string, action: DictationAction, prompt?: number, revision?: number, target?: DictationTarget, readingPhrases?: string[], };

export type DictationSource = "dictation";

export type DictationState = "ready" | "done" | "error";

/** Where dictated text goes: the shell prompt or a running program. */
export type DictationTarget = "shell" | "program";

export type Draft = { text: string, id: string, prompt: number, revision: number, context: string, target: DictationTarget, history?: number, };

export type EngineMode = "server";

export type FileEntry = { name: string, directory: boolean, symlink: boolean, size: number, modified: number, mode: number, };

export type FileListing = { path: string, parent: string, entries: Array<FileEntry>, truncated: boolean, };

export type HerdrAgent = { terminalId: string, paneId: string, workspaceId?: string, tabId?: string, workspace: string, name: string, kind: string, status: HerdrStatus, sequence: number, completion?: number, cwd: string, };

export type HerdrFrame = { /** Viewers receive only acknowledged frames. */ seq: number, width: number, height: number, full: boolean, /** Raw ANSI bytes, decoded once from Herdr and base64-encoded only for JSON clients. */ bytes: string, };

export type HerdrMessage = { "type": "snapshot", snapshot: HerdrSnapshot, }
  | { "type": "error", message: string, };

export type HerdrSnapshot = { agents: Array<HerdrAgent>, terminals: Array<HerdrAgent>, spaces: Array<HerdrSpace>, worktreeDirectory?: string, version?: string, protocol?: number, };

export type HerdrSpace = { id: string, name: string, terminalIds: Array<string>, cwd: string, selectedTerminalId?: string, linkedWorktree?: boolean, checkoutPath?: string, /** Checkouts of one repository share this key, so worktrees can group under their root. */ repoKey?: string, repoName?: string, };

export type HerdrStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type ReadingCapture = { id: string, name: string, exitCode: number, };

export type RepairIntent = { "kind": "shell" }
  | { "kind": "reading-file", phrase: string, operand: string, }
  | { "kind": "reading-pipeline", phrase: string, command: string, };

export type RepairRequest = { id: string, text: string, prompt: number, revision: number, intent?: RepairIntent, };

export type RepairResult = { id: string, prompt: number, revision: number, accepted: boolean, error?: string, source?: DictationSource, original: string, selected: string, candidates: Array<Candidate>, };

export type ServerMessage = { "type": "pong" }
  | { "type": "repair-result" } & RepairResult
  | { "type": "input-line", id: string, prompt: number, revision: number, text?: string, cursor?: number, }
  | { "type": "transfer", request: TransferRequest, }
  | { "type": "pasted", text: string, replace: boolean, prompt: number, revision: number, source?: DictationSource, repairing?: boolean, }
  | { "type": "dictation", resume?: DictationCheckpoint, id: string, state: DictationState, message?: string, }
  | { "type": "reading-file", path: string, }
  | { "type": "reading-capture" } & ReadingCapture
  | { "type": "reading-error", message: string, }
  | { "type": "ssh-command", id: string, command: string, }
  | { "type": "herdr-command", id: string, command: string, }
  | { "type": "ssh-released", id: string, }
  | { "type": "output", seq: number, data: string, }
  | { "type": "screen", text: string, version?: number, }
  | { "type": "screen-delta", base: number, version: number, drop: number, from: number, tail: number, text: string, }
  | { "type": "herdr-layout", cols: number, rows: number, ready: boolean, }
  | { "type": "herdr-frame" } & HerdrFrame
  | { "type": "state", state: ShellState, }
  | { "type": "hello", engine: EngineMode, reset: boolean, truncated: boolean, firstSeq: number, lastSeq: number, streamId: string, }
  | { "type": "edit-result", id: string, accepted: boolean, revision: number, }
  | { "type": "input-ack", seq?: number, }
  | { "type": "result", id: string, accepted: boolean, message?: string, };

export type ShellState = { cwd: string, inputRevision: number, inputContext?: string, promptRevision: number, ready: boolean, prompt: number, exited: boolean, exitCode?: number, inputTarget?: DictationTarget, terminalScroll?: boolean, };

export type TransferRequest = { id: string, action: 'upload' | 'download', path: string, name: string, };
