import { COLOR_TILE_COUNT, COLOR_TILES, colorTileAtCell } from "../../maps/colors.js";
import { HEX_DIRECTIONS } from "../../maps/layers.js";
import { COLOR_CHAOS } from "./config.js";

/**
 * Daralma (shrink) as pure data. Stage 0 is the whole field; stage k (1…8) colours only
 * the tiles `COLOR_CHAOS.shrink[k − 1].keep` names, from its `cut` cycle on (in that
 * cycle the tiles it drops stand grey; from the next one they are gone). Stages 1–6 are
 * discs of tile centres, so they keep all twelve symmetries of the field (a layout of such
 * a stage can be shown through any of them); stage 7 ("four") is the middle tile and every
 * other tile around it — one tile per colour, each ≤ 2 steps from the others.
 */
export const SHRINK_STAGES = COLOR_CHAOS.shrink;
/** Stage count including the whole field (0) and the final "no tile" stage. */
export const SHRINK_STAGE_COUNT = SHRINK_STAGES.length + 1;

/** Stage whose colours cycle `index` (1-based) shows: the stages cut by then. */
export function shrinkStage(index: number) {
  let stage = 0;
  for (const { cut } of SHRINK_STAGES) if (cut <= index) stage++;
  return stage;
}
/** The middle tile (ring 0). */
export const HUB_TILE = COLOR_TILES.findIndex((t) => t.ring === 0);
/** The last field ("four"): the middle tile and the ring-1 tiles toward directions 0, 2, 4. */
export const FOUR_TILES: readonly number[] = [HUB_TILE, ...[0, 2, 4].map((k) => colorTileAtCell(HEX_DIRECTIONS[k])!.id)];

function stageMask(stage: number) {
  const keep = stage === 0 ? Infinity : SHRINK_STAGES[stage - 1].keep;
  if (keep === "four") return Uint8Array.from(COLOR_TILES, (t) => (FOUR_TILES.includes(t.id) ? 1 : 0));
  return Uint8Array.from(COLOR_TILES, (t) => (Math.hypot(t.x, t.z) <= keep + 1e-6 ? 1 : 0));
}
/** 1 for the tiles a stage keeps (index = tile id). */
export const STAGE_MASKS: readonly Uint8Array[] = Array.from({ length: SHRINK_STAGE_COUNT }, (_, stage) => stageMask(stage));
/** Tiles each stage keeps: 85, 73, 61, 43, 31, 19, 7, 4, 0. */
export const STAGE_SIZES: readonly number[] = STAGE_MASKS.map((mask) => mask.reduce((n, m) => n + m, 0));

/** First cycle of the shrink: the first rim is marked ("DARALIYOR!"). */
export const SHRINK_START_CYCLE = SHRINK_STAGES[0].cut - 1;
/** The cycle whose drop takes the last tile away (no colour left: the final drop). */
export const FINAL_CYCLE = SHRINK_STAGES[SHRINK_STAGES.length - 1].cut;

/**
 * How deep a tile sits inside a stage: 0 on the stage's edge (a neighbour it keeps is
 * missing, or the field ends), 1 one step in, … — tiles the stage drops get −1. Bots use
 * it to stay off the crumbling edge.
 */
export function stageDepth(stage: number, neighbours: readonly (readonly number[])[]): Int8Array {
  const mask = STAGE_MASKS[stage],
    depth = new Int8Array(COLOR_TILE_COUNT).fill(-1),
    queue: number[] = [];
  for (let id = 0; id < COLOR_TILE_COUNT; id++) {
    if (!mask[id]) continue;
    const onEdge = neighbours[id].length < 6 || neighbours[id].some((n) => !mask[n]);
    if (onEdge) {
      depth[id] = 0;
      queue.push(id);
    }
  }
  for (let i = 0; i < queue.length; i++)
    for (const n of neighbours[queue[i]])
      if (mask[n] && depth[n] < 0) {
        depth[n] = depth[queue[i]] + 1;
        queue.push(n);
      }
  return depth;
}
