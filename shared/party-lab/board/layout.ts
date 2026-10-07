import { BOARD } from "./config.js";

/**
 * Board geometry (metres, Y up, flat at y = 0): a winding S of squares. Rows run back
 * and forth along X, advancing toward −Z, joined by half-circle turns; each straight has a gentle sideways
 * wave that starts and ends flat, so the joins stay smooth. Square 0 (start) is at one
 * end, square `length` (treasure) at the other. Pure math: the client draws it, tests
 * check it.
 */
export const SQUARE_SPACING = 1.75;
export const SQUARE_SIZE = 1.4;
export const TURN_RADIUS = 2.1;
const WAVE = 0.55;

export interface SquarePose {
  x: number;
  z: number;
  /** Direction of travel (radians about Y, 0 = +Z). */
  yaw: number;
}

export const boardRows = (length: number) => (length <= 20 ? 3 : length <= 35 ? 4 : 5);

/** Centre-line point at arc distance `s` (wave ignored), plus the straight-section progress. */
function centreLine(s: number, rows: number, straight: number) {
  const turn = Math.PI * TURN_RADIUS;
  for (let row = 0; row < rows; row++) {
    const dir = row % 2 === 0 ? 1 : -1;
    const z = row * 2 * TURN_RADIUS;
    const x0 = dir > 0 ? 0 : straight;
    if (s <= straight || row === rows - 1) {
      const t = Math.min(s, straight);
      return { x: x0 + dir * t, z, wave: t / straight, dir };
    }
    s -= straight;
    if (s <= turn) {
      const a = s / TURN_RADIUS;
      const cx = dir > 0 ? straight : 0;
      return { x: cx + dir * Math.sin(a) * TURN_RADIUS, z: z + TURN_RADIUS - Math.cos(a) * TURN_RADIUS, wave: -1, dir };
    }
    s -= turn;
  }
  return { x: 0, z: 0, wave: -1, dir: 1 };
}

/** Length of each straight row (metres of centre line). */
const straightLength = (length: number, rows = boardRows(length)) => (length * SQUARE_SPACING - (rows - 1) * Math.PI * TURN_RADIUS) / rows;

/** One pose per square, 0 … length, centred on the origin. */
export function boardPath(length: number): SquarePose[] {
  const rows = boardRows(length);
  const total = length * SQUARE_SPACING;
  const straight = straightLength(length, rows);
  const point = (s: number) => {
    const p = centreLine(Math.max(0, Math.min(total, s)), rows, straight);
    // Zero value and slope at both ends of a straight: sin(πu)·sin(2πu).
    const offset = p.wave >= 0 ? WAVE * Math.sin(Math.PI * p.wave) * Math.sin(2 * Math.PI * p.wave) * p.dir : 0;
    // Rows advance toward −Z: from a camera on the +Z side the start is near, the treasure far.
    return { x: p.x, z: -(p.z + offset) };
  };
  const poses = Array.from({ length: length + 1 }, (_, i) => {
    const s = i * SQUARE_SPACING,
      here = point(s),
      a = point(s - 0.2),
      b = point(s + 0.2);
    return { x: here.x, z: here.z, yaw: Math.atan2(b.x - a.x, b.z - a.z) };
  });
  const xs = poses.map((p) => p.x),
    zs = poses.map((p) => p.z);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
    cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  return poses.map((p) => ({ x: p.x - cx, z: p.z - cz, yaw: p.yaw }));
}

/** The row each square stands on (0 at the start), or −1 for a square on a turn between rows. */
export function squareRows(length: number): number[] {
  const rows = boardRows(length),
    straight = straightLength(length, rows),
    turn = Math.PI * TURN_RADIUS;
  return Array.from({ length: length + 1 }, (_, i) => {
    // The same walk as the centre line.
    let s = i * SQUARE_SPACING;
    for (let row = 0; row < rows; row++) {
      if (s <= straight || row === rows - 1) return row;
      s -= straight;
      if (s <= turn) return -1;
      s -= turn;
    }
    return rows - 1;
  });
}

/** Two squares straight across the gap between neighbouring rows (`row` is the lower one). */
export interface RowPair {
  lower: number;
  upper: number;
  row: number;
  /** Across-the-board position of the pair (metres, centred). */
  x: number;
}
/**
 * Every square with a square straight above it in the next row (within half a spacing
 * across the board): where a ladder or a slide can join two rows.
 */
export function rowPairs(length: number): RowPair[] {
  const path = boardPath(length),
    rows = squareRows(length),
    pairs: RowPair[] = [];
  for (let lower = 0; lower <= length; lower++) {
    if (rows[lower] < 0) continue;
    let best = -1;
    for (let upper = 0; upper <= length; upper++)
      if (rows[upper] === rows[lower] + 1 && (best < 0 || Math.abs(path[upper].x - path[lower].x) < Math.abs(path[best].x - path[lower].x))) best = upper;
    if (best >= 0 && Math.abs(path[best].x - path[lower].x) <= SQUARE_SPACING / 2)
      pairs.push({ lower, upper: best, row: rows[lower], x: (path[lower].x + path[best].x) / 2 });
  }
  return pairs;
}

/** Axis-aligned extent of the squares (with their size), for framing the whole board. */
export function boardBounds(poses: readonly SquarePose[]) {
  const half = SQUARE_SIZE / 2 + 0.6;
  return {
    minX: Math.min(...poses.map((p) => p.x)) - half,
    maxX: Math.max(...poses.map((p) => p.x)) + half,
    minZ: Math.min(...poses.map((p) => p.z)) - half,
    maxZ: Math.max(...poses.map((p) => p.z)) + half,
  };
}

/**
 * Where the `index`-th of `count` pawns on one square stands, relative to its centre:
 * alone in the middle, otherwise evenly round a small ring, so up to six never overlap.
 */
export function pawnOffset(index: number, count: number): { x: number; z: number } {
  if (count <= 1) return { x: 0, z: 0 };
  const n = Math.min(count, BOARD.maxPlayers);
  const radius = n === 2 ? 0.3 : 0.4;
  const angle = -Math.PI / 2 + (2 * Math.PI * (index % n)) / n;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

/** Squares carrying a number: every fifth, never the start or the treasure. */
export const numberedSquare = (index: number, length: number) => index > 0 && index < length && index % 5 === 0;
