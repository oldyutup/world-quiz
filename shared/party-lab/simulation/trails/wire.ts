import { LIGHT_TRAILS as L } from "./config.js";
import { LEFT, type TrailGame, type TrailPhase } from "./game.js";

/** Bytes per trail point on the wire: x cm (int16), z cm (int16), step laid (uint16; top bit: the piece after it is wiped). */
export const POINT_BYTES = 6;
/** Points a lane can have at most (a life's worth, one more for the death, a margin). */
export const MAX_POINTS = Math.ceil((L.trailLife * L.hz) / L.trailEvery) + 8;
const CUT = 0x8000;
/**
 * Işık İzi snapshot section. Per-lane arrays are by lane (`seats[lane]` is its slot). Heads are
 * exact (the prediction runs on from them); trail points are on the centimetre, exactly the
 * points the server tests.
 */
export interface TrailWire {
  seats: number[];
  phase: TrailPhase;
  /** Countdown seconds left (0 once playing). */
  countdown: number;
  /** Play steps since BAŞLA (the fixed step is LIGHT_TRAILS.hz a second); the train runs on it. */
  step: number;
  /** Play time, seconds. */
  limit: number;
  x: number[];
  z: number[];
  /** Headings, radians from +x towards +z. */
  a: number[];
  alive: boolean[];
  out: boolean[];
  /** Play step each died at (−1 running), why (game.ts NONE…LEFT), and whose trail or head (lane, −1). */
  died: number[];
  cause: number[];
  by: number[];
  /** Steps the server ran on the same input packet before this snapshot (prediction). */
  held: number[];
  /** Places (0 best, ties share one), final at results. */
  places: number[];
  /** Trail points per lane, and the points themselves, lanes one after another (POINT_BYTES each). */
  counts: number[];
  points: Uint8Array;
  /** Players the train has killed this round. */
  trainKills: number;
}

export function trailSection(game: TrailGame, seats: readonly number[], held: readonly number[] = []): TrailWire {
  const counts = game.lines.map((line) => line.x.length),
    points = new Uint8Array(counts.reduce((n, c) => n + c, 0) * POINT_BYTES),
    view = new DataView(points.buffer);
  let o = 0;
  for (const line of game.lines)
    for (let i = 0; i < line.x.length; i++, o += POINT_BYTES) {
      view.setInt16(o, Math.round(line.x[i] * 100), true);
      view.setInt16(o + 2, Math.round(line.z[i] * 100), true);
      view.setUint16(o + 4, (line.t[i] & 0x7fff) | (line.cut[i] ? CUT : 0), true);
    }
  const p = game.players;
  return {
    seats: [...seats],
    phase: game.phase,
    countdown: game.phase === "countdown" ? game.countdownTicks / L.hz : 0,
    step: game.ticks,
    limit: L.limit,
    x: p.map((q) => q.x),
    z: p.map((q) => q.z),
    a: p.map((q) => q.a),
    alive: p.map((q) => q.alive),
    out: p.map((q) => q.out),
    died: p.map((q) => q.died),
    cause: p.map((q) => q.cause),
    by: p.map((q) => q.by),
    held: p.map((_, lane) => held[lane] ?? 0),
    places: game.places(),
    counts,
    points,
    trainKills: game.trainKills,
  };
}

/** The trail lines of a section, decoded (centimetres back to metres). */
export function wireLines(wire: TrailWire) {
  const view = new DataView(wire.points.buffer, wire.points.byteOffset, wire.points.byteLength);
  let o = 0;
  return wire.counts.map((count) => {
    const line = { x: [] as number[], z: [] as number[], t: [] as number[], cut: [] as boolean[] };
    for (let i = 0; i < count; i++, o += POINT_BYTES) {
      line.x.push(view.getInt16(o, true) / 100);
      line.z.push(view.getInt16(o + 2, true) / 100);
      const t = view.getUint16(o + 4, true);
      line.t.push(t & 0x7fff);
      line.cut.push((t & CUT) !== 0);
    }
    return line;
  });
}
/** Restores the heads and the trails from a section (the client's prediction world). */
export function restoreTrails(game: TrailGame, wire: TrailWire) {
  const lines = wireLines(wire);
  game.players.forEach((p, lane) => {
    p.x = wire.x[lane];
    p.z = wire.z[lane];
    p.a = wire.a[lane];
    p.alive = wire.alive[lane];
    p.out = wire.out[lane];
    p.died = wire.died[lane];
    p.cause = wire.cause[lane];
    p.by = wire.by[lane];
    Object.assign(game.lines[lane], lines[lane]);
  });
  game.ticks = wire.step;
  game.phase = wire.phase;
  game.trainKills = wire.trainKills;
}
/** Left the round while running (ranked last). */
export const leftRunning = (wire: TrailWire, lane: number) => wire.cause[lane] === LEFT;

const numbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n));
const flags = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every((b) => typeof b === "boolean");
/** A received section is well formed (the client never trusts a snapshot's shape). */
export function validTrailWire(value: unknown): value is TrailWire {
  if (!value || typeof value !== "object") return false;
  const w = value as TrailWire,
    lanes = Array.isArray(w.seats) ? w.seats.length : 0;
  if (lanes < 2 || lanes > L.maxLanes || !w.seats.every((slot) => Number.isInteger(slot) && slot >= 0)) return false;
  if (!(w.phase === "countdown" || w.phase === "playing" || w.phase === "results")) return false;
  if (![w.countdown, w.step, w.limit, w.trainKills].every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  if (![w.x, w.z, w.a, w.died, w.cause, w.by, w.held, w.places, w.counts].every((a) => numbers(a, lanes))) return false;
  if (!w.counts.every((c) => Number.isInteger(c) && c >= 0 && c <= MAX_POINTS)) return false;
  if (!(w.points instanceof Uint8Array) || w.points.byteLength !== w.counts.reduce((n, c) => n + c, 0) * POINT_BYTES) return false;
  if (!w.by.every((b) => Number.isInteger(b) && b >= -1 && b < lanes)) return false;
  return flags(w.alive, lanes) && flags(w.out, lanes);
}
