import { MARKSMAN as M } from "./config.js";
import type { MarksmanGame, MarksmanHit, MarksmanPhase } from "./game.js";
import type { SlotKind, Wave } from "./waves.js";

/**
 * Nişancı snapshot section. Per-lane arrays are by lane (`seats[lane]` is its slot). Only the
 * waves around now travel: the ones opening within `leadMs` (so every screen raises them on
 * time) and the ones closed within `keepMs` (their hits keep showing). `waveKinds` holds three
 * entries per wave; the hits listed are the hits on those waves. Times are ms after BAŞLA.
 */
export interface MarksmanWire {
  seats: number[];
  phase: MarksmanPhase;
  /** Countdown seconds left (0 once shooting). */
  countdown: number;
  /** Shooting clock, ms after BAŞLA (frozen at the end). */
  elapsed: number;
  /** Shooting time, seconds. */
  limit: number;
  waveId: number[];
  waveOpen: number[];
  waveClose: number[];
  waveKinds: number[];
  score: number[];
  aim: number[];
  fired: number[];
  shots: number[];
  shotAt: number[];
  shotAim: number[];
  stunUntil: number[];
  good: number[];
  slow: number[];
  bombs: number[];
  out: boolean[];
  /** Places (0 best, ties share one), final at results. */
  places: number[];
  hitLane: number[];
  hitWave: number[];
  hitSlot: number[];
  hitAt: number[];
  hitPoints: number[];
}

/** The waves to send at `now`. */
export const wavesAround = (waves: readonly Wave[], now: number) => waves.flatMap((w, id) => (w.open <= now + M.leadMs && w.close >= now - M.keepMs ? [id] : []));

export function marksmanSection(game: MarksmanGame, seats: readonly number[]): MarksmanWire {
  const lanes = game.lanes,
    now = game.elapsedMs,
    ids = wavesAround(game.waves, now),
    shown = new Set(ids),
    hits = lanes.flatMap((l, lane) => l.hits.filter((h) => shown.has(h.wave)).map((h) => ({ lane, ...h })));
  return {
    seats: [...seats],
    phase: game.phase,
    countdown: game.phase === "countdown" ? game.countdownTicks / M.hz : 0,
    elapsed: now,
    limit: M.limit,
    waveId: ids,
    waveOpen: ids.map((id) => game.waves[id].open),
    waveClose: ids.map((id) => game.waves[id].close),
    waveKinds: ids.flatMap((id) => game.waves[id].kinds),
    score: lanes.map((l) => l.score),
    aim: lanes.map((l) => l.aim),
    fired: lanes.map((l) => l.fired),
    shots: lanes.map((l) => l.shots),
    shotAt: lanes.map((l) => l.shotAt),
    shotAim: lanes.map((l) => l.shotAim),
    stunUntil: lanes.map((l) => l.stunUntil),
    good: lanes.map((l) => l.good),
    slow: lanes.map((l) => l.slow),
    bombs: lanes.map((l) => l.bombs),
    out: lanes.map((l) => l.out),
    places: game.places(),
    hitLane: hits.map((h) => h.lane),
    hitWave: hits.map((h) => h.wave),
    hitSlot: hits.map((h) => h.slot),
    hitAt: hits.map((h) => h.at),
    hitPoints: hits.map((h) => h.points),
  };
}

/** A wave as sent: its id (index in the round) with its moments and kinds. */
export interface WireWave extends Wave {
  id: number;
}
/** The waves in a section. */
export const wireWaves = (wire: MarksmanWire): WireWave[] =>
  wire.waveId.map((id, i) => ({ id, open: wire.waveOpen[i], close: wire.waveClose[i], kinds: wire.waveKinds.slice(i * M.slots, (i + 1) * M.slots) as SlotKind[] }));
/** Lane `lane`'s hits in a section. */
export const wireHits = (wire: MarksmanWire, lane: number): MarksmanHit[] =>
  wire.hitLane.flatMap((l, i) => (l === lane ? [{ wave: wire.hitWave[i], slot: wire.hitSlot[i], at: wire.hitAt[i], points: wire.hitPoints[i] }] : []));

const numbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n));
const integers = (value: unknown, length: number, min: number, max: number) => numbers(value, length) && value.every((n) => Number.isInteger(n) && n >= min && n <= max);
const booleans = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every((b) => typeof b === "boolean");
/** A received section is well formed (the client never trusts a snapshot's shape). */
export function validMarksmanWire(value: unknown): value is MarksmanWire {
  if (!value || typeof value !== "object") return false;
  const w = value as MarksmanWire,
    lanes = Array.isArray(w.seats) ? w.seats.length : 0,
    waves = Array.isArray(w.waveId) ? w.waveId.length : -1,
    hits = Array.isArray(w.hitLane) ? w.hitLane.length : -1;
  return (
    lanes >= 2 &&
    lanes <= M.maxLanes &&
    waves >= 0 &&
    waves <= 64 &&
    hits >= 0 &&
    hits <= 64 * M.slots * M.maxLanes &&
    w.seats.every((slot) => Number.isInteger(slot) && slot >= 0) &&
    (w.phase === "countdown" || w.phase === "shooting" || w.phase === "results") &&
    [w.countdown, w.elapsed, w.limit].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    integers(w.waveId, waves, 0, 10_000) &&
    numbers(w.waveOpen, waves) &&
    numbers(w.waveClose, waves) &&
    w.waveOpen.every((open, i) => open < w.waveClose[i]) &&
    integers(w.waveKinds, waves * M.slots, 0, 2) &&
    integers(w.aim, lanes, -1, 1) &&
    integers(w.shotAim, lanes, -1, 1) &&
    integers(w.fired, lanes, 0, 1e6) &&
    integers(w.shots, lanes, 0, 1e6) &&
    [w.good, w.slow, w.bombs].every((a) => integers(a, lanes, 0, 1e6)) &&
    [w.score, w.shotAt, w.stunUntil, w.places].every((a) => numbers(a, lanes)) &&
    booleans(w.out, lanes) &&
    integers(w.hitLane, hits, 0, lanes - 1) &&
    integers(w.hitWave, hits, 0, 10_000) &&
    integers(w.hitSlot, hits, 0, M.slots - 1) &&
    numbers(w.hitAt, hits) &&
    numbers(w.hitPoints, hits)
  );
}
