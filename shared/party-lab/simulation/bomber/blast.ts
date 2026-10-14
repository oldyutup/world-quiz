import { BOMBER as B } from "./config.js";
import { BOX, PILLAR, VOID, neighbour } from "./arena.js";

/** What a blast needs of the arena: cell kinds and the boxes already burning away. */
export interface BlastArena {
  readonly cells: ArrayLike<number>;
  readonly burn: ArrayLike<number>;
}
/** A bomb still to blow: its cell and steps to go (fractional is fine). */
export interface FuseBomb {
  readonly cell: number;
  readonly fuse: number;
}

/**
 * What a bomb on `cell` would burn: the cells its flames reach (itself first), the boxes it
 * would break, the bombs it would set off. The game's own rule (game.ts detonate): `range`
 * cells each way along the ray and the ring, stopped by pillars, fallen cells, the hub and the
 * edge; a box breaks and stops it (one already burning just stops it); a bomb is reached and
 * stops it.
 */
export function blastCells<T extends { cell: number }>(arena: BlastArena, bombAt: (cell: number) => T | undefined, cell: number) {
  const cells = [cell],
    boxes: number[] = [],
    bombs: T[] = [];
  for (let direction = 0; direction < 4; direction++) {
    let c = cell;
    for (let k = 1; k <= B.range; k++) {
      c = neighbour(c, direction);
      if (c < 0) break;
      const kind = arena.cells[c];
      if (kind === PILLAR || kind === VOID) break;
      if (kind === BOX) {
        if (!arena.burn[c]) boxes.push(c);
        break;
      }
      cells.push(c);
      const bomb = bombAt(c);
      if (bomb) {
        bombs.push(bomb);
        break;
      }
    }
  }
  return { cells, boxes, bombs };
}

/**
 * When each of `bombs` really blows and what its flames cover: at its own fuse, or earlier when
 * an earlier blast reaches it (chains, however long). Flames stop at any of `blockers` too (all
 * the bombs on the arena). The bots run from it; the view draws it under the bombs.
 */
export function blastPlan(arena: BlastArena, bombs: readonly FuseBomb[], blockers: readonly FuseBomb[] = bombs) {
  const at = (cell: number) => bombs.find((b) => b.cell === cell) ?? blockers.find((b) => b.cell === cell);
  const plan = bombs.map((b) => ({ cell: b.cell, time: b.fuse, cells: blastCells(arena, at, b.cell).cells }));
  for (let changed = true, guard = 0; changed && guard <= plan.length; guard++) {
    changed = false;
    for (const a of plan)
      for (const b of plan)
        if (b !== a && b.time > a.time && a.cells.includes(b.cell)) {
          b.time = a.time;
          changed = true;
        }
  }
  return plan;
}
