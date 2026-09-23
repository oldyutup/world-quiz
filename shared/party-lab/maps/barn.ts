import type { ArenaMap, ArenaCollider, BoxCollider, ColliderRole, RampCollider, Vec3 } from "./types.js";

/**
 * "Ambar" — Barn Shootout arena (layout and physics; the combat rules that use its
 * spawn, weapon and trap spots live in simulation/barn/). A four-wing barn: a 13 m
 * central hall (the hub) with a 9 m wide, 11 m long wing on each side, 35 m across. The wings are around
 * corners from each other, so a player deep in one sees the hub and — past cover
 * placed across the hub's axes — little of the opposite wing, and none of the
 * two beside it.
 *
 * Upper floor at 3.0 m: a broken ring of decks around an 8 × 8 m void over the hub
 * (open to the south, into the entrance wing), with two branches: a catwalk to the
 * hayloft over the north wing's end, and a catwalk over the east wing's stalls.
 * Three routes up, one per side (west ramp, east hay steps, south stairs), each
 * rising toward the hub so its tall end also blocks one side of a wing's mouth;
 * thirteen ways down: rail gaps on the void, the ring's broken ends, open catwalk edges.
 *
 * Heights follow measured ragdoll limits (see barn.test.ts):
 * - ≤ 0.6 m: walked onto without jumping (the hay steps use 0.6 m risers);
 * - 0.8–1.02 m: blocks walking, a jump clears it (barrels, landing bale);
 * - ≥ 1.6 m: full cover — never jump-spammed over, blocks future bullets;
 * - 1.2–1.45 m is avoided for free-standing obstacles (inconsistent jump-spam results).
 * Obstacles on the same level either touch or leave ≥ 1.4 m between them (no ragdoll traps).
 * Props keep their sizes: crates, bales, barrels, stall boards, rails, risers and treads
 * are the Phase 1 pieces, only the space between them grew.
 *
 * Coordinates: metres, +Y up, +X east, +Z south (the entrance wing), floor at y = 0.
 * Nothing here is derived from the visual shell (scene/arenas/buildBarn.ts).
 */
type Range = readonly [number, number];
export interface Rect {
  readonly x: Range;
  readonly z: Range;
}

/** Central hall: x, z −6.5…6.5. */
export const HUB_HALF = 6.5;
/** Wings are 9 m wide and reach 11 m beyond the hub. */
export const WING_HALF = 4.5;
export const OUTER = 17.5;
export const BARN = { minX: -OUTER, maxX: OUTER, minZ: -OUTER, maxZ: OUTER } as const;
export type WingId = "N" | "S" | "E" | "W";
export const WINGS: Readonly<Record<WingId, Rect>> = {
  N: { x: [-WING_HALF, WING_HALF], z: [-OUTER, -HUB_HALF] },
  S: { x: [-WING_HALF, WING_HALF], z: [HUB_HALF, OUTER] },
  E: { x: [HUB_HALF, OUTER], z: [-WING_HALF, WING_HALF] },
  W: { x: [-OUTER, -HUB_HALF], z: [-WING_HALF, WING_HALF] },
};
export const HUB: Rect = { x: [-HUB_HALF, HUB_HALF], z: [-HUB_HALF, HUB_HALF] };
/** Whether a floor point is inside the cross (walls excluded). */
export const insideBarn = (x: number, z: number) =>
  (Math.abs(x) <= HUB_HALF && Math.abs(z) <= HUB_HALF) ||
  (Math.abs(x) <= WING_HALF && Math.abs(z) <= OUTER) ||
  (Math.abs(z) <= WING_HALF && Math.abs(x) <= OUTER);
/** Sightline zones: each wing beyond 3 m from the hub, and the hub itself. */
export type ZoneId = WingId | "HUB";
export const ZONES: Readonly<Record<ZoneId, Rect>> = {
  N: { x: WINGS.N.x, z: [-OUTER, -HUB_HALF - 3] },
  S: { x: WINGS.S.x, z: [HUB_HALF + 3, OUTER] },
  E: { x: [HUB_HALF + 3, OUTER], z: WINGS.E.z },
  W: { x: [-OUTER, -HUB_HALF - 3], z: WINGS.W.z },
  HUB,
};

export const WALL_THICKNESS = 0.4;
/** Gameplay walls: 3.5 m above the upper floor (≥ 1.6 m is jump-spam safe); the shell above is visual. */
export const WALL_HEIGHT = 6.5;

// ─── Upper floor ────────────────────────────────────────────────────────────

export const UPPER_HEIGHT = 3.0;
/** Plank deck on beams: its underside (2.8 m) is the ceiling of the ground floor below. */
export const DECK_THICKNESS = 0.2;
/** The open middle of the ring (x, z −4…4); the ring is also broken over the south wing's mouth. */
export const VOID: Rect = { x: [-4, 4], z: [-4, 4] };
export type DeckId = "RN" | "RW" | "RE" | "RSW" | "RSE" | "NC" | "NL" | "EC";
export interface Deck extends Rect {
  readonly label: string;
}
export const DECKS: Readonly<Record<DeckId, Deck>> = {
  // Ring around the void (2.5 m wide), open to the south between RSW and RSE.
  RN: { label: "ring north", x: [-HUB_HALF, HUB_HALF], z: [-HUB_HALF, -4] },
  RW: { label: "ring west", x: [-HUB_HALF, -4], z: [-4, HUB_HALF] },
  RE: { label: "ring east", x: [4, HUB_HALF], z: [-4, HUB_HALF] },
  RSW: { label: "ring south-west end", x: [-4, -2], z: [4, HUB_HALF] },
  RSE: { label: "ring south-east end", x: [2, 4], z: [4, HUB_HALF] },
  // North wing: a catwalk along the east wall to the hayloft over the north end.
  NC: { label: "north catwalk", x: [2, WING_HALF], z: [-14, -HUB_HALF] },
  NL: { label: "north hayloft", x: [-WING_HALF, WING_HALF], z: [-OUTER, -14] },
  // East wing: a catwalk over the stalls along the south wall, out to the end wall.
  EC: { label: "east catwalk", x: [HUB_HALF, OUTER], z: [2, WING_HALF] },
};

export const RAIL_HEIGHT = 1.0;
export const RAIL_DEPTH = 0.1;
/**
 * Rails on the upper floor's open edges (a 0.1 m band inside the edge). Every other
 * open edge is a drop: the rail gaps are placed so a player can read "down here".
 */
export const RAILS: readonly Rect[] = [
  // Void, north side: railed except its east end, which opens with the east side's north half.
  { x: [-4, 1.7], z: [-4.1, -4] },
  // Void, west side: railed toward the north, open toward the south.
  { x: [-4.1, -4], z: [-4, 0.5] },
  // Void, east side: railed toward the south, open toward the north.
  { x: [4, 4.1], z: [-0.5, 4] },
  // The ring's broken ends face the void on their north side.
  { x: [-4, -2], z: [4, 4.1] },
  { x: [2, 4], z: [4, 4.1] },
  // Over the north wing's mouth: railed above the crates, open in the middle.
  { x: [-WING_HALF, -1.8], z: [-HUB_HALF, -6.4] },
  // Over the west wing's mouth: railed north of the ramp's top, open beside it.
  { x: [-HUB_HALF, -6.4], z: [-WING_HALF, -0.8] },
  // North catwalk: railed along its hub half.
  { x: [2, 2.1], z: [-10.2, -HUB_HALF] },
  // North hayloft front: open 2.8 m toward the catwalk.
  { x: [-WING_HALF, -0.8], z: [-14.1, -14] },
  // East catwalk: railed along its hub half, open toward the end.
  { x: [8.6, 11.6], z: [2, 2.1] },
];

/**
 * Intentional ways down: open deck edges (no rail) a player walks or jumps off onto
 * the ground floor. `edge` is the edge segment, `out` the direction off the deck.
 */
export type DropId = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8" | "D9" | "D10" | "D11" | "D12" | "D13";
export interface Drop {
  readonly id: DropId;
  readonly label: string;
  readonly edge: Rect;
  readonly out: { readonly x: number; readonly z: number };
}
export const DROPS: readonly Drop[] = [
  { id: "D1", label: "void, north side's east end", edge: { x: [1.7, 4], z: [-4, -4] }, out: { x: 0, z: 1 } },
  { id: "D2", label: "void, west opening", edge: { x: [-4, -4], z: [0.5, 4] }, out: { x: 1, z: 0 } },
  { id: "D3", label: "void, east opening", edge: { x: [4, 4], z: [-4, -0.5] }, out: { x: -1, z: 0 } },
  { id: "D4", label: "ring's south-west end", edge: { x: [-2, -2], z: [4, HUB_HALF] }, out: { x: 1, z: 0 } },
  { id: "D5", label: "ring's south-east end", edge: { x: [2, 2], z: [4, HUB_HALF] }, out: { x: -1, z: 0 } },
  { id: "D13", label: "ring's south-west end, over the south wing's mouth", edge: { x: [-WING_HALF, -2], z: [HUB_HALF, HUB_HALF] }, out: { x: 0, z: 1 } },
  { id: "D6", label: "over the north wing's mouth", edge: { x: [-1.8, 2], z: [-HUB_HALF, -HUB_HALF] }, out: { x: 0, z: -1 } },
  { id: "D7", label: "over the west wing's mouth", edge: { x: [-HUB_HALF, -HUB_HALF], z: [-0.8, 2.3] }, out: { x: -1, z: 0 } },
  { id: "D8", label: "over the east wing's mouth", edge: { x: [HUB_HALF, HUB_HALF], z: [-2.3, 2] }, out: { x: 1, z: 0 } },
  { id: "D9", label: "north catwalk, far half", edge: { x: [2, 2], z: [-14, -10.2] }, out: { x: -1, z: 0 } },
  { id: "D10", label: "hayloft front gap", edge: { x: [-0.8, 2], z: [-14, -14] }, out: { x: 0, z: 1 } },
  { id: "D11", label: "east catwalk, hub end", edge: { x: [HUB_HALF, 8.6], z: [2, 2] }, out: { x: 0, z: -1 } },
  { id: "D12", label: "east catwalk, far end", edge: { x: [11.6, OUTER], z: [2, 2] }, out: { x: 0, z: -1 } },
];

/** West route: a 26.6° plank ramp (as the rooftop stairs) along the west wing's south wall, rising east onto the ring. */
export const RAMP: Rect = { x: [-12.5, -HUB_HALF], z: [2.3, WING_HALF] };
/** South route: a wooden stair (same 26.6° wedge) along the south wing's east wall, rising north onto the ring. */
export const STAIRS: Rect = { x: [2, WING_HALF], z: [HUB_HALF, 12.5] };
/** East route: hay-bale steps along the east wing's north wall, rising west to a landing at the ring. */
export const STEPS = { z: [-WING_HALF, -2.3], riser: 0.6, tread: 1.2, count: 4 } as const;
/** Solid landing at deck height between the top hay step and the ring (a clean last 0.6 m riser). */
export const EAST_LANDING: Rect = { x: [HUB_HALF, HUB_HALF + STEPS.tread], z: STEPS.z };
/** Hay step i (1-based) is a column 0.6·i m tall; the landing (3.0 m) is the fifth 0.6 m riser. */
export const stepColumn = (i: number) =>
  ({
    x: [EAST_LANDING.x[1] + STEPS.tread * (STEPS.count - i), EAST_LANDING.x[1] + STEPS.tread * (STEPS.count + 1 - i)] as const,
    y: [0, STEPS.riser * i] as const,
    z: STEPS.z,
  }) as const;

/**
 * Four heavy timber columns under the ring's inner corners (0.6 m square, floor to the
 * deck underside); every other deck edge is carried by beams, brackets and the walls.
 * Measured with the real character (random approaches, persistent pushing): 0.3 m posts
 * leave the ragdoll leaning below 0.6 upright in half the approaches (an arm wraps
 * round), 0.6 m about as rarely as a crate — so there are no thin posts on the floor.
 */
export const POST = 0.6;
const post = (x: number, z: number): Rect => ({ x: [x, x + POST], z: [z, z + POST] });
export const POSTS: readonly Rect[] = [post(-4 - POST, -4 - POST), post(4, -4 - POST), post(-4 - POST, 4), post(4, 4)];

// ─── Cover ──────────────────────────────────────────────────────────────────

export type BarnCoverId =
  | "H1" | "H2" // hub
  | "N1" | "N2" | "N3" | "N4"
  | "S1" | "S2"
  | "E1" | "E2" | "E3"
  | "W1" | "W2" | "W3"
  | "U1" | "U2";
export interface BarnCover {
  readonly id: BarnCoverId;
  readonly role: Extract<ColliderRole, "hay" | "crate" | "stall">;
  readonly label: string;
  readonly x: Range;
  readonly y: Range;
  readonly z: Range;
}
/** Shooter crate ×1.3: 1.03 m cube; a 2 × 2 stack is 2.06 m. */
export const CRATE = 1.03;
/** A kit hay bale lying flat: 1.7 × 0.8 × 1.1 m. */
export const BALE = { long: 1.7, height: 0.8, short: 1.1 } as const;
/** Stall boards: 0.2 m thick, 1.8 m tall. */
export const STALL = { thickness: 0.2, height: 1.8 } as const;
/** A box of `nx` × `nz` crates, two high, from its minimum corner. */
const crates = (x: number, z: number, nx = 2, nz = 1, y = 0) =>
  ({ x: [x, x + nx * CRATE], y: [y, y + 2 * CRATE], z: [z, z + nz * CRATE] }) as const;
/** A bale stack from its minimum corner: `layers` × 0.8 m, long side along x unless `alongZ`. */
const bales = (x: number, z: number, layers: number, { alongZ = false, wide = 1, y = 0 } = {}) => {
  const lx = alongZ ? BALE.short * wide : BALE.long,
    lz = alongZ ? BALE.long : BALE.short * wide;
  return { x: [x, x + lx], y: [y, y + layers * BALE.height], z: [z, z + lz] } as const;
};
const U = UPPER_HEIGHT;
export const COVER: readonly BarnCover[] = [
  // Hub: a tiered hay pile under the void (1.6 m, a 2.4 m bale on top) breaks both long axes.
  { id: "H1", role: "hay", label: "central hay pile", ...bales(-BALE.long, -1.65, 2, { wide: 3 }), x: [-BALE.long, BALE.long] },
  { id: "H2", role: "hay", label: "central hay pile top", ...bales(-BALE.long / 2, -BALE.short / 2, 1, { y: 2 * BALE.height }) },
  // North wing — hay store: stacks under the hayloft, crates across the mouth, a bale tower.
  { id: "N1", role: "crate", label: "north mouth crates", ...crates(-2.6, -8.4) },
  { id: "N2", role: "hay", label: "north bale tower", ...bales(-WING_HALF, -12.6, 3) },
  { id: "N3", role: "hay", label: "hay store stack west", ...bales(-WING_HALF, -OUTER, 2) },
  { id: "N4", role: "hay", label: "hay store stack east", ...bales(1.4, -OUTER, 2) },
  // South wing — entrance yard: a hay stack across the mouth, crates by the west wall.
  { id: "S1", role: "hay", label: "south mouth hay stack", ...bales(-WING_HALF, 9.4, 2) },
  { id: "S2", role: "crate", label: "entrance crate block", ...crates(-WING_HALF, 12.2, 2, 2) },
  // East wing — stalls under the catwalk; crates against the hay steps close the north lane.
  { id: "E1", role: "stall", label: "stall board west", x: [10.4, 10.4 + STALL.thickness], y: [0, STALL.height], z: [2.3, WING_HALF] },
  { id: "E2", role: "stall", label: "stall board east", x: [14.1, 14.1 + STALL.thickness], y: [0, STALL.height], z: [2.3, WING_HALF] },
  { id: "E3", role: "crate", label: "east wing crates", ...crates(9.4, STEPS.z[1]) },
  // West wing — storage: crates along the north wall, crates against the ramp, an end stack.
  { id: "W1", role: "crate", label: "west store crates", ...crates(-12.4, -WING_HALF) },
  { id: "W2", role: "crate", label: "west ramp crates", ...crates(-10.9, RAMP.z[0] - CRATE) },
  { id: "W3", role: "crate", label: "west end crates", ...crates(-OUTER, -2.9, 1, 2) },
  // Upper floor: little cover — one stack on each branch.
  { id: "U1", role: "hay", label: "hayloft stack", ...bales(-2.9, -OUTER, 2, { y: U }) },
  { id: "U2", role: "hay", label: "east catwalk bale", ...bales(12.2, WING_HALF - BALE.short, 1, { y: U }) },
];
/** Hop-over barrels (Medieval barrel ×5: 0.79 m wide, 1.02 m tall). */
export type BarnBarrelId = "B1" | "B2" | "B3";
export const BARREL_SIZE = { radius: 0.4, height: 1.02 } as const;
export const BARRELS: readonly { readonly id: BarnBarrelId; readonly x: number; readonly z: number; readonly yaw: number }[] = [
  { id: "B1", x: -0.3, z: 10.6, yaw: 0.7 },
  { id: "B2", x: -14.6, z: 2.6, yaw: 2.3 },
  { id: "B3", x: 15.4, z: -1.6, yaw: 4.0 },
];

// ─── Spawns, weapons, traps ─────────────────────────────────────────────────

/** Floor position (y = the surface stood on) and facing (atan2(x, z), like the body's yaw) of each respawn candidate. */
export type BarnSpawnId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6";
export interface BarnSpawn extends Vec3 {
  readonly yaw: number;
}
const facing = (dx: number, dz: number) => Math.atan2(dx, dz);
export const SPAWN_CANDIDATES: Readonly<Record<BarnSpawnId, BarnSpawn>> = {
  S1: { x: 0.5, y: 0, z: 13, yaw: facing(0, -1) }, // south yard, looking up the entrance wing at the hub
  S2: { x: 13.5, y: 0, z: -1, yaw: facing(-1, 1) }, // east wing end, looking back toward the stalls and the hub
  // Ring, west side near the west wing's open edge (D7) and the void's west opening (D2), looking
  // north along the ring. It was the north-west corner (−5, −5), where the rails left only a standing
  // player's head in reach from the ground floor (torso/pelvis: 0 of 419 ground spots with the real
  // hitscan); here the hub and the west wing's mouth reach the body (25 spots; any part 107).
  // z = −1 keeps it out of S4's sight (−0.75 would see down the west wing).
  S3: { x: -5.25, y: U, z: -1, yaw: facing(0, -1) },
  S4: { x: -13, y: 0, z: -1, yaw: facing(1, 0) }, // west wing end, looking down the wing at the hub
  S5: { x: 2, y: 0, z: -9.5, yaw: facing(0, 1) }, // north wing beside the catwalk, looking at the hub
  S6: { x: 7, y: U, z: 3.25, yaw: facing(-1, 0) }, // east catwalk, looking back at the ring
};
/** Round start / local test slots 0–2: south yard (the local player), east wing, ring — hidden from each other. */
export const START_SPAWNS = ["S1", "S2", "S3"] as const satisfies readonly BarnSpawnId[];

/** Weapon pickup spots: a few are active at once (simulation/barn/pickups.ts). */
export type BarnWeaponSpotId = "W1" | "W2" | "W3" | "W4" | "W5" | "W6" | "W7";
export const WEAPON_SPOTS: Readonly<Record<BarnWeaponSpotId, Vec3>> = {
  W1: { x: -3.5, y: 0, z: 1.5 }, // risky: under the void, in view of the whole ring
  W2: { x: -2.25, y: 0, z: -15 }, // north hay store, under the hayloft
  W3: { x: -3.25, y: 0, z: 16 }, // south entrance, by the doors
  W4: { x: 12, y: 0, z: 3.25 }, // east stalls, under the catwalk
  W5: { x: -16.25, y: 0, z: 2.5 }, // west wing end
  W6: { x: 2.25, y: U, z: -14.5 }, // hayloft
  W7: { x: 16.25, y: U, z: 3.25 }, // east catwalk end
};
/** Bear traps (simulation/barn/traps.ts), on optional cut-throughs — never on a route up or down. */
export type BarnTrapId = "T1" | "T2";
export const TRAPS: Readonly<Record<BarnTrapId, Vec3>> = {
  T1: { x: 8.3, y: 0, z: 3.3 }, // east stall aisle, the covered short cut along the south wall
  T2: { x: -8, y: 0, z: -3.3 }, // west wing's north lane, the short cut past the store crates
};

// ─── Colliders ──────────────────────────────────────────────────────────────

/** Pelvis restore height above the surface, as on the other maps. */
export const SPAWN_LIFT = 1.6;

function box(role: ColliderRole, [x0, x1]: Range, [y0, y1]: Range, [z0, z1]: Range): BoxCollider {
  return {
    role,
    shape: "box",
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    half: { x: (x1 - x0) / 2, y: (y1 - y0) / 2, z: (z1 - z0) / 2 },
  };
}
function wedge(role: ColliderRole, r: Rect, rises: RampCollider["rises"]): RampCollider {
  return {
    role,
    shape: "ramp",
    rises,
    center: { x: (r.x[0] + r.x[1]) / 2, y: UPPER_HEIGHT / 2, z: (r.z[0] + r.z[1]) / 2 },
    half: { x: (r.x[1] - r.x[0]) / 2, y: UPPER_HEIGHT / 2, z: (r.z[1] - r.z[0]) / 2 },
  };
}

const T = WALL_THICKNESS,
  far = OUTER + T,
  H = WALL_HEIGHT;
/**
 * Solid wall mass outside the cross: two boxes per corner (one reaching the hub's
 * shoulder on each side) and the four end walls.
 */
export const WALL_BLOCKS: readonly { x: Range; z: Range }[] = [
  ...[-1, 1].flatMap((sx) =>
    [-1, 1].flatMap((sz) => {
      const xs = (a: number, b: number): Range => (sx > 0 ? [a, b] : [-b, -a]),
        zs = (a: number, b: number): Range => (sz > 0 ? [a, b] : [-b, -a]);
      return [
        { x: xs(WING_HALF, far), z: zs(HUB_HALF, far) },
        { x: xs(HUB_HALF, far), z: zs(WING_HALF, HUB_HALF) },
      ];
    })
  ),
  { x: [-WING_HALF, WING_HALF], z: [-far, -OUTER] },
  { x: [-WING_HALF, WING_HALF], z: [OUTER, far] },
  { x: [OUTER, far], z: [-WING_HALF, WING_HALF] },
  { x: [-far, -OUTER], z: [-WING_HALF, WING_HALF] },
];

const colliders: ArenaCollider[] = [
  box("floor", [-far, far], [-0.5, 0], [-far, far]),
  ...WALL_BLOCKS.map((w) => box("wall", w.x, [0, H], w.z)),
  ...Object.values(DECKS).map((d) => box("loft", d.x, [UPPER_HEIGHT - DECK_THICKNESS, UPPER_HEIGHT], d.z)),
  box("loft", EAST_LANDING.x, [0, UPPER_HEIGHT], EAST_LANDING.z),
  ...POSTS.map((p) => box("post", p.x, [0, UPPER_HEIGHT - DECK_THICKNESS], p.z)),
  ...RAILS.map((r) => box("rail", r.x, [UPPER_HEIGHT, UPPER_HEIGHT + RAIL_HEIGHT], r.z)),
  wedge("stairs", RAMP, "+x"),
  wedge("stairs", STAIRS, "-z"),
  ...Array.from({ length: STEPS.count }, (_, i) => {
    const s = stepColumn(i + 1);
    return box("step", s.x, s.y, s.z);
  }),
  ...COVER.map((c) => box(c.role, c.x, c.y, c.z)),
  ...BARRELS.map(
    (b): ArenaCollider => ({
      role: "barrel",
      shape: "cylinder",
      center: { x: b.x, y: BARREL_SIZE.height / 2, z: b.z },
      radius: BARREL_SIZE.radius,
      halfHeight: BARREL_SIZE.height / 2,
    })
  ),
];

const lifted = (id: BarnSpawnId): Vec3 => {
  const s = SPAWN_CANDIDATES[id];
  return { x: s.x, y: s.y + SPAWN_LIFT, z: s.z };
};

export const BARN_MAP: ArenaMap = {
  id: "barn",
  name: "Ambar",
  bounds: BARN,
  colliders,
  spawns: [lifted(START_SPAWNS[0]), lifted(START_SPAWNS[1]), lifted(START_SPAWNS[2])],
  spawnYaws: [SPAWN_CANDIDATES[START_SPAWNS[0]].yaw, SPAWN_CANDIDATES[START_SPAWNS[1]].yaw, SPAWN_CANDIDATES[START_SPAWNS[2]].yaw],
  // Enclosed: no lethal edges. Bots are not used here yet (local mode uses standing dummies).
  lethalEdges: [],
  bot: { home: { x: 0, z: 9 }, wander: { x: 0, z: 9, halfX: 2.5, halfZ: 2 } },
};
