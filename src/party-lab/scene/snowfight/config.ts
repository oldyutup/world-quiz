/** Local-only rules. No network modes, packets or production settings import this. */
export const FIGHT = {
  id: 'snowball_fight', step: 1 / 60, duration: 80, countdown: 4,
  hp: 3, respawn: 2, protection: 1.6, inventory: 3, gather: 0.78,
  walk: 4.4, sprint: 6.6, crouch: 2.2, gatherSpeed: 0.65,
  acceleration: 32, braking: 40, airAcceleration: 13,
  gravity: 18, jump: 5.4, groundedReset: 0.12,
  height: 1.8, crouchHeight: 1.02, radius: 0.32, mass: 55,
  throwSpeed: 18, ballGravity: 8.5, ballRadius: 0.13,
  ballLife: 3, ballCap: 24, throwInterval: 0.34, flinch: 0.14,
  arenaSize: 28,
} as const;
export interface Vec { x: number; y: number; z: number }
export interface FightInput { x: number; z: number; yaw: number; jump: boolean; sprint: boolean; crouch: boolean; gather: boolean; throw: boolean; aim?: Vec }
export const IDLE: FightInput = { x: 0, z: 0, yaw: Math.PI, jump: false, sprint: false, crouch: false, gather: false, throw: false };
export const COLORS = ['#e77851', '#528fb7', '#a684b5'];
export const NAMES = ['Sen', 'Poyraz', 'Misket'];
export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export const length = (v: Vec) => Math.hypot(v.x, v.y, v.z);
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const unit = (v: Vec): Vec => mul(v, 1 / Math.max(0.00001, length(v)));
export const distance = (a: Vec, b: Vec) => length(sub(a, b));
export function seeded(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
export function direction(yaw: number, pitch: number): Vec { return { x: Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) }; }
export function relativeMove(x: number, z: number, yaw: number) { return { x: -Math.sin(yaw) * z - Math.cos(yaw) * x, z: -Math.cos(yaw) * z + Math.sin(yaw) * x }; }
export function flight(origin: Vec, velocity: Vec, t: number, gravity: number = FIGHT.ballGravity): Vec { return { x: origin.x + velocity.x * t, y: origin.y + velocity.y * t - gravity * t * t / 2, z: origin.z + velocity.z * t }; }
export function leaders(scores: readonly number[]) { return scores.flatMap((n, i) => n === Math.max(...scores) ? [i] : []); }
