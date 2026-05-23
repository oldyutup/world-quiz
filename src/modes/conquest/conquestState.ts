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
  const distributed =
    Math.floor(regions.length / players.length) * players.length;

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
