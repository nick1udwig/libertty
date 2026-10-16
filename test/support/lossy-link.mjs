export const LOSSY_PROFILE = { name: 'lossy', rtt: 150, mbps: 1, cpu: 6, lossEvery: 37, retransmitMs: 200, stallEvery: 8, stallMs: 700 };

// Preserve TCP byte order while modelling packet retransmission and link outages.
export class LinkSchedule {
  departure = 0;
  packets = 0;
  losses = 0;
  stalls = 0;
  requests = 0;
  pendingStall = 0;
  constructor(profile) { this.profile = profile; }
  request(name) {
    if (this.case !== name) { this.case = name; this.packets = 0; this.requests = 0; }
    this.requests++;
    this.pendingStall = this.profile.stallEvery && this.requests % this.profile.stallEvery === 0 ? this.profile.stallMs : 0;
  }
  write(length, now) {
    const packets = Math.ceil(length / 1460), every = this.profile.lossEvery;
    const losses = every ? Math.floor((this.packets + packets) / every) - Math.floor(this.packets / every) : 0;
    this.packets += packets; this.losses += losses;
    if (this.pendingStall) this.stalls++;
    this.departure = Math.max(this.departure, now) + length * 8 / (this.profile.mbps * 1000) + losses * (this.profile.retransmitMs || 0) + this.pendingStall;
    this.pendingStall = 0;
    return this.departure + this.profile.rtt / 2;
  }
}

export async function installLossyLink(context) {
  await context.addInitScript(() => {
    const Native = WebSocket;
    const profile = window.__linkProfile = { enabled: false, messages: 0, losses: 0, stalls: 0, until: 0,
      pause(ms) { this.stalls++; this.until = performance.now() + ms; } };
    window.WebSocket = class extends Native {
      set onmessage(handler) {
        // One timer drains an ordered queue; separate timers for one release time can fire out of order.
        let arrival = 0, timer;
        const queue = [];
        const deliver = () => {
          timer = undefined;
          while (queue.length && queue[0].due <= performance.now()) {
            const { event } = queue.shift();
            if (this.readyState === Native.OPEN) handler.call(this, event);
          }
          if (queue.length) timer = setTimeout(deliver, queue[0].due - performance.now());
        };
        super.onmessage = event => {
          const now = performance.now();
          let due = Math.max(arrival, now);
          if (profile.enabled) {
            profile.messages++;
            due = Math.max(due, now + 75, profile.until);
            if (profile.messages % 11 === 0) { due += 200; profile.losses++; }
          }
          arrival = due;
          if (due <= now && !queue.length) { handler.call(this, event); return; }
          queue.push({ due, event });
          timer ??= setTimeout(deliver, queue[0].due - now);
        };
      }
    };
  });
}
