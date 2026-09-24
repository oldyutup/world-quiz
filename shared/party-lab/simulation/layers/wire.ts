import { LAYER_TILES } from "../../maps/layers.js";
import { LAYER_FLAG, LAYER_RESULTS, type LayerSnapshot } from "../../network/protocol.js";
import { PLAYERS } from "../players.js";
import { breakTicks } from "./config.js";
import type { LayerResult } from "./round.js";
import { armedProgress, armedStage, COLLAPSE_AT, type TileStage, type TileTimeline, type TileView } from "./timeline.js";

const TILE_COUNT = LAYER_TILES.length;
/** GONE bitset size: 297 tiles → 38 bytes. */
export const LAYER_GONE_BYTES = Math.ceil(TILE_COUNT / 8);
/** Bytes per armed tile in `LayerSnapshot.a`: id (uint16 LE) + age. */
export const LAYER_ARMED_STRIDE = 3;

/** The tile part of a snapshot section: GONE bitset and armed tiles with their age at round tick `t`. */
export function encodeTiles(field: TileTimeline, t: number): Pick<LayerSnapshot, "g" | "a"> {
  const g = new Uint8Array(LAYER_GONE_BYTES);
  let armed = 0;
  for (let id = 0; id < TILE_COUNT; id++) {
    if (field.gone[id]) g[id >> 3] |= 1 << (id & 7);
    else if (field.armTick[id] >= 0) armed++;
  }
  const a = new Uint8Array(armed * LAYER_ARMED_STRIDE);
  let o = 0;
  for (let id = 0; id < TILE_COUNT; id++) {
    if (field.gone[id] || field.armTick[id] < 0) continue;
    a[o] = id & 0xff;
    a[o + 1] = id >> 8;
    a[o + 2] = Math.max(0, Math.min(255, t - field.armTick[id]));
    o += LAYER_ARMED_STRIDE;
  }
  return { g, a };
}

export interface DecodedLayers {
  /** Round tick of the section (see LayerSnapshot.t). */
  t: number;
  /** 1 per GONE tile. */
  gone: Uint8Array;
  /** Arm tick of every armed, not yet GONE tile (−1 otherwise). */
  armTick: Int32Array;
  /** LAYER_FLAG bits per slot. */
  flags: number[];
  /** Round tick each slot was eliminated on (−1: not). */
  outAt: number[];
  result: LayerResult | "forfeit" | null;
}
const smallInt = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
/** Validated section (null: malformed). Never trusts lengths, ids or ranges. */
export function decodeLayerSnapshot(value: unknown): DecodedLayers | null {
  if (!value || typeof value !== "object") return null;
  const s = value as LayerSnapshot;
  if (!smallInt(s.t, 0, 1e7) || !(s.g instanceof Uint8Array) || s.g.byteLength !== LAYER_GONE_BYTES) return null;
  if (!(s.a instanceof Uint8Array) || s.a.byteLength % LAYER_ARMED_STRIDE !== 0 || s.a.byteLength > TILE_COUNT * LAYER_ARMED_STRIDE) return null;
  if (!Array.isArray(s.f) || s.f.length !== PLAYERS.length || !s.f.every((v) => smallInt(v, 0, 255))) return null;
  if (!Array.isArray(s.o) || s.o.length !== PLAYERS.length || !s.o.every((v) => smallInt(v, -1, 1e7))) return null;
  if (!smallInt(s.r, 0, LAYER_RESULTS.length - 1)) return null;
  const gone = new Uint8Array(TILE_COUNT);
  for (let id = 0; id < TILE_COUNT; id++) gone[id] = (s.g[id >> 3] >> (id & 7)) & 1;
  const armTick = new Int32Array(TILE_COUNT).fill(-1);
  for (let o = 0; o < s.a.byteLength; o += LAYER_ARMED_STRIDE) {
    const id = s.a[o] | (s.a[o + 1] << 8);
    if (id >= TILE_COUNT || gone[id] || armTick[id] >= 0) return null;
    armTick[id] = s.t - s.a[o + 2];
  }
  return { t: s.t, gone, armTick, flags: [...s.f], outAt: [...s.o], result: LAYER_RESULTS[s.r] };
}
export const layerFlag = (d: DecodedLayers | null, slot: number, flag: number) => !!d && slot >= 0 && !!(d.flags[slot] & flag);
export { LAYER_FLAG };

/**
 * What an online client knows about the tile field, from the snapshots of this round,
 * as a `TileView` on any round tick: the remote timeline (a little in the past), the
 * own predicted one (a little in the future) or the snapshot's own. Every snapshot
 * carries the complete state, so nothing is ever missed; arm ticks seen on the way are
 * kept so a tile that went GONE shows its last stages on a timeline behind the newest
 * snapshot. A tile first seen GONE (a reconnect) is GONE for every tick. Untouched tiles
 * follow the fixed collapse schedule, exactly as the server arms them.
 */
export class LayerTileKnowledge implements TileView {
  readonly tiles = LAYER_TILES;
  readonly armTick = new Int32Array(TILE_COUNT).fill(-1);
  readonly goneSeen = new Uint8Array(TILE_COUNT);
  round = -1;
  /** Round tick of the newest section applied. */
  latest = -1;
  /** The round tick `intact()` answers for (the view sets it each frame). */
  viewTick = 0;
  reset(round = -1) {
    this.armTick.fill(-1);
    this.goneSeen.fill(0);
    this.round = round;
    this.latest = -1;
    this.viewTick = 0;
  }
  /** A newer snapshot of `round` (older or equal ticks change nothing). */
  apply(round: number, d: DecodedLayers) {
    if (round !== this.round) this.reset(round);
    if (d.t < this.latest) return false;
    this.latest = d.t;
    for (let id = 0; id < TILE_COUNT; id++) {
      if (d.gone[id]) this.goneSeen[id] = 1;
      else if (d.armTick[id] >= 0) this.armTick[id] = d.armTick[id];
      else if (!this.goneSeen[id]) this.armTick[id] = -1;
    }
    return true;
  }
  /** Round tick from which the tile is GONE (−∞: GONE with its history unknown). */
  goneTick(id: number) {
    const armed = this.armTick[id];
    if (armed >= 0) return armed + breakTicks(armed);
    if (this.goneSeen[id]) return -Infinity;
    const c = COLLAPSE_AT[id];
    return c + breakTicks(c);
  }
  intact(id: number) {
    return this.viewTick < this.goneTick(id);
  }
  stage(id: number, roundTick: number): TileStage {
    const gone = this.goneTick(id);
    if (roundTick >= gone) return "gone";
    const armed = this.armTick[id],
      c = COLLAPSE_AT[id];
    if (armed >= 0 && roundTick >= armed) return armedStage(armed, gone, c, roundTick);
    if (armed < 0 && roundTick >= c) return armedStage(c, gone, c, roundTick);
    return armedStage(-1, -1, c, roundTick);
  }
  progress(id: number, roundTick: number) {
    const armed = this.armTick[id];
    if (armed >= 0) return armedProgress(armed, this.goneTick(id), roundTick);
    const c = COLLAPSE_AT[id];
    return roundTick >= c && !this.goneSeen[id] ? armedProgress(c, this.goneTick(id), roundTick) : 0;
  }
  counts(roundTick: number) {
    const out: Record<TileStage, number> = { solid: 0, marked: 0, warn: 0, crack: 0, break: 0, gone: 0 };
    for (const tile of this.tiles) out[this.stage(tile.id, roundTick)]++;
    return out;
  }
}
