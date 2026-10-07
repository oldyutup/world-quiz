import { DEFAULT_BOARD_LENGTH, isBoardLength, type BoardLength } from "./board/config.js";

/** The host's Tahta Oyunu preference, kept across mode changes. */
export interface BoardSettings { length: BoardLength; }
export const DEFAULT_BOARD_SETTINGS: Readonly<BoardSettings> = { length: DEFAULT_BOARD_LENGTH };
export function validBoardSettings(value: unknown): value is BoardSettings {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.keys(value)[0] === "length"
    && isBoardLength((value as BoardSettings).length);
}
