import { LAYER_OUTER_RING, LAYER_TILES, type LayerTile } from "../../maps/layers.js";
import { breakTicks, LAYER_CHAOS, LAYER_TICKS } from "./config.js";

/**
 * SOLID → WARN → CRACK → BREAK → GONE, plus MARKED: an untouched tile inside the
 * collapse warning (still SOLID for gameplay, armed when the warning ends).
 */
export type TileStage = "solid" | "marked" | "warn" | "crack" | "break" | "gone";
export const TILE_STAGES: readonly TileStage[] = ["solid", "marked", "warn", "crack", "break", "gone"];
export type ArmSource = "player" | "collapse";

/** Round tick at which an untouched tile is armed by the collapse wave. */
export function collapseArmTick(tile: LayerTile) {
  return LAYER_TICKS.layerStarts[tile.layer] + (LAYER_OUTER_RING[tile.layer] - tile.ring) * LAYER_TICKS.ringInterval + LAYER_TICKS.warning;
}
/** Round tick at which the collapse warning (MARKED) starts. */
export const collapseWarnTick = (tile: LayerTile) => collapseArmTick(tile) - LAYER_TICKS.warning;
/** Collapse arm tick per tile id (fixed by the layout). */
export const COLLAPSE_AT: Readonly<Int32Array> = Int32Array.from(LAYER_TILES, collapseArmTick);

/** Stage of a tile armed on `armTick` (−1: untouched) at a (possibly fractional) round tick, not yet GONE. */
export function armedStage(armTick: number, goneTick: number, collapseAt: number, roundTick: number): TileStage {
  if (armTick >= 0) {
    const f = armedProgress(armTick, goneTick, roundTick);
    return f < LAYER_CHAOS.stages.crack ? "warn" : f < LAYER_CHAOS.stages.break ? "crack" : "break";
  }
  return roundTick >= collapseAt - LAYER_TICKS.warning ? "marked" : "solid";
}
/** Share of an armed tile's duration elapsed at a round tick (0 untouched). */
export function armedProgress(armTick: number, goneTick: number, roundTick: number) {
  if (armTick < 0) return 0;
  return Math.min(1, Math.max(0, (roundTick - armTick) / (goneTick - armTick)));
}

/**
 * Read-only view of the tile field for presentation and the camera: whether a tile is
 * standing now, and its stage/progress at a round tick. The authoritative field
 * (`TileField`) and the online client's derived state (`LayerTileKnowledge`) both
 * provide it, so the visuals, camera and fall rules never touch physics.
 */
export interface TileView {
  readonly tiles: readonly LayerTile[];
  intact(id: number): boolean;
  stage(id: number, roundTick: number): TileStage;
  progress(id: number, roundTick: number): number;
}

/**
 * Katman Kaosu's tile rules as pure state, in whole round ticks: a tile's duration is
 * fixed when it first arms and never changes (a second player on it changes nothing),
 * the collapse arms untouched tiles on its fixed schedule, and a tile is GONE from its
 * `goneTick`. No physics here: `TileField` adds one collider per tile on top.
 */
export class TileTimeline implements TileView {
  readonly tiles = LAYER_TILES;
  /** Round tick the tile armed on (−1: untouched). */
  readonly armTick = new Int32Array(LAYER_TILES.length).fill(-1);
  /** Round tick the tile disappears (−1: not armed). */
  readonly goneTick = new Int32Array(LAYER_TILES.length).fill(-1);
  /** 0 untouched, 1 armed by a player, 2 armed by the collapse. */
  readonly armedBy = new Uint8Array(LAYER_TILES.length);
  /** 1 once GONE. */
  readonly gone = new Uint8Array(LAYER_TILES.length);
  /** Collapse schedule (round ticks), fixed per tile. */
  readonly collapseAt = Int32Array.from(COLLAPSE_AT);
  /** Tiles that went GONE on the last `advance` of this tick (presentation, tests). */
  readonly vanished: number[] = [];
  readonly stats = { armedByPlayers: 0, armedByCollapse: 0, gone: 0 };

  intact(id: number) {
    return this.gone[id] === 0;
  }
  /** Every tile back, untouched (round reset). */
  reset() {
    this.armTick.fill(-1);
    this.goneTick.fill(-1);
    this.armedBy.fill(0);
    this.vanished.length = 0;
    this.stats.armedByPlayers = this.stats.armedByCollapse = this.stats.gone = 0;
    this.gone.fill(0);
  }
  /**
   * Arm a tile on this round tick. Only the first arming counts: an armed or GONE tile
   * keeps its timer (false). The duration follows the round clock at this moment.
   */
  arm(id: number, roundTick: number, source: ArmSource = "player") {
    if (this.armTick[id] >= 0 || this.gone[id]) return false;
    this.armTick[id] = roundTick;
    this.goneTick[id] = roundTick + breakTicks(roundTick);
    this.armedBy[id] = source === "player" ? 1 : 2;
    if (source === "player") this.stats.armedByPlayers++;
    else this.stats.armedByCollapse++;
    return true;
  }
  /**
   * Start of a playing tick, before physics: the collapse arms its untouched tiles
   * due now, then every tile whose goneTick has come disappears.
   */
  advance(roundTick: number) {
    this.vanished.length = 0;
    for (const tile of this.tiles) {
      const id = tile.id;
      if (this.gone[id]) continue;
      if (this.armTick[id] < 0 && roundTick >= this.collapseAt[id]) this.arm(id, roundTick, "collapse");
      if (this.armTick[id] >= 0 && roundTick >= this.goneTick[id]) this.vanish(id);
    }
    return this.vanished;
  }
  protected vanish(id: number) {
    this.gone[id] = 1;
    this.stats.gone++;
    this.vanished.push(id);
  }
  /** Force a tile out (tests and layout checks): GONE now, untouched history. */
  remove(id: number) {
    if (!this.gone[id]) this.vanish(id);
  }
  /**
   * Stage at a (possibly fractional) round tick. Stages split the fixed duration:
   * WARN [0, 31%), CRACK [31%, 69%), BREAK [69%, 100%), GONE at goneTick.
   */
  stage(id: number, roundTick: number): TileStage {
    if (this.gone[id]) return "gone";
    return armedStage(this.armTick[id], this.goneTick[id], this.collapseAt[id], roundTick);
  }
  /** Share of an armed tile's duration elapsed (0 untouched). */
  progress(id: number, roundTick: number) {
    return armedProgress(this.armTick[id], this.goneTick[id], roundTick);
  }
  counts(roundTick: number) {
    const out: Record<TileStage, number> = { solid: 0, marked: 0, warn: 0, crack: 0, break: 0, gone: 0 };
    for (const tile of this.tiles) out[this.stage(tile.id, roundTick)]++;
    return out;
  }
  /** Tiles still standing (one enabled collider each in a `TileField`). */
  get enabledColliders() {
    return this.tiles.length - this.stats.gone;
  }
}
