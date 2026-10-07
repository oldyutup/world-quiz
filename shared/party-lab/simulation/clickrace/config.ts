/**
 * Tıklama Yarışı: every counted press pushes a player's car; it glides and slows down by
 * itself. The server moves the cars; clients only show where the server put them.
 *
 * The driving knobs are the four below `trackLength`. With them an average player (about
 * 9 presses a second) finishes in about 7.5 s, a fast one (about 12) in about 5.6 s, a slow
 * one (about 6) in about 12 s, and a car let go at cruising speed stops within about
 * half a second (servers/party-lab/tests/clickRace.test.ts pins these).
 */
export const CLICK_RACE = {
  /** Start line to finish line, metres (the arena draws the same length). */
  trackLength: 40,
  /** Speed one press adds, m/s. */
  pressSpeed: 2.6,
  /** Glide: speed falls by a factor e every `dragTime` seconds... */
  dragTime: 0.25,
  /** ...and by this much more every second (m/s²), so the car comes to a full stop. */
  friction: 2.2,
  /** Top speed, m/s: past about 15 presses a second, faster pressing hardly helps. */
  maxSpeed: 10,
  /**
   * A press is applied as made at its stamp: one the link delivered late adds the way its
   * push would already have covered plus the push it has left, so a stalled link costs
   * nothing (counted at most this far back, ms).
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
