import type { Vec } from "../ragdoll/math.js";
import { BARN_COMBAT } from "./config.js";

/**
 * Barn aim geometry shared by the simulation and the client (pure math, no Rapier:
 * the lobby/session bundle imports it without pulling the physics engine in).
 */
/** Unit aim direction for yaw (atan2(x, z), the body's facing) and pitch (> 0 looks down). */
export function aimDirection(yaw: number, pitch: number): Vec {
  return { x: Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
}
/** The camera's right-shoulder point relative to the pelvis, from the yaw alone. */
export function shoulderEye(yaw: number): Vec {
  const { pivotHeight, shoulder } = BARN_COMBAT.aim;
  return { x: -Math.cos(yaw) * shoulder, y: pivotHeight, z: Math.sin(yaw) * shoulder };
}
/** World point the aim line passes through: the client's (bounded) or the reconstructed one. */
export function aimEye(pelvis: Vec, yaw: number, offset?: Vec | null): Vec {
  const base = shoulderEye(yaw);
  let o = base;
  if (offset && Number.isFinite(offset.x) && Number.isFinite(offset.y) && Number.isFinite(offset.z)) {
    const dx = offset.x - base.x,
      dy = offset.y - base.y,
      dz = offset.z - base.z,
      d = Math.hypot(dx, dy, dz),
      k = d > BARN_COMBAT.aim.maxEyeOffset ? BARN_COMBAT.aim.maxEyeOffset / d : 1;
    o = { x: base.x + dx * k, y: base.y + dy * k, z: base.z + dz * k };
  }
  return { x: pelvis.x + o.x, y: pelvis.y + o.y, z: pelvis.z + o.z };
}
