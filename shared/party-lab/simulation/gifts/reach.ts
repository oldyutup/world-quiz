import { homeCenter } from "../../maps/gifts.js";
import { GIFT } from "./config.js";

export interface GiftReach {
  kind: "loose" | "pile" | "steal";
  /** The floor box's id, 0 for the pile, the robbed home's owner. */
  target: number;
  /** Horizontal distance to it (m): what decides a contest. */
  distance: number;
}
/** What reach needs to know of a round (the game and a decoded snapshot both have it). */
export interface ReachState {
  readonly seats: readonly number[];
  readonly players: number;
  readonly pile: number;
  readonly home: readonly number[];
  readonly boxes: readonly { id: number; x: number; z: number; land: number }[];
}

/**
 * What a Tut press by `slot` standing at `p` (its pelvis) takes on round tick `t`, nearest
 * first: a box on the floor within `reach.loose`, else the pile (within `reach.pile` of the
 * stand), else a rival's home it stands in (one with boxes in it). Never its own home, never a
 * box still in the air. The server's rule; clients only use it to show the hint.
 */
export function reachAt(p: { x: number; z: number }, slot: number, state: ReachState, t: number): GiftReach | null {
  let loose: { id: number } | null = null,
    near = Infinity;
  for (const box of state.boxes) {
    if (box.land > t) continue;
    const d = Math.hypot(p.x - box.x, p.z - box.z);
    if (d <= GIFT.reach.loose && d < near) {
      loose = box;
      near = d;
    }
  }
  if (loose) return { kind: "loose", target: loose.id, distance: near };
  const middle = Math.hypot(p.x, p.z);
  if (state.pile > 0 && middle - GIFT.pedestal.radius <= GIFT.reach.pile) return { kind: "pile", target: 0, distance: middle };
  for (const [seat, owner] of state.seats.entries()) {
    if (owner === slot || state.home[owner] <= 0) continue;
    const c = homeCenter(state.players, seat),
      d = Math.hypot(p.x - c.x, p.z - c.z);
    if (d <= GIFT.homes.radius) return { kind: "steal", target: owner, distance: d };
  }
  return null;
}
