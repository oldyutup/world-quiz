import {
  ACCESS_BUILDING,
  CONDENSER,
  CURB_DEPTH,
  CURB_HEIGHT,
  DECK,
  DECK_HEIGHT,
  FACADE_BOTTOM,
  FRONT_GAP_HALF,
  PARAPET_DEPTH,
  PARAPET_HEIGHT,
  ROOF,
  STAIRS,
} from "../../../../shared/party-lab/maps/rooftop";

/**
 * Visual-only layout for the rooftop. Nothing here has a collider; gameplay
 * geometry lives in shared/party-lab/maps/rooftop.ts and is only mirrored here.
 */

/** Bodies sink into the city haze just before the shared elimination height (−5). */
export const HAZE_Y = -4.2;
export const HAZE_COLOR = "#303b44";
export const HAZE_FAR_COLOR = "#6b7a86";
export const FOG = { near: 26, far: 70 } as const;

/** Neighbouring roofs and the skyline. `top` is the roof height of each box. */
export interface BackdropBlock {
  x: readonly [number, number];
  z: readonly [number, number];
  top: number;
  tone: number; // 0 = near/dark brick, 1 = far/pale concrete
}
/** Horizontal clearance every backdrop surface keeps from a lethal edge. */
export const BACKDROP_CLEARANCE = 3;
export const BACKDROP: readonly BackdropBlock[] = [
  // Behind the safe back parapet: can be close, nothing can reach it.
  { x: [-16, -8.2], z: [-20, -9], top: 1.6, tone: 0.3 },
  { x: [-8.2, 1.4], z: [-15, -9.2], top: -0.8, tone: 0.15 },
  { x: [1.4, 7.4], z: [-22, -10.5], top: 2.6, tone: 0.35 },
  { x: [7.4, 16], z: [-18, -9.2], top: 0.4, tone: 0.25 },
  { x: [-34, -16.5], z: [-44, -21], top: 8, tone: 0.8 },
  { x: [-15, 2], z: [-48, -26], top: 10, tone: 0.9 },
  { x: [16.5, 34], z: [-40, -19], top: 6, tone: 0.75 },
  // Beside and in front of the lethal edges: lower buildings sunk below the haze (and below
  // the elimination height), seen faintly through it, so nothing near a drop looks landable.
  { x: [-24, -10], z: [-8, 1.5], top: -6.2, tone: 0.2 },
  { x: [-22, -10.5], z: [2.5, 13], top: -7.6, tone: 0.3 },
  { x: [10, 24], z: [-7.5, 2.4], top: -6, tone: 0.2 },
  { x: [10.5, 22], z: [3.4, 14], top: -7.2, tone: 0.3 },
  { x: [-9.5, -1.2], z: [7.8, 16], top: -6.8, tone: 0.3 },
  { x: [1.6, 10.5], z: [8.2, 17], top: -7.8, tone: 0.35 },
];
/** See-through haze: bodies fade into it before the shared elimination removes them. */
export const HAZE_OPACITY = 0.8;
/** Backdrop window grid: 1 × 1.3 m panes, every 2.4 m across and 3 m down; about 1 in 9 lit. */
export const BACKDROP_WINDOWS = { width: 1, height: 1.3, spacingX: 2.4, spacingY: 3, firstBelowTop: 1.7, litEvery: 9 } as const;
/** Water tank on the low roof behind the back lane; its top stays inside the frame. */
export const WATER_TANK = { x: -0.2, z: -10.4, base: -0.8, legs: 1.5, radius: 1.05, height: 2.1 } as const;

/** Facade windows (dark glass) on the three visible sides, one row above the haze. */
export const WINDOW = { width: 1.1, height: 1.4, centerY: -2.1 } as const;
export const WINDOW_SPOTS: readonly { x: number; z: number; face: "front" | "left" | "right" }[] = [
  ...[-5, -3, -1, 1, 3, 5].map((x) => ({ x, z: ROOF.maxZ, face: "front" as const })),
  ...[-4.8, -2.4, 0, 2.4].flatMap((z) => [
    { x: ROOF.minX, z, face: "left" as const },
    { x: ROOF.maxX, z, face: "right" as const },
  ]),
];

/** Painted hazard bands on open (lethal) edges only: [x0, x1, z0, z1, y]. */
export const STRIPE_WIDTH = 0.2;
export const HAZARD_STRIPES: readonly (readonly [number, number, number, number, number])[] = [
  [ROOF.minX, ROOF.minX + STRIPE_WIDTH, ROOF.minZ + PARAPET_DEPTH, ROOF.maxZ, 0],
  [ROOF.maxX - STRIPE_WIDTH, ROOF.maxX, DECK.z[1], ROOF.maxZ, 0],
  [ROOF.maxX - STRIPE_WIDTH, ROOF.maxX, DECK.z[0], DECK.z[1], DECK_HEIGHT],
  [-FRONT_GAP_HALF, FRONT_GAP_HALF, ROOF.maxZ - STRIPE_WIDTH, ROOF.maxZ, 0],
];

export const DRAINS: readonly { x: number; z: number }[] = [
  { x: -6.2, z: 3.7 },
  { x: 6.2, z: 3.7 },
  { x: -0.8, z: -5.7 },
  { x: 6.3, z: -2.4 },
];
export const HATCH = { x: 0, z: -1.1 } as const;

export {
  ACCESS_BUILDING,
  CONDENSER,
  CURB_DEPTH,
  CURB_HEIGHT,
  DECK,
  DECK_HEIGHT,
  FACADE_BOTTOM,
  FRONT_GAP_HALF,
  PARAPET_DEPTH,
  PARAPET_HEIGHT,
  ROOF,
  STAIRS,
};
