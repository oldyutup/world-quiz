import type { Character } from "./ragdoll/character.js";
import type { Punch } from "./combat/punch.js";
import { PARTS } from "./ragdoll/config.js";
import {
  BARN_PREDICTION_BYTES,
  BARN_PREDICTION_FIELDS,
  VELOCITY_BYTES,
  type PredictionState,
} from "../network/protocol.js";
import { weaponCode, type BarnFighter } from "./barn/combat.js";

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

/** Barn: velocities plus the character's controller state and the own fighter's timers/weapon (Float64). */
export function captureBarnPredictionState(character: Character, fighter: BarnFighter): PredictionState {
  const { velocities } = capturePredictionState(character, { nextPunchHand: 0, alternateIn: 0, punches: [] });
  const barn = new Uint8Array(BARN_PREDICTION_BYTES),
    view = new DataView(barn.buffer);
  const w = fighter.weapon;
  const values: Record<(typeof BARN_PREDICTION_FIELDS)[number], number> = {
    facing: character.facing,
    gait: character.gait,
    jumpIn: character.jumpIn,
    sprint: character.sprint,
    anchored: character.anchored ? 1 : 0,
    anchorX: character.anchorX,
    anchorZ: character.anchorZ,
    alive: fighter.alive ? 1 : 0,
    punchHand: fighter.punchHand,
    punchCooldown: fighter.punchCooldown,
    punchAge: fighter.punch.age,
    punchSwingCooldown: fighter.punch.cooldown,
    trapped: fighter.trapped,
    staggerTime: fighter.stagger.time,
    staggerPosture: fighter.stagger.posture,
    staggerMobility: fighter.stagger.mobility,
    protection: fighter.protection,
    weapon: w ? weaponCode(w.kind) : 0,
    ammo: w?.ammo ?? 0,
    weaponCooldown: w?.cooldown ?? 0,
    bloom: w?.bloom ?? 0,
    aimPitch: fighter.aimPitch,
  };
  BARN_PREDICTION_FIELDS.forEach((name, i) => view.setFloat64(i * 8, values[name], true));
  return { slot: character.id, velocities, controller: [], barn };
}
/** Reads a barn prediction section back into named numbers (null if malformed). */
export function readBarnPredictionState(bytes: unknown): Record<(typeof BARN_PREDICTION_FIELDS)[number], number> | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== BARN_PREDICTION_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {} as Record<(typeof BARN_PREDICTION_FIELDS)[number], number>;
  for (let i = 0; i < BARN_PREDICTION_FIELDS.length; i++) {
    const v = view.getFloat64(i * 8, true);
    if (!Number.isFinite(v)) return null;
    out[BARN_PREDICTION_FIELDS[i]] = v;
  }
  return out;
}
