import { BOMBER as B } from "./config.js";

/**
 * The round arena: `RINGS` rings around a hub, each cut into `SECTORS` cells. A cell's index
 * is ring × SECTORS + sector. Pillars stand at odd rings × odd sectors, so the even rings are
 * whole circles and the even sectors run from the hub to the edge: a Bomberman grid bent
 * round. Every player owns one wedge of `SECTORS / players` sectors; all wedges are the same
 * turned, so every start is the same.
 */
export const SECTORS = B.sectors;
export const RINGS = B.ringDepths.length;
export const CELLS = RINGS * SECTORS;
export const SECTOR_ANGLE = (2 * Math.PI) / SECTORS;
/** Ring edges from the hub out: ring r spans EDGES[r] … EDGES[r + 1]. */
export const EDGES: readonly number[] = B.ringDepths.reduce<number[]>((edges, depth) => [...edges, Math.round((edges[edges.length - 1] + depth) * 1000) / 1000], [B.hubRadius]);
export const OUTER = EDGES[RINGS];

export const FLOOR = 0,
  PILLAR = 1,
  BOX = 2,
  /** A fallen cell (the last seconds): nothing stands there and nothing passes. */
  VOID = 3;
export type CellKind = typeof FLOOR | typeof PILLAR | typeof BOX | typeof VOID;

export const mod = (n: number, m: number) => ((n % m) + m) % m;
export const cellIndex = (ring: number, sector: number) => ring * SECTORS + mod(sector, SECTORS);
export const ringOf = (cell: number) => Math.floor(cell / SECTORS);
export const sectorOf = (cell: number) => cell % SECTORS;
export const midRadius = (ring: number) => (EDGES[ring] + EDGES[ring + 1]) / 2;
/** Angle of (x, z) in [0, 2π), from +x towards +z. */
export function angleOf(x: number, z: number) {
  const a = Math.atan2(z, x);
  return a < 0 ? a + 2 * Math.PI : a;
}
export const sectorAngle = (sector: number) => (sector + 0.5) * SECTOR_ANGLE;

/** The cell under (x, z), −1 on the hub or outside the arena. */
export function cellAt(x: number, z: number) {
  const r = Math.hypot(x, z);
  if (r < EDGES[0] || r >= OUTER) return -1;
  let ring = 0;
  while (ring < RINGS - 1 && r >= EDGES[ring + 1]) ring++;
  return cellIndex(ring, Math.min(SECTORS - 1, Math.floor(angleOf(x, z) / SECTOR_ANGLE)));
}
export function cellCenter(cell: number) {
  const r = midRadius(ringOf(cell)),
    a = sectorAngle(sectorOf(cell));
  return { x: r * Math.cos(a), z: r * Math.sin(a) };
}

/** Blast and walk directions: towards the hub, outwards, down and up the sector numbers. */
export const DIRECTIONS = ["in", "out", "ccw", "cw"] as const;
/** The cell next to `cell` in `direction` (0 in, 1 out, 2 ccw, 3 cw); −1 past the hub or the edge. */
export function neighbour(cell: number, direction: number) {
  const ring = ringOf(cell),
    sector = sectorOf(cell);
  if (direction === 0) return ring > 0 ? cell - SECTORS : -1;
  if (direction === 1) return ring < RINGS - 1 ? cell + SECTORS : -1;
  return cellIndex(ring, sector + (direction === 2 ? -1 : 1));
}
export const neighbours = (cell: number) => [0, 1, 2, 3].map((d) => neighbour(cell, d)).filter((c) => c >= 0);
export const adjacent = (a: number, b: number) => a >= 0 && b >= 0 && [0, 1, 2, 3].some((d) => neighbour(a, d) === b);

/** The middle of the side two neighbouring cells share (walkers go through it). */
export function sharedSide(a: number, b: number) {
  if (sectorOf(a) === sectorOf(b)) {
    const r = EDGES[Math.max(ringOf(a), ringOf(b))],
      angle = sectorAngle(sectorOf(a));
    return { x: r * Math.cos(angle), z: r * Math.sin(angle) };
  }
  const sa = sectorOf(a),
    sb = sectorOf(b),
    edge = mod(sb - sa, SECTORS) === 1 ? sb : sa,
    r = midRadius(ringOf(a)),
    angle = edge * SECTOR_ANGLE;
  return { x: r * Math.cos(angle), z: r * Math.sin(angle) };
}

export const isPillar = (ring: number, sector: number) => (B.pillarRings as readonly number[]).includes(ring) && sector % 2 === 1;

/** Sectors per wedge. */
export const wedgeSectors = (players: number) => SECTORS / players;
/** The lane whose wedge holds `sector`. */
export const wedgeOf = (sector: number, players: number) => Math.floor(mod(sector, SECTORS) / wedgeSectors(players));

/**
 * The start pocket in wedge coordinates (ring, sector within the wedge): the eight cells
 * around the pillar at ring 3 nearest the wedge's middle, the start on the outer ring in
 * front of that pillar, and the six boxes that close the pocket (the edge closes the rest).
 * A bomb anywhere in it leaves a cell behind the pillar to step to.
 */
export function pocketPlan(players: number) {
  const pillar = wedgeSectors(players) / 2 - 1;
  const cells: [number, number][] = [];
  for (let ring = 2; ring <= 4; ring++) for (let s = pillar - 1; s <= pillar + 1; s++) if (!(ring === 3 && s === pillar)) cells.push([ring, s]);
  const walls: [number, number][] = [
    [1, pillar - 1],
    [1, pillar + 1],
    [2, pillar - 2],
    [2, pillar + 2],
    [4, pillar - 2],
    [4, pillar + 2],
  ];
  return { pillar, start: [4, pillar] as [number, number], cells, walls };
}

export interface BomberLayout {
  players: number;
  /** Cell kinds at the start. */
  cells: Uint8Array;
  /** Per lane: its start cell and its pocket's cells. */
  spawns: number[];
  pockets: number[][];
}

/**
 * A round's arena for `players` (2 or 3): pillars, the closed start pockets, and boxes on a
 * `boxShare` of the other cells of one wedge, copied turned into every other wedge.
 */
export function bomberLayout(players: number, random: () => number = Math.random): BomberLayout {
  if (!Number.isInteger(players) || players < 2 || players > B.maxLanes || SECTORS % players) throw new RangeError(`Bombacı: ${players} players`);
  const wedge = wedgeSectors(players),
    plan = pocketPlan(players),
    kinds = new Uint8Array(wedge * RINGS); // one wedge: ring × wedge + sector
  const at = (ring: number, s: number) => ring * wedge + s;
  for (let ring = 0; ring < RINGS; ring++) for (let s = 0; s < wedge; s++) kinds[at(ring, s)] = isPillar(ring, s) ? PILLAR : FLOOR;
  for (const [ring, s] of plan.walls) kinds[at(ring, mod(s, wedge))] = BOX;
  const reserved = new Set([...plan.cells, ...plan.walls].map(([ring, s]) => at(ring, mod(s, wedge))));
  const free: number[] = [];
  kinds.forEach((kind, i) => {
    if (kind === FLOOR && !reserved.has(i)) free.push(i);
  });
  // An exact share, so every round has the same amount of digging.
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [free[i], free[j]] = [free[j], free[i]];
  }
  free.slice(0, Math.round(free.length * B.boxShare)).forEach((i) => (kinds[i] = BOX));
  const cells = new Uint8Array(CELLS);
  for (let lane = 0; lane < players; lane++)
    for (let ring = 0; ring < RINGS; ring++) for (let s = 0; s < wedge; s++) cells[cellIndex(ring, lane * wedge + s)] = kinds[at(ring, s)];
  return {
    players,
    cells,
    spawns: Array.from({ length: players }, (_, lane) => cellIndex(plan.start[0], lane * wedge + plan.start[1])),
    pockets: Array.from({ length: players }, (_, lane) => plan.cells.map(([ring, s]) => cellIndex(ring, lane * wedge + s))),
  };
}
