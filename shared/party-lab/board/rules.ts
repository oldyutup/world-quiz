/**
 * Board rules that need no state: dice, move order and mini game placements.
 * Everything takes its randomness as an argument, so tests can pin it.
 */

/** "two": two dice, the higher counts. "plus": one die + 1. "single": everyone else. */
export type DiceKind = "two" | "plus" | "single";
export type WinnerChoice = Exclude<DiceKind, "single">;
export const isWinnerChoice = (value: unknown): value is WinnerChoice => value === "two" || value === "plus";

/** A fair six-sided die (1–6). */
export type Die = () => number;
export const dieFrom = (random: () => number): Die => () => 1 + Math.min(5, Math.floor(random() * 6));

export function rollDice(kind: DiceKind, die: Die): { dice: number[]; value: number } {
  if (kind === "two") {
    const dice = [die(), die()];
    return { dice, value: Math.max(dice[0], dice[1]) };
  }
  const roll = die();
  return { dice: [roll], value: kind === "plus" ? roll + 1 : roll };
}

/**
 * Competition ranks from a per-slot score, higher is better: 0 for the best, equal scores
 * share a rank (1, 2, 2, 4 style). `null` is not in the round: −1.
 */
export function ranksByScore(scores: readonly (number | null)[]): number[] {
  return scores.map((score) =>
    score === null ? -1 : scores.filter((other) => other !== null && other > score).length
  );
}

/**
 * Per-slot ranks from per-seat values (`seats[i]` is the slot of seat i), sized for
 * `slots` entries. Seats without a value are left out (−1).
 */
export function seatRanks(seats: readonly number[], values: readonly (number | null)[], slots: number): number[] {
  const scores: (number | null)[] = Array.from({ length: slots }, () => null);
  seats.forEach((slot, seat) => {
    if (slot >= 0 && slot < slots) scores[slot] = values[seat] ?? null;
  });
  return ranksByScore(scores);
}

/**
 * Elimination rounds: still standing beats out, a later elimination beats an earlier one.
 * `outAt[slot]` is the round tick a player went out, −1 while standing; `inRound` masks slots.
 */
export function eliminationRanks(outAt: readonly number[], mask: number): number[] {
  return ranksByScore(outAt.map((tick, slot) => (mask & (1 << slot) ? (tick < 0 ? Infinity : tick) : null)));
}

/**
 * The order players roll and move in after a mini game. The winner (if any) goes first.
 * The rest follow the mode's placements when it gives them (0 best, ties share a rank);
 * a mode without full placements leaves them unranked. Within a rank the player further
 * behind on the board goes first, and players still level are ordered at random.
 */
export function moveOrder(
  slots: readonly number[],
  square: (slot: number) => number,
  winner: number,
  placements: readonly number[] | null,
  random: () => number
): number[] {
  const tie = new Map(slots.map((slot) => [slot, random()]));
  const rank = (slot: number) => {
    if (slot === winner) return -1;
    if (!placements) return 0;
    const place = placements[slot];
    return place === undefined || place < 0 ? Number.MAX_SAFE_INTEGER : place;
  };
  return [...slots].sort((a, b) => rank(a) - rank(b) || square(a) - square(b) || tie.get(a)! - tie.get(b)!);
}
