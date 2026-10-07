import { CLICK_RACE as C } from "./config.js";
import { ranksByScore } from "../../board/rules.js";

export type ClickPhase = "countdown" | "racing" | "results";
export interface ClickLane {
  /** Counted presses. */
  clicks: number;
  /** Metres along the lane (a finished car glides on past the line). */
  distance: number;
  /** m/s. */
  speed: number;
  /** When the car crossed the finish line, ms after BAŞLA; null until then. */
  finish: number | null;
  /** When the lane stopped racing (finished, left, or the race ended), ms; null until then. */
  end: number | null;
  /** Left the round: ranked behind everyone who stayed. */
  out: boolean;
  /** Counted stamps (ms after BAŞLA) of the last `windowMs`, oldest first. */
  stamps: number[];
  /** Most presses counted in one window. */
  peak: number;
  /** Presses over the cap, ignored without a penalty. */
  dropped: number;
}

const DT = 1 / C.hz;
const MS = 1000 / C.hz;
const DECAY = Math.exp(-DT / C.dragTime);
/** How far back (steps) a late press is still applied when it was made. */
const CATCH_UP = Math.round((C.catchUpMs * C.hz) / 1000);
const HISTORY = CATCH_UP + 4;

/** One lane's motion over the last `CATCH_UP` steps, so a late press can be replayed from its stamp. */
class LaneMotion {
  /** Steps the counted presses push in (≥ the oldest replayable step), ascending. */
  pushes: number[] = [];
  /** The earliest step a press counted since the last step falls in (Infinity: none). */
  from = Infinity;
  /** [distance, speed] at the end of each recent step, by step % HISTORY. */
  private readonly states = new Float64Array(HISTORY * 2);
  save(tick: number, lane: ClickLane) {
    const i = (tick % HISTORY) * 2;
    this.states[i] = lane.distance;
    this.states[i + 1] = lane.speed;
  }
  restore(tick: number, lane: ClickLane) {
    const i = (tick % HISTORY) * 2;
    lane.distance = this.states[i];
    lane.speed = this.states[i + 1];
  }
}

/**
 * The race rules without any network. After a countdown, each counted press adds
 * `pressSpeed` to the car; every step the speed falls (an exponential glide plus a constant
 * friction, so a car let go stops) and is capped at `maxSpeed`. The first car past
 * `track` metres wins; at the time limit the furthest car wins.
 *
 * A press counts at the moment it was made (its stamp, on the presser's clock from when
 * they saw BAŞLA), not when it arrived: a late one rewinds that lane to the press's step and
 * runs it forward again. Lanes never touch, so this is exact and costs at most `CATCH_UP`
 * steps of one lane. A stalled link costs nothing, a slow ping gives no handicap, and
 * batching presses gains nothing (the replay obeys friction and the top speed too).
 *
 * Autoclicker cap: at most `maxRate` stamps in any `windowMs`, counted on the stamps. Stamps
 * never go back and never lead the server's race clock (by more than `aheadMs`), so over
 * any stretch of real time a lane gets at most `maxRate` presses a second.
 */
export class ClickRaceGame {
  phase: ClickPhase = "countdown";
  /** Countdown steps left. */
  countdownTicks: number = C.countdown * C.hz;
  /** Race steps since BAŞLA. */
  ticks = 0;
  readonly lanes: ClickLane[];
  private readonly motion: LaneMotion[];
  constructor(readonly count: number, readonly track: number = C.trackLength) {
    if (!Number.isInteger(count) || count < 2 || count > C.maxLanes) throw new RangeError(`Tıklama Yarışı: ${count} lanes`);
    if (!(track > 0)) throw new RangeError(`Tıklama Yarışı: track ${track}`);
    this.lanes = Array.from({ length: count }, () => ({ clicks: 0, distance: 0, speed: 0, finish: null, end: null, out: false, stamps: [], peak: 0, dropped: 0 }));
    this.motion = this.lanes.map(() => new LaneMotion());
  }
  /** The server's race clock, ms after BAŞLA. */
  get elapsedMs() {
    return this.ticks * MS;
  }
  get limitTicks() {
    return C.limit * C.hz;
  }
  /**
   * One press made `stamp` ms after BAŞLA on the presser's clock. True when it counted; the
   * next step drives it from the step it was made in.
   */
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
    l.clicks++;
    // The step the press falls in: never before the replayable past, never after this step.
    const step = Math.min(this.ticks, Math.max(this.ticks - CATCH_UP + 1, 1, Math.ceil(at / MS - 1e-9))),
      m = this.motion[lane];
    m.pushes.push(step);
    m.from = Math.min(m.from, step);
    return true;
  }
  /** One step of one lane's motion at step `t`: its pushes, then glide, friction and the cap. */
  private drive(lane: number, t: number) {
    const l = this.lanes[lane],
      m = this.motion[lane];
    let pushes = 0;
    for (const step of m.pushes) if (step === t) pushes++;
    if (!l.out) l.speed = Math.min(C.maxSpeed, l.speed + pushes * C.pressSpeed);
    const before = l.distance;
    l.distance += l.speed * DT;
    l.speed = Math.max(0, l.speed * DECAY - C.friction * DT);
    if (l.finish === null && !l.out && before < this.track && l.distance >= this.track) {
      l.finish = (t - 1 + (this.track - before) / (l.distance - before)) * MS;
      l.end = l.finish;
    }
    m.save(t, l);
  }
  /** One fixed step; `clicks[lane]` are that lane's stamps received since the last step. */
  step(clicks: readonly (readonly number[] | undefined)[] = []) {
    if (this.phase === "results") {
      // The cars glide to a stop under the results.
      this.ticks++;
      this.lanes.forEach((_, lane) => this.drive(lane, this.ticks));
      return;
    }
    if (this.phase === "countdown") {
      if (--this.countdownTicks <= 0) {
        this.phase = "racing";
        this.lanes.forEach((l, lane) => this.motion[lane].save(0, l));
      }
    } else {
      this.ticks++;
      clicks.forEach((stamps, lane) => stamps?.forEach((stamp) => this.click(lane, stamp)));
      this.lanes.forEach((l, lane) => {
        const m = this.motion[lane];
        while (m.pushes.length && m.pushes[0] < this.ticks - CATCH_UP) m.pushes.shift();
        // A press made in an earlier step rewinds this lane to it; otherwise one plain step.
        const start = Math.max(Math.min(m.from, this.ticks), this.ticks - CATCH_UP + 1, 1);
        m.from = Infinity;
        if (start < this.ticks) m.restore(start - 1, l);
        for (let t = start; t <= this.ticks; t++) this.drive(lane, t);
      });
    }
    const racing = this.lanes.filter((l) => !l.out);
    if (racing.length <= 1 || racing.every((l) => l.finish !== null) || this.ticks >= this.limitTicks) this.end();
  }
  /** Puts a car at `metres` (tests, debug): its recent motion too, so a replay starts there. */
  setDistance(lane: number, metres: number) {
    const l = this.lanes[lane];
    l.distance = metres;
    for (let t = Math.max(0, this.ticks - HISTORY + 1); t <= this.ticks; t++) this.motion[lane].save(t, l);
  }
  /** The lane left the round for good: its car stops and it ranks last. */
  remove(lane: number) {
    const l = this.lanes[lane];
    if (!l || l.out) return;
    l.out = true;
    l.speed = 0;
    if (this.phase !== "results") l.end ??= this.elapsedMs;
  }
  private end() {
    this.phase = "results";
    for (const l of this.lanes) l.end ??= this.elapsedMs;
  }
  /** Presses counted in the last second of the race clock. */
  rate(lane: number) {
    const from = this.elapsedMs - C.windowMs;
    return this.lanes[lane].stamps.filter((stamp) => stamp > from).length;
  }
  /** Per-lane order, higher first: finishers by finish time, then distance; leavers last. */
  scores() {
    return this.lanes.map((l) => (l.out ? -1e9 + l.distance : l.finish !== null ? 1e9 - l.finish : l.distance));
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
