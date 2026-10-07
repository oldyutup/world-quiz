/**
 * Tıklama Yarışı: every counted press pushes a player's car; it glides and slows down by
 * itself. The server moves the cars; clients only show where the server put them.
 *
 * The driving knobs are the four below `trackLength`. With them an average player (about
 * 9 presses a second) finishes in about 7.5 s, a fast one (about 12) in about 5.7 s, a slow
 * one (about 6) in about 11 s; a car let go at top speed glides about 2 s (some 5 m) before
 * it stops, so pressing in bursts still gets there (servers/party-lab/tests/clickRace.test.ts
 * pins these).
 */
export const CLICK_RACE = {
  /** Start line to finish line, metres (the arena draws the same length). */
  trackLength: 40,
  /** Speed one press adds, m/s. */
  pressSpeed: 1.17,
  /** Glide: speed falls by a factor e every `dragTime` seconds... */
  dragTime: 0.565,
  /** ...and by this much more every second (m/s²), so the car comes to a full stop. */
  friction: 0.5,
  /** Top speed, m/s: past about 15 presses a second, faster pressing hardly helps. */
  maxSpeed: 10,
  /**
   * A press counts when it was made (its stamp): a late one rewinds its lane up to this far
   * back (ms) and drives it forward again, so a stalled link costs nothing.
   */
  catchUpMs: 2000,
  /** Simulation steps per second (the room's fixed step). */
  hz: 60,
  /** 3-2-1 before BAŞLA, seconds. Clicks before BAŞLA never count. */
  countdown: 3,
  /** Racing time limit, seconds; the furthest car wins if nobody finished. */
  limit: 30,
  /** Results screen, seconds. */
  results: 8,
  /** At most this many clicks count in any `windowMs` (autoclicker cap). */
  maxRate: 25,
  windowMs: 1000,
  /**
   * A click is stamped on the clicker's clock (ms after BAŞLA), so clicks a stalled link
   * delivers together keep their real spacing. A stamp may lead the server's race clock
   * by this much (clock drift, step timing); later ones are pulled back to it.
   */
  aheadMs: 100,
  /** Stamps in one input packet; the client keeps the rest for its next packet. */
  maxStamps: 32,
  /** Stamps the server queues between two steps. */
  maxQueued: 64,
  /** Lanes the engine and the view support (the room seats fewer). */
  maxLanes: 6,
} as const;
