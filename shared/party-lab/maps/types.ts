/**
 * Gameplay-only arena description, shared by the authoritative server, the
 * client prediction rig and the local reference mode. Rendering never feeds
 * back into it: colliders here are the only physical geometry.
 *
 * Coordinates: metres, +Y up, +Z toward the fixed camera, main floor at y = 0.
 */
export type ArenaMapId = "rooftop" | "test" | "barn";
/**
 * Katman Kaosu's tile field (layers.ts), local and online (MODE_MAP.layer_chaos), and Renk
 * Kaosu's colour field (colors.ts, local only). Not in the static map registry: their tiles
 * are gameplay state (they break or drop), added to the world by the tile field.
 */
export type TileArenaId = "layers" | "colors";
/**
 * Arenas that belong to one local game mode and are not in the static registry either:
 * Bomba Sende's walled playground (bomb.ts, local and online) and Saklambaç's forest camp
 * (propHunt.ts, local only). Their geometry is static, but the rooftop test pins ARENA_MAPS's
 * keys and the local test header lists only those.
 */
export type ModeArenaId = "bomb" | "prophunt";

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

/** What a collider represents; renderers and bots key off this, physics does not. */
export type ColliderRole =
  | "floor"
  | "parapet"
  | "building"
  | "deck"
  | "stairs"
  | "condenser"
  | "curb"
  | "bumper"
  // Barn ("Ambar")
  | "wall"
  | "fence"
  | "loft"
  | "step"
  | "rail"
  | "hay"
  | "crate"
  | "stall"
  | "barrel"
  | "post"
  // Bomba Sende ("Oyun Parkı")
  | "hop"
  // Saklambaç ("Orman Kampı")
  | "boundary"
  | "glass"
  | "roof"
  | "woodpile"
  | "tent"
  | "firepit"
  | "furniture"
  | "prop";

interface ColliderBase {
  readonly role: ColliderRole;
  /** Defaults to ARENA_FRICTION. */
  readonly friction?: number;
  readonly restitution?: number;
}
export interface BoxCollider extends ColliderBase {
  readonly shape: "box";
  readonly center: Vec3;
  readonly half: Vec3;
}
export interface CylinderCollider extends ColliderBase {
  readonly shape: "cylinder";
  readonly center: Vec3;
  readonly radius: number;
  readonly halfHeight: number;
}
/** A wedge filling its bounding box, low at one side and full height at the side it rises toward. */
export interface RampCollider extends ColliderBase {
  readonly shape: "ramp";
  readonly center: Vec3;
  readonly half: Vec3;
  readonly rises: "+x" | "-x" | "+z" | "-z";
}
export type ArenaCollider = BoxCollider | CylinderCollider | RampCollider;

/** A boundary where leaving the roof is lethal. `outward` points into the void. */
export interface LethalEdge {
  readonly from: Vec2;
  readonly to: Vec2;
  readonly outward: Vec2;
}

export interface ArenaMap {
  readonly id: ArenaMapId | TileArenaId | ModeArenaId;
  readonly name: string;
  /** Main walkable floor footprint at y = 0. */
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
  readonly colliders: readonly ArenaCollider[];
  /** One per slot; the pelvis is restored here, facing `spawnYaws` (default: the origin). */
  readonly spawns: readonly [Vec3, Vec3, Vec3];
  /** Facing per slot (atan2(x, z), the body's yaw); maps without it face every spawn toward the origin. */
  readonly spawnYaws?: readonly [number, number, number];
  readonly lethalEdges: readonly LethalEdge[];
  /** Local bots only: retreat point and random wander box. */
  readonly bot: {
    readonly home: Vec2;
    readonly wander: { readonly x: number; readonly z: number; readonly halfX: number; readonly halfZ: number };
  };
}

/** Static environment friction; the original test platform's value. */
export const ARENA_FRICTION = 0.6;
