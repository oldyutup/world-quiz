import { RAGDOLL } from "../ragdoll/config.js";

/** Whole fixed steps for a duration in seconds (60 Hz: 1.3 s = 78 ticks). */
export const ticks = (seconds: number) => Math.round(seconds / RAGDOLL.step);

/**
 * Katman Kaosu tuning (local and online, unchanged since local Phase 1). Seconds and metres; everything the rules use
 * is converted to whole 60 Hz ticks once, so tile timing is exact and deterministic.
 * Rooftop and Barn read none of this.
 */
export const LAYER_CHAOS = {
  mode: "layer_chaos",
  label: "Katman Kaosu",
  players: { min: 2, max: 3 },
  round: {
    countdown: 3,
    results: 3.5,
    /**
     * Safety net only: by ~95.4 s the last layer has collapsed and everyone has fallen
     * out (see `collapse`). Survivors still standing at the cap draw.
     */
    cap: 100,
  },
  /** Seconds from arming to GONE, fixed when a tile first arms (by the round clock then). */
  breakTime: {
    base: 1.3,
    /** "Hızlanıyor". */
    fast: 1.05,
    fastAt: 45,
    /** "Çöküş". */
    collapse: 0.8,
    collapseAt: 70,
  },
  /** Stage boundaries as shares of a tile's duration: WARN [0, crack), CRACK [crack, break), BREAK [break, 1). */
  stages: { crack: 0.31, break: 0.69 },
  /**
   * Anti-stall collapse: each layer's untouched tiles are armed ring by ring from the
   * outside in. Ring k (0 = outermost) of a layer is marked at `layerStarts + k·ringInterval`
   * and armed `warning` seconds later. Deterministic; tiles already armed keep their timer.
   */
  collapse: {
    layerStarts: [70, 76, 82, 88],
    ringInterval: 1.2,
    warning: 1.0,
  },
  /** No health: a punch only pushes and staggers (whole-body Δv, like the Barn's knockback). */
  punch: {
    cooldown: 0.6,
    /** Horizontal and upward velocity change (m/s) given to every body part. */
    push: 3.0,
    lift: 0.3,
    /** Measured safe (audit): 0.35 s at posture 0.7 slides ~1 m idle and never topples. */
    stagger: { time: 0.35, posture: 0.7, mobility: 0.25 },
  },
  /**
   * The tile under the hips arms when the controller's own stand-up support would
   * act on it: pelvis ray within RAGDOLL.supportRange, not in a jump's rising phase.
   */
  trigger: { maxRiseSpeed: 2 },
  /** Hips below this: out of the round (the shared fall line). */
  eliminationY: RAGDOLL.fallY,
} as const;

export const LAYER_TICKS = {
  countdown: ticks(LAYER_CHAOS.round.countdown),
  results: ticks(LAYER_CHAOS.round.results),
  cap: ticks(LAYER_CHAOS.round.cap),
  base: ticks(LAYER_CHAOS.breakTime.base),
  fast: ticks(LAYER_CHAOS.breakTime.fast),
  fastAt: ticks(LAYER_CHAOS.breakTime.fastAt),
  collapse: ticks(LAYER_CHAOS.breakTime.collapse),
  collapseAt: ticks(LAYER_CHAOS.breakTime.collapseAt),
  layerStarts: LAYER_CHAOS.collapse.layerStarts.map(ticks),
  ringInterval: ticks(LAYER_CHAOS.collapse.ringInterval),
  warning: ticks(LAYER_CHAOS.collapse.warning),
  punchCooldown: ticks(LAYER_CHAOS.punch.cooldown),
} as const;

/** Break duration (ticks) of a tile that arms on this round tick. */
export function breakTicks(roundTick: number) {
  return roundTick < LAYER_TICKS.fastAt ? LAYER_TICKS.base : roundTick < LAYER_TICKS.collapseAt ? LAYER_TICKS.fast : LAYER_TICKS.collapse;
}
export type SchedulePhase = "normal" | "fast" | "collapse";
export function schedulePhase(roundTick: number): SchedulePhase {
  return roundTick < LAYER_TICKS.fastAt ? "normal" : roundTick < LAYER_TICKS.collapseAt ? "fast" : "collapse";
}
