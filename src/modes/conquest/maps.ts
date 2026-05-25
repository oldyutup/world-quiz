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
// Turkey — 24 strategic conquest regions (Phase 10)
// ─────────────────────────────────────────────────────────────────────────────

const TURKEY_REGIONS: ConquestRegion[] = [
  // ── Row 0: Northern band ─────────────────────────────────────────────────
  {
    id: "trakya",
    name: "Trakya",
    mapId: "turkey",
    neighbors: ["istanbul_kocaeli", "bati_karadeniz"],
    displayLabel: "Trakya",
    emoji: "🏰",
    groupName: "Batı Türkiye",
  },
  {
    id: "istanbul_kocaeli",
    name: "İstanbul / Kocaeli",
    mapId: "turkey",
    neighbors: ["trakya", "guney_marmara", "bati_karadeniz", "ic_bati_anadolu"],
    displayLabel: "İstanbul",
    emoji: "🌉",
    groupName: "Batı Türkiye",
  },
  {
    id: "bati_karadeniz",
    name: "Batı Karadeniz",
    mapId: "turkey",
    neighbors: ["trakya", "istanbul_kocaeli", "orta_karadeniz", "ankara_cevre"],
    displayLabel: "Batı Kara.",
    emoji: "🌲",
    groupName: "Karadeniz",
  },
  {
    id: "orta_karadeniz",
    name: "Orta Karadeniz",
    mapId: "turkey",
    neighbors: ["bati_karadeniz", "dogu_karadeniz", "ankara_cevre", "orta_anadolu"],
    displayLabel: "Orta Kara.",
    emoji: "🌿",
    groupName: "Karadeniz",
  },
  {
    id: "dogu_karadeniz",
    name: "Doğu Karadeniz",
    mapId: "turkey",
    neighbors: ["orta_karadeniz", "kuzeydogu_anadolu", "erzurum_kars"],
    displayLabel: "Doğu Kara.",
    emoji: "⛵",
    groupName: "Karadeniz",
  },
  {
    id: "kuzeydogu_anadolu",
    name: "Kuzeydoğu Anadolu",
    mapId: "turkey",
    // Erzincan (in this region) borders Elazığ/Tunceli/Bingöl → malatya_elazig.
    neighbors: ["dogu_karadeniz", "erzurum_kars", "malatya_elazig"],
    displayLabel: "KD Anad.",
    emoji: "🏔️",
    groupName: "Doğu Türkiye",
  },

  // ── Row 1: Ege + Central Anatolia ────────────────────────────────────────
  {
    id: "kuzey_ege",
    name: "Kuzey Ege",
    mapId: "turkey",
    neighbors: ["guney_marmara", "guney_ege", "ic_bati_anadolu"],
    displayLabel: "Kuzey Ege",
    emoji: "🏖️",
    groupName: "Ege",
  },
  {
    id: "guney_marmara",
    name: "Güney Marmara",
    mapId: "turkey",
    neighbors: ["istanbul_kocaeli", "kuzey_ege", "ic_bati_anadolu"],
    displayLabel: "G. Marmara",
    emoji: "🌊",
    groupName: "Batı Türkiye",
  },
  {
    id: "ic_bati_anadolu",
    name: "İç Batı Anadolu",
    mapId: "turkey",
    neighbors: ["istanbul_kocaeli", "guney_marmara", "kuzey_ege", "guney_ege", "ankara_cevre", "konya_karaman"],
    displayLabel: "İç Batı",
    emoji: "🌾",
    groupName: "Orta Türkiye",
  },
  {
    id: "ankara_cevre",
    name: "Ankara / Çevre",
    mapId: "turkey",
    neighbors: ["bati_karadeniz", "orta_karadeniz", "ic_bati_anadolu", "konya_karaman", "kapadokya", "orta_anadolu"],
    displayLabel: "Ankara",
    emoji: "🏛️",
    groupName: "Orta Türkiye",
  },
  {
    id: "orta_anadolu",
    name: "Orta Anadolu",
    mapId: "turkey",
    neighbors: ["orta_karadeniz", "ankara_cevre", "kapadokya", "erzurum_kars", "malatya_elazig"],
    displayLabel: "Orta Anad.",
    emoji: "⛰️",
    groupName: "Orta Türkiye",
  },
  {
    id: "erzurum_kars",
    name: "Erzurum / Kars",
    mapId: "turkey",
    neighbors: ["dogu_karadeniz", "orta_anadolu", "kuzeydogu_anadolu", "malatya_elazig", "van_hakkari"],
    displayLabel: "Erzurum",
    emoji: "❄️",
    groupName: "Doğu Türkiye",
  },

  // ── Row 2: South Ege + South Central + Far East ──────────────────────────
  {
    id: "guney_ege",
    name: "Güney Ege",
    mapId: "turkey",
    neighbors: ["kuzey_ege", "ic_bati_anadolu", "bati_akdeniz"],
    displayLabel: "Güney Ege",
    emoji: "⛵",
    groupName: "Ege",
  },
  {
    id: "bati_akdeniz",
    name: "Batı Akdeniz",
    mapId: "turkey",
    neighbors: ["guney_ege", "konya_karaman", "cukurova"],
    displayLabel: "Batı Akd.",
    emoji: "🍊",
    groupName: "Akdeniz",
  },
  {
    id: "konya_karaman",
    name: "Konya / Karaman",
    mapId: "turkey",
    neighbors: ["ic_bati_anadolu", "ankara_cevre", "bati_akdeniz", "cukurova", "kapadokya"],
    displayLabel: "Konya",
    emoji: "🌾",
    groupName: "Orta Türkiye",
  },
  {
    id: "kapadokya",
    name: "Kapadokya",
    mapId: "turkey",
    neighbors: ["ankara_cevre", "orta_anadolu", "konya_karaman", "cukurova", "malatya_elazig", "firat_hatti"],
    displayLabel: "Kapadokya",
    emoji: "🏺",
    groupName: "Orta Türkiye",
  },
  {
    id: "malatya_elazig",
    name: "Malatya / Elazığ",
    mapId: "turkey",
    neighbors: ["orta_anadolu", "kapadokya", "erzurum_kars", "van_hakkari", "firat_hatti", "kuzeydogu_anadolu"],
    displayLabel: "Malatya",
    emoji: "🍑",
    groupName: "Doğu Türkiye",
  },
  {
    id: "van_hakkari",
    name: "Van / Hakkari",
    mapId: "turkey",
    neighbors: ["erzurum_kars", "malatya_elazig", "dicle_hatti", "mardin_sirnak"],
    displayLabel: "Van",
    emoji: "🏔️",
    groupName: "Doğu Türkiye",
  },

  // ── Row 3: Southern band ─────────────────────────────────────────────────
  {
    id: "hatay_osmaniye",
    name: "Hatay / Osmaniye",
    mapId: "turkey",
    // Osmaniye borders Kahramanmaraş (in firat_hatti).
    neighbors: ["cukurova", "antep_kilis", "firat_hatti"],
    displayLabel: "Hatay",
    emoji: "🕊️",
    groupName: "Güney Türkiye",
  },
  {
    id: "cukurova",
    name: "Çukurova",
    mapId: "turkey",
    // Adana borders Kahramanmaraş (in firat_hatti).
    neighbors: ["bati_akdeniz", "konya_karaman", "kapadokya", "hatay_osmaniye", "antep_kilis", "firat_hatti"],
    displayLabel: "Çukurova",
    emoji: "🌿",
    groupName: "Akdeniz",
  },
  {
    id: "firat_hatti",
    name: "Fırat Hattı",
    mapId: "turkey",
    // Kahramanmaraş (in this region) borders Adana (cukurova) and Osmaniye (hatay_osmaniye).
    neighbors: ["kapadokya", "malatya_elazig", "dicle_hatti", "antep_kilis", "cukurova", "hatay_osmaniye"],
    displayLabel: "Fırat",
    emoji: "🏜️",
    groupName: "Güneydoğu",
  },
  {
    id: "dicle_hatti",
    name: "Dicle Hattı",
    mapId: "turkey",
    neighbors: ["firat_hatti", "van_hakkari", "antep_kilis", "mardin_sirnak"],
    displayLabel: "Dicle",
    emoji: "🏜️",
    groupName: "Güneydoğu",
  },
  {
    id: "antep_kilis",
    name: "Antep / Kilis",
    mapId: "turkey",
    neighbors: ["cukurova", "hatay_osmaniye", "firat_hatti", "dicle_hatti"],
    displayLabel: "Antep",
    emoji: "🌶️",
    groupName: "Güneydoğu",
  },
  {
    id: "mardin_sirnak",
    name: "Mardin / Şırnak",
    mapId: "turkey",
    neighbors: ["van_hakkari", "dicle_hatti"],
    displayLabel: "Mardin",
    emoji: "🏛️",
    groupName: "Güneydoğu",
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
    description:       "Türkiye'yi 24 stratejik bölgeye bölen harita. Tüm bölgeleri ele geçir.",
    icon:              "🇹🇷",
    minPlayers:        2,
    maxPlayers:        4,
    recommendedRounds: 8,
    regionCount:       TURKEY_REGIONS.length,
    implemented:       true,
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
