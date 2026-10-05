import { CLASSIC as C, clamp } from './config';
export function seededRandom(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
/** Pick a time on the repeating sweep, not a velocity or a score. */
export function phaseTime(value: number, halfPeriod: number) {
  const v = clamp(value, -1, 1);
  return v >= 0 ? v * halfPeriod / 2 : (1 - v / 2) * halfPeriod;
}
export type BotStyle = 'straight' | 'angle' | 'power';
export interface BotPlan { position: number; direction: number; power: number; style: BotStyle }
export function botPlan(random: () => number, style: BotStyle, targets: readonly { x: number; z: number }[]): BotPlan {
  const signed = () => random() * 2 - 1;
  const position = clamp(style === 'straight' ? signed() * .16 : signed() * .51, -C.positionRange, C.positionRange);
  const target = targets.length < 6 ? targets[Math.floor(random() * targets.length)] ?? { x: 0, z: C.headZ } : { x: signed() * .15, z: C.headZ };
  // Accuracy is aim/timing error only. Bad attempts are possible in every style.
  const miss = random() < .12;
  const angle = Math.atan2(target.x - position, target.z) * 180 / Math.PI + signed() * (miss ? 5.4 : style === 'power' ? 1.65 : 1.1);
  const power = style === 'power' ? 79 + random() * 21 : 42 + random() * 54;
  const jitter = () => signed() * .035;
  // Keep the original value-space error and near-centre floor as sweeps speed up.
  const positionTimingScale = C.positionHalfPeriod / 1.8;
  const directionTimingScale = C.directionHalfPeriod / 2.2;
  return {
    style,
    position: Math.max(.08 * positionTimingScale, phaseTime(position / C.positionRange, C.positionHalfPeriod) + jitter() * positionTimingScale),
    direction: Math.max(.06 * directionTimingScale, phaseTime(clamp(angle, -C.angleRange, C.angleRange) / C.angleRange, C.directionHalfPeriod) + jitter() * directionTimingScale),
    power: Math.max(.08, phaseTime((power - C.powerMin) / (C.powerMax - C.powerMin) * 2 - 1, C.powerHalfPeriod) + jitter()),
  };
}
