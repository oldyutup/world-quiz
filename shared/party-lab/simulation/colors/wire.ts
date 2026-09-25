import { COLOR_TILE_COUNT } from "../../maps/colors.js";
import { LAYER_FLAG, LAYER_RESULTS, type ColorFieldSnapshot } from "../../network/protocol.js";
import { PLAYERS } from "../players.js";
import type { LayerResult } from "../layers/round.js";
import { COLOR_TICKS, reactionTicks, type ColorIndex } from "./config.js";
import { NO_COLOR } from "./layouts.js";
import type { ColorCycleState } from "./schedule.js";
import { shrinkStage, STAGE_MASKS } from "./shrink.js";

/** One bit per tile (85 tiles → 11 bytes, LSB first). */
export const COLOR_BITSET_BYTES = Math.ceil(COLOR_TILE_COUNT / 8);
/** Two bits of colour per tile (85 tiles → 22 bytes). */
export const COLOR_LAYOUT_BYTES = Math.ceil(COLOR_TILE_COUNT / 4);
/** Highest cycle a snapshot may name (the final drop is cycle 32; the cap ends play by ~35). */
export const MAX_COLOR_CYCLE = 64;

const cycleTickCache: (readonly [number, number, number, number])[] = [];
/**
 * Round ticks [start, announce, drop, restore] of cycle `n` (1-based). Every length is
 * fixed (preview, reaction by cycle, unsafe), so these follow from `n` alone — the
 * schedule makes exactly these; the client checks a snapshot's against them.
 */
export function cycleTicks(n: number): readonly [number, number, number, number] {
  while (cycleTickCache.length < n) {
    const index = cycleTickCache.length + 1,
      start = index === 1 ? 0 : cycleTickCache[index - 2][3],
      announce = start + (index === 1 ? 0 : COLOR_TICKS.preview),
      drop = announce + reactionTicks(index);
    cycleTickCache.push([start, announce, drop, drop + COLOR_TICKS.unsafe]);
  }
  return cycleTickCache[n - 1];
}

const bit = (bytes: Uint8Array, id: number) => (bytes[id >> 3] >> (id & 7)) & 1;
function bitset(test: (id: number) => boolean) {
  const out = new Uint8Array(COLOR_BITSET_BYTES);
  for (let id = 0; id < COLOR_TILE_COUNT; id++) if (test(id)) out[id >> 3] |= 1 << (id & 7);
  return out;
}

/** The field part of a `colors` section: the cycle, its ticks and target, and the tiles as bitsets + 2-bit colours. */
export function encodeColorField(cycle: ColorCycleState): Pick<ColorFieldSnapshot, "n" | "k" | "h" | "p" | "g" | "m" | "c"> {
  const c = new Uint8Array(COLOR_LAYOUT_BYTES);
  for (let id = 0; id < COLOR_TILE_COUNT; id++) {
    const color = cycle.colors[id];
    if (color !== NO_COLOR) c[id >> 2] |= (color & 3) << ((id & 3) * 2);
  }
  return {
    n: cycle.index,
    k: [cycle.start, cycle.announce, cycle.drop, cycle.restore],
    h: cycle.target,
    p: bitset((id) => cycle.present[id] === 1),
    g: bitset((id) => cycle.present[id] === 1 && cycle.colors[id] === NO_COLOR),
    m: bitset((id) => cycle.warned[id] === 1),
    c,
  };
}

export interface DecodedColors {
  /** Round tick of the section (see LayerSnapshot.t). */
  t: number;
  cycle: ColorCycleState;
  /** LAYER_FLAG bits per slot. */
  flags: number[];
  /** Round tick each slot was eliminated on (−1: not). */
  outAt: number[];
  result: LayerResult | "forfeit" | null;
}
const smallInt = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const bytes = (v: unknown, length: number): v is Uint8Array => v instanceof Uint8Array && v.byteLength === length;
/**
 * Validated section (null: malformed or inconsistent). Never trusts lengths or ranges, and
 * checks the floor against the rules this page was built with: the cycle's ticks, which
 * tiles are there, grey and marked all follow from its number (a stale or mismatched page
 * refuses the section instead of drawing or predicting another floor).
 */
export function decodeColorSnapshot(value: unknown): DecodedColors | null {
  if (!value || typeof value !== "object") return null;
  const s = value as ColorFieldSnapshot;
  if (!smallInt(s.t, 0, 1e7) || !smallInt(s.n, 1, MAX_COLOR_CYCLE) || !smallInt(s.h, 0, 3)) return null;
  if (!bytes(s.p, COLOR_BITSET_BYTES) || !bytes(s.g, COLOR_BITSET_BYTES) || !bytes(s.m, COLOR_BITSET_BYTES) || !bytes(s.c, COLOR_LAYOUT_BYTES)) return null;
  if (!Array.isArray(s.k) || s.k.length !== 4 || !s.k.every((v) => smallInt(v, 0, 1e7))) return null;
  if (!Array.isArray(s.f) || s.f.length !== PLAYERS.length || !s.f.every((v) => smallInt(v, 0, 255))) return null;
  if (!Array.isArray(s.o) || s.o.length !== PLAYERS.length || !s.o.every((v) => smallInt(v, -1, 1e7))) return null;
  if (!smallInt(s.r, 0, LAYER_RESULTS.length - 1)) return null;
  const ticks = cycleTicks(s.n);
  if (ticks.some((v, i) => v !== s.k[i])) return null;
  const stage = shrinkStage(s.n),
    was = STAGE_MASKS[shrinkStage(s.n - 1)],
    kept = STAGE_MASKS[stage],
    next = STAGE_MASKS[shrinkStage(s.n + 1)];
  const colors = new Uint8Array(COLOR_TILE_COUNT).fill(NO_COLOR),
    present = new Uint8Array(COLOR_TILE_COUNT),
    warned = new Uint8Array(COLOR_TILE_COUNT);
  for (let id = 0; id < COLOR_TILE_COUNT; id++) {
    const p = bit(s.p, id),
      grey = bit(s.g, id),
      coloured = p && !grey ? 1 : 0;
    if (p !== was[id] || (grey && !p) || coloured !== kept[id] || bit(s.m, id) !== (kept[id] && !next[id] ? 1 : 0)) return null;
    present[id] = p;
    warned[id] = bit(s.m, id);
    if (coloured) colors[id] = (s.c[id >> 2] >> ((id & 3) * 2)) & 3;
  }
  const [start, announce, drop, restore] = ticks;
  const cycle: ColorCycleState = {
    index: s.n,
    start,
    announce,
    drop,
    restore,
    target: s.h as ColorIndex,
    colors,
    stage,
    present,
    warned,
    final: !kept.includes(1),
  };
  return { t: s.t, cycle, flags: [...s.f], outAt: [...s.o], result: LAYER_RESULTS[s.r] };
}
export const colorFlag = (d: DecodedColors | null, slot: number, flag: number) => !!d && slot >= 0 && slot < PLAYERS.length && !!(d.flags[slot] & flag);
export { LAYER_FLAG as COLOR_FLAG };

/**
 * What an online client knows about the colour field from this round's snapshots, on any
 * round tick: the remote timeline (a little behind), the own predicted one (a little
 * ahead) or the snapshot's own. Every snapshot carries its whole cycle, so nothing can be
 * missed; the last few cycles are kept so a timeline behind the newest snapshot still
 * draws the cycle it is in (and the tiles rising back at its start).
 *
 * Past the newest cycle's restore (the next cycle not heard of yet), every tile with a
 * colour this cycle stands again — exactly what the server restores; the next drop is at
 * least 2.1 s after that, far beyond any prediction window.
 */
export class ColorFieldKnowledge {
  private readonly cycles: ColorCycleState[] = [];
  round = -1;
  /** Round tick of the newest section applied. */
  latest = -1;
  reset(round = -1) {
    this.cycles.length = 0;
    this.round = round;
    this.latest = -1;
  }
  /** A newer snapshot of `round` (older ticks change nothing). */
  apply(round: number, d: DecodedColors) {
    if (round !== this.round) this.reset(round);
    const newest = this.cycles[this.cycles.length - 1];
    if (d.t < this.latest || (newest && d.cycle.index < newest.index)) return false;
    this.latest = d.t;
    if (!newest || d.cycle.index > newest.index) {
      this.cycles.push(d.cycle);
      if (this.cycles.length > 4) this.cycles.shift();
    }
    return true;
  }
  /** The newest cycle heard of (null: none yet). */
  get newest(): ColorCycleState | null {
    return this.cycles[this.cycles.length - 1] ?? null;
  }
  /** The known cycle round tick `tick` falls in (the oldest known one for earlier ticks). */
  cycleAt(tick: number): ColorCycleState | null {
    for (let i = this.cycles.length - 1; i >= 0; i--) if (this.cycles[i].start <= tick) return this.cycles[i];
    return this.cycles[0] ?? null;
  }
  /** What to draw on round tick `tick`: its cycle and the one before (for the tiles rising back). */
  view(tick: number): { cycle: ColorCycleState; previous: ColorCycleState | null } | null {
    const cycle = this.cycleAt(tick);
    if (!cycle) return null;
    return { cycle, previous: this.cycles.find((c) => c.index === cycle.index - 1) ?? null };
  }
  /** Whether tile `id`'s collider is there on round tick `tick` (the server's exact rule). */
  standing(id: number, tick: number) {
    const c = this.cycleAt(tick);
    if (!c) return true;
    if (tick >= c.restore) return c.colors[id] !== NO_COLOR;
    return c.colors[id] === c.target || (c.present[id] === 1 && tick < c.drop);
  }
  /** Whether round tick `tick` is a restore (the below-floor rule runs on it). */
  isRestore(tick: number) {
    return this.cycles.some((c) => c.restore === tick);
  }
}
