/**
 * Conquest (Kuşatma) — map configs.
 *
 * Phase-3 scope: placeholder region topology for Turkey, Europe, and Middle
 * East.  No geometry is resolved here; these are pure data configs used by
 * future gameplay logic and (optionally) the lobby map dropdown.
 *
 * PLACEHOLDER NOTE
 * ────────────────
 * Turkey currently uses 7 broad geographic regions.  These will be replaced
 * by 18–24 custom conquest zones before the map goes live.  The region ids
 * will change; the ConquestMapConfig shape will not.
 *
 * Europe and Middle East use minimal region lists; real country-level data
 * will be added in a later phase.
 *
 * To add a future map:
 *  1. Extend ConquestMapId in types.ts.
 *  2. Define its ConquestRegion[] below.
 *  3. Push a ConquestMapConfig entry into CONQUEST_MAP_CONFIGS.
 *  4. No other files need to change.
 */

import type {
  ConquestMapConfig,
  ConquestMapId,
  ConquestRegion,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Turkey — 7 placeholder broad geographic regions
// Will be replaced by 18–24 custom conquest regions before shipping.
// ─────────────────────────────────────────────────────────────────────────────

const TURKEY_REGIONS: ConquestRegion[] = [
  {
    id: "marmara",
    name: "Marmara",
    mapId: "turkey",
    neighbors: ["ege", "ic_anadolu", "karadeniz"],
    displayLabel: "Marmara",
    emoji: "🌊",
    groupName: "Batı Türkiye",
  },
  {
    id: "ege",
    name: "Ege",
    mapId: "turkey",
    neighbors: ["marmara", "ic_anadolu", "akdeniz"],
    displayLabel: "Ege",
    emoji: "🏖️",
    groupName: "Batı Türkiye",
  },
  {
    id: "ic_anadolu",
    name: "İç Anadolu",
    mapId: "turkey",
    neighbors: ["marmara", "ege", "karadeniz", "akdeniz", "dogu_anadolu", "guneydogu_anadolu"],
    displayLabel: "İç Anadolu",
    emoji: "🌾",
    groupName: "Orta Türkiye",
  },
  {
    id: "karadeniz",
    name: "Karadeniz",
    mapId: "turkey",
    neighbors: ["marmara", "ic_anadolu", "dogu_anadolu"],
    displayLabel: "Karadeniz",
    emoji: "🌿",
    groupName: "Kuzey Türkiye",
  },
  {
    id: "akdeniz",
    name: "Akdeniz",
    mapId: "turkey",
    neighbors: ["ege", "ic_anadolu", "guneydogu_anadolu"],
    displayLabel: "Akdeniz",
    emoji: "🍊",
    groupName: "Güney Türkiye",
  },
  {
    id: "dogu_anadolu",
    name: "Doğu Anadolu",
    mapId: "turkey",
    neighbors: ["karadeniz", "ic_anadolu", "guneydogu_anadolu"],
    displayLabel: "Doğu Anadolu",
    emoji: "⛰️",
    groupName: "Doğu Türkiye",
  },
  {
    id: "guneydogu_anadolu",
    name: "Güneydoğu Anadolu",
    mapId: "turkey",
    neighbors: ["ic_anadolu", "akdeniz", "dogu_anadolu"],
    displayLabel: "Güneydoğu",
    emoji: "🌵",
    groupName: "Doğu Türkiye",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Europe — placeholder country clusters (not final; will expand to countries)
// ─────────────────────────────────────────────────────────────────────────────

const EUROPE_REGIONS: ConquestRegion[] = [
  {
    id: "eu_western",
    name: "Batı Avrupa",
    mapId: "europe",
    neighbors: ["eu_northern", "eu_central", "eu_iberian", "eu_southern"],
    displayLabel: "Batı",
    groupName: "Avrupa",
  },
  {
    id: "eu_northern",
    name: "Kuzey Avrupa",
    mapId: "europe",
    neighbors: ["eu_western", "eu_central", "eu_british"],
    displayLabel: "Kuzey",
    groupName: "Avrupa",
  },
  {
    id: "eu_central",
    name: "Orta Avrupa",
    mapId: "europe",
    neighbors: ["eu_western", "eu_northern", "eu_eastern", "eu_southern", "eu_balkan"],
    displayLabel: "Orta",
    groupName: "Avrupa",
  },
  {
    id: "eu_eastern",
    name: "Doğu Avrupa",
    mapId: "europe",
    neighbors: ["eu_central", "eu_balkan"],
    displayLabel: "Doğu",
    groupName: "Avrupa",
  },
  {
    id: "eu_southern",
    name: "Güney Avrupa",
    mapId: "europe",
    neighbors: ["eu_western", "eu_central", "eu_iberian", "eu_balkan"],
    displayLabel: "Güney",
    groupName: "Avrupa",
  },
  {
    id: "eu_iberian",
    name: "İber Yarımadası",
    mapId: "europe",
    neighbors: ["eu_western", "eu_southern"],
    displayLabel: "İber",
    groupName: "Avrupa",
  },
  {
    id: "eu_balkan",
    name: "Balkanlar",
    mapId: "europe",
    neighbors: ["eu_central", "eu_eastern", "eu_southern"],
    displayLabel: "Balkan",
    groupName: "Avrupa",
  },
  {
    id: "eu_british",
    name: "Britanya Adaları",
    mapId: "europe",
    neighbors: ["eu_northern", "eu_western"],
    displayLabel: "Britanya",
    groupName: "Avrupa",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Middle East — placeholder geographic clusters (not final)
// ─────────────────────────────────────────────────────────────────────────────

const MIDDLE_EAST_REGIONS: ConquestRegion[] = [
  {
    id: "me_levant",
    name: "Levant",
    mapId: "middle-east",
    neighbors: ["me_anatolia", "me_mesopotamia", "me_north_africa"],
    displayLabel: "Levant",
    groupName: "Orta Doğu",
  },
  {
    id: "me_arabian",
    name: "Arap Yarımadası",
    mapId: "middle-east",
    neighbors: ["me_gulf", "me_levant", "me_mesopotamia"],
    displayLabel: "Arabistan",
    groupName: "Orta Doğu",
  },
  {
    id: "me_mesopotamia",
    name: "Mezopotamya",
    mapId: "middle-east",
    neighbors: ["me_levant", "me_arabian", "me_gulf", "me_anatolia"],
    displayLabel: "Mezopotamya",
    groupName: "Orta Doğu",
  },
  {
    id: "me_gulf",
    name: "Körfez",
    mapId: "middle-east",
    neighbors: ["me_arabian", "me_mesopotamia"],
    displayLabel: "Körfez",
    groupName: "Orta Doğu",
  },
  {
    id: "me_anatolia",
    name: "Anadolu Bağlantısı",
    mapId: "middle-east",
    neighbors: ["me_levant", "me_mesopotamia"],
    displayLabel: "Anadolu",
    groupName: "Orta Doğu",
  },
  {
    id: "me_north_africa",
    name: "Kuzey Afrika",
    mapId: "middle-east",
    neighbors: ["me_levant"],
    displayLabel: "K. Afrika",
    groupName: "Orta Doğu",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Map configs — authoritative source for all Kuşatma map data
// ─────────────────────────────────────────────────────────────────────────────

export const CONQUEST_MAP_CONFIGS: ConquestMapConfig[] = [
  {
    id:                "turkey",
    kind:              "region-based",
    displayName:       "Türkiye Kuşatması",
    shortName:         "Türkiye",
    description:       "Türkiye'yi 7 coğrafi bölgeye bölen harita. Tüm bölgeleri ele geçir.",
    icon:              "🇹🇷",
    minPlayers:        2,
    maxPlayers:        4,
    recommendedRounds: 6,
    regionCount:       TURKEY_REGIONS.length,
    implemented:       false,   // placeholder — not yet playable
    regions:           TURKEY_REGIONS,
  },
  {
    id:                "europe",
    kind:              "region-based",
    displayName:       "Avrupa Kuşatması",
    shortName:         "Avrupa",
    description:       "Avrupa'yı büyük coğrafi bloklara ayıran harita.",
    icon:              "🇪🇺",
    minPlayers:        2,
    maxPlayers:        4,
    recommendedRounds: 8,
    regionCount:       EUROPE_REGIONS.length,
    implemented:       false,
    regions:           EUROPE_REGIONS,
  },
  {
    id:                "middle-east",
    kind:              "region-based",
    displayName:       "Orta Doğu Kuşatması",
    shortName:         "Orta Doğu",
    description:       "Orta Doğu'yu stratejik bölgelere ayıran harita.",
    icon:              "🕌",
    minPlayers:        2,
    maxPlayers:        4,
    recommendedRounds: 6,
    regionCount:       MIDDLE_EAST_REGIONS.length,
    implemented:       false,
    regions:           MIDDLE_EAST_REGIONS,
  },
];

/** Look up a map config by id.  Returns undefined for unknown ids. */
export function getConquestMapConfig(
  id: ConquestMapId,
): ConquestMapConfig | undefined {
  return CONQUEST_MAP_CONFIGS.find(m => m.id === id);
}
