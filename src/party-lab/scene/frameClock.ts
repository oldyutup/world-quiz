import { NET } from "../../../shared/party-lab/network/protocol";

/**
 * Where the arenas' fixed-step accumulator restarts (round start, Esc menu closed, tab
 * back): half a tick. Restarting at 0 put every frame right on a tick boundary, so small
 * frame-time noise chose between 0 and 2 ticks per frame. A 2-tick input can be
 * acknowledged when the server has used it for one tick, which cost a one-tick (~77 mm
 * at walking speed) correction each time. Half a tick keeps a steady display at one
 * tick, one input, per frame.
 */
export const ACCUMULATOR_START = 0.5 / NET.physicsHz;

/** The animation frame's own timestamp when the browser exposes it, else `fallback`. */
export function frameTime(fallback: number) {
  const t = typeof document === "undefined" ? null : document.timeline?.currentTime;
  return typeof t === "number" && Number.isFinite(t) ? t : fallback;
}

/** Frames averaged: at 60 Hz, 133 ms. */
const FRAMES = 8;

/**
 * Presentation clock for the online arenas. A steady display shows one frame per
 * refresh, but the times a page can read wander around it: in headed Chrome on macOS
 * both the frame timestamp and performance.now() ran 15–19 ms apart on a 60 Hz panel
 * with no dropped frame, and React Three Fiber's delta is the same. Moving bodies,
 * camera and remote playback by those raw deltas stepped them ±12% unevenly. Each
 * frame here advances by the mean of the last FRAMES intervals instead: the wander
 * averages out (about ±1%), the sum still equals real elapsed time (no drift), and a
 * dropped frame is spread over the next few instead of shown as one jump.
 */
export class FrameClock {
  private last = NaN;
  private recent: number[] = [];
  /** This frame's presentation time (ms, the performance.now() timeline). */
  time = NaN;
  /** Advance to the frame read at `at` (ms). Seconds; `fallback` (the renderer's delta) for the first frame. */
  step(at: number, fallback: number) {
    const raw = at - this.last;
    this.last = at;
    if (!Number.isFinite(raw) || raw < 0 || raw > 250) {
      // First frame, or a hidden tab / long stall: restart from the real clock. The
      // arenas treat a delta over 0.25 s as "suspend", so a stall still reads as one.
      this.recent.length = 0;
      this.time = at;
      return Number.isFinite(raw) && raw >= 0 ? raw / 1000 : fallback;
    }
    if (raw === 0) return 0; // The same frame again.
    this.recent.push(raw);
    if (this.recent.length > FRAMES) this.recent.shift();
    const dt = this.recent.reduce((sum, d) => sum + d, 0) / this.recent.length;
    this.time += dt;
    // Never far from the real clock (remote playback is timed against arrivals).
    if (Math.abs(at - this.time) > 50) this.time = at;
    return dt / 1000;
  }
}
