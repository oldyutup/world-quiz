/**
 * Conquest (Kuşatma) — region action rules and resolution.
 *
 * Pure helpers.  No React, no Supabase, no randomness.  Every function takes
 * the current immutable game state and returns either a boolean predicate,
 * a list of legal actions, or a new region-state array.  Nothing mutates
 * its inputs.
 *
 * Action semantics (Phase 6 — deterministic, no combat / dice / boosts):
 *   capture_neutral — region must be owner-less; flips to caller
 *   attack_region   — region must be enemy-owned AND adjacent to one of
 *                     the caller's regions; flips to caller
 *   defend_region   — placeholder, no-op resolution beyond marking the
 *                     region.shielded flag (kept stub-simple; no expiry)
 *   skip            — always legal; advances the round with no map change
 */

import type {
  ConquestActionResult,
  ConquestActionType,
  ConquestMapConfig,
  ConquestPendingAction,
  ConquestPlayer,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Internal lookups
// ─────────────────────────────────────────────────────────────────────────────

function regionStateById(
  states: ConquestRegionState[],
): Map<ConquestRegionId, ConquestRegionState> {
  return new Map(states.map(rs => [rs.regionId, rs]));
}

function playerName(
  players: ConquestPlayer[],
  id:      string,
): string {
  return players.find(p => p.id === id)?.name ?? "Oyuncu";
}

// ─────────────────────────────────────────────────────────────────────────────
// Predicates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical legal-target rule for any region-targeting action.
 *
 *   legal = target exists
 *        && target.ownerId !== playerId
 *        && some neighbor of target is owned by playerId
 *
 * Number of opponents bordering the target, fronts touched, or whether
 * the target is neutral vs. enemy-owned does NOT affect legality — those
 * only steer the action *type* (capture vs. attack vs. duel).  UI
 * highlighting, click validation, and gameplay resolution all funnel
 * through this predicate via canCaptureNeutral / canAttackRegion below,
 * so the rule has a single source of truth.
 */
export function isLegalTarget(
  mapConfig:    ConquestMapConfig,
  regionStates: ConquestRegionState[],
  playerId:     string,
  regionId:     ConquestRegionId,
): boolean {
  const region = mapConfig.regions.find(r => r.id === regionId);
  if (!region) return false;
  const byId = regionStateById(regionStates);
  const target = byId.get(regionId);
  if (!target) return false;
  if (target.ownerPlayerId === playerId) return false;
  for (const nbId of region.neighbors) {
    const nb = byId.get(nbId);
    if (nb && nb.ownerPlayerId === playerId) return true;
  }
  return false;
}

/**
 * True if `playerId` may capture `regionId` as a neutral take.
 * Neutral flavour of the canonical rule: target must be owner-less and
 * legal per isLegalTarget.
 */
export function canCaptureNeutral(
  mapConfig:    ConquestMapConfig,
  regionStates: ConquestRegionState[],
  playerId:     string,
  regionId:     ConquestRegionId,
): boolean {
  const target = regionStateById(regionStates).get(regionId);
  if (!target || target.ownerPlayerId !== null) return false;
  return isLegalTarget(mapConfig, regionStates, playerId, regionId);
}

/**
 * True if `playerId` may attack `regionId`.
 * Opponent flavour of the canonical rule: target must be owned by
 * someone other than playerId (not neutral) and legal per isLegalTarget.
 * Shielded regions are still attackable here — shield consumption is
 * handled by the gameplay layer, not the legality predicate.
 */
export function canAttackRegion(
  mapConfig:    ConquestMapConfig,
  regionStates: ConquestRegionState[],
  playerId:     string,
  regionId:     ConquestRegionId,
): boolean {
  const target = regionStateById(regionStates).get(regionId);
  if (!target || target.ownerPlayerId === null) return false;
  return isLegalTarget(mapConfig, regionStates, playerId, regionId);
}

/**
 * True if `playerId` may defend (shield) `regionId`.
 * Phase-6 stub: legal iff the player owns the region.  Shield duration /
 * cooldowns are deliberately not modelled yet — the flag is set and stays
 * until a future system clears it.
 */
export function canDefendRegion(
  _mapConfig:   ConquestMapConfig,
  regionStates: ConquestRegionState[],
  playerId:     string,
  regionId:     ConquestRegionId,
): boolean {
  const rs = regionStateById(regionStates).get(regionId);
  return !!rs && rs.ownerPlayerId === playerId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legal-action enumeration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarises which action types the player has *any* legal target for.
 * `skip` is always present so the UI can offer "Hamleyi Pas Geç".  When the
 * only legal action is `skip`, callers should auto-resolve to skip rather
 * than leave the player stuck.
 *
 * Note: this returns action *types*, not target lists.  See
 * `getLegalTargetsForAction` for the per-action target set.
 */
export function getLegalActionsForPlayer(
  mapConfig:    ConquestMapConfig,
  regionStates: ConquestRegionState[],
  playerId:     string,
): ConquestActionType[] {
  const out: ConquestActionType[] = [];

  const hasNeutral = regionStates.some(
    rs => canCaptureNeutral(mapConfig, regionStates, playerId, rs.regionId),
  );
  if (hasNeutral) out.push("capture_neutral");

  const hasAttack = regionStates.some(
    rs => canAttackRegion(mapConfig, regionStates, playerId, rs.regionId),
  );
  if (hasAttack) out.push("attack_region");

  // defend_region is intentionally NOT advertised in v1 — the UI does not
  // expose a shield button yet.  Keep the predicate available for future use.

  out.push("skip");
  return out;
}

/**
 * Region ids the player can legally target for the given action.  Used by
 * the board to highlight valid drop targets and by the action-resolver to
 * sanity-check the chosen region before mutation.
 */
export function getLegalTargetsForAction(
  mapConfig:    ConquestMapConfig,
  regionStates: ConquestRegionState[],
  playerId:     string,
  action:       ConquestActionType,
): ConquestRegionId[] {
  switch (action) {
    case "capture_neutral":
      return regionStates
        .filter(rs => canCaptureNeutral(mapConfig, regionStates, playerId, rs.regionId))
        .map(rs => rs.regionId);
    case "attack_region":
      return regionStates
        .filter(rs => canAttackRegion(mapConfig, regionStates, playerId, rs.regionId))
        .map(rs => rs.regionId);
    case "defend_region":
      return regionStates
        .filter(rs => canDefendRegion(mapConfig, regionStates, playerId, rs.regionId))
        .map(rs => rs.regionId);
    case "skip":
      return [];
  }
}

/**
 * Convenience: every region a player can legally touch this turn, regardless
 * of which action lands on it.  Used by ConquestBoard to render the "click
 * me" affordance without committing to a specific action type.
 */
export function getAllLegalTargetsForPlayer(
  mapConfig:    ConquestMapConfig,
  regionStates: ConquestRegionState[],
  playerId:     string,
): Set<ConquestRegionId> {
  const set = new Set<ConquestRegionId>();
  for (const rs of regionStates) {
    if (isLegalTarget(mapConfig, regionStates, playerId, rs.regionId)) {
      set.add(rs.regionId);
    }
  }
  return set;
}

/**
 * Infer which action a player intends from the region they clicked.  Returns
 * null when the click is not a legal action for the player.
 *
 * Capture is preferred over attack when both are theoretically possible —
 * but they can't both be true on the same region (neutral vs. enemy-owned),
 * so the order is just a defensive default.
 */
export function inferActionFromRegionClick(
  mapConfig:    ConquestMapConfig,
  regionStates: ConquestRegionState[],
  playerId:     string,
  regionId:     ConquestRegionId,
): ConquestActionType | null {
  if (canCaptureNeutral(mapConfig, regionStates, playerId, regionId)) {
    return "capture_neutral";
  }
  if (canAttackRegion(mapConfig, regionStates, playerId, regionId)) {
    return "attack_region";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

interface ApplyResult {
  regionStates: ConquestRegionState[];
  result:       ConquestActionResult;
}

/**
 * Apply a pending action against the current region states and return the
 * new array + a structured result.  Pure: never mutates inputs.  Illegal
 * actions return the unchanged state and `result.ok=false`.
 *
 * `currentRound` is recorded on the touched region for later replay.
 */
export function applyConquestAction(
  mapConfig:    ConquestMapConfig,
  regionStates: ConquestRegionState[],
  players:      ConquestPlayer[],
  currentRound: number,
  action:       ConquestPendingAction,
): ApplyResult {
  switch (action.type) {
    case "skip":
      return {
        regionStates,
        result: {
          ok:       true,
          action:   "skip",
          playerId: action.playerId,
          regionId: null,
          message:  `${playerName(players, action.playerId)} hamleyi pas geçti.`,
        },
      };

    case "capture_neutral": {
      if (!canCaptureNeutral(mapConfig, regionStates, action.playerId, action.regionId)) {
        return {
          regionStates,
          result: illegal(action, "Bu bölgeye hamle yapılamaz."),
        };
      }
      return flipOwnership(
        regionStates, players, currentRound,
        action.playerId, action.regionId,
        "capture_neutral",
        `${playerName(players, action.playerId)} ${regionLabel(mapConfig, action.regionId)} bölgesini ele geçirdi.`,
      );
    }

    case "attack_region": {
      if (!canAttackRegion(mapConfig, regionStates, action.playerId, action.regionId)) {
        return {
          regionStates,
          result: illegal(action, "Bu bölgeye hamle yapılamaz."),
        };
      }
      return flipOwnership(
        regionStates, players, currentRound,
        action.playerId, action.regionId,
        "attack_region",
        `${playerName(players, action.playerId)}, ${regionLabel(mapConfig, action.regionId)} bölgesini fethetti.`,
      );
    }

    case "defend_region": {
      if (!canDefendRegion(mapConfig, regionStates, action.playerId, action.regionId)) {
        return {
          regionStates,
          result: illegal(action, "Bu bölgeye kalkan basılamaz."),
        };
      }
      const next = regionStates.map(rs =>
        rs.regionId === action.regionId ? { ...rs, shielded: true } : rs,
      );
      return {
        regionStates: next,
        result: {
          ok:       true,
          action:   "defend_region",
          playerId: action.playerId,
          regionId: action.regionId,
          message:  `${playerName(players, action.playerId)} ${regionLabel(mapConfig, action.regionId)} bölgesini kalkanladı.`,
        },
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution helpers
// ─────────────────────────────────────────────────────────────────────────────

function flipOwnership(
  states:        ConquestRegionState[],
  _players:      ConquestPlayer[],
  currentRound:  number,
  newOwner:      string,
  regionId:      ConquestRegionId,
  actionType:    ConquestActionType,
  message:       string,
): ApplyResult {
  const next = states.map(rs => {
    if (rs.regionId !== regionId) return rs;
    return {
      ...rs,
      ownerPlayerId:  newOwner,
      lastCapturedBy: newOwner,
      turnCaptured:   currentRound,
      captureCount:   (rs.captureCount ?? 0) + 1,
      /* Capture clears any shield on the region — sensible default for the
       * future shield mechanic, harmless today. */
      shielded:       false,
      /* Liman ⚓: per-tenure income counter resets on every ownership
       * change so a fresh owner starts at 0/10.  Harmless on non-liman
       * regions (field stays unread for them). */
      limanIncomeTicks: 0,
      /* Bereketli Ova 🌾: per-tenure hold counter resets so the new owner
       * has to hold the region for BEREKET_HARVEST_INTERVAL fresh rounds
       * before the next harvest fires.  Harmless on non-bereket regions. */
      bereketHarvestTurns: 0,
    };
  });
  return {
    regionStates: next,
    result: {
      ok:       true,
      action:   actionType,
      playerId: newOwner,
      regionId,
      message,
    },
  };
}

function illegal(
  action:  ConquestPendingAction,
  message: string,
): ConquestActionResult {
  return {
    ok:       false,
    action:   action.type,
    playerId: action.playerId,
    regionId: action.type === "skip" ? null : action.regionId,
    message,
  };
}

function regionLabel(mapConfig: ConquestMapConfig, regionId: ConquestRegionId): string {
  const r = mapConfig.regions.find(rg => rg.id === regionId);
  return r?.displayLabel ?? r?.name ?? regionId;
}
