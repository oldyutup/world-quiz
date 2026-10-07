import { GOLD_KINDS, GOLD_MINER as G } from "./config.js";
import type { GoldMinerGame, GoldPhase } from "./game.js";

const HOOK_STATES = ["swing", "out", "back"] as const;
const ITEM_STATES = ["free", "carried", "banked", "lost"] as const;
/**
 * Altın Madenci snapshot section. Per-lane arrays are by lane (`seats[lane]` is its slot),
 * per-item arrays by item. Times are ms after BAŞLA; hooks are placed from their numbers
 * with `hookPose` (mine.ts), so a client draws them at any moment between snapshots.
 */
export interface GoldWire {
  seats: number[];
  phase: GoldPhase;
  /** Countdown seconds left (0 once mining). */
  countdown: number;
  /** Mining clock, ms after BAŞLA. */
  elapsed: number;
  /** Mining time, seconds. */
  limit: number;
  /** Items: kind (index into GOLD_KINDS), centre (m), radius (m). */
  kind: number[];
  x: number[];
  y: number[];
  r: number[];
  /** 0 free, 1 on a hook, 2 banked, 3 lost (its hook's player left). */
  state: number[];
  /** The lane carrying or holding it, −1 free. */
  by: number[];
  /** Banked at (ms), −1 not yet. */
  at: number[];
  /** Points; a sack's stay hidden (−1) until it is up. */
  value: number[];
  /** Hooks: 0 swinging, 1 going out, 2 coming back; then their motion (mine.ts HookMotion). */
  hook: number[];
  origin: number[];
  angle: number[];
  fired: number[];
  turn: number[];
  reach: number[];
  home: number[];
  /** Shots fired, the item on the hook (−1 none). */
  shots: number[];
  item: number[];
  score: number[];
  out: boolean[];
  /** Places (0 best, ties share one), final at results. */
  places: number[];
}

const cm = (metres: number) => Math.round(metres * 1000) / 1000;
const ms = (time: number) => Math.round(time * 1000) / 1000;
export function goldSection(game: GoldMinerGame, seats: readonly number[]): GoldWire {
  const hooks = game.lanes.map((l) => l.hook);
  return {
    seats: [...seats],
    phase: game.phase,
    countdown: game.phase === "countdown" ? game.countdownTicks / G.hz : 0,
    elapsed: ms(game.elapsedMs),
    limit: G.limit,
    kind: game.items.map((item) => GOLD_KINDS.indexOf(item.kind)),
    x: game.items.map((item) => cm(item.x)),
    y: game.items.map((item) => cm(item.y)),
    r: game.items.map((item) => item.r),
    state: game.items.map((item) => ITEM_STATES.indexOf(item.state)),
    by: game.items.map((item) => item.by),
    at: game.items.map((item) => ms(item.at)),
    value: game.items.map((item) => (item.kind === "sack" && item.state !== "banked" ? -1 : item.value)),
    hook: hooks.map((h) => HOOK_STATES.indexOf(h.state)),
    origin: hooks.map((h) => ms(h.origin)),
    angle: hooks.map((h) => Math.round(h.angle * 1e6) / 1e6),
    fired: hooks.map((h) => ms(h.fired)),
    turn: hooks.map((h) => ms(h.turn)),
    reach: hooks.map((h) => cm(h.reach)),
    home: hooks.map((h) => ms(h.home)),
    shots: hooks.map((h) => h.shots),
    item: hooks.map((h) => h.item),
    score: game.lanes.map((l) => l.score),
    out: game.lanes.map((l) => l.out),
    places: game.places(),
  };
}
export const hookState = (wire: GoldWire, lane: number) => HOOK_STATES[wire.hook[lane]] ?? "swing";
export const itemState = (wire: GoldWire, index: number) => ITEM_STATES[wire.state[index]] ?? "free";
export const itemKind = (wire: GoldWire, index: number) => GOLD_KINDS[wire.kind[index]] ?? "small";

const numbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n));
const indices = (value: unknown, length: number, below: number) => numbers(value, length) && value.every((n) => Number.isInteger(n) && n >= -1 && n < below);
/** A received section is well formed (the client never trusts a snapshot's shape). */
export function validGoldWire(value: unknown): value is GoldWire {
  if (!value || typeof value !== "object") return false;
  const w = value as GoldWire,
    lanes = Array.isArray(w.seats) ? w.seats.length : 0,
    items = Array.isArray(w.kind) ? w.kind.length : -1;
  return (
    lanes >= 2 &&
    lanes <= G.maxLanes &&
    items >= 0 &&
    items <= 64 &&
    w.seats.every((slot) => Number.isInteger(slot) && slot >= 0) &&
    (w.phase === "countdown" || w.phase === "mining" || w.phase === "results") &&
    [w.countdown, w.elapsed, w.limit].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    w.kind.every((k) => Number.isInteger(k) && k >= 0 && k < GOLD_KINDS.length) &&
    [w.x, w.y, w.r, w.at, w.value].every((a) => numbers(a, items)) &&
    numbers(w.state, items) &&
    w.state.every((s) => Number.isInteger(s) && s >= 0 && s < ITEM_STATES.length) &&
    indices(w.by, items, lanes) &&
    numbers(w.hook, lanes) &&
    w.hook.every((s) => Number.isInteger(s) && s >= 0 && s < HOOK_STATES.length) &&
    [w.origin, w.angle, w.fired, w.turn, w.reach, w.home, w.shots, w.score, w.places].every((a) => numbers(a, lanes)) &&
    indices(w.item, lanes, items) &&
    Array.isArray(w.out) &&
    w.out.length === lanes &&
    w.out.every((o) => typeof o === "boolean")
  );
}
