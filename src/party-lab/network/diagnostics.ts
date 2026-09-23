import type {
  OnlinePhase,
  PongPacket,
  ServerDiagnostics,
} from "../../../shared/party-lab/network/protocol";

/**
 * Link thresholds, derived from the measured cadence: snapshots every 50 ms in
 * countdown/play/results, pongs every 1000 ms in every phase. A single late packet
 * or a normal ±80 ms jitter never crosses them; a visible freeze does.
 */
export const LINK = {
  /** Ten consecutive missing snapshots (a 0.5 s visible freeze). */
  snapshotStallMs: 500,
  /** Two consecutive missing pongs, e.g. in the lobby where nothing else flows. */
  silenceMs: 2500,
  /**
   * Two consecutive RTT samples above this are noticeably slow for a brawler. One is
   * not enough: a pong that waited behind a main-thread stall (arena load, GC) reads
   * as a multi-second RTT although the network was fine.
   */
  slowRttMs: 350,
  /** Degraded stays up at least this long after the last bad observation (no flicker). */
  holdMs: 1500,
  /** Nothing at all from the server while "connected": treat the socket as dead. */
  deadMs: 10000,
  /** Unacknowledged input beyond ~0.5 s at 60 Hz is coalesced to 10 packets/s. */
  unackedInputs: 30,
  stalledInputIntervalMs: 100,
  /** Rolling window for maxima and rates. */
  windowMs: 5000,
} as const;

export type LinkQuality = "good" | "degraded";

class Series {
  private items: { at: number; value: number }[] = [];
  constructor(private readonly windowMs: number) {}
  push(value: number, now: number) {
    this.items.push({ at: now, value });
    this.prune(now);
  }
  prune(now: number) {
    while (this.items.length && now - this.items[0].at > this.windowMs)
      this.items.shift();
  }
  count(now: number) {
    this.prune(now);
    return this.items.length;
  }
  max(now: number) {
    this.prune(now);
    return this.items.reduce((m, i) => Math.max(m, i.value), 0);
  }
  clear() {
    this.items = [];
  }
}

const RTT_SAMPLES = 20;

/** Client-side link measurements. Pure: every method takes `now` (performance.now). */
export class NetDiagnostics {
  rtt: number[] = [];
  /** Server Date.now() minus client Date.now(), from the lowest-RTT recent sample. */
  clockOffsetMs = 0;
  private offsetRtt = Infinity;
  server: ServerDiagnostics | null = null;
  lastServerMessageAt = -1;
  lastSnapshotAt = -1;
  private lastSnapshotSeq = -1;
  snapshotsAccepted = 0;
  snapshotsRejected = 0; // duplicate, out of order, wrong version or malformed
  snapshotGaps = 0; // sequence numbers never received (incl. across a reconnect)
  private snapshotArrivals = new Series(1000);
  private snapshotIntervals = new Series(LINK.windowMs);
  private inputs = new Series(1000);
  inputsCoalesced = 0;
  drops = 0;
  reconnects = 0;
  deadSocketResets = 0;
  lastCloseCode = 0;
  lastCloseReason = "";
  private droppedAt = -1;
  lastOutageMs = 0;
  private frames = new Series(LINK.windowMs);
  private longTasks = new Series(LINK.windowMs);
  lastChat: {
    id: string;
    serverToClientMs: number;
    receivedAt: number;
    renderMs: number;
  } | null = null;
  private badUntil = -1;

  serverMessage(now: number) {
    this.lastServerMessageAt = now;
  }
  pong(pong: PongPacket, now: number, wallNow: number) {
    const sample = now - pong.t;
    if (!Number.isFinite(sample) || sample < 0) return;
    this.rtt.push(sample);
    if (this.rtt.length > RTT_SAMPLES) this.rtt.shift();
    // The tightest round trip bounds the offset error best; stale ones age out.
    if (sample <= this.offsetRtt || this.rtt.length === 1) {
      this.offsetRtt = sample;
      this.clockOffsetMs = pong.s - (wallNow - sample / 2);
    } else this.offsetRtt += 5;
    if (pong.d) this.server = pong.d;
  }
  snapshot(seq: number, accepted: boolean, now: number) {
    if (!accepted) {
      this.snapshotsRejected++;
      return;
    }
    if (this.lastSnapshotSeq >= 0 && seq > this.lastSnapshotSeq + 1)
      this.snapshotGaps += seq - this.lastSnapshotSeq - 1;
    if (this.lastSnapshotAt >= 0)
      this.snapshotIntervals.push(now - this.lastSnapshotAt, now);
    this.lastSnapshotSeq = seq;
    this.lastSnapshotAt = now;
    this.snapshotsAccepted++;
    this.snapshotArrivals.push(1, now);
  }
  input(now: number) {
    this.inputs.push(1, now);
  }
  frame(dtMs: number, now: number) {
    this.frames.push(dtMs, now);
  }
  longTask(ms: number, now: number) {
    this.longTasks.push(ms, now);
  }
  dropped(code: number, reason: string | undefined, now: number) {
    this.drops++;
    this.lastCloseCode = code;
    this.lastCloseReason = reason ?? "";
    this.droppedAt = now;
  }
  reconnected(now: number) {
    this.reconnects++;
    if (this.droppedAt >= 0) this.lastOutageMs = now - this.droppedAt;
    this.droppedAt = -1;
    // A fresh socket: stale silence must not immediately read as degraded/dead.
    this.lastServerMessageAt = now;
    this.lastSnapshotAt = -1;
  }
  closed(code: number, reason: string | undefined) {
    this.lastCloseCode = code;
    this.lastCloseReason = reason ?? "";
  }
  chatReceived(id: string, sentAt: number, now: number, wallNow: number) {
    this.lastChat = {
      id,
      serverToClientMs: wallNow + this.clockOffsetMs - sentAt,
      receivedAt: now,
      renderMs: -1,
    };
  }
  chatRendered(id: string, now: number) {
    if (this.lastChat?.id === id && this.lastChat.renderMs < 0)
      this.lastChat.renderMs = now - this.lastChat.receivedAt;
  }

  /** Arena phases stream 20 snapshots/s; the lobby only has 1 pong/s. */
  quality(now: number, phase: OnlinePhase): LinkQuality {
    const silent =
      this.lastServerMessageAt >= 0 &&
      now - this.lastServerMessageAt > LINK.silenceMs;
    const frozen =
      phase !== "waiting" &&
      this.lastSnapshotAt >= 0 &&
      now - this.lastSnapshotAt > LINK.snapshotStallMs;
    const n = this.rtt.length;
    const slow =
      n >= 2 && this.rtt[n - 1] > LINK.slowRttMs && this.rtt[n - 2] > LINK.slowRttMs;
    if (silent || frozen || slow) this.badUntil = now + LINK.holdMs;
    return now < this.badUntil ? "degraded" : "good";
  }
  dead(now: number) {
    return (
      this.lastServerMessageAt >= 0 &&
      now - this.lastServerMessageAt > LINK.deadMs
    );
  }

  summary(now: number) {
    const rtt = this.rtt;
    const last = rtt[rtt.length - 1] ?? NaN;
    const avg = rtt.length ? rtt.reduce((a, b) => a + b, 0) / rtt.length : NaN;
    let jitter = 0;
    for (let i = 1; i < rtt.length; i++) jitter += Math.abs(rtt[i] - rtt[i - 1]);
    return {
      rtt: last,
      rttAvg: avg,
      rttJitter: rtt.length > 1 ? jitter / (rtt.length - 1) : NaN,
      rttMax: rtt.length ? Math.max(...rtt) : NaN,
      snapshotAge: this.lastSnapshotAt < 0 ? NaN : now - this.lastSnapshotAt,
      snapshotsPerSecond: this.snapshotArrivals.count(now),
      snapshotGapMaxMs: this.snapshotIntervals.max(now),
      snapshotGaps: this.snapshotGaps,
      snapshotsRejected: this.snapshotsRejected,
      inputsPerSecond: this.inputs.count(now),
      inputsCoalesced: this.inputsCoalesced,
      serverSilenceMs:
        this.lastServerMessageAt < 0 ? NaN : now - this.lastServerMessageAt,
      frameMaxMs: this.frames.max(now),
      longTasks: this.longTasks.count(now),
      longTaskMaxMs: this.longTasks.max(now),
      drops: this.drops,
      reconnects: this.reconnects,
      deadSocketResets: this.deadSocketResets,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      lastOutageMs: this.lastOutageMs,
      clockOffsetMs: this.clockOffsetMs,
      server: this.server,
      chat: this.lastChat,
    };
  }
  reset() {
    this.rtt = [];
    this.offsetRtt = Infinity;
    this.clockOffsetMs = 0;
    this.server = null;
    this.lastServerMessageAt = this.lastSnapshotAt = this.lastSnapshotSeq = -1;
    this.snapshotsAccepted = this.snapshotsRejected = this.snapshotGaps = 0;
    this.snapshotArrivals.clear();
    this.snapshotIntervals.clear();
    this.inputs.clear();
    this.inputsCoalesced = 0;
    this.drops = this.reconnects = this.deadSocketResets = 0;
    this.lastCloseCode = 0;
    this.lastCloseReason = "";
    this.droppedAt = -1;
    this.lastOutageMs = 0;
    this.frames.clear();
    this.longTasks.clear();
    this.lastChat = null;
    this.badUntil = -1;
  }
}
