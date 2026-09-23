import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";
import type { ServerDiagnostics } from "../../../shared/party-lab/network/protocol.js";

/** Reported values describe the last completed window, so they don't flicker. */
export const DIAGNOSTICS_WINDOW_MS = 5000;
/** A window worse than any of these is logged once (Railway logs keep the evidence). */
export const SLOW = { stepMs: 8, tickGapMs: 100, loopDelayMs: 100, gcMs: 50 };

interface LoopWindow {
  steps: number;
  stepMs: number;
  stepMaxMs: number;
  tickGapMaxMs: number;
  catchUpSteps: number;
  snapshots: number;
  snapshotMs: number;
  snapshotMaxMs: number;
  chats: number;
  chatPatchMs: number;
  chatPatchMaxMs: number;
}
const emptyLoop = (): LoopWindow => ({
  steps: 0,
  stepMs: 0,
  stepMaxMs: 0,
  tickGapMaxMs: 0,
  catchUpSteps: 0,
  snapshots: 0,
  snapshotMs: 0,
  snapshotMaxMs: 0,
  chats: 0,
  chatPatchMs: 0,
  chatPatchMaxMs: 0,
});

const LOOP_RESOLUTION_MS = 10;
/** The histogram records sample intervals (≈ resolution + delay); report the delay only. */
const loopDelayMs = (ns: number) => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS);
/** Process-wide: one event-loop histogram and GC observer for every room. */
class ProcessMetrics {
  private loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  private gcMaxMs = 0;
  private started = performance.now();
  private cpu = process.cpuUsage();
  last = { loopDelayP99Ms: 0, loopDelayMaxMs: 0, gcMaxMs: 0, cpuPercent: 0 };
  rooms = 0;
  constructor() {
    this.loop.enable();
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          this.gcMaxMs = Math.max(this.gcMaxMs, entry.duration);
      }).observe({ entryTypes: ["gc"] });
    } catch {
      /* GC timing is optional on some runtimes. */
    }
    // Unref: diagnostics must never keep a stopping process alive.
    setInterval(() => this.rotate(), DIAGNOSTICS_WINDOW_MS).unref();
  }
  private rotate() {
    const now = performance.now();
    const cpu = process.cpuUsage(this.cpu);
    this.last = {
      loopDelayP99Ms: loopDelayMs(this.loop.percentile(99)),
      loopDelayMaxMs: loopDelayMs(this.loop.max),
      gcMaxMs: this.gcMaxMs,
      cpuPercent: ((cpu.user + cpu.system) / 1000 / (now - this.started)) * 100,
    };
    this.loop.reset();
    this.gcMaxMs = 0;
    this.cpu = process.cpuUsage();
    this.started = now;
    if (
      this.last.loopDelayMaxMs > SLOW.loopDelayMs ||
      this.last.gcMaxMs > SLOW.gcMs
    )
      console.warn(
        `[party-lab] event loop: delay p99 ${this.last.loopDelayP99Ms.toFixed(1)} ms, max ${this.last.loopDelayMaxMs.toFixed(1)} ms, gc max ${this.last.gcMaxMs.toFixed(1)} ms, cpu ${this.last.cpuPercent.toFixed(0)}% (rooms ${this.rooms})`
      );
  }
}
let shared: ProcessMetrics | null = null;
export const processMetrics = () => (shared ??= new ProcessMetrics());

/** Per-room fixed-step, snapshot and chat timings over a rolling window. */
export class LoopMetrics {
  private current = emptyLoop();
  private last: LoopWindow | null = null;
  private windowStart = performance.now();
  private lastTick = -1;
  private pendingChat: number[] = [];
  constructor(private readonly label: () => string) {}
  /** Called at the top of every fixed-step callback, before any early return. */
  tick(now: number) {
    if (this.lastTick >= 0) {
      const gap = now - this.lastTick;
      this.current.tickGapMaxMs = Math.max(this.current.tickGapMaxMs, gap);
      // setFixedTimestep runs up to five steps back-to-back after a late interval.
      if (gap < 2) this.current.catchUpSteps++;
    }
    this.lastTick = now;
    if (now - this.windowStart >= DIAGNOSTICS_WINDOW_MS) this.rotate(now);
  }
  step(ms: number) {
    this.current.steps++;
    this.current.stepMs += ms;
    this.current.stepMaxMs = Math.max(this.current.stepMaxMs, ms);
  }
  snapshot(ms: number) {
    this.current.snapshots++;
    this.current.snapshotMs += ms;
    this.current.snapshotMaxMs = Math.max(this.current.snapshotMaxMs, ms);
  }
  chatReceived(now: number) {
    this.pendingChat.push(now);
  }
  /** Colyseus onBeforePatch: pending chat leaves in this patch. */
  patch(now: number) {
    for (const received of this.pendingChat) {
      const ms = now - received;
      this.current.chats++;
      this.current.chatPatchMs += ms;
      this.current.chatPatchMaxMs = Math.max(this.current.chatPatchMaxMs, ms);
    }
    this.pendingChat = [];
  }
  private rotate(now: number) {
    const w = this.current;
    if (
      w.stepMaxMs > SLOW.stepMs ||
      w.tickGapMaxMs > SLOW.tickGapMs
    )
      console.warn(
        `[party-lab] room ${this.label()} slow loop: step avg ${(w.stepMs / Math.max(1, w.steps)).toFixed(2)} ms, max ${w.stepMaxMs.toFixed(2)} ms, tick gap max ${w.tickGapMaxMs.toFixed(0)} ms, catch-up steps ${w.catchUpSteps}`
      );
    this.last = w;
    this.current = emptyLoop();
    this.windowStart = now;
  }
  report(): ServerDiagnostics {
    const w = this.last ?? this.current;
    const p = processMetrics();
    const memory = process.memoryUsage();
    return {
      windowMs: DIAGNOSTICS_WINDOW_MS,
      stepAvgMs: w.stepMs / Math.max(1, w.steps),
      stepMaxMs: w.stepMaxMs,
      tickGapMaxMs: w.tickGapMaxMs,
      catchUpSteps: w.catchUpSteps,
      snapshotAvgMs: w.snapshotMs / Math.max(1, w.snapshots),
      snapshotMaxMs: w.snapshotMaxMs,
      loopDelayP99Ms: p.last.loopDelayP99Ms,
      loopDelayMaxMs: p.last.loopDelayMaxMs,
      gcMaxMs: p.last.gcMaxMs,
      cpuPercent: p.last.cpuPercent,
      heapMb: memory.heapUsed / 1048576,
      rssMb: memory.rss / 1048576,
      chatPatchAvgMs: w.chatPatchMs / Math.max(1, w.chats),
      chatPatchMaxMs: w.chatPatchMaxMs,
      rooms: p.rooms,
    };
  }
}
