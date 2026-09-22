import RAPIER from "@dimforge/rapier3d-compat";
import { RAGDOLL } from "./ragdoll/config.js";
import {
  ARENA_FRICTION,
  rampHull,
  type ArenaCollider,
  type ArenaMap,
} from "../maps/index.js";

function colliderDesc(c: ArenaCollider): RAPIER.ColliderDesc {
  const desc =
    c.shape === "box"
      ? RAPIER.ColliderDesc.cuboid(c.half.x, c.half.y, c.half.z).setTranslation(c.center.x, c.center.y, c.center.z)
      : c.shape === "cylinder"
      ? RAPIER.ColliderDesc.cylinder(c.halfHeight, c.radius).setTranslation(c.center.x, c.center.y, c.center.z)
      : RAPIER.ColliderDesc.convexHull(new Float32Array(rampHull(c).flatMap((p) => [p.x, p.y, p.z])));
  if (!desc) throw new Error(`Invalid ${c.role} collider`);
  desc.setFriction(c.friction ?? ARENA_FRICTION);
  if (c.restitution !== undefined) desc.setRestitution(c.restitution);
  return desc;
}

/** Identical static arena for authority, the local reference mode and prediction. */
export function createArenaWorld(map: ArenaMap) {
  const world = new RAPIER.World({ x: 0, y: RAGDOLL.gravity, z: 0 });
  world.timestep = RAGDOLL.step;
  for (const collider of map.colliders) world.createCollider(colliderDesc(collider));
  return world;
}
