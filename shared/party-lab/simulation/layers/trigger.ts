import RAPIER from "@dimforge/rapier3d-compat";
import type { Character } from "../ragdoll/character.js";
import { RAGDOLL, SHAPES } from "../ragdoll/config.js";
import { add, rotate, type Vec } from "../ragdoll/math.js";
import { LAYER_CHAOS } from "./config.js";
import type { TileField } from "./tiles.js";

const DOWN = { x: 0, y: -1, z: 0 };
export type SupportVia = "hips" | "feet";
export interface TileSupport {
  tile: number;
  via: SupportVia;
}

/**
 * The tile supporting a character, which is the tile it arms:
 *
 * 1. Hips: the tile straight below the pelvis within `RAGDOLL.supportRange` — the same
 *    ray (static, walkable normal) the controller's stand-up support uses, so a tile
 *    arms exactly when it starts carrying the body, landing included.
 * 2. Feet (fallback, only when the hips find nothing): a toe ray from either leg, the
 *    controller's `grounded` probe — a body standing at a tile's edge with its pelvis
 *    over a hole.
 *
 * Nothing else arms: hands, arms, head and a torso brushing a tile's side are never
 * probed. Not while rising in a jump (jump cooldown or the pelvis moving up faster than
 * `trigger.maxRiseSpeed`), so a jump arcing over a tile leaves it alone. Eliminated
 * bodies never arm; the caller also skips countdown and results.
 */
export function supportingTile(world: RAPIER.World, character: Character, field: TileField): TileSupport | null {
  if (character.eliminated || character.jumpIn > 0 || character.body.linvel().y >= LAYER_CHAOS.trigger.maxRiseSpeed) return null;
  const tileBelow = (from: Vec, range: number) => {
    const hit = world.castRayAndGetNormal(
      new RAPIER.Ray(from, DOWN),
      range,
      false,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
      undefined,
      undefined,
      undefined,
      (collider) => collider.isEnabled() && field.tileOf(collider) !== undefined
    );
    return hit && hit.normal.y > 0.65 ? field.tileOf(hit.collider) ?? null : null;
  };
  const hips = tileBelow(character.body.translation(), RAGDOLL.supportRange);
  if (hips !== null) return { tile: hips, via: "hips" };
  for (const name of ["leftLeg", "rightLeg"] as const) {
    const part = character.parts[name],
      shape = SHAPES[name],
      toe = add(part.body.translation(), rotate(part.body.rotation(), { x: 0, y: -shape.half, z: 0 }));
    const feet = tileBelow(toe, shape.radius + RAGDOLL.groundMargin);
    if (feet !== null) return { tile: feet, via: "feet" };
  }
  return null;
}
