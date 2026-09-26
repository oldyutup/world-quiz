/**
 * Saklambaç's prop catalogue (pure data, shared by the simulation, the local arena, the
 * kit builder's checks and the tests).
 *
 * A **family** is a transformable prop: the map scatters decoys of it, and a hider standing
 * next to one can take its shape. One `shape` serves three jobs, so they can never disagree:
 * the decoy's static collider, the disguised hider's collider (what bodies bump into and the
 * character controller moves), and the seeker's hitbox. The kit builder scales each family's
 * model to exactly this size (bottom-centre pivot), so the drawn prop covers its shape.
 *
 * Sizes are the Party Lab character's scale (1.92 m tall, 1.16 m wide with arms): the Ultimate
 * House Interior furniture at 1.25× real size, the Survival and Nature props fitted one by one.
 * Nothing tiny is a family (every one is ≥ 0.55 m across in two dimensions): the seeker has 12
 * shots, and a hider must be a fair target.
 *
 * Box shapes are axis-aligned for decoys (quarter turns only: `ArenaCollider` boxes do not
 * rotate); a disguised hider's box turns freely with the body.
 */
export type PropFamilyId =
  | "crate"
  | "log"
  | "stump"
  | "backpack"
  | "propane"
  | "wheelieBin"
  | "metalCan"
  | "chair"
  | "nightstand"
  | "dresser"
  | "armchair"
  | "sideTable"
  | "pottedPlant"
  | "flowerBush"
  | "bush"
  | "boulder"
  | "boulderB"
  | "sapling"
  | "barrel"
  | "sacks";

/** Full sizes in metres, before any turn: x across, y up, z deep (the model's forward is +z). */
export type PropShape =
  | { readonly kind: "box"; readonly x: number; readonly y: number; readonly z: number }
  | { readonly kind: "cylinder"; readonly radius: number; readonly height: number };

export interface PropFamily {
  readonly id: PropFamilyId;
  /** Turkish display name (HUD: "Kılık: Sandık"). */
  readonly name: string;
  /** The kit node drawn for it (public/party-lab/maps/prop-hunt/prop-hunt-kit.glb). */
  readonly node: string;
  readonly shape: PropShape;
  /** Size class: S ≤ 0.85 m, M ≤ 1.2 m, L above (largest dimension). */
  readonly tier: "S" | "M" | "L";
}

const box = (x: number, y: number, z: number): PropShape => ({ kind: "box", x, y, z });
const cylinder = (radius: number, height: number): PropShape => ({ kind: "cylinder", radius, height });

export const PROP_FAMILIES: Readonly<Record<PropFamilyId, PropFamily>> = {
  crate: { id: "crate", name: "Sandık", node: "Crate", shape: box(0.92, 0.92, 0.92), tier: "M" },
  log: { id: "log", name: "Kütük", node: "Log", shape: box(1.5, 0.46, 0.46), tier: "L" },
  stump: { id: "stump", name: "Ağaç kütüğü", node: "Stump", shape: cylinder(0.36, 0.66), tier: "S" },
  backpack: { id: "backpack", name: "Sırt çantası", node: "Backpack", shape: box(0.86, 0.8, 0.46), tier: "S" },
  propane: { id: "propane", name: "Gaz tüpü", node: "Propane", shape: cylinder(0.32, 0.86), tier: "S" },
  wheelieBin: { id: "wheelieBin", name: "Çöp konteyneri", node: "WheelieBin", shape: box(0.62, 1.1, 0.8), tier: "M" },
  metalCan: { id: "metalCan", name: "Çöp kovası", node: "MetalCan", shape: cylinder(0.38, 1.15), tier: "M" },
  chair: { id: "chair", name: "Sandalye", node: "Chair", shape: box(0.5, 1.1, 0.54), tier: "M" },
  nightstand: { id: "nightstand", name: "Komodin", node: "Nightstand", shape: box(0.62, 0.62, 0.62), tier: "S" },
  dresser: { id: "dresser", name: "Şifonyer", node: "Dresser", shape: box(1.75, 0.84, 0.72), tier: "L" },
  armchair: { id: "armchair", name: "Koltuk", node: "Armchair", shape: box(1.32, 0.8, 1.25), tier: "L" },
  sideTable: { id: "sideTable", name: "Yuvarlak sehpa", node: "SideTable", shape: cylinder(0.6, 0.72), tier: "L" },
  pottedPlant: { id: "pottedPlant", name: "Saksı", node: "PottedPlant", shape: cylinder(0.4, 0.78), tier: "S" },
  flowerBush: { id: "flowerBush", name: "Çiçekli çalı", node: "FlowerBush", shape: cylinder(0.64, 1.1), tier: "L" },
  bush: { id: "bush", name: "Çalı", node: "Bush", shape: cylinder(0.64, 1.1), tier: "L" },
  boulder: { id: "boulder", name: "Kaya", node: "Boulder", shape: box(1.28, 0.8, 1.04), tier: "L" },
  boulderB: { id: "boulderB", name: "Yosunlu kaya", node: "BoulderB", shape: box(1.2, 0.9, 1.2), tier: "L" },
  sapling: { id: "sapling", name: "Çam fidanı", node: "Sapling", shape: cylinder(0.5, 1.9), tier: "L" },
  barrel: { id: "barrel", name: "Fıçı", node: "Barrel", shape: cylinder(0.39, 1.0), tier: "M" },
  sacks: { id: "sacks", name: "Çuvallar", node: "Sacks", shape: box(1.3, 0.56, 1.15), tier: "L" },
};
export const PROP_FAMILY_IDS = Object.keys(PROP_FAMILIES) as PropFamilyId[];
export const isPropFamilyId = (value: unknown): value is PropFamilyId => typeof value === "string" && Object.prototype.hasOwnProperty.call(PROP_FAMILIES, value);

/** Largest dimension of a shape (m). */
export function shapeSpan(shape: PropShape) {
  return shape.kind === "box" ? Math.max(shape.x, shape.y, shape.z) : Math.max(2 * shape.radius, shape.height);
}
/** Footprint half-extents for a quarter-turned shape (world x, z). */
export function footprintHalf(shape: PropShape, turns: number): { x: number; z: number } {
  if (shape.kind === "cylinder") return { x: shape.radius, z: shape.radius };
  return turns % 2 === 0 ? { x: shape.x / 2, z: shape.z / 2 } : { x: shape.z / 2, z: shape.x / 2 };
}
export const shapeHeight = (shape: PropShape) => (shape.kind === "box" ? shape.y : shape.height);

/**
 * Things in the camp that are never transformable. `collider` null: decoration the body
 * passes through (thin lamps, rugs, torches, leaning tools, ground cover) — thin posts are
 * ragdoll traps (the Barn's audit), so nothing slimmer than 0.6 m stands solid in a walkway.
 */
export type SceneryKind =
  | "fireplace"
  | "couch"
  | "diningTable"
  | "bunkBed"
  | "bookshelf"
  | "toolShelf"
  | "kitchenSink"
  | "kitchenDrawers"
  | "kitchenOven"
  | "fridge"
  | "floorLamp"
  | "hangingLamp"
  | "rug"
  | "rugRound"
  | "bench"
  | "wagon"
  | "campfire"
  | "torch"
  | "axe"
  | "shovel"
  | "rockLarge"
  | "fern"
  | "agave"
  | "flowers"
  | "grass";

export interface SceneryItem {
  /** Kit node drawn (null: generated in code, e.g. the picnic tables). */
  readonly node: string;
  /** Solid footprint and height (m, before turns); null: no collider. */
  readonly collider: { readonly x: number; readonly y: number; readonly z: number } | null;
}
export const SCENERY: Readonly<Record<SceneryKind, SceneryItem>> = {
  fireplace: { node: "Fireplace", collider: { x: 2.03, y: 1.6, z: 0.72 } },
  couch: { node: "Couch", collider: { x: 2.82, y: 1.22, z: 1.25 } },
  diningTable: { node: "DiningTable", collider: { x: 2.32, y: 0.7, z: 1.21 } },
  bunkBed: { node: "BunkBed", collider: { x: 1.36, y: 1.89, z: 2.5 } },
  bookshelf: { node: "Bookshelf", collider: { x: 1.45, y: 2.78, z: 0.48 } },
  toolShelf: { node: "ToolShelf", collider: { x: 2.11, y: 2.77, z: 0.47 } },
  kitchenSink: { node: "KitchenSink", collider: { x: 0.63, y: 1.01, z: 0.7 } },
  kitchenDrawers: { node: "KitchenDrawers", collider: { x: 0.63, y: 1.01, z: 0.7 } },
  kitchenOven: { node: "KitchenOven", collider: { x: 0.63, y: 1.01, z: 0.7 } },
  fridge: { node: "Fridge", collider: { x: 0.81, y: 2.07, z: 0.81 } },
  floorLamp: { node: "FloorLamp", collider: null },
  hangingLamp: { node: "HangingLamp", collider: null },
  rug: { node: "Rug", collider: null },
  rugRound: { node: "RugRound", collider: null },
  bench: { node: "Bench", collider: { x: 1.6, y: 0.5, z: 0.5 } },
  wagon: { node: "Wagon", collider: { x: 1.9, y: 1.15, z: 3.2 } },
  campfire: { node: "Campfire", collider: null },
  torch: { node: "Torch", collider: null },
  axe: { node: "Axe", collider: null },
  shovel: { node: "Shovel", collider: null },
  rockLarge: { node: "RockLarge", collider: { x: 2.2, y: 1.4, z: 2.0 } },
  fern: { node: "Fern", collider: null },
  agave: { node: "Agave", collider: null },
  flowers: { node: "Flowers", collider: null },
  grass: { node: "Grass", collider: null },
};
