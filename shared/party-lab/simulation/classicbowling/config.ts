/** Local-only geometry, independent of Human Bowling. Metres, kilograms, seconds. */
export const CLASSIC = {
  id: 'classic_bowling', frames: 3, step: 1 / 120,
  laneWidth: 1.5, headZ: 10.5, deckEnd: 11.65, launchZ: 0,
  gutterWidth: .34, gutterDepth: .19,
  ballRadius: .135, ballMass: 6.5,
  pinHeight: .47625, pinRadius: .0755, pinMass: 1.58, spacing: .381,
  pinPlacementTolerance: .0015,
  positionRange: .56, positionHalfPeriod: .675,
  angleRange: 6.5, directionHalfPeriod: .825,
  powerMin: 35, powerMax: 100, powerHalfPeriod: 1.5,
  speedMin: 4, speedMax: 9.5,
  settleMin: 1.6, settleMax: 2.8, stableDuration: .35, rollTimeout: 7,
  resultDuration: 1.35, returnDuration: 1.05,
} as const;
export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
/** Constant-speed sweep, starts at centre, repeats forever. halfPeriod = edge to edge. */
export function sweep(time: number, halfPeriod: number) {
  const t = ((time / halfPeriod + .5) % 2 + 2) % 2;
  return 1 - 2 * Math.abs(t - 1);
}
export const positionAt = (t: number) => sweep(t, CLASSIC.positionHalfPeriod) * CLASSIC.positionRange;
export const directionAt = (t: number) => sweep(t, CLASSIC.directionHalfPeriod) * CLASSIC.angleRange;
export const powerAt = (t: number) => CLASSIC.powerMin + (sweep(t, CLASSIC.powerHalfPeriod) + 1) * .5 * (CLASSIC.powerMax - CLASSIC.powerMin);
export const ballSpeed = (power: number) => CLASSIC.speedMin + (CLASSIC.speedMax - CLASSIC.speedMin) * clamp((power - CLASSIC.powerMin) / (CLASSIC.powerMax - CLASSIC.powerMin), 0, 1);
export function rackPositions() {
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: row + 1 }, (_, col) => ({ x: (col - row / 2) * CLASSIC.spacing, y: .002, z: CLASSIC.headZ + row * CLASSIC.spacing * Math.sqrt(3) / 2 }))).flat();
}
/** Original lathed silhouette. The same profile builds render geometry and two convex colliders. */
export const PIN_PROFILE: readonly (readonly [number, number])[] = [
  [.031, 0], [.037, .016], [.059, .065], [.0755, .143], [.07, .195],
  [.049, .25], [.028, .3], [.024, .335], [.031, .361], [.041, .391],
  [.043, .417], [.032, .456], [.012, .475], [0, .47625],
];
export const PIN_SPLIT = 7;
export const COLORS = ['#378f96', '#d77963', '#c29a3e'];
export const PLAYER_NAMES = ['Sen', 'Misket', 'Limon'];
