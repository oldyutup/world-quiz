import { ticks } from "../layers/config.js";

/**
 * Bomba Sende tuning (local V1). Seconds and metres; the rules use whole 60 Hz ticks
 * (BOMB_TICKS), so every pass and blast happens on an exact tick. Rooftop, Barn, Katman
 * Kaosu and Renk Kaosu read none of this.
 */
export const BOMB_TAG = {
  mode: "bomb_tag",
  label: "Bomba Sende",
  players: { min: 2, max: 3 },
  round: {
    countdown: 3,
    results: 4,
    /**
     * Safety net only (draw): every fuse ends in a blast, so a round of n players ends
     * after n − 1 fuses (3 players: 14 + 2.5 + 14 s).
     */
    cap: 45,
  },
  /**
   * One fuse per blast. It does NOT reset or refill when the bomb changes hands: it keeps
   * burning on the new carrier, and whoever holds it at 0 explodes. Passing it with a
   * second left is the whole point.
   */
  fuse: 14,
  /**
   * After a blast: the next carrier (a random survivor) is shown at once, and the new
   * fuse lights after this pause — everyone else gets a head start (the countdown does the
   * same for the first carrier).
   */
  gap: 2.5,
  /** The previous carrier cannot be tagged straight back for this long (no instant ping-pong). */
  tagBack: 1.0,
  /**
   * Carrier's speed and acceleration (the drive's mobility) while the fuse burns: the chase
   * must be closable, but a runner who routes well (round cover, over hop walls, the gap
   * shortcuts) still gets away. Measured: walking 4.68 → 5.37 m/s, sprinting 6.52 → 7.49 m/s.
   */
  carrierSpeed: 1.15,
  /**
   * Tag assist: while the carrier's punch swings (startup + active, 0.35 s), the nearest
   * rival right next to it takes the bomb, in any direction — in front, beside or behind (no
   * facing rule, no exact hand contact needed; a real hand contact counts under the same
   * rules). Close range only, and never through geometry:
   * - `range`: pelvis to pelvis, horizontal (m) — bodies about an arm's length apart at most;
   * - `surfaceStep`: the two stand on surfaces at most this far apart (m) — the same floor,
   *   ramp or top, never floor-to-catwalk or floor-to-AC-unit;
   * - `heightGap`: pelvis heights at most this far apart (m) (a jump on the same surface is fine);
   * - line of sight: the pelvis-to-pelvis and chest-to-chest lines both clear of every static
   *   collider (walls, AC units, crates, hop walls, decks).
   * Evaluated only while a carrier's punch swings (a few rays per swing), for bots and
   * humans alike.
   */
  tag: { range: 1.3, surfaceStep: 0.65, heightGap: 1.0 },
  /**
   * Slow traps (Bomba Sende's own; maps/bomb.ts BOMB_TRAPS): a foot at floor level within
   * `radius` of an armed trap springs it, on anyone — carrier or not. No damage, no hold:
   * the one caught moves at `slow` × their speed (walking, sprinting, carrier bonus
   * included; jumping still works) for `time` s, and loses that share of their speed at the
   * snap. The trap then lies shut for `rearm` s and reopens. Someone already slowed passes
   * over an armed trap without springing it.
   */
  trap: { radius: 0.45, slow: 0.5, time: 1.0, rearm: 7.0 },
  /**
   * The shove punch (Katman Kaosu's values): every landed punch pushes and staggers; the
   * carrier's landed punch also passes the bomb. The stagger (0.35 s, slow, no jump) is
   * the passer's escape window.
   */
  punch: {
    cooldown: 0.6,
    push: 3.0,
    lift: 0.3,
    stagger: { time: 0.35, posture: 0.7, mobility: 0.25 },
  },
  /** The blast: everyone else within `radius` m is shoved away and staggered. */
  blast: { radius: 3, push: 4, lift: 1.5, stagger: { time: 0.5, posture: 0.6, mobility: 0.3 } },
} as const;

export const BOMB_TICKS = {
  countdown: ticks(BOMB_TAG.round.countdown),
  results: ticks(BOMB_TAG.round.results),
  cap: ticks(BOMB_TAG.round.cap),
  fuse: ticks(BOMB_TAG.fuse),
  gap: ticks(BOMB_TAG.gap),
  tagBack: ticks(BOMB_TAG.tagBack),
  trapSlow: ticks(BOMB_TAG.trap.time),
  trapRearm: ticks(BOMB_TAG.trap.rearm),
} as const;
