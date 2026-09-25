import type RAPIER from "@dimforge/rapier3d-compat";
import type { Character } from "../../../../shared/party-lab/simulation/ragdoll/character";
import { PARTS, RAGDOLL } from "../../../../shared/party-lab/simulation/ragdoll/config";

/**
 * Rapier 0.20: a tile collider that comes back (re-enabled, moved into place) is invisible
 * to ray queries until the next world step. A prediction rig that brings tiles back on a
 * restore takes that step now — with timestep 0 and its body switched off, because a
 * solver pass with no time step over the jointed body throws it around (158 m/s measured);
 * the caller restores the body from the snapshot right after (Katman Kaosu and Renk Kaosu).
 */
export function refreshTileQueries(world: RAPIER.World, character: Character) {
  for (const name of PARTS) character.parts[name].body.setEnabled(false);
  world.timestep = 0;
  world.step();
  world.timestep = RAGDOLL.step;
}
