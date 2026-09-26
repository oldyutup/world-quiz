import type { ArenaCollider, ArenaMap, BoxCollider, ColliderRole, CylinderCollider, RampCollider, Vec2, Vec3 } from "./types.js";
import { footprintHalf, PROP_FAMILIES, SCENERY, shapeHeight, type PropFamilyId, type SceneryKind } from "./propHuntProps.js";

/**
 * "Orman Kampı" — Saklambaç's map (local only): a compact summer camp / ranger lodge,
 * 22 × 22 m of play (x, z −11…11, ground y 0), half inside and under roofs, half outdoors.
 * +X east, +Z south, north at −Z (the lodge's back wall is the north boundary).
 *
 * Zones (see ZONES):
 * - Lodge (NW): 13 × 8.5 m outside, floor +0.45. A double-height great room (fireplace,
 *   couch, dining table) to the west, the kitchen to the east under the loft. Three ways out:
 *   the 2.2 m front door onto the porch, the 2.2 m side door into the work yard, and the loft
 *   door upstairs.
 * - Loft: 5 × 7.9 m over the kitchen at +3.65 (3.0 m clear below). Three ways out: the
 *   stair along the great room's north wall (26.6°, the Barn's stair slope), the 2.2 m drop
 *   gap in its rail, and the loft door onto the lean-to roof.
 * - Porch: across the lodge's south face, 3.1 m deep, +0.45, roofed at 3.4 m. A 1.0 m rail you
 *   can vault either way (it stands 0.65 m back from the deck's edge: step up onto the lip, then
 *   jump), open at the front door and at its east end.
 * - Lean-to woodshed on the lodge's east side: a solid log store whose roof you can walk on
 *   (22.6°). With the woodpile (1.2 m) and a 0.6 m crate step it makes a walk-up route —
 *   every step 0.6 m, no jump needed — from the yard to the loft door.
 * - Shed (NE): 4.5 × 5.5 m, floor +0.15, a 2.2 m door facing south and a small west window
 *   over the woodpile.
 * - Work yard between the lodge, shed and the middle: a wagon, crates, bins, barrels, sacks.
 * - Campfire plaza south of the porch: a fire pit with two to four logs or stumps round it (the seeker's spawn).
 * - Tent camp (SW): two closed A-frame tents, both flush against the boundary so nobody can
 *   hide in a sliver behind them.
 * - Picnic pavilion (SE): open-sided, two picnic tables under a roof on four 0.6 m posts.
 * - Boundary: an invisible 6 m wall at ±11 m; fence, bushes and rocks inside it, trees outside.
 *
 * Heights and gaps follow the measured ragdoll (Rooftop, Barn and Bomba Sende audits):
 * - ≤ 0.65 m is walked onto (lodge floor 0.45, crate step and every climb step 0.6);
 * - nothing standable lies within 1.5 m below a roof edge or a wall top you should not reach
 *   (shed eave 3.6 over a 1.2 m woodpile, pavilion eave 2.9 over 0.76 m tables);
 * - posts are 0.6 m square (thinner posts trap the ragdoll's arm);
 * - doors are 2.2 × 2.6 m; indoor clear height ≥ 3.0 m (the third-person camera).
 *
 * Nothing here is derived from rendered meshes: the local arena draws the shells from these
 * numbers and the kit's props over their colliders.
 */
export const CAMP = {
  /** Play area half-size: x, z −11…11. */
  half: 11,
  boundary: { height: 6, thickness: 0.5 },
} as const;
const H = CAMP.half;

type Span = readonly [number, number];
export interface Rect {
  readonly x: Span;
  readonly z: Span;
}

// ─── Buildings ──────────────────────────────────────────────────────────────

export const WALL = 0.3;
export const LODGE = { x: [-11, 2] as Span, z: [-11, -2.5] as Span, floor: 0.45, wallTop: 6.8, ridge: 9.3 } as const;
/** Inside faces of the lodge's walls. */
export const LODGE_INSIDE: Rect = { x: [-10.7, 1.7], z: [-10.7, -2.8] };
export const LOFT = {
  x: [-3.3, 1.7] as Span,
  z: [-10.7, -2.8] as Span,
  top: 3.65,
  thickness: 0.2,
  railHeight: 1.0,
  /** The rail along the loft's open (west) edge, and the drop gap south of it. */
  rail: [-8.9, -5.0] as Span,
  drop: [-5.0, -2.8] as Span,
} as const;
/** Along the great room's north wall, rising east from the lodge floor to the loft (26.6°). */
export const STAIR = { x: [-9.7, -3.3] as Span, z: [-10.7, -8.9] as Span, bottom: 0.45, top: 3.65 } as const;
export const PORCH = { x: [-11, 2] as Span, z: [-2.5, 0.6] as Span, top: 0.45, roof: 3.4, roofThickness: 0.15, railHeight: 1.0 } as const;
/** Porch roof posts (x spans, 0.6 m square, at the porch's south edge) and the rails between them. */
export const PORCH_POSTS: readonly Span[] = [
  [-10.7, -10.1],
  [-8.2, -7.6],
  [-5.4, -4.8],
  [-0.4, 0.2],
];
export const PORCH_POST_Z: Span = [-0.4, 0.2];
export const PORCH_RAILS: readonly Span[] = [
  [-10.1, -8.2],
  [-4.8, -0.4],
];
/** The rails stand back from the deck's front edge: a 0.6 m lip to step up on, then vault the 1.0 m rail. */
export const PORCH_RAIL_Z: Span = [-0.15, -0.05];
/** Half-height entry steps (0.22 m) where the 0.45 m floors meet the ground: the porch's front and east openings, the side door. */
export const ENTRY_STEPS: readonly Rect[] = [
  { x: [-7.6, -5.4], z: [0.6, 1.05] },
  { x: [0.2, 2.0], z: [0.6, 1.05] },
  { x: [2.0, 2.45], z: [-2.5, 0.6] },
  { x: [2.0, 2.45], z: [-6.3, -4.1] },
];
export const ENTRY_STEP_HEIGHT = 0.22;
/** The lean-to woodshed: a solid log store (0…low) under a walkable roof rising west to the lodge wall. */
export const LEAN_TO = { x: [2, 5] as Span, z: [-11, -7] as Span, low: 1.8, high: 3.05 } as const;
export const WOODPILE = { x: [5, 6.5] as Span, z: [-11, -7] as Span, top: 1.2 } as const;
export const CRATE_STEP = { x: [5.4, 6.3] as Span, z: [-7, -6.1] as Span, top: 0.6 } as const;
export const SHED = { x: [6.5, 11] as Span, z: [-11, -5.5] as Span, floor: 0.15, wallTop: 3.6, ridge: 4.9 } as const;
export const SHED_INSIDE: Rect = { x: [6.8, 10.7], z: [-10.7, -5.8] };
export const PAVILION = { x: [4, 10] as Span, z: [3.5, 8.5] as Span, post: 0.6, eave: 2.9, roofThickness: 0.15, overhang: 0.3, ridge: 4.1 } as const;
export const PAVILION_POSTS: readonly Rect[] = [
  { x: [4, 4.6], z: [3.5, 4.1] },
  { x: [9.4, 10], z: [3.5, 4.1] },
  { x: [4, 4.6], z: [7.9, 8.5] },
  { x: [9.4, 10], z: [7.9, 8.5] },
];
/** Classic picnic tables (generated): a top between two attached bench planks, long along z. */
export const PICNIC = { length: 1.9, top: 0.8, height: 0.76, bench: 0.35, benchHeight: 0.5 } as const;
export const PICNIC_TABLES: readonly Vec2[] = [
  { x: 5.6, z: 6.0 },
  { x: 8.4, z: 6.0 },
];
export const PLAZA = { x: -1, z: 5, radius: 3.6 } as const;
export const FIRE_PIT = { x: -1, z: 5, radius: 0.75, height: 0.4 } as const;
/** Closed A-frame tents (not enterable), both against the west boundary. `ridge`: the axis the ridge runs along. */
export interface Tent extends Rect {
  readonly ridge: "x" | "z";
  readonly height: number;
  /** The open end's direction (the entrance flap faces this way). */
  readonly entrance: "+x" | "-x" | "+z" | "-z";
}
export const TENTS: readonly Tent[] = [
  { x: [-11, -8.2], z: [1.5, 6.3], ridge: "z", height: 2.0, entrance: "+z" },
  { x: [-11, -6.2], z: [8.2, 11], ridge: "x", height: 2.0, entrance: "+x" },
];

// ─── Walls and openings ─────────────────────────────────────────────────────

export type WallId = "lodgeN" | "lodgeS" | "lodgeW" | "lodgeE" | "shedN" | "shedS" | "shedW" | "shedE";
export interface WallSpec {
  /** The axis the wall runs along; `span` is along it, `across` its thickness range. */
  readonly along: "x" | "z";
  readonly span: Span;
  readonly across: Span;
  readonly top: number;
}
export const WALLS: Readonly<Record<WallId, WallSpec>> = {
  lodgeN: { along: "x", span: LODGE.x, across: [-11, -10.7], top: LODGE.wallTop },
  lodgeS: { along: "x", span: LODGE.x, across: [-2.8, -2.5], top: LODGE.wallTop },
  lodgeW: { along: "z", span: LODGE_INSIDE.z, across: [-11, -10.7], top: LODGE.wallTop },
  lodgeE: { along: "z", span: LODGE_INSIDE.z, across: [1.7, 2], top: LODGE.wallTop },
  shedN: { along: "x", span: SHED.x, across: [-11, -10.7], top: SHED.wallTop },
  shedS: { along: "x", span: SHED.x, across: [-5.8, -5.5], top: SHED.wallTop },
  shedW: { along: "z", span: SHED_INSIDE.z, across: [6.5, 6.8], top: SHED.wallTop },
  shedE: { along: "z", span: SHED_INSIDE.z, across: [10.7, 11], top: SHED.wallTop },
};
export interface Opening {
  readonly wall: WallId;
  readonly kind: "door" | "window";
  readonly label: string;
  /** Along the wall. */
  readonly span: Span;
  readonly bottom: number;
  readonly top: number;
}
/** Doors 2.2 × 2.6 m. Windows are glazed: bodies and shots stop at the glass, sight does not. */
export const OPENINGS: readonly Opening[] = [
  { wall: "lodgeS", kind: "door", label: "front", span: [-7.6, -5.4], bottom: LODGE.floor, top: LODGE.floor + 2.6 },
  { wall: "lodgeE", kind: "door", label: "side", span: [-6.3, -4.1], bottom: LODGE.floor, top: LODGE.floor + 2.6 },
  { wall: "lodgeE", kind: "door", label: "loft", span: [-10.3, -8.1], bottom: LOFT.top, top: LOFT.top + 2.6 },
  { wall: "shedS", kind: "door", label: "shed", span: [7.6, 9.8], bottom: SHED.floor, top: SHED.floor + 2.6 },
  { wall: "lodgeS", kind: "window", label: "great room", span: [-10.0, -8.8], bottom: 1.45, top: 2.65 },
  { wall: "lodgeS", kind: "window", label: "dining", span: [-4.9, -3.7], bottom: 1.45, top: 2.65 },
  { wall: "lodgeS", kind: "window", label: "kitchen", span: [-1.2, 0.2], bottom: 1.45, top: 2.65 },
  { wall: "lodgeS", kind: "window", label: "loft west", span: [-2.6, -1.4], bottom: 4.6, top: 5.8 },
  { wall: "lodgeS", kind: "window", label: "loft east", span: [0.1, 1.3], bottom: 4.6, top: 5.8 },
  { wall: "lodgeE", kind: "window", label: "kitchen east", span: [-3.8, -3.0], bottom: 1.45, top: 2.65 },
  { wall: "shedW", kind: "window", label: "shed", span: [-9.6, -8.4], bottom: 1.35, top: 2.55 },
];
export const GLASS_THICKNESS = 0.06;

// ─── Collider helpers ───────────────────────────────────────────────────────

function box(role: ColliderRole, [x0, x1]: Span, [y0, y1]: Span, [z0, z1]: Span): BoxCollider {
  return {
    role,
    shape: "box",
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    half: { x: (x1 - x0) / 2, y: (y1 - y0) / 2, z: (z1 - z0) / 2 },
  };
}
function ramp(role: ColliderRole, [x0, x1]: Span, [y0, y1]: Span, [z0, z1]: Span, rises: RampCollider["rises"]): RampCollider {
  return { ...box(role, [x0, x1], [y0, y1], [z0, z1]), shape: "ramp", rises };
}
function cylinder(role: ColliderRole, x: number, z: number, y0: number, height: number, radius: number): CylinderCollider {
  return { role, shape: "cylinder", center: { x, y: y0 + height / 2, z }, radius, halfHeight: height / 2 };
}
/** A wall's box between `a` and `b` along it, from `y0` to `y1`. */
function wallPiece(spec: WallSpec, [a, b]: Span, [y0, y1]: Span, role: ColliderRole = "wall"): BoxCollider {
  return spec.along === "x" ? box(role, [a, b], [y0, y1], spec.across) : box(role, spec.across, [y0, y1], [a, b]);
}
/** A wall cut by its openings: full-height pieces between them, sills under windows, lintels over everything, glass in windows. */
export function wallColliders(id: WallId): BoxCollider[] {
  const spec = WALLS[id],
    holes = OPENINGS.filter((o) => o.wall === id).sort((p, q) => p.span[0] - q.span[0]),
    out: BoxCollider[] = [];
  // Doors and windows at the same place on different storeys (the lodge's east wall): cut per storey band.
  const cuts: { span: Span; bands: Span[] }[] = [];
  for (const o of holes) {
    const same = cuts.find((c) => c.span[0] === o.span[0] && c.span[1] === o.span[1]);
    if (same) same.bands.push([o.bottom, o.top]);
    else cuts.push({ span: o.span, bands: [[o.bottom, o.top]] });
  }
  let at = spec.span[0];
  for (const cut of cuts) {
    if (cut.span[0] > at) out.push(wallPiece(spec, [at, cut.span[0]], [0, spec.top]));
    const bands = [...cut.bands].sort((p, q) => p[0] - q[0]);
    let y = 0;
    for (const [bottom, top] of bands) {
      if (bottom > y) out.push(wallPiece(spec, cut.span, [y, bottom]));
      y = top;
    }
    if (spec.top > y) out.push(wallPiece(spec, cut.span, [y, spec.top]));
    at = cut.span[1];
  }
  if (spec.span[1] > at) out.push(wallPiece(spec, [at, spec.span[1]], [0, spec.top]));
  // Glass: a thin pane in the middle of the wall's thickness.
  for (const o of holes) {
    if (o.kind !== "window") continue;
    const mid = (spec.across[0] + spec.across[1]) / 2,
      half = GLASS_THICKNESS / 2,
      pane = spec.along === "x" ? box("glass", o.span, [o.bottom, o.top], [mid - half, mid + half]) : box("glass", [mid - half, mid + half], [o.bottom, o.top], o.span);
    out.push(pane);
  }
  return out;
}

// ─── Placements ─────────────────────────────────────────────────────────────

export type ZoneId = "lodge" | "loft" | "porch" | "leanTo" | "shed" | "yard" | "plaza" | "camp" | "pavilion" | "border";
/** Zones that are inside, upstairs or under a roof (the searchable structures). */
export const STRUCTURE_ZONES: readonly ZoneId[] = ["lodge", "loft", "porch", "leanTo", "shed", "pavilion"];

/** A transformable-looking prop of a round's layout (bottom-centre on `y`, quarter turns). */
export interface DecoyPlacement {
  readonly family: PropFamilyId;
  readonly x: number;
  readonly z: number;
  /** The surface it stands on (m). */
  readonly y: number;
  /** Quarter turns about +Y (yaw = turns · π/2; the model's forward +z turns toward +x). */
  readonly turns: 0 | 1 | 2 | 3;
  readonly zone: ZoneId;
  /** The scene slot it fills and its scene (propHuntScenes.ts); absent in the hand-placed reference layout. */
  readonly slot?: string;
  readonly scene?: string;
}
export interface SceneryPlacement {
  readonly kind: SceneryKind;
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly turns: 0 | 1 | 2 | 3;
  /** Visual only: lean (radians, about the model's own x axis). */
  readonly tilt?: number;
  /** Visual only: uniform scale (ground cover). */
  readonly scale?: number;
}

const L = LODGE.floor,
  U = LOFT.top,
  S = SHED.floor,
  P = PORCH.top;
const d = (family: PropFamilyId, x: number, z: number, y: number, turns: 0 | 1 | 2 | 3, zone: ZoneId): DecoyPlacement => ({ family, x, z, y, turns, zone });

/**
 * The hand-placed V1 layout: 85 props in 20 families, 2–10 of each, every family in ≥ 2 zones.
 * Rounds no longer use it — each round deals its decoys from the scene recipes
 * (propHuntScenes.ts, propHuntLayout.ts) — but it stays as a fixed layout for tests that need known spots
 * (PropHuntGame's `layout` option with REFERENCE_LAYOUT).
 */
export const REFERENCE_DECOYS: readonly DecoyPlacement[] = [
  // Lodge: great room and kitchen (floor +0.45).
  d("log", -9.72, -6.2, L, 1, "lodge"),
  d("armchair", -9.56, -3.425, L, 2, "lodge"),
  d("sideTable", -8.3, -3.4, L, 0, "lodge"),
  d("pottedPlant", -5.8, -8.45, L, 0, "lodge"),
  d("chair", -5.18, -6.9, L, 1, "lodge"),
  d("chair", -5.18, -5.7, L, 1, "lodge"),
  d("chair", -3.42, -6.9, L, 3, "lodge"),
  d("chair", -3.42, -5.7, L, 3, "lodge"),
  d("crate", 1.24, -7.9, L, 0, "lodge"),
  d("metalCan", -2.92, -10.32, L, 0, "lodge"),
  d("dresser", 0.205, -3.16, L, 2, "lodge"),
  d("nightstand", 1.39, -3.11, L, 2, "lodge"),
  // Loft (+3.65).
  d("dresser", -0.425, -10.34, U, 0, "loft"),
  d("nightstand", 0.76, -10.39, U, 0, "loft"),
  d("nightstand", 1.39, -4.79, U, 3, "loft"),
  d("crate", 0.38, -3.26, U, 0, "loft"),
  d("backpack", 1.27, -3.03, U, 0, "loft"),
  d("pottedPlant", -0.48, -3.2, U, 0, "loft"),
  d("armchair", -1.45, -6.25, U, 1, "loft"),
  d("sideTable", -1.45, -7.515, U, 0, "loft"),
  d("backpack", 1.27, -7.83, U, 0, "loft"),
  // Porch (+0.45).
  d("propane", -10.66, -2.16, P, 0, "porch"),
  d("chair", -10.09, -2.23, P, 0, "porch"),
  d("chair", -9.59, -2.23, P, 0, "porch"),
  d("pottedPlant", -8.0, -2.1, P, 0, "porch"),
  d("pottedPlant", -5.0, -2.1, P, 0, "porch"),
  d("armchair", -3.94, -1.875, P, 0, "porch"),
  d("sideTable", -2.68, -1.9, P, 0, "porch"),
  d("log", 0.33, -2.27, P, 0, "porch"),
  d("crate", 1.54, -2.04, P, 0, "porch"),
  // Lean-to: a crate on the woodpile.
  d("crate", 6.04, -10.54, WOODPILE.top, 0, "leanTo"),
  // Work yard (ground).
  d("stump", 2.9, -6.64, 0, 0, "yard"),
  d("crate", 4.3, -6.54, 0, 0, "yard"),
  d("propane", 5.08, -6.68, 0, 0, "yard"),
  d("propane", 6.86, -5.18, 0, 0, "yard"),
  d("metalCan", 2.38, -3.72, 0, 0, "yard"),
  d("wheelieBin", 2.31, -2.91, 0, 0, "yard"),
  d("barrel", 10.61, -5.11, 0, 0, "yard"),
  d("barrel", 10.61, -4.33, 0, 0, "yard"),
  d("barrel", 10.61, -3.55, 0, 0, "yard"),
  d("crate", 10.54, -2.7, 0, 0, "yard"),
  d("crate", 10.54, -1.78, 0, 0, "yard"),
  d("sacks", 9.05, -0.745, 0, 0, "yard"),
  d("sacks", 10.35, -0.745, 0, 0, "yard"),
  d("log", 4.99, -3.155, 0, 0, "yard"),
  d("stump", 6.1, -3.285, 0, 0, "yard"),
  // Shed (+0.15).
  d("crate", 7.26, -10.24, S, 0, "shed"),
  d("crate", 8.18, -10.24, S, 0, "shed"),
  d("sacks", 9.29, -10.125, S, 0, "shed"),
  d("dresser", 7.16, -8.905, S, 1, "shed"),
  d("barrel", 10.31, -8.2, S, 0, "shed"),
  d("propane", 10.38, -6.12, S, 0, "shed"),
  d("wheelieBin", 7.11, -6.2, S, 0, "shed"),
  // Campfire plaza (ground).
  d("log", -1, 2.4, 0, 0, "plaza"),
  d("log", -1, 7.6, 0, 0, "plaza"),
  d("log", -3.6, 5, 0, 1, "plaza"),
  d("log", 1.6, 5, 0, 1, "plaza"),
  d("stump", 1.4, 2.6, 0, 0, "plaza"),
  d("stump", -3.4, 7.4, 0, 0, "plaza"),
  d("boulder", -5.3, 3.0, 0, 0, "camp"),
  // Tent camp (ground).
  d("crate", -3.9, 10.5, 0, 0, "border"),
  d("backpack", -7.97, 3.0, 0, 1, "camp"),
  d("stump", -6.9, 4.4, 0, 0, "camp"),
  d("stump", -6.9, 5.8, 0, 0, "camp"),
  d("chair", -6.0, 4.5, 0, 1, "camp"),
  d("bush", -10.36, 6.94, 0, 0, "camp"),
  d("boulderB", -9.1, 7.6, 0, 0, "camp"),
  d("backpack", -5.77, 9.0, 0, 0, "camp"),
  d("sapling", -4.95, 10.5, 0, 0, "camp"),
  d("propane", -5.88, 10.6, 0, 0, "camp"),
  // Picnic pavilion (ground).
  d("metalCan", 4.45, 5.0, 0, 0, "pavilion"),
  d("backpack", 9.38, 6.0, 0, 1, "pavilion"),
  d("propane", 9.66, 4.42, 0, 0, "pavilion"),
  d("pottedPlant", 4.3, 7.5, 0, 0, "pavilion"),
  d("wheelieBin", 10.69, 3.0, 0, 0, "pavilion"),
  d("flowerBush", 10.36, 7.26, 0, 0, "pavilion"),
  // Border: the south and east edges.
  d("flowerBush", -2.6, 10.36, 0, 0, "border"),
  d("boulderB", -1.36, 10.4, 0, 0, "border"),
  d("flowerBush", 1.8, 10.36, 0, 0, "border"),
  d("sapling", 3.4, 9.36, 0, 0, "border"),
  d("boulder", 4.6, 10.48, 0, 0, "border"),
  d("bush", 7.1, 10.36, 0, 0, "border"),
  d("sapling", 8.24, 10.5, 0, 0, "border"),
  d("boulderB", 10.21, 6.0, 0, 0, "pavilion"),
  d("bush", 10.36, 1.96, 0, 0, "border"),
];

const s = (kind: SceneryKind, x: number, z: number, y: number, turns: 0 | 1 | 2 | 3 = 0, extra: { tilt?: number; scale?: number } = {}): SceneryPlacement => ({ kind, x, z, y, turns, ...extra });
/** Furniture and camp dressing (never transformable). */
export const SCENERY_PLACEMENTS: readonly SceneryPlacement[] = [
  // Great room.
  s("fireplace", -10.34, -6.2, L, 1),
  s("bookshelf", -10.46, -3.9, L, 1),
  s("couch", -7.575, -6.2, L, 3),
  s("rug", -9.0, -6.2, L, 1),
  s("diningTable", -4.3, -6.3, L, 1),
  s("floorLamp", -8.55, -4.45, L),
  s("floorLamp", -6.55, -8.35, L),
  // Kitchen: one counter run on the north wall, facing south.
  s("kitchenDrawers", -1.315, -10.35, L),
  s("kitchenDrawers", -0.685, -10.35, L),
  s("kitchenSink", -0.055, -10.35, L),
  s("kitchenOven", 0.575, -10.35, L),
  s("fridge", 1.295, -10.295, L),
  // Loft.
  s("bunkBed", 1.02, -6.35, U, 0),
  s("rugRound", -1.45, -6.6, U),
  s("floorLamp", -2.9, -3.3, U),
  // Porch and yard.
  s("hangingLamp", -6.5, -1.25, PORCH.roof - 0.66),
  s("hangingLamp", -1.2, -1.25, PORCH.roof - 0.66),
  s("wagon", 6.8, -1.975, 0, 1),
  s("axe", 6.2, -3.285, shapeHeight(PROP_FAMILIES.stump.shape), 0, { tilt: 0.35 }),
  s("shovel", 7.35, -5.62, 0, 0, { tilt: -0.28 }),
  // Plaza, camp and pavilion.
  s("campfire", FIRE_PIT.x, FIRE_PIT.z, 0),
  s("torch", 2.3, 1.75, 0),
  s("torch", -4.3, 1.4, 0),
  s("torch", 2.6, 8.6, 0),
  s("torch", -7.9, 4.3, 0),
  s("bench", -3.2, 0.85, 0, 0),
  // Ground cover (no colliders) along the edges.
  s("fern", -10.5, 1.4, 0, 0, { scale: 0.9 }),
  s("fern", 0.1, 10.6, 0, 1, { scale: 0.8 }),
  s("fern", 10.6, -1.6, 0, 2, { scale: 0.8 }),
  s("agave", 5.9, 10.55, 0, 0, { scale: 0.9 }),
  s("agave", -7.9, 1.3, 0, 1),
  s("flowers", 0.6, 10.7, 0, 0),
  s("flowers", 2.9, 10.6, 0, 1),
  s("flowers", 10.6, 4.6, 0, 2),
  s("flowers", -5.3, 3.3, 0, 3, { scale: 0.8 }),
  s("grass", -8.4, 1.25, 0, 0),
  s("grass", -2.1, 8.8, 0, 1),
  s("grass", 3.3, 3.4, 0, 2),
  s("grass", 10.6, 0.4, 0, 3),
  s("grass", 7.9, 9.2, 0, 1),
  s("grass", -6.3, 7.4, 0, 0),
  s("grass", 2.6, 1.3, 0, 2),
];

/** Shape turned by quarter turns: world half-extents (m). */
export function decoyHalf(p: DecoyPlacement) {
  return footprintHalf(PROP_FAMILIES[p.family].shape, p.turns);
}
export function decoyCollider(p: DecoyPlacement): ArenaCollider {
  const shape = PROP_FAMILIES[p.family].shape;
  if (shape.kind === "cylinder") return cylinder("prop", p.x, p.z, p.y, shape.height, shape.radius);
  const h = decoyHalf(p);
  return box("prop", [p.x - h.x, p.x + h.x], [p.y, p.y + shape.y], [p.z - h.z, p.z + h.z]);
}
export function sceneryCollider(p: SceneryPlacement): BoxCollider | null {
  const c = SCENERY[p.kind].collider;
  if (!c) return null;
  const hx = (p.turns % 2 === 0 ? c.x : c.z) / 2,
    hz = (p.turns % 2 === 0 ? c.z : c.x) / 2;
  return box("furniture", [p.x - hx, p.x + hx], [p.y, p.y + c.y], [p.z - hz, p.z + hz]);
}
/** A picnic table's three solids: the table (top and legs as one) and its two bench planks. */
export function picnicColliders({ x, z }: Vec2): BoxCollider[] {
  const t = PICNIC,
      zs: Span = [z - t.length / 2, z + t.length / 2];
  return [
    box("furniture", [x - t.top / 2, x + t.top / 2], [0, t.height], zs),
    box("furniture", [x - t.top / 2 - t.bench, x - t.top / 2], [0, t.benchHeight], zs),
    box("furniture", [x + t.top / 2, x + t.top / 2 + t.bench], [0, t.benchHeight], zs),
  ];
}
/** A tent's two slopes (a closed prism): nothing can stand on them (≈ 55°). */
export function tentColliders(t: Tent): RampCollider[] {
  if (t.ridge === "z") {
    const mid = (t.x[0] + t.x[1]) / 2;
    return [ramp("tent", [t.x[0], mid], [0, t.height], t.z, "+x"), ramp("tent", [mid, t.x[1]], [0, t.height], t.z, "-x")];
  }
  const mid = (t.z[0] + t.z[1]) / 2;
  return [ramp("tent", t.x, [0, t.height], [t.z[0], mid], "+z"), ramp("tent", t.x, [0, t.height], [mid, t.z[1]], "-z")];
}

// ─── Spawns ─────────────────────────────────────────────────────────────────

export type PropRole = "seeker" | "hider";
/** Pelvis spawns: the seeker south of the fire; the hiders between the fire and the porch. */
export const SEEKER_SPAWN: Vec3 = { x: -0.4, y: 0.9, z: 8.8 };
export const HIDER_SPAWNS: readonly Vec3[] = [
  { x: -2.4, y: 0.9, z: 1.7 },
  { x: 0.6, y: 0.9, z: 1.7 },
];
/** Body yaw (atan2(x, z)): everyone starts facing the lodge (north), the camera behind them over the plaza. */
export const SEEKER_YAW = Math.PI;
export const HIDER_YAW = Math.PI;

// ─── Route clearances ───────────────────────────────────────────────────────

/**
 * Floor areas no decoy may ever stand in, whatever the round's layout: the doorways (inside
 * and out), the stair's foot, approach and top, the loft's walkways to its door and its drop
 * gap (and the drop's landing below), the porch's front walk, steps and exits, the vault
 * landing in front of the porch rails, the shed's entrance, the crate step and the woodpile
 * route up to the lean-to roof, and the spawns. `y`: the floor it applies to (an area under
 * the loft is not blocked by the loft's walkway above it).
 */
export interface RouteClearance extends Rect {
  readonly label: string;
  readonly y: number;
}
const clear = (label: string, y: number, x: Span, z: Span): RouteClearance => ({ label, y, x, z });
export const ROUTE_CLEARANCES: readonly RouteClearance[] = [
  // Lodge floor.
  clear("front door (inside)", LODGE.floor, [-7.9, -5.1], [-4.9, -2.8]),
  clear("side door (inside)", LODGE.floor, [0.1, 1.7], [-6.6, -3.8]),
  clear("stair foot", LODGE.floor, [-10.7, -9.7], [-10.7, -8.9]),
  clear("stair approach", LODGE.floor, [-10.7, -6.9], [-8.9, -7.62]),
  clear("loft drop landing", LODGE.floor, [-4.8, -3.3], [-5.1, -2.8]),
  // Loft.
  clear("stair top", LOFT.top, [-3.3, -1.7], [-10.7, -8.7]),
  clear("loft walk to the loft door", LOFT.top, [-3.3, 1.7], [-9.95, -8.15]),
  clear("loft door (inside)", LOFT.top, [0.3, 1.7], [-10.1, -7.9]),
  clear("loft rail walk", LOFT.top, [-3.2, -2.05], [-8.8, -2.8]),
  clear("loft drop gap", LOFT.top, [-3.3, -1.9], [-5.1, -2.8]),
  // Porch deck.
  clear("porch front walk", PORCH.top, [-11, 2], [-1.25, 0.6]),
  clear("front door (porch)", PORCH.top, [-7.9, -5.1], [-2.5, 0.6]),
  // Ground.
  clear("front steps", 0, [-7.9, -5.1], [0.6, 2.3]),
  clear("porch rail vault landing", 0, [-11, 2.45], [0.6, 1.5]),
  clear("porch east exit", 0, [2.0, 3.6], [-2.5, 1.5]),
  clear("side door (outside)", 0, [1.7, 4.0], [-6.4, -3.8]),
  clear("crate step", 0, [5.0, 6.5], [-7.0, -5.0]),
  clear("shed door (outside)", 0, [7.3, 10.1], [-5.5, -4.2]),
  clear("seeker spawn", 0, [SEEKER_SPAWN.x - 0.6, SEEKER_SPAWN.x + 0.6], [SEEKER_SPAWN.z - 0.6, SEEKER_SPAWN.z + 0.6]),
  ...HIDER_SPAWNS.map((h, k) => clear(`hider spawn ${k + 1}`, 0, [h.x - 0.6, h.x + 0.6], [h.z - 0.6, h.z + 0.6])),
  // Shed floor and the woodpile's top.
  clear("shed door (inside)", SHED.floor, [7.3, 10.1], [-7.0, -5.8]),
  clear("woodpile route", WOODPILE.top, [5.0, 6.5], [-8.8, -7.0]),
];

// ─── The physics map ────────────────────────────────────────────────────────

const B = CAMP.boundary;
export const BOUNDARY: readonly BoxCollider[] = [
  box("boundary", [-H - B.thickness, H + B.thickness], [0, B.height], [-H - B.thickness, -H]),
  box("boundary", [-H - B.thickness, H + B.thickness], [0, B.height], [H, H + B.thickness]),
  box("boundary", [-H - B.thickness, -H], [0, B.height], [-H, H]),
  box("boundary", [H, H + B.thickness], [0, B.height], [-H, H]),
];

/** Every static solid of the camp except the decoys. */
export const STRUCTURE_COLLIDERS: readonly ArenaCollider[] = [
  box("floor", [-30, 30], [-1, 0], [-30, 30]),
  ...BOUNDARY,
  // Lodge: floor, walls, loft, stair.
  box("deck", LODGE.x, [0, LODGE.floor], LODGE.z),
  ...(["lodgeN", "lodgeS", "lodgeW", "lodgeE"] as const).flatMap(wallColliders),
  box("loft", [LOFT.x[0], 2], [LOFT.top - LOFT.thickness, LOFT.top], LOFT.z),
  box("rail", [LOFT.x[0], LOFT.x[0] + 0.1], [LOFT.top, LOFT.top + LOFT.railHeight], LOFT.rail),
  ramp("stairs", STAIR.x, [STAIR.bottom, STAIR.top], STAIR.z, "+x"),
  // Porch.
  box("deck", PORCH.x, [0, PORCH.top], PORCH.z),
  ...PORCH_POSTS.map((x) => box("post", x, [PORCH.top, PORCH.roof], PORCH_POST_Z)),
  ...PORCH_RAILS.map((x) => box("rail", x, [PORCH.top, PORCH.top + PORCH.railHeight], PORCH_RAIL_Z)),
  box("roof", PORCH.x, [PORCH.roof, PORCH.roof + PORCH.roofThickness], [PORCH.z[0], PORCH.z[1] + 0.3]),
  ...ENTRY_STEPS.map((r) => box("step", r.x, [0, ENTRY_STEP_HEIGHT], r.z)),
  // Lean-to, woodpile, crate step.
  box("woodpile", LEAN_TO.x, [0, LEAN_TO.low], LEAN_TO.z),
  ramp("roof", LEAN_TO.x, [LEAN_TO.low, LEAN_TO.high], LEAN_TO.z, "-x"),
  box("woodpile", WOODPILE.x, [0, WOODPILE.top], WOODPILE.z),
  box("step", CRATE_STEP.x, [0, CRATE_STEP.top], CRATE_STEP.z),
  // Shed.
  box("deck", SHED.x, [0, SHED.floor], SHED.z),
  ...(["shedN", "shedS", "shedW", "shedE"] as const).flatMap(wallColliders),
  // Pavilion, picnic tables, fire pit, tents.
  ...PAVILION_POSTS.map((p) => box("post", p.x, [0, PAVILION.eave], p.z)),
  box("roof", [PAVILION.x[0] - PAVILION.overhang, PAVILION.x[1] + PAVILION.overhang], [PAVILION.eave, PAVILION.eave + PAVILION.roofThickness], [PAVILION.z[0] - PAVILION.overhang, PAVILION.z[1] + PAVILION.overhang]),
  ...PICNIC_TABLES.flatMap(picnicColliders),
  cylinder("firepit", FIRE_PIT.x, FIRE_PIT.z, 0, FIRE_PIT.height, FIRE_PIT.radius),
  ...TENTS.flatMap(tentColliders),
  // Furniture and camp dressing with bodies.
  ...SCENERY_PLACEMENTS.map(sceneryCollider).filter((c): c is BoxCollider => c !== null),
];

/**
 * The physics map: the structures only. The decoys change every round (propHuntLayout.ts):
 * PropHuntGame adds the round's decoy colliders to the world and swaps them at each reset.
 * `spawns` are placeholders for the shared physics constructor; PropHuntGame places every body
 * by role.
 */
export const PROP_HUNT_MAP: ArenaMap = {
  id: "prophunt",
  name: "Orman Kampı",
  bounds: { minX: -H, maxX: H, minZ: -H, maxZ: H },
  colliders: STRUCTURE_COLLIDERS,
  spawns: [SEEKER_SPAWN, HIDER_SPAWNS[0], HIDER_SPAWNS[1]],
  spawnYaws: [SEEKER_YAW, HIDER_YAW, HIDER_YAW],
  lethalEdges: [],
  bot: { home: { x: PLAZA.x, z: PLAZA.z }, wander: { x: 0, z: 0, halfX: 9, halfZ: 9 } },
};

// ─── Queries (cameras, bots, presentation; physics uses the colliders) ─────

/** Top of a collider at (x, z), the point clamped into its footprint (ramps: the slope there). */
export function colliderTop(c: ArenaCollider, x: number, z: number): number {
  if (c.shape === "cylinder") return c.center.y + c.halfHeight;
  const { center: m, half: h } = c;
  if (c.shape === "box") return m.y + h.y;
  const alongX = c.rises[1] === "x",
    half = alongX ? h.x : h.z,
    a = Math.max(-half, Math.min(half, alongX ? x - m.x : z - m.z)),
    sign = c.rises[0] === "+" ? 1 : -1;
  return m.y - h.y + (2 * h.y * (sign * a + half)) / (2 * half);
}
/** Whether (x, z) lies within a collider's footprint (grown by `margin`). */
export function overFootprint(c: ArenaCollider, x: number, z: number, margin = 0): boolean {
  if (c.shape === "cylinder") return Math.hypot(x - c.center.x, z - c.center.z) <= c.radius + margin;
  return Math.abs(x - c.center.x) <= c.half.x + margin && Math.abs(z - c.center.z) <= c.half.z + margin;
}
/**
 * Height of the highest standable top at (x, z) that is not above `y` (+ a step's margin):
 * the ground, a floor, a deck, a slope or — with the round's decoy colliders in `extra` — a
 * prop's top. −Infinity outside the play area.
 */
export function surfaceBelow(x: number, z: number, y = Infinity, extra: readonly ArenaCollider[] = []): number {
  if (Math.abs(x) > H || Math.abs(z) > H) return -Infinity;
  let best = 0;
  const limit = y + 0.3;
  for (const list of [PROP_HUNT_MAP.colliders, extra])
    for (const c of list) {
      if (c.role === "floor" || c.role === "boundary" || c.role === "glass" || !overFootprint(c, x, z)) continue;
      const top = colliderTop(c, x, z);
      if (top <= limit && top > best) best = top;
    }
  return best;
}

/** Zone rectangles (floor plan), checked in this order. Upstairs (y ≥ 2.5 inside the lodge) is the loft. */
export const ZONES: readonly { readonly id: ZoneId; readonly rect: Rect }[] = [
  { id: "lodge", rect: LODGE_INSIDE },
  { id: "porch", rect: PORCH },
  { id: "leanTo", rect: { x: [2, 6.5], z: [-11, -7] } },
  { id: "shed", rect: SHED_INSIDE },
  { id: "yard", rect: { x: [2, 11], z: [-7, 0] } },
  { id: "pavilion", rect: { x: [3.6, 11], z: [2.4, 8.9] } },
  { id: "camp", rect: { x: [-11, -4.4], z: [0, 11] } },
  { id: "plaza", rect: { x: [-4.9, 3.2], z: [0, 9.2] } },
  { id: "border", rect: { x: [-11, 11], z: [-11, 11] } },
];
/** The zone a floor point is in (`y`: its surface height). */
export function zoneAt(x: number, z: number, y = 0): ZoneId {
  for (const { id, rect } of ZONES) {
    if (x < rect.x[0] || x > rect.x[1] || z < rect.z[0] || z > rect.z[1]) continue;
    if (id === "lodge" && y >= 2.5) return "loft";
    return id;
  }
  return "border";
}
