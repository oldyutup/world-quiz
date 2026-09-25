import { COLOR_TILE_COUNT } from "../../maps/colors.js";
import { COLOR_INDICES, COLOR_TICKS, reactionTicks, type ColorIndex } from "./config.js";
import { applyPick, colorLayoutBanks, LAYOUT_STAGE_COUNT, mulberry32, NO_COLOR, OPENING_LAYOUT_COUNT, type ColorLayout, type LayoutPick } from "./layouts.js";
import { FOUR_TILES, shrinkStage, STAGE_MASKS } from "./shrink.js";

/**
 * Target colours from a shuffle bag: every bag holds the four colours once in a random
 * order, and a bag never starts with the colour that ended the previous one — so a
 * colour never comes twice in a row and every colour comes once per four cycles
 * (no streaks, no droughts longer than six cycles).
 */
export class TargetBag {
  private bag: ColorIndex[] = [];
  last: ColorIndex | null = null;
  constructor(private readonly random: () => number) {}
  next(): ColorIndex {
    if (!this.bag.length) {
      const bag = [...COLOR_INDICES];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      if (bag[0] === this.last) {
        const j = 1 + Math.floor(this.random() * (bag.length - 1));
        [bag[0], bag[j]] = [bag[j], bag[0]];
      }
      this.bag = bag;
    }
    this.last = this.bag.shift()!;
    return this.last;
  }
}

/** PREVIEW: new colours, no target. RUN: target announced, reaction timer running. UNSAFE: every other colour gone. */
export type ColorPhase = "preview" | "run" | "unsafe";
export type ColorEvent = "target" | "drop" | "restore" | null;

/**
 * What a cycle is on the field, in round ticks (tick 0 = first playing tick): everything a
 * screen draws and a prediction replays — the schedule's own cycles, and online the ones
 * decoded from snapshots (`colors/wire.ts`).
 */
export interface ColorCycleState {
  /** 1-based. */
  index: number;
  /** First tick of the cycle (the previous cycle's restore; 0 for the first). */
  start: number;
  /** Target announced (reaction timer starts). */
  announce: number;
  /** Every tile of another colour drops (colliders off before this tick's physics). */
  drop: number;
  /** Every tile back (colliders on before this tick's physics) — and the next cycle starts. */
  restore: number;
  target: ColorIndex;
  /** Colour per tile; NO_COLOR on tiles that are gone or stand grey through their last cycle. */
  colors: ColorLayout;
  /** Shrink stage of the colours (0: the whole field; 8: none left — the final drop). */
  stage: number;
  /** 1: the tile is there at the start of this cycle (coloured, or grey: gone for good at this drop). */
  present: Uint8Array;
  /** 1: coloured now, grey next cycle, then gone (the shrink's warning). */
  warned: Uint8Array;
  /** No colour anywhere: this drop takes the last tile. */
  final: boolean;
}
/** One cycle of the schedule: its state and the layout pick it was drawn from. */
export interface ColorCycle extends ColorCycleState {
  pick: LayoutPick;
}

/**
 * Renk Kaosu's cycle clock as pure state (no physics): which colours the tiles show,
 * which colour is the target, and on which exact tick the other colours drop and come
 * back. Deterministic for a seed; the game (local, and online the room server) drives it once per
 * playing tick, before physics.
 *
 * Cycle 1: target on the first playing tick (its colours were visible through the whole
 * countdown), drop after the reaction time, restore `unsafe` later. Every later cycle
 * starts on the previous restore with a `preview` (new colours, no target, bodies
 * settle), then target, reaction time, drop, unsafe window.
 *
 * Daralma (COLOR_CHAOS.shrink): from cycle 19 the colours come from the shrink stage's
 * smaller field. A stage's ring is `warned` one cycle, grey (present, no colour) the next,
 * drops with the other colours and is not `present` again.
 */
export class ColorSchedule {
  cycle!: ColorCycle;
  /** The cycle before (its non-target tiles are the ones returning at this cycle's start). */
  previous: ColorCycle | null = null;
  private random!: () => number;
  private bag!: TargetBag;
  private lastIndex = -1;
  private lastStage = 0;
  constructor(
    seed: number,
    public players: 2 | 3
  ) {
    this.reset(seed);
  }
  /** A fresh round (for `players`: the opening layout's symmetry): cycle 1 with a symmetric opening layout. */
  reset(seed: number, players: 2 | 3 = this.players) {
    this.players = players;
    this.random = mulberry32(seed);
    this.bag = new TargetBag(this.random);
    this.lastIndex = -1;
    this.lastStage = 0;
    this.previous = null;
    this.cycle = this.plan(1, 0, null);
  }
  private shuffledColors() {
    const palette = [...COLOR_INDICES];
    for (let i = palette.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [palette[i], palette[j]] = [palette[j], palette[i]];
    }
    return palette;
  }
  private pickLayout(opening: boolean, stage: number): LayoutPick {
    // The last fields have no bank: "four" takes one colour per tile (palette[k] on FOUR_TILES[k]), then none.
    if (stage >= LAYOUT_STAGE_COUNT) return { bank: "cycle", stage, index: -1, symmetry: 0, palette: this.shuffledColors() };
    if (stage !== this.lastStage) this.lastIndex = -1;
    this.lastStage = stage;
    const count = opening ? OPENING_LAYOUT_COUNT : colorLayoutBanks().stages[stage].length;
    let index = Math.floor(this.random() * count);
    // Never the same bank layout twice in a row (the transform alone may look alike).
    if (!opening && count > 1 && index === this.lastIndex) index = (index + 1 + Math.floor(this.random() * (count - 1))) % count;
    if (!opening) this.lastIndex = index;
    const symmetry = Math.floor(this.random() * 12),
      palette = this.shuffledColors();
    return { bank: opening ? "opening" : "cycle", stage, index, symmetry, palette };
  }
  /** Cycle `index` starting on round tick `start`, after cycle `before` (null: the round's first). */
  private plan(index: number, start: number, before: ColorCycle | null): ColorCycle {
    const opening = !before,
      stage = shrinkStage(index),
      pick = this.pickLayout(opening, stage),
      announce = start + (opening ? 0 : COLOR_TICKS.preview),
      drop = announce + reactionTicks(index),
      target = this.bag.next();
    let colors: ColorLayout;
    if (stage < LAYOUT_STAGE_COUNT) colors = applyPick(pick, this.players);
    else {
      // "four": one tile per colour (so exactly one safe tile, wherever the target is); after it, none.
      colors = new Uint8Array(COLOR_TILE_COUNT).fill(NO_COLOR);
      if (STAGE_MASKS[stage].includes(1)) FOUR_TILES.forEach((id, k) => (colors[id] = pick.palette[k]));
    }
    // Back at this restore: the previous stage's field (and whatever stood through the drop).
    const present = Uint8Array.from(STAGE_MASKS[shrinkStage(index - 1)], (k, id) => (k || (before && before.colors[id] === before.target) ? 1 : 0)),
      kept = STAGE_MASKS[stage],
      next = STAGE_MASKS[shrinkStage(index + 1)],
      warned = Uint8Array.from(kept, (k, id) => (k && !next[id] ? 1 : 0));
    return { index, start, announce, drop, restore: drop + COLOR_TICKS.unsafe, target, pick, colors, stage, present, warned, final: !kept.includes(1) };
  }
  /**
   * Start of playing tick t, before physics. On the restore tick the next cycle begins
   * (new layout and target). Returns what happened on this tick.
   */
  advance(t: number): ColorEvent {
    const c = this.cycle;
    if (t === c.restore) {
      this.previous = c;
      this.cycle = this.plan(c.index + 1, t, c);
      return "restore";
    }
    if (t === c.drop) return "drop";
    if (t === c.announce) return "target";
    return null;
  }
  phase(t: number): ColorPhase {
    const c = this.cycle;
    return t < c.announce ? "preview" : t < c.drop ? "run" : "unsafe";
  }
  /** Whether a tile stands on round tick t of the current cycle. */
  standing(id: number, t: number) {
    const c = this.cycle;
    return c.colors[id] === c.target || (!!c.present[id] && t < c.drop);
  }
  /** Tiles without the target colour (the ones that drop; the grey ones for good). */
  dropping(): number[] {
    const out: number[] = [];
    for (let id = 0; id < COLOR_TILE_COUNT; id++) if (this.cycle.colors[id] !== this.cycle.target) out.push(id);
    return out;
  }
  /** Seconds of reaction time left on round tick t (0 before the announcement is over / after the drop). */
  timeLeft(t: number) {
    const c = this.cycle;
    return t < c.announce || t >= c.drop ? 0 : (c.drop - t) / 60;
  }
}
