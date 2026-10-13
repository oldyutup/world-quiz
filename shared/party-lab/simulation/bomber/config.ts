/**
 * Bombacı: a round arena of rings and rays, bombs that blow along both, boxes to break and
 * pillars that never break. The server owns the arena, the bombs, the deaths and the scores;
 * every knob lives here.
 *
 * Coordinates: metres on the ground plane, x right and z down the screen when the view is not
 * turned; the arena's centre is the origin. A cell is (ring, sector): ring 0 next to the hub,
 * sector s spans angles [s, s + 1) × 2π / sectors measured from +x towards +z.
 */
export const BOMBER = {
  /** Sectors around the arena: divisible by 4 and 3, so the 2-sector pillar pattern survives a turn by a half and by a third. */
  sectors: 24,
  /** Radius of the hub (no cell, nobody walks there), m. */
  hubRadius: 2.9,
  /** Ring depths from the hub outwards, m. Inner rings are deeper so cells stay close in size. */
  ringDepths: [1.2, 1.1, 1.0, 0.92, 0.85],
  /** Pillars stand on these rings at every odd sector. */
  pillarRings: [1, 3],
  /** Share of a wedge's free cells (outside the start pocket) that get a box. */
  boxShare: 0.6,

  /** Player body radius and walking speed, m and m/s. */
  radius: 0.3,
  speed: 3.6,

  /** Bombs a player may have on the arena at once. */
  maxBombs: 2,
  /** Fuse, s. */
  fuse: 2.5,
  /** Cells a blast reaches in each of the four directions. */
  range: 3,
  /** A blast's flames burn this long, s: walking in still kills. A broken box burns as long. */
  flame: 0.5,

  /** Dead this long before coming back at the start cell, s. */
  respawn: 2,
  /** Back from the dead: blinking and unhurt by bombs this long, s. */
  shield: 1.5,

  /** Points: hitting another player (to the bomb's owner), dying to your own bomb. */
  killPoints: 1,
  selfPoints: -1,

  /**
   * The last seconds: rings fall from the outside in. Ring `rings[k]` starts blinking at
   * `start + k × every` s of play and falls `warn` s later; ring 0 stays to the end.
   */
  collapse: { start: 45, every: 3.5, warn: 1.5, rings: [4, 3, 2, 1] },

  /** Simulation steps per second (the room's fixed step). */
  hz: 60,
  /** 3-2-1 before BAŞLA, s. */
  countdown: 3,
  /** Play time, s. */
  limit: 60,
  /** Results screen, s. */
  results: 8,
  /** Players the arena is built for. */
  maxLanes: 3,
} as const;

/** Seconds to fixed steps. */
export const ticks = (seconds: number) => Math.round(seconds * BOMBER.hz);
