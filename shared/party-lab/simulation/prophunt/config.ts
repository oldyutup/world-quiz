/**
 * Saklambaç (Prop Hunt) tuning, local V1. Seconds and metres here; the simulation counts
 * whole 60 Hz ticks (PROP_TICKS).
 */
export const PROP_HUNT = {
  /** Local and online mode id and display name. */
  mode: "prop_hunt",
  label: "Saklambaç",
  timing: {
    /** Everyone frozen, the roles shown. */
    countdown: 3,
    /** Hiders move and disguise; the seeker is frozen and sees nothing. */
    hiding: 15,
    /** The seeker is released; hiders win if one is still hidden when it runs out. */
    search: 75,
    /** The result, with every hider still hidden revealed where it was. */
    results: 5,
  },
  seeker: {
    /** Shots for the whole round: no reload, no pickups. Every shot counts; the last one gone with a hider still hidden ends the round (the hiders win). */
    ammo: 15,
    /** Seconds between shots (a deliberate, single-shot blaster). */
    cooldown: 0.55,
    /** Hitscan range (m): the whole camp. */
    range: 40,
  },
  /**
   * The seeker's aim, as in the Barn: the crosshair line runs from the chase camera through
   * a shoulder point (pivot above the pelvis, offset right); what it meets first is the aim
   * point, and the shot leaves the torso toward it, so cover in front of the body stops it.
   */
  aim: {
    pivotHeight: 1.0,
    shoulder: 0.55,
    range: 60,
    /** A client's aim-line point may sit this far from the reconstructed shoulder point (m). */
    maxEyeOffset: 1.2,
    minConvergence: 0.35,
    minForward: 0.2,
  },
  /**
   * The periodic whistle (anti-stall): every `every` seconds of the search (60, 45, 30 and 15 s
   * left in a 75 s search; none at the start or the end), every hider still hidden whistles
   * once, in slot order `stagger` seconds apart, from where it is (its prop or its body). Sound
   * only: no marker, no reveal, nothing else changes.
   */
  whistle: { every: 15, stagger: 0.6 },
  manualWhistle: { cooldown: 8 },
  /**
   * The seeker's close-range hunch: when a hider still hidden has been within `radius` m of the
   * seeker (horizontally; feet within `vertical` m, with no wall, glass, floor or roof between
   * them — furniture and props do not count) for `dwell` s in a row, the seeker gets one
   * generic "someone is close" pulse; then must leave `rearmRadius` for `outsideDwell` s. Who, which
   * prop, which way and how far are never told, and two hiders close by are still one pulse.
   */
  proximity: { radius: 5.5, vertical: 1.5, dwell: 0.9, rearmRadius: 6.5, outsideDwell: 1.25 },
  disguise: {
    /** Horizontal reach from the hider's pelvis to the nearest point of a decoy it copies (m). */
    range: 1.8,
    /** A decoy up to this much above or below the hider's feet can be copied (m). */
    heightGap: 1.2,
    /** Moving while disguised: slow and steady (m/s), no sprint, no jump. */
    speed: 2.3,
    acceleration: 12,
    /** Turn rate toward the movement direction (rad/s). */
    turnRate: 3.2,
    /** Seconds between two transform/untransform presses taking effect. */
    cooldown: 0.8,
    /** Character controller skin (m): the body floats this far above what it stands on. */
    skin: 0.02,
    /** Steps it climbs by itself: the lodge's 0.45 m floor, not a 0.5 m bench or the 0.6 m crate step. */
    step: 0.47,
    /** Steepest slope it climbs (the stair is 26.6°, the lean-to roof 22.6°). */
    maxSlope: 35,
    gravity: 20,
    /** How far a disguise may be nudged to fit beside walls and props when it appears (m). */
    fitSearch: 0.9,
  },
} as const;

const ticks = (seconds: number) => Math.round(seconds * 60);
export const PROP_TICKS = {
  countdown: ticks(PROP_HUNT.timing.countdown),
  hiding: ticks(PROP_HUNT.timing.hiding),
  search: ticks(PROP_HUNT.timing.search),
  results: ticks(PROP_HUNT.timing.results),
  shotCooldown: ticks(PROP_HUNT.seeker.cooldown),
  disguiseCooldown: ticks(PROP_HUNT.disguise.cooldown),
  whistleStagger: ticks(PROP_HUNT.whistle.stagger),
  proximityDwell: ticks(PROP_HUNT.proximity.dwell),
  proximityOutsideDwell: ticks(PROP_HUNT.proximity.outsideDwell),
  manualWhistleCooldown: ticks(PROP_HUNT.manualWhistle.cooldown),
} as const;

/** Seconds left in the search at each whistle: 60, 45, 30, 15 (every 15 s, never at 0 or 75). */
export const WHISTLE_TIMES: readonly number[] = Array.from({ length: Math.ceil(PROP_HUNT.timing.search / PROP_HUNT.whistle.every) - 1 }, (_, k) => PROP_HUNT.timing.search - (k + 1) * PROP_HUNT.whistle.every).filter((left) => left > 0);
/** Search ticks the whistles are due on (the first hider's; the next one `whistleStagger` later). */
export const WHISTLE_TICKS: readonly number[] = WHISTLE_TIMES.map((left) => PROP_TICKS.search - ticks(left));
