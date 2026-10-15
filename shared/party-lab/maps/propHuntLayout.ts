import { CAMP, REFERENCE_DECOYS, ROUTE_CLEARANCES, STRUCTURE_COLLIDERS, zoneAt } from "./propHunt.js";
import { CAMP_FAMILY_IDS, type PropFamilyId } from "./propHuntProps.js";
import { CAMP_SCENES } from "./propHuntScenes.js";
import { createPropDealer, type LayoutTuning } from "./propDealer.js";

export { CRACK, WALKWAY, mixSeed, placeIn, roundSeed, slotTurns, type PropLayout, type Pose } from "./propDealer.js";

/**
 * Orman Kampı's per-round prop layouts (the generic dealer, propDealer.ts, bound to the camp):
 * 60–68 decoys a round, 15–18 of the 20 families in play (each at least twice), about half of
 * the ordinary props changing from one round to the next. Tests (prophuntLayout.test.ts) pin
 * all of it over hundreds of layouts, navigation included.
 */

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
} as const satisfies LayoutTuning;

export const CAMP_DEALER = createPropDealer({
  name: "Orman Kampı",
  half: CAMP.half,
  structure: STRUCTURE_COLLIDERS,
  routes: ROUTE_CLEARANCES,
  zoneAt,
  scenes: CAMP_SCENES,
  families: CAMP_FAMILY_IDS,
  core: CORE_FAMILIES,
  /** Scenes whose same-kind group is the point (the dining table's chairs, the fire's seats): never trimmed by a family's cap. */
  setPieces: new Set(["lodge.dining", "plaza.fire"]),
  tuning: LAYOUT_TUNING,
});
export const { familyCap, staticRefusal, slotPoses, conflict, layoutOf, layoutProblem, generatePropLayout, layoutChange, roundLayout } = CAMP_DEALER;

/** The hand-placed V1 decoys as a fixed layout (tests that need known spots). */
export const REFERENCE_LAYOUT = layoutOf(REFERENCE_DECOYS, null);
