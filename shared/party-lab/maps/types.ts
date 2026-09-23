/**
 * Gameplay-only arena description, shared by the authoritative server, the
 * client prediction rig and the local reference mode. Rendering never feeds
 * back into it: colliders here are the only physical geometry.
 *
 * Coordinates: metres, +Y up, +Z toward the fixed camera, main floor at y = 0.
 */
export type ArenaMapId = "rooftop" | "test" | "barn";

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
  | "post";

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
  readonly id: ArenaMapId;
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
