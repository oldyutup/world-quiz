/** Saklambaç's maps and their zone names (pure types, shared by both maps' data and the generic code). */
export type PropMapId = "camp" | "market";
/** Orman Kampı's zones (maps/propHunt.ts). */
export type CampZoneId = "lodge" | "loft" | "porch" | "leanTo" | "shed" | "yard" | "plaza" | "camp" | "pavilion" | "border";
/** Market's zones (maps/market.ts). */
export type MarketZoneId = "entrance" | "checkout" | "aisles" | "produce" | "fridges" | "depot";
export type ZoneId = CampZoneId | MarketZoneId;
export const isPropMapId = (value: unknown): value is PropMapId => value === "camp" || value === "market";

/** The lobby's map choice: one map, or a fresh coin toss for every round. */
export type PropMapChoice = PropMapId | "random";
export const PROP_MAP_CHOICES: readonly PropMapChoice[] = ["camp", "market", "random"];
export const isPropMapChoice = (value: unknown): value is PropMapChoice => value === "random" || isPropMapId(value);
export const PROP_MAP_CHOICE_LABEL: Readonly<Record<PropMapChoice, string>> = { camp: "Orman Kampı", market: "Market", random: "Rastgele" };
