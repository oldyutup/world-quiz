import {
  AdditiveBlending,
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
  type Material,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  BALE,
  BARRELS,
  COVER,
  CRATE,
  DECK_THICKNESS,
  DECKS,
  DROPS,
  EAST_LANDING,
  HUB_HALF,
  OUTER,
  POSTS,
  RAILS,
  RAMP,
  SPAWN_CANDIDATES,
  STAIRS,
  START_SPAWNS,
  STEPS,
  TRAPS,
  UPPER_HEIGHT,
  WEAPON_SPOTS,
  WING_HALF,
  WINGS,
  insideBarn,
  stepColumn,
  type BarnCover,
  type BarnSpawnId,
  type Rect,
  type WingId,
} from "../../../../shared/party-lab/maps/barn";
import { PLAYERS } from "../players";
import {
  DOORS,
  FRAME,
  PICKUP,
  PLANK,
  RAFTERS,
  SACKS,
  SHEAVES,
  SHELL,
  STAIR_STEP,
  TRAP_YAW,
  WEAPON_PREVIEW,
  WINDOW,
  WINDOWS,
  WOOD,
} from "./barnScenery";
import type { BarnPropsView } from "./barnView";

/** Nodes of barn-kit.glb (see scripts/build-party-lab-barn-kit.mjs). */
export const BARN_KIT_NODES = [
  "BarnDoors",
  "HayBale",
  "HaySheaf",
  "Barrel",
  "Sacks",
  "Rail",
  "Crate",
  "Pallet",
  "Shotgun",
  "Smg",
  "BearTrap",
] as const;
export type BarnKitNode = (typeof BARN_KIT_NODES)[number];
export interface BarnKitPart {
  geometry: BufferGeometry;
  material: Material;
}
export type BarnKit = Record<BarnKitNode, BarnKitPart[]>;

export function readBarnKit(root: Object3D): BarnKit {
  const kit = {} as BarnKit;
  for (const name of BARN_KIT_NODES) {
    const node = root.getObjectByName(name);
    if (!node) throw new Error(`barn-kit.glb is missing ${name}`);
    kit[name] = [];
    node.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) kit[name].push({ geometry: mesh.geometry, material: mesh.material as Material });
    });
    if (!kit[name].length) throw new Error(`barn-kit.glb node ${name} has no meshes`);
  }
  return kit;
}

const Y_AXIS = new Vector3(0, 1, 0);
const matrix = (x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1) =>
  new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(Y_AXIS, rotY), new Vector3(sx, sy, sz));
const linear = (hex: string) => new Color(hex).toArray() as [number, number, number];
const pick = <T,>(list: readonly T[], i: number) => list[((i % list.length) + list.length) % list.length];
const cover = (id: string) => COVER.find((c) => c.id === id)!;

/** Fills a collider box with scaled bales, long axis along the box's longer horizontal side. */
function baleMatrices(x: readonly [number, number], y: readonly [number, number], z: readonly [number, number], layerHeight: number = BALE.height) {
  const lx = x[1] - x[0], lz = z[1] - z[0], h = y[1] - y[0];
  const alongX = lx >= lz;
  const long = alongX ? lx : lz, short = alongX ? lz : lx;
  const nLong = Math.max(1, Math.round(long / BALE.long)),
    nShort = Math.max(1, Math.round(short / BALE.short)),
    layers = Math.max(1, Math.round(h / layerHeight));
  const sLong = long / nLong / BALE.long,
    sShort = short / nShort / BALE.short,
    sy = h / layers / BALE.height;
  const out: Matrix4[] = [];
  for (let layer = 0; layer < layers; layer++)
    for (let i = 0; i < nLong; i++)
      for (let j = 0; j < nShort; j++) {
        const a = (i + 0.5) / nLong, b = (j + 0.5) / nShort;
        const cx = alongX ? x[0] + a * lx : x[0] + b * lx,
          cz = alongX ? z[0] + b * lz : z[0] + a * lz;
        // Alternate each layer by 180° so stacked straps don't line up exactly.
        const yaw = (alongX ? 0 : Math.PI / 2) + (layer % 2) * Math.PI;
        out.push(matrix(cx, y[0] + (layer * h) / layers, cz, yaw, sLong, sy, sShort));
      }
  return out;
}
/** Fills a box with kit crates (1.03 m cubes), each turned a quarter-step for variety. */
function crateMatrices(c: BarnCover) {
  const out: Matrix4[] = [];
  const nx = Math.round((c.x[1] - c.x[0]) / CRATE),
    ny = Math.round((c.y[1] - c.y[0]) / CRATE),
    nz = Math.round((c.z[1] - c.z[0]) / CRATE);
  let k = 0;
  for (let iy = 0; iy < ny; iy++)
    for (let ix = 0; ix < nx; ix++)
      for (let iz = 0; iz < nz; iz++, k++)
        out.push(matrix(c.x[0] + (ix + 0.5) * CRATE, c.y[0] + iy * CRATE, c.z[0] + (iz + 0.5) * CRATE, ((k * 3 + iy) % 4) * (Math.PI / 2)));
  return out;
}

// ─── Vertex-coloured shell geometry ─────────────────────────────────────────

type V = readonly [number, number, number];
type RGB = readonly [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Flat-shaded, vertex-coloured triangles. Every face is given the direction it
 * must face (toward the room), and its winding is fixed to match, so no face can
 * end up invisible from the inside.
 */
class Shell {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  poly(points: readonly V[], facing: V, color: RGB) {
    let pts = points;
    let nn = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    if (dot(nn, facing) < 0) {
      pts = [...pts].reverse();
      nn = [-nn[0], -nn[1], -nn[2]];
    }
    for (let i = 1; i + 1 < pts.length; i++)
      for (const p of [pts[0], pts[i], pts[i + 1]]) {
        this.positions.push(...p);
        this.normals.push(...nn);
        this.colors.push(...color);
      }
  }
  /** Axis-aligned box; `faces` picks which sides are drawn. */
  box(min: V, max: V, color: RGB, faces = "xXyYzZ") {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    if (faces.includes("X")) this.poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], color);
    if (faces.includes("x")) this.poly([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0], color);
    if (faces.includes("Y")) this.poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], color);
    if (faces.includes("y")) this.poly([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], color);
    if (faces.includes("Z")) this.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], color);
    if (faces.includes("z")) this.poly([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1], color);
  }
  /** A square-section timber from `a` to `b` (w wide, h deep), for rafters and braces. */
  beam(a: V, b: V, w: number, h: number, color: RGB) {
    const axis = norm(sub(b, a));
    const side = Math.abs(axis[1]) > 0.95 ? ([1, 0, 0] as V) : norm(cross(axis, [0, 1, 0]));
    const up = norm(cross(side, axis));
    const c = (p: V, s: number, u: number): V => [p[0] + side[0] * s + up[0] * u, p[1] + side[1] * s + up[1] * u, p[2] + side[2] * s + up[2] * u];
    const ring = (p: V) => [c(p, -w / 2, -h / 2), c(p, w / 2, -h / 2), c(p, w / 2, h / 2), c(p, -w / 2, h / 2)];
    const ra = ring(a), rb = ring(b);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4,
        mid = [(ra[i][0] + ra[j][0]) / 2 - a[0], (ra[i][1] + ra[j][1]) / 2 - a[1], (ra[i][2] + ra[j][2]) / 2 - a[2]] as V;
      this.poly([ra[i], ra[j], rb[j], rb[i]], mid, color);
    }
    this.poly(ra, [-axis[0], -axis[1], -axis[2]], color);
    this.poly(rb, axis, color);
  }
  get triangles() {
    return this.positions.length / 9;
  }
  build() {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.normals, 3));
    g.setAttribute("color", new Float32BufferAttribute(this.colors, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** A point on a wall plane: `c` runs along the wall, `off` steps into the room. */
interface WallPlane {
  readonly axis: "x" | "z";
  readonly at: number;
  readonly inward: 1 | -1;
}
const onWall = (w: WallPlane, c: number, y: number, off = 0): V =>
  w.axis === "x" ? [w.at + w.inward * off, y, c] : [c, y, w.at + w.inward * off];
const wallNormal = (w: WallPlane): V => (w.axis === "x" ? [w.inward, 0, 0] : [0, 0, w.inward]);

/** Vertical boards over [c0, c1] between a bottom and a top profile (piecewise linear, kinked at `kink`). */
function boards(s: Shell, w: WallPlane, c0: number, c1: number, bottom: (c: number) => number, top: (c: number) => number, colors: readonly string[], kink?: number) {
  const n = Math.max(1, Math.round((c1 - c0) / PLANK.wall));
  for (let i = 0; i < n; i++) {
    const a = c0 + ((c1 - c0) * i) / n,
      b = c0 + ((c1 - c0) * (i + 1)) / n;
    const cuts = kink !== undefined && kink > a && kink < b ? [a, kink, b] : [a, b];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const p = cuts[k], q = cuts[k + 1];
      if (top(p) - bottom(p) < 1e-6 && top(q) - bottom(q) < 1e-6) continue;
      s.poly([onWall(w, p, bottom(p)), onWall(w, q, bottom(q)), onWall(w, q, top(q)), onWall(w, p, top(p))], wallNormal(w), linear(pick(colors, i)));
    }
  }
}

interface WallRun extends WallPlane {
  readonly c: readonly [number, number];
  readonly kind: "side" | "end" | "shoulder" | "hub-upper";
  readonly wing?: WingId;
}
/** Every inner wall face of the cross, with its role. */
function wallRuns(): WallRun[] {
  const out: WallRun[] = [];
  for (const [id, r] of Object.entries(WINGS) as [WingId, Rect][]) {
    const alongZ = id === "N" || id === "S";
    const along = alongZ ? r.z : r.x,
      sign = along[0] < 0 ? -1 : 1;
    // Side walls (the wing's length) and the end wall (a gable).
    for (const s of [-1, 1] as const) out.push({ axis: alongZ ? "x" : "z", at: s * WING_HALF, inward: (-s) as 1 | -1, c: along, kind: "side", wing: id });
    out.push({ axis: alongZ ? "z" : "x", at: sign * OUTER, inward: (-sign) as 1 | -1, c: [-WING_HALF, WING_HALF], kind: "end", wing: id });
    // Above the wing's opening into the hub, the hub wall carries on up to the hub eave.
    out.push({ axis: alongZ ? "z" : "x", at: sign * HUB_HALF, inward: (-sign) as 1 | -1, c: [-WING_HALF, WING_HALF], kind: "hub-upper", wing: id });
  }
  // The hub's eight shoulders (2 m of wall beside each wing's opening), full height.
  for (const axis of ["x", "z"] as const)
    for (const s of [-1, 1] as const)
      for (const c of [[-HUB_HALF, -WING_HALF], [WING_HALF, HUB_HALF]] as const)
        out.push({ axis, at: s * HUB_HALF, inward: (-s) as 1 | -1, c, kind: "shoulder" });
  return out;
}
const gable = (c: number) => SHELL.wingEave + (SHELL.wingRidge - SHELL.wingEave) * (1 - Math.abs(c) / WING_HALF);

function walls(s: Shell) {
  const beam = linear(WOOD.beam), post = linear(WOOD.post);
  for (const w of wallRuns()) {
    const [c0, c1] = w.c;
    if (w.kind === "side") boards(s, w, c0, c1, () => 0, () => SHELL.wingEave, WOOD.wall);
    else if (w.kind === "shoulder") boards(s, w, c0, c1, () => 0, () => SHELL.hubEave, WOOD.wall);
    else if (w.kind === "hub-upper") boards(s, w, c0, c1, gable, () => SHELL.hubEave, WOOD.wall, 0);
    else boards(s, w, c0, c1, () => 0, gable, WOOD.wall, 0);
    // Timber frame: base board, a ledger at the upper floor's level, a top plate, posts.
    const n = wallNormal(w);
    const band = (y0: number, y1: number, depth: number, from = c0, to = c1) => {
      const a = onWall(w, from, y0), b = onWall(w, to, y1, depth);
      s.box([Math.min(a[0], b[0]), y0, Math.min(a[2], b[2])], [Math.max(a[0], b[0]), y1, Math.max(a[2], b[2])], beam, faceTowards(n));
    };
    if (w.kind !== "hub-upper") {
      band(0, FRAME.base, 0.05);
      band(FRAME.ledger[0], FRAME.ledger[1], 0.06);
    }
    if (w.kind === "side") band(SHELL.wingEave - FRAME.plate, SHELL.wingEave, 0.1);
    if (w.kind === "shoulder" || w.kind === "hub-upper") band(SHELL.hubEave - FRAME.plate, SHELL.hubEave, 0.1);
    if (w.kind === "side") {
      const n2 = Math.max(1, Math.round((c1 - c0) / FRAME.postEvery));
      for (let i = 0; i <= n2; i++) {
        const c = c0 + ((c1 - c0) * i) / n2,
          a = Math.max(c0, c - FRAME.post / 2),
          b = Math.min(c1, c + FRAME.post / 2);
        const p = onWall(w, a, 0), q = onWall(w, b, SHELL.wingEave, FRAME.depth);
        s.box([Math.min(p[0], q[0]), 0, Math.min(p[2], q[2])], [Math.max(p[0], q[0]), SHELL.wingEave, Math.max(p[2], q[2])], post, faceTowards(n) + sidesAlong(w));
      }
    }
  }
}
/** Box faces seen from the room side of a wall with normal n. */
const faceTowards = (n: V) => (n[0] > 0 ? "XYy" : n[0] < 0 ? "xYy" : n[2] > 0 ? "ZYy" : "zYy");
const sidesAlong = (w: WallPlane) => (w.axis === "x" ? "zZ" : "xX");

function roofs(s: Shell) {
  const beam = linear(WOOD.beam);
  const { wingEave: eave, wingRidge: ridge, hubEave, hubPeak } = SHELL;
  for (const [id, r] of Object.entries(WINGS) as [WingId, Rect][]) {
    const alongZ = id === "N" || id === "S";
    const [a0, a1] = alongZ ? r.z : r.x;
    // Point on the wing from (across, y, along).
    const at = (c: number, y: number, a: number): V => (alongZ ? [c, y, a] : [a, y, c]);
    const n = Math.round((a1 - a0) / PLANK.roof);
    for (const side of [-1, 1]) {
      const facing = alongZ ? ([-side * (ridge - eave), -WING_HALF, 0] as V) : ([0, -WING_HALF, -side * (ridge - eave)] as V);
      for (let i = 0; i < n; i++) {
        const p = a0 + ((a1 - a0) * i) / n,
          q = a0 + ((a1 - a0) * (i + 1)) / n;
        s.poly([at(side * WING_HALF, eave, p), at(side * WING_HALF, eave, q), at(0, ridge, q), at(0, ridge, p)], facing, linear(pick(WOOD.roof, i)));
      }
    }
    // Rafter pairs just under the boards, a collar tie above the camera's reach, and a ridge beam.
    const count = Math.round((a1 - a0) / RAFTERS.every);
    const drop = RAFTERS.size / 2 + 0.02,
      collarC = WING_HALF * (1 - (RAFTERS.collarY - eave) / (ridge - eave));
    for (let i = 0; i <= count; i++) {
      const a = Math.min(a1 - RAFTERS.size, Math.max(a0 + RAFTERS.size, a0 + ((a1 - a0) * i) / count));
      for (const side of [-1, 1]) s.beam(at(side * (WING_HALF - 0.05), eave - drop, a), at(0, ridge - drop - 0.02, a), RAFTERS.size, RAFTERS.size, beam);
      s.beam(at(-collarC + 0.05, RAFTERS.collarY, a), at(collarC - 0.05, RAFTERS.collarY, a), RAFTERS.size * 0.9, RAFTERS.size, beam);
    }
    s.beam(at(0, RAFTERS.ridgeY, a0), at(0, RAFTERS.ridgeY, a1), 0.26, 0.3, beam);
  }
  // Hub: pyramid roof in six boarded bands, hip rafters, and two tie beams high over the void.
  const peak: V = [0, hubPeak, 0];
  const corners: V[] = [[-HUB_HALF, hubEave, -HUB_HALF], [HUB_HALF, hubEave, -HUB_HALF], [HUB_HALF, hubEave, HUB_HALF], [-HUB_HALF, hubEave, HUB_HALF]];
  const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4];
    const mid = lerp(a, b, 0.5),
      facing = norm([-mid[0], -(hubPeak - hubEave) * 0.9, -mid[2]]);
    const bands = 6;
    for (let i = 0; i < bands; i++) {
      const t0 = i / bands, t1 = (i + 1) / bands;
      const pts: V[] = t1 < 1 ? [lerp(a, peak, t0), lerp(b, peak, t0), lerp(b, peak, t1), lerp(a, peak, t1)] : [lerp(a, peak, t0), lerp(b, peak, t0), peak];
      s.poly(pts, facing, linear(pick(WOOD.roof, i + k)));
    }
    s.beam(lerp(a, peak, 0.02), lerp(a, peak, 0.97), 0.3, 0.3, beam);
  }
  for (const axis of ["x", "z"] as const) {
    const y = hubEave - 0.4;
    s.beam(axis === "x" ? [-HUB_HALF, y, 0] : [0, y, -HUB_HALF], axis === "x" ? [HUB_HALF, y, 0] : [0, y, HUB_HALF], 0.3, 0.36, beam);
  }
}

function floors(s: Shell) {
  // Planks run along each wing (and north–south through the hub).
  const strip = (x0: number, x1: number, z0: number, z1: number, i: number) =>
    s.poly([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], [0, 1, 0], linear(pick(WOOD.floor, i)));
  const split = (lo: number, hi: number) => {
    const n = Math.max(1, Math.round((hi - lo) / PLANK.floor));
    return Array.from({ length: n }, (_, i) => [lo + ((hi - lo) * i) / n, lo + ((hi - lo) * (i + 1)) / n] as const);
  };
  split(-WING_HALF, WING_HALF).forEach(([a, b], i) => strip(a, b, -OUTER, OUTER, i));
  for (const [lo, hi] of [[-HUB_HALF, -WING_HALF], [WING_HALF, HUB_HALF]] as const) split(lo, hi).forEach(([a, b], i) => strip(a, b, -HUB_HALF, HUB_HALF, i + 1));
  for (const [lo, hi] of [[-OUTER, -HUB_HALF], [HUB_HALF, OUTER]] as const)
    split(-WING_HALF, WING_HALF).forEach(([a, b], i) => s.poly([[lo, 0, a], [hi, 0, a], [hi, 0, b], [lo, 0, b]], [0, 1, 0], linear(pick(WOOD.floor, i + 2))));
}

/** Whether a point just off a deck edge is solid ground for the deck (wall, another deck, a route's top). */
function supported(x: number, z: number) {
  if (!insideBarn(x, z)) return true;
  const within = (r: Rect) => x > r.x[0] - 1e-6 && x < r.x[1] + 1e-6 && z > r.z[0] - 1e-6 && z < r.z[1] + 1e-6;
  return Object.values(DECKS).some(within) || within(EAST_LANDING) || within(RAMP) || within(STAIRS);
}
/** Open stretches of a deck's edges (not against a wall, another deck or a route), as [from, to] along the edge. */
export function openDeckEdges(d: Rect) {
  const out: { axis: "x" | "z"; at: number; out: 1 | -1; from: number; to: number }[] = [];
  const step = 0.05;
  for (const [axis, at, dir] of [["z", d.z[0], -1], ["z", d.z[1], 1], ["x", d.x[0], -1], ["x", d.x[1], 1]] as const) {
    const [lo, hi] = axis === "z" ? d.x : d.z;
    let start: number | null = null;
    for (let c = lo + step / 2; c < hi + step; c += step) {
      const inRange = c < hi;
      const px = axis === "z" ? c : at + dir * 0.02, pz = axis === "z" ? at + dir * 0.02 : c;
      const open = inRange && !supported(px, pz);
      if (open && start === null) start = c - step / 2;
      if (!open && start !== null) {
        out.push({ axis, at, out: dir, from: start, to: Math.min(hi, c - step / 2) });
        start = null;
      }
    }
  }
  return out;
}

function decks(s: Shell) {
  const top = UPPER_HEIGHT, under = UPPER_HEIGHT - DECK_THICKNESS, beam = linear(WOOD.beam);
  for (const d of Object.values(DECKS)) {
    const lx = d.x[1] - d.x[0], lz = d.z[1] - d.z[0];
    // Boards run across the deck (along its short side).
    const alongX = lx >= lz;
    const n = Math.round((alongX ? lx : lz) / PLANK.deck);
    for (let i = 0; i < n; i++) {
      const a = (alongX ? d.x[0] : d.z[0]) + ((alongX ? lx : lz) * i) / n,
        b = (alongX ? d.x[0] : d.z[0]) + ((alongX ? lx : lz) * (i + 1)) / n;
      const [x0, x1, z0, z1] = alongX ? [a, b, d.z[0], d.z[1]] : [d.x[0], d.x[1], a, b];
      s.poly([[x0, top, z0], [x1, top, z0], [x1, top, z1], [x0, top, z1]], [0, 1, 0], linear(pick(WOOD.deck, i)));
      // Underside: boards seen from below, every third one a darker joist line.
      s.poly([[x0, under, z0], [x1, under, z0], [x1, under, z1], [x0, under, z1]], [0, -1, 0], i % 3 === 0 ? beam : linear(pick(WOOD.deckUnder, i)));
    }
    // Fascia boards on the open edges.
    for (const e of openDeckEdges(d)) {
      const n2 = Math.max(1, Math.round((e.to - e.from) / PLANK.fascia));
      for (let i = 0; i < n2; i++) {
        const a = e.from + ((e.to - e.from) * i) / n2, b = e.from + ((e.to - e.from) * (i + 1)) / n2;
        const pts: V[] = e.axis === "z" ? [[a, under, e.at], [b, under, e.at], [b, top, e.at], [a, top, e.at]] : [[e.at, under, a], [e.at, under, b], [e.at, top, b], [e.at, top, a]];
        s.poly(pts, e.axis === "z" ? [0, 0, e.out] : [e.out, 0, 0], linear(pick(WOOD.fascia, i)));
      }
    }
  }
  // Drop edges: a straw-coloured board along each open edge you are meant to jump from.
  const strip = linear(WOOD.dropEdge), w = 0.16;
  for (const { edge, out } of DROPS) {
    const y = top + 0.004;
    const [x0, x1] = out.x !== 0 ? [edge.x[0] - (out.x > 0 ? w : 0), edge.x[0] + (out.x < 0 ? w : 0)] : edge.x;
    const [z0, z1] = out.z !== 0 ? [edge.z[0] - (out.z > 0 ? w : 0), edge.z[0] + (out.z < 0 ? w : 0)] : edge.z;
    s.poly([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], [0, 1, 0], strip);
  }
  // The four columns under the ring's inner corners, with knee braces toward the edges.
  const post = linear(WOOD.post);
  for (const p of POSTS) {
    s.box([p.x[0], 0, p.z[0]], [p.x[1], under, p.z[1]], post, "xXzZ");
    s.box([p.x[0] - 0.03, under - 0.18, p.z[0] - 0.03], [p.x[1] + 0.03, under, p.z[1] + 0.03], beam, "xXzZy");
    const cx = (p.x[0] + p.x[1]) / 2, cz = (p.z[0] + p.z[1]) / 2;
    // Braces run along the ring's inner edges (toward the neighbouring columns).
    for (const [dx, dz] of [[-Math.sign(cx), 0], [0, -Math.sign(cz)]] as const) {
      const from: V = [cx + dx * 0.3, under - 0.75, cz + dz * 0.3],
        to: V = [cx + dx * 1.05, under - 0.02, cz + dz * 1.05];
      s.beam(from, to, 0.16, 0.16, beam);
    }
  }
}

function routes(s: Shell) {
  const top = UPPER_HEIGHT;
  // West ramp: plank boards up the slope (rising +x), darker cleats, and its open north side.
  {
    const [xl, xh] = RAMP.x, [z0, z1] = RAMP.z;
    const run = xh - xl, length = Math.hypot(run, top);
    const facing: V = [-top, run, 0];
    const at = (t: number) => [xl + run * t, top * t] as const;
    const boardsN = Math.round(length / PLANK.ramp);
    for (let i = 0; i < boardsN; i++) {
      const [xa, ya] = at(i / boardsN), [xb, yb] = at((i + 1) / boardsN);
      const cleat = (i + 1) % 2 === 0 ? 0.12 / length : 0;
      const [xc, yc] = at((i + 1) / boardsN - cleat);
      s.poly([[xa, ya, z0], [xa, ya, z1], [xc, yc, z1], [xc, yc, z0]], facing, linear(pick(WOOD.ramp, i)));
      if (cleat) s.poly([[xc, yc, z0], [xc, yc, z1], [xb, yb, z1], [xb, yb, z0]], facing, linear(WOOD.rampCleat));
    }
    s.poly([[xl, 0, z0], [xh, 0, z0], [xh, top, z0]], [0, 0, -1], linear(WOOD.rampSide));
    s.poly([[xh, 0, z0], [xh, 0, z1], [xh, top, z1], [xh, top, z0]], [1, 0, 0], linear(WOOD.rampSide));
  }
  // South stairs: steps whose nosings lie on the wedge's slope (feet float at most one riser's back).
  {
    const [x0, x1] = STAIRS.x, [zt, zb] = STAIRS.z;
    const count = Math.round(top / STAIR_STEP.rise);
    for (let i = 1; i < count; i++) {
      const y = i * STAIR_STEP.rise, zf = zb - i * STAIR_STEP.run, zk = zf - STAIR_STEP.run;
      s.poly([[x0, y, zf], [x1, y, zf], [x1, y, zk], [x0, y, zk]], [0, 1, 0], linear(pick(WOOD.stair, i)));
      s.poly([[x0, y - STAIR_STEP.rise, zf], [x1, y - STAIR_STEP.rise, zf], [x1, y, zf], [x0, y, zf]], [0, 0, 1], linear(WOOD.stairRiser));
    }
    s.poly([[x0, top - STAIR_STEP.rise, zt], [x1, top - STAIR_STEP.rise, zt], [x1, top, zt], [x0, top, zt]], [0, 0, 1], linear(WOOD.stairRiser));
    // Stringer on the open side and the tall end under the ring.
    s.poly([[x0, 0, zb], [x0, 0, zt], [x0, top, zt]], [-1, 0, 0], linear(WOOD.rampSide));
    s.poly([[x0, 0, zt], [x1, 0, zt], [x1, top, zt], [x0, top, zt]], [0, 0, -1], linear(WOOD.rampSide));
  }
  // East landing: a boarded block at deck height beside the top hay step.
  {
    const r = EAST_LANDING, colour = (i: number) => linear(pick(WOOD.fascia, i));
    const [x0, x1] = r.x, [z0, z1] = r.z;
    const n = Math.round((x1 - x0) / PLANK.fascia);
    for (let i = 0; i < n; i++) {
      const a = x0 + ((x1 - x0) * i) / n, b = x0 + ((x1 - x0) * (i + 1)) / n;
      s.poly([[a, 0, z1], [b, 0, z1], [b, top, z1], [a, top, z1]], [0, 0, 1], colour(i));
      s.poly([[a, top, z0], [b, top, z0], [b, top, z1], [a, top, z1]], [0, 1, 0], linear(pick(WOOD.deck, i)));
    }
    const col4 = stepColumn(STEPS.count).y[1];
    s.poly([[x1, col4, z0], [x1, col4, z1], [x1, top, z1], [x1, top, z0]], [1, 0, 0], colour(1));
    s.poly([[x0, 0, z0], [x0, 0, z1], [x0, top, z1], [x0, top, z0]], [-1, 0, 0], colour(2));
  }
  // Stall boards (E1, E2): vertical planks, posts at the ends, a top rail.
  for (const id of ["E1", "E2"]) {
    const c = cover(id), beam = linear(WOOD.beam);
    const [sx0, sx1] = c.x, [, sy1] = c.y, [sz0, sz1] = c.z;
    for (let i = 0, z = sz0 + 0.12; z < sz1 - 0.12 - 1e-6; i++, z += PLANK.stall)
      s.box([sx0, 0, z], [sx1, sy1 - 0.12, Math.min(sz1 - 0.12, z + PLANK.stall)], linear(pick(WOOD.stall, i)), "xX");
    for (const [z0, z1] of [[sz0, sz0 + 0.12], [sz1 - 0.12, sz1]]) s.box([sx0, 0, z0], [sx1, sy1, z1], beam, "xXzZY");
    s.box([sx0, sy1 - 0.12, sz0 + 0.12], [sx1, sy1, sz1 - 0.12], beam, "xXY");
  }
}

/** Window trims (vertex-coloured, into the shell) and panes (returned: their own glowing material). */
function windows(s: Shell) {
  const trim = linear(WINDOW.trim), f = WINDOW.frame, d = WINDOW.depth;
  const pane = new Shell();
  for (const w of WINDOWS) {
    const n = wallNormal(w);
    const r = (c0: number, c1: number, y0: number, y1: number, off: number) => {
      const a = onWall(w, c0, y0), b = onWall(w, c1, y1, off);
      return [[Math.min(a[0], b[0]), y0, Math.min(a[2], b[2])], [Math.max(a[0], b[0]), y1, Math.max(a[2], b[2])]] as [V, V];
    };
    const c0 = w.c - w.w / 2, c1 = w.c + w.w / 2, y0 = w.y, y1 = w.y + w.h;
    for (const [a, b] of [r(c0 - f, c1 + f, y0 - f, y0, d), r(c0 - f, c1 + f, y1, y1 + f, d), r(c0 - f, c0, y0, y1, d), r(c1, c1 + f, y0, y1, d), r(c0, c1, (y0 + y1) / 2 - f / 3, (y0 + y1) / 2 + f / 3, d * 0.6), r(w.c - f / 3, w.c + f / 3, y0, y1, d * 0.6)])
      s.box(a, b, trim, faceTowards(n) + sidesAlong(w) + "Yy");
    pane.poly([onWall(w, c0, y0, 0.012), onWall(w, c1, y0, 0.012), onWall(w, c1, y1, 0.012), onWall(w, c0, y1, 0.012)], n, linear(WINDOW.pane));
  }
  return pane.build();
}

/** Slot-coloured spawn rings with a facing tick (start spawns), pale rings (other respawn candidates), gold weapon rings. */
function markerGeometry() {
  const pieces: BufferGeometry[] = [];
  const paint = (g: BufferGeometry, hex: string) => {
    const c = linear(hex), count = g.getAttribute("position").count;
    g.setAttribute("color", new Float32BufferAttribute(Array.from({ length: count }, () => c).flat(), 3));
    g.deleteAttribute("uv");
    pieces.push(g.index ? g.toNonIndexed() : g);
  };
  const ring = (inner: number, outer: number, x: number, y: number, z: number, hex: string) =>
    paint(new RingGeometry(inner, outer, 40).rotateX(-Math.PI / 2).translate(x, y + 0.012, z), hex);
  for (const [id, s] of Object.entries(SPAWN_CANDIDATES) as [BarnSpawnId, (typeof SPAWN_CANDIDATES)[BarnSpawnId]][]) {
    const slot = (START_SPAWNS as readonly BarnSpawnId[]).indexOf(id);
    const hex = slot >= 0 ? PLAYERS[slot].color : "#efe4cf";
    ring(0.72, 0.8, s.x, s.y, s.z, hex);
    // A short wedge on the ring pointing where the spawn faces.
    paint(new RingGeometry(0.8, 1.02, 3, 1, -0.22, 0.44).rotateX(-Math.PI / 2).rotateY(s.yaw - Math.PI / 2).translate(s.x, s.y + 0.012, s.z), hex);
  }
  for (const w of Object.values(WEAPON_SPOTS)) ring(0.78, 0.9, w.x, w.y, w.z, "#ffcf3f");
  return mergeGeometries(pieces)!;
}

/**
 * Builds the static barn from the shared layout (a generated, vertex-coloured shell)
 * and the kit's props. Visual only: no physics is created or read here. The whole
 * roofed barn is shown — the third-person camera plays inside it.
 */
export function buildBarn(kit: BarnKit) {
  const group = new Group();
  group.name = "barn";
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(value: T) => {
    owned.push(value);
    return value;
  };
  const add = (object: Object3D, name: string, parent: Group = group) => {
    object.name = name;
    object.matrixAutoUpdate = false;
    object.updateMatrix();
    parent.add(object);
    return object;
  };
  const single = (name: BarnKitNode, m: Matrix4 = new Matrix4()) => {
    for (const part of kit[name]) {
      const mesh = new Mesh(part.geometry, part.material);
      mesh.applyMatrix4(m);
      add(mesh, `kit-${name}`);
    }
  };
  const instanced = (name: BarnKitNode, matrices: Matrix4[]) => {
    const meshes: InstancedMesh[] = [];
    for (const part of kit[name]) {
      const mesh = new InstancedMesh(part.geometry, part.material, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      own({ dispose: () => mesh.dispose() });
      meshes.push(add(mesh, `kit-${name}`) as InstancedMesh);
    }
    return meshes;
  };

  // The shell: one vertex-coloured mesh for walls, roofs, floors, decks, routes and frame.
  const shell = new Shell();
  floors(shell);
  walls(shell);
  roofs(shell);
  decks(shell);
  routes(shell);
  const paneGeometry = own(windows(shell));
  add(new Mesh(own(shell.build()), own(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }))), "barn-shell");
  add(
    new Mesh(paneGeometry, own(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, emissive: new Color(WINDOW.paneGlow), emissiveIntensity: 0.9 }))),
    "barn-windows"
  );
  // Big Barn's doors are modelled slid apart; here they hang flattened on the boarded end wall.
  single("BarnDoors", matrix(0, 0, DOORS.z - (DOORS.depth * DOORS.flatten) / 2, Math.PI, 1, 1, DOORS.flatten));

  // Cover and hay steps, filled from the shared colliders.
  instanced("HayBale", [
    ...COVER.filter((c) => c.role === "hay").flatMap((c) => baleMatrices(c.x, c.y, c.z)),
    ...Array.from({ length: STEPS.count }, (_, i) => {
      const s = stepColumn(i + 1);
      return baleMatrices(s.x, s.y, s.z, STEPS.riser);
    }).flat(),
  ]);
  instanced("Crate", COVER.filter((c) => c.role === "crate").flatMap(crateMatrices));
  instanced("Barrel", BARRELS.map((b) => matrix(b.x, 0, b.z, b.yaw)));

  // Rails (1 m, over the shared rail colliders); the kit rail's long side is x.
  const railLength = 2.37;
  instanced(
    "Rail",
    RAILS.flatMap((r) => {
      const alongX = r.x[1] - r.x[0] >= r.z[1] - r.z[0];
      const [a, b] = alongX ? r.x : r.z,
        across = alongX ? (r.z[0] + r.z[1]) / 2 : (r.x[0] + r.x[1]) / 2;
      const n = Math.max(1, Math.round((b - a) / railLength)), piece = (b - a) / n;
      return Array.from({ length: n }, (_, i) => {
        const c = a + (i + 0.5) * piece;
        return alongX ? matrix(c, UPPER_HEIGHT, across, 0, piece / railLength, 1, 1) : matrix(across, UPPER_HEIGHT, c, Math.PI / 2, piece / railLength, 1, 1);
      });
    })
  );

  // Decoration, only on top of full cover.
  const sackCrates = cover(SACKS.cover);
  single("Sacks", matrix((sackCrates.x[0] + sackCrates.x[1]) / 2, sackCrates.y[1], (sackCrates.z[0] + sackCrates.z[1]) / 2, SACKS.yaw, SACKS.scale, SACKS.scale, SACKS.scale));
  instanced(
    "HaySheaf",
    SHEAVES.map((s) => {
      const c = cover(s.cover);
      return matrix((c.x[0] + c.x[1]) / 2 + s.dx, c.y[1], (c.z[0] + c.z[1]) / 2 + s.dz, s.yaw);
    })
  );

  // Pickups: a pallet on every spot, turning weapons on the active ones (all seven as a
  // preview when no combat view is given), bear traps, spawn/weapon rings.
  const spots = Object.entries(WEAPON_SPOTS) as [keyof typeof WEAPON_SPOTS, (typeof WEAPON_SPOTS)["W1"]][];
  const spotIndex = new Map(spots.map(([id], i) => [id as string, i]));
  const palletScale = PICKUP.palletScale;
  instanced("Pallet", spots.map(([, w], i) => matrix(w.x, w.y, w.z, i * 0.9, palletScale, palletScale, palletScale)));
  const palletTop = 0.19 * palletScale;
  const weapons = (["Shotgun", "Smg"] as const).map((model) => {
    const box = new Box3();
    for (const part of kit[model]) {
      part.geometry.computeBoundingBox();
      box.union(part.geometry.boundingBox!);
    }
    const centre = box.getCenter(new Vector3());
    // Room for a weapon on every spot; `count` shows only the ones lying there.
    const meshes = instanced(model, spots.map(() => new Matrix4()));
    return { kind: model === "Shotgun" ? ("shotgun" as const) : ("smg" as const), model, centre, meshes };
  });
  const preview = spots.map(([id]) => ({ spot: id as string, kind: WEAPON_PREVIEW[id] === "Shotgun" ? ("shotgun" as const) : ("smg" as const) }));
  const trapEntries = Object.entries(TRAPS) as [keyof typeof TRAPS, (typeof TRAPS)["T1"]][];
  const trapMeshes = instanced("BearTrap", trapEntries.map(([id, t]) => matrix(t.x, t.y, t.z, TRAP_YAW[id])));
  // Glow rings: gold where a weapon is about to appear, red under a sprung trap.
  const glow = new InstancedMesh(
    own(new RingGeometry(0.55, 0.9, 40).rotateX(-Math.PI / 2)),
    own(new MeshBasicMaterial({ color: "#ffffff", blending: AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false })),
    spots.length + trapEntries.length
  );
  own({ dispose: () => glow.dispose() });
  glow.frustumCulled = false;
  add(glow, "combat-glow").renderOrder = 2;
  const gold = new Color("#ffcf3f"), red = new Color("#ff4a36"), tint = new Color();
  // Colour attribute up front, so the shader never recompiles on the first glow.
  for (let i = 0; i < glow.count; i++) glow.setColorAt(i, tint.setRGB(0, 0, 0));
  const spinning = new Matrix4(), turn = new Matrix4(), offset = new Matrix4(), size = new Matrix4();
  /** Per frame: turning pickups, telegraph glows, trap jaws (open when armed, snapped shut when sprung). */
  const update = (elapsed: number, view?: BarnPropsView | null) => {
    const lying = view ? view.pickups : preview;
    for (const { kind, centre, meshes } of weapons) {
      let n = 0;
      for (const p of lying) {
        if (p.kind !== kind) continue;
        const i = spotIndex.get(p.spot);
        if (i === undefined) continue;
        const w = spots[i][1],
          phase = i * 2.1,
          s = PICKUP.weaponScale;
        spinning
          .makeTranslation(w.x, w.y + palletTop + PICKUP.hover + Math.sin(elapsed * 1.6 + phase) * 0.05, w.z)
          .multiply(turn.makeRotationY(elapsed * PICKUP.spin + phase))
          .multiply(size.makeScale(s, s, s))
          .multiply(offset.makeTranslation(-centre.x, -centre.y, -centre.z));
        for (const mesh of meshes) mesh.setMatrixAt(n, spinning);
        n++;
      }
      for (const mesh of meshes) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    let g = 0;
    for (const t of view?.telegraphs ?? []) {
      const i = spotIndex.get(t.spot);
      if (i === undefined) continue;
      const w = spots[i][1],
        pulse = 0.75 + 0.25 * Math.sin(elapsed * 18);
      glow.setMatrixAt(g, matrix(w.x, w.y + 0.03, w.z, 0, 0.6 + 0.6 * t.progress, 1, 0.6 + 0.6 * t.progress));
      glow.setColorAt(g++, tint.copy(gold).multiplyScalar(pulse * (0.4 + 0.6 * t.progress)));
    }
    trapEntries.forEach(([id, t], i) => {
      const state = view?.traps.find((s) => s.id === id);
      const sprung = !!state && !state.armed;
      // Snapped shut: jaws closed across, standing a little taller.
      const m = matrix(t.x, t.y, t.z, TRAP_YAW[id], sprung ? 0.42 : 1, sprung ? 1.5 : 1, 1);
      for (const mesh of trapMeshes) mesh.setMatrixAt(i, m);
      if (sprung) {
        const k = state!.holding ? 0.9 + 0.1 * Math.sin(elapsed * 22) : 0.35 * Math.min(1, state!.rearmIn / 2);
        glow.setMatrixAt(g, matrix(t.x, t.y + 0.03, t.z, 0, 0.75, 1, 0.75));
        glow.setColorAt(g++, tint.copy(red).multiplyScalar(k));
      }
    });
    for (const mesh of trapMeshes) mesh.instanceMatrix.needsUpdate = true;
    glow.count = g;
    glow.instanceMatrix.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  };
  update(0);
  for (const { meshes } of weapons) for (const mesh of meshes) mesh.computeBoundingSphere();
  for (const mesh of trapMeshes) mesh.frustumCulled = false;
  for (const { meshes } of weapons) for (const mesh of meshes) mesh.frustumCulled = false;
  const rings = add(
    new Mesh(own(markerGeometry()), own(new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false }))),
    "markers"
  );
  rings.renderOrder = 1;

  return {
    group,
    update,
    /** Triangles in the generated shell (for the performance readout and tests). */
    shellTriangles: shell.triangles,
    dispose() {
      for (const item of owned) item.dispose();
      owned.length = 0;
    },
  };
}
