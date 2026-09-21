import RAPIER from "@dimforge/rapier3d-compat";
import type { MovementInput } from "../input/keyboard";

export const PHYSICS = {
  step: 1 / 60,
  gravity: -20,
  radius: 0.42,
  halfHeight: 0.38,
  mass: 1,
  speed: 5.2,
  acceleration: 32,
  airAcceleration: 10,
  braking: 18,
  damping: 0.45,
  friction: 0.3,
  jumpSpeed: 7.5,
  groundMargin: 0.08,
  fallY: -5,
  respawnDelay: 1.25,
} as const;

export const SPAWN = { x: 0, y: 1.6, z: 2 };
export const PLATFORM = { width: 14, depth: 12, height: 1.2 };
export const BUMPERS = [
  { x: -3.2, z: -1.7, radius: 0.85, height: 1.4, color: "#ef9a87" },
  { x: 3.2, z: -1.7, radius: 0.85, height: 1.4, color: "#e9ce7d" },
  { x: 0, z: -3.7, radius: 1.05, height: 0.65, color: "#aaa2d9" },
] as const;

let initialization: Promise<void> | undefined;
export function initializePhysics(): Promise<void> {
  // Share WASM initialization, never a World, across StrictMode mounts.
  return initialization ??= RAPIER.init().catch(error => {
    initialization = undefined;
    throw error;
  });
}

/** Local fixed-step simulation, deliberately independent of React and Three. */
export class PlaygroundPhysics {
  readonly world: RAPIER.World;
  readonly player: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly groundRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly impulse = { x: 0, y: 0, z: 0 };
  private respawnRemaining = 0;
  private disposed = false;
  fallen = false;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    this.world.timestep = PHYSICS.step;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(PLATFORM.width / 2, PLATFORM.height / 2, PLATFORM.depth / 2)
      .setTranslation(0, -PLATFORM.height / 2, 0).setFriction(0.6));
    for (const bumper of BUMPERS) {
      this.world.createCollider(RAPIER.ColliderDesc.cylinder(bumper.height / 2, bumper.radius)
        .setTranslation(bumper.x, bumper.height / 2, bumper.z)
        .setFriction(0.3).setRestitution(0.55)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max));
    }
    this.player = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(SPAWN.x, SPAWN.y, SPAWN.z)
      .lockRotations().setLinearDamping(PHYSICS.damping).setCcdEnabled(true));
    this.collider = this.world.createCollider(RAPIER.ColliderDesc.capsule(PHYSICS.halfHeight, PHYSICS.radius)
      .setMass(PHYSICS.mass).setFriction(PHYSICS.friction).setRestitution(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min), this.player);
  }

  isGrounded(): boolean {
    if (this.fallen || this.player.linvel().y > 0.5) return false;
    const position = this.player.translation();
    this.groundRay.origin.x = position.x;
    this.groundRay.origin.y = position.y;
    this.groundRay.origin.z = position.z;
    const hit = this.world.castRayAndGetNormal(this.groundRay,
      PHYSICS.halfHeight + PHYSICS.radius + PHYSICS.groundMargin, true,
      undefined, undefined, this.collider, this.player);
    return hit !== null && hit.normal.y > 0.65;
  }

  step(input: MovementInput): "fell" | "respawned" | null {
    if (this.fallen) {
      this.respawnRemaining -= PHYSICS.step;
      if (this.respawnRemaining > 0) return null;
      // Teleport only on respawn, never as a movement controller.
      this.player.setTranslation(SPAWN, true);
      this.player.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.player.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.player.resetForces(true);
      this.player.resetTorques(true);
      this.player.setEnabled(true);
      this.fallen = false;
      return "respawned";
    }

    const grounded = this.isGrounded();
    const velocity = this.player.linvel();
    const length = Math.hypot(input.x, input.z);
    const normalizer = Math.max(1, length);
    const desiredX = input.x / normalizer * PHYSICS.speed;
    const desiredZ = input.z / normalizer * PHYSICS.speed;
    const deltaX = desiredX - velocity.x;
    const deltaZ = desiredZ - velocity.z;
    const acceleration = grounded ? (length > 0 ? PHYSICS.acceleration : PHYSICS.braking) : (length > 0 ? PHYSICS.airAcceleration : 0);
    const change = Math.hypot(deltaX, deltaZ);
    const scale = change > 0 ? Math.min(1, acceleration * PHYSICS.step / change) : 0;
    this.impulse.x = deltaX * scale * PHYSICS.mass;
    this.impulse.z = deltaZ * scale * PHYSICS.mass;
    this.impulse.y = input.jump && grounded ? (PHYSICS.jumpSpeed - velocity.y) * PHYSICS.mass : 0;
    this.player.applyImpulse(this.impulse, true);
    this.world.step();

    if (this.player.translation().y < PHYSICS.fallY) {
      this.fallen = true;
      this.respawnRemaining = PHYSICS.respawnDelay;
      this.player.setEnabled(false);
      return "fell";
    }
    return null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.world.free();
  }
}
