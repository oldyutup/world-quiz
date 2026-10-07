import { GOLD_MINER as G } from "./config.js";
import { generateField, type FieldItem } from "./field.js";
import { SHOT_SPEED, contactLength, edgeLength, pivotX, returnMs, shotMs, swingAngle, SWING_MS, type HookMotion } from "./mine.js";
import { ranksByScore } from "../../board/rules.js";

export type GoldPhase = "countdown" | "mining" | "results";
export type ItemState = "free" | "carried" | "banked" | "lost";
export interface GoldItem extends FieldItem {
  state: ItemState;
  /** The lane carrying or holding it, −1 while free. */
  by: number;
  /** When it reached the top (banked), ms after BAŞLA; −1 until then. */
  at: number;
}
export interface GoldHook extends HookMotion {
  /** Shots fired: a shot packet names the next one, so a repeated packet fires once. */
  shots: number;
  /** The item on the hook (an index), −1 for none. */
  item: number;
  /** How far (length) the outgoing hook has been checked against the items. */
  swept: number;
}
export interface GoldLane {
  score: number;
  /** Left the round: ranked behind everyone who stayed. */
  out: boolean;
  /** Items banked (indices), in order. */
  banked: number[];
  hook: GoldHook;
}
/** One shot request: the next shot number and the press moment on the shooter's clock (ms after BAŞLA). */
export interface GoldShot {
  shot: number;
  at: number;
}

const MS = 1000 / G.hz;

/**
 * The Altın Madenci rules without any network. After a countdown every lane's hook swings;
 * a shot fires it straight out at the angle of the moment it was pressed. The first free item
 * its tip touches is taken (it can never be taken by another hook) and pulled up, slower the
 * heavier it is; points count when it arrives. Hooks pass through each other and through
 * items other hooks carry. The round ends after `limit` seconds (an item still on its way up
 * does not count) or once every item is up.
 *
 * Every hook position is a function of time, so a shot can be fired in the past: a press the
 * server learns of late (at most `aimToleranceMs`) is fired from the moment and angle the
 * shooter saw. Two hooks reaching the same item in one step: the earlier contact takes it
 * (the lower lane on an exact tie), and a claim is final.
 */
export class GoldMinerGame {
  phase: GoldPhase = "countdown";
  countdownTicks: number = G.countdown * G.hz;
  /** Mining steps since BAŞLA. */
  ticks = 0;
  readonly items: GoldItem[];
  readonly lanes: GoldLane[];
  constructor(readonly count: number, random: () => number = Math.random, field?: readonly FieldItem[]) {
    if (!Number.isInteger(count) || count < 2 || count > G.maxLanes) throw new RangeError(`Altın Madenci: ${count} lanes`);
    this.items = (field ?? generateField(count, random)).map((item) => ({ ...item, state: "free", by: -1, at: -1 }));
    this.lanes = Array.from({ length: count }, (_, lane) => ({
      score: 0,
      out: false,
      banked: [],
      // Hooks start a third of a swing apart, so they never move in step.
      hook: { state: "swing", origin: -(lane * SWING_MS) / count, angle: 0, fired: 0, turn: 0, reach: 0, home: 0, shots: 0, item: -1, swept: 0 },
    }));
  }
  /** The server's mining clock, ms after BAŞLA. */
  get elapsedMs() {
    return this.ticks * MS;
  }
  get limitTicks() {
    return G.limit * G.hz;
  }
  pivot(lane: number) {
    return pivotX(lane, this.count);
  }
  /**
   * A shot by `lane`: `shot` must be its next shot number and its hook must be swinging. It is
   * fired at `at` (its press time), kept from the hook's return on, at most `aimToleranceMs`
   * ago and at most `aheadMs` ahead of now. True when it fired.
   */
  shoot(lane: number, request: GoldShot): boolean {
    const l = this.lanes[lane],
      h = l?.hook;
    if (this.phase !== "mining" || !l || l.out || h.state !== "swing" || request.shot !== h.shots + 1 || !Number.isFinite(request.at)) return false;
    const now = this.elapsedMs,
      since = h.shots ? h.home : 0;
    const at = Math.min(now + G.aheadMs, Math.max(request.at, since, now - G.aimToleranceMs));
    h.angle = swingAngle(at, h.origin);
    h.fired = at;
    h.state = "out";
    h.shots++;
    h.swept = G.restLength;
    h.item = -1;
    return true;
  }
  /** One fixed step; `shots[lane]` is that lane's shot request received since the last step. */
  step(shots: readonly (GoldShot | undefined)[] = []) {
    if (this.phase === "results") return;
    if (this.phase === "countdown") {
      if (--this.countdownTicks <= 0) this.phase = "mining";
    } else {
      this.ticks++;
      const now = this.elapsedMs;
      this.bank(now);
      shots.forEach((request, lane) => request && this.shoot(lane, request));
      this.sweep(now);
      this.bank(now);
      if (this.items.every((item) => item.state === "banked" || item.state === "lost") || this.ticks >= this.limitTicks) this.end();
    }
    // The last player left wins at once.
    if (this.lanes.filter((l) => !l.out).length <= 1) this.end();
  }
  /** Outgoing hooks up to `now`: contacts in time order (claims are final), then the edges. */
  private sweep(now: number) {
    const going = this.lanes.flatMap((l, lane) => (l.hook.state === "out" && !l.out ? [lane] : []));
    if (!going.length) return;
    const reach = (lane: number) => {
      const h = this.lanes[lane].hook;
      return Math.min(edgeLength(this.pivot(lane), h.angle), lengthAt(h, now));
    };
    for (;;) {
      let best: { lane: number; item: number; length: number; time: number } | null = null;
      for (const lane of going) {
        const h = this.lanes[lane].hook;
        if (h.state !== "out") continue;
        const to = reach(lane);
        this.items.forEach((item, index) => {
          if (item.state !== "free") return;
          const length = contactLength(this.pivot(lane), h.angle, item, h.swept, to);
          if (length === null) return;
          const time = h.fired + shotMs(length);
          if (!best || time < best.time - 1e-9 || (Math.abs(time - best.time) <= 1e-9 && lane < best.lane)) best = { lane, item: index, length, time };
        });
      }
      if (!best) break;
      const { lane, item, length, time } = best as { lane: number; item: number; length: number; time: number },
        h = this.lanes[lane].hook,
        it = this.items[item];
      it.state = "carried";
      it.by = lane;
      h.state = "back";
      h.item = item;
      h.turn = time;
      h.reach = length;
      h.home = time + returnMs(length, it.kind);
    }
    for (const lane of going) {
      const h = this.lanes[lane].hook;
      if (h.state !== "out") continue;
      const edge = edgeLength(this.pivot(lane), h.angle);
      h.swept = Math.min(edge, lengthAt(h, now));
      if (h.swept >= edge) {
        h.state = "back";
        h.item = -1;
        h.turn = h.fired + shotMs(edge);
        h.reach = edge;
        h.home = h.turn + returnMs(edge, null);
      }
    }
  }
  /** Hooks back at the top by `now`: their item scores, and the swing goes on from the shot's angle. */
  private bank(now: number) {
    for (const l of this.lanes) {
      const h = l.hook;
      if (h.state !== "back" || h.home > now) continue;
      const item = this.items[h.item];
      if (item && item.state === "carried") {
        item.state = "banked";
        item.at = h.home;
        l.score += item.value;
        l.banked.push(h.item);
      }
      h.origin += h.home - h.fired;
      h.state = "swing";
      h.item = -1;
    }
  }
  /** The lane left the round for good: its hook is gone, and so is the item on it. */
  remove(lane: number) {
    const l = this.lanes[lane];
    if (!l || l.out) return;
    l.out = true;
    const h = l.hook,
      item = this.items[h.item];
    if (item && item.state === "carried") item.state = "lost";
    h.state = "swing";
    h.item = -1;
  }
  private end() {
    this.phase = "results";
  }
  /** Per-lane order, higher first: points; leavers last. */
  scores() {
    return this.lanes.map((l) => (l.out ? -1e9 + l.score : l.score));
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

/** The outgoing tip's length at `t` (no edge, no contact). */
const lengthAt = (h: HookMotion, t: number) => G.restLength + (SHOT_SPEED * Math.max(0, t - h.fired)) / 1000;
