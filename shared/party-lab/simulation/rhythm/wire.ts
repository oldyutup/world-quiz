import { RHYTHM as R } from "./config.js";
import { RHYTHM_STYLES } from "./song.js";
import { firstAtOrAfter, type Grade, type RhythmGame, type RhythmPhase } from "./game.js";

/**
 * Ritim Ustası snapshot section. Per-lane arrays are by lane (`seats[lane]` is its slot). The
 * song travels as its style and seed (every browser composes the same one; `notes` checks it);
 * of the results only the recent ones travel (`keepMs`): a note's result, and a stray press, for
 * as long as the view still shows it. Times are ms after BAŞLA.
 */
export interface RhythmWire {
  seats: number[];
  phase: RhythmPhase;
  /** Countdown seconds left (0 once playing). */
  countdown: number;
  /** Playing clock, ms after BAŞLA (frozen at the end). */
  elapsed: number;
  /** Playing time, seconds. */
  limit: number;
  /** RHYTHM_STYLES index, the song's seed, its number of notes and its chart's fingerprint (chartHash). */
  style: number;
  seed: number;
  notes: number;
  chart: number;
  score: number[];
  combo: number[];
  maxCombo: number[];
  /** The longest combo's bonus and the total (score + bonus), what ranks the players. */
  bonus: number[];
  total: number[];
  perfect: number[];
  good: number[];
  miss: number[];
  wrong: number[];
  strays: number[];
  /** Presses each player reported (their browser confirms its own presses by it). */
  pressed: number[];
  out: boolean[];
  /** Places (0 best, ties share one), final at results. */
  places: number[];
  resLane: number[];
  resNote: number[];
  resGrade: number[];
  resAt: number[];
  strayLane: number[];
  strayAt: number[];
}

export function rhythmSection(game: RhythmGame, seats: readonly number[]): RhythmWire {
  const lanes = game.lanes,
    now = game.elapsedMs,
    since = now - R.keepMs,
    from = firstAtOrAfter(game.notes, since - R.windows.good - R.toleranceMs);
  const res = lanes.flatMap((l, lane) => {
    const out: { lane: number; note: number; grade: number; at: number }[] = [];
    for (let note = from; note < game.notes.length; note++) if (l.grades[note] >= 0 && l.at[note] >= since) out.push({ lane, note, grade: l.grades[note], at: l.at[note] });
    return out;
  });
  const strays = lanes.flatMap((l, lane) => l.strays.filter((at) => at >= since).slice(-16).map((at) => ({ lane, at })));
  return {
    seats: [...seats],
    phase: game.phase,
    countdown: game.phase === "countdown" ? game.countdownTicks / R.hz : 0,
    elapsed: now,
    limit: R.limit,
    style: RHYTHM_STYLES.indexOf(game.style),
    seed: game.song.seed,
    notes: game.notes.length,
    chart: game.chart,
    score: lanes.map((l) => l.score),
    combo: lanes.map((l) => l.combo),
    maxCombo: lanes.map((l) => l.maxCombo),
    bonus: lanes.map((_, lane) => game.bonus(lane)),
    total: lanes.map((_, lane) => game.total(lane)),
    perfect: lanes.map((l) => l.perfect),
    good: lanes.map((l) => l.good),
    miss: lanes.map((l) => l.miss),
    wrong: lanes.map((l) => l.wrong),
    strays: lanes.map((l) => l.strays.length),
    pressed: lanes.map((l) => l.pressed),
    out: lanes.map((l) => l.out),
    places: game.places(),
    resLane: res.map((r) => r.lane),
    resNote: res.map((r) => r.note),
    resGrade: res.map((r) => r.grade),
    resAt: res.map((r) => r.at),
    strayLane: strays.map((s) => s.lane),
    strayAt: strays.map((s) => s.at),
  };
}

/** Lane `lane`'s results in a section. */
export const wireResults = (wire: RhythmWire, lane: number) =>
  wire.resLane.flatMap((l, i) => (l === lane ? [{ note: wire.resNote[i], grade: wire.resGrade[i] as Grade, at: wire.resAt[i] }] : []));
/** Lane `lane`'s stray presses in a section. */
export const wireStrays = (wire: RhythmWire, lane: number) => wire.strayLane.flatMap((l, i) => (l === lane ? [wire.strayAt[i]] : []));

const numbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n));
const integers = (value: unknown, length: number, min: number, max: number) => numbers(value, length) && value.every((n) => Number.isInteger(n) && n >= min && n <= max);
const booleans = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every((b) => typeof b === "boolean");
/** A received section is well formed (the client never trusts a snapshot's shape). */
export function validRhythmWire(value: unknown): value is RhythmWire {
  if (!value || typeof value !== "object") return false;
  const w = value as RhythmWire,
    lanes = Array.isArray(w.seats) ? w.seats.length : 0,
    res = Array.isArray(w.resLane) ? w.resLane.length : -1,
    strays = Array.isArray(w.strayLane) ? w.strayLane.length : -1;
  return (
    lanes >= 2 &&
    lanes <= R.maxLanes &&
    res >= 0 &&
    res <= 256 * R.maxLanes &&
    strays >= 0 &&
    strays <= 16 * R.maxLanes &&
    w.seats.every((slot) => Number.isInteger(slot) && slot >= 0) &&
    (w.phase === "countdown" || w.phase === "playing" || w.phase === "results") &&
    [w.countdown, w.elapsed, w.limit].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    Number.isInteger(w.style) &&
    w.style >= 0 &&
    w.style < RHYTHM_STYLES.length &&
    Number.isInteger(w.seed) &&
    w.seed >= 0 &&
    w.seed < 2 ** 32 &&
    Number.isInteger(w.notes) &&
    w.notes >= 1 &&
    w.notes <= 1000 &&
    Number.isInteger(w.chart) &&
    w.chart >= 0 &&
    w.chart < 2 ** 32 &&
    [w.score, w.combo, w.maxCombo, w.bonus, w.total, w.perfect, w.good, w.miss, w.wrong, w.strays, w.pressed].every((a) => integers(a, lanes, 0, 1e7)) &&
    numbers(w.places, lanes) &&
    booleans(w.out, lanes) &&
    integers(w.resLane, res, 0, lanes - 1) &&
    integers(w.resNote, res, 0, w.notes - 1) &&
    integers(w.resGrade, res, 0, 3) &&
    numbers(w.resAt, res) &&
    integers(w.strayLane, strays, 0, lanes - 1) &&
    numbers(w.strayAt, strays)
  );
}
