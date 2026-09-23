import type { ArenaMapId } from "./maps/types.js";

/**
 * Online game modes. Every round is played in exactly one mode, chosen by the
 * server before the round starts and sent explicitly (lobby state and every
 * snapshot). Clients never infer the mode from geometry or a map name.
 */
export const GAME_MODES = ["rooftop_brawl", "barn_shootout"] as const;
export type GameMode = (typeof GAME_MODES)[number];
/** What the room host picks in the lobby: one mode, or both alternating. */
export const MODE_SELECTIONS = ["rooftop_brawl", "barn_shootout", "mixed"] as const;
export type ModeSelection = (typeof MODE_SELECTIONS)[number];

export const DEFAULT_MODE_SELECTION: ModeSelection = "rooftop_brawl";

export const MODE_MAP: Readonly<Record<GameMode, ArenaMapId>> = {
  rooftop_brawl: "rooftop",
  barn_shootout: "barn",
};
export const MODE_NAMES: Readonly<Record<ModeSelection, string>> = {
  rooftop_brawl: "Çatı Kavgası",
  barn_shootout: "Ambar Çatışması",
  mixed: "Karışık",
};

export const isGameMode = (value: unknown): value is GameMode =>
  typeof value === "string" && (GAME_MODES as readonly string[]).includes(value);
export const isModeSelection = (value: unknown): value is ModeSelection =>
  typeof value === "string" && (MODE_SELECTIONS as readonly string[]).includes(value);

export const otherMode = (mode: GameMode): GameMode =>
  mode === "rooftop_brawl" ? "barn_shootout" : "rooftop_brawl";

/**
 * The mode of the next round for a selection. Mixed starts on a random mode and then
 * alternates: `previous` is the mode of the last round that actually started playing
 * under the mixed selection (null right after choosing Mixed).
 */
export function upcomingMode(selection: ModeSelection, previous: GameMode | null, random: () => number = Math.random): GameMode {
  if (selection !== "mixed") return selection;
  return previous ? otherMode(previous) : random() < 0.5 ? "rooftop_brawl" : "barn_shootout";
}
