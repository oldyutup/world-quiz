import type { ArenaCollider, ArenaMap, Vec3 } from "./types.js";
import { CAMP, HIDER_SPAWNS, HIDER_YAW, PROP_HUNT_MAP, SEEKER_SPAWN, SEEKER_YAW, STRUCTURE_ZONES, surfaceBelow, zoneAt } from "./propHunt.js";
import { MARKET, MARKET_HIDER_SPAWNS, MARKET_HIDER_YAW, MARKET_MAP, MARKET_SEEKER_SPAWN, MARKET_SEEKER_YAW, MARKET_STRUCTURE_ZONES, marketSurfaceBelow, marketZoneAt } from "./market.js";
import { CAMP_DEALER } from "./propHuntLayout.js";
import { MARKET_DEALER } from "./marketLayout.js";
import type { PropDealer } from "./propDealer.js";
import type { PropMapChoice, PropMapId, ZoneId } from "./propTypes.js";

export { isPropMapChoice, isPropMapId, PROP_MAP_CHOICE_LABEL, PROP_MAP_CHOICES, type PropMapChoice, type PropMapId } from "./propTypes.js";

/**
 * Saklambaç's maps: Orman Kampı (maps/propHunt.ts) and Market (maps/market.ts). The rules are
 * the same on both; a map is its architecture, spawns, scene recipes (its dealer) and families.
 */
export interface PropMap {
  readonly id: PropMapId;
  /** Turkish display name (lobby, Esc menu, HUD). */
  readonly name: string;
  /** The physics map: the static solids (the round's decoys are added per round). */
  readonly arena: ArenaMap;
  /** Play area half-size (x, z within ±half). */
  readonly half: number;
  readonly seekerSpawn: Vec3;
  readonly hiderSpawns: readonly Vec3[];
  readonly seekerYaw: number;
  readonly hiderYaw: number;
  readonly dealer: PropDealer;
  /** Zones under a roof or behind walls: hider bots like them, the seeker bot checks them first. */
  readonly structureZones: readonly ZoneId[];
  /** Highest standable top at (x, z) not above `y` (+ a step), the round's decoys in `extra`. */
  surfaceBelow(x: number, z: number, y?: number, extra?: readonly ArenaCollider[]): number;
  zoneAt(x: number, z: number, y?: number): ZoneId;
}

export const PROP_MAPS: Readonly<Record<PropMapId, PropMap>> = {
  camp: {
    id: "camp",
    name: "Orman Kampı",
    arena: PROP_HUNT_MAP,
    half: CAMP.half,
    seekerSpawn: SEEKER_SPAWN,
    hiderSpawns: HIDER_SPAWNS,
    seekerYaw: SEEKER_YAW,
    hiderYaw: HIDER_YAW,
    dealer: CAMP_DEALER,
    structureZones: STRUCTURE_ZONES,
    surfaceBelow,
    zoneAt,
  },
  market: {
    id: "market",
    name: "Market",
    arena: MARKET_MAP,
    half: MARKET.half,
    seekerSpawn: MARKET_SEEKER_SPAWN,
    hiderSpawns: MARKET_HIDER_SPAWNS,
    seekerYaw: MARKET_SEEKER_YAW,
    hiderYaw: MARKET_HIDER_YAW,
    dealer: MARKET_DEALER,
    structureZones: MARKET_STRUCTURE_ZONES,
    surfaceBelow: marketSurfaceBelow,
    zoneAt: (x, z) => marketZoneAt(x, z),
  },
};
export const PROP_MAP_IDS: readonly PropMapId[] = ["camp", "market"];
/** The map a round is played on: the choice itself, or (Rastgele) either map with even odds. */
export function pickPropMap(choice: PropMapChoice, random: () => number): PropMapId {
  return choice === "random" ? (random() < 0.5 ? "camp" : "market") : choice;
}
