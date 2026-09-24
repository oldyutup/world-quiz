import { LAYER_TOPS, layerBelow } from "../../../../shared/party-lab/maps/layers";
import type { TileView } from "../../../../shared/party-lab/simulation/layers/timeline";
import { intactTileNear } from "./layerCamera";

/**
 * What tells a real fall between layers from a jump, for the camera and the landing
 * marker (physics is the same either way). Measured with the shared ragdoll
 * (layers.test.ts): standing, the pelvis is ≈ 0.78 m over its layer's surface; a jump
 * (standing, walking, sprinting, over one or two missing tiles) lifts it to ≈ 1.74 m,
 * comes down at up to ≈ 6.6 m/s and lands back on the same layer. Being airborne,
 * descending fast and having no tile under the hips are all part of a jump too.
 *
 * A body falls between layers while descending when:
 * - its pelvis is further above the layer surface below it than any jump reaches
 *   (it has dropped past the layer it stood on, or is under the last layer); or
 * - it is below standing height over a hole, with no intact tile of that layer near
 *   enough to catch it: a body that comes up short of a gap can still catch the far
 *   tile's edge and climb up from lower than that (≤ 0.45 m away, measured).
 *
 * The fall ends when the body stops descending near a layer, which becomes its ground.
 */
export const LAYER_FALL = {
  /** Descending faster than this (m/s). */
  descend: 1,
  /** Pelvis this far above the layer surface below it (m): higher than a jump's apex. */
  clear: 2.2,
  /** Pelvis this low over a hole (m, standing ≈ 0.78) … */
  sink: 0.6,
  /** … with no intact tile of that layer within this distance (m). */
  ledge: 0.5,
  /** A fall ends once the body descends slower than this (m/s) within `clear` of a layer. */
  rest: 0.5,
  /** Standing pelvis height over the walking surface (m). */
  stand: 0.78,
} as const;

/** One character's state: normal play (jumps included) or falling between layers. Update once per physics tick. */
export class LayerFall {
  falling = false;
  /** Walking surface of the layer the body stands on (or last stood on, while falling). */
  ground: number = LAYER_TOPS[0];
  /** Pelvis height when standing on the ground layer. */
  get stance() {
    return this.ground + LAYER_FALL.stand;
  }
  /** A body standing (or spawned) with its pelvis at `y`. */
  reset(y: number) {
    const plane = layerBelow(y);
    this.falling = plane === -1;
    this.ground = LAYER_TOPS[plane === -1 ? 3 : plane];
  }
  /** The pelvis at (x, y, z) moving vertically at `vy`; returns whether it is falling between layers. */
  update(field: TileView, x: number, y: number, z: number, vy: number) {
    const plane = layerBelow(y);
    if (plane === -1) return (this.falling = true);
    const height = y - LAYER_TOPS[plane];
    if (!this.falling)
      this.falling =
        vy < -LAYER_FALL.descend &&
        (height > LAYER_FALL.clear || (height < LAYER_FALL.sink && !intactTileNear(field, plane, x, z, LAYER_FALL.ledge)));
    else if (vy > -LAYER_FALL.rest && height < LAYER_FALL.clear) {
      this.falling = false;
      this.ground = LAYER_TOPS[plane];
    }
    return this.falling;
  }
}
