import type { ArenaMapId, ModeArenaId, TileArenaId } from "./maps/types.js";

/**
 * Online game modes. Every round is played in exactly one mode, chosen by the
 * server before the round starts and sent explicitly (lobby state and every
 * snapshot). Clients never infer the mode from geometry or a map name.
 */
export const GAME_MODES = ["rooftop_brawl", "barn_shootout", "layer_chaos", "color_chaos", "bomb_tag", "prop_hunt"] as const;
export type GameMode = (typeof GAME_MODES)[number];
/** What the room host picks in the lobby: one mode, or all of them in a shuffled rotation. */
export const MODE_SELECTIONS = ["rooftop_brawl", "barn_shootout", "layer_chaos", "color_chaos", "bomb_tag", "prop_hunt", "mixed"] as const;
export type ModeSelection = (typeof MODE_SELECTIONS)[number];

export const DEFAULT_MODE_SELECTION: ModeSelection = "rooftop_brawl";

export const MODE_MAP: Readonly<Record<GameMode, ArenaMapId | TileArenaId | ModeArenaId>> = {
  rooftop_brawl: "rooftop",
  barn_shootout: "barn",
  layer_chaos: "layers",
  color_chaos: "colors",
  bomb_tag: "bomb",
  prop_hunt: "prophunt",
};
export const MODE_NAMES: Readonly<Record<ModeSelection, string>> = {
  rooftop_brawl: "Çatı Kavgası",
  barn_shootout: "Ambar Çatışması",
  layer_chaos: "Katman Kaosu",
  color_chaos: "Renk Kaosu",
  bomb_tag: "Bomba Sende",
  prop_hunt: "Saklambaç",
  mixed: "Karışık",
};

export const isGameMode = (value: unknown): value is GameMode =>
  typeof value === "string" && (GAME_MODES as readonly string[]).includes(value);
export const isModeSelection = (value: unknown): value is ModeSelection =>
  typeof value === "string" && (MODE_SELECTIONS as readonly string[]).includes(value);

/**
 * One Mixed cycle: every mode exactly once, in random order, never starting with
 * `previous` (the last mode played), so no mode is played twice in a row.
 */
export function mixedCycle(previous: GameMode | null, random: () => number = Math.random): GameMode[] {
  const cycle = [...GAME_MODES] as GameMode[];
  for (let i = cycle.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [cycle[i], cycle[j]] = [cycle[j], cycle[i]];
  }
  if (cycle[0] === previous) {
    // Swap the repeat with a random later mode: the cycle still has each mode once.
    const j = 1 + Math.min(cycle.length - 2, Math.floor(random() * (cycle.length - 1)));
    [cycle[0], cycle[j]] = [cycle[j], cycle[0]];
  }
  return cycle;
}

/**
 * The server's Mixed sequence. Each cycle holds all six modes once in a shuffled
 * order and the next cycle is reshuffled, never repeating the mode just played. `next`
 * is what the lobby shows before Ready; it is consumed only once a round of it reaches
 * play (a cancelled countdown keeps it). No voting.
 */
export class MixedRotation {
  private queue: GameMode[] = [];
  private last: GameMode | null = null;
  constructor(private readonly random: () => number = Math.random) {}
  /** The next round's mode. */
  get next(): GameMode {
    if (!this.queue.length) this.queue = mixedCycle(this.last, this.random);
    return this.queue[0];
  }
  /** Modes left in the current cycle, the next one first. */
  get remaining(): readonly GameMode[] {
    void this.next;
    return this.queue;
  }
  /** A round of the next mode reached play. */
  played() {
    this.last = this.next;
    this.queue.shift();
  }
  /** Mixed chosen again: a fresh cycle. */
  reset() {
    this.queue = [];
    this.last = null;
  }
}

/** The next round's mode for a single-mode selection; Mixed asks its rotation. */
export function upcomingMode(selection: ModeSelection, rotation: MixedRotation): GameMode {
  return selection === "mixed" ? rotation.next : selection;
}
