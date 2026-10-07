/**
 * Tahta Oyunu (board_game): mini games in turns, the winner rolls better, the first to
 * reach the treasure at the end of the path wins. Pure numbers only (no engine, no DOM);
 * the server runs the rules and every client draws from the same values.
 */
export const BOARD_LENGTHS = [20, 35, 50] as const;
export type BoardLength = (typeof BOARD_LENGTHS)[number];
export const DEFAULT_BOARD_LENGTH: BoardLength = 35;
export const BOARD_LENGTH_NAMES: Readonly<Record<BoardLength, string>> = { 20: "Kısa", 35: "Orta", 50: "Uzun" };
export const isBoardLength = (value: unknown): value is BoardLength =>
  (BOARD_LENGTHS as readonly unknown[]).includes(value);

/** Seconds unless named otherwise. */
export const BOARD = {
  /** Data structures and pawn placement are sized for this many players (rooms hold fewer today). */
  maxPlayers: 6,
  /** Board shown before each mini game ("Sıradaki mini oyun"). */
  introSeconds: 3.5,
  /** A finished mini game's own results screen, cut short on the board. */
  miniResultsSeconds: 5,
  /** Safety net: a mini game that never reaches its results ends without a winner. */
  miniTimeoutSeconds: 420,
  /** The mini game winner's "two dice" / "+1" choice; then "two dice". */
  chooseSeconds: 10,
  /** The roll button; then the server rolls. */
  rollSeconds: 10,
  /** A disconnected player's turn is played for them after this pause. */
  awaySeconds: 1,
  diceSeconds: 1.5,
  hopSeconds: 0.25,
  /** Pause after the last hop before the next turn. */
  settleSeconds: 0.6,
  /** Winner celebration, then the lobby. */
  finishSeconds: 8,
  /** Seat grace for a board player who dropped (other modes keep RECONNECT_SECONDS). */
  reconnectSeconds: 120,
} as const;

/** Special squares (forward, back, swap, bonus die) come later; the model already carries a type. */
export const SQUARE_TYPES = ["normal"] as const;
export type SquareType = (typeof SQUARE_TYPES)[number];
export interface BoardSquare {
  index: number;
  type: SquareType;
}
/** Square 0 is the start; square `length` holds the treasure. */
export function boardSquares(length: number): BoardSquare[] {
  return Array.from({ length: length + 1 }, (_, index) => ({ index, type: "normal" as const }));
}

/** How long a roll of `steps` squares takes to show: dice, one hop per square, a pause. */
export const moveSeconds = (steps: number) => BOARD.diceSeconds + steps * BOARD.hopSeconds + BOARD.settleSeconds;
