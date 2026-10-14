import { MARKSMAN as M } from "./config.js";

/** What a slot holds in a wave. */
export const EMPTY = 0,
  TARGET = 1,
  BOMB = 2;
export type SlotKind = typeof EMPTY | typeof TARGET | typeof BOMB;
/** One wave: it opens and closes at the same moments for everyone (ms after BAŞLA); `kinds` by slot. */
export interface Wave {
  open: number;
  close: number;
  kinds: SlotKind[];
}

const lerp = (from: number, to: number, u: number) => from + (to - from) * u;
/** The tempo for a wave opening at `at`: how long it stays up, the pause after it and the odds of 1/2/3 slots. */
export function tempo(at: number) {
  const u = Math.max(0, Math.min(1, at / (M.limit * 1000)));
  return {
    openMs: lerp(M.openMs.start, M.openMs.end, u),
    gapMs: lerp(M.gapMs.start, M.gapMs.end, u),
    sizes: M.sizes.start.map((p, i) => lerp(p, M.sizes.end[i], u)),
  };
}

/**
 * The round's waves, in order, never overlapping: each opens `gapMs` after the last one closed,
 * and the last one closes by the time limit. A wave opens 1–3 distinct slots (odds by the
 * tempo); a lone slot is a bomb with `bombs.single`, and in a bigger wave every slot is a bomb
 * with `bombs.multi`, but never all of them.
 */
export function makeWaves(random: () => number): Wave[] {
  const waves: Wave[] = [],
    end = M.limit * 1000;
  let open: number = M.firstMs;
  for (;;) {
    const t = tempo(open),
      close = Math.round(open + t.openMs);
    if (close > end) break;
    const r = random(),
      size = r < t.sizes[0] ? 1 : r < t.sizes[0] + t.sizes[1] ? 2 : 3;
    const order = [0, 1, 2];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(random() * (i + 1)));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const chosen = order.slice(0, size),
      kinds: SlotKind[] = [EMPTY, EMPTY, EMPTY];
    for (const slot of chosen) kinds[slot] = random() < (size === 1 ? M.bombs.single : M.bombs.multi) ? BOMB : TARGET;
    if (size > 1 && chosen.every((slot) => kinds[slot] === BOMB)) kinds[chosen[Math.min(size - 1, Math.floor(random() * size))]] = TARGET;
    waves.push({ open, close, kinds });
    open = Math.round(close + t.gapMs);
  }
  return waves;
}

/** The wave up at `t` (open ≤ t < close), −1 between waves. */
export function waveAt(waves: readonly Wave[], t: number) {
  let lo = 0,
    hi = waves.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1,
      w = waves[mid];
    if (t < w.open) hi = mid - 1;
    else if (t >= w.close) lo = mid + 1;
    else return mid;
  }
  return -1;
}
