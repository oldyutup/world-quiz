import { LIGHT_TRAILS as L, ticks } from "./config.js";
import { segmentNearBox, sweepBox, sweepCircle, sweepOut, sweepSegment } from "./sweep.js";
import { trainSwept, type TrainSpan } from "./train.js";
import { ranksByScore } from "../../board/rules.js";

export type TrailPhase = "countdown" | "playing" | "results";
/** Why a player is out: nothing yet, a wall, another's trail, their own, a head-on crash, the train, or they left. */
export const NONE = 0,
  WALL = 1,
  TRAIL = 2,
  SELF = 3,
  HEAD = 4,
  TRAIN = 5,
  LEFT = 6;
export interface TrailHead {
  x: number;
  z: number;
  /** Heading: radians from +x towards +z (clockwise on the screen), in (−π, π]. */
  a: number;
}
export interface TrailPlayer extends TrailHead {
  alive: boolean;
  /** Left the round. */
  out: boolean;
  /** The play step it died at (−1 alive). */
  died: number;
  cause: number;
  /** Whose trail it hit, or which head it met (lane), −1 none. */
  by: number;
}
/** One player's keys as screen directions: each −1, 0 or 1 (none pressed: straight on). */
export interface TrailInput {
  x: number;
  z: number;
}
/**
 * A trail: points laid every few steps (on the centimetre, exactly what the wire carries) and
 * when it died; the line goes on from the last one to the living head. `cut[i]`: the train
 * wiped the piece after point i.
 */
export interface TrailLine {
  x: number[];
  z: number[];
  t: number[];
  cut: boolean[];
}

const STEP = 1 / L.hz,
  HALF_X = L.width / 2,
  HALF_Z = L.depth / 2;
/** Steps a point lives, fades over its last, and a dead player's trail takes to go. */
export const LIFE = ticks(L.trailLife),
  FADE = ticks(L.trailFade),
  DEATH_FADE = ticks(L.deathFade);
/** A head this close to a trail's centre line touches it. */
export const HIT = L.radius + L.trailRadius;
/** After this play step everyone runs and turns `rush.factor` times as fast. */
export const RUSH_AT = ticks(L.limit - L.rush.last);
export const rushed = (step: number) => step > RUSH_AT;
export const speedAt = (step: number) => L.speed * (rushed(step) ? L.rush.factor : 1);
export const turnRateAt = (step: number) => L.turnRate * (rushed(step) ? L.rush.factor : 1);
/** Trail points sit on the centimetre (the wire's resolution), so the server tests what everyone draws. */
export const onCentimetre = (v: number) => Math.round(v * 100) / 100;

/** The direction the keys point at (radians), or null when none is pressed. */
export function keyHeading(input: TrailInput | undefined) {
  const x = Math.sign(input?.x ?? 0),
    z = Math.sign(input?.z ?? 0);
  return x || z ? Math.atan2(z, x) : null;
}
/**
 * One step of running at play step `step`: turn towards the keys' direction by at most the turn
 * rate (exactly opposite: the U-turn's side is fixed by the float rounding, the same everywhere),
 * then run. The server and the client's prediction both use this.
 */
export function steer(p: TrailHead, input: TrailInput | undefined, step: number) {
  const target = keyHeading(input);
  if (target !== null) {
    const d = Math.atan2(Math.sin(target - p.a), Math.cos(target - p.a)),
      max = turnRateAt(step) * STEP;
    p.a = Math.abs(d) <= max ? target : p.a + Math.sign(d) * max;
    if (p.a > Math.PI) p.a -= 2 * Math.PI;
    else if (p.a <= -Math.PI) p.a += 2 * Math.PI;
  }
  const v = speedAt(step) * STEP;
  p.x += Math.cos(p.a) * v;
  p.z += Math.sin(p.a) * v;
}

/** The starting ellipse's half axes, m. */
export const SPAWN_AXES = { x: HALF_X * L.spawnScale, z: HALF_Z * L.spawnScale } as const;
const RING = (() => {
  // Arc length round the ellipse, sampled finely: equal spacing is along it, not by angle.
  const n = 1440,
    arc = new Float64Array(n + 1);
  let px = SPAWN_AXES.x,
    pz = 0;
  for (let i = 1; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI,
      x = SPAWN_AXES.x * Math.cos(t),
      z = SPAWN_AXES.z * Math.sin(t);
    arc[i] = arc[i - 1] + Math.hypot(x - px, z - pz);
    px = x;
    pz = z;
  }
  return { n, arc, length: arc[n] };
})();
/** The point `share` (0…1) of the way round the starting ellipse, facing clockwise along it. */
export function ringPoint(share: number): TrailHead {
  const s = (((share % 1) + 1) % 1) * RING.length;
  let lo = 0,
    hi = RING.n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (RING.arc[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = ((lo + (s - RING.arc[lo]) / Math.max(1e-12, RING.arc[hi] - RING.arc[lo])) / RING.n) * 2 * Math.PI;
  return { x: SPAWN_AXES.x * Math.cos(t), z: SPAWN_AXES.z * Math.sin(t), a: Math.atan2(SPAWN_AXES.z * Math.cos(t), -SPAWN_AXES.x * Math.sin(t)) };
}
/** Where `count` players start: equally spaced along the ellipse from `turn` (0…1) round it, all facing clockwise. */
export const spawnRing = (count: number, turn: number) => Array.from({ length: count }, (_, lane) => ringPoint(turn + lane / count));

/**
 * A trail's live pieces at play step `step`, newest first: from the head (when alive) back to
 * the tail, each clipped where it is older than its life; nothing once a dead trail has faded.
 * `grace` m along the line from the head are left out (your own trail never hits you there).
 * Wiped pieces are left out but still count along the line. `visit` gets each piece's ends
 * (a older, b newer) and the steps they were laid at.
 */
export function visitTrail(
  line: TrailLine,
  died: number,
  step: number,
  head: { x: number; z: number } | null,
  grace: number,
  visit: (ax: number, az: number, bx: number, bz: number, ta: number, tb: number) => void
) {
  const n = line.x.length;
  if (!n || (died >= 0 && step >= died + DEATH_FADE)) return;
  let arc = 0;
  for (let i = head ? n - 1 : n - 2; i >= 0; i--) {
    const live = i === n - 1;
    let bx = live ? head!.x : line.x[i + 1],
      bz = live ? head!.z : line.z[i + 1];
    const tb = live ? step : line.t[i + 1],
      ta = line.t[i];
    if (tb + LIFE <= step) return;
    let ax = line.x[i],
      az = line.z[i];
    const length = Math.hypot(bx - ax, bz - az);
    if (ta + LIFE <= step && tb > ta) {
      const f = (step - LIFE - ta) / (tb - ta);
      ax += (bx - ax) * f;
      az += (bz - az) * f;
    }
    if (arc < grace) {
      const spare = grace - arc;
      arc += length;
      if (spare >= length) continue;
      const k = spare / Math.max(1e-12, length);
      bx += (line.x[i] - bx) * k;
      bz += (line.z[i] - bz) * k;
    } else arc += length;
    if (!line.cut[i]) visit(ax, az, bx, bz, ta, tb);
  }
}

/** How bright a trail point laid at step `born` is at `step` (0…1): fading over its last second, and with a dead trail. */
export function trailAlpha(born: number, died: number, step: number) {
  let alpha = Math.max(0, Math.min(1, (born + LIFE - step) / FADE));
  if (died >= 0) alpha *= Math.max(0, Math.min(1, (died + DEATH_FADE - step) / DEATH_FADE));
  return alpha;
}

export interface TrailHit {
  /** Share of the step's move at which the head touched. */
  f: number;
  cause: number;
  by: number;
}

/**
 * The Işık İzi rules without any network. After a countdown everyone runs at a fixed speed,
 * turning towards their keys; each leaves a trail that lives `trailLife` s. Touching a wall, a
 * visible trail (your own too, but its newest `selfGrace` m), the train, or another head (both
 * die) kills, tested along the whole move. The last one standing wins at once; players who die
 * in the same step share a place; when the time is up everyone still running draws.
 */
export class TrailGame {
  phase: TrailPhase = "countdown";
  countdownTicks = ticks(L.countdown);
  /** Play steps since BAŞLA. */
  ticks = 0;
  readonly players: TrailPlayer[];
  readonly lines: TrailLine[];
  /** This round's turn of the starting ellipse (0…1). */
  readonly turn: number;
  /** Players the train has killed. */
  trainKills = 0;
  constructor(readonly count: number, random: () => number = Math.random, turn?: number) {
    if (!Number.isInteger(count) || count < 2 || count > L.maxLanes) throw new RangeError(`Işık İzi: ${count} players`);
    this.turn = turn ?? random();
    this.players = spawnRing(count, this.turn).map((s) => ({ ...s, alive: true, out: false, died: -1, cause: NONE, by: -1 }));
    this.lines = this.players.map(() => ({ x: [], z: [], t: [], cut: [] }));
  }
  get limitTicks() {
    return L.limit * L.hz;
  }
  /** Players still running. */
  standing() {
    return this.players.filter((p) => p.alive && !p.out).length;
  }

  /** One fixed step; `inputs[lane]` is that player's latest keys (undefined: straight on). */
  step(inputs: readonly (TrailInput | undefined)[] = []) {
    if (this.phase === "results") return;
    if (this.phase === "countdown") {
      if (--this.countdownTicks <= 0) {
        this.phase = "playing";
        this.players.forEach((p, lane) => p.alive && this.lay(lane, 0));
      }
      if (this.standing() <= 1) this.phase = "results";
      return;
    }
    const step = ++this.ticks,
      from = this.players.map((p) => ({ x: p.x, z: p.z }));
    this.players.forEach((p, lane) => {
      if (p.alive && !p.out) steer(p, inputs[lane], step);
    });
    const train = trainSwept(step);
    if (train) this.wipe(train);
    // Everyone's first touch along their move, then heads meeting (before either hit anything else).
    const hits = this.players.map((p, lane) => (p.alive && !p.out ? this.hazard(lane, from[lane], p, step, train) : null));
    const best = hits.map((h) => h);
    for (let i = 0; i < this.count; i++)
      for (let j = i + 1; j < this.count; j++) {
        const p = this.players[i],
          q = this.players[j];
        if (!p.alive || p.out || !q.alive || q.out) continue;
        const f = sweepCircle(from[i].x - from[j].x, from[i].z - from[j].z, p.x - from[i].x - (q.x - from[j].x), p.z - from[i].z - (q.z - from[j].z), 0, 0, 2 * L.radius);
        if (f > 1 || f > (hits[i]?.f ?? Infinity) || f > (hits[j]?.f ?? Infinity)) continue;
        if (f < (best[i]?.f ?? Infinity)) best[i] = { f, cause: HEAD, by: j };
        if (f < (best[j]?.f ?? Infinity)) best[j] = { f, cause: HEAD, by: i };
      }
    best.forEach((hit, lane) => hit && this.kill(lane, hit, from[lane], step));
    if (step % L.trailEvery === 0) this.players.forEach((p, lane) => p.alive && !p.out && this.lay(lane, step));
    this.lines.forEach((line, lane) => this.prune(line, this.players[lane].died, step));
    if (this.standing() <= 1 || step >= this.limitTicks) this.phase = "results";
  }

  /** `lane`'s first touch moving `from` → `to` at play step `step` (also the prediction's and the bots' check). */
  hazard(lane: number, from: { x: number; z: number }, to: { x: number; z: number }, step: number, train: TrainSpan | null = trainSwept(step)): TrailHit | null {
    const dx = to.x - from.x,
      dz = to.z - from.z;
    let hit: TrailHit = { f: sweepOut(from.x, from.z, dx, dz, HALF_X - L.radius, HALF_Z - L.radius), cause: WALL, by: -1 };
    if (train) {
      const f = sweepBox(from.x, from.z, dx, dz, train.x0 - L.radius, train.x1 + L.radius, -L.train.halfWidth - L.radius, L.train.halfWidth + L.radius);
      if (f <= 1 && f < hit.f) hit = { f, cause: TRAIN, by: -1 };
    }
    this.lines.forEach((line, j) => {
      const other = this.players[j],
        self = j === lane;
      visitTrail(line, other.died, step, other.alive && !other.out ? (self ? from : other) : null, self ? L.selfGrace : 0, (ax, az, bx, bz) => {
        const f = sweepSegment(from.x, from.z, dx, dz, ax, az, bx, bz, HIT);
        if (f <= 1 && f < hit.f) hit = { f, cause: self ? SELF : TRAIL, by: j };
      });
    });
    return hit.f <= 1 ? hit : null;
  }
  /** The train wipes every trail piece it runs over (the lines up to the heads included). */
  private wipe(train: TrainSpan) {
    const hw = L.train.halfWidth;
    this.lines.forEach((line, lane) => {
      const p = this.players[lane],
        n = line.x.length;
      for (let i = 0; i < n; i++) {
        if (line.cut[i]) continue;
        const last = i === n - 1;
        if (last && !(p.alive && !p.out)) continue;
        const bx = last ? p.x : line.x[i + 1],
          bz = last ? p.z : line.z[i + 1];
        if (segmentNearBox(line.x[i], line.z[i], bx, bz, train.x0, train.x1, -hw, hw, L.trailRadius)) line.cut[i] = true;
      }
    });
  }
  private kill(lane: number, hit: TrailHit, from: { x: number; z: number }, step: number) {
    const p = this.players[lane];
    p.x = from.x + (p.x - from.x) * hit.f;
    p.z = from.z + (p.z - from.z) * hit.f;
    p.alive = false;
    p.died = step;
    p.cause = hit.cause;
    p.by = hit.by;
    if (hit.cause === TRAIN) this.trainKills++;
    this.lay(lane, step);
  }
  /** A trail point at the head (on the centimetre). */
  private lay(lane: number, step: number) {
    const p = this.players[lane],
      line = this.lines[lane];
    line.x.push(onCentimetre(p.x));
    line.z.push(onCentimetre(p.z));
    line.t.push(step);
    line.cut.push(false);
  }
  /** Drops the points nothing can see any more. */
  private prune(line: TrailLine, died: number, step: number) {
    if (died >= 0 && step >= died + DEATH_FADE) {
      line.x.length = line.z.length = line.t.length = line.cut.length = 0;
      return;
    }
    let k = 0;
    while (k + 1 < line.t.length && line.t[k + 1] + LIFE <= step) k++;
    if (k) for (const list of [line.x, line.z, line.t, line.cut] as unknown[][]) list.splice(0, k);
  }
  /** `lane` left the round for good: out where it stands, its trail fading; ranked behind everyone who stayed. */
  remove(lane: number) {
    const p = this.players[lane];
    if (!p || p.out) return;
    p.out = true;
    if (!p.alive) return;
    p.alive = false;
    p.died = this.ticks;
    p.cause = LEFT;
    p.by = -1;
    if (this.phase === "playing") this.lay(lane, this.ticks);
  }
  /** Per-lane order, higher first: still running, then the later death; a player who left while running last. */
  scores() {
    return this.players.map((p) => (p.cause === LEFT ? -Infinity : p.alive && !p.out ? Infinity : p.died));
  }
  /** Per-lane places: 0 best, players out in the same step share one. */
  places() {
    return ranksByScore(this.scores());
  }
  /** The winning lane at results: the only one still running; −1 before, or a draw. */
  winner() {
    if (this.phase !== "results") return -1;
    const running = this.players.flatMap((p, lane) => (p.alive && !p.out ? [lane] : []));
    return running.length === 1 ? running[0] : -1;
  }
}
