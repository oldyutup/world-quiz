import { SNOWBALL as C, angleDelta, clamp, type SnowInput } from './config';

/** Rooftop's fixed screen basis: right = +X, up = -Z.
 * This is only a keyboard adapter to the existing throttle/steer motor.
 * It never writes a body pose/velocity/heading or changes a physics coefficient.
 * Opposite-direction requests use the existing brake/reverse path; other requests
 * turn at the motor's existing rate. Momentum still takes time to change direction.
 */
export function snowballScreenInput(x: number, z: number, heading: number, speed: number): SnowInput {
  if (!x && !z) return { throttle: 0, steer: 0 };
  const desired = Math.atan2(x, -z);
  const reverse = Math.abs(angleDelta(desired, heading)) > Math.PI / 2;
  const delta = angleDelta(desired + (reverse ? Math.PI : 0), heading);
  // A wrapped 2π can leave floating-point residue. A settled heading must send
  // actual zero: the existing motor enables lateral grip for nonzero steering.
  const error = Math.abs(delta) < 1e-8 ? 0 : delta;
  const stepAngle = C.turnRate / (1 + speed * 0.12) * C.step;
  return {
    // Project the requested direction onto the current control heading, avoiding
    // full thrust in the wrong screen direction while the unchanged motor turns.
    throttle: (reverse ? -1 : 1) * Math.max(0, Math.cos(error)),
    steer: clamp(error / stepAngle, -1, 1),
  };
}
