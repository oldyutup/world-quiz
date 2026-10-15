/** Approved Crate Rain rules shared by local play and the authoritative server. */
export const CRATE_RAIN = Object.freeze({
  id: 'crate_rain', label: 'Kutu Yağmuru', step: 1 / 120,
  rounds: 3, countdown: 3, resultTime: 3, maxRoundTime: 20,
  arenaSize: 14, wallHeight: 10, boxCap: 120, gravity: 22,
  walkSpeed: 5, sprintSpeed: 7.2, acceleration: 38, airAcceleration: 17,
  jumpSpeed: 8.9, coyote: 0.10, jumpBuffer: 0.12, stepHeight: 0.26,
  playerRadius: 0.32, playerHalf: 0.42, playerMass: 8,
  friction: 0.82, spawnHeight: 9,
});
/** All gameplay variants share exactly one cube and mass. Only paint differs. */
export const CRATE_SIZE = 1.4;
export const CRATE_MASS = 34;
const STANDARD = { size: [CRATE_SIZE, CRATE_SIZE, CRATE_SIZE] as const, mass: CRATE_MASS };
export const BOXES = {
  cedar: { ...STANDARD, color: '#bf9367', strap: '#587e7a' },
  olive: { ...STANDARD, color: '#bb956f', strap: '#67765b' },
  ochre: { ...STANDARD, color: '#b88959', strap: '#c6a35e' },
} as const;
export type BoxKind = keyof typeof BOXES;
export const BOX_KINDS = Object.keys(BOXES) as BoxKind[];
export const PLAYER_COLORS = ['#ed7056', '#548cce', '#a779c5'];
export const PLAYER_NAMES = ['Sen', 'Misket', 'Fındık'];
/**
 * The punch (Yumruk: F / left click), Hediye Kapmaca's values on the capsule. A press swings for
 * `startup` + `active` s (one press per `cooldown` s). The nearest rival within `range` m in the
 * active window (centre to centre, any direction; within `heightGap` m up or down; no crate
 * between) is pushed `push` m/s away (and `lift` m/s up) and stunned for `stun` s: no walking,
 * jumping or punching, and no braking (it slides); falling crates still knock it out. Then it is
 * guarded for `guard` s: nobody can punch it, so a stun can never be chained. A stunned player
 * cannot be punched either.
 */
export const CRATE_PUNCH = Object.freeze({
  startup: 0.08, active: 0.27, cooldown: 0.6,
  range: 1.3, heightGap: 1.0,
  push: 3.0, lift: 0.3,
  stun: 1.0, guard: 1.5,
});
export type Input = { x: number; z: number; jump: boolean; sprint: boolean; punch?: boolean };
export const IDLE: Input = { x: 0, z: 0, jump: false, sprint: false, punch: false };
export const FEET = CRATE_RAIN.playerRadius + CRATE_RAIN.playerHalf;
export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) | 0; let n = Math.imul(state ^ state >>> 15, 1 | state); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
/** Landing-time coverage curve, scaled to the playable grid, never fixed crate counts. */
export const COVERAGE_CURVE = [[0, 0], [5, .08], [10, .24], [15, .52], [18, .82], [19.25, 1]] as const;
export function baseLandingTime(index: number, cells: number) {
  const fraction = (index + 1) / cells;
  for (let i = 1; i < COVERAGE_CURVE.length; i++) {
    const [t, f] = COVERAGE_CURVE[i], [prevT, prevF] = COVERAGE_CURVE[i - 1];
    if (fraction <= f + 1e-9) return prevT + (t - prevT) * (fraction - prevF) / (f - prevF);
  }
  return 19.25;
}
export function waveAt(t: number) {
  const phase = t < 5 ? 1 : t < 10 ? 2 : t < 15 ? 3 : t < 18 ? 4 : 5;
  return { phase, label: ['İlk teslimat', 'Kargo birikiyor', 'Yollar daralıyor', 'Sağanak!', 'SON YAĞMUR!'][phase - 1],
    warning: .95 - .30 * clamp(t / 18, 0, 1), bias: t < 18 ? 0 : .65 };
}
/** Shortest-arc visual turn. Physical velocity is deliberately independent. */
export function smoothFacing(current: number, target: number, dt: number) {
  return current + Math.atan2(Math.sin(target - current), Math.cos(target - current)) * (1 - Math.exp(-18 * dt));
}
/** null: continue; -1: same-tick elimination draw. */
export function roundWinner(alive: readonly boolean[]) { const ids = alive.flatMap((v, i) => v ? [i] : []); return ids.length > 1 ? null : ids[0] ?? -1; }
