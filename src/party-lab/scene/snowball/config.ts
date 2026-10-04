/** Local prototype only. Never imported by the shared protocol or server. */
export const SNOWBALL = Object.freeze({
  id: 'snowball_brawl', label: 'Kartopu Çarpışması', players: [2, 3] as const,
  rounds: 3, countdown: 3, resultTime: 3.5, fallGrace: 0.9, step: 1 / 120,
  arenaRadius: 10, radius: 0.95, mass: 80, gravity: 16,
  // Ball-to-ball rebound; the floor's Min combine rule keeps ice restitution at 0.
  friction: 0.22, restitution: 0.70, floorFriction: 0.22,
  linearDamping: 0.12, angularDamping: 0.16,
  acceleration: 7.2, usefulSpeed: 11, brake: 12, reverse: 7.2,
  turnRate: 3.6, steeringGrip: 8.5, steeringResponse: 4.2,
  eliminateY: -3.5, shrinkStart: 28, shrinkRate: 0.45, shrinkFastAt: 36, shrinkLateRate: 0.9,
});
export const SNOW_COLORS = ['#ef7357', '#537fcc', '#9c65b6'];
export const SNOW_NAMES = ['Sen', 'Poyraz', 'Tipi'];
export type SnowInput = { throttle: number; steer: number };
export const IDLE: SnowInput = { throttle: 0, steer: 0 };
export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export function arenaRadiusAt(seconds: number, initial: number = SNOWBALL.arenaRadius) {
  const elapsed = Math.max(0, seconds - SNOWBALL.shrinkStart);
  const gentle = Math.min(elapsed, SNOWBALL.shrinkFastAt - SNOWBALL.shrinkStart);
  const late = Math.max(0, seconds - SNOWBALL.shrinkFastAt);
  return Math.max(0, initial - gentle * SNOWBALL.shrinkRate - late * SNOWBALL.shrinkLateRate);
}
export function arenaShrinkSpeedAt(seconds: number) {
  return seconds < SNOWBALL.shrinkStart ? 0 : seconds < SNOWBALL.shrinkFastAt ? SNOWBALL.shrinkRate : SNOWBALL.shrinkLateRate;
}
export function snowSpawns(count: number, radius: number = SNOWBALL.arenaRadius, round = 1) {
  if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error('Snowball needs 2–8 slots');
  return Array.from({ length: count }, (_, i) => {
    const a = i * Math.PI * 2 / count + (round - 1) * 0.55;
    return { x: Math.sin(a) * radius * 0.55, y: SNOWBALL.radius + 0.04, z: Math.cos(a) * radius * 0.55, heading: -a };
  });
}
export function isSnowOut(p: { x: number; y: number; z: number }, initialRadius: number = SNOWBALL.arenaRadius) {
  return p.y < SNOWBALL.eliminateY || Math.hypot(p.x, p.z) > initialRadius + 15;
}
/** null: still playing; -1: simultaneous fall/draw. */
export function snowWinner(alive: readonly boolean[]): number | null {
  const remaining = alive.flatMap((yes, i) => yes ? [i] : []);
  return remaining.length > 1 ? null : remaining[0] ?? -1;
}
