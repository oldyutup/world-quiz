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

/**
 * Square types. A special square acts only when a move ends exactly on it; the square an
 * effect sends a player to never acts (no chains). A new type (say a duel) needs an entry
 * here, a group, a place in the layout (squares.ts) and an effect (session.ts).
 */
export const SQUARE_TYPES = ["normal", "forward", "bonus", "back", "slide", "ladder", "swap"] as const;
export type SquareType = (typeof SQUARE_TYPES)[number];
export type SpecialType = Exclude<SquareType, "normal">;
export const SPECIAL_TYPES = SQUARE_TYPES.filter((type): type is SpecialType => type !== "normal");
export const isSpecialType = (value: unknown): value is SpecialType => (SPECIAL_TYPES as readonly unknown[]).includes(value);
/** Rewards and penalties are kept level on every board; swaps are neither. */
export const SQUARE_GROUPS: Readonly<Record<SpecialType, "reward" | "penalty" | "neutral">> = {
  forward: "reward",
  bonus: "reward",
  ladder: "reward",
  back: "penalty",
  slide: "penalty",
  swap: "neutral",
};
export interface BoardSquare {
  index: number;
  type: SquareType;
  /** Where the effect sends the player (İleri, Geri, Merdiven, Kaydırak), −1 otherwise. */
  target: number;
}
/** Square 0 is the start; square `length` holds the treasure. All normal: the layout adds the specials. */
export function boardSquares(length: number): BoardSquare[] {
  return Array.from({ length: length + 1 }, (_, index) => ({ index, type: "normal" as const, target: -1 }));
}

/** Special square effects (seconds unless named). */
export const EFFECT = {
  /** İleri / Geri move this many squares (Geri never below the start). */
  forward: 3,
  back: 3,
  /** The square lights up and the HUD names the effect before anything moves. */
  leadSeconds: 0.6,
  /** İleri / Geri: one hop per square. */
  hopSeconds: 0.22,
  climbSeconds: 1.3,
  slideSeconds: 1.0,
  swapSeconds: 1.1,
  /** A bonus die, or a swap with nobody to swap with: the notice alone. */
  stillSeconds: 0.8,
  settleSeconds: 0.6,
} as const;
/** What an effect looks like on the wire and to the clock (see BoardEffect). */
export interface EffectMotion {
  type: SpecialType;
  from: number;
  to: number;
  /** Swap partner, −1 for none. */
  other: number;
}
/** Seconds the pieces travel during an effect (after the lead). */
export function effectTravelSeconds(effect: EffectMotion) {
  switch (effect.type) {
    case "forward":
    case "back":
      return Math.abs(effect.to - effect.from) * EFFECT.hopSeconds;
    case "ladder":
      return EFFECT.climbSeconds;
    case "slide":
      return EFFECT.slideSeconds;
    case "swap":
      return effect.other >= 0 ? EFFECT.swapSeconds : EFFECT.stillSeconds;
    case "bonus":
      return EFFECT.stillSeconds;
  }
}
/** How long the server holds an effect before the next turn: lead, travel, a pause. */
export const effectSeconds = (effect: EffectMotion) => EFFECT.leadSeconds + effectTravelSeconds(effect) + EFFECT.settleSeconds;

/** How long a roll of `steps` squares takes to show: dice, one hop per square, a pause. */
export const moveSeconds = (steps: number) => BOARD.diceSeconds + steps * BOARD.hopSeconds + BOARD.settleSeconds;
