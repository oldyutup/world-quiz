import { COMBAT } from "../combatConfig.js";
import type { KnockoutState } from "./knockout.js";
import { clamp } from "../ragdoll/math.js";
/** Quality affects hand posture/force, never writes the target's Y velocity. */
export function liftQuality(
  grips: number,
  state: KnockoutState["state"],
  effort: number,
  distance: number
) {
  if (!grips || distance > COMBAT.lift.maxCarryDistance) return 0;
  const vulnerability =
    state === "KNOCKED_OUT"
      ? 1
      : state === "DAZED"
      ? COMBAT.lift.dazedQuality
      : COMBAT.lift.consciousQuality;
  return (
    (grips >= 2 ? COMBAT.lift.twoQuality : COMBAT.lift.oneQuality) *
    vulnerability *
    (1 - COMBAT.lift.resistingPenalty * clamp(effort))
  );
}
