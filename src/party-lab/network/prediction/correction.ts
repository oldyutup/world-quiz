import { Quaternion, Vector3 } from "three";
export const CORRECTION = {
  tiny: 0.015,
  small: 0.15,
  hard: 1,
  limbHard: 1.25,
  angleHard: Math.PI / 2,
  tinySeconds: 0.06,
  smallSeconds: 0.12,
  mediumSeconds: 0.18,
} as const;
export function correctionTier(error: number, angle = 0, limbError = 0) {
  if (
    ![error, angle, limbError].every(Number.isFinite) ||
    error > CORRECTION.hard ||
    angle > CORRECTION.angleHard ||
    limbError > CORRECTION.limbHard
  )
    return "hard";
  if (error < 0.0001 && angle < 0.0001 && limbError < 0.0001) return "none";
  return error <= CORRECTION.tiny
    ? "tiny"
    : error <= CORRECTION.small
    ? "small"
    : "medium";
}
/** A single rigid visual offset for the whole rig, never per-limb forces or divergent body offsets. */
export class RigCorrection {
  private offset = new Vector3();
  private rotation = new Quaternion();
  private remaining = 0;
  private duration = 0;
  private q = new Quaternion();
  private point = new Vector3();
  private bodyQ = new Quaternion();
  private identity = new Quaternion();
  get active() {
    return this.remaining > 0;
  }
  begin(before: Float32Array, after: Float32Array) {
    const delta = (i: number) =>
      Math.hypot(
        before[i] - after[i],
        before[i + 1] - after[i + 1],
        before[i + 2] - after[i + 2]
      );
    const error = Math.max(delta(0), delta(7));
    let limbError = 0;
    for (let i = 0; i < 63; i += 7) limbError = Math.max(limbError, delta(i));
    this.rotation.set(before[3], before[4], before[5], before[6]);
    this.q.set(after[3], after[4], after[5], after[6]);
    const angle = this.rotation.angleTo(this.q);
    const tier = correctionTier(error, angle, limbError);
    this.clear();
    if (tier !== "none" && tier !== "hard") {
      this.offset.set(
        before[0] - after[0],
        before[1] - after[1],
        before[2] - after[2]
      );
      this.rotation
        .set(before[3], before[4], before[5], before[6])
        .multiply(this.q.invert())
        .normalize();
      this.remaining = this.duration =
        tier === "tiny"
          ? CORRECTION.tinySeconds
          : tier === "small"
          ? CORRECTION.smallSeconds
          : CORRECTION.mediumSeconds;
    }
    return { error, tier };
  }
  apply(pose: Float32Array, dt: number, out = new Float32Array(63)) {
    this.remaining = Math.max(0, this.remaining - dt);
    const weight = this.duration ? (this.remaining / this.duration) ** 2 : 0;
    this.q.copy(this.identity).slerp(this.rotation, weight);
    for (let i = 0; i < 63; i += 7) {
      this.point
        .set(pose[i] - pose[0], pose[i + 1] - pose[1], pose[i + 2] - pose[2])
        .applyQuaternion(this.q);
      out[i] = this.point.x + pose[0] + this.offset.x * weight;
      out[i + 1] = this.point.y + pose[1] + this.offset.y * weight;
      out[i + 2] = this.point.z + pose[2] + this.offset.z * weight;
      this.bodyQ
        .set(pose[i + 3], pose[i + 4], pose[i + 5], pose[i + 6])
        .premultiply(this.q)
        .normalize();
      out[i + 3] = this.bodyQ.x;
      out[i + 4] = this.bodyQ.y;
      out[i + 5] = this.bodyQ.z;
      out[i + 6] = this.bodyQ.w;
    }
    return out;
  }
  clear() {
    this.offset.set(0, 0, 0);
    this.rotation.identity();
    this.duration = this.remaining = 0;
  }
}
