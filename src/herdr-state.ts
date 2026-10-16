import type { HerdrAgent, HerdrSnapshot, HerdrStatus } from './herdr-protocol.ts';
export interface HerdrNotification { terminalId: string; kind: 'done' | 'request'; sequence: number }
interface State { raw: HerdrStatus; sequence: number; completion?: number; seen?: number; working: boolean }
/** Completion acknowledgements belong to this viewer, independently of desktop focus. */
export class HerdrState {
  private states = new Map<string, State>();
  private initialized = false;
  agents: HerdrAgent[] = [];
  constructor(checkpoint?: Record<string, State>) {
    if (!checkpoint || typeof checkpoint !== 'object') return;
    for (const [id, state] of Object.entries(checkpoint).slice(0, 256)) {
      if (!state || !Number.isSafeInteger(state.sequence) || !['idle', 'working', 'blocked', 'done', 'unknown'].includes(state.raw)) continue;
      this.states.set(id, { raw: state.raw, sequence: state.sequence, working: state.working === true,
        completion: Number.isSafeInteger(state.completion) ? state.completion : undefined, seen: Number.isSafeInteger(state.seen) ? state.seen : undefined });
    }
  }
  checkpoint() { return Object.fromEntries(this.states); }
  update(snapshot: HerdrSnapshot): HerdrNotification[] {
    const notifications: HerdrNotification[] = [], live = new Set(snapshot.agents.map(agent => agent.terminalId));
    for (const id of this.states.keys()) if (!live.has(id)) this.states.delete(id);
    for (const agent of snapshot.agents) {
      const previous = this.states.get(agent.terminalId);
      // A decreasing lifecycle sequence means this is a fresh server/occupant.
      const old = previous && agent.sequence >= previous.sequence ? previous : undefined;
      const state: State = { raw: agent.status, sequence: agent.sequence, seen: old?.seen, working: old?.working || false };
      if (agent.status === 'working') state.working = true;
      if (agent.status === 'idle' || agent.status === 'done') {
        state.completion = agent.completion ?? (agent.status === 'done' || old?.working ? agent.sequence : old?.completion);
        state.working = false;
        if (this.initialized && old && state.completion !== undefined && state.completion !== old.completion)
          notifications.push({ terminalId: agent.terminalId, kind: 'done', sequence: state.completion });
      }
      if (this.initialized && old && agent.status === 'blocked' && (old.raw !== 'blocked' || old.sequence !== agent.sequence))
        notifications.push({ terminalId: agent.terminalId, kind: 'request', sequence: agent.sequence });
      if (agent.status === 'unknown') state.working = false;
      this.states.set(agent.terminalId, state);
    }
    this.agents = snapshot.agents; this.initialized = true;
    return notifications;
  }
  viewed(terminalId: string): boolean {
    const state = this.states.get(terminalId);
    if (!state || state.completion === undefined || (state.seen ?? -1) >= state.completion) return false;
    state.seen = state.completion; return true;
  }
  completion(terminalId: string) { return this.states.get(terminalId)?.completion; }
  status(agent: HerdrAgent): HerdrStatus {
    const state = this.states.get(agent.terminalId);
    if (state && (state.raw === 'idle' || state.raw === 'done'))
      return state.completion !== undefined && (state.seen ?? -1) < state.completion ? 'done' : 'idle';
    return agent.status;
  }
  get attention() { return this.agents.filter(agent => ['done', 'blocked'].includes(this.status(agent))).length; }
}
