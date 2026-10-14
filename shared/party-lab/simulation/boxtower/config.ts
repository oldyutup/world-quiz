/**
 * Kutu Kulesi: every player stacks boxes in their own yard of 7 columns. A box slides along
 * the top, bouncing off both ends; a press drops it straight into the column under its middle,
 * on top of what stands there. The first to stack `goal` boxes in one column wins at once.
 * The server owns the slides, the columns and the result; every knob lives here.
 *
 * Units: columns across (0 … columns − 1, left to right), boxes up; times in ms after BAŞLA.
 */
/**
 * The speed curve's ends: seconds the sliding box takes from the first column to the last with
 * nothing standing (`start`) and with the tallest column `top` boxes high (`end`). Every box in
 * between speeds it up by the same share: ×(end / start)^(1 / top) ≈ 0.885 per box, about 11.5 %
 * (0.900, 0.797, 0.705, 0.624, 0.552, 0.489, 0.433, 0.383, 0.339, 0.300 s).
 */
const TRAVEL = { start: 0.9, end: 0.3, top: 9 } as const;
const travelSeconds: readonly number[] = Array.from({ length: TRAVEL.top + 1 }, (_, height) =>
  height === TRAVEL.top ? TRAVEL.end : TRAVEL.start * (TRAVEL.end / TRAVEL.start) ** (height / TRAVEL.top)
);

export const BOX_TOWER = {
  columns: 7,
  /** Boxes in one column that win the round at once. */
  goal: 10,
  travel: TRAVEL,
  /**
   * The speed curve by the player's own tallest column (index = its height; a taller one keeps
   * the last entry), from `travel`. A box landing elsewhere (a miss) leaves the tallest column,
   * so the speed, as it was.
   */
  travelSeconds,
  /** A dropped box falls this long, ms, from any height: it lands at its press + fallMs. */
  fallMs: 250,
  /** The next box starts sliding this long after the last one landed, ms. */
  respawnMs: 400,
  /** Simulation steps per second (the room's fixed step). */
  hz: 60,
  /** 3-2-1 before BAŞLA, seconds. */
  countdown: 3,
  /**
   * Stacking time, seconds. A box pressed before it still lands and counts (the round ends
   * once it is down); a press after it does not count.
   */
  limit: 60,
  /** Results screen, seconds. */
  results: 8,
  /**
   * Aim fairness (as Altın Madenci): a press drops the box where it was at the press moment on
   * the player's clock (ms after BAŞLA) when that was at most this long ago on the server's
   * clock; an older press is moved up to this limit.
   */
  aimToleranceMs: 150,
  /**
   * A press may lead the server's clock by this much, ms (the player's clock follows the
   * snapshots, and the fixed step runs a little early or late against them).
   */
  aheadMs: 50,
  /** Players (yards) the engine and the view support. */
  maxLanes: 3,
  /**
   * Yerel Test Arenası bots. A bot aims at its tallest column (any tallest one) and presses
   * when the box should be over it, `reaction` ms at the earliest after the box appears (±20 %),
   * with a timing error drawn around zero: `error` ms (one standard deviation) at the start
   * speed, times (start travel / travel)^`speedGain`, so it misses more as the box speeds up.
   * Alone for 60 s (scratch simulation, 500 rounds each): Zor reaches 10 every time, in about
   * 30 s; Orta about half the time, in about 50 s, otherwise mostly 8–9 high; Kolay about one
   * round in seven, mostly 7–8 high.
   */
  bots: {
    easy: { reaction: 1200, error: 130, speedGain: 1.1 },
    medium: { reaction: 1000, error: 75, speedGain: 1.0 },
    hard: { reaction: 230, error: 52, speedGain: 0.95 },
  },
} as const;
