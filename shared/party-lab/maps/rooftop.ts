import type { ArenaMap, BoxCollider, ColliderRole } from "./types.js";

/**
 * "Çatı" — a 14 × 11 m city rooftop (see the Phase 1 audit). Heights are chosen
 * from measured ragdoll limits: a walker climbs anything ≤ 0.65 m, shoves and
 * carry-drops cross edges < 0.6 m, and jump-spamming into a wall gets the pelvis
 * onto its top (the stand-up support then lifts the player over) unless the wall
 * rises ≥ 1.5 m above the surface in front of it: 1.2 m walls were crossed in
 * 19/30 angled attempts, 1.5–1.8 m in 0/30 (rooftop.test.ts keeps this checked).
 *
 * Edge language:
 * - open (left, right, centre-front, raised deck's right side): lethal;
 * - 0.3 m curb (front flanks): stops punch knockback, still lethal to shoves/carries;
 * - 1.6 m brick wall (back; 1.6 m above the deck behind it): safe, jumps included.
 */
export const ROOF = { minX: -7, maxX: 7, minZ: -6.5, maxZ: 4.5 } as const;
export const PARAPET_HEIGHT = 1.6;
export const PARAPET_DEPTH = 0.4;
export const DECK_HEIGHT = 1.0;
export const CURB_HEIGHT = 0.3;
export const CURB_DEPTH = 0.3;
/** Open centre-front gap between the two curbs. */
export const FRONT_GAP_HALF = 2;
/** Physics slab depth: the visible building wall down to the haze, never a ledge. */
export const FACADE_BOTTOM = -4.6;

const parapetInner = ROOF.minZ + PARAPET_DEPTH;

function box(
  role: ColliderRole,
  [x0, x1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  [z0, z1]: readonly [number, number]
): BoxCollider {
  return {
    role,
    shape: "box",
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    half: { x: (x1 - x0) / 2, y: (y1 - y0) / 2, z: (z1 - z0) / 2 },
  };
}

/** Access building (door faces the camera), flush against the back parapet. */
export const ACCESS_BUILDING = { x: [-5.5, -1.5], z: [parapetInner, -3.9], height: 3.1 } as const;
/** Raised deck, right/back; its right side is the building's open edge. */
export const DECK = { x: [3.5, ROOF.maxX], z: [parapetInner, -3.1] } as const;
/** Stairs rise toward +X onto the deck. */
export const STAIRS = { x: [1.5, DECK.x[0]], z: [parapetInner, -4.1] } as const;
/** Prop_ACUnit × 2: 1.78 × 1.2 × 0.7 m, fan facing the camera. */
export const CONDENSER = { x: 4.6, z: -1.2, halfX: 0.89, halfZ: 0.35, height: 1.2 } as const;

export const ROOFTOP_MAP: ArenaMap = {
  id: "rooftop",
  name: "Çatı",
  bounds: ROOF,
  colliders: [
    box("floor", [ROOF.minX, ROOF.maxX], [FACADE_BOTTOM, 0], [ROOF.minZ, ROOF.maxZ]),
    box("parapet", [ROOF.minX, ROOF.maxX], [0, PARAPET_HEIGHT], [ROOF.minZ, parapetInner]),
    // Behind the stairs and deck the wall continues to a full parapet height above the
    // deck top; otherwise players on the upper steps/deck could jump onto it.
    box("parapet", [STAIRS.x[0], ROOF.maxX], [PARAPET_HEIGHT, DECK_HEIGHT + PARAPET_HEIGHT], [ROOF.minZ, parapetInner]),
    box("building", ACCESS_BUILDING.x, [0, ACCESS_BUILDING.height], ACCESS_BUILDING.z),
    box("deck", DECK.x, [0, DECK_HEIGHT], DECK.z),
    {
      role: "stairs",
      shape: "ramp",
      rises: "+x",
      center: { x: (STAIRS.x[0] + STAIRS.x[1]) / 2, y: DECK_HEIGHT / 2, z: (STAIRS.z[0] + STAIRS.z[1]) / 2 },
      half: { x: (STAIRS.x[1] - STAIRS.x[0]) / 2, y: DECK_HEIGHT / 2, z: (STAIRS.z[1] - STAIRS.z[0]) / 2 },
    },
    ...[-1, 1].map((side) =>
      box(
        "condenser",
        [side * CONDENSER.x - CONDENSER.halfX, side * CONDENSER.x + CONDENSER.halfX],
        [0, CONDENSER.height],
        [CONDENSER.z - CONDENSER.halfZ, CONDENSER.z + CONDENSER.halfZ]
      )
    ),
    box("curb", [ROOF.minX, -FRONT_GAP_HALF], [0, CURB_HEIGHT], [ROOF.maxZ - CURB_DEPTH, ROOF.maxZ]),
    box("curb", [FRONT_GAP_HALF, ROOF.maxX], [0, CURB_HEIGHT], [ROOF.maxZ - CURB_DEPTH, ROOF.maxZ]),
  ],
  // Equilateral (5.2 m sides); slots 0/1 mirror each other, slot 2 is on the axis.
  spawns: [
    { x: -2.6, y: 1.6, z: 1.3 },
    { x: 2.6, y: 1.6, z: 1.3 },
    { x: 0, y: 1.6, z: -3.2 },
  ],
  lethalEdges: [
    { from: { x: ROOF.minX, z: parapetInner }, to: { x: ROOF.minX, z: ROOF.maxZ }, outward: { x: -1, z: 0 } },
    { from: { x: ROOF.maxX, z: parapetInner }, to: { x: ROOF.maxX, z: ROOF.maxZ }, outward: { x: 1, z: 0 } },
    { from: { x: ROOF.minX, z: ROOF.maxZ }, to: { x: ROOF.maxX, z: ROOF.maxZ }, outward: { x: 0, z: 1 } },
  ],
  bot: { home: { x: 0, z: -0.4 }, wander: { x: 0, z: -0.4, halfX: 2, halfZ: 1.5 } },
};
