import { BARN_COMBAT } from "./config.js";
import type { Character } from "../ragdoll/character.js";
import { SHAPES } from "../ragdoll/config.js";
import { add, rotate, type Vec } from "../ragdoll/math.js";

/**
 * Bear traps: a foot at floor level over an armed trap springs it (the combat applies
 * damage and the hold). A sprung trap rearms after `rearm` seconds. Pure state plus a
 * read of the characters' feet; no colliders are added (the trap is flat).
 */
export interface TrapState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  armed: boolean;
  /** Seconds until armed again (sprung traps). */
  rearmIn: number;
  /** Seconds since it last sprang (visuals); Infinity before the first. */
  sprungFor: number;
}
export const createTraps = (points: Readonly<Record<string, Vec>>): TrapState[] =>
  Object.entries(points).map(([id, p]) => ({ id, x: p.x, y: p.y, z: p.z, armed: true, rearmIn: 0, sprungFor: Infinity }));

export function resetTraps(traps: TrapState[]) {
  for (const t of traps) Object.assign(t, { armed: true, rearmIn: 0, sprungFor: Infinity });
}
/** Returns the traps that rearmed this tick. */
export function tickTraps(traps: TrapState[], dt: number): TrapState[] {
  const rearmed: TrapState[] = [];
  for (const t of traps) {
    t.sprungFor += dt;
    if (t.armed) continue;
    t.rearmIn = Math.max(0, t.rearmIn - dt);
    if (t.rearmIn === 0) {
      t.armed = true;
      rearmed.push(t);
    }
  }
  return rearmed;
}
/** Bottom of each leg (as the controller's ground check). */
export function feet(character: Character): Vec[] {
  return (["leftLeg", "rightLeg"] as const).map((name) => {
    const body = character.parts[name].body;
    return add(body.translation(), rotate(body.rotation(), { x: 0, y: -SHAPES[name].half - SHAPES[name].radius, z: 0 }));
  });
}
/** The armed trap a foot is on, if any. */
export function trapUnder(traps: readonly TrapState[], points: readonly Vec[]): TrapState | null {
  const { radius } = BARN_COMBAT.trap;
  for (const t of traps) {
    if (!t.armed) continue;
    for (const p of points) if (Math.hypot(p.x - t.x, p.z - t.z) <= radius && p.y <= t.y + 0.35 && p.y >= t.y - 0.3) return t;
  }
  return null;
}
export function spring(trap: TrapState) {
  trap.armed = false;
  trap.rearmIn = BARN_COMBAT.trap.rearm;
  trap.sprungFor = 0;
}
