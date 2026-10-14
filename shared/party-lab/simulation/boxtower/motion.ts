import { BOX_TOWER as T } from "./config.js";

/** The last column's index: the box's middle runs from 0 to SPAN and back. */
export const SPAN = T.columns - 1;

/** Ms from the first column to the last for a player whose tallest column is `best` boxes high. */
export const travelMs = (best: number) => T.travelSeconds[Math.max(0, Math.min(T.travelSeconds.length - 1, Math.floor(best)))] * 1000;

/**
 * One box's slide: it appears at `spawn` (ms after BAŞLA) over column `from`, moving `dir`
 * (+1 right, −1 left), and crosses the yard in `travel` ms. Its place is a function of time, so
 * the server can drop it at a press moment in the past and every screen draws it the same.
 */
export interface Slide {
  spawn: number;
  from: number;
  dir: number;
  travel: number;
}

/** The sliding box's middle at `t`, in columns (0 … SPAN); it turns back at both ends. */
export function slideX(s: Slide, t: number) {
  const u = s.from + (s.dir * SPAN * Math.max(0, t - s.spawn)) / s.travel,
    period = 2 * SPAN,
    m = ((u % period) + period) % period;
  return m <= SPAN ? m : period - m;
}
/** The column under the box's middle at `t` (a box exactly between two takes the right one). */
export const columnAt = (s: Slide, t: number) => Math.min(SPAN, Math.max(0, Math.round(slideX(s, t))));

/** The moments in [after, before) the box's middle is exactly over `column`, in order. */
export function crossings(s: Slide, column: number, after: number, before: number): number[] {
  const speed = SPAN / s.travel,
    period = 2 * SPAN,
    out: number[] = [];
  // The unfolded position u runs on from `from`; the box is over `column` where u ≡ ±column (mod 2·SPAN).
  const reach = s.from + s.dir * speed * Math.max(0, before - s.spawn),
    low = Math.min(s.from, reach),
    high = Math.max(s.from, reach);
  for (let n = Math.floor((low - SPAN) / period); n <= Math.ceil((high + SPAN) / period); n++)
    for (const target of [column + n * period, -column + n * period]) {
      const t = s.spawn + (s.dir * (target - s.from)) / speed;
      if (t >= after && t < before && t >= s.spawn && !out.some((o) => Math.abs(o - t) < 1e-6)) out.push(t);
    }
  return out.sort((a, b) => a - b);
}
