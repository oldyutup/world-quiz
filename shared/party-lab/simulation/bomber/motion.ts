import { BOMBER as B } from "./config.js";
import { EDGES, OUTER, RINGS, SECTOR_ANGLE, adjacent, angleOf, cellAt, cellIndex, ringOf, sectorOf } from "./arena.js";

/** A walker's centre on the ground plane. */
export interface Point {
  x: number;
  z: number;
}
/** Whether a cell stops this walker (pillar, box, fallen cell, a bomb it may not cross). */
export type Solid = (cell: number) => boolean;

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const SKIN = 0.004;

/**
 * How a circle of `radius` at (x, z) overlaps the cell: the depth and the unit normal that
 * pushes it out, or null when it does not touch. Cells are ring sectors: the closest point is
 * on an arc (same angle) or on a straight side (along the ray).
 */
export function cellContact(cell: number, x: number, z: number, radius: number): { depth: number; nx: number; nz: number } | null {
  const ring = ringOf(cell),
    r0 = EDGES[ring],
    r1 = EDGES[ring + 1],
    a0 = sectorOf(cell) * SECTOR_ANGLE,
    a1 = a0 + SECTOR_ANGLE,
    half = SECTOR_ANGLE / 2;
  const r = Math.hypot(x, z),
    angle = Math.atan2(z, x),
    off = wrap(angle - (a0 + half));
  let cx: number, cz: number;
  if (Math.abs(off) <= half) {
    if (r >= r0 && r <= r1) {
      // Inside: out through the nearest side.
      const ux = x / r,
        uz = z / r,
        from = off + half;
      const sides = [
        { d: r - r0, nx: -ux, nz: -uz },
        { d: r1 - r, nx: ux, nz: uz },
        { d: r * Math.sin(from), nx: Math.sin(a0), nz: -Math.cos(a0) },
        { d: r * Math.sin(SECTOR_ANGLE - from), nx: -Math.sin(a1), nz: Math.cos(a1) },
      ];
      let best = sides[0];
      for (const side of sides) if (side.d < best.d) best = side;
      return { depth: best.d + radius, nx: best.nx, nz: best.nz };
    }
    const to = r < r0 ? r0 : r1;
    cx = (x / r) * to;
    cz = (z / r) * to;
  } else {
    const edge = off > 0 ? a1 : a0,
      ux = Math.cos(edge),
      uz = Math.sin(edge),
      t = Math.min(r1, Math.max(r0, x * ux + z * uz));
    cx = t * ux;
    cz = t * uz;
  }
  const dx = x - cx,
    dz = z - cz,
    d = Math.hypot(dx, dz);
  if (d >= radius) return null;
  if (d < 1e-9) return { depth: radius, nx: x / r, nz: z / r };
  return { depth: radius - d, nx: dx / d, nz: dz / d };
}
/** The circle overlaps the cell. */
export const overlapsCell = (cell: number, x: number, z: number, radius = B.radius) => cellContact(cell, x, z, radius) !== null;

/** Cells close enough to touch a walker at (x, z). */
function nearby(x: number, z: number): number[] {
  const r = Math.hypot(x, z);
  let ring = 0;
  while (ring < RINGS - 1 && r >= EDGES[ring + 1]) ring++;
  const sector = Math.floor(angleOf(x, z) / SECTOR_ANGLE),
    out: number[] = [];
  for (let rr = Math.max(0, ring - 1); rr <= Math.min(RINGS - 1, ring + 1); rr++) for (let s = sector - 2; s <= sector + 2; s++) out.push(cellIndex(rr, s));
  return out;
}
/** The hub and the outer wall, as push-outs. */
function bounds(p: Point, radius: number) {
  const r = Math.hypot(p.x, p.z);
  const inner = EDGES[0] + radius,
    outer = OUTER - radius;
  if (r < 1e-9) {
    p.x = inner;
    return;
  }
  if (r < inner || r > outer) {
    const to = r < inner ? inner : outer;
    p.x = (p.x / r) * to;
    p.z = (p.z / r) * to;
  }
}
/** Pushes the walker out of every solid cell it overlaps (a few passes settle corners). */
export function resolve(p: Point, solid: Solid, radius = B.radius) {
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const cell of nearby(p.x, p.z)) {
      if (!solid(cell)) continue;
      const hit = cellContact(cell, p.x, p.z, radius);
      if (!hit) continue;
      p.x += hit.nx * hit.depth;
      p.z += hit.nz * hit.depth;
      moved = true;
    }
    bounds(p, radius);
    if (!moved) break;
  }
}
/** Outward normals of the solids (and walls) the walker is touching. */
function touching(p: Point, solid: Solid, radius: number) {
  const normals: { nx: number; nz: number }[] = [];
  for (const cell of nearby(p.x, p.z)) {
    if (!solid(cell)) continue;
    const hit = cellContact(cell, p.x, p.z, radius + SKIN);
    if (hit) normals.push(hit);
  }
  const r = Math.hypot(p.x, p.z);
  if (r > 1e-9) {
    if (r <= EDGES[0] + radius + SKIN) normals.push({ nx: p.x / r, nz: p.z / r });
    if (r >= OUTER - radius - SKIN) normals.push({ nx: -p.x / r, nz: -p.z / r });
  }
  return normals;
}
/**
 * Pressed into a wall beside an opening (a corridor between pillars): the sideways
 * direction that slides the walker into it, or null. Bomberman's corner help, so a walker
 * need not line up to the centimetre with a gap it is pressing towards.
 */
function cornerHelp(p: Point, ux: number, uz: number, solid: Solid, radius: number) {
  const here = cellAt(p.x, p.z),
    px = -uz,
    pz = ux,
    reach = radius + 0.3;
  for (const k of [0.12, 0.24, 0.36, 0.48])
    for (const side of [1, -1]) {
      const cell = cellAt(p.x + ux * reach + px * k * side, p.z + uz * reach + pz * k * side);
      if (cell < 0 || cell === here || solid(cell) || !adjacent(here, cell)) continue;
      return { x: px * side, z: pz * side };
    }
  return null;
}

/**
 * One fixed step of walking: `dir` (length ≤ 1, world axes) at `B.speed` for `dt` s, in two
 * halves. Against a wall it slides along it at full speed (unless pressed nearly straight
 * into it, then corner help); it never ends inside a solid cell, the hub or past the edge.
 * Pure and deterministic: the server and a client's prediction run exactly this.
 */
export function walk(p: Point, dir: Point, solid: Solid, dt: number, radius = B.radius) {
  const length = Math.hypot(dir.x, dir.z);
  if (!(length > 1e-6)) return;
  const ux = dir.x / length,
    uz = dir.z / length,
    want = (B.speed * dt * Math.min(1, length)) / 2;
  for (let half = 0; half < 2; half++) {
    let dx = ux * want,
      dz = uz * want;
    const normals = touching(p, solid, radius);
    for (let pass = 0; pass < 2; pass++)
      for (const n of normals) {
        const dot = dx * n.nx + dz * n.nz;
        if (dot < 0) {
          dx -= dot * n.nx;
          dz -= dot * n.nz;
        }
      }
    const got = Math.hypot(dx, dz);
    if (got < want * 0.3) {
      const help = cornerHelp(p, ux, uz, solid, radius);
      if (help) {
        dx = help.x * want;
        dz = help.z * want;
      }
    } else if (got < want) {
      dx *= want / got;
      dz *= want / got;
    }
    p.x += dx;
    p.z += dz;
    resolve(p, solid, radius);
  }
}
