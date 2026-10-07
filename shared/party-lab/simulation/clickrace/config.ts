/**
 * Tıklama Yarışı: every counted click moves a player's car one step down their lane.
 * The server counts; clients only show what it counted.
 */
export const CLICK_RACE = {
  /**
   * Clicks from the start line to the finish: the one track-length knob. 150 puts an
   * average player (8–10 clicks/s) at the finish in 15–19 s.
   */
  trackClicks: 150,
  /** Simulation steps per second (the room's fixed step). */
  hz: 60,
  /** 3-2-1 before BAŞLA, seconds. Clicks before BAŞLA never count. */
  countdown: 3,
  /** Racing time limit, seconds; the furthest car wins if nobody finished. */
  limit: 45,
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
