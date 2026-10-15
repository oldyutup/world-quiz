import type { ArenaCollider, ArenaMap, BoxCollider, Vec3 } from "./types.js";
import { BOUNDARY, box, cutWall, surfaceIn, type Rect, type RouteClearance, type Span, type WallSpec } from "./propHunt.js";
import type { MarketZoneId, ZoneId } from "./propTypes.js";

/**
 * "Market" — Saklambaç's second map: a one-storey supermarket, 22 × 22 m of play like the camp
 * (x, z −11…11, floor y 0), all indoors under a 5 m ceiling. +X east, +Z south, north at −Z (the
 * fridge wall), the glass shop front and the entrance along the south edge.
 *
 * Zones (see MARKET_ZONES):
 * - Fridges (NW, along the north wall): a run of upright glass-door fridges, two chest-freezer
 *   islands in front of them.
 * - Depot (NE): a back room behind full-height walls, a pallet rack along its north wall. Two
 *   2.2 m doorways (one from the shop floor, one from the fridge aisle), so it is never a dead end.
 * - Produce (W): a sloped produce rack on the west wall, two produce tables, the watermelon pile.
 * - Aisles (middle and east): three double-sided shelf gondolas (2.2 m, cans, breakfast boxes,
 *   snacks) and a drinks wall on the east wall, 2.6 m aisles, end caps at both ends.
 * - Checkout (SW): three checkout counters with 3.1 m lanes between them.
 * - Entrance (SE): the glass doors (closed: the play area ends at the shop front), the cart
 *   corral and the basket stacks. The seeker starts here.
 *
 * Heights and gaps follow the camp's rules (maps/propHunt.ts): structures stand ≥ 1.4 m apart
 * or touch (no gap a ragdoll could wedge in); counters (0.95 m), freezers (0.9 m) and produce
 * tables (0.85 m) are jumpable, shelves and fridges are not; doors are 2.2 × 2.6 m; the ceiling
 * is 5 m (the shoulder camera rides at ~3.4 m, over the 2.2 m shelves).
 *
 * The ordinary decoys are dealt per round from marketScenes.ts (marketLayout.ts); this file is
 * the architecture and the fixtures only. Nothing here is derived from rendered meshes: the
 * arena draws the shells and fixtures from these numbers.
 */
export const MARKET = {
  /** Play area half-size: x, z −11…11. */
  half: 11,
  /** Wall inside faces. */
  inside: 10.7,
  /** The ceiling (camera only: nothing reaches it). */
  ceiling: 5.0,
  boundary: { height: 6, thickness: 0.5 },
} as const;
const H = MARKET.half,
  I = MARKET.inside,
  C = MARKET.ceiling;

// ─── Walls ──────────────────────────────────────────────────────────────────

export type MarketWallId = "north" | "west" | "east" | "front" | "depotS" | "depotW";
export const MARKET_WALLS: Readonly<Record<MarketWallId, WallSpec>> = {
  north: { along: "x", span: [-H, H], across: [-H, -I], top: C },
  west: { along: "z", span: [-I, I], across: [-H, -I], top: C },
  east: { along: "z", span: [-I, I], across: [I, H], top: C },
  /** The shop front: a low wall, big windows and the (closed) glass entrance doors. */
  front: { along: "x", span: [-H, H], across: [I, H], top: C },
  /** The depot's walls, up to the ceiling. */
  depotS: { along: "x", span: [3.5, I], across: [-6.3, -6.0], top: C },
  depotW: { along: "z", span: [-I, -6.3], across: [3.5, 3.8], top: C },
};
/** The depot (inside faces of its walls). */
export const DEPOT: Rect = { x: [3.8, I], z: [-I, -6.3] };
export interface MarketOpening {
  readonly wall: MarketWallId;
  readonly kind: "door" | "window";
  readonly label: string;
  readonly span: Span;
  readonly bottom: number;
  readonly top: number;
}
/** Doorways are open (2.2 × 2.6 m); windows and the entrance doors are glass (bodies and shots stop, sight does not). */
export const MARKET_OPENINGS: readonly MarketOpening[] = [
  { wall: "depotS", kind: "door", label: "depot (shop floor)", span: [6.2, 8.4], bottom: 0, top: 2.6 },
  { wall: "depotW", kind: "door", label: "depot (fridges)", span: [-9.4, -7.2], bottom: 0, top: 2.6 },
  { wall: "front", kind: "window", label: "front west", span: [-10.2, -4.6], bottom: 0.6, top: 3.2 },
  { wall: "front", kind: "window", label: "front middle", span: [-4.0, 1.6], bottom: 0.6, top: 3.2 },
  { wall: "front", kind: "window", label: "front east", span: [2.2, 5.6], bottom: 0.6, top: 3.2 },
  { wall: "front", kind: "window", label: "entrance doors", span: [6.0, 8.6], bottom: 0.02, top: 2.7 },
  { wall: "front", kind: "window", label: "front corner", span: [9.2, 10.4], bottom: 0.6, top: 3.2 },
];
export const marketWallColliders = (id: MarketWallId): BoxCollider[] => cutWall(MARKET_WALLS[id], MARKET_OPENINGS.filter((o) => o.wall === id));

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * The shop's fixed furniture (drawn in code, scene/prophunt/market/arena.ts): every one a solid
 * box (one collider, nothing to hide inside), never transformable.
 * - `fridge`: upright glass-door fridges (2.4 m), `freezer`: chest freezers (0.9 m);
 * - `gondola`: a double-sided shelf unit (2.2 m), `wallShelf`: a one-sided one against a wall (2.4 m);
 * - `produceRack`: the sloped fruit-and-veg display on the west wall (1.25 m at the back);
 * - `produceTable`: a fruit table (0.85 m) with produce crates on top, `melonPile`: the watermelon heap (0.95 m: its bin and melons);
 * - `checkout`: a checkout counter (0.95 m) with its belt, `palletRack`: the depot's heavy rack (3.0 m).
 */
export type FixtureKind = "fridge" | "freezer" | "gondola" | "wallShelf" | "produceRack" | "produceTable" | "melonPile" | "checkout" | "palletRack";
export interface Fixture extends Rect {
  readonly kind: FixtureKind;
  readonly height: number;
  /** The side a one-sided fixture faces (its shelves, its fridge doors, the cashier's back for a counter). */
  readonly faces?: "+x" | "-x" | "+z" | "-z";
  /** What it carries (shelf stock, fridge contents): the arena fills it from this. */
  readonly stock?: string;
}
const fx = (kind: FixtureKind, x: Span, z: Span, height: number, extra: { faces?: Fixture["faces"]; stock?: string } = {}): Fixture => ({ kind, x, z, height, ...extra });
/** The three gondolas run north–south between the cross aisles. */
export const GONDOLA_Z: Span = [-3.5, 3.5];
export const GONDOLAS: readonly Span[] = [
  [-1.1, 0.0],
  [2.6, 3.7],
  [6.3, 7.4],
];
export const CHECKOUTS: readonly Span[] = [
  [-6.85, -5.95],
  [-2.85, -1.95],
  [1.15, 2.05],
];
export const CHECKOUT_Z: Span = [6.8, 9.4];
export const MARKET_FIXTURES: readonly Fixture[] = [
  // Fridges along the north wall (west of the depot), freezer islands in front of them.
  fx("fridge", [-I, 1.9], [-I, -9.8], 2.4, { faces: "+z", stock: "fridge" }),
  fx("freezer", [-9.4, -5.4], [-7.6, -6.6], 0.9, { stock: "icecream" }),
  fx("freezer", [-3.4, 0.6], [-7.6, -6.6], 0.9, { stock: "frozen" }),
  // Depot.
  fx("palletRack", [3.8, I], [-I, -9.6], 3.0, { faces: "+z" }),
  // Produce.
  fx("produceRack", [-I, -9.7], [-5.0, 3.5], 1.25, { faces: "+x" }),
  fx("produceTable", [-8.4, -7.4], [-4.3, -1.7], 0.85, { stock: "fruit" }),
  fx("produceTable", [-8.4, -7.4], [0.0, 2.6], 0.85, { stock: "veg" }),
  fx("melonPile", [-5.9, -4.3], [-3.2, -1.6], 0.95),
  // Aisles: three gondolas and the drinks wall.
  fx("gondola", GONDOLAS[0], GONDOLA_Z, 2.2, { stock: "cans" }),
  fx("gondola", GONDOLAS[1], GONDOLA_Z, 2.2, { stock: "breakfast" }),
  fx("gondola", GONDOLAS[2], GONDOLA_Z, 2.2, { stock: "snacks" }),
  fx("wallShelf", [10.0, I], [-6.0, 4.6], 2.4, { faces: "-x", stock: "drinks" }),
  // Checkout counters (the cashier sits on the counter's west side).
  ...CHECKOUTS.map((x) => fx("checkout", x, CHECKOUT_Z, 0.95, { faces: "-x" })),
];
export const fixtureCollider = (f: Fixture): BoxCollider => box("furniture", f.x, [0, f.height], f.z);

// ─── Spawns ─────────────────────────────────────────────────────────────────

/** Pelvis spawns: the seeker just inside the entrance doors; the hiders in the front cross aisle, 3 m apart. */
export const MARKET_SEEKER_SPAWN: Vec3 = { x: 7.3, y: 0.9, z: 9.3 };
export const MARKET_HIDER_SPAWNS: readonly Vec3[] = [
  { x: -0.4, y: 0.9, z: 5.4 },
  { x: 2.6, y: 0.9, z: 5.4 },
];
/** Everyone starts facing into the shop (north). */
export const MARKET_SEEKER_YAW = Math.PI;
export const MARKET_HIDER_YAW = Math.PI;

// ─── Route clearances ───────────────────────────────────────────────────────

const clear = (label: string, x: Span, z: Span): RouteClearance => ({ label, y: 0, x, z });
/**
 * Floor areas no decoy may ever stand in: the depot's doorways (inside and out), the entrance
 * (the seeker's spawn and the glass doors), the spawns, the ends of the checkout lanes, and
 * the fridge aisle's ends (both ways into it stay open).
 */
export const MARKET_ROUTES: readonly RouteClearance[] = [
  clear("depot door (shop side)", [5.9, 8.7], [-6.0, -4.9]),
  clear("depot door (depot side)", [5.9, 8.7], [-7.5, -6.3]),
  clear("depot side door (fridge side)", [2.3, 3.5], [-9.7, -6.9]),
  clear("depot side door (depot side)", [3.8, 5.0], [-9.6, -7.0]),
  clear("entrance", [5.8, 8.8], [8.2, I]),
  clear("seeker spawn", [MARKET_SEEKER_SPAWN.x - 0.6, MARKET_SEEKER_SPAWN.x + 0.6], [MARKET_SEEKER_SPAWN.z - 0.6, MARKET_SEEKER_SPAWN.z + 0.6]),
  ...MARKET_HIDER_SPAWNS.map((h, k) => clear(`hider spawn ${k + 1}`, [h.x - 0.6, h.x + 0.6], [h.z - 0.6, h.z + 0.6])),
  // In front of both ends of every checkout counter (the lanes' mouths stay open).
  ...CHECKOUTS.map(([x0, x1], k) => clear(`checkout ${k + 1} (north end)`, [x0 - 1.2, x1 + 1.2], [6.0, CHECKOUT_Z[0]])),
  ...CHECKOUTS.map(([x0, x1], k) => clear(`checkout ${k + 1} (south end)`, [x0 - 1.2, x1 + 1.2], [CHECKOUT_Z[1], I])),
  clear("fridge aisle (west end)", [-I, -9.4], [-9.8, -6.0]),
  clear("fridge aisle (east end)", [1.9, 3.5], [-9.8, -7.6]),
];

// ─── The physics map ────────────────────────────────────────────────────────

/** Every static solid of the market except the decoys (no ceiling: nothing reaches it; the camera has its own). */
export const MARKET_COLLIDERS: readonly ArenaCollider[] = [
  box("floor", [-30, 30], [-1, 0], [-30, 30]),
  ...BOUNDARY,
  ...(["north", "west", "east", "front", "depotS", "depotW"] as const).flatMap(marketWallColliders),
  ...MARKET_FIXTURES.map(fixtureCollider),
];

/** The physics map: the structures only (the decoys change every round, like the camp's). */
export const MARKET_MAP: ArenaMap = {
  id: "prophunt",
  name: "Market",
  bounds: { minX: -H, maxX: H, minZ: -H, maxZ: H },
  colliders: MARKET_COLLIDERS,
  spawns: [MARKET_SEEKER_SPAWN, MARKET_HIDER_SPAWNS[0], MARKET_HIDER_SPAWNS[1]],
  spawnYaws: [MARKET_SEEKER_YAW, MARKET_HIDER_YAW, MARKET_HIDER_YAW],
  lethalEdges: [],
  bot: { home: { x: 2.1, z: 5.0 }, wander: { x: 0, z: 0, halfX: 9, halfZ: 9 } },
};

/** The market's `surfaceIn` (the round's decoys in `extra`). */
export function marketSurfaceBelow(x: number, z: number, y = Infinity, extra: readonly ArenaCollider[] = []): number {
  return surfaceIn(MARKET_COLLIDERS, H, x, z, y, extra);
}

/** Zone rectangles (floor plan), checked in this order. */
export const MARKET_ZONES: readonly { readonly id: MarketZoneId; readonly rect: Rect }[] = [
  { id: "depot", rect: { x: [3.5, I], z: [-I, -6.0] } },
  { id: "fridges", rect: { x: [-I, 3.5], z: [-I, -6.0] } },
  { id: "produce", rect: { x: [-I, -3.7], z: [-6.0, 5.6] } },
  { id: "aisles", rect: { x: [-3.7, I], z: [-6.0, 5.6] } },
  { id: "checkout", rect: { x: [-I, 4.0], z: [5.6, I] } },
  { id: "entrance", rect: { x: [4.0, I], z: [5.6, I] } },
];
export function marketZoneAt(x: number, z: number): MarketZoneId {
  for (const { id, rect } of MARKET_ZONES) if (x >= rect.x[0] && x <= rect.x[1] && z >= rect.z[0] && z <= rect.z[1]) return id;
  return x < 0 ? (z < 0 ? "fridges" : "checkout") : z < 0 ? "depot" : "entrance";
}
/** The searchable structures (hider bots like them, the seeker bot checks them first): the depot and the shelf aisles. */
export const MARKET_STRUCTURE_ZONES: readonly ZoneId[] = ["depot", "aisles"];
