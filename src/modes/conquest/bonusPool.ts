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
 * Full pool of bonus types.  Order is documentation only — the selector
 * groups by category internally.
 *
 * `ankara_hidden_shield` ("Gizli Operasyon") and `karadeniz_extra_time`
 * ("Zaman Takviyesi") are real, wired open bonuses and are catalogued here
 * with `implemented: true` so the lobby vote panel surfaces them alongside
 * the rest of the pool.  Their gameplay copy still lives in REGION_BONUSES
 * (legacy region-tied entries) — only the display label / category /
 * description used by lobby UI lives in this catalog.
 */
export const BONUS_POOL: readonly BonusPoolEntry[] = [
  // ── Savunma ────────────────────────────────────────────────────────────────
  {
    type:        "istanbul_defense",
    category:    "savunma",
    icon:        "🛡️",
    label:       "Kale Surları",
    description: "Bu bölgeyi fetheden oyuncu Kale Surları kazanır. Bölgeye gelen ilk başarılı düşman saldırısı bölgeyi değil surları yıkar.",
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
    type:        "karadeniz_extra_time",
    category:    "savunma",
    icon:        "⏳",
    label:       "Zaman Takviyesi",
    description: "Soru süresine +5 saniye ekler.",
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
    description: "Kalkanları aşar. Rakip bölge fethedince +1 puan kazandırır.",
    implemented: true,
  },
  {
    type:        "ankara_hidden_shield",
    category:    "saldiri",
    icon:        "🎭",
    label:       "Gizli Operasyon",
    description: "Gizli bir hamle yapmanı sağlar.",
    implemented: true,
  },
  {
    type:        "gecit",
    category:    "saldiri",
    icon:        "🌉",
    label:       "Köprü Başı",
    description: "Hamle erişimini genişleten bir bonus (henüz uygulanmadı).",
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
  {
    type:        "mancinik",
    category:    "saldiri",
    icon:        "🎯",
    label:       "Mancınık",
    description: "Bu bölgeyi fetheden oyuncu tek kullanımlık uzak saldırı hakkı kazanır. Bir sonraki saldırıda komşuluk sınırı olmadan haritadaki herhangi bir bölge hedeflenebilir. Kullanılınca biter. Kale Surları'nı yok saymaz.",
    implemented: true,
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
    label:       "Kâhin Büyüsü",
    description: "Bu bölgeyi elinde tutan oyuncu sıradaki sorunun türünü önceden görür. Bölge el değiştirirse avantaj da el değiştirir.",
    implemented: true,
  },
  {
    type:        "atlas",
    category:    "bilgi",
    icon:        "🗺️",
    label:       "Atlas",
    description: "Harita bilgisi avantajı sağlayan bir bonus.",
    implemented: false,
  },
  {
    type:        "istihbarat_agi",
    category:    "bilgi",
    icon:        "👁️",
    label:       "İstihbarat Ağı",
    description: "Bu bölgeyi elinde tutan oyuncu rakip gizli bonus keşiflerini ve Gizli Operasyon hedeflerini rapor olarak görür. Bölge el değiştirirse avantaj da el değiştirir.",
    implemented: true,
  },
  // ── Ekonomi ────────────────────────────────────────────────────────────────
  {
    type:        "cukurova_score",
    category:    "ekonomi",
    icon:        "🌾",
    label:       "Bereketli Ova",
    description: "Bu bölgeyi fetheden oyuncuya anında +2 bonus puan. Aynı oyuncu 3 tur boyunca elinde tutarsa bir kereye mahsus +4 puanlık hasat bonusu kazanır; bölge el değiştirmeden tekrar hasat verilmez. El değiştirince sayaç sıfırlanır.",
    implemented: true,
  },
  {
    type:        "liman",
    category:    "ekonomi",
    icon:        "⚓",
    label:       "Liman",
    description: "Sadece kıyı bölgelerinde çıkar. Sahibi her tur sonunda +1 puan ve +5 Gold kazanır (en fazla 10 kez). Sahip değişirse sayaç sıfırlanır.",
    implemented: true,
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
 * Vote-mode active bonus count.  One more than the random-mode count per the
 * lobby UX spec — players each pick this many bonuses, the top vote-getters
 * become active when the match starts.
 *
 *   2 players → 4 bonuses (vote slots per player)
 *   3 players → 5
 *   4+ players → 6
 */
export function voteBonusCountForPlayers(playerCount: number): number {
  if (playerCount <= 2) return 4;
  if (playerCount === 3) return 5;
  return 6;
}

/**
 * Bonus pool entries that are eligible to appear in the lobby vote UI.
 * Mirrors `buildActiveBonusTypes` filtering — only `implemented: true` types
 * are voteable.  Order matches BONUS_POOL declaration so the UI groups by
 * category visually.
 */
export const VOTEABLE_BONUS_POOL: readonly BonusPoolEntry[] =
  BONUS_POOL.filter(e => e.implemented);

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
 * Resolve the final active open-bonus types for a match in **vote** mode.
 *
 * Inputs:
 *   - `votes`        : playerId → bonus types they voted for (from lobby).
 *   - `playerCount`  : roster size at game start; determines target N
 *                      (2→4, 3→5, 4+→6) via `voteBonusCountForPlayers`.
 *   - `matchSeed`    : per-match seed (gameState.startedAt) so host/guest
 *                      derive an identical tie-break and fallback fill.
 *
 * Selection rules:
 *   1. Only types present in `VOTEABLE_BONUS_POOL` (implemented open bonuses)
 *      are eligible.  Hidden bonuses (Suikast / Lanet Mührü / Pusu) and
 *      placeholder pool entries (`implemented:false`) never enter the result.
 *   2. Tally one vote per (player, type).  Sort by descending tally; break
 *      ties deterministically using a seeded permutation of the eligible
 *      pool (every client computes the same order from `matchSeed`).
 *   3. Take up to N from the sorted list.  If fewer than N unique bonuses
 *      received any vote, fill the remaining slots from the eligible pool
 *      using a seeded shuffle — never duplicates.  If the pool itself has
 *      fewer than N implemented types, the returned list is shorter (no
 *      error thrown).
 */
export function resolveActiveBonusTypesFromVotes(
  votes:       Record<string, readonly ConquestRegionBonusType[]>,
  playerCount: number,
  matchSeed:   number,
): ConquestRegionBonusType[] {
  const target = voteBonusCountForPlayers(playerCount);

  // Eligible pool — implemented open bonuses only.
  const eligibleTypes = VOTEABLE_BONUS_POOL.map(e => e.type);
  const eligibleSet   = new Set<ConquestRegionBonusType>(eligibleTypes);

  // Tally votes, filtering out anything not in the voteable pool.
  const counts = new Map<ConquestRegionBonusType, number>();
  for (const list of Object.values(votes)) {
    if (!list) continue;
    for (const t of list) {
      if (!eligibleSet.has(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }

  // Deterministic tie-break order: seeded shuffle of the eligible pool keyed
  // by matchSeed.  Two clients with the same (votes, playerCount, matchSeed)
  // always produce the same final list.
  const rng         = mulberry32(seedFromMatchSeed(matchSeed));
  const tieOrder    = shuffledSeeded(eligibleTypes, rng);
  const tieRank     = new Map<ConquestRegionBonusType, number>();
  tieOrder.forEach((t, i) => tieRank.set(t, i));

  const voted = [...counts.keys()].sort((a, b) => {
    const dc = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    if (dc !== 0) return dc;
    return (tieRank.get(a) ?? 0) - (tieRank.get(b) ?? 0);
  });

  const picked: ConquestRegionBonusType[] = voted.slice(0, target);

  // Fallback fill — seeded random over remaining eligible types.  Uses the
  // same `rng` stream so the fill order is also deterministic per match.
  if (picked.length < target) {
    const pickedSet = new Set(picked);
    const remaining = shuffledSeeded(
      eligibleTypes.filter(t => !pickedSet.has(t)),
      rng,
    );
    for (const t of remaining) {
      if (picked.length >= target) break;
      picked.push(t);
    }
  }

  return picked;
}

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
