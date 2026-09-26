import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshLambertMaterial } from "three";
import {
  CRATE_STEP,
  ENTRY_STEP_HEIGHT,
  ENTRY_STEPS,
  FIRE_PIT,
  LEAN_TO,
  LODGE,
  LODGE_INSIDE,
  LOFT,
  PAVILION,
  PAVILION_POSTS,
  PICNIC,
  PICNIC_TABLES,
  PLAZA,
  PORCH,
  PORCH_POST_Z,
  PORCH_POSTS,
  SHED,
  SHED_INSIDE,
  STAIR,
  WOODPILE,
  wallColliders,
  type WallId,
} from "../../../../shared/party-lab/maps/propHunt";
import type { BoxCollider } from "../../../../shared/party-lab/maps/types";

/**
 * "Orman Kampı" gameplay geometry, generated from the shared map data (maps/propHunt.ts) so
 * what you see is what you collide with: one vertex-coloured, flat-shaded Lambert mesh (the
 * ground and paths, the lodge's log walls, floors, loft deck, ceiling and roof, the porch,
 * lean-to, woodpile backing, shed, pavilion, picnic tables, fire ring, steps, the lodge's stair
 * and chimney) and one transparent mesh (the window glass). No textures, no shadows. Doors,
 * window frames, rails, furniture and every prop come from the kit (scenery.ts).
 */
type V = readonly [number, number, number];
type Span = readonly [number, number];
const PALETTE = {
  grassA: "#94c26d",
  grassB: "#8aba64",
  grassC: "#9ec877",
  dirt: "#cfae80",
  dirtDark: "#bf9d70",
  gravel: "#c9bda9",
  logA: "#a8703f",
  logB: "#976232",
  logInA: "#c99a64",
  logInB: "#bb8b56",
  corner: "#7c5230",
  plankA: "#cf9f66",
  plankB: "#c19159",
  plankDark: "#8e6139",
  deckEdge: "#7d5433",
  stone: "#a7a095",
  stoneDark: "#8c857a",
  roofA: "#6b7a52",
  roofB: "#617048",
  roofEdge: "#4e3a28",
  ceiling: "#b88752",
  boardA: "#a2714a",
  boardB: "#946643",
  post: "#855a36",
  table: "#b9864f",
  tableDark: "#a07142",
  ash: "#5d5752",
  glass: "#cfeaf5",
} as const;
const color = (hex: string) => new Color(hex);
const shade = (c: Color, k: number) => c.clone().multiplyScalar(k);

class Mesher {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  /** A planar quad, corners counter-clockwise seen from its front. */
  quad(a: V, b: V, c: V, d: V, tint: Color) {
    const n = newell([a, b, c, d]);
    for (const p of [a, b, c, a, c, d]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.colors.push(tint.r, tint.g, tint.b);
    }
  }
  tri(a: V, b: V, c: V, tint: Color) {
    const n = newell([a, b, c]);
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.colors.push(tint.r, tint.g, tint.b);
    }
  }
  /** Axis-aligned box; `faces` picks a colour per face (null: skip it). */
  box(min: V, max: V, faces: (face: Face) => Color | null) {
    const [x0, y0, z0] = min,
      [x1, y1, z1] = max;
    const f = (name: Face, a: V, b: V, c: V, d: V) => {
      const tint = faces(name);
      if (tint) this.quad(a, b, c, d, tint);
    };
    f("top", [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    f("bottom", [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    f("px", [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    f("nx", [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    f("pz", [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    f("nz", [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
  }
  /**
   * A vertical face (bottom edge a→b, counter-clockwise from its front) from y0 to y1, cut into
   * horizontal bands at world multiples of `band` (log courses line up across wall pieces).
   */
  courses(a: readonly [number, number], b: readonly [number, number], y0: number, y1: number, band: number, tint: (k: number) => Color) {
    let y = y0;
    while (y < y1 - 1e-6) {
      const k = Math.floor(y / band + 1e-6),
        next = Math.min(y1, (k + 1) * band);
      this.quad([a[0], y, a[1]], [b[0], y, b[1]], [b[0], next, b[1]], [a[0], next, a[1]], tint(k));
      y = next;
    }
  }
  /** Vertical boards: a vertical face (bottom edge a→b, counter-clockwise from its front) cut at world multiples of `band` along its length. */
  boards(a: readonly [number, number], b: readonly [number, number], y0: number, y1: number, band: number, tint: (k: number) => Color) {
    const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]),
      s0 = alongX ? a[0] : a[1],
      s1 = alongX ? b[0] : b[1],
      lo = Math.min(s0, s1),
      hi = Math.max(s0, s1),
      cuts = [lo];
    for (let k = Math.floor(lo / band) + 1; k * band < hi - 1e-6; k++) cuts.push(k * band);
    cuts.push(hi);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const k = Math.floor((cuts[i] + 1e-6) / band),
        [p, q] = s1 >= s0 ? [cuts[i], cuts[i + 1]] : [cuts[i + 1], cuts[i]],
        P = alongX ? [p, a[1]] : [a[0], p],
        Q = alongX ? [q, a[1]] : [a[0], q];
      this.quad([P[0], y0, P[1]], [Q[0], y0, Q[1]], [Q[0], y1, Q[1]], [P[0], y1, P[1]], tint(k));
    }
  }
  /** A polygon (3 or 4 corners, any order around it) facing `outward`. */
  faced(points: readonly V[], outward: V, tint: Color) {
    const n = newell(points),
      flip = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0,
      pts = flip ? [...points].reverse() : points;
    if (pts.length === 3) this.tri(pts[0], pts[1], pts[2], tint);
    else this.quad(pts[0], pts[1], pts[2], pts[3], tint);
  }
  /** A flat mark on a horizontal surface at height y (slightly above it), facing up whatever the corner order. */
  decal(points: readonly [number, number][], y: number, tint: Color) {
    const pts = points.map(([x, z]): V => [x, y, z]);
    for (let k = 1; k + 1 < pts.length; k++) {
      const tri = [pts[0], pts[k], pts[k + 1]] as const;
      if (newell([...tri])[1] > 0) this.tri(tri[0], tri[1], tri[2], tint);
      else this.tri(tri[2], tri[1], tri[0], tint);
    }
  }
  build() {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }
  get triangles() {
    return this.positions.length / 9;
  }
}
type Face = "top" | "bottom" | "px" | "nx" | "pz" | "nz";

/** Unit normal of a polygon by Newell's method, from its winding. */
function newell(points: readonly V[]): [number, number, number] {
  let x = 0,
    y = 0,
    z = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length];
    x += (p[1] - q[1]) * (p[2] + q[2]);
    y += (p[2] - q[2]) * (p[0] + q[0]);
    z += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
/** Deterministic 0…1 hash of a grid cell (ground colour variation). */
const hash = (i: number, j: number) => {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const bounds = (c: BoxCollider) => ({
  x0: c.center.x - c.half.x,
  x1: c.center.x + c.half.x,
  y0: c.center.y - c.half.y,
  y1: c.center.y + c.half.y,
  z0: c.center.z - c.half.z,
  z1: c.center.z + c.half.z,
});

// ─── Pieces ────────────────────────────────────────────────────────────────

/** The ground: grass in 2 m cells of three tones, out to the treeline and beyond. */
function ground(m: Mesher) {
  const tones = [color(PALETTE.grassA), color(PALETTE.grassB), color(PALETTE.grassC)],
    R = 40,
    cell = 2;
  for (let i = -R / cell; i < R / cell; i++)
    for (let j = -R / cell; j < R / cell; j++) {
      const x0 = i * cell,
        z0 = j * cell,
        tone = tones[Math.floor(hash(i, j) * 3)];
      m.quad([x0, 0, z0 + cell], [x0 + cell, 0, z0 + cell], [x0 + cell, 0, z0], [x0, 0, z0], tone);
    }
}
/** A dirt path of width `w` along a polyline (flat quads just above the grass). */
function path(m: Mesher, points: readonly [number, number][], w: number, tint: Color, y = 0.006) {
  for (let k = 0; k + 1 < points.length; k++) {
    const [ax, az] = points[k],
      [bx, bz] = points[k + 1],
      l = Math.hypot(bx - ax, bz - az),
      px = (-(bz - az) / l) * (w / 2),
      pz = ((bx - ax) / l) * (w / 2);
    m.decal(
      [
        [ax + px, az + pz],
        [bx + px, bz + pz],
        [bx - px, bz - pz],
        [ax - px, az - pz],
      ],
      y,
      tint
    );
  }
}
function disc(m: Mesher, x: number, z: number, r: number, tint: Color, y = 0.008, sides = 24) {
  const pts: [number, number][] = Array.from({ length: sides }, (_, k) => [x + Math.cos((k / sides) * Math.PI * 2) * r, z + Math.sin((k / sides) * Math.PI * 2) * r]);
  m.decal(pts, y, tint);
}

/** A log wall piece: horizontal courses (0.3 m) outside and in, end grain on its cut faces. */
function logWall(m: Mesher, c: BoxCollider, along: "x" | "z", inside: "+" | "-", band = 0.3) {
  const b = bounds(c),
    outA = color(PALETTE.logA),
    outB = color(PALETTE.logB),
    inA = color(PALETTE.logInA),
    inB = color(PALETTE.logInB),
    end = color(PALETTE.corner);
  const out = (k: number) => (k % 2 ? outB : outA),
    ins = (k: number) => (k % 2 ? inB : inA);
  if (along === "x") {
    // Faces +z and −z are the long sides.
    const plus = inside === "+" ? ins : out,
      minus = inside === "+" ? out : ins;
    m.courses([b.x0, b.z1], [b.x1, b.z1], b.y0, b.y1, band, plus);
    m.courses([b.x1, b.z0], [b.x0, b.z0], b.y0, b.y1, band, minus);
    m.box([b.x0, b.y0, b.z0], [b.x1, b.y1, b.z1], (f) => (f === "px" || f === "nx" ? end : f === "top" ? shade(end, 1.1) : f === "bottom" ? shade(end, 0.9) : null));
  } else {
    const plus = inside === "+" ? ins : out,
      minus = inside === "+" ? out : ins;
    m.courses([b.x1, b.z1], [b.x1, b.z0], b.y0, b.y1, band, plus);
    m.courses([b.x0, b.z0], [b.x0, b.z1], b.y0, b.y1, band, minus);
    m.box([b.x0, b.y0, b.z0], [b.x1, b.y1, b.z1], (f) => (f === "pz" || f === "nz" ? end : f === "top" ? shade(end, 1.1) : f === "bottom" ? shade(end, 0.9) : null));
  }
}
/** A board wall piece (the shed, the lean-to): vertical boards. */
function boardWall(m: Mesher, c: BoxCollider, along: "x" | "z") {
  const b = bounds(c),
    a = color(PALETTE.boardA),
    bb = color(PALETTE.boardB),
    tint = (k: number) => (k % 2 ? bb : a),
    inner = (k: number) => shade(tint(k), 1.12),
    end = color(PALETTE.deckEdge);
  if (along === "x") {
    m.boards([b.x0, b.z1], [b.x1, b.z1], b.y0, b.y1, 0.25, tint);
    m.boards([b.x1, b.z0], [b.x0, b.z0], b.y0, b.y1, 0.25, inner);
  } else {
    m.boards([b.x1, b.z1], [b.x1, b.z0], b.y0, b.y1, 0.25, tint);
    m.boards([b.x0, b.z0], [b.x0, b.z1], b.y0, b.y1, 0.25, inner);
  }
  m.box([b.x0, b.y0, b.z0], [b.x1, b.y1, b.z1], (f) => (f === "top" || f === "bottom" ? end : along === "x" ? (f === "px" || f === "nx" ? end : null) : f === "pz" || f === "nz" ? end : null));
}
/** A plank deck top with boards running along `along` (0.3 m), plain sides. */
function deck(m: Mesher, x: Span, z: Span, y0: number, y1: number, along: "x" | "z", side: Color, underside: Color | null = null) {
  const a = color(PALETTE.plankA),
    b = color(PALETTE.plankB);
  if (along === "x") {
    let k = Math.floor(z[0] / 0.3);
    for (let zz = z[0]; zz < z[1] - 1e-6; k++) {
      const next = Math.min(z[1], (k + 1) * 0.3);
      m.quad([x[0], y1, next], [x[1], y1, next], [x[1], y1, zz], [x[0], y1, zz], k % 2 ? b : a);
      zz = next;
    }
  } else {
    let k = Math.floor(x[0] / 0.3);
    for (let xx = x[0]; xx < x[1] - 1e-6; k++) {
      const next = Math.min(x[1], (k + 1) * 0.3);
      m.quad([xx, y1, z[1]], [next, y1, z[1]], [next, y1, z[0]], [xx, y1, z[0]], k % 2 ? b : a);
      xx = next;
    }
  }
  m.box([x[0], y0, z[0]], [x[1], y1, z[1]], (f) => (f === "top" ? null : f === "bottom" ? underside : f === "nz" || f === "nx" ? shade(side, 0.85) : side));
}
/** A gable roof over a rectangle: ridge along `ridge`, eaves at `eave` on the long sides, gable triangles in wall colour. */
function gableRoof(m: Mesher, x: Span, z: Span, eave: number, top: number, ridge: "x" | "z", overhang: number, gable: Color) {
  const a = color(PALETTE.roofA),
    b = color(PALETTE.roofB),
    edge = color(PALETTE.roofEdge),
    under = shade(color(PALETTE.ceiling), 0.85),
    thick = 0.16;
  // Across (the slope direction) and along (the ridge).
  const across: Span = ridge === "x" ? z : x,
    along: Span = ridge === "x" ? x : z,
    mid = (across[0] + across[1]) / 2,
    halfSpan = (across[1] - across[0]) / 2,
    slope = (top - eave) / halfSpan;
  const P = (acr: number, y: number, al: number): V => (ridge === "x" ? [al, y, acr] : [acr, y, al]);
  const dirAcross = (s: number): V => (ridge === "x" ? [0, 0, s] : [s, 0, 0]),
    dirAlong = (s: number): V => (ridge === "x" ? [s, 0, 0] : [0, 0, s]);
  const lo = along[0] - overhang,
    hi = along[1] + overhang,
    outer = halfSpan + overhang,
    eaveY = top - slope * outer;
  for (const side of [-1, 1]) {
    // Shingle courses down the slope (0.5 m bands).
    const courses = Math.ceil(outer / 0.5);
    for (let k = 0; k < courses; k++) {
      const d0 = (k * outer) / courses,
        d1 = ((k + 1) * outer) / courses,
        c0 = mid + side * d0,
        c1 = mid + side * d1,
        y0 = top - slope * d0 + thick,
        y1 = top - slope * d1 + thick;
      m.faced([P(c0, y0, lo), P(c0, y0, hi), P(c1, y1, hi), P(c1, y1, lo)], [0, 1, 0], k % 2 ? b : a);
    }
    const cE = mid + side * outer;
    // The slope's underside (seen from under the overhang, or inside the pavilion) and the fascia.
    m.faced([P(mid, top, lo), P(mid, top, hi), P(cE, eaveY, hi), P(cE, eaveY, lo)], [0, -1, 0], under);
    m.faced([P(cE, eaveY, lo), P(cE, eaveY, hi), P(cE, eaveY + thick, hi), P(cE, eaveY + thick, lo)], dirAcross(side), edge);
  }
  // Gable triangles on both ends (in the wall plane) and the roof's end edges.
  for (const end of [along[0], along[1]]) {
    const dir = end === along[0] ? -1 : 1;
    m.faced([P(across[0], eave, end), P(across[1], eave, end), P(mid, top, end)], dirAlong(dir), gable);
    const e = end + dir * overhang;
    m.faced([P(mid - outer, eaveY, e), P(mid, top, e), P(mid, top + thick, e), P(mid - outer, eaveY + thick, e)], dirAlong(dir), edge);
    m.faced([P(mid, top, e), P(mid + outer, eaveY, e), P(mid + outer, eaveY + thick, e), P(mid, top + thick, e)], dirAlong(dir), edge);
  }
}

/**
 * The lodge stair's steps, generated from its collider (STAIR: a 26.6° ramp from the great
 * room's floor up to the loft's edge): RISERS equal risers, each tread's nose on the ramp's
 * slope line, so the ramp a body walks on touches every nose and never rises more than one
 * riser above a tread. The last riser is the loft deck's own edge: the top tread meets the loft
 * floor, with no gap and no step that is not there.
 */
export const STAIR_RISERS = 20;
export interface StairStep {
  /** The tread's nose (its low, west edge) and back (where the next riser rises), m. */
  readonly x0: number;
  readonly x1: number;
  /** The tread's top. */
  readonly top: number;
}
export function stairSteps(): StairStep[] {
  const rise = (STAIR.top - STAIR.bottom) / STAIR_RISERS,
    run = (STAIR.x[1] - STAIR.x[0]) / STAIR_RISERS;
  return Array.from({ length: STAIR_RISERS - 1 }, (_, i) => {
    const k = i + 1;
    return { x0: STAIR.x[0] + run * k, x1: STAIR.x[0] + run * (k + 1), top: STAIR.bottom + rise * k };
  });
}
function stair(m: Mesher) {
  const [z0, z1] = STAIR.z,
    steps = stairSteps(),
    rise = (STAIR.top - STAIR.bottom) / STAIR_RISERS,
    a = color(PALETTE.plankA),
    b = color(PALETTE.plankB),
    riser = shade(color(PALETTE.deckEdge), 1.05),
    panel = color(PALETTE.boardA),
    stringer = color(PALETTE.plankDark),
    // The ramp's slope line (through every nose): y at x.
    line = (x: number) => STAIR.bottom + ((x - STAIR.x[0]) * (STAIR.top - STAIR.bottom)) / (STAIR.x[1] - STAIR.x[0]);
  steps.forEach((step, k) => {
    // Tread (a board a little proud of its riser) and the riser under its nose, facing the foot (−x).
    m.quad([step.x0 - 0.02, step.top, z1], [step.x1, step.top, z1], [step.x1, step.top, z0], [step.x0 - 0.02, step.top, z0], k % 2 ? b : a);
    m.quad([step.x0 - 0.02, step.top - 0.04, z1], [step.x0 - 0.02, step.top, z1], [step.x0 - 0.02, step.top, z0], [step.x0 - 0.02, step.top - 0.04, z0], shade(k % 2 ? b : a, 0.8));
    m.quad([step.x0, step.top - rise, z0], [step.x0, step.top - rise, z1], [step.x0, step.top - 0.04, z1], [step.x0, step.top - 0.04, z0], riser);
    // The open side (facing the great room, +z): a board panel under the steps, a dark stringer
    // band along the slope below the noses.
    const band0 = Math.max(STAIR.bottom, line(step.x0) - 0.26),
      band1 = Math.max(STAIR.bottom, line(step.x1) - 0.26);
    for (const z of [z0, z1]) {
      const normal: V = [0, 0, z === z0 ? -1 : 1];
      m.faced([[step.x0, STAIR.bottom, z], [step.x1, STAIR.bottom, z], [step.x1, band1, z], [step.x0, band0, z]], normal, panel);
      m.faced([[step.x0, band0, z], [step.x1, band1, z], [step.x1, step.top, z], [step.x0, step.top, z]], normal, stringer);
    }
  });
  // Close the high end facing the kitchen. The existing solid Rapier wedge already fills
  // this volume; these boards add no collision, width or obstacle to the kitchen route.
  const backBoards = 16;
  for (let i = 0; i < backBoards; i++) {
    const y0 = STAIR.bottom + (STAIR.top - STAIR.bottom) * i / backBoards,
      y1 = STAIR.bottom + (STAIR.top - STAIR.bottom) * (i + 1) / backBoards;
    m.faced([[STAIR.x[1], y0, z0], [STAIR.x[1], y0, z1], [STAIR.x[1], y1, z1], [STAIR.x[1], y1, z0]], [1, 0, 0], i % 2 ? shade(panel, 0.92) : panel);
  }
  m.faced([[STAIR.x[0], STAIR.bottom, z0], [STAIR.x[1], STAIR.bottom, z0], [STAIR.x[1], STAIR.bottom, z1], [STAIR.x[0], STAIR.bottom, z1]], [0, -1, 0], stringer);
  // A threshold board along the loft's edge where the stair arrives, and a newel post at the rail's end.
  m.decal(
    [
      [STAIR.x[1], z0],
      [STAIR.x[1] + 0.22, z0],
      [STAIR.x[1] + 0.22, z1],
      [STAIR.x[1], z1],
    ],
    STAIR.top + 0.004,
    stringer
  );
  m.box([STAIR.x[1], STAIR.top, z1], [STAIR.x[1] + 0.1, STAIR.top + LOFT.railHeight + 0.12, z1 + 0.1], (f) => (f === "bottom" ? null : shade(color(PALETTE.post), f === "nz" || f === "nx" ? 0.85 : 1)));
}

export interface PropArenaMeshes {
  group: Group;
  triangles: number;
  dispose(): void;
}

export function buildPropArena(): PropArenaMeshes {
  const m = new Mesher(),
    glass = new Mesher();
  ground(m);
  // ── Paths and trodden ground ──
  const dirt = color(PALETTE.dirt),
    dirtDark = color(PALETTE.dirtDark),
    gravel = color(PALETTE.gravel);
  disc(m, PLAZA.x, PLAZA.z, PLAZA.radius + 0.4, dirt, 0.007, 28);
  disc(m, -7.2, 4.4, 2.6, dirtDark, 0.006, 20);
  path(m, [[-6.5, 1.05], [-4.6, 2.8], [-3.4, 3.6]], 1.7, dirt);
  path(m, [[1.1, 1.05], [1.9, 2.4]], 1.6, dirt);
  path(m, [[2.4, 5.2], [4.3, 5.8]], 1.5, dirt);
  path(m, [[-0.9, 8.7], [-0.4, 10.6]], 1.3, dirtDark);
  m.decal(
    [
      [2, -7],
      [11, -7],
      [11, 0.2],
      [2, 0.2],
    ],
    0.005,
    gravel
  );
  m.decal(
    [
      [PAVILION.x[0], PAVILION.z[0]],
      [PAVILION.x[1], PAVILION.z[0]],
      [PAVILION.x[1], PAVILION.z[1]],
      [PAVILION.x[0], PAVILION.z[1]],
    ],
    0.009,
    shade(gravel, 1.04)
  );
  // ── Lodge: stone footing, plank floor, log walls, loft, ceiling, roof, chimney ──
  const stone = color(PALETTE.stone),
    stoneDark = color(PALETTE.stoneDark),
    deckEdge = color(PALETTE.deckEdge);
  deck(m, LODGE.x, LODGE.z, 0, LODGE.floor, "x", stone);
  const lodgeWalls: [WallId, "x" | "z", "+" | "-"][] = [
    ["lodgeN", "x", "+"],
    ["lodgeS", "x", "-"],
    ["lodgeW", "z", "+"],
    ["lodgeE", "z", "-"],
  ];
  for (const [id, along, inside] of lodgeWalls)
    for (const c of wallColliders(id)) {
      if (c.role === "glass") glassPane(glass, c);
      else logWall(m, c, along, inside);
    }
  // Corner posts (dark logs) standing proud of the walls.
  for (const [x, z] of [
    [LODGE.x[0], LODGE.z[0]],
    [LODGE.x[1], LODGE.z[0]],
    [LODGE.x[0], LODGE.z[1]],
    [LODGE.x[1], LODGE.z[1]],
  ] as const) {
    const cx = x === LODGE.x[0] ? x + 0.15 : x - 0.15,
      cz = z === LODGE.z[0] ? z + 0.15 : z - 0.15;
    m.box([cx - 0.24, 0, cz - 0.24], [cx + 0.24, LODGE.wallTop, cz + 0.24], (f) => (f === "bottom" ? null : f === "top" ? color(PALETTE.corner) : shade(color(PALETTE.corner), f === "nz" || f === "nx" ? 0.85 : 1)));
  }
  deck(m, [LOFT.x[0], 2], LOFT.z, LOFT.top - LOFT.thickness, LOFT.top, "z", deckEdge, shade(color(PALETTE.ceiling), 0.9));
  stair(m);
  // Loft beams under the deck, every 1.6 m, over the kitchen.
  for (let z = LOFT.z[0] + 0.6; z < LOFT.z[1]; z += 1.6) m.box([LOFT.x[0], LOFT.top - LOFT.thickness - 0.18, z - 0.1], [LODGE_INSIDE.x[1], LOFT.top - LOFT.thickness, z + 0.1], (f) => (f === "top" ? null : shade(deckEdge, f === "bottom" ? 1.05 : 0.92)));
  // Ceiling at the wall tops (the gable roof above it).
  const ceiling = color(PALETTE.ceiling);
  m.faced([[LODGE_INSIDE.x[0], LODGE.wallTop, LODGE_INSIDE.z[0]], [LODGE_INSIDE.x[1], LODGE.wallTop, LODGE_INSIDE.z[0]], [LODGE_INSIDE.x[1], LODGE.wallTop, LODGE_INSIDE.z[1]], [LODGE_INSIDE.x[0], LODGE.wallTop, LODGE_INSIDE.z[1]]], [0, -1, 0], ceiling);
  for (let x = LODGE_INSIDE.x[0] + 1.2; x < LODGE_INSIDE.x[1] - 0.5; x += 2.4) m.box([x - 0.12, LODGE.wallTop - 0.22, LODGE_INSIDE.z[0]], [x + 0.12, LODGE.wallTop, LODGE_INSIDE.z[1]], (f) => (f === "top" ? null : shade(deckEdge, f === "bottom" ? 1.05 : 0.9)));
  gableRoof(m, LODGE.x, LODGE.z, LODGE.wallTop, LODGE.ridge, "x", 0.45, color(PALETTE.logA));
  // The fireplace's stone chimney outside the west wall, above the ridge.
  m.box([LODGE.x[0] - 0.95, 0, -6.85], [LODGE.x[0], LODGE.ridge + 1.1, -5.55], (f) => (f === "bottom" ? null : f === "top" ? stoneDark : shade(stone, f === "nz" || f === "nx" ? 0.85 : 1)));
  m.box([LODGE.x[0] - 1.05, LODGE.ridge + 1.1, -6.95], [LODGE.x[0] + 0.1, LODGE.ridge + 1.35, -5.45], (f) => (f === "bottom" ? stoneDark : shade(stoneDark, f === "top" ? 0.7 : 1)));
  // ── Porch ──
  deck(m, PORCH.x, PORCH.z, 0, PORCH.top, "x", deckEdge);
  for (const x of PORCH_POSTS) m.box([x[0], PORCH.top, PORCH_POST_Z[0]], [x[1], PORCH.roof, PORCH_POST_Z[1]], (f) => (f === "bottom" || f === "top" ? null : shade(color(PALETTE.post), f === "nz" || f === "nx" ? 0.85 : 1)));
  m.box([PORCH.x[0], PORCH.roof, PORCH.z[0]], [PORCH.x[1], PORCH.roof + PORCH.roofThickness, PORCH.z[1] + 0.3], (f) => (f === "top" ? color(PALETTE.roofA) : f === "bottom" ? ceiling : color(PALETTE.roofEdge)));
  // Beam along the posts.
  m.box([PORCH.x[0], PORCH.roof - 0.22, PORCH_POST_Z[0] + 0.05], [PORCH.x[1], PORCH.roof, PORCH_POST_Z[1] - 0.05], (f) => (f === "top" ? null : shade(deckEdge, f === "bottom" ? 1.05 : 0.95)));
  // Entry steps.
  for (const r of ENTRY_STEPS) deck(m, r.x, r.z, 0, ENTRY_STEP_HEIGHT, r.x[1] - r.x[0] > r.z[1] - r.z[0] ? "x" : "z", deckEdge);
  // ── Lean-to (log store under a walkable plank roof), woodpile backing, crate step ──
  const boards = color(PALETTE.boardA);
  boardWall(m, { role: "woodpile", shape: "box", center: { x: (LEAN_TO.x[0] + LEAN_TO.x[1]) / 2, y: LEAN_TO.low / 2, z: (LEAN_TO.z[0] + LEAN_TO.z[1]) / 2 }, half: { x: (LEAN_TO.x[1] - LEAN_TO.x[0]) / 2, y: LEAN_TO.low / 2, z: (LEAN_TO.z[1] - LEAN_TO.z[0]) / 2 } }, "x");
  {
    const [x0, x1] = LEAN_TO.x,
      [z0, z1] = LEAN_TO.z,
      lo = LEAN_TO.low,
      hi = LEAN_TO.high,
      a = color(PALETTE.plankA),
      b = color(PALETTE.plankB);
    // Roof planks running down the slope (0.3 m wide), rising west to the lodge wall.
    let k = Math.floor(z0 / 0.3);
    for (let z = z0; z < z1 - 1e-6; k++) {
      const next = Math.min(z1, (k + 1) * 0.3);
      m.faced([[x1, lo, next], [x1, lo, z], [x0, hi, z], [x0, hi, next]], [0, 1, 0], k % 2 ? b : a);
      z = next;
    }
    // Gable-end triangles (north and south faces above the log store) and the fascia at the low edge.
    m.faced([[x1, lo, z1], [x0, hi, z1], [x0, lo, z1]], [0, 0, 1], shade(boards, 0.95));
    m.faced([[x0, lo, z0], [x0, hi, z0], [x1, lo, z0]], [0, 0, -1], shade(boards, 0.85));
    m.faced([[x1, lo - 0.14, z1], [x1, lo - 0.14, z0], [x1, lo, z0], [x1, lo, z1]], [1, 0, 0], deckEdge);
  }
  m.box([WOODPILE.x[0] + 0.04, 0, WOODPILE.z[0]], [WOODPILE.x[1] - 0.04, WOODPILE.top - 0.03, WOODPILE.z[1] - 0.04], (f) => (f === "bottom" ? null : shade(color(PALETTE.plankDark), 0.7)));
  deck(m, CRATE_STEP.x, CRATE_STEP.z, 0, CRATE_STEP.top, "z", shade(color(PALETTE.tableDark), 0.9));
  // ── Shed ──
  deck(m, SHED.x, SHED.z, 0, SHED.floor, "z", stone);
  const shedWalls: [WallId, "x" | "z"][] = [
    ["shedN", "x"],
    ["shedS", "x"],
    ["shedW", "z"],
    ["shedE", "z"],
  ];
  for (const [id, along] of shedWalls)
    for (const c of wallColliders(id)) {
      if (c.role === "glass") glassPane(glass, c);
      else boardWall(m, c, along);
    }
  m.faced([[SHED_INSIDE.x[0], SHED.wallTop, SHED_INSIDE.z[0]], [SHED_INSIDE.x[1], SHED.wallTop, SHED_INSIDE.z[0]], [SHED_INSIDE.x[1], SHED.wallTop, SHED_INSIDE.z[1]], [SHED_INSIDE.x[0], SHED.wallTop, SHED_INSIDE.z[1]]], [0, -1, 0], ceiling);
  gableRoof(m, SHED.x, SHED.z, SHED.wallTop, SHED.ridge, "z", 0.35, boards);
  // ── Pavilion: posts, roof slab, gable; picnic tables ──
  for (const p of PAVILION_POSTS) m.box([p.x[0], 0, p.z[0]], [p.x[1], PAVILION.eave, p.z[1]], (f) => (f === "bottom" || f === "top" ? null : shade(color(PALETTE.post), f === "nz" || f === "nx" ? 0.85 : 1)));
  const o = PAVILION.overhang;
  m.box([PAVILION.x[0] - o, PAVILION.eave, PAVILION.z[0] - o], [PAVILION.x[1] + o, PAVILION.eave + PAVILION.roofThickness, PAVILION.z[1] + o], (f) => (f === "top" ? null : f === "bottom" ? ceiling : deckEdge));
  gableRoof(m, [PAVILION.x[0] - o, PAVILION.x[1] + o], [PAVILION.z[0] - o, PAVILION.z[1] + o], PAVILION.eave + PAVILION.roofThickness, PAVILION.ridge, "x", 0.05, shade(ceiling, 0.95));
  for (const t of PICNIC_TABLES) picnicTable(m, t.x, t.z);
  // ── Fire ring ──
  const rock = color(PALETTE.stone);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2,
      r = FIRE_PIT.radius - 0.12,
      x = FIRE_PIT.x + Math.cos(a) * r,
      z = FIRE_PIT.z + Math.sin(a) * r,
      s = 0.13 + 0.03 * ((k * 7) % 3);
    m.box([x - s, 0, z - s], [x + s, FIRE_PIT.height * (0.7 + 0.1 * (k % 3)), z + s], (f) => (f === "bottom" ? null : shade(rock, f === "top" ? 1.05 : f === "nz" || f === "nx" ? 0.8 : 0.92)));
  }
  disc(m, FIRE_PIT.x, FIRE_PIT.z, FIRE_PIT.radius - 0.2, color(PALETTE.ash), 0.02, 16);

  const material = new MeshLambertMaterial({ vertexColors: true });
  const mesh = new Mesh(m.build(), material);
  mesh.name = "prop-arena";
  mesh.matrixAutoUpdate = false;
  const glassMaterial = new MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.28, depthWrite: false, side: DoubleSide });
  const panes = new Mesh(glass.build(), glassMaterial);
  panes.name = "prop-glass";
  panes.renderOrder = 3;
  panes.matrixAutoUpdate = false;
  const group = new Group();
  group.name = "prop-arena";
  group.add(mesh, panes);
  return {
    group,
    triangles: m.triangles + glass.triangles,
    dispose() {
      mesh.geometry.dispose();
      panes.geometry.dispose();
      material.dispose();
      glassMaterial.dispose();
    },
  };
}

function glassPane(m: Mesher, c: BoxCollider) {
  const b = bounds(c),
    tint = color(PALETTE.glass);
  m.box([b.x0, b.y0, b.z0], [b.x1, b.y1, b.z1], (f) => (f === "top" || f === "bottom" ? null : tint));
}
/** A classic picnic table (long along z): three top boards, two bench planks, A-frame legs. */
function picnicTable(m: Mesher, x: number, z: number) {
  const t = PICNIC,
    a = color(PALETTE.table),
    d = color(PALETTE.tableDark),
    z0 = z - t.length / 2,
    z1 = z + t.length / 2,
    top = (f: Face) => (f === "bottom" ? null : f === "top" ? a : shade(d, f === "nz" || f === "nx" ? 0.85 : 1));
  for (let k = 0; k < 3; k++) {
    const x0 = x - t.top / 2 + (k * t.top) / 3 + 0.01;
    m.box([x0, t.height - 0.05, z0], [x0 + t.top / 3 - 0.02, t.height, z1], top);
  }
  for (const side of [-1, 1]) {
    const bx = side < 0 ? x - t.top / 2 - t.bench : x + t.top / 2;
    m.box([bx + 0.01, t.benchHeight - 0.05, z0], [bx + t.bench - 0.01, t.benchHeight, z1], top);
  }
  // A-frame legs near each end and the cross bar that carries the benches.
  for (const zz of [z0 + 0.25, z1 - 0.25]) {
    m.box([x - t.top / 2 - t.bench, t.benchHeight - 0.14, zz - 0.05], [x + t.top / 2 + t.bench, t.benchHeight - 0.05, zz + 0.05], (f) => (f === "bottom" ? null : d));
    for (const side of [-1, 1]) m.box([x + side * 0.3 - 0.05, 0, zz - 0.05], [x + side * 0.3 + 0.05, t.height - 0.05, zz + 0.05], (f) => (f === "bottom" || f === "top" ? null : d));
  }
}
