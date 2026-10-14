import { MARKSMAN as M } from "./config.js";
import { BOMB, EMPTY, makeWaves, waveAt, type Wave } from "./waves.js";
import { ranksByScore } from "../../board/rules.js";

export type MarksmanPhase = "countdown" | "shooting" | "results";
/** One shot: the press moment on the shooter's clock (ms after BAŞLA) and the aim it was pressed with. */
export interface MarksmanShot {
  at: number;
  aim: number;
}
/**
 * What one packet tells the server: the aim now, how many shots the player has fired this
 * round, and the latest of them (the last one is shot number `fired`).
 */
export interface MarksmanVolley {
  aim: number;
  fired: number;
  shots: readonly MarksmanShot[];
}
/** A hit: the wave (its index in the round), the slot, the moment and the points it scored. */
export interface MarksmanHit {
  wave: number;
  slot: number;
  at: number;
  points: number;
}
export interface MarksmanLane {
  score: number;
  /** The aim now (−1 left, 0 middle, +1 right): what the others see. */
  aim: number;
  /** Shots this player reported (a packet names its shots by number, so a repeated one counts once). */
  fired: number;
  /** Shots that counted (not refused), and the last one's moment and aim (−1e9 none yet). */
  shots: number;
  shotAt: number;
  shotAim: number;
  /** The last counted shot's own stamp (the cooldown runs on the shooter's clock). */
  stamp: number;
  /** No shot counts before this moment (a bomb's stun). */
  stunUntil: number;
  /** Lives left (a bomb takes one), and when the last one went (−1 still standing). */
  lives: number;
  diedAt: number;
  hits: MarksmanHit[];
  good: number;
  slow: number;
  bombs: number;
  /** Left the round: ranked behind everyone who stayed. */
  out: boolean;
}

const MS = 1000 / M.hz;
/** Below any player still in the round. */
const LEFT = -1e12;
const NEVER = -1e9;
export const isAim = (aim: unknown): aim is number => aim === -1 || aim === 0 || aim === 1;

/**
 * The Nişancı rules without any network. After a countdown the waves (one schedule for
 * everyone, drawn at construction) open and close on the clock. A shot is judged at its press
 * moment with the aim it was pressed with: a target up in that slot scores `good` when hit at
 * most `goodMs` after it opened, else `slow`; a bomb costs `bomb` and a life: the first stuns for
 * `stunMs`, the last knocks the player out. Every player has their own copy of every wave, so a
 * hit never touches anyone else's.
 *
 * The round ends `aimToleranceMs` after the limit (late shots pressed in time still count); when a
 * knock-out leaves one player standing (or none), `aimToleranceMs` after that knock-out (shots
 * pressed before it still count, later ones do not); at once when one player is left in the round.
 */
export class MarksmanGame {
  phase: MarksmanPhase = "countdown";
  countdownTicks: number = M.countdown * M.hz;
  /** Shooting steps since BAŞLA. */
  ticks = 0;
  readonly lanes: MarksmanLane[];
  readonly waves: readonly Wave[];
  /** The knock-out that left one player standing (or none), ms; null while two or more stand. */
  decidedAt: number | null = null;
  constructor(readonly count: number, random: () => number = Math.random, waves?: readonly Wave[]) {
    if (!Number.isInteger(count) || count < 2 || count > M.maxLanes) throw new RangeError(`Nişancı: ${count} lanes`);
    this.waves = waves ?? makeWaves(random);
    this.lanes = Array.from({ length: count }, () => ({
      score: 0,
      aim: 0,
      fired: 0,
      shots: 0,
      shotAt: NEVER,
      shotAim: 0,
      stamp: NEVER,
      stunUntil: 0,
      lives: M.lives,
      diedAt: -1,
      hits: [],
      good: 0,
      slow: 0,
      bombs: 0,
      out: false,
    }));
  }
  /** The server's shooting clock, ms after BAŞLA. */
  get elapsedMs() {
    return this.ticks * MS;
  }
  get limitTicks() {
    return M.limit * M.hz;
  }
  get limitMs() {
    return M.limit * 1000;
  }
  /** Still shooting: in the round and not knocked out. */
  standing(lane: number) {
    const l = this.lanes[lane];
    return !!l && !l.out && l.diedAt < 0;
  }
  /** Has `lane` hit `slot` of wave `wave`. */
  hit(lane: number, wave: number, slot: number) {
    return this.lanes[lane]?.hits.some((h) => h.wave === wave && h.slot === slot) ?? false;
  }
  /**
   * One shot by `lane`, judged at its press moment (kept at most `aimToleranceMs` ago and
   * `aheadMs` ahead of now) with its aim. Refused (null) outside the shooting time (or after the
   * knock-out that decided the round), closer than `cooldownMs` to the last one on the shooter's
   * clock, while stunned or once knocked out; otherwise the points it scored (0 a miss).
   */
  shoot(lane: number, shot: MarksmanShot): number | null {
    const l = this.lanes[lane];
    if (this.phase !== "shooting" || !this.standing(lane) || !Number.isFinite(shot.at) || !isAim(shot.aim)) return null;
    if (shot.at < 0 || shot.at >= Math.min(this.limitMs, this.decidedAt ?? Infinity) || shot.at < l.stamp + M.cooldownMs - 1e-6) return null;
    const now = this.elapsedMs,
      at = Math.min(now + M.aheadMs, Math.max(shot.at, now - M.aimToleranceMs));
    if (at >= this.limitMs || at < l.stunUntil) return null;
    l.stamp = shot.at;
    l.shots++;
    l.shotAt = at;
    l.shotAim = shot.aim;
    const wave = waveAt(this.waves, at),
      slot = shot.aim + 1,
      kind = wave < 0 ? EMPTY : this.waves[wave].kinds[slot];
    if (kind === EMPTY || this.hit(lane, wave, slot)) return 0;
    const points = kind === BOMB ? M.points.bomb : at - this.waves[wave].open <= M.goodMs ? M.points.good : M.points.slow;
    l.hits.push({ wave, slot, at, points });
    l.score += points;
    if (kind === BOMB) {
      l.bombs++;
      if (--l.lives > 0) l.stunUntil = at + M.stunMs;
      else l.diedAt = at;
    } else if (points === M.points.good) l.good++;
    else l.slow++;
    return points;
  }
  /** A packet from `lane`: its aim, then its shots it has not reported before, in order. */
  volley(lane: number, volley: MarksmanVolley) {
    const l = this.lanes[lane];
    if (!l || l.out || this.phase === "results") return;
    if (isAim(volley.aim)) l.aim = volley.aim;
    const first = volley.fired - volley.shots.length + 1;
    for (let n = Math.max(l.fired + 1, first); n <= volley.fired; n++) this.shoot(lane, volley.shots[n - first]);
    l.fired = Math.max(l.fired, volley.fired);
  }
  /** One fixed step; `volleys[lane]` is that lane's packet received since the last step. */
  step(volleys: readonly (MarksmanVolley | undefined)[] = []) {
    if (this.phase === "results") return;
    if (this.phase === "countdown") {
      volleys.forEach((v, lane) => v && this.volley(lane, v));
      if (--this.countdownTicks <= 0) this.phase = "shooting";
    } else {
      this.ticks++;
      volleys.forEach((v, lane) => v && this.volley(lane, v));
      // One standing (or none): decided at the last knock-out so far (a late shot may still knock out
      // the one standing, before it).
      const standing = this.lanes.filter((_, lane) => this.standing(lane)).length;
      if (standing <= 1) this.decidedAt = Math.max(...this.lanes.map((l) => (l.out ? -1 : l.diedAt)));
      // Time, or the knock-out: shots pressed before it may still arrive for aimToleranceMs.
      if (this.elapsedMs >= Math.min(this.limitMs, this.decidedAt ?? Infinity) + M.aimToleranceMs) this.end();
    }
    // The last player left in the round wins at once.
    if (this.lanes.filter((l) => !l.out).length <= 1) this.end();
  }
  /** A dropped player: the aim back to the middle (their waves keep coming). */
  neutralize(lane: number) {
    const l = this.lanes[lane];
    if (l) l.aim = 0;
  }
  /** The lane left the round for good: ranked last. */
  remove(lane: number) {
    const l = this.lanes[lane];
    if (l) l.out = true;
  }
  private end() {
    this.phase = "results";
  }
  /**
   * Per-lane order, higher first: those standing by score, then the knocked out by when (later
   * higher; the same moment shares a place), then leavers.
   */
  scores() {
    return this.lanes.map((l) => {
      const rank = l.diedAt >= 0 ? l.diedAt : 1e7 + l.score;
      return l.out ? LEFT + rank : rank;
    });
  }
  /** Per-lane places: 0 best, equal scores share one. */
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
