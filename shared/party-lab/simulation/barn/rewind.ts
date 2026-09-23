import type { PlaygroundPhysics } from "../physics.js";
import { PLAYERS, type PlayerId } from "../players.js";
import { PARTS, SHAPES, type PartName } from "../ragdoll/config.js";
import type { Vec } from "../ragdoll/math.js";

/**
 * Lag compensation for Barn hitscan (server only). A client aims at remote players
 * drawn ~100 ms in the past (interpolation) and its shot reaches the server another
 * half round trip later. The server keeps a short history of every character's nine
 * hit volumes per tick and resolves a shot against the poses at the tick the shooter
 * was looking at — bounded to `maxTicks` (≈ 250 ms) and never later than a snapshot
 * the client could have received.
 *
 * Only the characters' capsules are rewound, analytically: the Rapier world is never
 * stepped back. Walls, decks, rails and cover are always tested in the current world,
 * as are pickups and traps. Dead bodies and the shooter are never hittable.
 */
export const REWIND = {
  /** Ticks kept (a little more than the 15-tick / 250 ms maximum rewind). */
  historyTicks: 24,
} as const;
const POSE_FLOATS = PARTS.length * 7;

export interface PoseFrame {
  tick: number;
  /** Per slot: 9 parts × (x, y, z, qx, qy, qz, qw). */
  poses: Float32Array;
  /** Per slot: whether the character could be hit at that tick (alive, in play). */
  hittable: boolean[];
  /** Per slot: life counter; poses of different lives are never blended. */
  lives: number[];
}
/** Poses a shot is resolved against (one tick, or a blend of two neighbours). */
export interface HistoricView {
  tick: number;
  poses: Float32Array;
  hittable: boolean[];
}
export interface HistoricHit {
  id: PlayerId;
  part: PartName;
  distance: number;
}

export class PoseHistory {
  private readonly frames: PoseFrame[] = Array.from({ length: REWIND.historyTicks }, () => ({
    tick: -1,
    poses: new Float32Array(PLAYERS.length * POSE_FLOATS),
    hittable: PLAYERS.map(() => false),
    lives: PLAYERS.map(() => 0),
  }));
  private head = -1;
  /** Newest recorded tick (−1 before the first). */
  latest = -1;
  clear() {
    for (const f of this.frames) f.tick = -1;
    this.head = this.latest = -1;
  }
  /** After the physics step of `tick`: the poses a snapshot of this tick shows. */
  record(tick: number, physics: PlaygroundPhysics, hittable: (id: PlayerId) => boolean, lives: readonly number[]) {
    this.head = (this.head + 1) % this.frames.length;
    const frame = this.frames[this.head];
    frame.tick = tick;
    let o = 0;
    for (const player of physics.players) {
      frame.hittable[player.id] = !player.eliminated && hittable(player.id);
      frame.lives[player.id] = lives[player.id];
      for (const name of PARTS) {
        const body = player.parts[name].body,
          p = body.translation(),
          q = body.rotation();
        frame.poses[o++] = p.x;
        frame.poses[o++] = p.y;
        frame.poses[o++] = p.z;
        frame.poses[o++] = q.x;
        frame.poses[o++] = q.y;
        frame.poses[o++] = q.z;
        frame.poses[o++] = q.w;
      }
    }
    this.latest = tick;
  }
  frame(tick: number): PoseFrame | null {
    if (this.head < 0) return null;
    const back = this.latest - tick;
    if (!Number.isInteger(back) || back < 0 || back >= this.frames.length) return null;
    const f = this.frames[(this.head - back + this.frames.length) % this.frames.length];
    return f.tick === tick ? f : null;
  }
  /**
   * Poses at a (fractional) tick inside the history. Neighbouring ticks are blended
   * (positions linearly, orientations normalised) unless a character changed life
   * between them (respawn teleport): then the later tick is used for it.
   */
  view(tick: number, out?: HistoricView): HistoricView | null {
    const lo = Math.floor(tick),
      a = this.frame(lo);
    if (!a) return null;
    const t = tick - lo,
      b = t > 1e-6 ? this.frame(lo + 1) : null;
    const view = out ?? { tick, poses: new Float32Array(PLAYERS.length * POSE_FLOATS), hittable: PLAYERS.map(() => false) };
    view.tick = tick;
    if (!b) {
      view.poses.set(a.poses);
      for (const { id } of PLAYERS) view.hittable[id] = a.hittable[id];
      return view;
    }
    for (const { id } of PLAYERS) {
      const same = a.lives[id] === b.lives[id],
        base = id * POSE_FLOATS;
      view.hittable[id] = same ? a.hittable[id] && b.hittable[id] : b.hittable[id];
      for (let i = 0; i < PARTS.length; i++) {
        const k = base + i * 7;
        if (!same) {
          for (let j = 0; j < 7; j++) view.poses[k + j] = b.poses[k + j];
          continue;
        }
        for (let j = 0; j < 3; j++) view.poses[k + j] = a.poses[k + j] + (b.poses[k + j] - a.poses[k + j]) * t;
        // Quaternion nlerp along the short way; neighbouring ticks are close.
        const sign = a.poses[k + 3] * b.poses[k + 3] + a.poses[k + 4] * b.poses[k + 4] + a.poses[k + 5] * b.poses[k + 5] + a.poses[k + 6] * b.poses[k + 6] < 0 ? -1 : 1;
        let n = 0;
        for (let j = 3; j < 7; j++) {
          view.poses[k + j] = a.poses[k + j] + (sign * b.poses[k + j] - a.poses[k + j]) * t;
          n += view.poses[k + j] ** 2;
        }
        n = Math.sqrt(n) || 1;
        for (let j = 3; j < 7; j++) view.poses[k + j] /= n;
      }
    }
    return view;
  }
}

/** Distance along a unit ray to a sphere, or null. */
function raySphere(o: Vec, d: Vec, c: Vec, r: number): number | null {
  const mx = o.x - c.x,
    my = o.y - c.y,
    mz = o.z - c.z;
  const b = mx * d.x + my * d.y + mz * d.z,
    cc = mx * mx + my * my + mz * mz - r * r;
  if (cc > 0 && b > 0) return null;
  const disc = b * b - cc;
  if (disc < 0) return null;
  return Math.max(0, -b - Math.sqrt(disc));
}
/**
 * Distance along a unit ray to a capsule (segment a–b, radius r), or null. Standard
 * closest-approach test: the cylinder body first, then the two end caps.
 */
export function rayCapsule(o: Vec, d: Vec, a: Vec, b: Vec, r: number): number | null {
  const ba = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z },
    oa = { x: o.x - a.x, y: o.y - a.y, z: o.z - a.z };
  const baba = ba.x * ba.x + ba.y * ba.y + ba.z * ba.z;
  if (baba < 1e-12) return raySphere(o, d, a, r);
  const bard = ba.x * d.x + ba.y * d.y + ba.z * d.z,
    baoa = ba.x * oa.x + ba.y * oa.y + ba.z * oa.z,
    rdoa = d.x * oa.x + d.y * oa.y + d.z * oa.z,
    oaoa = oa.x * oa.x + oa.y * oa.y + oa.z * oa.z;
  const A = baba - bard * bard,
    B = baba * rdoa - baoa * bard,
    C = baba * oaoa - baoa * baoa - r * r * baba;
  // Inside the capsule already: hit at the origin.
  const s = Math.max(0, Math.min(1, baoa / baba)),
    inside = (oa.x - ba.x * s) ** 2 + (oa.y - ba.y * s) ** 2 + (oa.z - ba.z * s) ** 2 <= r * r;
  if (inside) return 0;
  if (Math.abs(A) > 1e-12) {
    const h = B * B - A * C;
    if (h < 0) return null;
    const t = (-B - Math.sqrt(h)) / A,
      y = baoa + t * bard;
    if (t >= 0 && y > 0 && y < baba) return t;
  }
  const ta = raySphere(o, d, a, r),
    tb = raySphere(o, d, b, r);
  if (ta === null) return tb;
  if (tb === null) return ta;
  return Math.min(ta, tb);
}
/** Segment ends of a part's capsule (body-local ±Y × half) from a stored pose. */
function segment(poses: Float32Array, k: number, half: number) {
  const x = poses[k],
    y = poses[k + 1],
    z = poses[k + 2],
    qx = poses[k + 3],
    qy = poses[k + 4],
    qz = poses[k + 5],
    qw = poses[k + 6];
  // Rotate (0, half, 0) by q.
  const ux = 2 * (qx * qy - qw * qz) * half,
    uy = (1 - 2 * (qx * qx + qz * qz)) * half,
    uz = 2 * (qy * qz + qw * qx) * half;
  return [
    { x: x - ux, y: y - uy, z: z - uz },
    { x: x + ux, y: y + uy, z: z + uz },
  ] as const;
}
/**
 * Nearest historical character part along a unit ray within `range`, skipping the
 * shooter and anything not hittable (by the view or `alsoHittable`, the current state).
 */
export function castHistoric(
  view: HistoricView,
  origin: Vec,
  direction: Vec,
  range: number,
  shooter: PlayerId,
  alsoHittable: (id: PlayerId) => boolean
): HistoricHit | null {
  let best: HistoricHit | null = null;
  for (const { id } of PLAYERS) {
    if (id === shooter || !view.hittable[id] || !alsoHittable(id)) continue;
    const base = id * POSE_FLOATS;
    // Cheap reject: the whole character fits in a 1.6 m sphere around the torso.
    const torso = base + 7;
    const coarse = raySphere(origin, direction, { x: view.poses[torso], y: view.poses[torso + 1] + 0.2, z: view.poses[torso + 2] }, 1.6);
    if (coarse === null || coarse > range) continue;
    PARTS.forEach((name, i) => {
      const shape = SHAPES[name],
        [a, b] = segment(view.poses, base + i * 7, shape.half),
        t = rayCapsule(origin, direction, a, b, shape.radius);
      if (t !== null && t <= range && (!best || t < best.distance)) best = { id, part: name, distance: t };
    });
  }
  return best;
}
