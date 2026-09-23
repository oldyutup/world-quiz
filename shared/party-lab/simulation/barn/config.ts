const deg = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Barn Shootout combat tuning (local V1). Rooftop combat (combatConfig.ts) is not
 * read or changed by any of this. Metres, seconds, HP; knockback is a whole-body
 * velocity change (every part gets mass × Δv, as measured in the barn audit).
 */
export const BARN_COMBAT = {
  health: 100,
  /** Unarmed fallback: a physical arm strike, landed by real hand contact. */
  punch: {
    damage: 12,
    /** One strike at a time, alternating hands. */
    cooldown: 0.5,
    knockback: 1.2,
    lift: 0.15,
    stagger: { time: 0.15, posture: 0.85, mobility: 0.7 },
  },
  /** One shell, then it is gone. */
  shotgun: {
    ammo: 1,
    pellets: 8,
    damage: 15,
    /** Pellets land within this angle of the aim (cone half-angle). */
    spread: deg(5.5),
    /** Full damage to `full` m, linear to `weakFactor` at `weak` m, then to 0 at `range`. */
    full: 4,
    weak: 12,
    weakFactor: 0.2,
    range: 14,
    /** Whole-body Δv per landed pellet at full power (m/s), capped; a little of it upward. */
    knockbackPerPellet: 0.9,
    maxKnockback: 7,
    lift: 0.25,
    /** A clean hit (≥ `pellets` landed) staggers: posture never below the measured safe 0.6. */
    stagger: { pellets: 3, time: 0.3, posture: 0.6, mobility: 0.25 },
  },
  /** Ten rounds of automatic fire, then it is gone. */
  smg: {
    ammo: 10,
    /** Seconds between rounds while held (≈ 9.5 rounds/s; the remainder carries over). */
    interval: 0.105,
    damage: 14,
    /** Full damage to `full` m, linear to `farFactor` at `far` m, nothing past `range`. */
    full: 22,
    far: 35,
    farFactor: 0.5,
    range: 40,
    /** Cone half-angle: the first round, growth per round held, cap, recovery per second. */
    spread: deg(1.2),
    bloom: deg(0.45),
    maxSpread: deg(3.2),
    recovery: deg(10),
    knockback: 0.3,
    /** Small push at the struck part: a wobble, never a topple. */
    partImpulse: 0.08,
  },
  aim: {
    /** Chase camera pivot above the pelvis and right-shoulder offset (barnCamera.ts BARN_CAMERA). */
    pivotHeight: 1.05,
    shoulder: 0.45,
    /** How far the crosshair ray is followed to find what it points at. */
    range: 60,
    /** A client's aim-line point may sit this far from the reconstructed shoulder, no further. */
    maxEyeOffset: 1.5,
    /**
     * The shot leaves the torso toward the aim point unless that point is practically
     * inside the shooter (closer than this, m) or not in front of them (the cosine to the
     * look direction below `minForward`); then it goes along the look direction.
     */
    minConvergence: 0.35,
    minForward: 0.2,
  },
  /** E / right click: the nearest active pickup within this reach of the pelvis. */
  pickup: { radius: 1.1, height: 1.0 },
  /** Seconds a body stays down, then protection after the respawn. */
  death: { respawn: 2, protection: 1 },
  /**
   * Respawn choice (combat.ts chooseSpawn). Candidates closer than `clearance` to a
   * living enemy are used only if nothing else is left; then the best score: distance
   * to the nearest living enemy (≤ 25 m) minus `seenPenalty` per enemy with a chest
   * line to the spot, minus `weaponPenalty`/`trapPenalty` per metre inside the weapon
   * or armed-trap clearance, minus `repeatPenalty` for the spot last used, plus
   * 0–`randomness` m.
   */
  respawn: {
    clearance: 6,
    seenPenalty: 10,
    weaponClearance: 3,
    weaponPenalty: 2,
    trapClearance: 2.5,
    trapPenalty: 3,
    repeatPenalty: 6,
    randomness: 2,
  },
  /** A trap or environment death is credited to the last other player who hit the victim this recently (s). */
  credit: { window: 3 },
  trap: {
    /** A foot within this horizontal radius of the trap's centre, at floor level, springs it. */
    radius: 0.45,
    damage: 25,
    /** Seconds held: no walking or jumping, aiming and attacking still allowed. */
    hold: 1.1,
    rearm: 10,
    /** Share of horizontal speed removed at the snap (so a runner stops on the trap). */
    stop: 0.85,
    stagger: { time: 0.2, posture: 0.75, mobility: 1 },
  },
  pickups: {
    /** Active weapons on the map at once (the three-character local test; online: one per player). */
    active: 3,
    /** Seconds from a pickup being taken to its replacement appearing elsewhere. */
    replace: 4,
    /** The replacement's spot glows this long before the weapon appears. */
    telegraph: 0.8,
    /** No replacement appears within this distance of a living player. */
    clearance: 3,
    /** Recently emptied spots are avoided, so two spots do not simply alternate. */
    recent: 2,
  },
} as const;
