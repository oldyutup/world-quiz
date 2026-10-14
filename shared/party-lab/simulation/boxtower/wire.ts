import { BOX_TOWER as T } from "./config.js";
import type { BoxTowerGame, TowerPhase } from "./game.js";
import type { Slide } from "./motion.js";

/**
 * Kutu Kulesi snapshot section. Per-lane arrays are by lane (`seats[lane]` is its slot);
 * `heights` holds `columns` entries per lane, lane after lane. Times are ms after BAŞLA and
 * exact (the slide is a function of time: a client draws it at any moment between snapshots,
 * the same as the server drops it).
 */
export interface TowerWire {
  seats: number[];
  phase: TowerPhase;
  /** Countdown seconds left (0 once stacking). */
  countdown: number;
  /** Stacking clock, ms after BAŞLA (frozen at the end). */
  elapsed: number;
  /** Stacking time, seconds. */
  limit: number;
  heights: number[];
  best: number[];
  /** When the tallest column first got that tall (ms; 0 while nothing stands). */
  reached: number[];
  drops: number[];
  placed: number[];
  /** The box in the air: column (−1 none), press moment and landing. */
  fallColumn: number[];
  fallAt: number[];
  fallLand: number[];
  /** The last box that landed: column (−1 none), landing, and whether it made the tallest column taller. */
  lastColumn: number[];
  lastLand: number[];
  lastGood: boolean[];
  /** The sliding box (the next one while a box falls or waits). */
  spawn: number[];
  from: number[];
  dir: number[];
  travel: number[];
  out: boolean[];
  /** Places (0 best, ties share one), final at results. */
  places: number[];
}

export function towerSection(game: BoxTowerGame, seats: readonly number[]): TowerWire {
  const lanes = game.lanes;
  return {
    seats: [...seats],
    phase: game.phase,
    countdown: game.phase === "countdown" ? game.countdownTicks / T.hz : 0,
    elapsed: game.elapsedMs,
    limit: T.limit,
    heights: lanes.flatMap((l) => l.heights),
    best: lanes.map((l) => l.best),
    reached: lanes.map((l) => l.reached),
    drops: lanes.map((l) => l.drops),
    placed: lanes.map((l) => l.placed),
    fallColumn: lanes.map((l) => l.falling?.column ?? -1),
    fallAt: lanes.map((l) => l.falling?.at ?? 0),
    fallLand: lanes.map((l) => l.falling?.land ?? 0),
    lastColumn: lanes.map((l) => l.last?.column ?? -1),
    lastLand: lanes.map((l) => l.last?.land ?? 0),
    lastGood: lanes.map((l) => l.good),
    spawn: lanes.map((l) => l.slide.spawn),
    from: lanes.map((l) => l.slide.from),
    dir: lanes.map((l) => l.slide.dir),
    travel: lanes.map((l) => l.slide.travel),
    out: lanes.map((l) => l.out),
    places: game.places(),
  };
}
/** Lane `lane`'s column heights. */
export const laneHeights = (wire: TowerWire, lane: number) => wire.heights.slice(lane * T.columns, (lane + 1) * T.columns);
/** Lane `lane`'s slide. */
export const wireSlide = (wire: TowerWire, lane: number): Slide => ({ spawn: wire.spawn[lane], from: wire.from[lane], dir: wire.dir[lane], travel: wire.travel[lane] });

const numbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n));
const integers = (value: unknown, length: number, min: number, max: number) => numbers(value, length) && value.every((n) => Number.isInteger(n) && n >= min && n <= max);
const booleans = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every((b) => typeof b === "boolean");
/** A received section is well formed (the client never trusts a snapshot's shape). */
export function validTowerWire(value: unknown): value is TowerWire {
  if (!value || typeof value !== "object") return false;
  const w = value as TowerWire,
    lanes = Array.isArray(w.seats) ? w.seats.length : 0;
  return (
    lanes >= 2 &&
    lanes <= T.maxLanes &&
    w.seats.every((slot) => Number.isInteger(slot) && slot >= 0) &&
    (w.phase === "countdown" || w.phase === "stacking" || w.phase === "results") &&
    [w.countdown, w.elapsed, w.limit].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    integers(w.heights, lanes * T.columns, 0, 10_000) &&
    integers(w.best, lanes, 0, 10_000) &&
    integers(w.drops, lanes, 0, 1e6) &&
    integers(w.placed, lanes, 0, 1e6) &&
    integers(w.fallColumn, lanes, -1, T.columns - 1) &&
    integers(w.lastColumn, lanes, -1, T.columns - 1) &&
    integers(w.from, lanes, 0, T.columns - 1) &&
    numbers(w.dir, lanes) &&
    w.dir.every((d) => d === 1 || d === -1) &&
    numbers(w.travel, lanes) &&
    w.travel.every((t) => t > 0) &&
    [w.reached, w.fallAt, w.fallLand, w.lastLand, w.spawn, w.places].every((a) => numbers(a, lanes)) &&
    booleans(w.lastGood, lanes) &&
    booleans(w.out, lanes)
  );
}
