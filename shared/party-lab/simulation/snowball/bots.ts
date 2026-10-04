import { angleDelta, clamp, arenaShrinkSpeedAt, SNOWBALL, type SnowInput } from './config.js';
export interface SnowSense { id: number; x: number; z: number; vx: number; vz: number; heading: number; alive: boolean }
/** Sample-and-hold decisions. Only present positions/velocities, no physics forecasts. */
export function snowBot(me: SnowSense, rivals: SnowSense[], radius: number, time: number, seed: number): SnowInput {
  const speed = Math.hypot(me.vx, me.vz), radial = Math.hypot(me.x, me.z);
  const outward = (me.x * me.vx + me.z * me.vz) / Math.max(1, radial);
  const cautious = me.id % 2 === 0;
  // Keep the original full-arena caution. Scale the margin only as the disk
  // shrinks: a fixed 3.2 m margin would eventually mark even the center unsafe.
  const margin = Math.min(cautious ? 3.2 : 2.4, radius * 0.45);
  // Account for edge loss during one imperfect reaction interval, not a physics
  // forecast. Current positions/velocities and the public round clock only.
  const danger = radial + Math.max(0, outward) * 0.65 + arenaShrinkSpeedAt(time) * 0.32 > radius - margin;
  const target = rivals.filter(p => p.alive && p.id !== me.id).sort((a, b) =>
    Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
  let x = 0, z = 0;
  if (!danger && target) {
    const error = Math.sin(time * 1.3 + seed * 0.7 + me.id * 4) * (cautious ? 1.1 : 0.65);
    x = target.x + target.vx * 0.18 + error;
    z = target.z + target.vz * 0.18 - error;
    // Break low-speed shoving contests: circle out for a fresh collision line.
    // Staggered by slot/seed so opponents don't retreat in lockstep.
    const reset = (time + me.id * 2.1 + seed * 0.13) % 7 < 1.7;
    if (reset && Math.hypot(target.x-me.x,target.z-me.z)<4.5 && radius>5) {
      const angle = Math.atan2(me.z,me.x) + (cautious ? -0.9 : 1.1);
      x = Math.cos(angle)*radius*0.48; z = Math.sin(angle)*radius*0.48;
    }
  }
  const desired = Math.atan2(x - me.x, -(z - me.z));
  const error = angleDelta(desired, me.heading);
  const braking = (danger && outward > 1.2) || (Math.abs(error) > 1.1 && speed > 3.8);
  const throttle = braking ? -1 : Math.abs(error) > 1.6 ? 0 : cautious && speed > 7 ? 0.45 : 1;
  return { throttle, steer: clamp(error * 1.6, -1, 1) };
}
export const botReaction = (slot: number) => Math.round((slot % 2 ? 0.24 : 0.32) / SNOWBALL.step);
