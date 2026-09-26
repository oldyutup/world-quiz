import type { Vec } from "../ragdoll/math.js";
import { PROP_HUNT } from "./config.js";

/**
 * Saklambaç's aim geometry, shared by the simulation and the client camera (pure math, no
 * Rapier). The Barn's model with this mode's camera: the crosshair line passes through a
 * shoulder point `pivotHeight` above the pelvis and `shoulder` to the right of the aim yaw.
 */
/** Unit aim direction for yaw (atan2(x, z), the body's facing) and pitch (> 0 looks down). */
export function aimDirection(yaw: number, pitch: number): Vec {
  return { x: Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
}
/** Screen-right on the floor plane for a yaw. */
export const rightOf = (yaw: number): Vec => ({ x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) });
/** The shoulder point relative to the pelvis, from the yaw alone. */
export function shoulderEye(yaw: number): Vec {
  const { pivotHeight, shoulder } = PROP_HUNT.aim,
    r = rightOf(yaw);
  return { x: r.x * shoulder, y: pivotHeight, z: r.z * shoulder };
}
/** World point the aim line passes through: the client's (bounded to `maxEyeOffset`) or the reconstructed one. */
export function aimEye(pelvis: Vec, yaw: number, offset?: Vec | null): Vec {
  const base = shoulderEye(yaw);
  let o = base;
  if (offset && Number.isFinite(offset.x) && Number.isFinite(offset.y) && Number.isFinite(offset.z)) {
    const dx = offset.x - base.x,
      dy = offset.y - base.y,
      dz = offset.z - base.z,
      d = Math.hypot(dx, dy, dz),
      k = d > PROP_HUNT.aim.maxEyeOffset ? PROP_HUNT.aim.maxEyeOffset / d : 1;
    o = { x: base.x + dx * k, y: base.y + dy * k, z: base.z + dz * k };
  }
  return { x: pelvis.x + o.x, y: pelvis.y + o.y, z: pelvis.z + o.z };
}
