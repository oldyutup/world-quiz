/**
 * Conquest (Kuşatma) — pure state helpers.
 *
 * No React, no Supabase.  All functions are pure and deterministic so they
 * can be unit-tested independently of the UI.
 *
 * Phase-4 scope: initial color assignment and region ownership distribution.
 * Turn logic, capture resolution, and win conditions come in a later phase.
 */

import type {
  ConquestMapConfig,
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegionState,
} from "./types";

/** Ordered color palette assigned by player slot (index 0 = first player). */
export const CONQUEST_COLOR_PALETTE: ConquestPlayerColor[] = [
  "red",
  "blue",
  "green",
  "yellow",
];

/** Hex values for each ConquestPlayerColor — used by UI components. */
export const CONQUEST_COLOR_HEX: Record<ConquestPlayerColor, string> = {
  red:    "#ef4444",
  blue:   "#3b82f6",
  green:  "#22c55e",
  yellow: "#eab308",
  purple: "#a855f7",
  orange: "#f97316",
};

/**
 * Assign a color from the fixed palette to each player by their slot index.
 * Returns a map of playerId → ConquestPlayerColor.
 */
export function assignConquestPlayerColors(
  players: ConquestPlayer[],
): Record<string, ConquestPlayerColor> {
  const out: Record<string, ConquestPlayerColor> = {};
  players.forEach((p, i) => {
    out[p.id] = CONQUEST_COLOR_PALETTE[i % CONQUEST_COLOR_PALETTE.length];
  });
  return out;
}

/**
 * Distribute regions evenly across players in round-robin order.
 *
 * Strategy:
 *   - Base share = floor(regionCount / playerCount)
 *   - Distributed slots = base × playerCount (leftover regions stay neutral)
 *   - Regions[0…distributed-1] are assigned round-robin by player index
 *   - Remaining regions are neutral (ownerPlayerId = null)
 *
 * This is deterministic and depends only on region list order and player slot
 * order — no randomness, safe to call multiple times with the same inputs.
 */
export function createInitialRegionStates(
  mapConfig: ConquestMapConfig,
  players: ConquestPlayer[],
): ConquestRegionState[] {
  const regions = mapConfig.regions;
  if (players.length === 0) {
    return regions.map(r => ({
      regionId:      r.id,
      ownerPlayerId: null,
      shielded:      false,
    }));
  }
  // Fixed starting regions per player count; remaining stay neutral.
  const startingPerPlayer: Record<number, number> = { 2: 4, 3: 3, 4: 3 };
  const perPlayer = startingPerPlayer[players.length] ?? 3;
  const distributed = Math.min(perPlayer * players.length, regions.length);

  return regions.map((r, i) => ({
    regionId:      r.id,
    ownerPlayerId: i < distributed ? players[i % players.length].id : null,
    shielded:      false,
  }));
}

/**
 * Count the number of regions each player currently owns.
 * Returns a map of playerId → count.  Players with 0 regions are omitted.
 */
export function getRegionOwnerCounts(
  regionStates: ConquestRegionState[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rs of regionStates) {
    if (rs.ownerPlayerId !== null) {
      counts[rs.ownerPlayerId] = (counts[rs.ownerPlayerId] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Hide Ankara "Gizli Operasyon" placements from non-owner viewers.  Three flavours:
 *
 *   - kind === "shield"       → region is already openly owned by the placing
 *     player; only the shield itself is secret.  Keep ownership visible to
 *     opponents and just strip the `hiddenShieldOwnerId`/`hiddenShieldKind`
 *     so the shield's presence doesn't leak.
 *
 *   - kind === "conquest"     → region was secretly captured from neutral
 *     (gizli fetih).  Real owner is the placer; mask ownership so opponents
 *     see a plain neutral tile.  Also the legacy fallback for very old saves
 *     without a stored kind.
 *
 *   - kind === "neutral_trap" → LEGACY only: pre-spec-rev3 trap where the
 *     region stayed genuinely neutral.  Strip the hidden-shield fields for
 *     opponents so the tile renders as a plain neutral region.
 *
 * Owner-side projection is identity in all cases.
 *
 * NOTE: `shielded` (İstanbul open shield) is intentionally NOT cleared here.
 * It is a public/open field — opponents must always see it on the map.
 *
 * Used for all opponent-facing renders and any helper that derives "what the
 * viewer sees on the board" (legal targets, region counts in side panels).
 * Gameplay logic must still operate on the real `regionStates` so blocks and
 * reveals trigger correctly when an opponent acts on a hidden region.
 */
export function projectRegionStatesForViewer(
  regionStates: ConquestRegionState[],
  viewerId:     string | null,
): ConquestRegionState[] {
  let mutated = false;
  const out = regionStates.map(rs => {
    const hiddenOwner = rs.hiddenShieldOwnerId;
    if (!hiddenOwner) return rs;
    if (hiddenOwner === viewerId) return rs;
    mutated = true;
    const kind = rs.hiddenShieldKind ?? "conquest";
    if (kind === "shield" || kind === "neutral_trap") {
      // Region is either openly owned (shield) or genuinely neutral (trap);
      // either way the tile's owner is shown correctly, only the hidden
      // marker is stripped for opponents.
      return {
        ...rs,
        hiddenShieldOwnerId: undefined,
        hiddenShieldKind:    undefined,
      };
    }
    // Legacy ("conquest"): mask the whole capture as a neutral tile.
    return {
      ...rs,
      ownerPlayerId:       null,
      hiddenShieldOwnerId: undefined,
      hiddenShieldKind:    undefined,
      lastCapturedBy:      undefined,
    };
  });
  return mutated ? out : regionStates;
}
