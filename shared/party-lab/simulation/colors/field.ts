import type RAPIER from "@dimforge/rapier3d-compat";
import { COLOR_TILES } from "../../maps/colors.js";
import { createTileColliders, parkTileCollider, restoreTileCollider } from "../layers/tiles.js";

/**
 * Renk Kaosu's 85 tiles as physics: one static convex prism per tile (Katman Kaosu's
 * hull, flush, 0.5 m deep). A dropped tile's collider is disabled and parked 1000 m
 * down, so the controller's support ray is exact on the drop tick too; restoring puts
 * it back and enables it. No rigid body is ever created for a tile — the drop is
 * presentation only.
 *
 * Rapier: a collider that is re-enabled or moved back only answers ray queries after
 * the next world step. On a restore tick the returning tiles are holes that nobody
 * stands on, and contacts see them in that tick's step, so nothing waits on it.
 */
export class ColorTileField {
  readonly tiles = COLOR_TILES;
  readonly colliders: RAPIER.Collider[];
  /** 1 while a tile is dropped. */
  readonly gone = new Uint8Array(COLOR_TILES.length);
  private readonly byHandle = new Map<number, number>();
  constructor(world: RAPIER.World) {
    this.colliders = createTileColliders(world, COLOR_TILES);
    this.colliders.forEach((collider, id) => this.byHandle.set(collider.handle, id));
  }
  intact(id: number) {
    return this.gone[id] === 0;
  }
  /** Tile id of a collider (undefined: not a tile). */
  tileOf(collider: RAPIER.Collider) {
    return this.byHandle.get(collider.handle);
  }
  drop(ids: readonly number[]) {
    for (const id of ids)
      if (!this.gone[id]) {
        this.gone[id] = 1;
        parkTileCollider(this.colliders[id], this.tiles[id]);
      }
  }
  /**
   * Every dropped tile back — or, with `present` (the shrink), only the tiles it marks:
   * the others stay down for good (disabled, parked).
   */
  restore(present?: Uint8Array) {
    for (const tile of this.tiles)
      if (this.gone[tile.id] && (!present || present[tile.id])) {
        this.gone[tile.id] = 0;
        restoreTileCollider(this.colliders[tile.id], tile);
      }
  }
  /** Tiles standing (one enabled collider each). */
  get enabledColliders() {
    let n = 0;
    for (const g of this.gone) if (!g) n++;
    return n;
  }
}
