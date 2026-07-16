/**
 * selector.ts — Günün Görevi deterministik seçici (SAF/DB'siz).
 *
 * 20260803120000_daily_quest_init.sql içindeki `_daily_quest_select_template`
 * fonksiyonunun BİREBİR aynası (check-route-duel-logic.ts simülasyon deseni).
 * Simülasyonlar (check-daily-quest-rotation.ts) ve kurallar bu katmanda
 * doğrulanır; SQL tarafı aynı kural setini uygular.
 *
 * DRIFT UYARISI: SQL seçim kuralları değişirse burası da güncellenmeli.
 *
 * KURAL SETİ (hepsi UTC gün aritmetiği, diff = today - usedDate gün olarak):
 *   SERT (asla gevşetilmez):
 *     H1. Aynı configuration_key diff ≤ 45 iken tekrar seçilemez.
 *     H2. Aynı mode diff ≤ 2 iken tekrar seçilemez (önceki 2 UTC gün).
 *     H3. Yakın-benzer config (aynı comparable_key + eşik-altı parametre
 *         farkı) diff ≤ 45 iken exact tekrar gibi bloklanır.
 *     H4. Zorluk gerilemesi: aynı comparable_key diff ≤ 30 içinde
 *         kullanıldıysa aday difficulty_score son 30 günün maksimumundan
 *         düşük olamaz. (Pencere dolunca tier reset serbest.)
 *   YUMUŞAK (sırayla gevşetilir):
 *     S1. family_key diff ≤ 7 → tercihen dışla; aday kalmazsa ≤ 5; o da
 *         kalmazsa family kısıtı tamamen düşer.
 *     S2. Tier dengesi: son 7 günde en az kullanılan tier'ın adayları
 *         tercih edilir (deterministik sıra easy→normal→hard); o tier'da
 *         aday yoksa sıradaki tier.
 *   SEÇİM: kalan adaylar arasından md5(quest_date + '|' + configuration_key)
 *   sözlük sırasına göre EN KÜÇÜK olan seçilir (tarih+geçmişe göre
 *   deterministik; client girdisi yok).
 */
import { createHash } from "node:crypto";
import {
  DAILY_QUEST_TEMPLATES,
  isNearSimilar,
  similarityThreshold,
  similarityValue,
  type DailyQuestTemplate,
  type DailyQuestTier,
} from "./templates";

export interface QuestHistoryEntry {
  /** UTC gün, "YYYY-MM-DD". */
  date: string;
  template: DailyQuestTemplate;
}

export const EXACT_COOLDOWN_DAYS = 45;
export const MODE_COOLDOWN_DAYS = 2;
export const FAMILY_COOLDOWN_DAYS = 7;
export const FAMILY_COOLDOWN_RELAXED_DAYS = 5;
export const REGRESSION_WINDOW_DAYS = 30;
export const TIER_BALANCE_WINDOW_DAYS = 7;

const TIER_ORDER: DailyQuestTier[] = ["easy", "normal", "hard"];

export function utcDayNumber(dateISO: string): number {
  return Math.floor(Date.parse(`${dateISO}T00:00:00Z`) / 86_400_000);
}

export function md5Hex(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

export class DailyQuestPoolExhaustedError extends Error {
  constructor(date: string) {
    super(`daily_quest_pool_exhausted: no eligible template for ${date}`);
    this.name = "DailyQuestPoolExhaustedError";
  }
}

/**
 * Bir UTC günü için görevi seçer. Aynı (date, history, templates) girdisi
 * her zaman aynı template'i döndürür.
 */
export function selectDailyQuest(
  dateISO: string,
  history: QuestHistoryEntry[],
  templates: DailyQuestTemplate[] = DAILY_QUEST_TEMPLATES
): DailyQuestTemplate {
  const today = utcDayNumber(dateISO);
  const withDiff = history
    .map((h) => ({ ...h, diff: today - utcDayNumber(h.date) }))
    .filter((h) => h.diff > 0); // yalnız geçmiş günler

  const blockedConfig = new Set(
    withDiff.filter((h) => h.diff <= EXACT_COOLDOWN_DAYS).map((h) => h.template.configuration_key)
  );
  const blockedModes = new Set(
    withDiff.filter((h) => h.diff <= MODE_COOLDOWN_DAYS).map((h) => h.template.mode)
  );
  const recent45 = withDiff.filter((h) => h.diff <= EXACT_COOLDOWN_DAYS);
  const recent30 = withDiff.filter((h) => h.diff <= REGRESSION_WINDOW_DAYS);

  const maxScoreByComparable = new Map<string, number>();
  for (const h of recent30) {
    const k = h.template.comparable_key;
    const cur = maxScoreByComparable.get(k);
    if (cur === undefined || h.template.difficulty_score > cur) {
      maxScoreByComparable.set(k, h.template.difficulty_score);
    }
  }

  const base = templates.filter((t) => {
    if (!t.enabled) return false;
    if (blockedConfig.has(t.configuration_key)) return false; // H1
    if (blockedModes.has(t.mode)) return false; // H2
    // H3 — yakın-benzer, exact cooldown penceresiyle aynı 45 günde bloklar.
    for (const h of recent45) {
      if (h.template.configuration_key === t.configuration_key) continue;
      if (isNearSimilar(t, h.template)) return false;
    }
    // H4 — zorluk gerilemesi.
    const maxRecent = maxScoreByComparable.get(t.comparable_key);
    if (maxRecent !== undefined && t.difficulty_score < maxRecent) return false;
    return true;
  });

  // S1 — family cooldown gevşetme merdiveni: 7 → 5 → 0.
  let candidates: DailyQuestTemplate[] = [];
  for (const windowDays of [FAMILY_COOLDOWN_DAYS, FAMILY_COOLDOWN_RELAXED_DAYS, 0]) {
    const famBlocked = new Set(
      withDiff.filter((h) => h.diff <= windowDays).map((h) => h.template.family_key)
    );
    candidates = base.filter((t) => !famBlocked.has(t.family_key));
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) {
    throw new DailyQuestPoolExhaustedError(dateISO);
  }

  // S2 — tier dengesi (deterministik): son 7 günde en az görülen tier tercih.
  const tierCounts = new Map<DailyQuestTier, number>([["easy", 0], ["normal", 0], ["hard", 0]]);
  for (const h of withDiff) {
    if (h.diff <= TIER_BALANCE_WINDOW_DAYS) {
      tierCounts.set(
        h.template.difficulty_tier,
        (tierCounts.get(h.template.difficulty_tier) ?? 0) + 1
      );
    }
  }
  const tierPreference = [...TIER_ORDER].sort((a, b) => {
    const ca = tierCounts.get(a)!;
    const cb = tierCounts.get(b)!;
    if (ca !== cb) return ca - cb;
    return TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b);
  });
  for (const tier of tierPreference) {
    const pool = candidates.filter((t) => t.difficulty_tier === tier);
    if (pool.length > 0) { candidates = pool; break; }
  }

  // Deterministik pick: md5(date|config_key) min.
  let best: DailyQuestTemplate | null = null;
  let bestHash = "";
  for (const t of candidates) {
    const h = md5Hex(`${dateISO}|${t.configuration_key}`);
    if (best === null || h < bestHash) { best = t; bestHash = h; }
  }
  return best!;
}

/* ── Simülasyon yardımcıları ────────────────────────────────────────────── */

export interface SimulationResult {
  entries: QuestHistoryEntry[];
  violations: string[];
}

export function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * `days` gün boyunca art arda seçim yapar; her seçimden sonra tüm sert
 * kuralları geçmişe karşı bağımsız olarak yeniden doğrular.
 */
export function simulateRotation(
  startDateISO: string,
  days: number,
  templates: DailyQuestTemplate[] = DAILY_QUEST_TEMPLATES,
  initialHistory: QuestHistoryEntry[] = []
): SimulationResult {
  const entries: QuestHistoryEntry[] = [...initialHistory];
  const violations: string[] = [];
  const byKey = new Map(templates.map((t) => [t.configuration_key, t]));

  for (let i = 0; i < days; i++) {
    const date = addDaysISO(startDateISO, i);
    const picked = selectDailyQuest(date, entries, templates);

    if (!byKey.has(picked.configuration_key) || !picked.enabled) {
      violations.push(`${date}: picked template not in enabled allowlist (${picked.configuration_key})`);
    }

    const today = utcDayNumber(date);
    for (const h of entries) {
      const diff = today - utcDayNumber(h.date);
      if (diff <= 0) continue;
      if (diff <= EXACT_COOLDOWN_DAYS && h.template.configuration_key === picked.configuration_key) {
        violations.push(`${date}: exact repeat within ${EXACT_COOLDOWN_DAYS}d of ${h.date} (${picked.configuration_key})`);
      }
      if (diff <= MODE_COOLDOWN_DAYS && h.template.mode === picked.mode) {
        violations.push(`${date}: mode repeat within ${MODE_COOLDOWN_DAYS}d of ${h.date} (${picked.mode})`);
      }
      if (
        diff <= EXACT_COOLDOWN_DAYS &&
        h.template.configuration_key !== picked.configuration_key &&
        isNearSimilar(picked, h.template)
      ) {
        violations.push(
          `${date}: near-similar repeat of ${h.date} (${picked.configuration_key} ~ ${h.template.configuration_key}, |Δ|=${Math.abs(similarityValue(picked) - similarityValue(h.template))} ≤ ${similarityThreshold(picked.mode)})`
        );
      }
      if (
        diff <= REGRESSION_WINDOW_DAYS &&
        h.template.comparable_key === picked.comparable_key &&
        picked.difficulty_score < h.template.difficulty_score
      ) {
        violations.push(
          `${date}: difficulty regression vs ${h.date} in ${picked.comparable_key} (${picked.difficulty_score} < ${h.template.difficulty_score})`
        );
      }
    }

    entries.push({ date, template: picked });
  }

  return { entries, violations };
}
