/**
 * Conquest — Kader Kartı V2 catalog + pure helpers.
 *
 * V2 expands the pool to 13 cards (7 good / 6 bad) while keeping the system
 * intentionally conservative — every effect collapses to one of two safe
 * primitives:
 *   • bonusPoints delta on `playerBonuses[playerId]` (clamped so the visible
 *     total can never go below 0).
 *   • actionEndsAt delta on `round`, floored at FATE_REVEAL_MS + 5000ms of
 *     remaining time so a "time loss" card can't strand the holder with no
 *     usable move window.
 *
 * Cards that originally had richer ideas in the design doc (next-correct-
 * answer bonus, shield against the next bad card, region-point grant) were
 * simplified to a flat +1 bonusPoints for this V2 — stability first; the
 * effect copy still reads naturally, and the unique behaviours can be
 * layered back in later without touching the catalog shape.
 *
 * Exception: `bolge_kalkani` (V2.1) is a placement-style card — it has no
 * bonusPoints / time delta of its own.  `getCardPointDelta` returns 0 and
 * `applyFateCardEffectToRound` is a no-op for it; the actual effect (stamp
 * `shielded:true` on a self-owned region) is wired into the draw flow in
 * `ConquestGame.tsx` via a local selection mode that mirrors the Pusu
 * placement pattern.  No new state field — reuses `ConquestRegionState.shielded`
 * which already drives the duel intercept (shield consumed on attacker-win).
 *
 * Random draw is category-first: a coin flip picks good vs bad (always
 * 50/50, independent of pool sizes), then a uniform pick within the chosen
 * pool selects the card.  Adding/removing cards stays a one-line change
 * here; the picker, reveal overlay, and event feed pick it up unchanged.
 * The "%50 iyi, %50 kötü" widget promise is now algorithmic rather than
 * incidental, so the catalog no longer has to be hand-balanced 6/6 to keep
 * the contract honest.
 *
 * Cards are server-blind: the random draw runs on whichever client issues
 * the action, the resulting card is written into `lastFateCardEvent` on
 * ConquestGameState, and every other client reads the same value back.
 *
 * No React imports here — `applyFateCardEffectToBonuses` /
 * `applyFateCardEffectToRound` return fresh slices that the caller
 * assembles into the next ConquestGameState and pushes through the existing
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

/**
 * Minimum remaining action time (after the reveal closes) that a "time loss"
 * card is allowed to leave behind.  Sis Çöktü subtracts 5s but never below
 * this floor, so the holder always has at least one usable move window.
 */
const FATE_TIME_FLOOR_MS = 5000;

/** "Son Hamle" extra action time, added on top of the reveal pause. */
const FATE_TIME_GAIN_MS = 5000;

/** "Sis Çöktü" action-time penalty (subject to the floor above). */
const FATE_TIME_LOSS_MS = 5000;

/**
 * "Moral Üstünlüğü" next-move bonus.  Layered onto
 * `playerBonuses[playerId].extraNextMoveMs` via Math.max so that a pending
 * Karadeniz bonus (+5s) is preserved if it's already larger.  Consumed by
 * `consumeMoveTimeBonus` when the holder's next action phase starts — same
 * channel Karadeniz uses, so the chip render and one-shot reset come for
 * free.  Distinct from `son_hamle`, which extends the CURRENT action's
 * `actionEndsAt` immediately.
 */
const FATE_NEXT_MOVE_GAIN_MS = 3000;

export interface ConquestFateCardDef {
  id:          string;
  name:        string;
  type:        ConquestFateCardType;
  /** Player-facing one-liner shown on the reveal overlay. */
  description: string;
}

/**
 * V2 catalog — 13 cards, 7 good / 6 bad.  Each effect is dispatched by `id`
 * in the helpers below; adding a card means appending here and registering
 * a delta in `getCardPointDelta` (and/or a branch in
 * `applyFateCardEffectToRound`).  No external order dependency.
 */
export const FATE_CARDS: ConquestFateCardDef[] = [
  // ── Good ────────────────────────────────────────────────────────────
  {
    id:          "talih_kusu",
    name:        "Talih Kuşu",
    type:        "good",
    description: "+1 puan ve +50 Gold kazandın.",
  },
  {
    id:          "hazine_sandigi",
    name:        "Hazine Sandığı",
    type:        "good",
    description: "+2 puan ve +100 Gold kazandın.",
  },
  {
    id:          "moral_ustunlugu",
    name:        "Moral Üstünlüğü",
    type:        "good",
    description: "+1 puan kazandın. Sıradaki hamlende +3 saniye avantaj.",
  },
  {
    id:          "son_hamle",
    name:        "Son Hamle",
    type:        "good",
    description: "Hamle sürene +5 saniye eklendi.",
  },
  {
    id:          "sinir_destegi",
    name:        "Sınır Desteği",
    type:        "good",
    description: "Komşu olduğun boş bir bölgeye Sınır Karakolu kurarsın. Rakip saldırırsa bölgeyi doğrudan alamaz; seninle düello yapmak zorunda kalır.",
  },
  {
    id:          "kalkan",
    name:        "Muhafız Desteği",
    type:        "good",
    description: "Muhafız desteği geldi. +1 puan.",
  },
  {
    id:          "bolge_kalkani",
    name:        "Bölge Kalkanı",
    type:        "good",
    description: "Kendi bölgelerinden birine kalkan bas. Rakibin ilk başarılı saldırısı bölgeyi ele geçiremez, kalkan kırılır.",
  },

  // ── Bad ─────────────────────────────────────────────────────────────
  {
    id:          "lanetli_zar",
    name:        "Lanetli Zar",
    type:        "bad",
    description: "-1 puan kaybettin.",
  },
  {
    id:          "vergi_baskini",
    name:        "Vergi Baskını",
    type:        "bad",
    description: "Vergi baskını yaşandı. -2 puan.",
  },
  {
    id:          "sis_coktu",
    name:        "Sis Çöktü",
    type:        "bad",
    description: "Sis çöktü. Hamle süren 5 saniye azaldı.",
  },
  {
    id:          "kara_haber",
    name:        "Kara Haber",
    type:        "bad",
    description: "Kara haber geldi. -1 puan.",
  },
  {
    id:          "ters_ruzgar",
    name:        "Ters Rüzgar",
    type:        "bad",
    description: "Ters rüzgar esti. -1 puan.",
  },
  {
    id:          "ic_karisiklik",
    name:        "İç Karışıklık",
    type:        "bad",
    description: "İç karışıklık çıktı. -1 puan.",
  },
];

export function getFateCardById(id: string): ConquestFateCardDef | null {
  return FATE_CARDS.find(c => c.id === id) ?? null;
}

/**
 * Category-first random pick.  First rng() call selects the category with a
 * fixed 50/50 split (good vs bad), independent of the catalog's good/bad
 * counts.  Second rng() call picks uniformly within the chosen category's
 * pool.  This makes the widget's "%50 iyi, %50 kötü" promise algorithmic
 * rather than incidental: adding more cards in one category dilutes that
 * category's per-card probability but keeps the category-level odds at 50/50.
 *
 * With today's 6 good / 6 bad catalog every card still resolves to 1/12
 * end-to-end (0.5 * 1/6), so the V2 balance is statistically unchanged from
 * the prior uniform-over-pool draw.  Tests that pinned a deterministic seed
 * may surface different cards, since the rng is now consumed up to twice
 * per draw instead of once — the `rng` parameter is still the only knob.
 *
 * Fallback: if either category pool is empty (e.g. catalog edited so that
 * one side has no cards), the picker degrades to uniform-over-pool over the
 * whole catalog — matching the prior behaviour so the player is never
 * stuck.  This consumes the rng exactly once.  Throws only if FATE_CARDS
 * itself is empty, which would already have produced `undefined` under the
 * old code and indicates a packaging bug, not a runtime condition.
 */
export function drawRandomFateCard(rng: () => number = Math.random): ConquestFateCardDef {
  const goodCards = FATE_CARDS.filter(c => c.type === "good");
  const badCards  = FATE_CARDS.filter(c => c.type === "bad");

  if (goodCards.length === 0 || badCards.length === 0) {
    if (FATE_CARDS.length === 0) {
      throw new Error("FATE_CARDS catalog is empty");
    }
    const idx = Math.min(FATE_CARDS.length - 1, Math.max(0, Math.floor(rng() * FATE_CARDS.length)));
    return FATE_CARDS[idx];
  }

  const pool = rng() < 0.5 ? goodCards : badCards;
  const idx  = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[idx];
}

/**
 * Point delta for cards that resolve to a flat bonusPoints change.  Time-
 * effect cards (`son_hamle`, `sis_coktu`) return 0 here — their effect lives
 * in `applyFateCardEffectToRound` instead.  Unknown ids return 0 so a future
 * client running an older catalog can no-op gracefully.
 */
function getCardPointDelta(cardId: string): number {
  switch (cardId) {
    // Good
    case "talih_kusu":      return +1;
    case "hazine_sandigi":  return +2;
    case "moral_ustunlugu": return +1;
    // sinir_destegi → placement card; no bonusPoints delta.  Effect lives in
    // the ConquestGame.tsx selection mode that stamps borderOutpostOwnerId
    // on a neutral neighbour region.
    case "kalkan":          return +1;
    // Bad
    case "lanetli_zar":     return -1;
    case "vergi_baskini":   return -2;
    case "kara_haber":      return -1;
    case "ters_ruzgar":     return -1;
    case "ic_karisiklik":   return -1;
    // Time cards & unknowns
    default:                return 0;
  }
}

/**
 * Apply a card's bonusPoints effect to the score model.  Scoring lives on
 * `playerBonuses[playerId].bonusPoints` so the existing scoreboard / event-
 * feed / XP surfaces pick it up unchanged.
 *
 * Positive deltas (Talih Kuşu, Hazine Sandığı, Moral Üstünlüğü, Kalkan)
 * add straight.  Negative deltas (Lanetli Zar, Vergi
 * Baskını, Kara Haber, Ters Rüzgar, İç Karışıklık) are clamped so the
 * player's visible total (regionPoints + bonusPoints) never drops below 0.
 * The bonusPoints field itself may legitimately go negative, matching how
 * Suikast tracks deductions.
 *
 * Time-effect cards (Son Hamle / Sis Çöktü) resolve to delta=0 and pass
 * through unchanged — see `applyFateCardEffectToRound` for those.
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

  const delta = getCardPointDelta(cardId);
  if (delta === 0) return currentBonuses;

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

/**
 * Apply a card's time effect to the action round.  The caller is expected to
 * have ALREADY bumped `round.actionEndsAt` (and `actionStartedAt`) by
 * FATE_REVEAL_MS for the reveal pause — this helper layers the card-specific
 * delta on top of that.
 *
 * Son Hamle → +FATE_TIME_GAIN_MS to actionEndsAt.
 * Sis Çöktü → -FATE_TIME_LOSS_MS to actionEndsAt, floored so the holder
 *             still has at least FATE_TIME_FLOOR_MS of move time AFTER the
 *             reveal overlay closes (i.e. nextEndsAt >= now + FATE_REVEAL_MS
 *             + FATE_TIME_FLOOR_MS).
 *
 * No-op for non-time cards, for non-action phases, or when actionEndsAt is
 * missing — those cases pass `round` through unchanged.
 */
export function applyFateCardEffectToRound(
  round:  ConquestGameState["round"],
  phase:  ConquestGameState["phase"],
  cardId: string,
  now:    number,
): ConquestGameState["round"] {
  if (phase !== "action")                       return round;
  if (typeof round.actionEndsAt !== "number")   return round;

  if (cardId === "son_hamle") {
    return { ...round, actionEndsAt: round.actionEndsAt + FATE_TIME_GAIN_MS };
  }
  if (cardId === "sis_coktu") {
    const minEndsAt  = now + FATE_REVEAL_MS + FATE_TIME_FLOOR_MS;
    const nextEndsAt = Math.max(round.actionEndsAt - FATE_TIME_LOSS_MS, minEndsAt);
    return { ...round, actionEndsAt: nextEndsAt };
  }
  return round;
}

/**
 * Apply a card's next-move time effect to `playerBonuses[playerId].extraNextMoveMs`.
 *
 * Moral Üstünlüğü → Math.max(prev, FATE_NEXT_MOVE_GAIN_MS).  We deliberately
 * do NOT overwrite (the Karadeniz pattern) because the two sources share the
 * same channel: if a player already has Karadeniz's +5s pending and draws
 * Moral Üstünlüğü, a flat overwrite would silently DOWNGRADE their bonus to
 * +3s.  Math.max keeps whichever is larger.  Either way `consumeMoveTimeBonus`
 * resets the field to 0 after the next action phase starts, so there is no
 * leak across rounds.
 *
 * No-op for any other card id (the caller passes the drawn card unconditionally).
 *
 * Returns a fresh `playerBonuses` map.  Caller should chain this AFTER
 * `applyFateCardEffectToBonuses` so a single card that touches both
 * `bonusPoints` and `extraNextMoveMs` lands atomically on the same pb entry.
 */
export function applyFateCardEffectToNextMove(
  state:    ConquestGameState,
  playerId: string,
  cardId:   string,
): Record<string, ConquestPlayerBonusState> {
  const currentBonuses = state.playerBonuses ?? {};
  if (cardId !== "moral_ustunlugu") return currentBonuses;

  const pb        = currentBonuses[playerId] ?? createEmptyPlayerBonusState();
  const nextExtra = Math.max(pb.extraNextMoveMs, FATE_NEXT_MOVE_GAIN_MS);
  if (nextExtra === pb.extraNextMoveMs) return currentBonuses;

  return {
    ...currentBonuses,
    [playerId]: { ...pb, extraNextMoveMs: nextExtra },
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
  // Eliminated players cannot draw — defensive, since they can't become
  // action holder anyway once their region count hits 0.
  if ((state.eliminatedPlayerIds ?? []).includes(playerId)) return false;
  return true;
}
