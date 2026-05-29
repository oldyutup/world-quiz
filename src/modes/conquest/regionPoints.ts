/**
 * Conquest — region point values.
 *
 * Score is the sum of point values of held regions, not raw region count.
 * Points reflect a mix of strategic importance, economy/population weight,
 * geographic / logistic value, and (loosely) area. Tunable here.
 *
 * Currently only the Turkey map carries explicit weights. Other maps fall
 * back to 1 point per region (preserving region-count semantics).
 */

import type {
  ConquestPlayer,
  ConquestPlayerBonusState,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";

export const REGION_POINTS: Record<string, number> = {
  // Batı
  trakya:             2,
  istanbul_kocaeli:   5,
  guney_marmara:      4,

  // Karadeniz
  bati_karadeniz:     3,
  orta_karadeniz:     3,
  dogu_karadeniz:     3,

  // Ege
  kuzey_ege:          3,
  guney_ege:          3,

  // Akdeniz / Güney
  bati_akdeniz:       3,
  cukurova:           4,
  hatay_osmaniye:     3,

  // Orta
  ankara_cevre:       5,
  ic_bati_anadolu:    3,
  konya_karaman:      3,
  kapadokya:          3,
  orta_anadolu:       3,

  // Doğu
  malatya_elazig:     3,
  erzurum_kars:       2,
  kars:               1,
  kuzeydogu_anadolu:  2,
  van_hakkari:        3,

  // Güneydoğu
  antep_kilis:        3,
  firat_hatti:        3,
  dicle_hatti:        3,
  mardin_sirnak:      3,
};

const DEFAULT_REGION_POINTS = 1;

export function getRegionPoints(regionId: ConquestRegionId): number {
  return REGION_POINTS[regionId] ?? DEFAULT_REGION_POINTS;
}

/** Total points each player currently controls. Players with 0 are included. */
export function getPlayerRegionPoints(
  players:      ConquestPlayer[],
  regionStates: ConquestRegionState[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of players) out[p.id] = 0;
  for (const rs of regionStates) {
    if (rs.ownerPlayerId !== null && out[rs.ownerPlayerId] !== undefined) {
      out[rs.ownerPlayerId] += getRegionPoints(rs.regionId);
    }
  }
  return out;
}

/**
 * Bonus points contributed by region bonuses (Çukurova +1 etc.).  Read from
 * the per-player bonus state; missing entries default to 0.
 */
export function getPlayerBonusPoints(
  players:       ConquestPlayer[],
  playerBonuses: Record<string, ConquestPlayerBonusState> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of players) {
    out[p.id] = playerBonuses?.[p.id]?.bonusPoints ?? 0;
  }
  return out;
}

/** Region points + bonus points, summed per player. */
export function getPlayerTotalPoints(
  players:       ConquestPlayer[],
  regionStates:  ConquestRegionState[],
  playerBonuses: Record<string, ConquestPlayerBonusState> | undefined,
): Record<string, number> {
  const region = getPlayerRegionPoints(players, regionStates);
  const bonus  = getPlayerBonusPoints(players, playerBonuses);
  const out: Record<string, number> = {};
  for (const p of players) out[p.id] = (region[p.id] ?? 0) + (bonus[p.id] ?? 0);
  return out;
}

/** Total points still held by neutral (un-owned) regions. */
export function getNeutralRegionPoints(
  regionStates: ConquestRegionState[],
): number {
  let total = 0;
  for (const rs of regionStates) {
    if (rs.ownerPlayerId === null) total += getRegionPoints(rs.regionId);
  }
  return total;
}
