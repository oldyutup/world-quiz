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

import type {
  ConquestGameState,
  ConquestPlayerBonusState,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";
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
 *
 * V2 split: the overlay sequences a short intro slate ("Kader Kartı çekildi!")
 * for FATE_REVEAL_INTRO_MS, then crossfades into the viewer-aware detail
 * slate for the remainder.  The total stays = FATE_REVEAL_MS so the
 * action-clock freeze math is unchanged — the action handler still bumps
 * `actionStartedAt`/`actionEndsAt` by exactly FATE_REVEAL_MS, the host's
 * auto-skip timeout shifts by the same amount, and the Sis Çöktü floor
 * (`now + FATE_REVEAL_MS + 5000`) scales automatically.
 */
export const FATE_REVEAL_MS       = 3500;
/** Length of the dramatic intro slate before the detail card swaps in. */
export const FATE_REVEAL_INTRO_MS = 1200;

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
    description: "+1 puan ve tek kullanımlık kalkan bypass hakkı. Bir sonraki kalkanlı bölge saldırında kalkanı aşarsın.",
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
    description: "Vergi baskını! -2 puan ve en fazla -100 Gold.",
  },
  {
    id:          "sis_coktu",
    name:        "Sis Çöktü",
    type:        "bad",
    description: "Kör harita etkisi yakında aktif olacak.",
  },
  {
    id:          "kara_haber",
    name:        "Kara Haber",
    type:        "bad",
    description: "Kara haber geldi. Aktif bir bonusunu kaybedersin; bonusun yoksa -1 puan.",
  },
  {
    id:          "ters_ruzgar",
    name:        "Ters Rüzgar",
    type:        "bad",
    description: "Ters rüzgar çıktı. Bu hamlede -5 saniye.",
  },
  {
    id:          "ic_karisiklik",
    name:        "İç Karışıklık",
    type:        "bad",
    description: "İç karışıklık çıktı. Rastgele bir bölgen tarafsıza düşer; bölgen yoksa -1 puan.",
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
    // ters_ruzgar    → time-effect card (see applyFateCardEffectToRound);
    // sis_coktu      → currently a no-op (kör harita V2'ye ertelendi);
    // kara_haber     → bonus-loss card; -1 puan only as fallback when the
    //                  drawer has no removable bonus (see
    //                  applyFateCardEffectToBonusLoss +
    //                  applyKaraHaberFallbackPointLoss).
    // ic_karisiklik  → region-loss card; -1 puan only as fallback when the
    //                  drawer has no owned regions (see
    //                  applyFateCardEffectToRebellion +
    //                  applyIcKarisiklikFallbackPointLoss).
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
 * add straight.  Negative deltas (Lanetli Zar, Vergi Baskını, Kara Haber,
 * İç Karışıklık) are clamped so the player's visible total (regionPoints +
 * bonusPoints) never drops below 0.  The bonusPoints field itself may
 * legitimately go negative, matching how Suikast tracks deductions.
 *
 * Time-effect cards (Son Hamle / Ters Rüzgar) and the V1 no-op (Sis Çöktü)
 * resolve to delta=0 and pass through unchanged — see
 * `applyFateCardEffectToRound` for the time path.
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
 * Son Hamle   → +FATE_TIME_GAIN_MS to actionEndsAt.
 * Ters Rüzgar → -FATE_TIME_LOSS_MS to actionEndsAt, floored so the holder
 *               still has at least FATE_TIME_FLOOR_MS of move time AFTER the
 *               reveal overlay closes (i.e. nextEndsAt >= now + FATE_REVEAL_MS
 *               + FATE_TIME_FLOOR_MS).  Inherited verbatim from the prior
 *               Sis Çöktü branch; same floor math keeps the holder with a
 *               usable move window after the reveal closes.
 *
 * Sis Çöktü   → no-op in V1.  The kör-harita rework is deferred to V2; the
 *               card draws and the reveal/event-feed copy reads "yakında
 *               aktif olacak" so the catalog entry stays in the rotation
 *               without a stand-in time penalty.
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
  if (cardId === "ters_ruzgar") {
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

/**
 * Apply a card's open-shield bypass effect to
 * `playerBonuses[playerId].guardianShieldBypassCharges`.
 *
 * Muhafız Desteği (kalkan) → Math.max(prev, 1).  Defensive overwrite-not-stack
 * since the card is once-per-match (`fateCardsUsedByPlayerId` gates re-draws),
 * so in practice the charge cannot stack — Math.max keeps the floor at 1 if a
 * future change ever opens up a stacking path without re-thinking the flag.
 * Consumed by gameplay's `consumeGuardianShieldBypassCharge` at duel start
 * the moment the holder commits an attack against an open-shielded opponent
 * region (see conquestGameplay.ts).
 *
 * No-op for any other card id.  Returns a fresh `playerBonuses` map.  Caller
 * should chain this AFTER `applyFateCardEffectToBonuses` so a single card
 * that touches both `bonusPoints` and the bypass charge lands atomically on
 * the same pb entry.
 */
export function applyFateCardEffectToShieldBypass(
  state:    ConquestGameState,
  playerId: string,
  cardId:   string,
): Record<string, ConquestPlayerBonusState> {
  const currentBonuses = state.playerBonuses ?? {};
  if (cardId !== "kalkan") return currentBonuses;

  const pb        = currentBonuses[playerId] ?? createEmptyPlayerBonusState();
  const prev      = pb.guardianShieldBypassCharges ?? 0;
  const nextCharge = Math.max(prev, 1);
  if (nextCharge === prev) return currentBonuses;

  return {
    ...currentBonuses,
    [playerId]: { ...pb, guardianShieldBypassCharges: nextCharge },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kara Haber V1 — bonus-loss helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of `applyFateCardEffectToBonusLoss`.  When `removedAny` is true the
 * bonusKey/Label pair identifies which slot was zeroed so the caller can
 * forward it into `lastFateCardEvent` for viewer-aware copy.  When false the
 * `playerBonuses` map is returned unchanged — the caller is expected to apply
 * the Kara Haber -1 fallback via `applyKaraHaberFallbackPointLoss`.
 */
export interface ConquestFateCardBonusLossResult {
  playerBonuses:     Record<string, ConquestPlayerBonusState>;
  removedAny:        boolean;
  removedBonusKey?:  string;
  removedBonusLabel?: string;
}

interface KaraHaberCandidate {
  key:   string;
  label: string;
  apply: (pb: ConquestPlayerBonusState) => ConquestPlayerBonusState;
}

/**
 * Apply Kara Haber's bonus-loss effect.  Scans the drawer's
 * `playerBonuses[playerId]` slot for active charges and zeroes one at random.
 *
 * V1 silinebilir bonus havuzu (önce-pozitif olanlar; field semantik olarak
 * "var/yok"):
 *   - mancinikCharges              → "Mancınık Hakkı"
 *   - eliminatorCharges            → "Eleme Hakkı"
 *   - guardianShieldBypassCharges  → "Muhafız Desteği"
 *   - pendingHiddenShield (true)   → "Gizli Kalkan"
 *   - extraNextMoveMs > 0          → "Ekstra Süre"
 *
 * Intentionally OUT of scope for V1: `bonusPoints` (kümülatif skor),
 * `cukurovaClaimed` (legacy lock), `matchGoldEarned` (sadece kazanç log'u),
 * `playerHiddenBonuses` (ayrı inventory kanalı), ve bölgeye bağlı tüm
 * bonuslar (`shielded`, `borderOutpostOwnerId`, `hiddenShieldOwnerId`,
 * `limanIncomeTicks`, `bereketHarvestTurns`, `mevziProtectionClaimedBy`).
 *
 * Non-Kara-Haber card ids are no-ops (returns `playerBonuses` unchanged,
 * `removedAny: false`) so the caller can chain unconditionally on every draw.
 *
 * Pure — input is not mutated; a fresh playerBonuses map is returned when
 * something changes, otherwise the input reference is passed through.  RNG
 * defaults to `Math.random`; the seeded variant is available for tests but
 * draws don't need determinism since the result is replicated via
 * `lastFateCardEvent`.
 *
 * Fallback (no candidate found): caller MUST call
 * `applyKaraHaberFallbackPointLoss` to apply the -1 puan with the same
 * visible-total-floor clamp as `applyFateCardEffectToBonuses`.
 */
export function applyFateCardEffectToBonusLoss(
  playerBonuses: Record<string, ConquestPlayerBonusState> | undefined,
  playerId:      string,
  cardId:        string,
  rng:           () => number = Math.random,
): ConquestFateCardBonusLossResult {
  const currentBonuses = playerBonuses ?? {};
  if (cardId !== "kara_haber") {
    return { playerBonuses: currentBonuses, removedAny: false };
  }

  const pb = currentBonuses[playerId] ?? createEmptyPlayerBonusState();
  const candidates: KaraHaberCandidate[] = [];

  if ((pb.mancinikCharges ?? 0) > 0) {
    candidates.push({
      key:   "mancinikCharges",
      label: "Mancınık Hakkı",
      apply: p => ({ ...p, mancinikCharges: 0 }),
    });
  }
  if ((pb.eliminatorCharges ?? 0) > 0) {
    candidates.push({
      key:   "eliminatorCharges",
      label: "Eleme Hakkı",
      apply: p => ({ ...p, eliminatorCharges: 0 }),
    });
  }
  if ((pb.guardianShieldBypassCharges ?? 0) > 0) {
    candidates.push({
      key:   "guardianShieldBypassCharges",
      label: "Muhafız Desteği",
      apply: p => ({ ...p, guardianShieldBypassCharges: 0 }),
    });
  }
  if (pb.pendingHiddenShield === true) {
    candidates.push({
      key:   "pendingHiddenShield",
      label: "Gizli Kalkan",
      apply: p => ({ ...p, pendingHiddenShield: false }),
    });
  }
  if ((pb.extraNextMoveMs ?? 0) > 0) {
    candidates.push({
      key:   "extraNextMoveMs",
      label: "Ekstra Süre",
      apply: p => ({ ...p, extraNextMoveMs: 0 }),
    });
  }

  if (candidates.length === 0) {
    return { playerBonuses: currentBonuses, removedAny: false };
  }

  const idx = Math.min(
    candidates.length - 1,
    Math.max(0, Math.floor(rng() * candidates.length)),
  );
  const picked = candidates[idx];

  return {
    playerBonuses: {
      ...currentBonuses,
      [playerId]: picked.apply(pb),
    },
    removedAny:        true,
    removedBonusKey:   picked.key,
    removedBonusLabel: picked.label,
  };
}

/**
 * Shared visible-total-floor clamp used by both Kara Haber and İç Karışıklık
 * fallback paths.  Mirrors the clamp in `applyFateCardEffectToBonuses`: the
 * player's visible total (regionPoints + bonusPoints) never drops below 0;
 * `bonusPoints` itself may go negative (Suikast pattern).
 *
 * Pure — returns a fresh playerBonuses map.  Private so the two exported
 * fallbacks present distinct, intention-revealing names without diverging
 * on the math.
 */
function applyClampedBonusPointDelta(
  state:    ConquestGameState,
  playerId: string,
  delta:    number,
): Record<string, ConquestPlayerBonusState> {
  const currentBonuses = state.playerBonuses ?? {};
  const pb = currentBonuses[playerId] ?? createEmptyPlayerBonusState();

  let nextBonusPoints = pb.bonusPoints + delta;
  if (delta < 0) {
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
 * Kara Haber fallback — apply -1 bonusPoints with the visible-total-floor
 * clamp.  Caller invokes this only when `applyFateCardEffectToBonusLoss`
 * returned `removedAny: false` for a Kara Haber draw (i.e. the drawer had
 * no removable bonus).  Pure — returns a fresh playerBonuses map.
 */
export function applyKaraHaberFallbackPointLoss(
  state:    ConquestGameState,
  playerId: string,
): Record<string, ConquestPlayerBonusState> {
  return applyClampedBonusPointDelta(state, playerId, -1);
}

// ─────────────────────────────────────────────────────────────────────────────
// İç Karışıklık V1 — region-loss helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of `applyFateCardEffectToRebellion`.  When `droppedAny` is true the
 * `affectedRegionId` identifies the region that rebelled (caller resolves the
 * display label from mapConfig and forwards both onto `lastFateCardEvent`).
 * When false the `regionStates` array is returned reference-equal — the
 * caller is expected to apply the -1 puan fallback via
 * `applyIcKarisiklikFallbackPointLoss`.
 */
export interface ConquestFateCardRebellionResult {
  regionStates:      ConquestRegionState[];
  droppedAny:        boolean;
  affectedRegionId?: ConquestRegionId;
}

/**
 * Apply İç Karışıklık's region-loss effect.  Scans the drawer's owned regions
 * and drops one (uniform random) to neutral.  Intentionally NOT a capture —
 * this helper does not route through `flipOwnership` or `applyActionToGame`,
 * so capture-side chains (mevzi protection, koçbaşı, hidden bonus claim,
 * border outpost, point award to opponent) are all skipped.  Pure on
 * `regionStates`; no mutation, fresh array on the dropped region.
 *
 * Non-İç-Karışıklık card ids are no-ops (returns the input reference,
 * `droppedAny: false`) so the caller can chain unconditionally on every draw.
 *
 * Fields cleared on the dropped region (every alan structurally tied to the
 * previous owner):
 *   - ownerPlayerId        → null
 *   - shielded             → false   (open shield was owner's defense)
 *   - borderOutpostOwnerId → undefined (Sınır Karakolu binası sahibi kaybetti)
 *   - hiddenShieldOwnerId  → undefined (Ankara Gizli Op sahibinindi)
 *   - hiddenShieldKind     → undefined (paired with hiddenShieldOwnerId)
 *   - limanIncomeTicks     → 0       (per-tenure counter; new tenant restarts)
 *   - bereketHarvestTurns  → 0       (per-tenure counter)
 *
 * Fields intentionally preserved (history / per-region anti-farm log):
 *   - lastCapturedBy
 *   - turnCaptured
 *   - captureCount
 *   - mevziProtectionClaimedBy   (matches flipOwnership policy — same field
 *                                 is not reset on capture either)
 *
 * Fallback (no owned regions): caller MUST call
 * `applyIcKarisiklikFallbackPointLoss` to apply the -1 puan with the same
 * visible-total-floor clamp as Kara Haber's fallback.
 *
 * RNG defaults to `Math.random`; result is replicated to every client via
 * `lastFateCardEvent.affectedRegionId` so the rebellion target stays
 * consistent across viewers.
 */
export function applyFateCardEffectToRebellion(
  regionStates: ConquestRegionState[],
  playerId:     string,
  cardId:       string,
  rng:          () => number = Math.random,
): ConquestFateCardRebellionResult {
  if (cardId !== "ic_karisiklik") {
    return { regionStates, droppedAny: false };
  }

  const ownedIndices: number[] = [];
  for (let i = 0; i < regionStates.length; i++) {
    if (regionStates[i].ownerPlayerId === playerId) ownedIndices.push(i);
  }

  if (ownedIndices.length === 0) {
    return { regionStates, droppedAny: false };
  }

  const pick     = Math.min(
    ownedIndices.length - 1,
    Math.max(0, Math.floor(rng() * ownedIndices.length)),
  );
  const targetIdx      = ownedIndices[pick];
  const affectedRegion = regionStates[targetIdx].regionId;

  const nextRegionStates = regionStates.map((rs, i) => {
    if (i !== targetIdx) return rs;
    return {
      ...rs,
      ownerPlayerId:        null,
      shielded:             false,
      borderOutpostOwnerId: undefined,
      hiddenShieldOwnerId:  undefined,
      hiddenShieldKind:     undefined,
      limanIncomeTicks:     0,
      bereketHarvestTurns:  0,
    };
  });

  return {
    regionStates:     nextRegionStates,
    droppedAny:       true,
    affectedRegionId: affectedRegion,
  };
}

/**
 * İç Karışıklık fallback — apply -1 bonusPoints with the visible-total-floor
 * clamp.  Caller invokes this only when `applyFateCardEffectToRebellion`
 * returned `droppedAny: false` for an İç Karışıklık draw (drawer had no
 * owned regions).  Pure — returns a fresh playerBonuses map.
 */
export function applyIcKarisiklikFallbackPointLoss(
  state:    ConquestGameState,
  playerId: string,
): Record<string, ConquestPlayerBonusState> {
  return applyClampedBonusPointDelta(state, playerId, -1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewer-aware copy — V2 reveal + event-feed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output of `getFateCardViewerCopy` — a small {title, detail} pair the reveal
 * overlay and the event feed share.  `title` is always the card's display
 * name (matches what the catalog renders elsewhere); `detail` is the
 * viewer-aware sentence ("kazandın" for the drawer, "kazandı" for everyone
 * else).  Two fields rather than one so the renderer can format them
 * independently — the reveal stacks title above detail in different
 * typographic weights; the event feed combines them on one line for the
 * actor and falls through to `detail` alone for the opponent (whose detail
 * already starts with the actor name and so doesn't need the title prefix).
 */
export interface ConquestFateCardViewerCopy {
  title:  string;
  detail: string;
}

export interface ConquestFateCardViewerCopyContext {
  /** Display name of the player who drew the card.  Used in opponent-view
   *  copy ("Ahmet Talih Kuşu ile +1 puan kazandı.").  Defaults to "Rakibin"
   *  when omitted — exceedingly unlikely since the event always carries
   *  `playerName`, but cheap insurance against a future caller that passes
   *  only the cardId. */
  actorName?: string;
  /**
   * Kara Haber V1 — player-facing label of the consumed bonus
   * (e.g. "Mancınık Hakkı") when the draw actually removed a bonus.  Forward
   * `lastFateCardEvent.removedBonusLabel` verbatim.  When absent for a
   * Kara Haber draw, the helper falls through to the fallback / defensive
   * branch depending on `karaHaberFallbackPointLoss`.
   */
  removedBonusLabel?: string;
  /**
   * Kara Haber V1 — true when the draw fell through to the -1 puan fallback
   * (drawer had no removable bonus).  Forward
   * `lastFateCardEvent.karaHaberFallbackPointLoss` verbatim.  When true and
   * `removedBonusLabel` is absent, the helper renders the "kaybedecek aktif
   * bonusun yoktu" variant.
   */
  karaHaberFallbackPointLoss?: boolean;
  /**
   * İç Karışıklık V1 — display label of the rebelled region (e.g. "Çukurova").
   * Forward `lastFateCardEvent.affectedRegionName` verbatim.  When present,
   * the helper renders the "{regionName} bölgende isyan çıktı" copy variant.
   */
  affectedRegionName?: string;
  /**
   * İç Karışıklık V1 — true when the draw fell through to the -1 puan
   * fallback (drawer had no owned regions).  Forward
   * `lastFateCardEvent.icKarisiklikFallbackPointLoss` verbatim.  When true
   * and `affectedRegionName` is absent, the helper renders the "kaybedecek
   * bölgen yoktu" variant.
   */
  icKarisiklikFallbackPointLoss?: boolean;
}

/**
 * Viewer-aware copy for a fate-card draw event.
 *
 * `viewerIsActor` lets the renderer pick between 2nd-person ("kazandın",
 * "hamlende") and 3rd-person ("kazandı", "hamlesinde") copy without
 * re-deriving the comparison everywhere the event surfaces.  The catalog
 * `description` strings stay 2nd-person and are intentionally left
 * untouched — older code paths and any future surfaces that want a
 * single-perspective sentence still get a sensible fallback.
 *
 * Unknown card ids fall through to the catalog description so a client
 * running an older catalog against a newer event continues to render a
 * non-empty sentence (the opponent variant still prefixes the actor name).
 *
 * Pure — no React imports, no time reads, no randomness.  Safe to call from
 * the event-feed hook, the reveal component, and any future surface that
 * needs to display a draw event.
 */
export function getFateCardViewerCopy(
  cardId:        string,
  viewerIsActor: boolean,
  ctx?:          ConquestFateCardViewerCopyContext,
): ConquestFateCardViewerCopy {
  const def       = getFateCardById(cardId);
  const cardName  = def?.name ?? cardId;
  // Defensive fallback for missing actorName.  Subject case ("Rakip") so the
  // opponent-view template ("${actorName} Talih Kuşu ile … kazandı.") reads
  // as grammatical Turkish.  An earlier revision used the possessive form
  // ("Rakibin") which produced "Rakibin Talih Kuşu ile … kazandı." — parses
  // as "your opponent's Talih Kuşu won" rather than "a rival won via …".
  // In practice never hits since the event always carries playerName.
  const actorName = ctx?.actorName ?? "Rakip";

  switch (cardId) {
    // ── Good ────────────────────────────────────────────────────────────
    case "talih_kusu":
      return viewerIsActor
        ? { title: cardName, detail: "+1 puan ve +50 Gold kazandın." }
        : { title: cardName, detail: `${actorName} Talih Kuşu ile +1 puan ve +50 Gold kazandı.` };

    case "hazine_sandigi":
      return viewerIsActor
        ? { title: cardName, detail: "+2 puan ve +100 Gold kazandın." }
        : { title: cardName, detail: `${actorName} Hazine Sandığı ile +2 puan ve +100 Gold kazandı.` };

    case "moral_ustunlugu":
      return viewerIsActor
        ? { title: cardName, detail: "+1 puan kazandın. Sıradaki hamlende +3 saniye avantaj alacaksın." }
        : { title: cardName, detail: `${actorName} Moral Üstünlüğü ile +1 puan kazandı. Sıradaki hamlesinde +3 saniye avantaj alacak.` };

    case "son_hamle":
      return viewerIsActor
        ? { title: cardName, detail: "Bu hamle için +5 saniye kazandın." }
        : { title: cardName, detail: `${actorName} Son Hamle ile bu hamle için +5 saniye kazandı.` };

    case "sinir_destegi":
      return viewerIsActor
        ? { title: cardName, detail: "Komşu olduğun boş bir bölgeye Sınır Karakolu kurabilirsin." }
        : { title: cardName, detail: `${actorName} Sınır Desteği çekti. Komşu boş bir bölgeye Sınır Karakolu kurabilecek.` };

    case "kalkan":
      return viewerIsActor
        ? { title: cardName, detail: "+1 puan kazandın. Bir sonraki kalkanlı bölge saldırında kalkanı aşabilirsin." }
        : { title: cardName, detail: `${actorName} Muhafız Desteği ile +1 puan kazandı ve bir kalkan bypass hakkı aldı.` };

    case "bolge_kalkani":
      return viewerIsActor
        ? { title: cardName, detail: "Kendi bölgelerinden birine kalkan yerleştirebilirsin." }
        : { title: cardName, detail: `${actorName} Bölge Kalkanı çekti. Bir bölgesine kalkan yerleştirecek.` };

    // ── Bad ─────────────────────────────────────────────────────────────
    case "lanetli_zar":
      return viewerIsActor
        ? { title: cardName, detail: "Lanetli zar düştü. -1 puan kaybettin." }
        : { title: cardName, detail: `${actorName} Lanetli Zar yüzünden -1 puan kaybetti.` };

    case "vergi_baskini":
      return viewerIsActor
        ? { title: cardName, detail: "Vergi Baskını: -2 puan kaybettin ve en fazla 100 Gold vergi olarak kesildi." }
        : { title: cardName, detail: `${actorName} Vergi Baskını yaşadı: -2 puan kaybetti ve en fazla 100 Gold vergi ödedi.` };

    case "sis_coktu":
      return viewerIsActor
        ? { title: cardName, detail: "Sis Çöktü: Kör harita etkisi yakında aktif olacak." }
        : { title: cardName, detail: `${actorName} Sis Çöktü kartını çekti. Kör harita etkisi yakında aktif olacak.` };

    case "kara_haber": {
      // Three rendering branches, in priority order:
      //  1) removedBonusLabel present  → a real bonus was zeroed.
      //  2) karaHaberFallbackPointLoss → drawer had no bonus; -1 puan applied.
      //  3) neither (defensive)        → older client / metadata missing;
      //     render a soft "aktif bir bonusu sarsıldı" line so the row is
      //     never empty even if forward-compat slipped.
      if (ctx?.removedBonusLabel) {
        return viewerIsActor
          ? { title: cardName, detail: `Kara Haber: ${ctx.removedBonusLabel} kaybettin.` }
          : { title: cardName, detail: `${actorName} Kara Haber aldı ve ${ctx.removedBonusLabel} bonusunu kaybetti.` };
      }
      if (ctx?.karaHaberFallbackPointLoss) {
        return viewerIsActor
          ? { title: cardName, detail: "Kara Haber: Kaybedecek aktif bonusun yoktu. -1 puan kaybettin." }
          : { title: cardName, detail: `${actorName} Kara Haber aldı. Kaybedecek aktif bonusu olmadığı için -1 puan kaybetti.` };
      }
      return viewerIsActor
        ? { title: cardName, detail: "Kara Haber aldın. Aktif bir bonusun sarsıldı." }
        : { title: cardName, detail: `${actorName} Kara Haber aldı. Aktif bir bonusu sarsıldı.` };
    }

    case "ters_ruzgar":
      return viewerIsActor
        ? { title: cardName, detail: "Ters Rüzgar: Bu hamlede 5 saniye kaybettin." }
        : { title: cardName, detail: `${actorName} Ters Rüzgar yüzünden bu hamlede 5 saniye kaybetti.` };

    case "ic_karisiklik": {
      // Three rendering branches, in priority order:
      //  1) affectedRegionName present  → a real region was dropped to neutral.
      //  2) icKarisiklikFallbackPointLoss → drawer had no regions; -1 puan.
      //  3) defensive fallback (older client / metadata missing).
      if (ctx?.affectedRegionName) {
        return viewerIsActor
          ? { title: cardName, detail: `${ctx.affectedRegionName} bölgende isyan çıktı! İç karışıklıklar bölgeyi kaybetmene sebep oldu.` }
          : { title: cardName, detail: `${actorName} oyuncusunun kontrolündeki ${ctx.affectedRegionName} bölgesi iç isyanlar sonucu düştü! Bölgeyi ele geçirmek için doğru zaman.` };
      }
      if (ctx?.icKarisiklikFallbackPointLoss) {
        return viewerIsActor
          ? { title: cardName, detail: "İç Karışıklık çıktı ama kaybedecek bölgen yoktu. -1 puan kaybettin." }
          : { title: cardName, detail: `${actorName} İç Karışıklık çekti ama kaybedecek bölgesi yoktu. -1 puan kaybetti.` };
      }
      return viewerIsActor
        ? { title: cardName, detail: "İç Karışıklık çıktı. Bölgelerinde huzursuzluk başladı." }
        : { title: cardName, detail: `${actorName} İç Karışıklık çekti. Bölgelerinde huzursuzluk başladı.` };
    }

    default: {
      // Unknown card id — fall through to the catalog description so a
      // mismatched catalog still produces a legible sentence.  For the
      // opponent we prepend the actor name so the row is still attributable.
      const fallback = def?.description ?? "";
      return {
        title:  cardName,
        detail: viewerIsActor
          ? fallback
          : `${actorName} ${cardName}: ${fallback}`.trimEnd(),
      };
    }
  }
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
