/**
 * Conquest (Kuşatma) — bonus pool catalog + balanced selector (infra only).
 *
 * Forward-looking catalog of 12 bonus types organised into 4 categories.
 * This file is the SINGLE SOURCE of truth for the new bonus pool: type
 * membership, category mapping, label/icon/description copy, and the
 * `implemented` flag that gates which types may currently be drafted by the
 * pool-driven selector.
 *
 * Scope of this first revision is intentionally infra-only:
 *
 *   - The 12 type literals are added to `ConquestRegionBonusType`
 *     (see types.ts) for type safety across the codebase.
 *   - The pool catalog and `buildActiveBonusTypes` selector live here.
 *   - `buildActiveBonusTypes` is NOT yet called by the active match-creation
 *     path (`createInitialConquestGameState` still uses the legacy
 *     `ROTATING_BONUS_TYPES` set inside `conquestRoundBonuses.ts`).  That
 *     keeps gameplay observably identical for now.
 *   - Only entries with `implemented: true` are eligible for selection —
 *     currently `istanbul_defense` and `cukurova_score`.  As future PRs wire
 *     real effects for the remaining 10 types, flip the flag and they
 *     automatically join the draft pool.  No selector code change required.
 *
 * Until the selector is wired into the live match-creation path, the new 10
 * types never reach a region assignment, so they never surface in any UI
 * (bonus guide, panel, map badge, toast).  This is enforced by data, not by
 * filtering in each UI surface.
 */

import type { ConquestRegionBonusType } from "./types";

/** Four canonical bonus categories used to balance selection across roles. */
export type BonusCategory = "savunma" | "saldiri" | "bilgi" | "ekonomi";

/** Stable ordered list of categories — drives deterministic iteration in the
 *  selector so a given (playerCount, matchSeed) tuple always yields the same
 *  draft regardless of `Object.keys` ordering. */
export const BONUS_CATEGORIES: readonly BonusCategory[] = [
  "savunma",
  "saldiri",
  "bilgi",
  "ekonomi",
] as const;

/** One catalog entry per bonus type. */
export interface BonusPoolEntry {
  type:        ConquestRegionBonusType;
  category:    BonusCategory;
  icon:        string;
  label:       string;
  description: string;
  /**
   * `true` when the bonus has a wired gameplay effect today.  Selector
   * filters on this flag so unimplemented bonuses are never drafted; UI
   * surfaces that iterate live `roundBonuses` therefore never display
   * placeholder copy from this catalog.
   */
  implemented: boolean;
}

/**
 * Full pool of 12 bonus types.  Order is documentation only — the selector
 * groups by category internally.
 *
 * Implementation note: the two legacy types that are currently in
 * ROTATING_BONUS_TYPES but NOT in this user-defined pool list
 * (`ankara_hidden_shield`, `karadeniz_extra_time`) are intentionally absent.
 * They remain in the `ConquestRegionBonusType` union and continue to be
 * assigned by the legacy path; they will eventually be retired or
 * re-categorised in a follow-up PR.
 */
export const BONUS_POOL: readonly BonusPoolEntry[] = [
  // ── Savunma ────────────────────────────────────────────────────────────────
  {
    type:        "istanbul_defense",
    category:    "savunma",
    icon:        "🛡️",
    label:       "Boğaz Kalesi",
    description: "Bu bölgeyi fetheden oyuncu açık kalkan kazanır. Bölgeye gelen ilk düşman saldırısı, bölgeyi değil kalkanı kırar.",
    implemented: true,
  },
  {
    type:        "mevzi_bekcisi",
    category:    "savunma",
    icon:        "🏰",
    label:       "Mevzi Bekçisi",
    description: "Bu bölgeyi kaybetsen bile puanını korursun.",
    implemented: true,
  },
  {
    type:        "direnis",
    category:    "savunma",
    icon:        "✊",
    label:       "Direniş",
    description: "Bölgeyi kaybetmeyi zorlaştıran bir bonus.",
    implemented: false,
  },
  // ── Saldırı ────────────────────────────────────────────────────────────────
  {
    type:        "kocbasi",
    category:    "saldiri",
    icon:        "🪵",
    label:       "Koçbaşı",
    description: "Saldırı gücünü artıran bir bonus.",
    implemented: false,
  },
  {
    type:        "gecit",
    category:    "saldiri",
    icon:        "🌉",
    label:       "Geçit",
    description: "Hamle erişimini genişleten bir bonus.",
    implemented: false,
  },
  {
    type:        "kiskac_harekati",
    category:    "saldiri",
    icon:        "🦀",
    label:       "Kıskaç Harekatı",
    description: "Çoklu cephede saldırı imkânı tanıyan bir bonus.",
    implemented: false,
  },
  // ── Bilgi ──────────────────────────────────────────────────────────────────
  {
    type:        "eleme_yetkisi",
    category:    "bilgi",
    icon:        "🃏",
    label:       "Eleme Yetkisi",
    description: "Sonraki test sorunda 1 yanlış şık silinir.",
    implemented: true,
  },
  {
    type:        "kahin",
    category:    "bilgi",
    icon:        "🔮",
    label:       "Kahin",
    description: "Sonraki tur hakkında öngörü sağlayan bir bonus.",
    implemented: false,
  },
  {
    type:        "atlas",
    category:    "bilgi",
    icon:        "🗺️",
    label:       "Atlas",
    description: "Harita bilgisi avantajı sağlayan bir bonus.",
    implemented: false,
  },
  // ── Ekonomi ────────────────────────────────────────────────────────────────
  {
    type:        "cukurova_score",
    category:    "ekonomi",
    icon:        "🌾",
    label:       "Bereketli Ova",
    description: "Bu bölgeyi maçta ilk fetheden oyuncuya tek seferlik +1 puan verilir.",
    implemented: true,
  },
  {
    type:        "liman",
    category:    "ekonomi",
    icon:        "⚓",
    label:       "Liman",
    description: "Kaynak akışını hızlandıran bir bonus.",
    implemented: false,
  },
  {
    type:        "ganimet",
    category:    "ekonomi",
    icon:        "💎",
    label:       "Ganimet",
    description: "Fetihten ek ödül kazandıran bir bonus.",
    implemented: false,
  },
];

/** Quick lookup index from bonus type to its catalog entry.  Null when the
 *  type is not part of the new pool (e.g. the two legacy types that remain
 *  in the union but are catalogued in `regionBonuses.ts`). */
const POOL_BY_TYPE: Map<ConquestRegionBonusType, BonusPoolEntry> = (() => {
  const m = new Map<ConquestRegionBonusType, BonusPoolEntry>();
  for (const e of BONUS_POOL) m.set(e.type, e);
  return m;
})();

export function getBonusPoolEntry(
  type: ConquestRegionBonusType,
): BonusPoolEntry | null {
  return POOL_BY_TYPE.get(type) ?? null;
}

/**
 * Number of active bonus types to draft for a given player count.
 *
 *   2 players → 3 bonuses
 *   3 players → 4 bonuses
 *   4+ players → 5 bonuses
 */
export function activeBonusCountForPlayers(playerCount: number): number {
  if (playerCount <= 2) return 3;
  if (playerCount === 3) return 4;
  return 5;
}

/**
 * Resolved per-match active bonus type set.  Same shape as the input to the
 * existing `scoreCandidate` region picker, so swapping ROTATING_BONUS_TYPES
 * for this output is a drop-in replacement when the time comes.
 */
export type ActiveBonusTypes = ConquestRegionBonusType[];

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic helpers (local copies so this module stays decoupled).
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bit mix so wall-clock low bits aren't directly exposed to the picker. */
function seedFromMatchSeed(matchSeed: number): number {
  const a = (matchSeed >>> 0);
  const b = (0x85ebca6b >>> 0);  // different constant from matchBonusSeed so
                                  // two parallel seeded streams don't shadow
                                  // each other when used in the same match
  return (a ^ b ^ ((a << 7) | (a >>> 25))) >>> 0;
}

function shuffledSeeded<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j   = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selector — pure function; not yet wired into match creation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick a balanced, deterministic set of active bonus types for a match.
 * Pure function — same `(playerCount, matchSeed)` always yields the same
 * draft.  Only entries with `implemented: true` are eligible.
 *
 * Balance rules:
 *
 *   - 3 players (4 picks): one entry from each of the 4 categories.
 *   - 4+ players (5 picks): one entry from each category, then one extra
 *     drawn at random from the pool of remaining (already-picked types
 *     excluded; category may repeat).
 *   - 2 players (3 picks): randomly drop one of the 4 categories, then
 *     draft one entry from each of the remaining 3.
 *
 * Graceful degradation:
 *
 *   - If a chosen category has zero implemented entries, it is skipped.
 *   - Therefore in the current state where only `istanbul_defense`
 *     (savunma) and `cukurova_score` (ekonomi) are implemented, this
 *     selector returns at most 2 entries even for higher player counts.
 *     The active match-creation path still uses the legacy 4-type set, so
 *     this is purely a design-time observation.
 */
export function buildActiveBonusTypes(
  playerCount: number,
  matchSeed:   number,
): ActiveBonusTypes {
  const rng   = mulberry32(seedFromMatchSeed(matchSeed));
  const count = activeBonusCountForPlayers(playerCount);

  const byCategory: Record<BonusCategory, BonusPoolEntry[]> = {
    savunma:  [],
    saldiri:  [],
    bilgi:    [],
    ekonomi:  [],
  };
  for (const e of BONUS_POOL) {
    if (!e.implemented) continue;
    byCategory[e.category].push(e);
  }

  // Decide which categories contribute one base pick each.
  let baseCategories: BonusCategory[];
  if (count === 3) {
    baseCategories = shuffledSeeded(BONUS_CATEGORIES, rng).slice(0, 3);
  } else {
    // 4 or 5 picks → one from each category.
    baseCategories = BONUS_CATEGORIES.slice();
  }

  const picked: ConquestRegionBonusType[] = [];
  for (const cat of baseCategories) {
    const bucket = byCategory[cat];
    if (bucket.length === 0) continue;
    const choice = bucket[Math.floor(rng() * bucket.length)];
    picked.push(choice.type);
  }

  // Extra pick for 5-bonus draft: any remaining implemented type.
  if (count === 5) {
    const remaining = BONUS_POOL.filter(
      e => e.implemented && !picked.includes(e.type),
    );
    if (remaining.length > 0) {
      const choice = remaining[Math.floor(rng() * remaining.length)];
      picked.push(choice.type);
    }
  }

  return picked;
}
