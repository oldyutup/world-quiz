import type { ActionIntent } from "../../input/actions";
import type { MovementInput } from "../../input/types";
import { LAYER_INDICES, LAYER_TOPS, tileAt, type LayerTile } from "../../../../shared/party-lab/maps/layers";
import type { TileView } from "../../../../shared/party-lab/simulation/layers/timeline";
import type { LandingMarker } from "./tileVisuals";

/**
 * Katman Kaosu meaning of the shared bindings: WASD relative to the camera yaw (x is the
 * strafe axis, z the device's back axis, as everywhere), Punch pushes, Lift (Shift) is
 * sprint, Jump jumps. No aim facing — the body turns toward where it walks — and no
 * grab or lift gameplay; saved controls need no new actions.
 */
export function layerIntent(raw: ActionIntent, yaw: number): MovementInput {
  const forward = -raw.z,
    rightX = -Math.cos(yaw),
    rightZ = Math.sin(yaw);
  return {
    x: Math.sin(yaw) * forward + rightX * raw.x,
    z: Math.cos(yaw) * forward + rightZ * raw.x,
    jump: raw.jump,
    punch: raw.punch,
    sprint: raw.lift,
  };
}

/** Feedback starts once the drop to the next surface is more than a hop. */
const MARKER_MIN_HEIGHT = 1.4;
/**
 * The landing indicator for a pelvis at (x, y, z) moving vertically at `vy`: while
 * falling between layers (`falling`, fall.ts), the first intact tile straight below;
 * with none, a red marker on the next layer's plane below (or the haze, below the last
 * layer). Nothing in normal play (jumps included), while rising or within a hop of the
 * surface.
 */
export function landingMarker(field: TileView, falling: boolean, x: number, y: number, z: number, vy: number): LandingMarker {
  if (!falling) return { kind: "none" };
  let below: LayerTile | null = null;
  for (const layer of LAYER_INDICES) {
    if (LAYER_TOPS[layer] > y - 0.25) continue;
    const tile = tileAt(layer, x, z);
    if (tile && field.intact(tile.id)) {
      below = tile;
      break;
    }
  }
  if (vy > -1 || (below && y - below.top < MARKER_MIN_HEIGHT)) return { kind: "none" };
  if (below) return { kind: "safe", tile: below.id, x, z };
  const plane = LAYER_INDICES.map((layer) => LAYER_TOPS[layer]).find((top) => top < y - 0.9);
  return { kind: "danger", x, y: plane ?? -4.5, z };
}
