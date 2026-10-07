import { CLICK_RACE as C } from "./config.js";
import type { ClickPhase, ClickRaceGame } from "./game.js";

/** Tıklama Yarışı snapshot section; every array is per lane (`seats[lane]` is its slot). */
export interface ClickWire {
  seats: number[];
  phase: ClickPhase;
  /** Countdown seconds left (0 once racing). */
  countdown: number;
  /** Race clock, ms after BAŞLA. */
  elapsed: number;
  /** Metres to the finish. */
  track: number;
  /** Time limit, seconds. */
  limit: number;
  /** Counted presses. */
  clicks: number[];
  /** Metres along the lane (cm precision; a finished car glides on past the line). */
  distance: number[];
  /** m/s (cm/s precision). */
  speed: number[];
  /** Presses counted in the last second. */
  rate: number[];
  /** Finish time in ms after BAŞLA (when the car crossed the line), −1 not finished. */
  finish: number[];
  /** Time raced in ms (to the finish, the end of the race, or leaving). */
  time: number[];
  /** Most presses counted in one second. */
  peak: number[];
  out: boolean[];
  /** Places (0 best, ties share one), final at results. */
  places: number[];
}

const cm = (metres: number) => Math.round(metres * 100) / 100;
export function clickSection(game: ClickRaceGame, seats: readonly number[]): ClickWire {
  return {
    seats: [...seats],
    phase: game.phase,
    countdown: game.phase === "countdown" ? game.countdownTicks / C.hz : 0,
    elapsed: Math.round(game.elapsedMs),
    track: game.track,
    limit: C.limit,
    clicks: game.lanes.map((l) => l.clicks),
    distance: game.lanes.map((l) => cm(l.distance)),
    speed: game.lanes.map((l) => cm(l.speed)),
    rate: game.lanes.map((_, lane) => game.rate(lane)),
    finish: game.lanes.map((l) => (l.finish === null ? -1 : Math.round(l.finish))),
    time: game.lanes.map((l) => Math.round(l.end ?? game.elapsedMs)),
    peak: game.lanes.map((l) => l.peak),
    out: game.lanes.map((l) => l.out),
    places: game.places(),
  };
}

const count = (value: unknown, lanes: number): value is number[] =>
  Array.isArray(value) && value.length === lanes && value.every((n) => typeof n === "number" && Number.isFinite(n));
/** A received section is well formed (the client never trusts a snapshot's shape). */
export function validClickWire(value: unknown): value is ClickWire {
  if (!value || typeof value !== "object") return false;
  const w = value as ClickWire,
    lanes = Array.isArray(w.seats) ? w.seats.length : 0;
  return (
    lanes >= 2 &&
    lanes <= C.maxLanes &&
    w.seats.every((slot) => Number.isInteger(slot) && slot >= 0) &&
    (w.phase === "countdown" || w.phase === "racing" || w.phase === "results") &&
    [w.countdown, w.elapsed, w.track, w.limit].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    w.track >= 1 &&
    [w.clicks, w.distance, w.speed, w.rate, w.finish, w.time, w.peak, w.places].every((a) => count(a, lanes)) &&
    Array.isArray(w.out) &&
    w.out.length === lanes &&
    w.out.every((o) => typeof o === "boolean")
  );
}
