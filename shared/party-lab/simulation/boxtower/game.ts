import { BOX_TOWER as T } from "./config.js";
import { SPAN, columnAt, travelMs, type Slide } from "./motion.js";
import { ranksByScore } from "../../board/rules.js";

export type TowerPhase = "countdown" | "stacking" | "results";
/** A dropped box: its column, the press moment and the landing, ms after BAŞLA. */
export interface TowerDrop {
  column: number;
  at: number;
  land: number;
}
export interface TowerLane {
  /** Boxes standing in each column. */
  heights: number[];
  /** The tallest column's height, and when it first got that tall (ms; 0 while nothing stands). */
  best: number;
  reached: number;
  /** Left the round: ranked behind everyone who stayed. */
  out: boolean;
  /** Boxes dropped: a drop packet names the next one, so a repeated packet drops once. */
  drops: number;
  /** Boxes that landed (every drop lands, in order, unless the round ends first). */
  placed: number;
  /** The box in the air, null when none. */
  falling: TowerDrop | null;
  /** The last box that landed, and whether it made the tallest column taller. */
  last: TowerDrop | null;
  good: boolean;
  /** The sliding box; while one falls (or the next one waits) this is already the next slide. */
  slide: Slide;
}
/** One drop request: the next drop number and the press moment on the player's clock (ms after BAŞLA). */
export interface TowerPress {
  drop: number;
  at: number;
}

const MS = 1000 / T.hz;
/** Below any player still in the round. */
const LEFT = -1e12;

/**
 * The Kutu Kulesi rules without any network. After a countdown every lane's box slides (from a
 * random column, in a random direction). A press drops it into the column under its middle at
 * the press moment; it lands `fallMs` later on top of that column, and the next box appears
 * `respawnMs` after that, again from a random column and way. The slide speeds up with the
 * lane's tallest column. The first column `goal` high ends the round at once; otherwise the
 * round ends after `limit` (a box pressed before it still lands). Lanes never touch each other.
 *
 * The box's place is a function of time, so a press the server learns of late (at most
 * `aimToleranceMs`) drops the box where the player saw it. A press while the box falls or
 * before the next one appeared does not count.
 */
export class BoxTowerGame {
  phase: TowerPhase = "countdown";
  countdownTicks: number = T.countdown * T.hz;
  /** Stacking steps since BAŞLA. */
  ticks = 0;
  readonly lanes: TowerLane[];
  constructor(readonly count: number, private readonly random: () => number = Math.random) {
    if (!Number.isInteger(count) || count < 2 || count > T.maxLanes) throw new RangeError(`Kutu Kulesi: ${count} lanes`);
    this.lanes = Array.from({ length: count }, () => ({
      heights: Array.from({ length: T.columns }, () => 0),
      best: 0,
      reached: 0,
      out: false,
      drops: 0,
      placed: 0,
      falling: null,
      last: null,
      good: false,
      slide: this.nextSlide(0, 0),
    }));
  }
  /** The server's stacking clock, ms after BAŞLA. */
  get elapsedMs() {
    return this.ticks * MS;
  }
  get limitTicks() {
    return T.limit * T.hz;
  }
  get limitMs() {
    return T.limit * 1000;
  }
  /** A new box over a random column, going a random way (inward from an end), at the speed of `best`. */
  private nextSlide(spawn: number, best: number): Slide {
    const from = Math.min(SPAN, Math.floor(this.random() * T.columns)),
      way = this.random() < 0.5 ? -1 : 1;
    return { spawn, from, dir: from === 0 ? 1 : from === SPAN ? -1 : way, travel: travelMs(best) };
  }
  /**
   * A drop by `lane`: `drop` must be its next drop number, nothing of its may be in the air, and
   * the press moment (`at`, kept at most `aimToleranceMs` ago and `aheadMs` ahead of now) must
   * find its box sliding, before the time is up. True when the box dropped.
   */
  drop(lane: number, request: TowerPress): boolean {
    const l = this.lanes[lane];
    if (this.phase !== "stacking" || !l || l.out || l.falling || request.drop !== l.drops + 1 || !Number.isFinite(request.at)) return false;
    const now = this.elapsedMs,
      at = Math.min(now + T.aheadMs, Math.max(request.at, now - T.aimToleranceMs));
    if (at < l.slide.spawn || at >= this.limitMs) return false;
    const column = columnAt(l.slide, at),
      land = at + T.fallMs;
    l.falling = { column, at, land };
    l.drops++;
    // The next box's speed: the tallest column once this one is down (known now).
    l.slide = this.nextSlide(land + T.respawnMs, Math.max(l.best, l.heights[column] + 1));
    return true;
  }
  /** One fixed step; `presses[lane]` is that lane's drop request received since the last step. */
  step(presses: readonly (TowerPress | undefined)[] = []) {
    if (this.phase === "results") return;
    if (this.phase === "countdown") {
      if (--this.countdownTicks <= 0) this.phase = "stacking";
    } else {
      this.ticks++;
      const now = this.elapsedMs;
      this.land(now);
      if (this.phase !== "stacking") return;
      presses.forEach((press, lane) => press && this.drop(lane, press));
      // Time: presses made before it may still arrive for aimToleranceMs, and boxes in the air land.
      if (now >= this.limitMs + T.aimToleranceMs && this.lanes.every((l) => l.out || !l.falling)) this.end();
    }
    // The last player left wins at once.
    if (this.lanes.filter((l) => !l.out).length <= 1) this.end();
  }
  /** Boxes down by `now`, in landing order; a column reaching `goal` ends the round (boxes landing at that same moment count too). */
  private land(now: number) {
    let cutoff = now,
      won = false;
    for (;;) {
      let next = -1;
      this.lanes.forEach((l, lane) => {
        if (!l.out && l.falling && l.falling.land <= cutoff && (next < 0 || l.falling.land < this.lanes[next].falling!.land)) next = lane;
      });
      if (next < 0) break;
      const l = this.lanes[next],
        f = l.falling!;
      l.falling = null;
      l.last = f;
      l.placed++;
      const height = ++l.heights[f.column];
      l.good = height > l.best;
      if (l.good) {
        l.best = height;
        l.reached = f.land;
      }
      if (l.best >= T.goal) {
        won = true;
        cutoff = f.land;
      }
    }
    if (won) this.end();
  }
  /** The lane left the round for good: ranked last, its box in the air gone. */
  remove(lane: number) {
    const l = this.lanes[lane];
    if (!l || l.out) return;
    l.out = true;
    l.falling = null;
  }
  private end() {
    this.phase = "results";
    // Boxes still in the air never land.
    for (const l of this.lanes) l.falling = null;
  }
  /** The time on the clock when the lane's tallest column first reached `goal` (−1 not yet). */
  finished(lane: number) {
    const l = this.lanes[lane];
    return l && l.best >= T.goal ? l.reached : -1;
  }
  /** Per-lane order, higher first: the tallest column, then who reached it first; leavers last. */
  scores() {
    return this.lanes.map((l) => (l.out ? LEFT + l.best : l.best * 1e7 - l.reached));
  }
  /** Per-lane places: 0 best, equal results share one. */
  places() {
    return ranksByScore(this.scores());
  }
  /** The winning lane at results, −1 before or on a tie for first. */
  winner() {
    if (this.phase !== "results") return -1;
    const first = this.places().flatMap((place, lane) => (place === 0 ? [lane] : []));
    return first.length === 1 ? first[0] : -1;
  }
}
