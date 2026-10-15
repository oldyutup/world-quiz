import { RHYTHM as R } from "./config.js";
import { chartHash, composeSong, RHYTHM_STYLES, type RhythmStyle, type Song } from "./song.js";
import { ranksByScore } from "../../board/rules.js";

export type RhythmPhase = "countdown" | "playing" | "results";
/** How a note went: missed (nobody pressed it in time), İYİ, MÜKEMMEL, or lost to a wrong key. */
export const MISS = 0,
  GOOD = 1,
  PERFECT = 2,
  WRONG = 3;
export type Grade = typeof MISS | typeof GOOD | typeof PERFECT | typeof WRONG;
export const isHit = (grade: number) => grade === GOOD || grade === PERFECT;
export const gradePoints = (grade: number) => (grade === PERFECT ? R.points.perfect : grade === GOOD ? R.points.good : 0);
/** One key press: the moment on the player's clock (ms after BAŞLA) and the key (0 W, 1 A, 2 S, 3 D). */
export interface RhythmPress {
  at: number;
  key: number;
}
/**
 * What one packet tells the server: how many keys the player has pressed this round, and the
 * latest of those presses (the last one is press number `pressed`).
 */
export interface RhythmVolley {
  pressed: number;
  presses: readonly RhythmPress[];
}
/** A note's result: the note (its index in the chart), how it went, and when (the press, or `good` after the note for a miss). */
export interface NoteResult {
  note: number;
  grade: Grade;
  at: number;
}
export const isKey = (key: unknown): key is number => key === 0 || key === 1 || key === 2 || key === 3;

/** The first index whose note is at or after `t` (notes in time order). */
export function firstAtOrAfter(notes: readonly { t: number }[], t: number) {
  let lo = 0,
    hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A press of `key` at `at` against the notes not resolved yet: the nearest such note of that key
 * within `good` is hit (MÜKEMMEL within `perfect`); with none of that key, the nearest note in the
 * window is lost to the wrong key; with no note in the window it is a stray press (null).
 * Equal distances go to the earlier note. The server and the browsers judge with this alone.
 */
export function judgePress(notes: readonly { t: number; key: number }[], resolved: (note: number) => boolean, at: number, key: number): { note: number; grade: Grade } | null {
  const { perfect, good } = R.windows;
  let match = -1,
    matchGap = Infinity,
    nearest = -1,
    nearestGap = Infinity;
  for (let i = firstAtOrAfter(notes, at - good - 1e-6); i < notes.length && notes[i].t <= at + good + 1e-6; i++) {
    if (resolved(i)) continue;
    const gap = Math.abs(at - notes[i].t);
    if (gap > good + 1e-6) continue;
    if (notes[i].key === key && gap < matchGap) {
      match = i;
      matchGap = gap;
    }
    if (gap < nearestGap) {
      nearest = i;
      nearestGap = gap;
    }
  }
  if (match >= 0) return { note: match, grade: matchGap <= perfect + 1e-6 ? PERFECT : GOOD };
  if (nearest >= 0) return { note: nearest, grade: WRONG };
  return null;
}

/**
 * The combo from a lane's results and stray presses, in time order: every hit adds one, a miss,
 * a wrong key or a stray press sets it back to zero. Returns the combo after the last of them and
 * the longest one. The order alone decides it (not when the server learnt of each), so the
 * server and a browser that know the same events agree; at the same moment a break goes first.
 */
export function comboOf(results: Iterable<{ grade: number; at: number }>, strays: Iterable<number> = []) {
  const events: { at: number; hit: boolean }[] = [];
  for (const r of results) events.push({ at: r.at, hit: isHit(r.grade) });
  for (const at of strays) events.push({ at, hit: false });
  events.sort((a, b) => a.at - b.at || Number(a.hit) - Number(b.hit));
  let combo = 0,
    max = 0;
  for (const e of events) {
    combo = e.hit ? combo + 1 : 0;
    max = Math.max(max, combo);
  }
  return { combo, max };
}

export interface RhythmLane {
  /** Points from the notes (the combo bonus comes on top at the end). */
  score: number;
  /** Presses this player reported (a packet names its presses by number, so a repeated one counts once). */
  pressed: number;
  /** Every note's grade (−1 not resolved yet) and its moment. */
  grades: Int8Array;
  at: Float64Array;
  /** Presses that met no note (they break the combo), in time order. */
  strays: number[];
  perfect: number;
  good: number;
  miss: number;
  wrong: number;
  /** The combo now and the longest one (kept up to date by the game). */
  combo: number;
  maxCombo: number;
  /** Left the round: ranked behind everyone who stayed. */
  out: boolean;
}

const MS = 1000 / R.hz;
/** Below any player still in the round. */
const LEFT = -1e12;
const pick = (random: () => number, n: number) => Math.min(n - 1, Math.floor(random() * n));

/**
 * The Ritim Ustası rules without any network. After a countdown the song plays and its notes
 * (one chart for everyone) come; every lane plays its own copy. A press is judged at its moment
 * on the player's clock (kept at most `toleranceMs` old and `aheadMs` ahead of now); a note is
 * called missed once no press can reach it any more. The round ends at the time limit, or at
 * once when one player is left in it; the longest combo × `comboBonus` is added to every score.
 */
export class RhythmGame {
  phase: RhythmPhase = "countdown";
  countdownTicks: number = R.countdown * R.hz;
  /** Playing steps since BAŞLA. */
  ticks = 0;
  readonly song: Song;
  /** The chart's fingerprint (sent with the song so a browser can check its own composition). */
  readonly chart: number;
  readonly lanes: RhythmLane[];
  /** Every note before this one is resolved in every lane (misses are called in order). */
  private settled = 0;
  constructor(readonly count: number, random: () => number = Math.random, song?: Song) {
    if (!Number.isInteger(count) || count < 2 || count > R.maxLanes) throw new RangeError(`Ritim Ustası: ${count} lanes`);
    this.song = song ?? composeSong(RHYTHM_STYLES[pick(random, RHYTHM_STYLES.length)], Math.floor(random() * 2 ** 32));
    this.chart = chartHash(this.song.notes);
    const n = this.song.notes.length;
    this.lanes = Array.from({ length: count }, () => ({
      score: 0,
      pressed: 0,
      grades: new Int8Array(n).fill(-1),
      at: new Float64Array(n),
      strays: [],
      perfect: 0,
      good: 0,
      miss: 0,
      wrong: 0,
      combo: 0,
      maxCombo: 0,
      out: false,
    }));
  }
  get style(): RhythmStyle {
    return this.song.style;
  }
  get notes() {
    return this.song.notes;
  }
  /** The server's playing clock, ms after BAŞLA. */
  get elapsedMs() {
    return this.ticks * MS;
  }
  get limitTicks() {
    return R.limit * R.hz;
  }
  get limitMs() {
    return R.limit * 1000;
  }
  /** Lane `lane`'s resolved notes. */
  results(lane: number): NoteResult[] {
    const l = this.lanes[lane];
    const out: NoteResult[] = [];
    if (!l) return out;
    l.grades.forEach((grade, note) => {
      if (grade >= 0) out.push({ note, grade: grade as Grade, at: l.at[note] });
    });
    return out;
  }
  private resolve(lane: number, note: number, grade: Grade, at: number) {
    const l = this.lanes[lane];
    l.grades[note] = grade;
    l.at[note] = at;
    l.score += gradePoints(grade);
    if (grade === PERFECT) l.perfect++;
    else if (grade === GOOD) l.good++;
    else if (grade === WRONG) l.wrong++;
    else l.miss++;
  }
  private recount(lane: number) {
    const l = this.lanes[lane],
      c = comboOf(this.results(lane), l.strays);
    l.combo = c.combo;
    l.maxCombo = c.max;
  }
  /**
   * One press by `lane`, judged at its moment (kept at most `toleranceMs` ago and `aheadMs` ahead
   * of now). Refused (undefined) outside the playing time; otherwise the note it hit or lost and
   * how, or null for a stray press.
   */
  press(lane: number, p: RhythmPress): { note: number; grade: Grade } | null | undefined {
    const l = this.lanes[lane];
    if (this.phase !== "playing" || !l || l.out || !Number.isFinite(p.at) || !isKey(p.key) || p.at < 0 || p.at >= this.limitMs) return undefined;
    const now = this.elapsedMs,
      at = Math.min(now + R.aheadMs, Math.max(p.at, now - R.toleranceMs));
    if (at >= this.limitMs) return undefined;
    const hit = judgePress(this.notes, (note) => l.grades[note] >= 0, at, p.key);
    if (hit) this.resolve(lane, hit.note, hit.grade, at);
    else {
      // Kept in time order (a packet's presses come in order; another's may interleave).
      let i = l.strays.length;
      while (i > 0 && l.strays[i - 1] > at) i--;
      l.strays.splice(i, 0, at);
    }
    this.recount(lane);
    return hit;
  }
  /** A packet from `lane`: its presses it has not reported before, in order. */
  volley(lane: number, volley: RhythmVolley) {
    const l = this.lanes[lane];
    if (!l || l.out || this.phase === "results") return;
    const first = volley.pressed - volley.presses.length + 1;
    for (let n = Math.max(l.pressed + 1, first); n <= volley.pressed; n++) this.press(lane, volley.presses[n - first]);
    l.pressed = Math.max(l.pressed, volley.pressed);
  }
  /** Calls every note missed that no press can reach any more (all of them with `all`). */
  private settle(all = false) {
    const reach = this.elapsedMs - R.toleranceMs - R.windows.good;
    const notes = this.notes;
    while (this.settled < notes.length && (all || notes[this.settled].t < reach)) {
      const note = this.settled++;
      this.lanes.forEach((l, lane) => {
        if (!l.out && l.grades[note] < 0) {
          this.resolve(lane, note, MISS, notes[note].t + R.windows.good);
          this.recount(lane);
        }
      });
    }
  }
  /** One fixed step; `volleys[lane]` is that lane's packet received since the last step. */
  step(volleys: readonly (RhythmVolley | undefined)[] = []) {
    if (this.phase === "results") return;
    if (this.phase === "countdown") {
      if (--this.countdownTicks <= 0) this.phase = "playing";
    } else {
      this.ticks++;
      volleys.forEach((v, lane) => v && this.volley(lane, v));
      this.settle();
      if (this.ticks >= this.limitTicks) this.end();
    }
    // The last player left in the round wins at once.
    if (this.lanes.filter((l) => !l.out).length <= 1) this.end();
  }
  /** The lane left the round for good: ranked last. */
  remove(lane: number) {
    const l = this.lanes[lane];
    if (l) l.out = true;
  }
  private end() {
    if (this.phase === "playing" && this.ticks >= this.limitTicks) this.settle(true);
    this.phase = "results";
  }
  /** The longest combo's bonus. */
  bonus(lane: number) {
    return (this.lanes[lane]?.maxCombo ?? 0) * R.comboBonus;
  }
  /** Points plus the combo bonus: what ranks the players. */
  total(lane: number) {
    return (this.lanes[lane]?.score ?? 0) + this.bonus(lane);
  }
  /** Per-lane order, higher first: the totals, leavers behind everyone. */
  scores() {
    return this.lanes.map((l, lane) => (l.out ? LEFT + this.total(lane) : this.total(lane)));
  }
  /** Per-lane places: 0 best, equal totals share one. */
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
