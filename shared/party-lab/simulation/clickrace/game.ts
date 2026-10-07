import { CLICK_RACE as C } from "./config.js";
import { ranksByScore } from "../../board/rules.js";

export type ClickPhase = "countdown" | "racing" | "results";
export interface ClickLane {
  /** Counted clicks: the car's position in steps. */
  clicks: number;
  /** Race steps at the finishing click, null until then. */
  finish: number | null;
  /** Race steps when the lane stopped racing (finished, left, or the race ended). */
  end: number | null;
  /** Left the round: ranked behind everyone who stayed. */
  out: boolean;
  /** Counted stamps (ms after BAŞLA) of the last `windowMs`, oldest first. */
  stamps: number[];
  /** Most clicks counted in one window. */
  peak: number;
  /** Clicks over the cap, ignored without a penalty. */
  dropped: number;
}

/**
 * The race rules without any network: a countdown, then each lane advances one step per
 * counted click until it reaches `track` or the time limit ends the race.
 *
 * Autoclicker cap: at most `maxRate` stamps in any `windowMs`. The window runs on the
 * clicker's own stamps, not on arrival, so a burst a stalled link delivers late is counted
 * as the clicks were made. A forged timeline gains nothing: stamps never go back and never
 * lead the server's race clock (by more than `aheadMs`), so over any stretch of real time
 * a lane gets at most `maxRate` clicks a second.
 */
export class ClickRaceGame {
  phase: ClickPhase = "countdown";
  /** Countdown steps left. */
  countdownTicks: number = C.countdown * C.hz;
  /** Race steps since BAŞLA. */
  ticks = 0;
  readonly lanes: ClickLane[];
  constructor(readonly count: number, readonly track: number = C.trackClicks) {
    if (!Number.isInteger(count) || count < 2 || count > C.maxLanes) throw new RangeError(`Tıklama Yarışı: ${count} lanes`);
    if (!Number.isInteger(track) || track < 1) throw new RangeError(`Tıklama Yarışı: track ${track}`);
    this.lanes = Array.from({ length: count }, () => ({ clicks: 0, finish: null, end: null, out: false, stamps: [], peak: 0, dropped: 0 }));
  }
  /** The server's race clock, ms after BAŞLA. */
  get elapsedMs() {
    return (this.ticks * 1000) / C.hz;
  }
  get limitTicks() {
    return C.limit * C.hz;
  }
  /** One click made `stamp` ms after BAŞLA on the clicker's clock. True when it counted. */
  click(lane: number, stamp: number): boolean {
    const l = this.lanes[lane];
    if (this.phase !== "racing" || !l || l.out || l.finish !== null || !Number.isFinite(stamp) || stamp < 0) return false;
    const last = l.stamps.length ? l.stamps[l.stamps.length - 1] : 0;
    const at = Math.min(Math.max(stamp, last), this.elapsedMs + C.aheadMs);
    while (l.stamps.length && l.stamps[0] <= at - C.windowMs) l.stamps.shift();
    if (l.stamps.length >= C.maxRate) {
      l.dropped++;
      return false;
    }
    l.stamps.push(at);
    l.peak = Math.max(l.peak, l.stamps.length);
    if (++l.clicks >= this.track) l.finish = l.end = this.ticks;
    return true;
  }
  /** One fixed step; `clicks[lane]` are that lane's stamps received since the last step. */
  step(clicks: readonly (readonly number[] | undefined)[] = []) {
    if (this.phase === "results") return;
    if (this.phase === "countdown") {
      if (--this.countdownTicks <= 0) this.phase = "racing";
    } else {
      this.ticks++;
      clicks.forEach((stamps, lane) => stamps?.forEach((stamp) => this.click(lane, stamp)));
    }
    const racing = this.lanes.filter((l) => !l.out);
    if (racing.length <= 1 || racing.every((l) => l.finish !== null) || this.ticks >= this.limitTicks) this.end();
  }
  /** The lane left the round for good: its car stops and it ranks last. */
  remove(lane: number) {
    const l = this.lanes[lane];
    if (!l || l.out) return;
    l.out = true;
    if (this.phase !== "results") l.end ??= this.ticks;
  }
  private end() {
    this.phase = "results";
    for (const l of this.lanes) l.end ??= this.ticks;
  }
  /** Clicks counted in the last second of the race clock. */
  rate(lane: number) {
    const from = this.elapsedMs - C.windowMs;
    return this.lanes[lane].stamps.filter((stamp) => stamp > from).length;
  }
  /** Per-lane order, higher first: finishers by finishing step, then distance; leavers last. */
  scores() {
    return this.lanes.map((l) => (l.out ? -1e6 + l.clicks : l.finish !== null ? 1e6 - l.finish : l.clicks));
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
