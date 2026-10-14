/**
 * Nişancı: every player stands at their own stretch of one shooting gallery with three target
 * slots in front of them (left, middle, right). The server draws one wave schedule for the
 * round, and every wave opens the same slots, with the same kinds, for everyone at once; each
 * player shoots their own copy. A target hit soon after it opened scores more; a bomb costs
 * points and stuns, the second one knocks the player out. The server owns the waves, the shots,
 * the lives and the scores; every knob lives here.
 *
 * Times are ms after BAŞLA unless a name says seconds. Slots are 0 left, 1 middle, 2 right;
 * an aim is −1 left, 0 middle, +1 right (slot = aim + 1).
 */
export const MARKSMAN = {
  slots: 3,
  /** Shooting time, seconds. A shot pressed before it still counts when it arrives in time. */
  limit: 45,
  /** 3-2-1 before BAŞLA, seconds. */
  countdown: 3,
  /** Results screen, seconds. */
  results: 8,
  /** Simulation steps per second (the room's fixed step). */
  hz: 60,
  /** The first wave opens this long after BAŞLA. */
  firstMs: 700,
  /**
   * The tempo, from the round's start to its end (by the wave's opening moment, linearly):
   * how long a wave stays up, the pause after it closes before the next one opens, and the
   * odds of a wave opening 1, 2 or 3 slots at once.
   */
  openMs: { start: 1100, end: 700 },
  gapMs: { start: 400, end: 200 },
  sizes: { start: [0.6, 0.3, 0.1], end: [0.25, 0.45, 0.3] },
  /**
   * Bombs: a one-slot wave is a lone bomb this often, and a wave of two or three is all bombs
   * `all` of the time (nothing to hit: holding fire is right). Otherwise in a wave of two or
   * three every slot is a bomb with `multi`, but never all of them (one is turned back into a
   * target). With the tempo above, about one slot in four is a bomb.
   */
  bombs: { single: 0.1, all: 0.1, multi: 0.25 },
  /** A target hit at most this long after it opened scores `good`; later, `slow`. */
  goodMs: 500,
  points: { good: 5, slow: 2, bomb: -5 },
  /**
   * Lives: every bomb hit takes one. With one left the player is stunned this long from the shot
   * (no shot counts, the aim still moves); with none left they are out of the round. When one
   * player is left standing the round ends (`aimToleranceMs` after the knock-out, for shots
   * pressed before it) and they win.
   */
  lives: 2,
  stunMs: 1000,
  /** At least this long between two shots (on the shooter's clock). */
  cooldownMs: 120,
  /**
   * Aim fairness (as Altın Madenci): a shot is judged at its press moment on the shooter's clock
   * (ms after BAŞLA) and with the aim it was pressed with, when that was at most this long ago on
   * the server's clock; an older shot is moved up to this limit.
   */
  aimToleranceMs: 150,
  /** A shot may lead the server's clock by this much (the client's clock follows the snapshots). */
  aheadMs: 50,
  /**
   * Waves are sent this long before they open, so every screen raises them at the exact moment
   * on its own clock: the speed points never pay for the network.
   */
  leadMs: 500,
  /** Closed waves stay in the snapshot this long (their hits keep showing). */
  keepMs: 1500,
  /** A shot packet carries this many of the latest shots (packets may arrive bunched). */
  recentShots: 3,
  /** Players (stretches of the gallery) the engine and the view support. */
  maxLanes: 3,
  /**
   * Yerel Test Arenası bots. For every wave a bot notices it after `reaction` ms (± `spread`),
   * turns to its first target and fires, then moves on to the next one `move` ms later
   * (± `spread` / 2). It mistakes a bomb for a target with `bombFire`, and with `wrong` it fires
   * into the wrong slot first (a wasted shot, corrected after `move`). Alone for 45 s (scratch
   * simulation, 300 rounds): Zor about 220 points and knocked out in 3 % of rounds, Orta about 135
   * and 22 %, Kolay about 50 and 70 %.
   */
  bots: {
    easy: { reaction: 650, spread: 160, move: 260, bombFire: 0.16, wrong: 0.12 },
    medium: { reaction: 470, spread: 110, move: 190, bombFire: 0.05, wrong: 0.06 },
    hard: { reaction: 310, spread: 70, move: 140, bombFire: 0.012, wrong: 0.02 },
  },
} as const;
