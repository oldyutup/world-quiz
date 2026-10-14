import { LIGHT_TRAILS as L } from "./config.js";
import { DEATH_FADE, LIFE, speedAt, steer, visitTrail, type TrailGame, type TrailHead, type TrailInput } from "./game.js";
import { segmentDistance } from "./sweep.js";
import { trainEnter, trainLeave, trainState } from "./train.js";

export const TRAIL_BOT_LEVELS = ["easy", "medium", "hard"] as const;
export type TrailBotLevel = (typeof TRAIL_BOT_LEVELS)[number];
export const TRAIL_BOT_NAMES: Readonly<Record<TrailBotLevel, string>> = { easy: "Kolay", medium: "Orta", hard: "Zor" };

interface Tuning {
  /** Steps between decisions. */
  think: number;
  /** Steps looked ahead for each choice. */
  horizon: number;
  /** Clearance wanted beyond touching, m. */
  margin: number;
  /** Chance a decision forgets its own trail for `forget` steps (it may run into it). */
  careless: number;
  forget: number;
  /** Chance a decision takes any choice that looks safe for half the horizon instead of the best. */
  noise: number;
  /** Weighs the room left where a choice ends (pockets are traps); Kolay does not. */
  room: boolean;
  /**
   * Weight of running across a rival's way just ahead of it (its trail then lies in the rival's
   * path): Zor's cutting players off, taken only when that choice is safe and roomy.
   */
  hunt: number;
}
export const TRAIL_BOT_TUNING: Readonly<Record<TrailBotLevel, Tuning>> = {
  easy: { think: 10, horizon: 42, margin: 0.05, careless: 0.004, forget: 90, noise: 0.12, room: false, hunt: 0 },
  medium: { think: 5, horizon: 72, margin: 0.18, careless: 0, forget: 0, noise: 0.04, room: true, hunt: 0 },
  hard: { think: 3, horizon: 100, margin: 0.18, careless: 0, forget: 0, noise: 0, room: true, hunt: 400 },
};
/** A choice cutting a rival off counts only with this much room left (cells). */
const HUNT_ROOM = 250;
/** Shorter clear runs than this are not weighed for room (they are lost anyway). */
const ROOM_FROM = 24;
/** Steps between the points checked along a choice. */
const STRIDE = 2;
/** Steps of a rival's way ahead taken as certain (it may turn after that). */
const RIVAL_AHEAD = 44;
/** The keys a bot can hold: none (straight on) and the eight screen directions. */
const CHOICES: readonly TrailInput[] = [{ x: 0, z: 0 }, ...[-1, 0, 1].flatMap((x) => [-1, 0, 1].flatMap((z) => (x || z ? [{ x, z }] : [])))];
const HALF_X = L.width / 2,
  HALF_Z = L.depth / 2,
  CELL = 1;

/** A trail piece in the bot's head: the steps it can be hit in. */
interface Piece {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  from: number;
  to: number;
}
/** Pieces bucketed by 1 m cells (each in every cell it comes near), so a point checks only its own cell. */
class Grid {
  private cells = new Map<number, Piece[]>();
  constructor(private readonly reach: number) {}
  add(p: Piece) {
    const r = this.reach;
    for (let cx = Math.floor((Math.min(p.ax, p.bx) - r) / CELL); cx <= Math.floor((Math.max(p.ax, p.bx) + r) / CELL); cx++)
      for (let cz = Math.floor((Math.min(p.az, p.bz) - r) / CELL); cz <= Math.floor((Math.max(p.az, p.bz) + r) / CELL); cz++) {
        const key = cx * 1000 + cz;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(p);
      }
  }
  /** A piece that can be hit at `step` lies within `r` of (x, z). */
  hits(x: number, z: number, step: number, r: number) {
    const list = this.cells.get(Math.floor(x / CELL) * 1000 + Math.floor(z / CELL));
    if (!list) return false;
    for (const p of list) if (step >= p.from && step < p.to && segmentDistance(x, z, p.ax, p.az, p.bx, p.bz) < r) return true;
    return false;
  }
}

/** Half-metre cells over the arena. */
const RC = 0.5,
  NX = Math.ceil(L.width / RC),
  NZ = Math.ceil(L.depth / RC),
  ROOM_CAP = 900,
  /** Trail ends this close to a head (m along the line) are left off the room map, else the head looks walled in by its own line. */
  ROOM_GRACE = 1,
  /** The newest samples of a choice's own path left off its room map, for the same reason. */
  PATH_GRACE = 6;
const centre = (c: number) => ({ x: -HALF_X + (Math.floor(c / NZ) + 0.5) * RC, z: -HALF_Z + ((c % NZ) + 0.5) * RC });
const cellOf = (x: number, z: number) => {
  const i = Math.floor((x + HALF_X) / RC),
    k = Math.floor((z + HALF_Z) / RC);
  return i >= 0 && i < NX && k >= 0 && k < NZ ? i * NZ + k : -1;
};
/** Calls `visit` for every cell whose middle is within `r` of the segment a–b. */
function cellsNear(ax: number, az: number, bx: number, bz: number, r: number, visit: (c: number) => void) {
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r + HALF_X) / RC)),
    i1 = Math.min(NX - 1, Math.floor((Math.max(ax, bx) + r + HALF_X) / RC)),
    k0 = Math.max(0, Math.floor((Math.min(az, bz) - r + HALF_Z) / RC)),
    k1 = Math.min(NZ - 1, Math.floor((Math.max(az, bz) + r + HALF_Z) / RC));
  for (let i = i0; i <= i1; i++)
    for (let k = k0; k <= k1; k++) {
      const c = i * NZ + k,
        at = centre(c);
      if (segmentDistance(at.x, at.z, ax, az, bx, bz) < r) visit(c);
    }
}
/**
 * The room left at the end of a choice, on half-metre cells, each holding the step from which
 * it is free of trails (walls never are; the rail while it is shut). A breadth-first run from
 * the end counts the cells a head could reach (one whose trail will have faded by the time it
 * gets there counts); the choice's own path is in its way for good.
 */
class RoomMap {
  readonly free = new Float64Array(NX * NZ);
  private readonly mine = new Float64Array(NX * NZ);
  private readonly arrive = new Float64Array(NX * NZ);
  private readonly queue = new Int32Array(NX * NZ);
  constructor(wall: { x: number; z: number }) {
    for (let c = 0; c < NX * NZ; c++) {
      const at = centre(c);
      if (Math.abs(at.x) > wall.x || Math.abs(at.z) > wall.z) this.free[c] = Infinity;
    }
  }
  /** Cells near the piece are taken until step `to`. */
  add(ax: number, az: number, bx: number, bz: number, to: number, r: number) {
    cellsNear(ax, az, bx, bz, r, (c) => (this.free[c] = Math.max(this.free[c], to)));
  }
  /** The band |z| < half is taken until step `to`. */
  band(half: number, to: number) {
    for (let c = 0; c < NX * NZ; c++) if (Math.abs(centre(c).z) < half) this.free[c] = Math.max(this.free[c], to);
  }
  /**
   * Breadth-first from `starts` (all at `step`), `perCell` steps a cell, into `out` (arrival
   * steps, Infinity unreached); `blocked(c)` stops it too. Returns the cells reached (capped).
   */
  private flood(out: Float64Array, starts: readonly number[], step: number, perCell: number, cap: number, blocked: (c: number) => boolean) {
    out.fill(Infinity);
    let head = 0,
      tail = 0;
    for (const c of starts)
      if (c >= 0 && out[c] === Infinity) {
        out[c] = step;
        this.queue[tail++] = c;
      }
    while (head < tail && head < cap) {
      const c = this.queue[head++],
        i = Math.floor(c / NZ),
        k = c % NZ,
        at = out[c] + perCell;
      for (const n of [i + 1 < NX ? c + NZ : -1, i > 0 ? c - NZ : -1, k + 1 < NZ ? c + 1 : -1, k > 0 ? c - 1 : -1]) {
        if (n < 0 || out[n] !== Infinity || this.free[n] > at || blocked(n)) continue;
        out[n] = at;
        this.queue[tail++] = n;
      }
    }
    return Math.min(head, cap);
  }
  /** The room where a choice ends: `path` (sampled every STRIDE steps) ends at `step`. */
  room(path: readonly { x: number; z: number }[], step: number, perCell: number, r: number) {
    const mine = this.mine.fill(0);
    for (let i = 1; i < path.length - PATH_GRACE; i++) cellsNear(path[i - 1].x, path[i - 1].z, path[i].x, path[i].z, r, (c) => (mine[c] = 1));
    const end = path[path.length - 1];
    return this.flood(this.arrive, [cellOf(end.x, end.z)], step, perCell, ROOM_CAP, (c) => mine[c] === 1);
  }
}

/** Where a head running straight on is after each STRIDE steps (the bot's guess at a rival). */
function straight(head: TrailHead, from: number, steps: number) {
  const out: { x: number; z: number }[] = [],
    h = { ...head };
  for (let s = 1; s <= steps; s++) {
    steer(h, undefined, from + s);
    if (s % STRIDE === 0) out.push({ x: h.x, z: h.z });
  }
  return out;
}

/**
 * A Işık İzi bot: every few steps it tries each of the nine key choices (none and the eight
 * directions), running the real turning and speed ahead, and keeps the one that stays clear of
 * walls, trails (those faded by then do not count), rivals' heads and their way just ahead, and
 * the rail while its warning is on. Orta and Zor also weigh the room left where a choice ends
 * (its own new trail included), so they keep out of pockets; ties go to turning less. Zor looks
 * further and, when it is safe and roomy, runs across a rival's way just ahead of it to cut it
 * off. Kolay looks less far, decides slower, sometimes picks loosely and now and then forgets
 * its own trail.
 */
export class TrailBot {
  private readonly tuning: Tuning;
  private choice: TrailInput = { x: 0, z: 0 };
  private wait = 0;
  private forgetUntil = -1;
  /** The latest decision's choices with how long each stays clear and its score (tests, debugging). */
  last: { choice: TrailInput; survive: number; score: number }[] = [];
  constructor(readonly level: TrailBotLevel, readonly lane: number, private readonly random: () => number = Math.random) {
    this.tuning = TRAIL_BOT_TUNING[level];
  }
  input(game: TrailGame): TrailInput {
    const me = game.players[this.lane];
    if (game.phase !== "playing" || !me?.alive || me.out) return { x: 0, z: 0 };
    if (--this.wait > 0) return this.choice;
    this.wait = this.tuning.think;
    this.choice = this.decide(game);
    return this.choice;
  }
  private decide(game: TrailGame): TrailInput {
    const t = this.tuning,
      now = game.ticks,
      me = game.players[this.lane],
      touch = L.radius + L.trailRadius,
      reach = touch + t.margin;
    if (t.careless && now >= this.forgetUntil && this.random() < t.careless) this.forgetUntil = now + t.forget;
    const forgetting = now < this.forgetUntil;
    const wall = { x: HALF_X - L.radius - t.margin, z: HALF_Z - L.radius - t.margin };
    const room = t.room ? new RoomMap(wall) : null;
    // What can be hit: every visible trail (its own beyond the grace, unless it forgot it), and
    // each rival's way just ahead from when it would lay it, plus the rival itself.
    const grid = new Grid(reach + L.radius);
    game.lines.forEach((line, j) => {
      const p = game.players[j],
        self = j === this.lane,
        head = p.alive && !p.out ? p : null,
        until = (tb: number) => (p.died >= 0 ? Math.min(tb + LIFE, p.died + DEATH_FADE) : tb + LIFE);
      if (!(self && forgetting)) visitTrail(line, p.died, now, head, self ? L.selfGrace : 0, (ax, az, bx, bz, _ta, tb) => grid.add({ ax, az, bx, bz, from: -Infinity, to: until(tb) }));
      if (room) visitTrail(line, p.died, now, head, ROOM_GRACE, (ax, az, bx, bz, _ta, tb) => room.add(ax, az, bx, bz, until(tb), touch + RC / 2));
    });
    const rivals = game.players.flatMap((p, j) => (j !== this.lane && p.alive && !p.out ? [{ head: p, path: straight(p, now, t.horizon + 40) }] : []));
    for (const r of rivals) {
      let px = r.head.x,
        pz = r.head.z;
      r.path.slice(0, RIVAL_AHEAD / STRIDE).forEach((q, k) => {
        grid.add({ ax: px, az: pz, bx: q.x, bz: q.z, from: now + (k + 1) * STRIDE + 4, to: Infinity });
        px = q.x;
        pz = q.z;
      });
    }
    // The rail while a warning is on (or the train runs): shut from a little before it enters until its tail is out.
    const train = trainState(now),
      shut = train.phase === "warn" || train.phase === "run" ? { from: trainEnter(train.k) - 8, to: trainLeave(train.k) + 4 } : null,
      railZ = L.train.halfWidth + L.radius + t.margin;
    if (room && shut) room.band(railZ, shut.to);
    const perCell = RC / (speedAt(now) / L.hz);

    const results = CHOICES.map((choice) => {
      const h: TrailHead = { x: me.x, z: me.z, a: me.a },
        samples: { x: number; z: number }[] = [{ x: me.x, z: me.z }];
      let survive = t.horizon;
      for (let s = 1; s <= t.horizon; s++) {
        steer(h, choice, now + s);
        if (s % STRIDE) continue;
        samples.push({ x: h.x, z: h.z });
        const step = now + s,
          hit =
            Math.abs(h.x) > wall.x ||
            Math.abs(h.z) > wall.z ||
            (shut && step >= shut.from && step < shut.to && Math.abs(h.z) < railZ) ||
            grid.hits(h.x, h.z, step, reach) ||
            (s <= RIVAL_AHEAD &&
              rivals.some((r) => {
                const q = r.path[s / STRIDE - 1];
                return !!q && Math.hypot(q.x - h.x, q.z - h.z) < 2 * L.radius + t.margin + 0.3;
              }));
        if (hit) {
          survive = s - STRIDE;
          break;
        }
      }
      let score = survive * 10;
      // The room where the clear part ends (a long run into a pocket is a trap too).
      const clear = samples.slice(0, survive / STRIDE + 1),
        cells = room && survive >= ROOM_FROM ? room.room(clear, now + survive, perCell, touch + RC / 2) : 0;
      score += cells * 0.6;
      if (survive >= t.horizon) {
        score += this.space(h, grid, now + t.horizon, wall, shut, railZ) * 3;
        if (t.hunt && cells >= HUNT_ROOM) score += t.hunt * this.cut(samples, rivals);
      }
      // Turn less: the choice's direction against the current heading (none pressed: no turn at all).
      if (choice.x || choice.z) {
        const target = Math.atan2(choice.z, choice.x);
        score -= Math.abs(Math.atan2(Math.sin(target - me.a), Math.cos(target - me.a))) * 4;
      }
      if (choice.x === this.choice.x && choice.z === this.choice.z) score += 3;
      return { choice, survive, score };
    });
    this.last = results;
    if (t.noise && this.random() < t.noise) {
      const loose = results.filter((r) => r.survive >= t.horizon / 2);
      if (loose.length) return loose[Math.floor(this.random() * loose.length)].choice;
    }
    return results.reduce((a, b) => (b.score > a.score ? b : a)).choice;
  }
  /** How well a choice runs across a rival's way just ahead of it (0 none … 1 right in front of it). */
  private cut(samples: readonly { x: number; z: number }[], rivals: readonly { path: readonly { x: number; z: number }[] }[]) {
    let best = 0;
    for (const r of rivals)
      samples.forEach((p, k) => {
        // The rival comes past this point 0.1–0.7 s after us: our trail lies in its way.
        for (let u = k + 2; u < Math.min(r.path.length, k + 21); u++) {
          const q = r.path[u];
          if (Math.hypot(q.x - p.x, q.z - p.z) < 1) best = Math.max(best, 1 - (u - k) / 24);
        }
      });
    return best;
  }
  /** Open room round the end of a choice: how far a head could run on in five directions (m, capped). */
  private space(h: TrailHead, grid: Grid, step: number, wall: { x: number; z: number }, shut: { from: number; to: number } | null, railZ: number) {
    let total = 0;
    for (const turn of [0, -0.8, 0.8, -1.6, 1.6]) {
      const a = h.a + turn,
        cx = Math.cos(a),
        cz = Math.sin(a);
      let d = 0;
      for (; d < 8; d += 0.5) {
        const x = h.x + cx * d,
          z = h.z + cz * d;
        if (Math.abs(x) > wall.x || Math.abs(z) > wall.z || grid.hits(x, z, step, L.radius + L.trailRadius) || (shut && step < shut.to && Math.abs(z) < railZ)) break;
      }
      total += turn === 0 ? d * 1.5 : d;
    }
    return total;
  }
}
