/**
 * Işık İzi: everyone runs without stopping, turning (smoothly, at a limited rate) towards the
 * screen direction their keys point at, and leaves a glowing trail that kills for as long as
 * it can be seen. A train crosses the middle every few seconds. The server owns the movement,
 * the trails, the train and every death; every knob lives here.
 *
 * Coordinates: metres on the ground plane, x right and z down the screen (the view is never
 * turned); the arena's centre is the origin. A heading is the angle from +x towards +z, so it
 * grows clockwise on the screen.
 */
export const LIGHT_TRAILS = {
  /** Inside of the walls, m (x across the screen, z down it). */
  width: 26,
  depth: 18,
  /** Body radius, m: a head this close to a wall, a trail line or the train is dead. */
  radius: 0.32,
  /** Half the trail's thickness, m: it kills within radius + this of its centre line. */
  trailRadius: 0.1,

  /** Running speed, m/s (never zero). */
  speed: 7,
  /** Fastest turn, rad/s (294°/s: a turning circle of about 2.7 m across, the same as 5 m/s at 210°/s). */
  turnRate: (294 * Math.PI) / 180,
  /** The last `last` seconds: speed and turn rate × `factor` (the same turning circle, all faster). */
  rush: { last: 15, factor: 1.3 },

  /** A trail point every this many steps (the trail is the line through them and the head). */
  trailEvery: 3,
  /** A trail point is gone this long after it was laid, s. */
  trailLife: 2.5,
  /** It fades out over its last this many seconds (and kills until it is gone). */
  trailFade: 0.6,
  /** The newest this much of your own trail, m along it from your head, never hits you. */
  selfGrace: 0.7,
  /** A dead (or departed) player's whole trail fades out over this, s (killing until gone). */
  deathFade: 0.4,

  /**
   * The train along z = 0. Pass k's front enters at `first + k × every` s of play, after
   * `warn` s of warning; it crosses the arena in `cross` s and is `length` m long (the rail
   * stays shut until its tail is out). Direction: left to right first, then turn about.
   */
  train: { first: 8, every: 10, warn: 2, cross: 0.6, length: 20, halfWidth: 0.85 },

  /** Starts: on an ellipse this share of the arena's half size, equally spaced along it, all facing clockwise. */
  spawnScale: 0.6,

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
export const ticks = (seconds: number) => Math.round(seconds * LIGHT_TRAILS.hz);
