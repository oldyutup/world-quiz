import type { Character } from "./ragdoll/character.js";
import type { Punch } from "./combat/punch.js";
import { PARTS } from "./ragdoll/config.js";
import { VELOCITY_BYTES, type PredictionState } from "../network/protocol.js";

export function capturePredictionState(
  character: Character,
  combat: { nextPunchHand: number; alternateIn: number; punches: Punch[] }
): PredictionState {
  const velocities = new Uint8Array(VELOCITY_BYTES),
    view = new DataView(velocities.buffer);
  let offset = 0;
  for (const name of PARTS) {
    const body = character.parts[name].body;
    for (const v of [body.linvel(), body.angvel()])
      for (const n of [v.x, v.y, v.z]) {
        view.setFloat32(offset, n, true);
        offset += 4;
      }
  }
  return {
    slot: character.id,
    velocities,
    controller: [
      character.facing,
      character.gait,
      character.jumpIn,
      combat.nextPunchHand,
      combat.alternateIn,
      ...combat.punches.flatMap((p) => [p.age, p.cooldown]),
    ],
  };
}
