import { Quaternion, Vector3 } from "three";
export const CORRECTION = {
  tiny: 0.015,
  small: 0.15,
  hard: 1,
  limbHard: 1.25,
  angleHard: Math.PI / 2,
  /** Tiny and small offsets (see RigCorrection). */
  smallSeconds: 0.3,
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
/**
 * A single rigid visual offset for the whole rig, never per-limb forces or divergent body
 * offsets, eased out over its tier's duration.
 *
 * Tiny and small offsets (the everyday ones, e.g. the server running an input one tick
 * earlier or later: ~77 mm at walking speed, then smaller ones on the next snapshots)
 * follow a cubic that starts at the offset's current velocity, so one that begins while
 * another is easing out continues that motion instead of restarting it. The quadratic
 * ease jumps to full correction speed on its first frame: a 77 mm correction took 26% off
 * that frame's step, again on each following snapshot. Medium offsets (stall recovery)
 * keep the quadratic: there converging fast keeps later errors under the hard limit.
 *
 * The everyday cubic takes 300 ms. Most of these offsets are not real: when inputs reach
 * the server right at its tick boundary, the acknowledgement alternates between two inputs
 * while the server has run the same ticks, so snapshots read a tick ahead, then behind
 * (measured up to 8–9 a second while walking, on localhost and at 70 ms RTT). Eased over
 * 60/120 ms they surged the body, and the Barn camera following it, ±20% of walking speed;
 * over 300 ms opposite ones cancel (under 4%) and a lasting one-tick shift moves the walk
 * by at most 8%.
 */
export class RigCorrection {
  private offset = new Vector3();
  /** Offset velocity (m/s) when this blend began, carried over from the one it replaced. */
  private velocity = new Vector3();
  private carried = new Vector3();
  /** This blend uses the velocity-continuous cubic (tiny/small tiers). */
  private smooth = false;
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
    const carry = this.smooth && this.active;
    this.offsetVelocity(this.carried);
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
        tier === "medium" ? CORRECTION.mediumSeconds : CORRECTION.smallSeconds;
      this.smooth = tier !== "medium";
      // Bounded, so the cubic cannot swing far past rest (at most 0.44× the offset).
      if (this.smooth && carry)
        this.velocity.copy(this.carried).clampLength(0, (3 * this.offset.length()) / this.duration);
    }
    return { error, tier };
  }
  /** 0 when the blend begins, 1 once it has settled. */
  private get progress() {
    return this.duration ? 1 - this.remaining / this.duration : 1;
  }
  /** d/dt of the drawn offset (see apply); only the cubic's is carried. */
  private offsetVelocity(out: Vector3) {
    if (!this.active || !this.smooth) return out.set(0, 0, 0);
    const s = this.progress;
    return out
      .copy(this.offset)
      .multiplyScalar((6 * s * s - 6 * s) / this.duration)
      .addScaledVector(this.velocity, 3 * s * s - 4 * s + 1);
  }
  apply(pose: Float32Array, dt: number, out = new Float32Array(63)) {
    this.remaining = Math.max(0, this.remaining - dt);
    const s = this.progress;
    // Tiny/small: cubic Hermite from (offset, velocity) to rest. Medium: quadratic ease.
    const weight = !this.duration ? 0 : this.smooth ? 2 * s ** 3 - 3 * s ** 2 + 1 : (1 - s) ** 2,
      carry = this.duration && this.smooth ? (s ** 3 - 2 * s ** 2 + s) * this.duration : 0;
    this.q.copy(this.identity).slerp(this.rotation, weight);
    for (let i = 0; i < 63; i += 7) {
      this.point
        .set(pose[i] - pose[0], pose[i + 1] - pose[1], pose[i + 2] - pose[2])
        .applyQuaternion(this.q);
      out[i] = this.point.x + pose[0] + this.offset.x * weight + this.velocity.x * carry;
      out[i + 1] = this.point.y + pose[1] + this.offset.y * weight + this.velocity.y * carry;
      out[i + 2] = this.point.z + pose[2] + this.offset.z * weight + this.velocity.z * carry;
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
    this.velocity.set(0, 0, 0);
    this.smooth = false;
    this.rotation.identity();
    this.duration = this.remaining = 0;
  }
}
