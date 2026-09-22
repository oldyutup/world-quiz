import type { Character } from "../ragdoll/character.js";
import type { Hand } from "../ragdoll/config.js";
import type { ArmDrive } from "../ragdoll/controller.js";
import { add, rotate, yaw } from "../ragdoll/math.js";
import { COMBAT } from "../combatConfig.js";
import type { PartName } from "../ragdoll/config.js";
import { clamp } from "../ragdoll/math.js";
import { impactWeight } from "./knockout.js";
export interface Punch {
  age: number;
  cooldown: number;
  hit: boolean;
}
export const newPunch = (): Punch => ({ age: -1, cooldown: 0, hit: false });
export function startPunch(punch: Punch) {
  if (punch.cooldown > 0) return false;
  punch.age = 0;
  punch.cooldown = COMBAT.punch.cooldown;
  punch.hit = false;
  return true;
}
export function tickPunch(p: Punch, dt: number) {
  p.cooldown = Math.max(0, p.cooldown - dt);
  if (p.age >= 0) {
    p.age += dt;
    if (
      p.age >
      COMBAT.punch.startup + COMBAT.punch.active + COMBAT.punch.recovery
    )
      p.age = -1;
  }
}
export const activePunch = (p: Punch) =>
  p.age >= COMBAT.punch.startup &&
  p.age < COMBAT.punch.startup + COMBAT.punch.active &&
  !p.hit;
export function punchPower(part: PartName, closing: number, direction: number) {
  if (
    closing < COMBAT.punch.minClosing ||
    direction < COMBAT.punch.minDirection
  )
    return 0;
  return impactWeight(
    part,
    clamp(closing / COMBAT.punch.fullClosing) * clamp(direction, 0.25, 1)
  );
}

/** Physical arm drive shared by real combat and presentation-only prediction. No hit logic. */
export function punchArmDrive(
  character: Character,
  hand: Hand,
  punch: Punch
): ArmDrive | null {
  if (punch.age < 0 || punch.age >= COMBAT.punch.startup + COMBAT.punch.active)
    return null;
  const arm: ArmDrive = {
    shoulder: punch.age < COMBAT.punch.startup ? -0.35 : COMBAT.punch.shoulder,
    elbow: COMBAT.punch.elbow,
  };
  if (punch.age >= COMBAT.punch.startup) {
    arm.target = add(
      character.body.translation(),
      rotate(yaw(character.facing), {
        x: hand === 0 ? -0.14 : 0.14,
        y: 0.82,
        z: 0.95,
      })
    );
    arm.force = COMBAT.punch.handForce;
  }
  return arm;
}
