import type { ArenaMap, Vec3 } from "./types.js";

/**
 * Katman Kaosu ("layer chaos"): four stacked fields of flush hexagonal tiles. Tiles
 * break after being stood on; players fall physically to the layer below, and below
 * the last layer out of the round. Played in the local arena and online (`layer_chaos`,
 * MODE_MAP → "layers"; the server's `LayerRoundSimulation`).
 *
 * Hex grid: axial coordinates (q, r); a tile's centre is x = W·(q + r/2),
 * z = W·(√3/2)·r. Neighbouring centres are exactly W apart (flat to flat), so tiles
 * touch with no physical gap; their corners point along ±z. The layouts reproduce
 * the audited plan (see ../simulation/layers/LAYERS.md).
 */
export const HEX = {
  /** Flat-to-flat width, also the distance between neighbouring centres (m). */
  width: 2.0,
  /** Centre-to-corner radius (m). */
  corner: 2 / Math.sqrt(3),
  /** Collider depth below the walking surface (m). */
  thickness: 0.5,
  /** Visual groove between neighbours (m), rendering only: colliders stay flush. */
  groove: 0.06,
} as const;

export type LayerIndex = 0 | 1 | 2 | 3;
export const LAYER_INDICES: readonly LayerIndex[] = [0, 1, 2, 3];
/** Walking surface height per layer, top (L1) to bottom (L4). */
export const LAYER_TOPS: readonly [number, number, number, number] = [16.5, 11, 5.5, 0];
export const LAYER_SPACING = 5.5;
/** L1 "Taç" (crown), L2 "Pencere" (windows), L3 "Petek" (honeycomb), L4 "Çekirdek" (core). */
export const LAYER_NAMES = ["Taç", "Pencere", "Petek", "Çekirdek"] as const;

export interface HexCoord {
  readonly q: number;
  readonly r: number;
}
export interface LayerTile extends HexCoord {
  /** Index into LAYER_TILES. */
  readonly id: number;
  readonly layer: LayerIndex;
  readonly x: number;
  readonly z: number;
  /** Walking surface height. */
  readonly top: number;
  /** Hex distance from the layer's centre; collapse waves run from the largest ring in. */
  readonly ring: number;
}

export const HEX_DIRECTIONS: readonly HexCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];
export const hexDistance = (a: HexCoord, b: HexCoord = { q: 0, r: 0 }) =>
  (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
export const hexCenter = ({ q, r }: HexCoord) => ({ x: HEX.width * (q + r / 2), z: HEX.width * (Math.sqrt(3) / 2) * r });
/** The hex cell containing a floor point (cube rounding). */
export function hexAt(x: number, z: number): HexCoord {
  const fr = z / (HEX.width * (Math.sqrt(3) / 2)),
    fq = x / HEX.width - fr / 2,
    fs = -fq - fr;
  let q = Math.round(fq),
    r = Math.round(fr);
  const s = Math.round(fs),
    dq = Math.abs(q - fq),
    dr = Math.abs(r - fr),
    ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 };
}
/** Flat-side normals of a tile (0°, 60°, 120° from +x toward +z); the hex is |p·n| ≤ W/2 for all three. */
const SIDE_NORMALS = [0, 60, 120].map((d) => ({ x: Math.cos((d * Math.PI) / 180), z: Math.sin((d * Math.PI) / 180) }));
/** Largest |offset·n| over the side normals: ≤ W/2 inside the hexagon. */
export const hexApothemDistance = (dx: number, dz: number) => Math.max(...SIDE_NORMALS.map((n) => Math.abs(dx * n.x + dz * n.z)));
/** Whether a floor point lies on a tile's top, optionally grown by `inflate` metres (flat sides moved out). */
export const hexContains = (tile: { x: number; z: number }, x: number, z: number, inflate = 0) =>
  hexApothemDistance(x - tile.x, z - tile.z) <= HEX.width / 2 + inflate;
/** Corner k (0…5) of a hexagon centred at the origin, at angles 30° + 60°k. */
export const hexCorner = (k: number, radius: number = HEX.corner) => {
  const a = ((30 + 60 * k) * Math.PI) / 180;
  return { x: radius * Math.cos(a), z: radius * Math.sin(a) };
};

// ─── Layouts (the audited plan) ─────────────────────────────────────────────

const key = (t: HexCoord) => `${t.q},${t.r}`;
function disk(radius: number): HexCoord[] {
  const out: HexCoord[] = [];
  for (let r = -radius; r <= radius; r++)
    for (let q = -radius; q <= radius; q++) if (Math.abs(q + r) <= radius) out.push({ q, r });
  return out;
}
/** Every cell whose centre is within `metres` of the middle: a round field. */
const round = (metres: number) =>
  disk(6).filter((t) => {
    const c = hexCenter(t);
    return Math.hypot(c.x, c.z) <= metres + 1e-6;
  });
const without = (cells: HexCoord[], removed: HexCoord[]) => {
  const gone = new Set(removed.map(key));
  return cells.filter((t) => !gone.has(key(t)));
};
const along = (steps: number, d: HexCoord): HexCoord => ({ q: steps * d.q, r: steps * d.r });
/** Toward the three spawns (slots 0, 1, 2), and the three directions between them. */
export const SPAWN_DIRECTIONS: readonly HexCoord[] = [HEX_DIRECTIONS[0], HEX_DIRECTIONS[4], HEX_DIRECTIONS[2]];
const BETWEEN_SPAWNS: readonly HexCoord[] = [HEX_DIRECTIONS[1], HEX_DIRECTIONS[3], HEX_DIRECTIONS[5]];

/**
 * L1 Taç: a broad round disc (Ø ≈ 20.7 m).
 * L2 Pencere: the same disc with three inner windows and three rim notches, all between the spawns.
 * L3 Petek: the disc with seven honeycomb windows — the hub and six on ring 2.
 * L4 Çekirdek: a compact final core (Ø ≈ 16.9 m).
 */
export const LAYER_CELLS: readonly (readonly HexCoord[])[] = [
  round(9.2),
  without(round(9.2), [...BETWEEN_SPAWNS.map((d) => along(2, d)), ...BETWEEN_SPAWNS.map((d) => along(4, d))]),
  without(round(9.2), [...BETWEEN_SPAWNS.map((d) => along(2, d)), ...SPAWN_DIRECTIONS.map((d) => along(2, d)), { q: 0, r: 0 }]),
  round(7.3),
];
export const LAYER_TILE_COUNTS = [85, 79, 78, 55] as const;

export const LAYER_TILES: readonly LayerTile[] = LAYER_CELLS.flatMap((cells, layer) =>
  cells.map((cell) => ({ ...cell, layer: layer as LayerIndex, ...hexCenter(cell), top: LAYER_TOPS[layer], ring: hexDistance(cell) }))
).map((tile, id) => ({ ...tile, id }));
const TILE_LOOKUP: readonly Map<string, LayerTile>[] = LAYER_INDICES.map(
  (layer) => new Map(LAYER_TILES.filter((t) => t.layer === layer).map((t) => [key(t), t]))
);
/** The tile of a layer at hex cell (q, r), if the layout has one there. */
export const tileAtCell = (layer: LayerIndex, cell: HexCoord) => TILE_LOOKUP[layer].get(key(cell));
/** The tile of a layer whose top contains the floor point (x, z), if any. */
export const tileAt = (layer: LayerIndex, x: number, z: number) => tileAtCell(layer, hexAt(x, z));
/** Neighbouring tiles of the same layer. */
export const tileNeighbours = (tile: LayerTile) =>
  HEX_DIRECTIONS.flatMap((d) => {
    const n = tileAtCell(tile.layer, { q: tile.q + d.q, r: tile.r + d.r });
    return n ? [n] : [];
  });
/** Outermost ring per layer (collapse waves start there). */
export const LAYER_OUTER_RING: readonly number[] = LAYER_INDICES.map((layer) =>
  Math.max(...LAYER_TILES.filter((t) => t.layer === layer).map((t) => t.ring))
);

/**
 * The layer a body at height `y` (pelvis) is on or falling toward: the highest layer
 * whose walking surface is below it. -1 above nothing (below the last layer).
 */
export function layerBelow(y: number): LayerIndex | -1 {
  for (const layer of LAYER_INDICES) if (y > LAYER_TOPS[layer]) return layer;
  return -1;
}

/** Top-layer spawns 120° apart on ring 3, pelvis a little above standing height, facing the centre. */
export const LAYER_SPAWN_CELLS: readonly HexCoord[] = SPAWN_DIRECTIONS.map((d) => along(3, d));
export const LAYER_SPAWN_HEIGHT = LAYER_TOPS[0] + 0.9;
const spawn = (cell: HexCoord): Vec3 => ({ ...hexCenter(cell), y: LAYER_SPAWN_HEIGHT });
const extent = Math.max(...LAYER_TILES.map((t) => Math.hypot(t.x, t.z))) + HEX.corner;

export const LAYERS_MAP: ArenaMap = {
  id: "layers",
  name: "Katman Kaosu",
  bounds: { minX: -extent, maxX: extent, minZ: -extent, maxZ: extent },
  // No static geometry: the tiles break, so the tile field owns their colliders.
  colliders: [],
  spawns: [spawn(LAYER_SPAWN_CELLS[0]), spawn(LAYER_SPAWN_CELLS[1]), spawn(LAYER_SPAWN_CELLS[2])],
  // Every tile edge can be fallen through; the tile field, not an edge list, decides.
  lethalEdges: [],
  bot: { home: { x: 0, z: 0 }, wander: { x: 0, z: 0, halfX: 6, halfZ: 6 } },
};
