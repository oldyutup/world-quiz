import { MARKET, MARKET_COLLIDERS, MARKET_ROUTES, marketZoneAt } from "./market.js";
import { MARKET_FAMILY_IDS } from "./propHuntProps.js";
import { MARKET_SCENE_SET } from "./marketScenes.js";
import { createPropDealer, type LayoutTuning } from "./propDealer.js";

/**
 * Market's per-round prop layouts (the generic dealer, propDealer.ts, bound to the shop): every
 * one of its twelve families in play every round with at least three decoys (a disguise is
 * never one of a kind), about half of the ordinary props changing from one round to the next.
 */
export const MARKET_LAYOUT_TUNING = {
  count: [58, 70] as const,
  /** All twelve families, every round. */
  active: [12, 12] as const,
  maxRest: 0,
  minPerFamily: 3,
  maxPerFamily: { cart: 10, parcel: 8, default: 7 } as const,
  change: [0.45, 0.55] as const,
  changeLimits: [0.4, 0.6] as const,
  attempts: 48,
} as const satisfies LayoutTuning;

export const MARKET_DEALER = createPropDealer({
  name: "Market",
  half: MARKET.half,
  structure: MARKET_COLLIDERS,
  routes: MARKET_ROUTES,
  zoneAt: marketZoneAt,
  scenes: MARKET_SCENE_SET,
  families: MARKET_FAMILY_IDS,
  core: MARKET_FAMILY_IDS,
  /** The cart corral and the till queues are rows on purpose: never cut short by the cart cap. */
  setPieces: new Set(["entrance.corral"]),
  tuning: MARKET_LAYOUT_TUNING,
});
