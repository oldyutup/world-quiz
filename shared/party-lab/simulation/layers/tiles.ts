import RAPIER from "@dimforge/rapier3d-compat";
import { ARENA_FRICTION } from "../../maps/types.js";
import { HEX, LAYER_TILES, hexCorner, type LayerTile } from "../../maps/layers.js";
import { TileTimeline } from "./timeline.js";

export {
  TILE_STAGES,
  collapseArmTick,
  collapseWarnTick,
  type ArmSource,
  type TileStage,
  type TileView,
} from "./timeline.js";

/** Where a GONE tile's collider waits (disabled) until the next round. */
const PARKED_Y = -1000;
/** Twelve corners of a hexagonal prism: the walking surface at y = 0, the underside `thickness` below. */
function prismPoints() {
  const points: number[] = [];
  for (const y of [0, -HEX.thickness])
    for (let k = 0; k < 6; k++) {
      const c = hexCorner(k);
      points.push(c.x, y, c.z);
    }
  return new Float32Array(points);
}

/** Where a hex tile sits: its centre and walking surface (Katman Kaosu's and Renk Kaosu's tiles). */
export type HexSlot = Pick<LayerTile, "x" | "z" | "top">;

/** One static convex prism collider per tile, flush with its neighbours (no gap). */
export function createTileColliders(world: RAPIER.World, tiles: readonly HexSlot[] = LAYER_TILES) {
  const hull = prismPoints();
  return tiles.map((tile) => {
    const desc = RAPIER.ColliderDesc.convexHull(hull);
    if (!desc) throw new Error("Invalid tile collider");
    desc.setTranslation(tile.x, tile.top, tile.z).setFriction(ARENA_FRICTION);
    return world.createCollider(desc);
  });
}
/**
 * A GONE tile's collider: disabled and parked out of the way. A disabled collider still
 * answers ray queries until the next world step; parked, it does not — so the
 * controller's support ray is exact on the tick it goes.
 */
export function parkTileCollider(collider: RAPIER.Collider, tile: HexSlot) {
  collider.setEnabled(false);
  collider.setTranslation({ x: tile.x, y: PARKED_Y, z: tile.z });
}
/**
 * Back in place and enabled. Ray queries only see it again after the next world step
 * (Rapier updates its query structure while stepping).
 */
export function restoreTileCollider(collider: RAPIER.Collider, tile: HexSlot) {
  collider.setTranslation({ x: tile.x, y: tile.top, z: tile.z });
  collider.setEnabled(true);
}

/**
 * Katman Kaosu's 297 tiles as gameplay state (`TileTimeline`) with one static convex
 * prism collider each. At its `goneTick` the collider is disabled and parked out of the
 * way — before that tick's physics step, so nothing stands on it any more, and queries
 * made before the next step (the controller's support ray) no longer see it either. No
 * rigid body is ever created for a broken tile; the falling piece is presentation only.
 */
export class TileField extends TileTimeline {
  readonly colliders: RAPIER.Collider[];
  private readonly byHandle = new Map<number, number>();

  constructor(world: RAPIER.World) {
    super();
    this.colliders = createTileColliders(world);
    this.colliders.forEach((collider, id) => this.byHandle.set(collider.handle, id));
  }
  /** Tile id of a collider (undefined: not a tile). */
  tileOf(collider: RAPIER.Collider) {
    return this.byHandle.get(collider.handle);
  }
  /** Every tile back, untouched (round reset). */
  override reset() {
    for (const tile of this.tiles) if (this.gone[tile.id]) restoreTileCollider(this.colliders[tile.id], tile);
    super.reset();
  }
  protected override vanish(id: number) {
    super.vanish(id);
    parkTileCollider(this.colliders[id], this.tiles[id]);
  }
}
