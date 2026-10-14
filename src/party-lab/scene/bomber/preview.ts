import { BOMBER as B, ticks } from "../../../../shared/party-lab/simulation/bomber/config";
import { BOX, CELLS } from "../../../../shared/party-lab/simulation/bomber/arena";
import { blastPlan, type FuseBomb } from "../../../../shared/party-lab/simulation/bomber/blast";
import { BURNING, type BomberWire } from "../../../../shared/party-lab/simulation/bomber/wire";

const FUSE = ticks(B.fuse);

/**
 * Where the bombs on the arena will burn, and when: per cell the steps until the first blast
 * that reaches it (Infinity none). The bots' plan (blast.ts): chains included, so a bomb another
 * blast sets off early shows that earlier time.
 */
export function blastTimes(wire: BomberWire, bombs: readonly FuseBomb[]) {
  const times = new Float64Array(CELLS).fill(Infinity);
  if (!bombs.length) return times;
  const cells = new Uint8Array(CELLS),
    burn = new Uint8Array(CELLS);
  for (let c = 0; c < CELLS; c++) {
    cells[c] = wire.cells[c] === BURNING ? BOX : wire.cells[c];
    burn[c] = wire.cells[c] === BURNING ? 1 : 0;
  }
  for (const { time, cells: burnt } of blastPlan({ cells, burn }, bombs))
    for (const c of burnt) times[c] = Math.min(times[c], Math.max(0, time));
  return times;
}

/**
 * How a cell about to burn is drawn `steps` before its blast, at `clock` seconds: from a faint
 * orange as the bomb goes down to a deep red that blinks faster and faster at the end.
 */
export function previewLook(steps: number, clock: number) {
  const u = 1 - Math.min(1, Math.max(0, steps / FUSE));
  const blink = u > 0.3 ? 0.55 + 0.45 * Math.cos(clock * Math.PI * 2 * (1.5 + 8 * u)) : 1;
  return { u, alpha: (0.34 + 0.42 * u) * blink };
}
