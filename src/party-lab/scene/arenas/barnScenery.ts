import type { BarnWeaponSpotId, BarnTrapId } from "../../../../shared/party-lab/maps/barn";

/**
 * Visual-only barn scenery. Nothing here is physical: gameplay geometry lives in
 * shared/party-lab/maps/barn.ts (the walls there are the cross's outline) and the
 * props come from scripts/build-party-lab-barn-kit.mjs. The shell itself — planked
 * walls, gable roofs, the hub's pyramid roof, timber frame, windows — is generated
 * in buildBarn.ts from these numbers.
 */
export const BARN_KIT_URL = "/party-lab/maps/barn/barn-kit.glb";

export const SKY_COLOR = "#bcd3e3";
export const FOG = { near: 42, far: 110 } as const;

/**
 * Shell heights (the camera blockers follow them). Wings: walls to the eave and a
 * gable roof whose ridge runs along the wing. Hub: taller walls (a clerestory over the
 * wing ridges) under a pyramid roof. The chase camera tops out around 7.3 m (upper
 * floor, looking fully down), under every rafter and tie beam.
 */
export const SHELL = { wingEave: 6.5, wingRidge: 10, hubEave: 11.5, hubPeak: 15.5 } as const;

/** Wood tones (sRGB), cycled per board so large surfaces read as planks without textures. */
export const WOOD = {
  floor: ["#a47b52", "#9a734c", "#ad8459", "#94704b"],
  wall: ["#8c4a33", "#83432e", "#944f36", "#7c3f2b"],
  roof: ["#9a6b45", "#8f633f", "#a3734b"],
  deck: ["#b08658", "#a67d52", "#b98f60"],
  deckUnder: ["#7d5a3b", "#755436"],
  fascia: ["#8a5d3b", "#825637", "#93643f"],
  beam: "#6a452b",
  post: "#634028",
  ramp: ["#a57c50", "#9b744b"],
  rampCleat: "#6f4b30",
  rampSide: "#7c5334",
  stair: ["#a98053", "#9f784e"],
  stairRiser: "#7a5233",
  stall: ["#8f6240", "#86593a", "#976845"],
  /** Straw-coloured edge boards marking the open drop edges on the upper floor. */
  dropEdge: "#e3c46f",
} as const;
export const PLANK = { floor: 0.41, wall: 0.45, roof: 0.5, deck: 0.32, fascia: 0.3, ramp: 0.5, stall: 0.35 } as const;
/** Visual stair steps over the south stairs' wedge (nosings on its slope). */
export const STAIR_STEP = { rise: 0.15, run: 0.3 } as const;

/** Timber frame on the walls: posts (pilasters) spacing, base board, deck-level ledger, top plate. */
export const FRAME = { postEvery: 3.7, post: 0.3, depth: 0.08, base: 0.3, ledger: [2.75, 3.0], plate: 0.3 } as const;
/** Wing rafters: spacing along each wing, collar-tie height and ridge beam (all above the camera). */
export const RAFTERS = { every: 3.2, size: 0.22, collarY: 8.2, ridgeY: 9.7 } as const;

/** Windows: white trim, light panes (emissive), on the inside face of the walls. */
export const WINDOW = { trim: "#dcd6c8", pane: "#cfe3ef", paneGlow: "#9fc4da", frame: 0.12, depth: 0.06 } as const;
export interface WindowSpec {
  /** Wall plane: axis and coordinate, and which way the room lies. */
  readonly axis: "x" | "z";
  readonly at: number;
  readonly inward: 1 | -1;
  /** Centre along the wall, bottom and size. */
  readonly c: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
const side = (axis: "x" | "z", at: number, inward: 1 | -1, cs: readonly number[], y = 3.8, w = 1.3, h = 1.8): WindowSpec[] =>
  cs.map((c) => ({ axis, at, inward, c, y, w, h }));
export const WINDOWS: readonly WindowSpec[] = [
  // Wing side walls, above the upper floor's level.
  ...side("x", -4.5, 1, [-9.5, -13.5]),
  ...side("x", 4.5, -1, [-9.5, -13.5]),
  ...side("x", -4.5, 1, [9.8, 14.4]),
  ...side("x", 4.5, -1, [14.4]),
  ...side("z", -4.5, 1, [-9.8, -14.2, 10.6, 14.6]),
  ...side("z", 4.5, -1, [-9.8, -14.2, 10.6, 14.6]),
  // Gable windows high on the four end walls.
  { axis: "z", at: -17.5, inward: 1, c: 0, y: 7.2, w: 1.6, h: 1.6 },
  { axis: "z", at: 17.5, inward: -1, c: 0, y: 5.4, w: 1.6, h: 1.6 },
  { axis: "x", at: 17.5, inward: -1, c: 0, y: 7.2, w: 1.6, h: 1.6 },
  { axis: "x", at: -17.5, inward: 1, c: 0, y: 7.2, w: 1.6, h: 1.6 },
  // Hub clerestory: tall windows high on the eight shoulders.
  ...([-1, 1] as const).flatMap((s) => [
    ...side("z", -6.5, 1, [s * 5.5], 7.4, 1.1, 2.4),
    ...side("z", 6.5, -1, [s * 5.5], 7.4, 1.1, 2.4),
    ...side("x", -6.5, 1, [s * 5.5], 7.4, 1.1, 2.4),
    ...side("x", 6.5, -1, [s * 5.5], 7.4, 1.1, 2.4),
  ]),
];

/**
 * Big Barn's sliding doors (kit node BarnDoors, 7.95 × 2.92 × 0.29 m) on the south end wall,
 * flattened to 0.1 m so they barely stand proud of the wall collider.
 */
export const DOORS = { z: 17.5, width: 7.95, height: 2.92, depth: 0.29, flatten: 0.35 } as const;

/** Which model sits on each weapon spot when no combat view drives them (scene tests, previews). */
export const WEAPON_PREVIEW: Readonly<Record<BarnWeaponSpotId, "Shotgun" | "Smg">> = {
  W1: "Shotgun",
  W2: "Smg",
  W3: "Shotgun",
  W4: "Smg",
  W5: "Shotgun",
  W6: "Smg",
  W7: "Shotgun",
};
export const PICKUP = { palletScale: 0.6, weaponScale: 8 / 7, hover: 0.42, spin: 0.9 } as const;
export const TRAP_YAW: Readonly<Record<BarnTrapId, number>> = { T1: 0.35, T2: -0.6 };

/** Decoration kept off walkable space: only on top of full cover. */
export const SACKS = { cover: "W1", scale: 0.75, yaw: 0.3 } as const;
export const SHEAVES = [
  { cover: "S2", dx: -0.3, dz: -0.2, yaw: 0.4 },
  { cover: "N1", dx: 0.4, dz: 0, yaw: 1.9 },
  { cover: "E3", dx: -0.5, dz: 0.1, yaw: -0.8 },
] as const;
