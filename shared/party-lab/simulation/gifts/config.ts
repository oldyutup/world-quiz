import { ticks } from "../layers/config.js";

/**
 * Hediye Kapmaca tuning (local and online). Seconds and metres; the rules run in whole
 * 60 Hz ticks (GIFT_TICKS). Nothing else reads this: Bomba Sende's shove punch values are
 * copied here as this mode's own tuning object.
 */
export const GIFT = {
  mode: "gift_grab",
  label: "Hediye Kapmaca",
  players: { min: 2, max: 3 },
  round: { countdown: 3, results: 4, duration: 40 },
  /** Boxes on the middle pile at the start, by player count. No box ever appears later. */
  pile: { 2: 9, 3: 13 } as Readonly<Record<2 | 3, number>>,
  arena: {
    /** Inner face of the round wall (m from the middle). */
    radius: 9.5,
    /** The wall: `segments` straight boxes (a multiple of 6, so it turns onto itself for 2 and 3 players). */
    wall: { thickness: 0.6, height: 1.6, segments: 36 },
    /** Floor slab beyond the wall (visual room) and its depth. */
    floor: 12.5,
    slabBottom: -2,
  },
  /** The middle pile sits on a round stand nobody can climb (≥ 1.5 m: never crossed). */
  pedestal: { radius: 1.0, height: 1.5 },
  /** Homes: flat circles `distance` from the middle, 120° apart for 3 players, opposite for 2. */
  homes: { distance: 6.8, radius: 1.8 },
  /** Six low obstacles 60° apart, between the homes for both player counts. */
  decor: { count: 6, distance: 5.6, radius: 0.42, height: 1.6, offset: Math.PI / 6 },
  reach: {
    /** A box on the floor: pelvis to box, horizontal. */
    loose: 1.1,
    /** The pile: pelvis to the stand's edge, horizontal. */
    pile: 0.8,
  },
  /** A Tut press waits this long for something to take (arriving a moment late still works). */
  pressBuffer: 0.15,
  /** The shove punch (Bomba Sende's values): every landed punch pushes and staggers a little. */
  punch: {
    cooldown: 0.6,
    push: 3.0,
    lift: 0.3,
    stagger: { time: 0.35, posture: 0.7, mobility: 0.25 },
  },
  /**
   * The punch on a carrier: a real hand contact, or (while the punch swings and has not
   * landed) the nearest carrier within `range` m pelvis to pelvis, any direction, pelvises
   * within `heightGap` and clear pelvis and chest lines (Bomba Sende's tag rule).
   */
  assist: { range: 1.3, heightGap: 1.0 },
  /**
   * A carrier hit: the box flies off, the carrier is stunned (no walking, jumping, punching or
   * taking: its movement is ignored), then guarded. Mobility stays 1 so the body still brakes
   * (0 would also switch braking off and let the shove slide it on).
   */
  stun: { time: 1.0, posture: 0.55, mobility: 1, guard: 1.5 },
  /** After an ordinary stagger: guarded this long. */
  staggerGuard: 0.6,
  /** A knocked box: lands `distance` m away along the hit (± `spread` rad), after `flight` s. */
  drop: { distance: [1.5, 2.5] as const, spread: 0.35, flight: 0.5, dropFlight: 0.35, apex: 0.9 },
  /** Box size (m) on the floor, the pile and the homes; the carried one over the head. */
  box: { size: 0.42, carried: 0.48 },
  /** Recent events kept on the wire (ticks) so no screen misses one between snapshots. */
  eventWindow: 60,
} as const;

export const GIFT_TICKS = {
  countdown: ticks(GIFT.round.countdown),
  results: ticks(GIFT.round.results),
  cap: ticks(GIFT.round.duration),
  pressBuffer: ticks(GIFT.pressBuffer),
  stun: ticks(GIFT.stun.time),
  stunGuard: ticks(GIFT.stun.guard),
  staggerGuard: ticks(GIFT.staggerGuard),
  flight: ticks(GIFT.drop.flight),
  dropFlight: ticks(GIFT.drop.dropFlight),
} as const;

export const pileSize = (players: number) => GIFT.pile[players === 2 ? 2 : 3];
