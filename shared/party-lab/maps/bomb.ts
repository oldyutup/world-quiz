import type { ArenaMap, BoxCollider, ColliderRole, RampCollider, Vec2, Vec3 } from "./types.js";

/**
 * "Oyun Parkı" — Bomba Sende's compact walled rooftop playground (local and online).
 * A 20 × 20 m floor (x, z −10…10, floor y 0) inside a 3.2 m perimeter (1 m brick parapet
 * with a glass guard to the top), so nobody falls: the mode is a chase, not a fall game.
 * The layout is symmetric under a half turn about the middle (x, z → −x, −z), so every
 * spawn and route has a twin.
 *
 * Heights come from the measured ragdoll (bomb.test.ts keeps them checked):
 * - a walker steps onto anything ≤ 0.65 m;
 * - a running jump gets onto a ledge up to ~1.2 m (a wide take-off window up to 1.1 m) and
 *   over a wall up to ~0.9 m from almost any distance; a 1.5 m gap at 1 m height is easy;
 * - nothing ≥ 1.5 m above the surface in front of it is ever crossed (Rooftop's audit), so
 *   pocket walls are 2.0 m and the perimeter is ≥ 2.0 m above every standable surface.
 *
 * Features (the half-turn twin in brackets):
 * - Open plaza in the middle (≈ 12 × 10 m).
 * - NW [SE] pocket: a 2.0 m L-wall, the hiding corner; two 2 m exits along the walls.
 * - NE [SW] corner: low AC units [crates], 1.1 m — no hiding, a juke corner you can hop.
 * - N [S] catwalk: a 1.0 m deck along the wall with a ramp at its west [east] end; its
 *   open inner side can be jumped onto anywhere and dropped from anywhere.
 * - Jump shortcut ×2: from each catwalk's far end a 1.5 m gap to a 2.5 m long AC unit
 *   [crate] top against the wall (a walking jump lands on it, a sprinting one about at its
 *   far end), and down into that corner — or back up the same way.
 * - E [W] hop wall: 0.9 m, 6 m long; walk round either end or hop straight over.
 */
export const BOMB_ARENA = {
  /** Floor half-size (m): x and z −10…10. */
  half: 10,
  wall: { height: 3.2, thickness: 0.5, brick: 1.0 },
  /** The building's roof ledge outside the perimeter (visual room for scenery). */
  ledge: 2.0,
  /** Physics slab depth under the floor (the facade down to the haze). */
  slabBottom: -4.6,
} as const;

const H = BOMB_ARENA.half;
export const POCKET_WALL_HEIGHT = 2.0;
export const LOW_COVER_HEIGHT = 1.1;
export const DECK_HEIGHT = 1.0;
export const HOP_WALL_HEIGHT = 0.9;

type Span = readonly [number, number];
export interface Block {
  readonly x: Span;
  readonly z: Span;
  readonly height: number;
}
/** The half-turn twin of a block (x, z → −x, −z). */
const twin = (b: Block): Block => ({ x: [-b.x[1], -b.x[0]], z: [-b.z[1], -b.z[0]], height: b.height });

/** NW L-wall: leg along x (its west end leaves a 2 m exit), leg along z (2 m exit to the north). */
export const L_WALL_NW: readonly Block[] = [
  { x: [-8.0, -5.2], z: [-5.6, -5.2], height: POCKET_WALL_HEIGHT },
  { x: [-5.6, -5.2], z: [-8.0, -5.6], height: POCKET_WALL_HEIGHT },
];
export const L_WALL_SE: readonly Block[] = L_WALL_NW.map(twin);
/** NE: the long AC unit facing the plaza, and the one against the north wall (the jump shortcut's landing). */
export const AC_UNITS: readonly Block[] = [
  { x: [5.4, 7.8], z: [-6.0, -5.0], height: LOW_COVER_HEIGHT },
  { x: [5.1, 7.6], z: [-H, -8.6], height: LOW_COVER_HEIGHT },
];
/** SW: the AC units' twins, as crates. */
export const CRATE_BLOCKS: readonly Block[] = AC_UNITS.map(twin);
/** Catwalk decks (N, S). */
export const CATWALKS: readonly Block[] = [
  { x: [-3.0, 3.6], z: [-H, -8.2], height: DECK_HEIGHT },
  twin({ x: [-3.0, 3.6], z: [-H, -8.2], height: DECK_HEIGHT }),
];
/** Catwalk ramps (N rises toward +x onto its deck, S toward −x). 1 m over 2.2 m (24°). */
export const RAMPS: readonly (Block & { rises: RampCollider["rises"] })[] = [
  { x: [-5.2, -3.0], z: [-H, -8.2], height: DECK_HEIGHT, rises: "+x" },
  { x: [3.0, 5.2], z: [8.2, H], height: DECK_HEIGHT, rises: "-x" },
];
/** Hop walls (E, W). */
export const HOP_WALLS: readonly Block[] = [
  { x: [6.0, 6.4], z: [-3.0, 3.0], height: HOP_WALL_HEIGHT },
  twin({ x: [6.0, 6.4], z: [-3.0, 3.0], height: HOP_WALL_HEIGHT }),
];
/**
 * The two jump shortcuts: take off from the catwalk's end (`from`, on the deck), land on
 * the corner block (`to`), 1.5 m across. Presentation marks them; bots read them.
 */
export const JUMP_SHORTCUTS: readonly { readonly from: Vec2; readonly to: Vec2; readonly gap: number }[] = [
  { from: { x: 3.1, z: -9.2 }, to: { x: 6.2, z: -9.3 }, gap: AC_UNITS[1].x[0] - CATWALKS[0].x[1] },
  { from: { x: -3.1, z: 9.2 }, to: { x: -6.2, z: 9.3 }, gap: CATWALKS[1].x[0] - CRATE_BLOCKS[1].x[1] },
];

function box(role: ColliderRole, [x0, x1]: Span, [y0, y1]: Span, [z0, z1]: Span): BoxCollider {
  return {
    role,
    shape: "box",
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    half: { x: (x1 - x0) / 2, y: (y1 - y0) / 2, z: (z1 - z0) / 2 },
  };
}
const block = (role: ColliderRole, b: Block) => box(role, b.x, [0, b.height], b.z);
function ramp(r: (typeof RAMPS)[number]): RampCollider {
  return {
    role: "stairs",
    shape: "ramp",
    rises: r.rises,
    center: { x: (r.x[0] + r.x[1]) / 2, y: r.height / 2, z: (r.z[0] + r.z[1]) / 2 },
    half: { x: (r.x[1] - r.x[0]) / 2, y: r.height / 2, z: (r.z[1] - r.z[0]) / 2 },
  };
}

const W = BOMB_ARENA.wall,
  OUT = H + W.thickness,
  EDGE = OUT + BOMB_ARENA.ledge;
/** The four perimeter walls (brick + glass guard: one solid collider each). */
export const PERIMETER: readonly Block[] = [
  { x: [-OUT, OUT], z: [-OUT, -H], height: W.height },
  { x: [-OUT, OUT], z: [H, OUT], height: W.height },
  { x: [-OUT, -H], z: [-H, H], height: W.height },
  { x: [H, OUT], z: [-H, H], height: W.height },
];

/** Spawns: three players on a 5 m circle round the middle (120° apart), two on opposite sides. */
export const BOMB_SPAWNS: Readonly<Record<2 | 3, readonly Vec3[]>> = {
  3: [
    { x: 0, y: 0.9, z: -5 },
    { x: -4.33, y: 0.9, z: 2.5 },
    { x: 4.33, y: 0.9, z: 2.5 },
  ],
  2: [
    { x: -3.5, y: 0.9, z: 3 },
    { x: 3.5, y: 0.9, z: -3 },
  ],
};
/** Pelvis spawn of `slot` in a match of `players`. */
export const bombSpawn = (players: 2 | 3, slot: number): Vec3 => BOMB_SPAWNS[players][slot];

/**
 * The three slow traps (simulation/bomb/traps.ts), flat on the floor: a loose triangle on
 * the plaza's painted ring (≈ 2.85 m from the middle), each in a gap between the spawns
 * (≥ 2.9 m from every spawn), with ≥ 4 m of floor between any two, so the middle stays a
 * crossroads. Clear of the pocket exits, ramps, catwalk landings, hop-wall landings and the
 * jump shortcuts (bomb.test.ts checks all of it). The one thing in the playground without a
 * half-turn twin: three can't pair up.
 */
export const BOMB_TRAPS: readonly Vec3[] = [
  { x: -0.25, y: 0, z: 2.85 },
  { x: -2.45, y: 0, z: -1.45 },
  { x: 2.85, y: 0, z: -0.15 },
];

/**
 * The physics map. Every collider is static; `spawns` are the three-player ones (a
 * two-player match moves its slots, BombTagGame). Nothing is lethal: the perimeter stands
 * ≥ 2 m above every standable surface, so the shared fall line (−5 m) is unreachable.
 */
export const BOMB_MAP: ArenaMap = {
  id: "bomb",
  name: "Oyun Parkı",
  bounds: { minX: -H, maxX: H, minZ: -H, maxZ: H },
  colliders: [
    box("floor", [-EDGE, EDGE], [BOMB_ARENA.slabBottom, 0], [-EDGE, EDGE]),
    ...PERIMETER.map((b) => block("parapet", b)),
    ...[...L_WALL_NW, ...L_WALL_SE].map((b) => block("wall", b)),
    ...AC_UNITS.map((b) => block("condenser", b)),
    ...CRATE_BLOCKS.map((b) => block("crate", b)),
    ...CATWALKS.map((b) => block("deck", b)),
    ...RAMPS.map(ramp),
    ...HOP_WALLS.map((b) => block("hop", b)),
  ],
  spawns: [BOMB_SPAWNS[3][0], BOMB_SPAWNS[3][1], BOMB_SPAWNS[3][2]],
  lethalEdges: [],
  bot: { home: { x: 0, z: 0 }, wander: { x: 0, z: 0, halfX: 5, halfZ: 4 } },
};

/**
 * Height of the highest walkable top at floor point (x, z) that is not above `y` (+ a
 * step's margin): the floor, a block's top or a ramp's slope; −Infinity outside the
 * floor. For cameras and bots; physics uses the colliders.
 */
export function surfaceBelow(x: number, z: number, y = Infinity): number {
  if (Math.abs(x) > H || Math.abs(z) > H) return -Infinity;
  let best = 0;
  const limit = y + 0.3;
  for (const c of BOMB_MAP.colliders) {
    if (c.shape === "cylinder" || c.role === "floor") continue;
    const { center: m, half: h } = c;
    if (Math.abs(x - m.x) > h.x || Math.abs(z - m.z) > h.z) continue;
    let top = m.y + h.y;
    if (c.shape === "ramp") {
      const axis = c.rises[1] === "x" ? x - m.x : z - m.z,
        sign = c.rises[0] === "+" ? 1 : -1,
        half = c.rises[1] === "x" ? h.x : h.z;
      top = m.y - h.y + (2 * h.y * (sign * axis + half)) / (2 * half);
    }
    if (top <= limit && top > best) best = top;
  }
  return best;
}
