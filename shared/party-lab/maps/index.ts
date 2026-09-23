import { BARN_MAP } from "./barn.js";
import { ROOFTOP_MAP } from "./rooftop.js";
import { TEST_MAP } from "./test.js";
import type { ArenaMap, ArenaMapId, RampCollider, Vec3 } from "./types.js";

export * from "./types.js";

/** Every map selectable in the local mode. Online, each game mode names its map (modes.ts MODE_MAP). */
export const ARENA_MAPS: Readonly<Record<ArenaMapId, ArenaMap>> = {
  rooftop: ROOFTOP_MAP,
  test: TEST_MAP,
  barn: BARN_MAP,
};
export const ARENA_MAP_IDS = Object.keys(ARENA_MAPS) as ArenaMapId[];
/** Local mode default. */
export const DEFAULT_ARENA_MAP_ID: ArenaMapId = "rooftop";
/**
 * Rooftop Brawl's online map (MODE_MAP.rooftop_brawl). Server authority and client
 * prediction both build from it; changing it requires a NET.version bump so stale
 * clients refuse snapshots.
 */
export const ONLINE_ARENA_MAP_ID: ArenaMapId = "rooftop";

export function arenaMap(id: ArenaMapId): ArenaMap {
  return ARENA_MAPS[id];
}
/** A slot's spawn facing: the map's explicit yaw, else toward the origin (rooftop, test). */
export function spawnYaw(map: ArenaMap, slot: number): number {
  const explicit = map.spawnYaws?.[slot];
  if (explicit !== undefined) return explicit;
  const s = map.spawns[slot];
  return Math.atan2(-s.x, -s.z);
}
export function isArenaMapId(value: unknown): value is ArenaMapId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ARENA_MAPS, value);
}

/** Six corners of a ramp wedge (convex hull input), world coordinates. */
export function rampHull({ center: c, half: h, rises }: RampCollider): Vec3[] {
  const axis = rises[1] as "x" | "z",
    sign = rises[0] === "+" ? 1 : -1;
  const low = c.y - h.y,
    high = c.y + h.y;
  const corners: Vec3[] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      corners.push({ x: c.x + sx * h.x, y: low, z: c.z + sz * h.z });
  // The raised edge sits on the side the ramp rises toward.
  const raised = corners
    .filter((p) => Math.sign((axis === "x" ? p.x - c.x : p.z - c.z)) === sign)
    .map((p) => ({ ...p, y: high }));
  return [...corners, ...raised];
}
