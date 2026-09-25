import type { Vec3 } from "../../maps/types.js";
import type { PlayerId } from "../players.js";
import type { Vec } from "../ragdoll/math.js";
import { BOMB_TAG, BOMB_TICKS } from "./config.js";

/** One slow trap: armed (open jaws) or shut, reopening after `rearmIn` ticks. */
export interface BombTrap {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  armed: boolean;
  /** Ticks until it reopens (0 while armed). */
  rearmIn: number;
  /** Who sprang it last (presentation), or null. */
  by: PlayerId | null;
}
export interface TrapSpring {
  trap: BombTrap;
  id: PlayerId;
}

/**
 * Bomba Sende's slow traps, as pure state in whole ticks (like BombRules): no colliders (a
 * trap is flat) and no damage — they only slow. The game feeds each player's feet once per
 * playing tick, before the step's physics:
 * - the shut traps count down and reopen after `trap.rearm`;
 * - every slow counts down (`trap.time`);
 * - a foot at floor level within `trap.radius` of an armed trap springs it on that player
 *   (the lowest slot first on a shared tick): shut for `trap.rearm`, and the player slowed.
 *   Someone already slowed passes over armed traps without springing them.
 * The bomb is none of its business: a trap never passes, takes or burns it.
 */
export class BombTraps {
  readonly traps: BombTrap[];
  /** Ticks of slow left per slot (0: free). */
  readonly slowed = [0, 0, 0];
  /** This round's springs (diagnostics). */
  springs = 0;
  constructor(points: readonly Vec3[]) {
    this.traps = points.map((p, id) => ({ id, x: p.x, y: p.y, z: p.z, armed: true, rearmIn: 0, by: null }));
  }
  reset() {
    for (const t of this.traps) Object.assign(t, { armed: true, rearmIn: 0, by: null });
    this.slowed.fill(0);
    this.springs = 0;
  }
  /**
   * One playing tick. `feet(id)`: the player's feet, or null for someone out of the round.
   * Returns the traps that reopened and the springs, in that order of events.
   */
  tick(players: readonly PlayerId[], feet: (id: PlayerId) => readonly Vec[] | null): { rearmed: BombTrap[]; sprung: TrapSpring[] } {
    const rearmed: BombTrap[] = [],
      sprung: TrapSpring[] = [];
    for (const t of this.traps)
      if (!t.armed && --t.rearmIn <= 0) {
        t.armed = true;
        t.rearmIn = 0;
        rearmed.push(t);
      }
    for (let id = 0; id < this.slowed.length; id++) if (this.slowed[id] > 0) this.slowed[id]--;
    for (const id of players) {
      if (this.slowed[id] > 0) continue;
      const points = feet(id);
      if (!points) continue;
      const trap = this.under(points);
      if (!trap) continue;
      trap.armed = false;
      trap.rearmIn = BOMB_TICKS.trapRearm;
      trap.by = id;
      this.slowed[id] = BOMB_TICKS.trapSlow;
      this.springs++;
      sprung.push({ trap, id });
    }
    return { rearmed, sprung };
  }
  /** The armed trap a foot is on (at floor level), if any. */
  under(points: readonly Vec[]): BombTrap | null {
    const { radius } = BOMB_TAG.trap;
    for (const t of this.traps) {
      if (!t.armed) continue;
      for (const p of points) if (Math.hypot(p.x - t.x, p.z - t.z) <= radius && p.y <= t.y + 0.35 && p.y >= t.y - 0.3) return t;
    }
    return null;
  }
  /** The drive's mobility factor for a slot this step (1: free). */
  mobility(id: PlayerId) {
    return this.slowed[id] > 0 ? BOMB_TAG.trap.slow : 1;
  }
}
