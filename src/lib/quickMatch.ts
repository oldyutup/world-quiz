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
 * The sheet shows only the two controls that actually reach the backend for the
 * selected mode — never a süre+tur combination the queue can't represent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ÜRÜN KARARI — KUŞATMA'NIN HIZLI EŞLEŞ'İ YOKTUR
 * ══════════════════════════════════════════════════════════════════════════
 * Kuşatma YALNIZ kendi oda/lobi akışıyla oynanır (kayıtlı kullanıcı oda kurar,
 * diğerleri oda kodu/davet ile katılır, host lobide başlatır). Bu modülde
 * `QuickMatchMode` birliğinde "conquest" YOKTUR: bir Kuşatma hızlı-eşleşme
 * niyeti TİP DÜZEYİNDE temsil edilemez, dolayısıyla ne masaüstü modalı
 * (QuickMatchModal) ne mobil sheet (MobileHome) ne de App yönlendirmesi
 * Kuşatma'yı seçebilir.
 *
 * Sunucudaki eski `conquest_quick_match` / `conquest_cancel_quick_match` /
 * `conquest_reset_quick_match` RPC'leri ve `conquest_quick_match_queue` tablosu
 * SİLİNMEDİ (canlı DB nesnesi salt-temizlik için düşürülmez) ama ÜRÜN
 * YÜZEYİNDEN ERİŞİLEMEZ: onları çağıran tek kod yolu ConquestMode'un
 * `autoQuickMatch` prop'udur ve App artık bu prop'u HİÇ geçmez.
 */

/** The four modes surfaced by the Quick Match entry surfaces. Kuşatma is
 *  DELIBERATELY absent — see the product decision in the header. */
export type QuickMatchMode = "country" | "wheel" | "flag" | "route";

/** Runtime guard for values that cross a trust boundary (sessionStorage
 *  restore after an OAuth round-trip). A build that once wrote
 *  `{"mode":"conquest"}` must NOT be able to resurrect a Kuşatma quick match
 *  after this build removed it, so the parse side re-validates instead of
 *  trusting the persisted string. */
export const QUICK_MATCH_MODES: readonly QuickMatchMode[] = ["country", "wheel", "flag", "route"] as const;

export function isQuickMatchMode(value: unknown): value is QuickMatchMode {
  return typeof value === "string" && (QUICK_MATCH_MODES as readonly string[]).includes(value);
}

/** What the sheet hands up to App when the player taps the primary CTA. */
export interface QuickMatchIntent {
  mode: QuickMatchMode;
  /** country | wheel → seconds, mapped to the RPC's p_duration. */
  duration?: number;
  /** flag | route → p_total_rounds. */
  rounds?: number;
  /** Duel modes → p_region (continent value chosen in the Kıta picker). */
  region?: string;
  /** Route duel only → p_route_length ('5' | '7' | '7plus'). */
  routeLength?: string;
}

/** A label/value pair the sheet's selector popover renders. */
export interface QmOption<T = number> {
  label: string;
  value: T;
  /** Locked "Yakında" row: rendered but not selectable and never handed to a
   *  queue parameter. Optional so the duration/round/region arrays stay
   *  assignable unchanged. */
  disabled?: boolean;
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

/** Tur seçenekleri — Rota 1v1. Birebir ROUTE_DUEL_ROUND_OPTIONS
 *  (routeDuelShared.ts) + route_duel_quick_match RPC check'i (3/5/10/15). */
export const QUICK_MATCH_ROUTE_ROUNDS: QmOption[] = [
  { label: "3 Tur", value: 3 },
  { label: "5 Tur", value: 5 },
  { label: "10 Tur", value: 10 },
  { label: "15 Tur", value: 15 },
];

/** Rota uzunluğu seçenekleri — Rota 1v1. Birebir ROUTE_DUEL_LENGTH_OPTIONS
 *  + RPC check'i ('5'/'7'/'7plus'). Eşleşme AYNI uzunluk tercihini ister. */
export const QUICK_MATCH_ROUTE_LENGTHS: QmOption<string>[] = [
  { label: "5 ara ülke", value: "5" },
  { label: "7 ara ülke", value: "7" },
  { label: "7+ ara ülke", value: "7plus" },
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

/**
 * Shared duel matchmaking blurb (Ülke Yaz / Çark / Bayrak) — the three modes
 * that pull from the same seviye-bracket queue.
 */
export const QUICK_MATCH_DUEL_DESC =
  "Seviyene yakın bir rakiple birebir eşleş. Bekledikçe seviye penceresi genişler.";

/** Canonical metadata for one mode surfaced by a Hızlı Eşleş entry. */
export interface QuickMatchModeMeta {
  mode: QuickMatchMode;
  /** Display label for the mode chip. */
  label: string;
  /** One-line matchmaking blurb shown under the active mode. */
  desc: string;
  /** false → the chip is still selectable and its config visible, but the
   *  "Eşleşme Ara" CTA stays inert (backend not live yet). */
  enabled: boolean;
}

/**
 * The four modes that own a real, live 1v1 quick-match queue — the single
 * source of truth for the mode SET + enabled state shared by every Hızlı Eşleş
 * entry surface. Only presentation (icon choice, exact wording) may vary per
 * surface; the modes listed here and their `enabled` flags do not. Ordered so
 * a playable duel (Ülke Yaz) leads and is the natural default selection.
 *
 * Kuşatma is NOT here and must never be re-added: it is room/lobby-only by
 * product decision (see header).
 *
 * NOTE: MobileHome keeps its own equivalent local list for the native sheet;
 * this export is consumed by the desktop entry (QuickMatchModal). Both derive
 * from the same option arrays, so they cannot diverge on which modes are live.
 */
export const QUICK_MATCH_MODE_META: QuickMatchModeMeta[] = [
  { mode: "country",  label: "Ülke Yaz 1v1",  desc: QUICK_MATCH_DUEL_DESC, enabled: true },
  { mode: "wheel",    label: "Çark 1v1",      desc: QUICK_MATCH_DUEL_DESC, enabled: true },
  { mode: "flag",     label: "Bayrak 1v1",    desc: QUICK_MATCH_DUEL_DESC, enabled: true },
  { mode: "route",    label: "Rota Modu 1v1", desc: QUICK_MATCH_DUEL_DESC, enabled: true },
];
