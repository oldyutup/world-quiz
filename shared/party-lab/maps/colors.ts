import { HEX, HEX_DIRECTIONS, hexAt, hexCenter, hexDistance, type HexCoord } from "./layers.js";
import type { ArenaMap, Vec3 } from "./types.js";

/**
 * Renk Kaosu ("colour chaos", local only for now): one floating field of flush hex
 * tiles. Each cycle the tiles get colours and a target colour is announced; when the
 * reaction timer runs out every tile of another colour drops for a moment. The hex
 * grid (2.0 m flat to flat, axial q/r, corners along ±z) is Katman Kaosu's (layers.ts).
 *
 * The field is L1 "Taç" of Katman Kaosu on its own: every cell whose centre is within
 * 9.2 m of the middle, 85 tiles, Ø ≈ 20.7 m, walking surface at y = 0.
 */
export const COLOR_ARENA_RADIUS = 9.2;
export const COLOR_TILE_TOP = 0;

export interface ColorTile extends HexCoord {
  /** Index into COLOR_TILES. */
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Walking surface height. */
  readonly top: number;
  /** Hex distance from the middle (0 hub … 5 rim). */
  readonly ring: number;
}

const key = (t: HexCoord) => `${t.q},${t.r}`;
function cells(): HexCoord[] {
  const out: HexCoord[] = [];
  for (let r = -6; r <= 6; r++)
    for (let q = -6; q <= 6; q++) {
      if (Math.abs(q + r) > 6) continue;
      const c = hexCenter({ q, r });
      if (Math.hypot(c.x, c.z) <= COLOR_ARENA_RADIUS + 1e-6) out.push({ q, r });
    }
  return out;
}

export const COLOR_TILES: readonly ColorTile[] = cells().map((cell, id) => ({
  ...cell,
  id,
  ...hexCenter(cell),
  top: COLOR_TILE_TOP,
  ring: hexDistance(cell),
}));
export const COLOR_TILE_COUNT = COLOR_TILES.length;
const LOOKUP = new Map(COLOR_TILES.map((t) => [key(t), t]));
/** The tile at hex cell (q, r), if the field has one there. */
export const colorTileAtCell = (cell: HexCoord) => LOOKUP.get(key(cell));
/** The tile whose top contains the floor point (x, z), if any (gone or not). */
export const colorTileAt = (x: number, z: number) => colorTileAtCell(hexAt(x, z));
/** Neighbouring tile ids per tile (flush, 2 m centre to centre). */
export const COLOR_NEIGHBOURS: readonly (readonly number[])[] = COLOR_TILES.map((tile) =>
  HEX_DIRECTIONS.flatMap((d) => {
    const n = colorTileAtCell({ q: tile.q + d.q, r: tile.r + d.r });
    return n ? [n.id] : [];
  })
);
export const COLOR_OUTER_RING = Math.max(...COLOR_TILES.map((t) => t.ring));

// ─── Symmetries of the round field (it is symmetric under all twelve) ───────

/** +60° about the middle (from +x toward +z): (q, r) → (−r, q + r). */
const rotate60 = ({ q, r }: HexCoord): HexCoord => ({ q: -r + 0, r: q + r });
/** Mirror z → −z: (q, r) → (q + r, −r). */
const mirror = ({ q, r }: HexCoord): HexCoord => ({ q: q + r, r: -r + 0 });
/**
 * The twelve symmetries as tile permutations: `COLOR_SYMMETRIES[s][id]` is where tile
 * `id` goes. s = 0…5 rotate by 60°·s; s = 6…11 mirror first, then rotate.
 */
export const COLOR_SYMMETRIES: readonly Int16Array[] = Array.from({ length: 12 }, (_, s) =>
  Int16Array.from(COLOR_TILES, (tile) => {
    let cell: HexCoord = s >= 6 ? mirror(tile) : tile;
    for (let k = 0; k < s % 6; k++) cell = rotate60(cell);
    const to = colorTileAtCell(cell);
    if (!to) throw new Error(`Renk Kaosu field is not symmetric at ${key(tile)}`);
    return to.id;
  })
);
/** Rotation by 360°/order (order 2: half turn, 3: third turn) as a tile permutation. */
export const colorRotation = (order: 1 | 2 | 3) => COLOR_SYMMETRIES[order === 1 ? 0 : 6 / order];

// ─── Spawns ─────────────────────────────────────────────────────────────────

/**
 * Three players: ring 3 toward Katman Kaosu's spawn directions, 120° apart and 6 m out
 * (the rim is ring 4–5), 10.4 m from each other. Two players: ring 3 on opposite sides,
 * 12 m apart. Each set is one orbit of a rotation (third / half turn), so an opening
 * layout with that rotation symmetry treats every spawn the same.
 */
export const COLOR_SPAWN_CELLS: Readonly<Record<2 | 3, readonly HexCoord[]>> = {
  3: [HEX_DIRECTIONS[0], HEX_DIRECTIONS[4], HEX_DIRECTIONS[2]].map((d) => ({ q: 3 * d.q, r: 3 * d.r })),
  2: [HEX_DIRECTIONS[0], HEX_DIRECTIONS[3]].map((d) => ({ q: 3 * d.q, r: 3 * d.r })),
};
/** Spawn tile ids per player count, slot order. */
export const COLOR_SPAWN_TILES: Readonly<Record<2 | 3, readonly number[]>> = {
  3: COLOR_SPAWN_CELLS[3].map((c) => colorTileAtCell(c)!.id),
  2: COLOR_SPAWN_CELLS[2].map((c) => colorTileAtCell(c)!.id),
};
export const COLOR_SPAWN_HEIGHT = COLOR_TILE_TOP + 0.9;
const spawn = (cell: HexCoord): Vec3 => ({ ...hexCenter(cell), y: COLOR_SPAWN_HEIGHT });
const extent = Math.max(...COLOR_TILES.map((t) => Math.hypot(t.x, t.z))) + HEX.corner;

/**
 * The physics map: no static colliders (the tile field owns one prism per tile, since
 * tiles drop). `spawns` are the three-player spawns; a two-player match moves slot 1 to
 * the opposite side (ColorChaosGame).
 */
export const COLORS_MAP: ArenaMap = {
  id: "colors",
  name: "Renk Kaosu",
  bounds: { minX: -extent, maxX: extent, minZ: -extent, maxZ: extent },
  colliders: [],
  spawns: [spawn(COLOR_SPAWN_CELLS[3][0]), spawn(COLOR_SPAWN_CELLS[3][1]), spawn(COLOR_SPAWN_CELLS[3][2])],
  lethalEdges: [],
  bot: { home: { x: 0, z: 0 }, wander: { x: 0, z: 0, halfX: 5, halfZ: 5 } },
};
/** Pelvis spawn point of `slot` in a match of `players`. */
export const colorSpawn = (players: 2 | 3, slot: number): Vec3 => spawn(COLOR_SPAWN_CELLS[players][slot]);
