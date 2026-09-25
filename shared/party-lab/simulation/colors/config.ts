import { RAGDOLL } from "../ragdoll/config.js";
import { ticks } from "../layers/config.js";

/** The four gameplay colours, in index order. */
export const COLOR_IDS = ["blue", "yellow", "green", "pink"] as const;
export type ColorId = (typeof COLOR_IDS)[number];
/** 0 blue, 1 yellow, 2 green, 3 pink. */
export type ColorIndex = 0 | 1 | 2 | 3;
export const COLOR_INDICES: readonly ColorIndex[] = [0, 1, 2, 3];
/** Turkish names (HUD: "MAVİ!"). */
export const COLOR_NAMES: Readonly<Record<ColorId, string>> = { blue: "Mavi", yellow: "Sarı", green: "Yeşil", pink: "Pembe" };
/** Surface symbol of each colour, so the colour is never the only cue. */
export const COLOR_SYMBOLS: Readonly<Record<ColorId, "circle" | "stripes" | "triangle" | "cross">> = {
  blue: "circle",
  yellow: "stripes",
  green: "triangle",
  pink: "cross",
};

/**
 * Renk Kaosu tuning (local V1). Seconds and metres; the rules use whole 60 Hz ticks
 * (COLOR_TICKS), so every drop and restore happens on an exact tick. Rooftop, Barn and
 * Katman Kaosu read none of this.
 */
export const COLOR_CHAOS = {
  mode: "color_chaos",
  label: "Renk Kaosu",
  players: { min: 2, max: 3 },
  round: {
    countdown: 3,
    results: 3.5,
    /**
     * Safety net only (draw), never reached in play: the shrink's final drop (cycle 32,
     * 119.4 s) takes the last tile away, so the last player is out by ≈ 120.5 s.
     */
    cap: 125,
  },
  cycle: {
    /**
     * All tiles back in the new colours, no target yet. Includes the restore animation, so
     * bodies that were pushed around during the drop settle before the next target. The
     * first cycle has none: its colours are visible through the whole countdown.
     */
    preview: 0.9,
    /** Non-target tiles gone (colliders off): falls resolve, then every tile returns. */
    unsafe: 1.5,
  },
  /**
   * Reaction time from the target announcement to the drop, by cycle (1-based):
   * [last cycle of the band, seconds]. Never below 1.2 s.
   */
  reaction: [
    [2, 2.6],
    [4, 2.2],
    [6, 1.8],
    [8, 1.5],
    [Infinity, 1.2],
  ] as readonly (readonly [number, number])[],
  /**
   * Daralma (shrink), from cycle 19 (70.5 s): the field erodes from the rim toward the
   * middle. Stage k keeps the tiles within `keep` m of the middle (tile centres; the
   * field's 2.0 m hexes: 9.2 → 85 tiles, 8.8 → 73, 8.1 → 61, 7.0 → 43, 5.3 → 31,
   * 4.1 → 19, 2.1 → 7), then "four" — the middle tile and every other tile around it,
   * one tile per colour — and −1: none (the final drop).
   * - Cycle `cut − 1`: the tiles it will drop are marked (they still play normally).
   * - Cycle `cut`: they come back grey, never the target, and stand through the preview
   *   and the reaction time (walkable, a warning); they drop with the other colours and
   *   never return.
   * So no tile a player could be standing on vanishes without a full cycle's warning, and
   * no tile ever leaves while it is the target.
   */
  shrink: [
    { cut: 20, keep: 8.8 },
    { cut: 21, keep: 8.1 },
    { cut: 22, keep: 7.0 },
    { cut: 23, keep: 5.3 },
    { cut: 24, keep: 4.1 },
    { cut: 26, keep: 2.1 },
    { cut: 28, keep: "four" },
    { cut: 32, keep: -1 },
  ] as readonly { readonly cut: number; readonly keep: number | "four" }[],
  /** Presentation (the colliders change on exact ticks; these are only the animations). */
  visual: { drop: 0.3, restore: 0.45 },
  /** Katman Kaosu's shove punch, as Renk Kaosu's own tuning (same values). */
  punch: {
    cooldown: 0.6,
    push: 3.0,
    lift: 0.3,
    stagger: { time: 0.35, posture: 0.7, mobility: 0.25 },
  },
  /** Hips below this: out of the round (the shared fall line, 5 m under the field). */
  eliminationY: RAGDOLL.fallY,
} as const;

/** Reaction time (s) of a cycle (1-based). */
export function reactionSeconds(cycle: number) {
  for (const [last, seconds] of COLOR_CHAOS.reaction) if (cycle <= last) return seconds;
  return COLOR_CHAOS.reaction[COLOR_CHAOS.reaction.length - 1][1];
}
/** Reaction time of a cycle in whole ticks (2.6 s = 156). */
export const reactionTicks = (cycle: number) => ticks(reactionSeconds(cycle));

export const COLOR_TICKS = {
  countdown: ticks(COLOR_CHAOS.round.countdown),
  results: ticks(COLOR_CHAOS.round.results),
  cap: ticks(COLOR_CHAOS.round.cap),
  preview: ticks(COLOR_CHAOS.cycle.preview),
  unsafe: ticks(COLOR_CHAOS.cycle.unsafe),
  drop: ticks(COLOR_CHAOS.visual.drop),
  restore: ticks(COLOR_CHAOS.visual.restore),
} as const;
