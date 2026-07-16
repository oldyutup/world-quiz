/**
 * check-daily-quest-rotation.ts — Günün Görevi rotasyon/çeşitlilik sözleşmesi.
 *
 * SQL _daily_quest_select_template'in saf TS aynası (scripts/dailyQuest/
 * selector.ts) üzerinde:
 *   • matris doğrulaması (unique key, mod başına ≥12, toplam ≥48,
 *     matris-içi yakın-benzer çift yok, skor monotonluğu)
 *   • 90 / 180 / 365 günlük simülasyonlar (tüm sert kurallar her gün geçmişe
 *     karşı bağımsız yeniden doğrulanır; havuz tükenmez)
 *   • determinizm (aynı tarih + aynı geçmiş → aynı seçim; iki koşu birebir)
 *   • zorluk-gerilemesi + 30 gün sonrası tier reset hedefli senaryoları
 *   • yakın-benzer bloğu hedefli senaryosu
 *   • havuz tükenmesinin SESSİZ tekrar yerine açık hata üretmesi
 *   • tier dağılımının tek yöne kilitlenmemesi
 *
 * Çalıştır:  npx tsx scripts/check-daily-quest-rotation.ts
 */
import {
  assertTemplateMatrix,
  DAILY_QUEST_TEMPLATES,
  isNearSimilar,
  type DailyQuestTemplate,
} from "./dailyQuest/templates";
import {
  addDaysISO,
  DailyQuestPoolExhaustedError,
  selectDailyQuest,
  simulateRotation,
  EXACT_COOLDOWN_DAYS,
  MODE_COOLDOWN_DAYS,
} from "./dailyQuest/selector";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const START = "2026-08-03";

/* ── 1) Matris ─────────────────────────────────────────────────────────── */
console.log("\n[1] Şablon matrisi");
{
  const problems = assertTemplateMatrix();
  ok(problems.length === 0, "matris iç tutarlı (unique / benzerlik / monotonluk / sayılar)", problems);
  ok(DAILY_QUEST_TEMPLATES.length >= 48, `toplam config ≥ 48 (${DAILY_QUEST_TEMPLATES.length})`);
  for (const mode of ["country_write", "flag_quiz", "route_complete", "wheel_find"]) {
    const n = DAILY_QUEST_TEMPLATES.filter((t) => t.mode === mode).length;
    ok(n >= 12, `${mode} config ≥ 12 (${n})`);
  }
}

/* ── 2) 90 / 180 / 365 gün simülasyonları ─────────────────────────────── */
console.log("\n[2] Uzun dönem simülasyonları");
for (const days of [90, 180, 365]) {
  try {
    const sim = simulateRotation(START, days);
    ok(sim.violations.length === 0, `${days} gün: kural ihlali yok`, sim.violations.slice(0, 3));
    ok(sim.entries.length === days, `${days} gün: her gün görev üretildi (havuz tükenmedi)`);
    if (days === 365) {
      const modeCounts = new Map<string, number>();
      const tierCounts = new Map<string, number>();
      const keyDates = new Map<string, number[]>();
      sim.entries.forEach((e, i) => {
        modeCounts.set(e.template.mode, (modeCounts.get(e.template.mode) ?? 0) + 1);
        tierCounts.set(e.template.difficulty_tier, (tierCounts.get(e.template.difficulty_tier) ?? 0) + 1);
        const arr = keyDates.get(e.template.configuration_key) ?? [];
        arr.push(i);
        keyDates.set(e.template.configuration_key, arr);
      });
      // Exact 45 gün cooldown'unun ikinci bir bağımsız doğrulaması:
      let minGap = Infinity;
      for (const dates of keyDates.values()) {
        for (let i = 1; i < dates.length; i++) minGap = Math.min(minGap, dates[i] - dates[i - 1]);
      }
      ok(minGap > EXACT_COOLDOWN_DAYS, `365 gün: aynı config_key min aralık ${minGap} > ${EXACT_COOLDOWN_DAYS}`);
      // Mode cooldown bağımsız doğrulama:
      let minModeGap = Infinity;
      const lastByMode = new Map<string, number>();
      sim.entries.forEach((e, i) => {
        const last = lastByMode.get(e.template.mode);
        if (last !== undefined) minModeGap = Math.min(minModeGap, i - last);
        lastByMode.set(e.template.mode, i);
      });
      ok(minModeGap > MODE_COOLDOWN_DAYS, `365 gün: aynı mode min aralık ${minModeGap} > ${MODE_COOLDOWN_DAYS}`);
      // Tier dağılımı tek yöne kilitlenmiyor:
      for (const tier of ["easy", "normal", "hard"]) {
        const n = tierCounts.get(tier) ?? 0;
        ok(n >= 365 * 0.15, `365 gün: ${tier} payı ≥ %15 (${n}/365)`);
      }
      console.log("    mod dağılımı:", Object.fromEntries(modeCounts));
      console.log("    tier dağılımı:", Object.fromEntries(tierCounts));
    }
  } catch (e) {
    ok(false, `${days} gün simülasyonu tamamlandı`, (e as Error).message);
  }
}

/* ── 3) Determinizm ───────────────────────────────────────────────────── */
console.log("\n[3] Determinizm");
{
  const a = simulateRotation(START, 120);
  const b = simulateRotation(START, 120);
  ok(
    a.entries.every((e, i) => e.template.configuration_key === b.entries[i].template.configuration_key),
    "aynı başlangıç + aynı geçmiş → 120 günlük seçim dizisi birebir aynı"
  );
  // Aynı gün, aynı geçmiş, bağımsız iki çağrı (eşzamanlı iki kullanıcı /
  // iki üretim isteği modeli) → aynı template.
  const history = a.entries.slice(0, 60);
  const day = addDaysISO(START, 60);
  const p1 = selectDailyQuest(day, history);
  const p2 = selectDailyQuest(day, history);
  ok(p1.configuration_key === p2.configuration_key,
    "aynı UTC günü için bağımsız iki seçim aynı görevi üretir");
  // Farklı UTC günleri farklı seçim akışı üretir (gün değişimi):
  const nextDay = addDaysISO(day, 1);
  const p3 = selectDailyQuest(nextDay, [...history, { date: day, template: p1 }]);
  ok(p3.mode !== p1.mode, "yeni UTC gününde mode cooldown uygulanır (farklı mod)");
}

/* ── 4) Zorluk gerilemesi + 30 gün sonrası reset ──────────────────────── */
console.log("\n[4] Zorluk gerilemesi");
{
  const w60 = (target: number) =>
    DAILY_QUEST_TEMPLATES.find((t) => t.configuration_key === `country_write|world|60|${target}`)!;
  const hard = w60(18), mid = w60(14), easy = w60(10);
  ok(!!hard && !!mid && !!easy, "test şablonları mevcut (world|60 10/14/18)");

  // Yalnız bu üç şablonluk havuz: dün world|60|18 çıktıysa (mode cooldown'u
  // aşacak kadar eski: 3 gün önce), 30 gün boyunca 10/14 SEÇİLEMEZ →
  // exact-cooldown 18'i de blokladığı için havuz tükenmeli (sessiz kolaylaşma YOK).
  const pool = [hard, mid, easy];
  const hist = [{ date: addDaysISO(START, -3), template: hard }];
  let exhausted = false;
  try { selectDailyQuest(START, hist, pool); } catch (e) {
    exhausted = e instanceof DailyQuestPoolExhaustedError;
  }
  ok(exhausted, "60sn'de 18 ülke sonrası yakın dönemde 60sn'de 10/14 ülke SEÇİLEMEZ (havuz açık hatayla tükenir)");

  // 30 günlük pencere dolunca (31 gün önce) kolay tier tekrar kullanılabilir;
  // exact cooldown 18'i hâlâ blokladığından seçim easy/mid'e düşebilmeli.
  const hist31 = [{ date: addDaysISO(START, -31), template: hard }];
  const pick31 = selectDailyQuest(START, hist31, pool);
  ok(
    pick31.configuration_key !== hard.configuration_key &&
      pick31.difficulty_score < hard.difficulty_score,
    "30 günlük karşılaştırma penceresi dolunca güvenli tier reset'i mümkün",
    pick31.configuration_key
  );

  // Tam simülasyonda hiçbir gün regresyon oluşmadığı zaten [2]'de doğrulandı.
}

/* ── 5) Yakın-benzer bloğu ────────────────────────────────────────────── */
console.log("\n[5] Yakın-benzerlik");
{
  const base = DAILY_QUEST_TEMPLATES.find(
    (t) => t.configuration_key === "country_write|world|60|14"
  )!;
  // Sentetik "60 saniyede 15 ülke" — farklı configuration_key ama kullanıcı
  // gözüyle neredeyse aynı görev. Matriste YOKTUR; kural testi için üretilir.
  const nearTwin: DailyQuestTemplate = {
    ...base,
    configuration_key: "country_write|world|60|15",
    config: { region: "world", duration_seconds: 60, target_count: 15 },
    difficulty_score: base.difficulty_score + 1,
  };
  ok(isNearSimilar(base, nearTwin), "60sn/14 ile 60sn/15 yakın-benzer sayılır");
  const pick = (() => {
    try {
      return selectDailyQuest(START, [{ date: addDaysISO(START, -5), template: base }], [nearTwin]);
    } catch (e) {
      return e instanceof DailyQuestPoolExhaustedError ? "exhausted" : "other";
    }
  })();
  ok(pick === "exhausted", "yakın-benzer tek aday, 45 gün penceresinde bloklanır (sessiz seçim yok)", pick);

  const far = { date: addDaysISO(START, -46), template: base };
  const pickFar = selectDailyQuest(START, [far], [nearTwin]);
  ok(pickFar.configuration_key === nearTwin.configuration_key,
    "45 gün penceresi dışında benzer config yeniden seçilebilir");
}

/* ── 6) Havuz tükenmesi açık hata üretir ──────────────────────────────── */
console.log("\n[6] Havuz tükenmesi");
{
  const single = [DAILY_QUEST_TEMPLATES[0]];
  const day1 = selectDailyQuest(START, [], single);
  let explicitError = false;
  try {
    selectDailyQuest(addDaysISO(START, 1), [{ date: START, template: day1 }], single);
  } catch (e) {
    explicitError = e instanceof DailyQuestPoolExhaustedError;
  }
  ok(explicitError, "aday kalmayınca daily_quest_pool_exhausted (eski görev sessizce TEKRAR EDİLMEZ)");
}

/* ── Sonuç ────────────────────────────────────────────────────────────── */
console.log(`\n${passed} geçti, ${failed} kaldı`);
if (failed > 0) process.exit(1);
