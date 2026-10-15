/**
 * Ritim Ustası: every player has a lane of their own and the same notes slide along every lane
 * at once (one song, drawn by the server from a style and a seed). A note pressed with its key
 * when it reaches the circle scores; every hit grows the combo, any slip (a miss, a wrong key, a
 * press with no note) breaks it, and the longest combo is paid as a bonus at the end. The server
 * owns the song, the presses, the scores and the combos; every knob lives here.
 *
 * Times are ms after BAŞLA unless a name says seconds. Keys are 0 W (up), 1 A (left), 2 S (down),
 * 3 D (right); the arrows do the same.
 */
export const RHYTHM = {
  /** Playing time, seconds: the song (about 43 s) and its last chord fit inside it. */
  limit: 45,
  /** 3-2-1 before BAŞLA, seconds. */
  countdown: 3,
  /** Results screen, seconds. */
  results: 8,
  /** Simulation steps per second (the room's fixed step). */
  hz: 60,
  keys: 4,
  /** The song: bars of four beats, the tempo rising smoothly from `bpm.start` to `bpm.end` over them. */
  song: { bars: 22, beatsPerBar: 4, bpm: { start: 110, end: 140 } },
  /**
   * Judging windows (half widths, ms): a press this close to its note is MÜKEMMEL, up to `good`
   * İYİ; a note nobody pressed by `good` after its moment is missed.
   */
  windows: { perfect: 50, good: 110 },
  points: { perfect: 10, good: 5 },
  /** The longest combo of the round, times this, is added to the score at the end. */
  comboBonus: 2,
  /**
   * Fairness (as Nişancı): a press is judged at its stamp on the player's clock (ms after BAŞLA),
   * the moment the note was on their screen, when that was at most this long ago on the server's
   * clock (a round trip and some); an older one is moved up to this limit. The server calls a
   * note missed only once no press can reach it any more (`good` + this after its moment).
   */
  toleranceMs: 300,
  /** A press may lead the server's clock by this much (the client's clock follows the snapshots). */
  aheadMs: 50,
  /** A press packet carries this many of the latest presses (packets may arrive bunched). */
  recentPresses: 6,
  /** Results (and stray presses) stay in the snapshot this long after they happened. */
  keepMs: 2500,
  /** Players (lanes) the engine and the view support. */
  maxLanes: 3,
  /**
   * Yerel Test Arenası bots. For every note a bot misses it with `miss`, presses a wrong key
   * with `wrong`, and otherwise presses it `bias` ± a normal spread of `sigma` ms off its moment
   * (so Zor is nearly always MÜKEMMEL and Kolay often İYİ or late). Now and then (`stray` per
   * note) it presses between notes, breaking its own combo.
   */
  bots: {
    easy: { sigma: 62, bias: 14, miss: 0.14, wrong: 0.05, stray: 0.02 },
    medium: { sigma: 40, bias: 6, miss: 0.07, wrong: 0.02, stray: 0.006 },
    hard: { sigma: 17, bias: 0, miss: 0.012, wrong: 0.004, stray: 0 },
  },
} as const;
