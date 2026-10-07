import { isGameMode, type GameMode } from "../modes.js";
import { BOARD, isBoardLength, isSpecialType, type SpecialType } from "./config.js";
import type { DiceKind, WinnerChoice } from "./rules.js";

export const BOARD_PHASES = ["intro", "minigame", "choose", "roll", "move", "effect", "finished"] as const;
export type BoardPhase = (typeof BOARD_PHASES)[number];

/** The latest roll. `seq` grows with every roll, so a client animates each one once. */
export interface BoardRoll {
  seq: number;
  slot: number;
  kind: DiceKind;
  /** One die, or two for "two" (the higher one counts). */
  dice: number[];
  /** Squares moved before the treasure cap ("plus" adds one, a bonus die one more). */
  value: number;
  /** A bonus die was used on this roll (+1). */
  bonus: boolean;
  from: number;
  to: number;
  /** Rolled by the server: timeout or the player was away. */
  auto: boolean;
}

/** The latest special square effect. `seq` grows with every effect, so a client animates each once. */
export interface BoardEffect {
  seq: number;
  /** The player who landed on the square. */
  slot: number;
  type: SpecialType;
  /** The player's square before and after (swap: the partner moves the other way). */
  from: number;
  to: number;
  /** Swap partner, −1 when nobody stood on another square. */
  other: number;
  /** Bonus: false when the player already held one (it does not stack). */
  gained: boolean;
}

/**
 * The whole board, sent as JSON in the room state (`LobbyState.board`, "" when no match):
 * small, changes a few times a second at most, and a reconnecting page has it complete
 * from its first patch.
 */
export interface BoardWire {
  phase: BoardPhase;
  length: number;
  round: number;
  /** [slot, square] for every player still on the board, in slot order. */
  pieces: [number, number][];
  /** This round's move order (slots); empty before the mini game ends. */
  order: number[];
  /** Whose turn it is (choose / roll / move), −1 otherwise. */
  current: number;
  /** The last mini game's winner, −1 for a draw or none. */
  first: number;
  choice: WinnerChoice | null;
  /** The next (intro) or running mini game. */
  mode: GameMode;
  lastMode: GameMode | null;
  /** Mini game stage while phase is "minigame". */
  mini: "playing" | "results" | null;
  roll: BoardRoll | null;
  /** Special squares of this match: [square, type, target (−1: none)]. Every other square is normal. */
  squares: [number, SpecialType, number][];
  /** Slots holding a bonus die. */
  bonus: number[];
  effect: BoardEffect | null;
  /** Whole seconds left in a timed phase, 0 when untimed. */
  left: number;
  winner: number;
  reason: "treasure" | "forfeit" | null;
}

export const encodeBoard = (board: BoardWire | null) => (board ? JSON.stringify(board) : "");

const int = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const slotOrNone = (value: unknown) => int(value, -1, BOARD.maxPlayers - 1);
const slot = (value: unknown) => int(value, 0, BOARD.maxPlayers - 1);

/** Client side: a malformed or foreign board is ignored (null), never half-trusted. */
export function parseBoard(text: unknown): BoardWire | null {
  if (typeof text !== "string" || !text || text.length > 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const b = value as Record<string, unknown>;
  if (!(BOARD_PHASES as readonly unknown[]).includes(b.phase) || !isBoardLength(b.length) || !int(b.round, 1, 10000)) return null;
  const length = b.length;
  if (!Array.isArray(b.pieces) || b.pieces.length > BOARD.maxPlayers) return null;
  if (!b.pieces.every((p) => Array.isArray(p) && p.length === 2 && slot(p[0]) && int(p[1], 0, length))) return null;
  if (!Array.isArray(b.order) || b.order.length > BOARD.maxPlayers || !b.order.every(slot)) return null;
  if (!slotOrNone(b.current) || !slotOrNone(b.first) || !slotOrNone(b.winner) || !int(b.left, 0, 600)) return null;
  if (b.choice !== null && b.choice !== "two" && b.choice !== "plus") return null;
  if (!isGameMode(b.mode) || (b.lastMode !== null && !isGameMode(b.lastMode))) return null;
  if (b.mini !== null && b.mini !== "playing" && b.mini !== "results") return null;
  if (b.reason !== null && b.reason !== "treasure" && b.reason !== "forfeit") return null;
  if (b.roll !== null) {
    const r = b.roll as Record<string, unknown>;
    if (!r || typeof r !== "object" || !int(r.seq, 1, Number.MAX_SAFE_INTEGER) || !slot(r.slot)) return null;
    if (r.kind !== "two" && r.kind !== "plus" && r.kind !== "single") return null;
    if (!Array.isArray(r.dice) || r.dice.length !== (r.kind === "two" ? 2 : 1) || !r.dice.every((d) => int(d, 1, 6))) return null;
    if (!int(r.value, 1, 8) || typeof r.bonus !== "boolean" || !int(r.from, 0, length) || !int(r.to, 0, length) || r.to < r.from || typeof r.auto !== "boolean") return null;
  }
  if (!Array.isArray(b.squares) || b.squares.length > length) return null;
  if (!b.squares.every((s) => Array.isArray(s) && s.length === 3 && int(s[0], 1, length - 1) && isSpecialType(s[1]) && int(s[2], -1, length))) return null;
  if (new Set(b.squares.map((s) => s[0])).size !== b.squares.length) return null;
  if (!Array.isArray(b.bonus) || b.bonus.length > BOARD.maxPlayers || !b.bonus.every(slot)) return null;
  if (b.effect !== null) {
    const e = b.effect as Record<string, unknown>;
    if (!e || typeof e !== "object" || !int(e.seq, 1, Number.MAX_SAFE_INTEGER) || !slot(e.slot) || !isSpecialType(e.type)) return null;
    if (!int(e.from, 0, length) || !int(e.to, 0, length) || !slotOrNone(e.other) || typeof e.gained !== "boolean") return null;
  }
  return b as unknown as BoardWire;
}
