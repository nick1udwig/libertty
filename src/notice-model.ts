/** Notice kinds from the least to the most severe. */
export const noticeKinds = ['progress', 'done', 'info', 'warning', 'error'] as const;
export type NoticeKind = typeof noticeKinds[number];
export interface NoticeAction { label: string; run(): void }
export interface NoticeInput { message: string; kind?: NoticeKind; source?: string; actions?: NoticeAction[] }
export interface Notice { id: number; kind: NoticeKind; message: string; source?: string; actions: NoticeAction[]; at: number; key?: string }
/** A notice posted by a terminal frame, whose actions the frame runs when the workspace returns their ids. */
export interface RemoteNotice { message: string; kind: NoticeKind; actions: { id: string; label: string }[] }

/** Done and info notices leave on their own; errors and warnings wait for the person. */
export const noticeLifetimes: Partial<Record<NoticeKind, number>> = { done: 3000, info: 6000, progress: 6000 };
const resumeAtLeast = 1500;
const historyLimit = 20;
const severity = (kind: NoticeKind) => noticeKinds.indexOf(kind);
/** Errors and warnings interrupt the person and wait for them. */
export const urgent = (kind: NoticeKind) => severity(kind) >= severity('warning');
const signature = (notice: Notice) => [notice.key, notice.kind, notice.message, notice.source].join('\n');

export function remoteNotice(data: unknown, fallback: NoticeKind): RemoteNotice | undefined {
  const value = data as Partial<RemoteNotice> | null;
  if (typeof value?.message !== 'string' || !value.message || value.message.length > 2000) return;
  const actions = Array.isArray(value.actions) ? value.actions.filter(action => typeof action?.id === 'string' && action.id.length <= 40 && typeof action.label === 'string' && action.label.length <= 40).slice(0, 2) : [];
  return { message: value.message, kind: noticeKinds.includes(value.kind!) ? value.kind! : fallback, actions: actions.map(({ id, label }) => ({ id, label })) };
}

export function remoteActions(notice: RemoteNotice, run: (id: string) => void): NoticeAction[] {
  return notice.actions.map(action => ({ label: action.label, run: () => run(action.id) }));
}

/** Hold current notices, keyed states and a short history, and choose the notice the bubble presents. */
export class NoticeModel {
  /** Current notices, newest first. */
  events: Notice[] = [];
  /** Conditions that last while true, such as a reconnecting terminal. */
  readonly states = new Map<string, Notice>();
  /** Dismissed and expired notices, newest first. */
  history: Notice[] = [];
  presented?: Notice;
  private nextId = 1;
  /** States the person put away, so one that returns unchanged, such as after a tab switch, stays folded. */
  private folded = new Set<string>();
  private timers = new Map<number, { handle?: ReturnType<typeof setTimeout>; deadline: number; remaining: number }>();
  private changed: () => void;
  private now: () => number;

  constructor(changed: () => void, now = () => Date.now()) { this.changed = changed; this.now = now; }

  get active() { return this.events.length > 0 || this.states.size > 0; }
  get progress() { return [...this.states.values()].some(notice => notice.kind === 'progress'); }
  /** Notices the person has not dismissed, excluding progress that resolves itself. */
  get unread() { return this.events.length + [...this.states.values()].filter(notice => notice.kind !== 'progress').length; }
  get strongest() { return [...this.states.values(), ...this.events].filter(notice => notice.kind !== 'progress').sort((a, b) => severity(b.kind) - severity(a.kind) || b.at - a.at)[0]; }
  /** States first, then notices, newest first. */
  get current() { return [...this.states.values(), ...this.events]; }

  notify(input: NoticeInput) {
    const kind = input.kind ?? 'error';
    const repeated = this.events.find(notice => notice.kind === kind && notice.message === input.message);
    if (repeated) this.remove(repeated);
    const notice = this.create(input, kind);
    this.events.unshift(notice);
    this.presented = notice;
    const lifetime = noticeLifetimes[kind];
    if (lifetime) { this.timers.set(notice.id, { deadline: 0, remaining: lifetime }); this.resume(notice); }
    this.changed();
    return notice;
  }

  /** Set or clear a keyed state; a presented state follows its updates, and a new or changed error or warning unfurls unless the person put it away. */
  set(key: string, input?: NoticeInput) {
    const previous = this.states.get(key);
    if (!input) {
      if (!previous) return;
      this.states.delete(key);
      if (this.presented === previous) this.presented = undefined;
      this.changed();
      return;
    }
    const kind = input.kind ?? 'progress', actions = input.actions ?? [];
    if (previous?.kind === kind && previous.message === input.message && previous.source === input.source && previous.actions.map(action => action.label).join('\n') === actions.map(action => action.label).join('\n')) {
      previous.actions = actions;
      return;
    }
    const notice = this.create(input, kind);
    notice.key = key;
    if (previous?.kind === kind) { notice.id = previous.id; notice.at = previous.at; }
    this.states.set(key, notice);
    if (this.presented === previous && previous) this.presented = notice;
    else if (urgent(kind) && !this.folded.has(signature(notice))) this.presented = notice;
    this.changed();
  }

  /** Move a notice to the history; a state only leaves the bubble because it lasts while true. */
  dismiss(notice: Notice) {
    if (notice.key !== undefined || !this.events.includes(notice)) { this.fold(notice); return; }
    this.remove(notice);
    this.history.unshift(notice);
    this.history.length = Math.min(this.history.length, historyLimit);
    this.changed();
  }

  /** Put the presented notice away without dismissing it. */
  fold(notice = this.presented) {
    if (!notice || this.presented !== notice) return;
    if (notice.key !== undefined) this.folded.add(signature(notice));
    this.presented = undefined;
    this.changed();
  }

  /** Dismiss every notice and forget the history, keeping states. */
  clear() {
    for (const notice of this.events) this.cancel(notice);
    this.events = []; this.history = []; this.presented = undefined;
    this.changed();
  }

  /** Pause a notice's lifetime while the person touches or reads it. */
  hold(notice: Notice) {
    const timer = this.timers.get(notice.id);
    if (!timer?.handle) return;
    clearTimeout(timer.handle); timer.handle = undefined;
    timer.remaining = Math.max(0, timer.deadline - this.now());
  }

  resume(notice: Notice) {
    const timer = this.timers.get(notice.id);
    if (!timer || timer.handle) return;
    const delay = Math.max(timer.remaining, resumeAtLeast);
    timer.deadline = this.now() + delay;
    timer.handle = setTimeout(() => { this.timers.delete(notice.id); this.dismiss(notice); }, delay);
  }

  private create(input: NoticeInput, kind: NoticeKind): Notice {
    return { id: this.nextId++, kind, message: input.message, source: input.source, actions: input.actions ?? [], at: this.now() };
  }

  private remove(notice: Notice) {
    this.events = this.events.filter(event => event !== notice);
    this.cancel(notice);
    if (this.presented === notice) this.presented = undefined;
  }

  private cancel(notice: Notice) {
    clearTimeout(this.timers.get(notice.id)?.handle);
    this.timers.delete(notice.id);
  }
}
