import { COMBAT } from "../combatConfig.js";
import type { PartName } from "../ragdoll/config.js";
import { clamp } from "../ragdoll/math.js";
export type Consciousness =
  | "CONSCIOUS"
  | "DAZED"
  | "KNOCKED_OUT"
  | "RECOVERING";
export interface KnockoutState {
  state: Consciousness;
  meter: number;
  remaining: number;
  koAge: number;
  immunity: number;
  quiet: number;
}
export const createKnockout = (): KnockoutState => ({
  state: "CONSCIOUS",
  meter: 0,
  remaining: 0,
  koAge: 0,
  immunity: 0,
  quiet: 0,
});
export function resetKnockout(s: KnockoutState) {
  Object.assign(s, createKnockout());
}
export function impactWeight(part: PartName, quality: number) {
  const value =
    part === "head"
      ? COMBAT.knockout.head
      : part === "torso" || part === "pelvis"
      ? COMBAT.knockout.torso
      : COMBAT.knockout.limb;
  return value * clamp(quality);
}
export function impact(s: KnockoutState, amount: number): boolean {
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    s.immunity > 0 ||
    s.state === "RECOVERING"
  )
    return false;
  s.quiet = 0;
  if (s.state === "KNOCKED_OUT") {
    s.remaining = Math.min(
      COMBAT.knockout.maxDuration - s.koAge,
      s.remaining + COMBAT.knockout.extension
    );
    return false;
  }
  s.meter = Math.min(COMBAT.knockout.threshold, s.meter + amount);
  if (s.meter >= COMBAT.knockout.threshold) {
    s.state = "KNOCKED_OUT";
    s.remaining = COMBAT.knockout.duration;
    s.koAge = 0;
    return true;
  }
  if (s.meter >= COMBAT.knockout.dazedThreshold) s.state = "DAZED";
  return false;
}
export function tickKnockout(s: KnockoutState, dt: number) {
  s.quiet += dt;
  s.immunity = Math.max(0, s.immunity - dt);
  if (s.state === "KNOCKED_OUT") {
    s.koAge += dt;
    s.remaining = Math.max(0, s.remaining - dt);
    if (s.remaining <= 0 || s.koAge >= COMBAT.knockout.maxDuration) {
      s.state = "RECOVERING";
      s.remaining = COMBAT.knockout.recovery;
      s.meter = COMBAT.knockout.recoveryMeter;
    }
  } else if (s.state === "RECOVERING") {
    s.remaining = Math.max(0, s.remaining - dt);
    if (s.remaining === 0) {
      s.state = "CONSCIOUS";
      s.immunity = COMBAT.knockout.immunity;
      s.quiet = 0;
    }
  } else {
    if (s.quiet > COMBAT.knockout.decayDelay)
      s.meter = Math.max(
        0,
        s.meter -
          COMBAT.knockout.decay *
            Math.min(dt, s.quiet - COMBAT.knockout.decayDelay)
      );
    s.state = s.meter >= COMBAT.knockout.dazedThreshold ? "DAZED" : "CONSCIOUS";
  }
}
export function controlStrength(s: KnockoutState): number {
  return s.state === "KNOCKED_OUT"
    ? 0
    : s.state === "DAZED"
    ? COMBAT.knockout.dazedPosture
    : s.state === "RECOVERING"
    ? 0.15 + 0.85 * (1 - s.remaining / COMBAT.knockout.recovery)
    : 1;
}
export function resistance(s: KnockoutState): number {
  return s.state === "KNOCKED_OUT"
    ? COMBAT.grip.koResistance
    : s.state === "DAZED"
    ? COMBAT.grip.dazedResistance
    : s.state === "RECOVERING"
    ? 0.4 + 0.6 * (1 - s.remaining / COMBAT.knockout.recovery)
    : 1;
}
