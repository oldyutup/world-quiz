/**
 * templates.ts — Günün Görevi kanonik konfigürasyon matrisi (TEK KAYNAK).
 *
 * Buradaki matris:
 *   • build-daily-quest-data.ts codegen'i ile migration seed'ine
 *     (20260803120000_daily_quest_init.sql, GENERATED bölümleri) yazılır,
 *   • selector.ts + check-daily-quest-rotation.ts simülasyonlarında
 *     doğrudan import edilir.
 *
 * KURALLAR (elle düzenlerken koru):
 *   • configuration_key TÜM parametrelerin canonical birleşimi ve UNIQUE.
 *   • family_key yakın-benzer görev ailesi (mod + bölge/soru-sayısı/bant).
 *   • comparable_key aynı seri içinde doğrudan zorluk karşılaştırması yapılan
 *     gruptur; difficulty_score bu grup İÇİNDE hardlık arttıkça artmalıdır
 *     (zorluk-gerilemesi kuralı bu skoru kullanır).
 *   • Aynı comparable_key içindeki iki config, NEAR_SIMILAR eşiğinden daha
 *     yakın parametre taşıyamaz (aksi halde rotasyonda birbirini bloklar);
 *     assertTemplateMatrix() bunu doğrular.
 *   • Bütün parametreler mevcut oyun kuralları + canonical veriyle
 *     desteklenen değerlerdir: süreler DURATION_OPTIONS {15,30,60,120,180,300}
 *     alt kümesi, bölgeler getContinentIds bölgeleri, rota bantları
 *     route_duel_pool {5,7,8,9}, hedef sayıları bölge havuz boyutlarının
 *     güvenli altında.
 */

export type DailyQuestMode =
  | "country_write"
  | "flag_quiz"
  | "route_complete"
  | "wheel_find";

export type DailyQuestTier = "easy" | "normal" | "hard";

export type DailyQuestRegion =
  | "world"
  | "europe"
  | "asia"
  | "africa"
  | "north-america"
  | "south-america"
  | "oceania";

export interface CountryWriteConfig {
  region: DailyQuestRegion;
  duration_seconds: number;
  target_count: number;
}
export interface FlagQuizConfig {
  region: DailyQuestRegion;
  total_questions: number;
  required_correct: number;
  /** Sunucunun attempt penceresi (sn) — soru sayısından türetilir. */
  window_seconds: number;
}
export interface RouteCompleteConfig {
  intermediates: 5 | 7 | 8 | 9;
  deadline_seconds: number;
}
export interface WheelFindConfig {
  region: DailyQuestRegion;
  target_count: number;
  total_seconds: number;
}

export type DailyQuestConfig =
  | CountryWriteConfig
  | FlagQuizConfig
  | RouteCompleteConfig
  | WheelFindConfig;

export interface DailyQuestTemplate {
  configuration_key: string;
  family_key: string;
  comparable_key: string;
  mode: DailyQuestMode;
  metric: string;
  config: DailyQuestConfig;
  difficulty_score: number;
  difficulty_tier: DailyQuestTier;
  enabled: boolean;
  version: number;
  title: string;
  description: string;
}

/* ── Bölge etiketleri (UI + başlık üretimi) ─────────────────────────────── */
export const REGION_LABELS: Record<DailyQuestRegion, string> = {
  world: "Dünya",
  europe: "Avrupa",
  asia: "Asya",
  africa: "Afrika",
  "north-america": "Kuzey Amerika",
  "south-america": "Güney Amerika",
  oceania: "Okyanusya",
};

export function formatSecondsTr(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m > 0 && s > 0) return `${m} dakika ${s} saniye`;
  if (m > 0) return `${m} dakika`;
  return `${s} saniye`;
}

/* ── Zorluk skoru formülleri ────────────────────────────────────────────────
 * Skor YALNIZ aynı comparable_key içinde karşılaştırılır (regresyon kuralı);
 * grup içinde hardlık arttıkça monoton artması yeterlidir. Bölge katsayısı
 * raporlama/denge içindir.
 */
const CW_REGION_FACTOR: Record<DailyQuestRegion, number> = {
  world: 1.0, europe: 1.1, asia: 1.15, africa: 1.3,
  "north-america": 1.2, "south-america": 0.9, oceania: 1.25,
};
const FLAG_REGION_FACTOR: Record<DailyQuestRegion, number> = {
  world: 1.0, europe: 0.95, asia: 1.15, africa: 1.35,
  "north-america": 1.15, "south-america": 1.05, oceania: 1.4,
};
const WHEEL_REGION_FACTOR: Record<DailyQuestRegion, number> = {
  world: 1.0, europe: 0.85, asia: 0.9, africa: 0.95,
  "north-america": 0.9, "south-america": 0.8, oceania: 0.85,
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function countryWriteScore(c: CountryWriteConfig): number {
  return round1(
    (c.target_count / c.duration_seconds) * 60 * CW_REGION_FACTOR[c.region] * 10 +
      c.target_count * 0.5
  );
}
export function flagQuizScore(c: FlagQuizConfig): number {
  return round1(
    (c.required_correct / c.total_questions) * 100 * FLAG_REGION_FACTOR[c.region] * 0.1 +
      c.total_questions * 0.2
  );
}
export function routeCompleteScore(c: RouteCompleteConfig): number {
  return round1(c.intermediates * 10 + (300 - c.deadline_seconds) * 0.2);
}
export function wheelFindScore(c: WheelFindConfig): number {
  return round1(
    (c.target_count * 10 + (120 - c.total_seconds) * 0.5) * WHEEL_REGION_FACTOR[c.region]
  );
}

/* ── Yakın-benzerlik eşikleri (SQL _daily_quest_near_similar aynası) ────────
 * Aynı comparable_key içinde iki config'in parametre farkı eşiğin ALTINDA
 * veya eşitse "çok benzer" sayılır ve rotasyonda 45 günlük exact-cooldown
 * gibi davranır. Farklı comparable_key'ler ASLA birbirine benzer sayılmaz
 * (farklı bölge/süre/soru-sayısı doğrudan karşılaştırılamaz — spec).
 */
export const NEAR_SIMILAR_THRESHOLDS = {
  country_write_target: 2, // aynı bölge+süre, hedef farkı ≤ 2 → benzer
  flag_required: 1,        // aynı bölge+toplam, doğru hedef farkı ≤ 1 → benzer
  route_deadline: 15,      // aynı ara-ülke bandı, süre farkı ≤ 15 sn → benzer
  wheel_seconds: 5,        // aynı bölge+hedef sayısı, süre farkı ≤ 5 sn → benzer
} as const;

/** Config'in comparable ekseni üzerindeki skaler değeri (benzerlik ölçümü). */
export function similarityValue(t: DailyQuestTemplate): number {
  switch (t.mode) {
    case "country_write": return (t.config as CountryWriteConfig).target_count;
    case "flag_quiz":     return (t.config as FlagQuizConfig).required_correct;
    case "route_complete":return (t.config as RouteCompleteConfig).deadline_seconds;
    case "wheel_find":    return (t.config as WheelFindConfig).total_seconds;
  }
}

export function similarityThreshold(mode: DailyQuestMode): number {
  switch (mode) {
    case "country_write":  return NEAR_SIMILAR_THRESHOLDS.country_write_target;
    case "flag_quiz":      return NEAR_SIMILAR_THRESHOLDS.flag_required;
    case "route_complete": return NEAR_SIMILAR_THRESHOLDS.route_deadline;
    case "wheel_find":     return NEAR_SIMILAR_THRESHOLDS.wheel_seconds;
  }
}

/** İki template kullanıcı-gözüyle "neredeyse aynı" mı? */
export function isNearSimilar(a: DailyQuestTemplate, b: DailyQuestTemplate): boolean {
  if (a.mode !== b.mode) return false;
  if (a.comparable_key !== b.comparable_key) return false;
  return Math.abs(similarityValue(a) - similarityValue(b)) <= similarityThreshold(a.mode);
}

/* ── Yapıcılar ─────────────────────────────────────────────────────────── */

function cw(
  region: DailyQuestRegion,
  duration: number,
  target: number,
  tier: DailyQuestTier
): DailyQuestTemplate {
  const config: CountryWriteConfig = {
    region, duration_seconds: duration, target_count: target,
  };
  return {
    configuration_key: `country_write|${region}|${duration}|${target}`,
    family_key: `country_write|${region}|${duration}`,
    comparable_key: `country_write|${region}|${duration}`,
    mode: "country_write",
    metric: "unique_countries",
    config,
    difficulty_score: countryWriteScore(config),
    difficulty_tier: tier,
    enabled: true,
    version: 1,
    title: `Ülke Yaz: ${REGION_LABELS[region]}`,
    description: `${REGION_LABELS[region]} kategorisinde ${formatSecondsTr(duration)} içinde ${target} farklı ülke yaz.`,
  };
}

function fq(
  region: DailyQuestRegion,
  total: number,
  required: number,
  tier: DailyQuestTier
): DailyQuestTemplate {
  const config: FlagQuizConfig = {
    region, total_questions: total, required_correct: required,
    window_seconds: total * 25 + 30,
  };
  return {
    configuration_key: `flag_quiz|${region}|${total}|${required}`,
    family_key: `flag_quiz|${region}|${total}`,
    comparable_key: `flag_quiz|${region}|${total}`,
    mode: "flag_quiz",
    metric: "correct_flags",
    config,
    difficulty_score: flagQuizScore(config),
    difficulty_tier: tier,
    enabled: true,
    version: 1,
    title: `Bayrak Bilmece: ${REGION_LABELS[region]}`,
    description: `${REGION_LABELS[region]} kategorisinde ${total} bayrak göreceksin; en az ${required} tanesini doğru bilmen gerekiyor.`,
  };
}

function rc(
  intermediates: 5 | 7 | 8 | 9,
  deadline: number,
  tier: DailyQuestTier
): DailyQuestTemplate {
  const config: RouteCompleteConfig = {
    intermediates, deadline_seconds: deadline,
  };
  return {
    configuration_key: `route_complete|${intermediates}|${deadline}`,
    family_key: `route_complete|${intermediates}`,
    comparable_key: `route_complete|${intermediates}`,
    mode: "route_complete",
    metric: "route_completed",
    config,
    difficulty_score: routeCompleteScore(config),
    difficulty_tier: tier,
    enabled: true,
    version: 1,
    title: `Rota Modu: ${intermediates} ara ülke`,
    description: `Başlangıç ülkesinden hedefe ${intermediates} ara ülkeli rotayı ${formatSecondsTr(deadline)} içinde tamamla.`,
  };
}

function wf(
  region: DailyQuestRegion,
  targets: number,
  seconds: number,
  tier: DailyQuestTier
): DailyQuestTemplate {
  const config: WheelFindConfig = {
    region, target_count: targets, total_seconds: seconds,
  };
  const regionNote = region === "world" ? "" : ` (${REGION_LABELS[region]})`;
  return {
    configuration_key: `wheel_find|${region}|${targets}|${seconds}`,
    family_key: `wheel_find|${region}|${targets}`,
    comparable_key: `wheel_find|${region}|${targets}`,
    mode: "wheel_find",
    metric: "targets_found",
    config,
    difficulty_score: wheelFindScore(config),
    difficulty_tier: tier,
    enabled: true,
    version: 1,
    title: `Çark Modu: ${targets} hedef${regionNote}`,
    description: `Çarkın seçtiği ${targets} ülkeyi haritada toplam ${formatSecondsTr(seconds)} içinde bul${region === "world" ? "" : ` — yalnız ${REGION_LABELS[region]} haritasında`}.`,
  };
}

/* ── MATRİS ─────────────────────────────────────────────────────────────── */

export const DAILY_QUEST_TEMPLATES: DailyQuestTemplate[] = [
  /* Ülke Yaz — 17 */
  cw("world", 60, 10, "easy"),
  cw("world", 60, 14, "normal"),
  cw("world", 60, 18, "hard"),
  cw("world", 120, 16, "easy"),
  cw("world", 120, 20, "normal"),
  cw("world", 120, 26, "hard"),
  cw("world", 180, 24, "normal"),
  cw("world", 180, 30, "hard"),
  cw("world", 300, 40, "normal"),
  cw("world", 300, 50, "hard"),
  cw("europe", 60, 8, "easy"),
  cw("europe", 60, 12, "normal"),
  cw("europe", 60, 16, "hard"),
  cw("europe", 120, 20, "normal"),
  cw("asia", 60, 8, "easy"),
  cw("asia", 120, 16, "normal"),
  cw("africa", 120, 18, "normal"),

  /* Bayrak Bilmece — 16 */
  fq("world", 8, 5, "easy"),
  fq("world", 8, 7, "hard"),
  fq("world", 10, 7, "easy"),
  fq("world", 10, 9, "hard"),
  fq("world", 12, 8, "easy"),
  fq("world", 12, 10, "normal"),
  fq("world", 15, 11, "normal"),
  fq("world", 15, 13, "hard"),
  fq("world", 20, 14, "normal"),
  fq("world", 20, 17, "hard"),
  fq("europe", 10, 8, "normal"),
  fq("europe", 12, 9, "normal"),
  fq("asia", 10, 8, "normal"),
  fq("africa", 10, 7, "normal"),
  fq("africa", 12, 9, "hard"),
  fq("south-america", 10, 8, "easy"),

  /* Rota Modu — 16 (route_duel_pool bantları: 5/7/8/9 ara ülke) */
  rc(5, 195, "easy"),
  rc(5, 150, "easy"),
  rc(5, 105, "normal"),
  rc(5, 75, "hard"),
  rc(7, 225, "easy"),
  rc(7, 180, "normal"),
  rc(7, 135, "normal"),
  rc(7, 100, "hard"),
  rc(8, 255, "easy"),
  rc(8, 210, "normal"),
  rc(8, 160, "normal"),
  rc(8, 120, "hard"),
  rc(9, 285, "easy"),
  rc(9, 240, "normal"),
  rc(9, 185, "hard"),
  rc(9, 140, "hard"),

  /* Çark Modu — 16 */
  wf("world", 3, 60, "easy"),
  wf("world", 3, 42, "normal"),
  wf("world", 3, 30, "hard"),
  wf("world", 4, 75, "easy"),
  wf("world", 4, 54, "normal"),
  wf("world", 4, 40, "hard"),
  wf("world", 5, 90, "easy"),
  wf("world", 5, 66, "normal"),
  wf("world", 5, 50, "hard"),
  wf("world", 6, 105, "easy"),
  wf("world", 6, 78, "normal"),
  wf("world", 6, 60, "hard"),
  wf("europe", 3, 30, "normal"),
  wf("europe", 4, 40, "normal"),
  wf("europe", 5, 50, "normal"),
  wf("europe", 6, 60, "normal"),
];

/* ── Matris doğrulaması (codegen + testler çağırır) ─────────────────────── */

export interface MatrixProblem {
  key: string;
  problem: string;
}

/**
 * Matrisin iç tutarlılığını doğrular:
 *   • configuration_key unique
 *   • aynı comparable_key içinde NEAR_SIMILAR eşiğini ihlal eden çift yok
 *     (yoksa rotasyon kendi kendini bloklar)
 *   • aynı comparable_key içinde difficulty_score, benzerlik-ekseni hardlık
 *     yönüyle monoton (regresyon kuralının anlamlı olması için)
 *   • mod başına en az 12, toplam en az 48 config
 */
export function assertTemplateMatrix(
  templates: DailyQuestTemplate[] = DAILY_QUEST_TEMPLATES
): MatrixProblem[] {
  const problems: MatrixProblem[] = [];
  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.configuration_key)) {
      problems.push({ key: t.configuration_key, problem: "duplicate configuration_key" });
    }
    seen.add(t.configuration_key);
  }

  for (let i = 0; i < templates.length; i++) {
    for (let j = i + 1; j < templates.length; j++) {
      const a = templates[i], b = templates[j];
      if (a.configuration_key !== b.configuration_key && isNearSimilar(a, b)) {
        problems.push({
          key: `${a.configuration_key} ~ ${b.configuration_key}`,
          problem: "near-similar pair inside matrix (would block each other in rotation)",
        });
      }
    }
  }

  // comparable grup içinde skor monotonluğu: hard yönü mode'a göre
  const groups = new Map<string, DailyQuestTemplate[]>();
  for (const t of templates) {
    const g = groups.get(t.comparable_key) ?? [];
    g.push(t);
    groups.set(t.comparable_key, g);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const harderIsLargerValue =
      group[0].mode === "country_write" || group[0].mode === "flag_quiz";
    const sorted = [...group].sort((a, b) => similarityValue(a) - similarityValue(b));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      const scoreRises = cur.difficulty_score > prev.difficulty_score;
      const ok = harderIsLargerValue ? scoreRises : !scoreRises;
      if (!ok) {
        problems.push({
          key,
          problem: `difficulty_score not monotonic along hardness axis (${prev.configuration_key} → ${cur.configuration_key})`,
        });
      }
    }
  }

  const byMode = new Map<DailyQuestMode, number>();
  for (const t of templates) byMode.set(t.mode, (byMode.get(t.mode) ?? 0) + 1);
  for (const mode of ["country_write", "flag_quiz", "route_complete", "wheel_find"] as DailyQuestMode[]) {
    if ((byMode.get(mode) ?? 0) < 12) {
      problems.push({ key: mode, problem: `fewer than 12 configurations (${byMode.get(mode) ?? 0})` });
    }
  }
  if (templates.length < 48) {
    problems.push({ key: "total", problem: `fewer than 48 configurations (${templates.length})` });
  }

  return problems;
}
