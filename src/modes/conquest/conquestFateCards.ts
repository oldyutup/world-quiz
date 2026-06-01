/**
 * Conquest — Kader Kartı V1 catalog + pure helpers.
 *
 * V1 ships with two cards (Talih Kuşu / Lanetli Zar).  The pool is intentionally
 * small so the system is easy to validate end-to-end; future revisions may grow
 * this to a 20-30 card deck with weighted rarities — the picker is already a
 * uniform random over `FATE_CARDS`, so adding entries is a one-line change.
 *
 * Cards are server-blind: the random draw runs on whichever client issues the
 * action, the resulting card is written into `lastFateCardEvent` on
 * ConquestGameState, and every other client reads the same value back.
 *
 * No React imports here — `applyFateCardEffect` returns a fresh
 * ConquestGameState that the caller pushes through the existing
 * `conquest_apply_gameplay_state` RPC.
 */

import type { ConquestGameState, ConquestPlayerBonusState } from "./types";
import { createEmptyPlayerBonusState } from "./regionBonuses";
import { getPlayerTotalPoints } from "./regionPoints";

export type ConquestFateCardType = "good" | "bad";

/**
 * Reveal-overlay duration.  Shared by the reveal component (auto-close timer)
 * and the action-phase pause in ConquestGame (the action deadline is pushed
 * forward by exactly this amount on draw, so the move timer effectively
 * freezes for the duration of the overlay).  Keep these two consumers in
 * lockstep — bumping one without the other re-introduces the "timer keeps
 * draining behind the backdrop" bug.
 */
export const FATE_REVEAL_MS = 3000;

export interface ConquestFateCardDef {
  id:          string;
  name:        string;
  type:        ConquestFateCardType;
  /** Player-facing one-liner shown on the reveal overlay. */
  description: string;
}

/**
 * V1 catalog — keep the union small and the effects easy to reason about.
 * `applyFateCardEffect` switches on `id`, so adding a new card means appending
 * here and adding a case there.  No external order dependency.
 */
export const FATE_CARDS: ConquestFateCardDef[] = [
  {
    id:          "talih_kusu",
    name:        "Talih Kuşu",
    type:        "good",
    description: "+1 puan kazandın.",
  },
  {
    id:          "lanetli_zar",
    name:        "Lanetli Zar",
    type:        "bad",
    description: "-1 puan kaybettin.",
  },
];

export function getFateCardById(id: string): ConquestFateCardDef | null {
  return FATE_CARDS.find(c => c.id === id) ?? null;
}

/** Uniform random pick over the V1 pool.  Caller supplies the rng so tests
 *  can drive a deterministic seed; production passes `Math.random`. */
export function drawRandomFateCard(rng: () => number = Math.random): ConquestFateCardDef {
  const idx = Math.min(FATE_CARDS.length - 1, Math.max(0, Math.floor(rng() * FATE_CARDS.length)));
  return FATE_CARDS[idx];
}

/**
 * Apply a card's effect to the score model.  Scoring lives on
 * `playerBonuses[playerId].bonusPoints` so the existing scoreboard / event-
 * feed / XP surfaces pick it up unchanged.
 *
 * Talih Kuşu  → bonusPoints += 1
 * Lanetli Zar → bonusPoints -= 1, clamped so the player's visible total
 *               (regionPoints + bonusPoints) never drops below 0.  The
 *               bonusPoints field itself may legitimately go negative, matching
 *               how Suikast tracks deductions.
 *
 * Returns a fresh `playerBonuses` map; the caller assembles the next
 * ConquestGameState (so it can also write `fateCardsUsedByPlayerId` and
 * `lastFateCardEvent` atomically in the same JSONB update).
 */
export function applyFateCardEffectToBonuses(
  state:    ConquestGameState,
  playerId: string,
  cardId:   string,
): Record<string, ConquestPlayerBonusState> {
  const currentBonuses = state.playerBonuses ?? {};
  const pb = currentBonuses[playerId] ?? createEmptyPlayerBonusState();

  let delta = 0;
  if (cardId === "talih_kusu")  delta = 1;
  if (cardId === "lanetli_zar") delta = -1;

  let nextBonusPoints = pb.bonusPoints + delta;

  if (delta < 0) {
    // Visible-total floor at 0.  totalNow = regionPoints + bonusPoints, so the
    // minimum legal nextBonusPoints is -(totalNow - bonusPoints).
    const totals     = getPlayerTotalPoints(state.players, state.regionStates, state.playerBonuses);
    const totalNow   = totals[playerId] ?? 0;
    const regionPart = totalNow - pb.bonusPoints;
    const minBonus   = -regionPart;
    if (nextBonusPoints < minBonus) nextBonusPoints = minBonus;
  }

  return {
    ...currentBonuses,
    [playerId]: { ...pb, bonusPoints: nextBonusPoints },
  };
}

/** True when the player has not yet drawn their once-per-match fate card. */
export function playerCanDrawFateCard(
  state:    ConquestGameState | null | undefined,
  playerId: string | null | undefined,
): boolean {
  if (!state || !playerId)                    return false;
  if (state.phase === "finished")             return false;
  if (state.phase !== "action")               return false;
  if (state.round.actionHolderId !== playerId) return false;
  if (state.fateCardsUsedByPlayerId?.[playerId]) return false;
  return true;
}
