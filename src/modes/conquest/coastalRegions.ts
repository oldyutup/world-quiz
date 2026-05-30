/**
 * Conquest (Kuşatma) — coastal region registry.
 *
 * Single source of truth for which regions have a sea border, used by the
 * Liman ⚓ bonus to restrict its spawn pool.  Liman represents a port and
 * may only land on coastal regions; landlocked regions are excluded by
 * data, not by ad-hoc filtering at each callsite.
 *
 * Maps not yet implemented (europe, middle-east) get empty sets — the
 * candidate filter will return zero coastal regions for them and the
 * rotation logic falls back to skipping the Liman slot.
 */

import type { ConquestMapId, ConquestRegionId } from "./types";

/**
 * Turkey coastal regions — every region whose territory touches the
 * Black Sea, Marmara, Aegean, or Mediterranean.
 *
 * Inland regions are intentionally omitted: ic_bati_anadolu, ankara_cevre,
 * orta_anadolu, konya_karaman, kapadokya, kuzeydogu_anadolu, erzurum_kars,
 * kars, malatya_elazig, van_hakkari, firat_hatti, dicle_hatti, antep_kilis,
 * mardin_sirnak.
 */
const TURKEY_COASTAL: ReadonlySet<ConquestRegionId> = new Set<ConquestRegionId>([
  "trakya",
  "istanbul_kocaeli",
  "guney_marmara",
  "kuzey_ege",
  "guney_ege",
  "bati_akdeniz",
  "cukurova",
  "hatay_osmaniye",
  "bati_karadeniz",
  "orta_karadeniz",
  "dogu_karadeniz",
]);

const EUROPE_COASTAL:      ReadonlySet<ConquestRegionId> = new Set();
const MIDDLE_EAST_COASTAL: ReadonlySet<ConquestRegionId> = new Set();

export const COASTAL_REGION_IDS: Record<ConquestMapId, ReadonlySet<ConquestRegionId>> = {
  turkey:        TURKEY_COASTAL,
  europe:        EUROPE_COASTAL,
  "middle-east": MIDDLE_EAST_COASTAL,
};

export function isCoastalRegion(
  mapId:    ConquestMapId,
  regionId: ConquestRegionId,
): boolean {
  return COASTAL_REGION_IDS[mapId]?.has(regionId) ?? false;
}
