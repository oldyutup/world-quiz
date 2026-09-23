import { BARN_COMBAT } from "./config.js";
import type { Vec } from "../ragdoll/math.js";

/**
 * Disposable Barn weapons: fixed ammunition, no reload. The last round removes the
 * weapon (the owner is unarmed again). Pure rules, no physics or rendering.
 */
export const WEAPON_KINDS = ["shotgun", "smg"] as const;
export type WeaponKind = (typeof WEAPON_KINDS)[number];

export interface HeldWeapon {
  readonly kind: WeaponKind;
  ammo: number;
  /** Seconds until the next round (negative: remainder carried while held). */
  cooldown: number;
  /** Current extra spread from sustained fire (SMG), radians. */
  bloom: number;
}
export const newWeapon = (kind: WeaponKind): HeldWeapon => ({ kind, ammo: BARN_COMBAT[kind].ammo, cooldown: 0, bloom: 0 });

/** Damage multiplier at a distance (0 = out of range). */
export function falloff(kind: WeaponKind, distance: number): number {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  if (kind === "shotgun") {
    const s = BARN_COMBAT.shotgun;
    if (distance > s.range) return 0;
    if (distance <= s.full) return 1;
    if (distance <= s.weak) return 1 - ((1 - s.weakFactor) * (distance - s.full)) / (s.weak - s.full);
    return (s.weakFactor * (s.range - distance)) / (s.range - s.weak);
  }
  const s = BARN_COMBAT.smg;
  if (distance > s.range) return 0;
  if (distance <= s.full) return 1;
  if (distance <= s.far) return 1 - ((1 - s.farFactor) * (distance - s.full)) / (s.far - s.full);
  return s.farFactor;
}
/** Whole HP per pellet/round at a distance; anything in range does at least 1. */
export function shotDamage(kind: WeaponKind, distance: number): number {
  const f = falloff(kind, distance);
  return f > 0 ? Math.max(1, Math.round(BARN_COMBAT[kind].damage * f)) : 0;
}
export const weaponRange = (kind: WeaponKind) => BARN_COMBAT[kind].range;

/** Per step: cooldown and bloom recovery. While held, the SMG carries its cooldown remainder. */
export function tickWeapon(weapon: HeldWeapon, dt: number, held: boolean) {
  weapon.cooldown = weapon.cooldown > 0 ? weapon.cooldown - dt : 0;
  if (!held) weapon.cooldown = Math.max(0, weapon.cooldown);
  if (weapon.kind === "smg" && !held) weapon.bloom = Math.max(0, weapon.bloom - BARN_COMBAT.smg.recovery * dt);
}
/**
 * Whether the weapon fires this step, consuming a round. The shotgun fires on a
 * press only; the SMG on a press or while held, once per `interval`.
 */
export function tryFire(weapon: HeldWeapon, pressed: boolean, held: boolean): boolean {
  const trigger = weapon.kind === "shotgun" ? pressed : pressed || held;
  if (!trigger || weapon.ammo <= 0 || weapon.cooldown > 1e-9) return false;
  weapon.ammo--;
  if (weapon.kind === "smg") {
    weapon.cooldown += BARN_COMBAT.smg.interval;
    weapon.bloom = Math.min(BARN_COMBAT.smg.maxSpread - BARN_COMBAT.smg.spread, weapon.bloom + BARN_COMBAT.smg.bloom);
  }
  return true;
}
/** Cone half-angle for the round about to be fired (SMG bloom grows after it). */
export const currentSpread = (weapon: HeldWeapon) =>
  weapon.kind === "shotgun" ? BARN_COMBAT.shotgun.spread : Math.min(BARN_COMBAT.smg.maxSpread, BARN_COMBAT.smg.spread + weapon.bloom);

/** Unit vectors perpendicular to `d` (any fixed choice, continuous away from vertical). */
function basis(d: Vec): [Vec, Vec] {
  const up = Math.abs(d.y) < 0.95 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  let u = { x: up.y * d.z - up.z * d.y, y: up.z * d.x - up.x * d.z, z: up.x * d.y - up.y * d.x };
  const l = Math.hypot(u.x, u.y, u.z);
  u = { x: u.x / l, y: u.y / l, z: u.z / l };
  const v = { x: d.y * u.z - d.z * u.y, y: d.z * u.x - d.x * u.z, z: d.x * u.y - d.y * u.x };
  return [u, v];
}
/** `d` tilted by `angle` toward the perpendicular direction at `around` radians. */
export function deviate(d: Vec, angle: number, around: number): Vec {
  const [u, v] = basis(d),
    s = Math.sin(angle),
    c = Math.cos(angle),
    cu = Math.cos(around) * s,
    cv = Math.sin(around) * s;
  return { x: d.x * c + u.x * cu + v.x * cv, y: d.y * c + u.y * cu + v.y * cv, z: d.z * c + u.z * cu + v.z * cv };
}
/**
 * Directions for one shot. Shotgun: one pellet near the centre and a ring of the rest
 * between 55 % and 100 % of the cone, evenly turned with jitter — every pellet stays
 * inside the cone and the pattern never clumps. SMG: one round anywhere in the cone.
 */
export function shotDirections(kind: WeaponKind, aim: Vec, spread: number, random: () => number): Vec[] {
  if (kind === "smg") return [deviate(aim, spread * Math.sqrt(random()), random() * Math.PI * 2)];
  const n = BARN_COMBAT.shotgun.pellets,
    ring = n - 1,
    turn = random() * Math.PI * 2;
  const out = [deviate(aim, spread * 0.15 * random(), random() * Math.PI * 2)];
  for (let i = 0; i < ring; i++)
    out.push(deviate(aim, spread * (0.55 + 0.45 * random()), turn + ((i + 0.3 * (random() - 0.5)) * Math.PI * 2) / ring));
  return out;
}
