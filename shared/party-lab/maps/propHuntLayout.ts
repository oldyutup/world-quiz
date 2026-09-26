import type { ArenaCollider } from "./types.js";
import { CAMP, REFERENCE_DECOYS, ROUTE_CLEARANCES, STRUCTURE_COLLIDERS, decoyCollider, surfaceBelow, zoneAt, type DecoyPlacement } from "./propHunt.js";
import { footprintHalf, PROP_FAMILIES, PROP_FAMILY_IDS, shapeHeight, type PropFamilyId } from "./propHuntProps.js";
import { CONTEXT_FAMILIES, FAMILY_SETTINGS, PROP_SCENES, slotById, variantItems, type PropScene, type PropSlot, type RecipeItem, type SceneVariant, type Side, type Turn } from "./propHuntScenes.js";

/**
 * Saklambaç's per-round prop layouts, dealt from the scene recipes (propHuntScenes.ts):
 *
 *   match seed → round → which scenes change → each changed scene's variant → its props
 *
 * - **Placing** a family in a slot: flush against what the slot backs onto (facing the room, or
 *   the table for a seat), anywhere along its free length in a few steps (small, natural
 *   offsets), a free-standing box in any quarter turn that fits. A pose is only ever used if
 *   it is plausible there (the slot's context), stands on the slot's floor all over, overlaps
 *   no solid, stays out of every route clearance (ROUTE_CLEARANCES: doors, stairs, the loft's
 *   exits, the porch's walk and exits, the shed door, the woodpile route, the spawns) and leaves
 *   no squeeze (a 0.6–1.15 m open gap a body could get wedged in) against a wall or furniture.
 * - **Dealing** a round: the first round realizes every scene; each later one keeps some scenes
 *   exactly as they were and re-rolls the rest (another variant, drawn afresh), so that about
 *   half of the ordinary props change (45–55%, never under 40% or over 60%) — familiar, but
 *   different. Every round has 60–68 decoys and at least two of every family (no prop is ever
 *   the only one of its kind), and no two props overlap or leave a squeeze between them.
 * - Pure and seeded (mulberry32): the same match seed deals the same rounds, so a room server
 *   only needs to send the match seed.
 *
 * Tests (prophuntLayout.test.ts) pin all of it over hundreds of layouts, navigation included.
 */

const H = CAMP.half;

// ─── Placing a family in a slot ─────────────────────────────────────────────

/** A box's quarter turn facing away from a wall on `side` (the model's forward is +z). */
const AWAY: Readonly<Record<Side, Turn>> = { "-z": 0, "-x": 1, "+z": 2, "+x": 3 };
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** How far along its free length a prop may sit, as a share of the slack (−½ one end … ½ the other). */
const ALONG = [-0.5, -0.25, 0, 0.25, 0.5] as const;
/** The same across both axes of a free-standing slot (coarser: two axes). */
const ACROSS = [-0.5, 0, 0.5] as const;
/** Slack (m) under which a prop simply sits centred. */
const MIN_SLACK = 0.08;

/** The quarter turns `family` may take in `slot` (flush boxes: set by the wall; free ones: those that fit; round shapes: 0, any look is drawn later). */
export function slotTurns(s: PropSlot, family: PropFamilyId): Turn[] {
  const shape = PROP_FAMILIES[family].shape;
  const fits = (t: Turn) => {
    const h = footprintHalf(shape, t);
    return 2 * h.x <= s.x[1] - s.x[0] + 1e-6 && 2 * h.z <= s.z[1] - s.z[0] + 1e-6;
  };
  if (shape.kind === "cylinder") return fits(0) ? [0] : [];
  if (s.against.length) {
    const t = ((AWAY[s.against[0]] + (s.faceIn ? 2 : 0)) % 4) as Turn;
    return fits(t) ? [t] : [];
  }
  return s.turns.filter(fits);
}
/** A pose in a slot: a quarter turn and where along the slack (shares, −½…½ per axis). */
export interface Pose {
  readonly turns: Turn;
  readonly u: number;
  readonly v: number;
}
/** `family` in `slot` with `pose`: flush against what it backs onto, `u`/`v` along the free length. */
export function placeIn(s: PropSlot, family: PropFamilyId, pose: Pose): DecoyPlacement {
  const h = footprintHalf(PROP_FAMILIES[family].shape, pose.turns);
  let x = (s.x[0] + s.x[1]) / 2 + pose.u * Math.max(0, s.x[1] - s.x[0] - 2 * h.x),
    z = (s.z[0] + s.z[1]) / 2 + pose.v * Math.max(0, s.z[1] - s.z[0] - 2 * h.z);
  for (const side of s.against) {
    if (side === "-x") x = s.x[0] + h.x;
    else if (side === "+x") x = s.x[1] - h.x;
    else if (side === "-z") z = s.z[0] + h.z;
    else z = s.z[1] - h.z;
  }
  return { family, x: round3(x), z: round3(z), y: s.y, turns: pose.turns, zone: s.zone, slot: s.id, scene: s.scene };
}
/** Every pose worth checking: each turn that fits, a few steps along each axis that has slack and is not flush. */
function candidatePoses(s: PropSlot, family: PropFamilyId): Pose[] {
  const out: Pose[] = [];
  const flushX = s.against.some((a) => a[1] === "x"),
    flushZ = s.against.some((a) => a[1] === "z"),
    free = !s.against.length;
  for (const turns of slotTurns(s, family)) {
    const h = footprintHalf(PROP_FAMILIES[family].shape, turns),
      steps = (flush: boolean, slack: number) => (flush || slack < MIN_SLACK ? [0] : free ? ACROSS : ALONG);
    for (const u of steps(flushX, s.x[1] - s.x[0] - 2 * h.x)) for (const v of steps(flushZ, s.z[1] - s.z[0] - 2 * h.z)) out.push({ turns, u, v });
  }
  return out;
}

// ─── Geometry: footprints, gaps, squeezes ───────────────────────────────────

/** A standing body is 0.92 m wide: a gap narrower than CRACK is closed, one of WALKWAY or more is a walkway. */
export const CRACK = 0.6;
export const WALKWAY = 1.15;
/** Anything rising more than this above the floor walls a passage (lower: stepped onto, it closes nothing). */
const TALL = 0.65;

interface Foot {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Cylinders: centre and radius (the gap is measured to the circle). */
  round: { x: number; z: number; r: number } | null;
  y0: number;
  y1: number;
}
function foot(c: ArenaCollider): Foot {
  if (c.shape === "cylinder") {
    const r = c.radius;
    return { x0: c.center.x - r, x1: c.center.x + r, z0: c.center.z - r, z1: c.center.z + r, round: { x: c.center.x, z: c.center.z, r }, y0: c.center.y - c.halfHeight, y1: c.center.y + c.halfHeight };
  }
  return { x0: c.center.x - c.half.x, x1: c.center.x + c.half.x, z0: c.center.z - c.half.z, z1: c.center.z + c.half.z, round: null, y0: c.center.y - c.half.y, y1: c.center.y + c.half.y };
}
/** Horizontal gap between two footprints (negative: they overlap by that much). */
function gap(a: Foot, b: Foot): number {
  const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1),
    dz = Math.max(a.z0 - b.z1, b.z0 - a.z1);
  if (!a.round && !b.round) return dx > 0 && dz > 0 ? Math.hypot(dx, dz) : Math.max(dx, dz);
  if (a.round && b.round) return Math.hypot(a.round.x - b.round.x, a.round.z - b.round.z) - a.round.r - b.round.r;
  const [c, r] = a.round ? [a.round, b] : [b.round!, a];
  const px = Math.max(r.x0 - c.x, 0, c.x - r.x1),
    pz = Math.max(r.z0 - c.z, 0, c.z - r.z1);
  if (px === 0 && pz === 0) return -Math.min(c.x - r.x0, r.x1 - c.x, c.z - r.z0, r.z1 - c.z) - c.r;
  return Math.hypot(px, pz) - c.r;
}
/** Whether a footprint's interior overlaps the rectangle [x0, x1] × [z0, z1]. */
const overlaps = (f: Foot, x0: number, x1: number, z0: number, z1: number) => f.x0 < x1 - 0.02 && f.x1 > x0 + 0.02 && f.z0 < z1 - 0.02 && f.z1 > z0 + 0.02;
/** Whether floor point (x, z) is inside one of `solids`. */
const inside = (solids: readonly Foot[], x: number, z: number) => solids.some((s) => x >= s.x0 - 0.01 && x <= s.x1 + 0.01 && z >= s.z0 - 0.01 && z <= s.z1 + 0.01);
/**
 * Whether the gap between two footprints is an open passage a body could try to squeeze
 * through: nothing in it (not a wall between two rooms), and — for a gap running along an
 * axis — open at both ends (a gap closed by a wall at one end is a pocket, a dead end).
 */
function passage(a: Foot, b: Foot, solids: readonly Foot[]): boolean {
  const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1),
    dz = Math.max(a.z0 - b.z1, b.z0 - a.z1);
  const [left, right] = a.x0 <= b.x0 ? [a, b] : [b, a],
    [near, far] = a.z0 <= b.z0 ? [a, b] : [b, a];
  const others = solids.filter((s) => s !== a && s !== b),
    walls = [...others, a, b];
  // A sliver of a gap region (two footprints meeting edge to edge, a wall cut into pieces) is
  // widened a little, so the solid filling it is seen.
  const wide = (lo: number, hi: number): [number, number] => (hi - lo < 0.06 ? [(lo + hi) / 2 - 0.03, (lo + hi) / 2 + 0.03] : [lo, hi]);
  if (dx > 0 && dz > 0) return !others.some((s) => overlaps(s, ...wide(left.x1, right.x0), ...wide(near.z1, far.z0)));
  const alongZ = dx > 0,
    lo = alongZ ? Math.max(a.z0, b.z0) : Math.max(a.x0, b.x0),
    hi = alongZ ? Math.min(a.z1, b.z1) : Math.min(a.x1, b.x1),
    g0 = alongZ ? left.x1 : near.z1,
    g1 = alongZ ? right.x0 : far.z0;
  if (others.some((s) => (alongZ ? overlaps(s, ...wide(g0, g1), ...wide(lo, hi)) : overlaps(s, ...wide(lo, hi), ...wide(g0, g1))))) return false;
  // Follow the gap out of each end (walls come in pieces): closed if something fills it across
  // before either side of it gives way (where a side ends, the gap widens: open).
  const point = (across: number, at: number): [number, number] => (alongZ ? [across, at] : [at, across]);
  const closed = (from: number, step: number) => {
    for (let d = 0.06; d <= 1.5; d += 0.1) {
      const at = from + step * d;
      if ([0.1, 0.3, 0.5, 0.7, 0.9].every((k) => inside(others, ...point(g0 + (g1 - g0) * k, at)))) return true;
      if (!inside(walls, ...point(g0 - 0.03, at)) || !inside(walls, ...point(g1 + 0.03, at))) return false;
    }
    return false;
  };
  return !closed(lo, -1) && !closed(hi, 1);
}
/** Solid parts of the camp that can wall a passage at floor `y` (for the squeeze rule), with their footprints. */
const tallAt = new Map<number, Foot[]>();
/** Footprints of wall pieces and window panes (merged per wall line by `mergeWalls`). */
const WALL_FEET = new WeakSet<Foot>();
function tallSolids(y: number): Foot[] {
  let list = tallAt.get(y);
  if (!list) {
    list = STRUCTURE_COLLIDERS.filter((c) => c.role !== "floor")
      .map((c) => {
        const f = foot(c);
        if (c.role === "wall" || c.role === "glass") WALL_FEET.add(f);
        if (c.shape !== "ramp") return f;
        // A walkable slope (the stair, the lean-to roof) walls a passage only where it has risen
        // TALL above this floor; a steep one (a tent's side) is a wall from its foot.
        const alongX = c.rises[1] === "x";
        if ((f.y1 - f.y0) / (alongX ? f.x1 - f.x0 : f.z1 - f.z0) > Math.tan((35 * Math.PI) / 180)) return f;
        const up = c.rises[0] === "+",
          k = (y + TALL - f.y0) / (f.y1 - f.y0);
        if (k >= 1) return null;
        if (k <= 0) return f;
        const [lo, hi] = alongX ? [f.x0, f.x1] : [f.z0, f.z1],
          cut = up ? lo + (hi - lo) * k : hi - (hi - lo) * k,
          span = up ? { lo: cut, hi } : { lo, hi: cut };
        return alongX ? { ...f, x0: span.lo, x1: span.hi } : { ...f, z0: span.lo, z1: span.hi };
      })
      .filter((f): f is Foot => f !== null && f.y1 > y + TALL && f.y0 < y + 1.8);
    tallAt.set(y, (list = mergeWalls(list)));
  }
  return list;
}
/**
 * One wall line's pieces (the parts between openings, a window's sill, pane and lintel) that
 * meet end to end at this level, merged into one footprint: at body height they are one
 * continuous barrier, and a prop beside a window is not "squeezed" against the pane's edge.
 */
function mergeWalls(list: Foot[]): Foot[] {
  const out = [...list];
  const inLine = (a: Foot, b: Foot, across: "x" | "z") =>
    across === "x"
      ? Math.abs(a.x0 - b.x0) < 0.35 && Math.abs(a.x1 - b.x1) < 0.35 && a.x1 - a.x0 < 0.5 && b.x1 - b.x0 < 0.5 && Math.max(a.z0, b.z0) - Math.min(a.z1, b.z1) <= 0.01
      : Math.abs(a.z0 - b.z0) < 0.35 && Math.abs(a.z1 - b.z1) < 0.35 && a.z1 - a.z0 < 0.5 && b.z1 - b.z0 < 0.5 && Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) <= 0.01;
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++)
      for (let j = i + 1; j < out.length && !merged; j++) {
        const a = out[i],
          b = out[j];
        if (a.round || b.round || !WALL_FEET.has(a) || !WALL_FEET.has(b) || !(inLine(a, b, "x") || inLine(a, b, "z"))) continue;
        const union: Foot = { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1), round: null, y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) };
        WALL_FEET.add(union);
        out.splice(j, 1);
        out[i] = union;
        merged = true;
      }
  }
  return out;
}
const solidsAt = new Map<number, Foot[]>();
function solidsOn(y: number): Foot[] {
  let list = solidsAt.get(y);
  if (!list) {
    list = STRUCTURE_COLLIDERS.filter((c) => c.role !== "floor").map(foot).filter((f) => f.y1 > y + 0.02 && f.y0 < y + 2.0);
    solidsAt.set(y, list);
  }
  return list;
}
const squeeze = (g: number) => g > CRACK + 1e-6 && g < WALKWAY - 1e-6;

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Why `family` in `slot` with `pose` is never allowed (null: it is): not plausible there (the
 * slot's context, the family's settings), does not fit, leaves the camp or the slot's zone, does
 * not stand on the slot's floor all over, overlaps a solid, stands in a route clearance, or
 * leaves a squeeze against a wall or furniture (a gap between CRACK and WALKWAY that is an open
 * passage; nooks and props too low to wall anything aside).
 */
export function staticRefusal(s: PropSlot, family: PropFamilyId, pose?: Pose): string | null {
  if (!CONTEXT_FAMILIES[s.context].includes(family)) return `not plausible in a ${s.context} slot`;
  if (!FAMILY_SETTINGS[family].includes(s.setting)) return `not ${s.setting}`;
  const turns = slotTurns(s, family);
  if (!turns.length) return "does not fit";
  for (const candidate of pose ? [pose] : candidatePoses(s, family)) {
    const why = poseRefusal(s, family, candidate);
    if (!why) return null;
    if (pose) return why;
  }
  return "no pose fits";
}
function poseRefusal(s: PropSlot, family: PropFamilyId, pose: Pose): string | null {
  const p = placeIn(s, family, pose),
    c = decoyCollider(p),
    f = foot(c);
  if (f.x0 < s.x[0] - 0.002 || f.x1 > s.x[1] + 0.002 || f.z0 < s.z[0] - 0.002 || f.z1 > s.z[1] + 0.002) return "outside its slot";
  if (Math.abs(p.x) + (f.x1 - f.x0) / 2 > H + 0.001 || Math.abs(p.z) + (f.z1 - f.z0) / 2 > H + 0.001) return "outside the camp";
  if (zoneAt(p.x, p.z, p.y) !== s.zone) return `in zone ${zoneAt(p.x, p.z, p.y)}`;
  const points: [number, number][] = [
    [p.x, p.z],
    [f.x0 + 0.04, f.z0 + 0.04],
    [f.x1 - 0.04, f.z0 + 0.04],
    [f.x0 + 0.04, f.z1 - 0.04],
    [f.x1 - 0.04, f.z1 - 0.04],
  ];
  if (!points.every(([x, z]) => Math.abs(surfaceBelow(x, z, s.y + 0.1) - s.y) < 0.02)) return "not on its floor";
  for (const solid of solidsOn(s.y)) if (gap(f, solid) < -0.012) return "overlaps a solid";
  for (const r of ROUTE_CLEARANCES)
    if (Math.abs(r.y - s.y) < 0.3 && f.x0 < r.x[1] - 0.005 && f.x1 > r.x[0] + 0.005 && f.z0 < r.z[1] - 0.005 && f.z1 > r.z[0] + 0.005) return `in the ${r.label} clearance`;
  if (!s.pocket && shapeHeight(PROP_FAMILIES[family].shape) > TALL)
    for (const solid of tallSolids(s.y)) if (squeeze(gap(f, solid)) && passage(f, solid, tallSolids(s.y))) return `leaves a ${gap(f, solid).toFixed(2)} m squeeze against a solid (${[solid.x0, solid.x1, solid.z0, solid.z1].map((n) => n.toFixed(2)).join(" ")})`;
  return null;
}
const poses = new Map<string, Pose[]>();
/** The poses `family` may take in `slot` (every check passed; computed once, on first use). */
export function slotPoses(s: PropSlot, family: PropFamilyId): readonly Pose[] {
  const key = `${s.id}|${family}`;
  let list = poses.get(key);
  if (!list) {
    list = CONTEXT_FAMILIES[s.context].includes(family) && FAMILY_SETTINGS[family].includes(s.setting) ? candidatePoses(s, family).filter((pose) => poseRefusal(s, family, pose) === null) : [];
    poses.set(key, list);
  }
  return list;
}
const feet = new WeakMap<DecoyPlacement, Foot>();
const placedFoot = (p: DecoyPlacement) => {
  let f = feet.get(p);
  if (!f) feet.set(p, (f = foot(decoyCollider(p))));
  return f;
};
/**
 * Whether two placed props conflict: they overlap, or both are tall and leave a squeeze
 * between them (an open passage 0.6–1.15 m wide; not a pocket along a wall, not in a nook).
 */
export function conflict(p: DecoyPlacement, q: DecoyPlacement): boolean {
  // Far apart (more than two of the largest footprints and a walkway): nothing to check.
  if (Math.abs(p.x - q.x) > 3.3 || Math.abs(p.z - q.z) > 3.3 || Math.abs(p.y - q.y) > 2.5) return false;
  const a = placedFoot(p),
    b = placedFoot(q);
  if (a.y1 <= b.y0 + 0.02 || b.y1 <= a.y0 + 0.02) return false;
  const g = gap(a, b);
  if (g < 0.01) return true;
  const ha = shapeHeight(PROP_FAMILIES[p.family].shape) > TALL,
    hb = shapeHeight(PROP_FAMILIES[q.family].shape) > TALL;
  if (!ha || !hb || !squeeze(g)) return false;
  if ((p.slot && slotById(p.slot)?.pocket) || (q.slot && slotById(q.slot)?.pocket)) return false;
  return passage(a, b, tallSolids(p.y));
}

// ─── Layouts ────────────────────────────────────────────────────────────────

export interface PropLayout {
  /** The seed it was dealt from (null: the hand-placed reference layout). */
  readonly seed: number | null;
  /** A short hash of the placements (8 hex digits): equal layouts, equal ids. */
  readonly id: string;
  readonly decoys: readonly DecoyPlacement[];
  /** One static collider per decoy, same order. */
  readonly colliders: readonly ArenaCollider[];
  /** The variant each scene took (empty for the hand-placed reference layout). */
  readonly scenes: Readonly<Record<string, string>>;
  /** The families in play this round, each with at least two decoys; the others have none. */
  readonly active: readonly PropFamilyId[];
  /** Per family: rounds in a row it has been out of play (0: in play this round). */
  readonly resting: Readonly<Record<PropFamilyId, number>>;
}
/** FNV-1a over the placements (families, positions to the millimetre, turns). */
function hashDecoys(decoys: readonly DecoyPlacement[]): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  };
  for (const d of [...decoys].sort((p, q) => p.x - q.x || p.z - q.z || p.y - q.y)) feed(`${d.family}|${Math.round(d.x * 1000)}|${Math.round(d.y * 1000)}|${Math.round(d.z * 1000)}|${d.turns};`);
  return (h >>> 0).toString(16).padStart(8, "0");
}
const presentFamilies = (decoys: readonly DecoyPlacement[]) => PROP_FAMILY_IDS.filter((f) => decoys.some((d) => d.family === f));
export function layoutOf(decoys: readonly DecoyPlacement[], seed: number | null, scenes: Readonly<Record<string, string>> = {}, resting?: Readonly<Record<PropFamilyId, number>>): PropLayout {
  const active = presentFamilies(decoys);
  return {
    seed,
    id: hashDecoys(decoys),
    decoys,
    colliders: decoys.map(decoyCollider),
    scenes,
    active,
    resting: resting ?? (Object.fromEntries(PROP_FAMILY_IDS.map((f) => [f, active.includes(f) ? 0 : 1])) as Record<PropFamilyId, number>),
  };
}
/** The hand-placed V1 decoys as a fixed layout (tests that need known spots). */
export const REFERENCE_LAYOUT: PropLayout = layoutOf(REFERENCE_DECOYS, null);

/** Seeded 0…1 (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A 32-bit mix (round seeds from a match seed). */
export function mixSeed(a: number, b: number): number {
  let h = Math.imul((a >>> 0) ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Families always in play: the dining table's chairs, the storage crates, the fire's logs and
 * the chopping block's stumps (the camp would not read as itself without them).
 */
export const CORE_FAMILIES: readonly PropFamilyId[] = ["chair", "crate", "log", "stump"];
export const LAYOUT_TUNING = {
  /** Decoys per round (the chopping block included). */
  count: [60, 68] as const,
  /** Families in play per round (drawn uniformly); the rest sit the round out. */
  active: [15, 18] as const,
  /** A family never sits out more rounds in a row than this. */
  maxRest: 2,
  /** A family in play has at least this many decoys (never the only one of its kind)… */
  minPerFamily: 2,
  /** …and at most this many (the common ones may be more). */
  maxPerFamily: { chair: 13, crate: 11, log: 9, stump: 8, backpack: 6, bush: 6, default: 5 } as const,
  /** Share of the ordinary props that change from one round to the next: aimed for… */
  change: [0.45, 0.55] as const,
  /** …and never outside. */
  changeLimits: [0.4, 0.6] as const,
  /** Deals tried per round before the best one is taken. */
  attempts: 48,
} as const;
/** Scenes whose same-kind group is the point (the dining table's chairs, the fire's seats): never trimmed by a family's cap. */
const SET_PIECES = new Set(["lodge.dining", "plaza.fire"]);
export const familyCap = (f: PropFamilyId): number => (LAYOUT_TUNING.maxPerFamily as Record<string, number>)[f] ?? LAYOUT_TUNING.maxPerFamily.default;

const FIXED_SCENES = new Set(PROP_SCENES.filter((s) => s.fixed).map((s) => s.id));
const sceneFixed = (id: string | undefined) => !!id && FIXED_SCENES.has(id);
/** How many props a variant deals on average with only `active` families in play (steers a round's total). */
function meanItems(v: SceneVariant, active: ReadonlySet<PropFamilyId>) {
  const live = (i: RecipeItem) => (i.families.some((f) => active.has(f)) ? i.chance : 0);
  return v.entries.reduce((sum, e) => sum + ("count" in e ? ((e.count[0] + e.count[1]) / 2) * (e.of.reduce((c, i) => c + live(i), 0) / e.of.length) : live(e)), 0);
}
function sceneMean(s: PropScene, active: ReadonlySet<PropFamilyId>) {
  return s.variants.reduce((sum, v) => sum + v.weight * meanItems(v, active), 0) / s.variants.reduce((sum, v) => sum + v.weight, 0);
}
const yields = (v: SceneVariant, f: PropFamilyId) => variantItems(v).some((i) => i.families.includes(f));
const count = (decoys: readonly DecoyPlacement[], f: PropFamilyId) => decoys.reduce((n, d) => n + (d.family === f ? 1 : 0), 0);

/**
 * One scene realized: a variant drawn (weighted: its recipe weight, away from the variant it had
 * if it is changing, toward what the round still needs — families in play short of two, the
 * round's total), then each of its items placed: a slot out of the item's list, a family in play
 * out of its list, a pose that fits and conflicts with nothing already placed. An item with no
 * family in play, or no room, is skipped (the scene simply has one prop fewer). `force`: the
 * repair pass needs this family here (only variants that can hold it; its items always come).
 * `fill`: the round is short of props — this variant again, with every optional item (a pick
 * still draws how many: a cluster's count is never pushed to its most).
 */
function realize(
  scene: PropScene,
  rng: () => number,
  others: readonly DecoyPlacement[],
  active: ReadonlySet<PropFamilyId>,
  want: number,
  previous: string | null,
  force: PropFamilyId | null = null,
  fill: string | null = null
): { variant: string; decoys: DecoyPlacement[] } {
  const needed = [...active].filter((f) => count(others, f) < LAYOUT_TUNING.minPerFamily);
  const weights = scene.variants.map((v) => {
    const mean = meanItems(v, active);
    if (fill) return v.id === fill ? 1 : 0;
    if (force ? !yields(v, force) : mean === 0 && v.entries.length) return 0;
    let w = v.weight * Math.exp(-((mean - want) ** 2) / 18);
    for (const f of needed) if (yields(v, f)) w *= 3;
    if (scene.variants.length > 1 && v.id === previous) w *= 0.3;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let draw = rng() * total,
    chosen = scene.variants[0];
  for (let k = 0; k < weights.length; k++) if (weights[k] > 0) chosen = scene.variants[k];
  for (let k = 0; k < weights.length && total > 0; k++)
    if (weights[k] > 0 && (draw -= weights[k]) <= 0) {
      chosen = scene.variants[k];
      break;
    }
  // The items: picks drawn (how many, which), chances rolled; a forced family's items always come.
  const live = (i: RecipeItem) => i.families.some((f) => active.has(f));
  const items: RecipeItem[] = [];
  for (const e of chosen.entries) {
    if ("count" in e) {
      const n = e.count[0] + Math.floor(rng() * (e.count[1] - e.count[0] + 1));
      const drawn = shuffle([...e.of], rng);
      if (force && !drawn.slice(0, n).some((i) => i.families.includes(force))) {
        const k = drawn.findIndex((i) => i.families.includes(force));
        if (k >= n && n > 0) [drawn[0], drawn[k]] = [drawn[k], drawn[0]];
      }
      items.push(...drawn.slice(0, n).filter((i) => live(i) && (fill || i.families.includes(force!) || rng() < i.chance)));
    } else if (live(e) && (fill || e.families.includes(force!) || rng() < (needed.some((f) => e.families.includes(f)) ? Math.min(1, e.chance * 1.6) : e.chance))) items.push(e);
  }
  const out: DecoyPlacement[] = [],
    used = new Set<string>();
  for (const it of items) {
    const slots = [...new Set(shuffle([...it.slots], rng))].filter((id) => !used.has(id));
    const families = it.families
      // The camp's two set pieces are never cut short (the table keeps its chairs, the fire its seats).
      .filter((f) => active.has(f) && (SET_PIECES.has(scene.id) || count(others, f) + count(out, f) < familyCap(f)))
      .map((f) => ({ f, w: f === force ? 100 : (needed.includes(f) ? 4 : 1) * (0.5 + rng()) }))
      .sort((a, b) => b.w - a.w)
      .map((o) => o.f);
    let done: DecoyPlacement | null = null;
    for (const f of families) {
      for (const id of slots) {
        const slot = slotById(id)!;
        for (const pose of shuffle([...slotPoses(slot, f)], rng)) {
          const cylinder = PROP_FAMILIES[f].shape.kind === "cylinder";
          // Round shapes: any look (the collider is the same whichever way they face).
          const p = placeIn(slot, f, cylinder ? { ...pose, turns: Math.floor(rng() * 4) as Turn } : pose);
          if (others.some((d) => conflict(d, p)) || out.some((d) => conflict(d, p))) continue;
          done = p;
          break;
        }
        if (done) {
          used.add(id);
          break;
        }
      }
      if (done) break;
    }
    if (done) out.push(done);
  }
  return { variant: chosen.id, decoys: out };
}
function shuffle<T>(list: T[], rng: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * The round's family pool: the core families always, the others all but 2–5 of them (so 15–18
 * in play). A family that has been in play longest is likeliest to sit out; one that already sat
 * out `maxRest` rounds in a row is always back.
 */
function drawPool(rng: () => number, previous: PropLayout | null): Set<PropFamilyId> {
  const T = LAYOUT_TUNING,
    size = T.active[0] + Math.floor(rng() * (T.active[1] - T.active[0] + 1)),
    candidates = PROP_FAMILY_IDS.filter((f) => !CORE_FAMILIES.includes(f) && (previous?.resting[f] ?? 0) < T.maxRest),
    // Rounds in play (from the chain of layouts is not kept: a family resting now weighs less, one in play more).
    weight = (f: PropFamilyId) => ((previous?.resting[f] ?? 0) > 0 ? 0.5 : 1.5),
    out = new Set(PROP_FAMILY_IDS);
  for (let resting = 0; resting < PROP_FAMILY_IDS.length - size && candidates.length; resting++) {
    let draw = rng() * candidates.reduce((sum, f) => sum + weight(f), 0),
      k = candidates.length - 1;
    for (let i = 0; i < candidates.length; i++) if ((draw -= weight(candidates[i])) <= 0) {
      k = i;
      break;
    }
    out.delete(candidates[k]);
    candidates.splice(k, 1);
  }
  return out;
}

/**
 * One deal: the family pool drawn; `previous` null → every scene realized; otherwise a share of
 * the scenes (about half of the ordinary props, and every scene holding a family now sitting out)
 * re-rolled and the rest kept exactly. Then a repair pass: a family in play short of two gets a
 * scene that can hold it re-dealt with it; one left with a single prop sits the round out instead
 * (its prop goes), so no family is ever the only one of its kind. Decoys come out in scene order.
 */
function deal(seed: number, previous: PropLayout | null, rng: () => number): PropLayout {
  const T = LAYOUT_TUNING;
  const target = T.count[0] + Math.floor(rng() * (T.count[1] - T.count[0] + 1));
  const active = drawPool(rng, previous);
  const kept = new Set<string>();
  if (previous && Object.keys(previous.scenes).length) {
    // Scenes to change: those holding a family now out of play, then others in random order, until
    // they hold about the share to change of last round's ordinary props.
    const counts = new Map<string, number>();
    for (const d of previous.decoys) if (d.scene) counts.set(d.scene, (counts.get(d.scene) ?? 0) + 1);
    const outOfPlay = (s: PropScene) => previous.decoys.some((d) => d.scene === s.id && !active.has(d.family));
    const movable = shuffle(PROP_SCENES.filter((s) => !s.fixed && s.id in previous.scenes), rng).sort((a, b) => Number(outOfPlay(b)) - Number(outOfPlay(a)));
    const ordinary = previous.decoys.filter((d) => !sceneFixed(d.scene)).length,
      // A changing scene often keeps a prop or two where they were: aim a little over half.
      share = 0.53 + (rng() - 0.5) * 0.16;
    let changing = 0;
    for (const s of movable) {
      if (changing >= share * ordinary && !outOfPlay(s)) kept.add(s.id);
      else changing += Math.max(0.5, counts.get(s.id) ?? 0);
    }
    for (const s of PROP_SCENES) if (s.fixed && s.id in previous.scenes) kept.add(s.id);
  }
  const scenes: Record<string, string> = {};
  const byScene = new Map<string, DecoyPlacement[]>();
  for (const s of PROP_SCENES)
    if (kept.has(s.id)) {
      byScene.set(s.id, previous!.decoys.filter((d) => d.scene === s.id));
      scenes[s.id] = previous!.scenes[s.id];
    }
  const all = (except?: string) => [...byScene].flatMap(([id, list]) => (id === except ? [] : list));
  const changing = shuffle(PROP_SCENES.filter((s) => !kept.has(s.id)), rng);
  changing.forEach((s, k) => {
    const placed = all(),
      later = changing.slice(k + 1).reduce((sum, o) => sum + sceneMean(o, active), 0);
    const done = realize(s, rng, placed, active, target - placed.length - later, previous?.scenes[s.id] ?? null);
    byScene.set(s.id, done.decoys);
    scenes[s.id] = done.variant;
  });
  // Repair: every family in play gets its two (a scene that can hold it re-dealt with it).
  const tried = new Set<string>();
  for (let pass = 0; pass < 12; pass++) {
    const decoys = all(),
      short = [...active].filter((f) => count(decoys, f) < T.minPerFamily).sort((a, b) => count(decoys, b) - count(decoys, a));
    const f = short.find((x) => !tried.has(x));
    if (!f) break;
    const candidates = shuffle(
      PROP_SCENES.filter((s) => !s.fixed && !tried.has(`${f}|${s.id}`) && s.variants.some((v) => yields(v, f)) && !byScene.get(s.id)?.some((d) => d.family === f)),
      rng
    ).sort((a, b) => Number(kept.has(a.id)) - Number(kept.has(b.id)));
    // Never take away the second prop of another family in play.
    const scene = candidates.find((s) => (byScene.get(s.id) ?? []).every((d) => d.family === f || count(decoys, d.family) > T.minPerFamily || !active.has(d.family)));
    if (!scene) {
      tried.add(f);
      continue;
    }
    tried.add(`${f}|${scene.id}`);
    const others = all(scene.id);
    const done = realize(scene, rng, others, active, (byScene.get(scene.id) ?? []).length, previous?.scenes[scene.id] ?? null, f);
    if (!done.decoys.some((d) => d.family === f)) continue;
    const lost = PROP_FAMILY_IDS.some((g) => g !== f && active.has(g) && count(decoys, g) >= T.minPerFamily && count([...others, ...done.decoys], g) < T.minPerFamily);
    if (lost) continue;
    byScene.set(scene.id, done.decoys);
    scenes[scene.id] = done.variant;
    kept.delete(scene.id);
  }
  // Short of the round's total: a few changing scenes get every item of their variant.
  for (const s of shuffle(PROP_SCENES.filter((x) => !x.fixed && !kept.has(x.id)), rng)) {
    const now = all();
    if (now.length >= target) break;
    const before = byScene.get(s.id) ?? [],
      others = all(s.id),
      done = realize(s, rng, others, active, 0, null, null, scenes[s.id]);
    if (done.decoys.length <= before.length) continue;
    // Never at the cost of a family's second prop.
    if (PROP_FAMILY_IDS.some((g) => active.has(g) && count(now, g) >= T.minPerFamily && count([...others, ...done.decoys], g) < T.minPerFamily)) continue;
    byScene.set(s.id, done.decoys);
  }
  // A family still short sits the round out: its lone prop goes (never the only one of its kind).
  for (const f of PROP_FAMILY_IDS) {
    if (count(all(), f) >= T.minPerFamily) continue;
    active.delete(f);
    for (const [id, list] of byScene) byScene.set(id, list.filter((d) => d.family !== f || sceneFixed(d.scene)));
  }
  const decoys = PROP_SCENES.flatMap((s) => byScene.get(s.id) ?? []);
  const resting = Object.fromEntries(PROP_FAMILY_IDS.map((f) => [f, decoys.some((d) => d.family === f) ? 0 : (previous?.resting[f] ?? 0) + 1])) as Record<PropFamilyId, number>;
  return layoutOf(decoys, seed, Object.fromEntries(PROP_SCENES.map((s) => [s.id, scenes[s.id]])), resting);
}

/**
 * What is wrong with a deal (null: nothing): its total; a family with a single prop, too many,
 * or out of play too long; too few or too many families in play; a core family missing; its
 * change from `previous` outside `limits`.
 */
export function layoutProblem(layout: PropLayout, previous: PropLayout | null, limits: readonly [number, number] = LAYOUT_TUNING.changeLimits): string | null {
  const T = LAYOUT_TUNING,
    n = layout.decoys.length;
  if (n < T.count[0] || n > T.count[1]) return `${n} decoys`;
  for (const f of PROP_FAMILY_IDS) {
    const c = count(layout.decoys, f);
    if (c === 1 || c > familyCap(f)) return `${c} × ${f}`;
    if (!c && CORE_FAMILIES.includes(f)) return `no ${f}`;
    if (layout.resting[f] > T.maxRest) return `${f} out of play ${layout.resting[f]} rounds`;
  }
  if (layout.active.length < T.active[0] || layout.active.length > T.active[1]) return `${layout.active.length} families in play`;
  if (previous) {
    if (layout.id === previous.id) return "the same layout";
    const change = layoutChange(previous, layout);
    if (change < limits[0] || change > limits[1]) return `${Math.round(change * 100)}% changed`;
  }
  return null;
}
/**
 * Deals from `seed`: tries up to `attempts` deals (each from its own sub-seed), takes the first
 * that passes with its change in the aimed band, else the passing one closest to half changed.
 */
function dealFrom(seed: number, previous: PropLayout | null): PropLayout {
  let best: { layout: PropLayout; score: number } | null = null;
  for (let attempt = 0; attempt < LAYOUT_TUNING.attempts; attempt++) {
    const layout = deal(seed, previous, random(mixSeed(seed ^ 0x5eed, attempt)));
    if (layoutProblem(layout, previous)) continue;
    if (!previous || !layoutProblem(layout, previous, LAYOUT_TUNING.change)) return layout;
    const score = Math.abs(layoutChange(previous, layout) - 0.5);
    if (!best || score < best.score) best = { layout, score };
  }
  if (best) return best.layout;
  throw new Error(`Saklambaç: no layout for seed ${seed}`);
}
/** A fresh layout from `seed` (every scene realized): a match's first round. */
export function generatePropLayout(seed: number): PropLayout {
  return dealFrom(seed, null);
}

/**
 * Share of `next`'s ordinary (not fixed) decoys that `previous` did not have at the same spot
 * (same family, same place to 5 cm, same turn — a round prop's turn does not count): 0
 * identical … 1 all new.
 */
export function layoutChange(previous: PropLayout, next: PropLayout): number {
  const ordinary = next.decoys.filter((d) => !sceneFixed(d.scene));
  if (!ordinary.length) return 0;
  const same = ordinary.filter((d) =>
    previous.decoys.some((p) => p.family === d.family && (p.turns === d.turns || PROP_FAMILIES[d.family].shape.kind === "cylinder") && Math.abs(p.y - d.y) < 0.05 && Math.hypot(p.x - d.x, p.z - d.z) < 0.05)
  ).length;
  return 1 - same / ordinary.length;
}
/** Round `round`'s seed in the match seeded by `match`. */
export const roundSeed = (match: number, round: number) => mixSeed(match, round);
/**
 * Round `round`'s layout in the match seeded by `match`: round 0 is dealt fresh; each later
 * round from the one before it (`previous`; recomputed from round 0 when not given), keeping
 * about half of it. The same match seed always deals the same sequence.
 */
export function roundLayout(match: number, round: number, previous: PropLayout | null = null): PropLayout {
  if (round <= 0) return generatePropLayout(roundSeed(match, 0));
  let before = previous;
  if (!before) for (let r = 0; r < round; r++) before = roundLayout(match, r, before);
  return dealFrom(roundSeed(match, round), before);
}
