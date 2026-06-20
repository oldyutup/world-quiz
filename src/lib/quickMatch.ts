/**
 * Hızlı Eşleş (Quick Match) — canonical shared definitions for the
 * native-app + narrow/mobile-web entry surface (MobileHome ⚡ Eşleş sheet).
 *
 * Single source of truth for:
 *   • the quick-match intent contract handed from the sheet up to App
 *   • the per-mode option lists the sheet renders. These mirror each duel
 *     game's own option arrays 1:1 (the full sets the backends accept — see
 *     "Parameter accuracy" below); we re-export them here so the sheet never
 *     re-hardcodes a divergent list.
 *   • the canonical continent/region list, a verbatim re-export of the room-
 *     create duel flow's REGION_OPTS (same labels, same values, same backend
 *     region strings) — no new quick-match-only region dictionary.
 *   • the elapsed-seconds → accepted mode-level delta curve, mirroring the
 *     identical `quickMatchBracket` each duel game already ships, so the
 *     Kuşatma quick-match client widens the window the exact same way.
 *
 * No matchmaking logic lives here. The three duel games keep their own
 * server-authoritative startQuickMatch / tick / cancel; this module only
 * carries config + the intent shape so MobileHome and App stay in lockstep
 * without importing each other's internals.
 *
 * Parameter accuracy (matches the live queue/RPC backends — see audit):
 *   • Ülke Yaz Düellosu (country) → Süre (p_duration, sn) + Kıta (p_region)
 *   • Çark Düellosu      (wheel)   → Süre (p_duration, sn) + Kıta (p_region)
 *   • Bayrak Düellosu    (flag)    → Tur  (p_total_rounds) + Kıta (p_region)
 *   • Kuşatma            (conquest)→ Tur (round_count) + Harita (yalnız turkey)
 * The sheet shows only the two controls that actually reach the backend for the
 * selected mode — never a süre+tur combination the queue can't represent. The
 * duel modes carry region; conquest carries map (region is irrelevant there).
 */

/** The four modes surfaced by the Quick Match sheet. */
export type QuickMatchMode = "country" | "wheel" | "flag" | "conquest";

/** What the sheet hands up to App when the player taps the primary CTA. */
export interface QuickMatchIntent {
  mode: QuickMatchMode;
  /** country | wheel → seconds, mapped to the RPC's p_duration. */
  duration?: number;
  /** flag → p_total_rounds; conquest → round_count. */
  rounds?: number;
  /** Duel modes → p_region (continent value chosen in the Kıta picker). */
  region?: string;
  /** Conquest only — Türkiye is the single live map. */
  map?: "turkey";
}

/** A label/value pair the sheet's selector popover renders. */
export interface QmOption<T = number> {
  label: string;
  value: T;
}

/**
 * Süre seçenekleri — Ülke Yaz Düellosu. Birebir DuelGame DURATION_OPTS
 * (30 sn / 1 dk / 2 dk / 3 dk / 5 dk = saniye).
 */
export const QUICK_MATCH_COUNTRY_DURATIONS: QmOption[] = [
  { label: "30 sn", value: 30 },
  { label: "1 dk", value: 60 },
  { label: "2 dk", value: 120 },
  { label: "3 dk", value: 180 },
  { label: "5 dk", value: 300 },
];

/**
 * Süre seçenekleri — Çark Düellosu. Birebir WheelDuelGame DURATION_OPTIONS
 * (1 dk / 2 dk / 3 dk / 5 dk; Çark'ta 30 sn YOK).
 */
export const QUICK_MATCH_WHEEL_DURATIONS: QmOption[] = [
  { label: "1 dk", value: 60 },
  { label: "2 dk", value: 120 },
  { label: "3 dk", value: 180 },
  { label: "5 dk", value: 300 },
];

/** Tur seçenekleri — Bayrak Düellosu. Birebir FlagDuelGame ROUND_OPTS. */
export const QUICK_MATCH_FLAG_ROUNDS: QmOption[] = [
  { label: "5 Tur", value: 5 },
  { label: "10 Tur", value: 10 },
  { label: "15 Tur", value: 15 },
  { label: "20 Tur", value: 20 },
];

/** Tur seçenekleri — Kuşatma. Birebir CONQUEST_ROUND_COUNTS ([6, 8, 10]). */
export const QUICK_MATCH_CONQUEST_ROUNDS: QmOption[] = [
  { label: "6 Tur", value: 6 },
  { label: "8 Tur", value: 8 },
  { label: "10 Tur", value: 10 },
];

/**
 * Kıta seçenekleri — oda kurma (düello) akışındaki REGION_OPTS'un birebir
 * ortak export'u: aynı etiketler, aynı `value`'lar, aynı backend region
 * string'leri. Quick-match'e özel YENİ bir bölge sözlüğü değildir; yeni
 * value / farklı kıta ismi üretilmez. Default = "world" (Dünya).
 */
export const QUICK_MATCH_REGIONS: QmOption<string>[] = [
  { label: "🌍 Dünya", value: "world" },
  { label: "🇪🇺 Avrupa", value: "europe" },
  { label: "🌏 Asya", value: "asia" },
  { label: "🌍 Afrika", value: "africa" },
  { label: "🌎 Kuzey Amerika", value: "north-america" },
  { label: "🌎 Güney Amerika", value: "south-america" },
  { label: "🌊 Okyanusya", value: "oceania" },
];

/** Region every duel quick-match call defaults to (Dünya / all continents). */
export const QUICK_MATCH_DEFAULT_REGION = "world";

/** The only conquest map with implemented region data — enforced everywhere. */
export const QUICK_MATCH_CONQUEST_MAP = "turkey" as const;

/**
 * Kuşatma quick-match CTA gate (product decision #5). Kuşatma is VISIBLE and
 * selectable in the sheet (Tur + Harita), but its "Eşleşmeye Başla" stays
 * inert until the new backend (20260719120000_conquest_quick_match.sql) is
 * deployed AND a real 2-account 1v1 match has been playtested. Flip to `true`
 * once that migration is applied and verified. The three duel modes reuse the
 * already-live queues, so they are active regardless of this flag.
 */
export const CONQUEST_QUICK_MATCH_ENABLED = true;

/**
 * Elapsed search seconds → accepted mode-level delta. Byte-for-byte the same
 * curve the duel games ship (`<10s=0, <20s=±2, <30s=±5, <60s=±15, sonra
 * her seviye`). The server RPCs apply LEAST(caller, candidate), so both sides
 * must agree on this; sharing it keeps Kuşatma identical to the duels.
 */
export function quickMatchBracket(searchSeconds: number): number {
  if (searchSeconds < 10) return 0;
  if (searchSeconds < 20) return 2;
  if (searchSeconds < 30) return 5;
  if (searchSeconds < 60) return 15;
  return 9999;
}

/** Human-readable bracket label for the search screen ("±3 lv" / "her seviye"). */
export function quickMatchBracketLabel(searchSeconds: number): string {
  const b = quickMatchBracket(searchSeconds);
  return b >= 9999 ? "her seviye" : `±${b} lv`;
}
