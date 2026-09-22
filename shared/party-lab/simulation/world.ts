import RAPIER from "@dimforge/rapier3d-compat";
import { RAGDOLL } from "./ragdoll/config.js";
import { PLATFORM, BUMPERS } from "./environment.js";

/** Identical static arena for authority, the local reference mode and prediction. */
export function createArenaWorld() {
  const world = new RAPIER.World({ x: 0, y: RAGDOLL.gravity, z: 0 });
  world.timestep = RAGDOLL.step;
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(
      PLATFORM.width / 2,
      PLATFORM.height / 2,
      PLATFORM.depth / 2
    )
      .setTranslation(0, -PLATFORM.height / 2, 0)
      .setFriction(0.6)
  );
  for (const bumper of BUMPERS)
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(bumper.height / 2, bumper.radius)
        .setTranslation(bumper.x, bumper.height / 2, bumper.z)
        .setFriction(0.3)
        .setRestitution(0.3)
    );
  return world;
}
