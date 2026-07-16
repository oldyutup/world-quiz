/**
 * check-daily-quest-logic.ts — Günün Görevi attempt/ilerleme/claim sözleşmesi.
 *
 * 20260803120000_daily_quest_init.sql'deki RPC durum makinesinin SAF/DB'siz
 * aynası (check-route-duel-logic.ts deseni). SQL'in FOR UPDATE + advisory
 * lock altında SERİ çalıştığı varsayımıyla mutasyonlar burada sıralı
 * fonksiyonlardır; partial-unique(active) + unique(user,quest) claim
 * kısıtları birlikte modellenir.
 *
 * DRIFT UYARISI: SQL RPC kuralları değişirse burası da güncellenmeli.
 * Gerçek eşzamanlılık (iki bağlantının aynı anda claim etmesi vb.) yalnız
 * canlı Postgres'te doğrulanabilir — bkz. sonuç raporu.
 *
 * Çalıştır:  npx tsx scripts/check-daily-quest-logic.ts
 */
import { createHash } from "node:crypto";
import {
  COUNTRIES,
  getContinentIds,
  getFameTier,
  isWheelEligible,
  resolveCountryAnswer,
  bfsPath,
  NEIGHBOR_GRAPH,
  type Continent,
} from "../src/data/countries";
import { ROUTE_DUEL_POOL } from "../src/data/routeDuelData.generated";
import {
  DAILY_QUEST_TEMPLATES,
  type DailyQuestTemplate,
  type CountryWriteConfig,
  type FlagQuizConfig,
  type RouteCompleteConfig,
  type WheelFindConfig,
} from "./dailyQuest/templates";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

function md5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/* ════════════════════════════════════════════════════════════════════════
   SUNUCU AYNASI — katalog + içerik üretimi + RPC durum makinesi
════════════════════════════════════════════════════════════════════════ */

interface CatalogRow {
  code: string;
  topoId: string;
  primaryContinent: string;
  continents: string[];
  wheelEligible: boolean;
  fameTier: number;
}

const REGIONS: (Continent | "world")[] = [
  "europe", "asia", "africa", "north-america", "south-america", "oceania",
];
const regionSets = new Map<string, Set<string>>(
  REGIONS.map((r) => [r, getContinentIds(r as Continent)])
);

const CATALOG: CatalogRow[] = COUNTRIES
  .filter((c) => c.counted && c.code && c.topoId)
  .map((c) => ({
    code: c.code,
    topoId: c.topoId,
    primaryContinent: c.continent,
    continents: REGIONS.filter((r) => regionSets.get(r)!.has(c.topoId)),
    wheelEligible: isWheelEligible(c),
    fameTier: getFameTier(c),
  }));
const CATALOG_BY_CODE = new Map(CATALOG.map((c) => [c.code, c]));

/** _daily_quest_pick_codes aynası: seed'li, kolaydan-zora rampalı N kod. */
function pickCodes(seed: string, region: string, wheel: boolean, count: number): string[] {
  const pool = CATALOG.filter(
    (c) => (region === "world" || c.primaryContinent === region) && (!wheel || c.wheelEligible)
  );
  const out: string[] = [];
  let remaining = count;
  for (let tier = 1; tier <= 4; tier++) {
    let quota = tier === 1 ? Math.ceil(count * 0.4)
      : tier === 2 ? Math.ceil(count * 0.3)
      : tier === 3 ? Math.ceil(count * 0.2)
      : remaining;
    quota = Math.min(quota, remaining);
    if (remaining <= 0) break;
    if (quota <= 0) continue;
    const batch = pool
      .filter((c) => c.fameTier === tier && !out.includes(c.code))
      .map((c) => ({ code: c.code, h: md5(`${seed}:${c.code}`) }))
      .sort((a, b) => (a.h < b.h ? -1 : 1))
      .slice(0, quota)
      .map((c) => c.code);
    out.push(...batch);
    remaining = count - out.length;
  }
  if (remaining > 0) {
    const batch = pool
      .filter((c) => !out.includes(c.code))
      .map((c) => ({ code: c.code, tier: c.fameTier, h: md5(`${seed}:${c.code}`) }))
      .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.h < b.h ? -1 : 1))
      .slice(0, remaining)
      .map((c) => c.code);
    out.push(...batch);
  }
  if (out.length < count) throw new Error("daily_quest_content_pool_short");
  return out;
}

/** _daily_quest_user_content rota dalının aynası (route_duel_pool + seed). */
function pickRoutePair(seed: string, intermediates: number): { pairKey: string; startKey: string; targetKey: string } {
  const band = ROUTE_DUEL_POOL
    .filter(([, , n]) => n === intermediates)
    .map(([a, b]) => ({ pairKey: `${a}|${b}`, a, b, h: md5(`${seed}:${a}|${b}`) }))
    .sort((x, y) => (x.h < y.h ? -1 : 1));
  if (band.length === 0) throw new Error("daily_quest_route_pool_empty");
  const row = band[0];
  const dirEven = parseInt(md5(`${seed}:dir`).slice(0, 8), 16) % 2 === 0;
  return dirEven
    ? { pairKey: row.pairKey, startKey: row.a, targetKey: row.b }
    : { pairKey: row.pairKey, startKey: row.b, targetKey: row.a };
}

/* ── Durum makinesi ────────────────────────────────────────────────────── */

type AttemptStatus = "active" | "completed" | "failed" | "abandoned" | "expired";
interface SimAttempt {
  id: string;
  questId: string;
  userId: string;
  status: AttemptStatus;
  progress: Record<string, unknown>;
  deadlineMs: number;
}
interface SimQuest {
  id: string;
  template: DailyQuestTemplate;
  startsAtMs: number;
  endsAtMs: number;
  rewardGold: number;
}
interface SimClaim { userId: string; questId: string; attemptId: string; rewardGold: number; }
interface GoldTx { userId: string; amount: number; reason: string; }

class DailyQuestServer {
  nowMs = Date.parse("2026-08-03T10:00:00Z");
  quest: SimQuest;
  attempts = new Map<string, SimAttempt>();
  content = new Map<string, Record<string, unknown>>(); // `${questId}:${userId}`
  claims: SimClaim[] = [];
  goldTx: GoldTx[] = [];
  balances = new Map<string, number>();
  private seq = 0;

  constructor(template: DailyQuestTemplate) {
    this.quest = {
      id: "quest-1",
      template,
      startsAtMs: Date.parse("2026-08-03T00:00:00Z"),
      endsAtMs: Date.parse("2026-08-04T00:00:00Z"),
      rewardGold: 50,
    };
  }

  private userContent(userId: string): Record<string, unknown> {
    const key = `${this.quest.id}:${userId}`;
    const existing = this.content.get(key);
    if (existing) return existing;
    const seed = md5(`${this.quest.id}:${userId}`);
    const cfg = this.quest.template.config;
    let content: Record<string, unknown>;
    switch (this.quest.template.mode) {
      case "country_write": content = {}; break;
      case "flag_quiz":
        content = { codes: pickCodes(seed, (cfg as FlagQuizConfig).region, false, (cfg as FlagQuizConfig).total_questions) };
        break;
      case "wheel_find":
        content = { targets: pickCodes(seed, (cfg as WheelFindConfig).region, true, (cfg as WheelFindConfig).target_count) };
        break;
      case "route_complete": {
        const pair = pickRoutePair(seed, (cfg as RouteCompleteConfig).intermediates);
        content = { pair_key: pair.pairKey, start_key: pair.startKey, target_key: pair.targetKey };
        break;
      }
    }
    this.content.set(key, content);
    return content;
  }

  startAttempt(userId: string | null, resume: boolean): Record<string, any> {
    if (!userId) return { ok: false, code: "unauthenticated" };
    if (this.nowMs >= this.quest.endsAtMs) return { ok: false, code: "quest_ended" };

    // _daily_quest_expire_stale
    for (const a of this.attempts.values()) {
      if (a.userId === userId && a.status === "active" &&
          (a.deadlineMs <= this.nowMs || this.quest.endsAtMs <= this.nowMs)) {
        a.status = "expired";
      }
    }
    const completed = [...this.attempts.values()].find(
      (a) => a.userId === userId && a.questId === this.quest.id && a.status === "completed");
    if (completed) return { ok: false, code: "already_completed" };

    const active = [...this.attempts.values()].find(
      (a) => a.userId === userId && a.questId === this.quest.id && a.status === "active");
    const content = this.userContent(userId);

    if (active) {
      if (resume) return { ok: true, resumed: true, attempt: active, config: this.quest.template.config };
      active.status = "abandoned";
    }

    const cfg = this.quest.template.config as Record<string, number | string>;
    const windowSec =
      this.quest.template.mode === "country_write" ? (cfg.duration_seconds as number) + 10 :
      this.quest.template.mode === "flag_quiz" ? (cfg.window_seconds as number) :
      this.quest.template.mode === "route_complete" ? (cfg.deadline_seconds as number) + 5 :
      (cfg.total_seconds as number) + 10;
    const deadlineMs = Math.min(this.quest.endsAtMs, this.nowMs + windowSec * 1000);

    const progress: Record<string, unknown> =
      this.quest.template.mode === "country_write" ? { found: [] as string[] } :
      this.quest.template.mode === "flag_quiz" ? { next_index: 0, correct: 0, wrong: 0 } :
      this.quest.template.mode === "wheel_find" ? { target_index: 0 } :
      { current_key: content.start_key, path: [content.start_key] };

    const attempt: SimAttempt = {
      id: `attempt-${++this.seq}`, questId: this.quest.id, userId,
      status: "active", progress, deadlineMs,
    };
    this.attempts.set(attempt.id, attempt);
    return { ok: true, resumed: false, attempt, config: this.quest.template.config };
  }

  private lockActive(attemptId: string, userId: string | null, mode: string):
    { error?: string; attempt?: SimAttempt } {
    if (!userId) return { error: "unauthenticated" };
    const a = this.attempts.get(attemptId);
    if (!a || a.userId !== userId) return { error: "attempt_not_found" };
    if (this.quest.template.mode !== mode) return { error: "wrong_mode" };
    if (a.status !== "active") return { error: "attempt_not_active" };
    if (this.nowMs >= this.quest.endsAtMs || this.nowMs > a.deadlineMs) {
      a.status = "expired";
      return { error: "deadline_passed" };
    }
    return { attempt: a };
  }

  submitCountry(attemptId: string, userId: string | null, code: string): Record<string, any> {
    const { error, attempt } = this.lockActive(attemptId, userId, "country_write");
    if (error) return { ok: false, code: error };
    const cfg = this.quest.template.config as CountryWriteConfig;
    const found = attempt!.progress.found as string[];
    const c = CATALOG_BY_CODE.get((code ?? "").toLowerCase());
    if (!c) return { ok: true, accepted: false, reason: "invalid_country", found_count: found.length };
    if (cfg.region !== "world" && !c.continents.includes(cfg.region)) {
      return { ok: true, accepted: false, reason: "wrong_region", found_count: found.length };
    }
    if (found.includes(c.code)) {
      return { ok: true, accepted: false, reason: "duplicate", found_count: found.length };
    }
    found.push(c.code);
    const done = found.length >= cfg.target_count;
    if (done) attempt!.status = "completed";
    return { ok: true, accepted: true, found_count: found.length, target: cfg.target_count, completed: done };
  }

  submitFlag(attemptId: string, userId: string | null, index: number, code: string | null): Record<string, any> {
    const { error, attempt } = this.lockActive(attemptId, userId, "flag_quiz");
    if (error) return { ok: false, code: error };
    const cfg = this.quest.template.config as FlagQuizConfig;
    const content = this.userContent(userId!);
    const codes = content.codes as string[];
    const p = attempt!.progress as { next_index: number; correct: number; wrong: number };
    if (index !== p.next_index || p.next_index >= cfg.total_questions) {
      return { ok: false, code: "index_mismatch", next_index: p.next_index };
    }
    const answer = codes[p.next_index];
    const isOk = code !== null && code.toLowerCase() === answer;
    if (isOk) p.correct++; else p.wrong++;
    p.next_index++;
    if (p.correct >= cfg.required_correct) attempt!.status = "completed";
    else if (p.wrong > cfg.total_questions - cfg.required_correct) attempt!.status = "failed";
    return {
      ok: true, correct: isOk, answer_code: answer,
      correct_count: p.correct, wrong_count: p.wrong, next_index: p.next_index,
      next_code: attempt!.status === "active" && p.next_index < cfg.total_questions ? codes[p.next_index] : null,
      completed: attempt!.status === "completed", failed: attempt!.status === "failed",
    };
  }

  submitRoute(attemptId: string, userId: string | null, countryKey: string): Record<string, any> {
    const { error, attempt } = this.lockActive(attemptId, userId, "route_complete");
    if (error) return { ok: false, code: error };
    const content = this.userContent(userId!);
    const p = attempt!.progress as { current_key: string; path: string[] };
    if (!countryKey || countryKey === p.current_key) {
      return { ok: true, accepted: false, reason: "same_country", current_key: p.current_key };
    }
    const neighbors = NEIGHBOR_GRAPH[p.current_key] ?? [];
    if (!neighbors.includes(countryKey)) {
      return { ok: true, accepted: false, reason: "not_neighbor", current_key: p.current_key };
    }
    p.path.push(countryKey);
    p.current_key = countryKey;
    const done = countryKey === content.target_key;
    if (done) attempt!.status = "completed";
    return { ok: true, accepted: true, current_key: countryKey, completed: done };
  }

  submitWheel(attemptId: string, userId: string | null, code: string): Record<string, any> {
    const { error, attempt } = this.lockActive(attemptId, userId, "wheel_find");
    if (error) return { ok: false, code: error };
    const cfg = this.quest.template.config as WheelFindConfig;
    const content = this.userContent(userId!);
    const targets = content.targets as string[];
    const p = attempt!.progress as { target_index: number };
    if (p.target_index >= cfg.target_count) return { ok: false, code: "no_pending_target" };
    const target = targets[p.target_index];
    if ((code ?? "").toLowerCase() !== target) {
      return { ok: true, correct: false, target_index: p.target_index };
    }
    p.target_index++;
    const done = p.target_index >= cfg.target_count;
    if (done) attempt!.status = "completed";
    return {
      ok: true, correct: true, target_index: p.target_index,
      next_code: done ? null : targets[p.target_index], completed: done,
    };
  }

  claim(attemptId: string, userId: string | null): Record<string, any> {
    if (!userId) return { ok: false, code: "unauthenticated" };
    const a = this.attempts.get(attemptId);
    if (!a || a.userId !== userId) return { ok: false, code: "attempt_not_found" };
    if (a.status !== "completed") return { ok: false, code: "attempt_not_completed" };
    if (this.nowMs < this.quest.startsAtMs || this.nowMs >= this.quest.endsAtMs) {
      return { ok: false, code: "quest_ended" };
    }
    const existing = this.claims.find((c) => c.userId === userId && c.questId === this.quest.id);
    if (existing) {
      return { ok: false, code: "already_claimed", gold: this.balances.get(userId) ?? 0 };
    }
    this.claims.push({ userId, questId: this.quest.id, attemptId, rewardGold: this.quest.rewardGold });
    const next = (this.balances.get(userId) ?? 0) + this.quest.rewardGold;
    this.balances.set(userId, next);
    this.goldTx.push({ userId, amount: this.quest.rewardGold, reason: "daily_quest_reward" });
    return { ok: true, gold: next, amount: this.quest.rewardGold };
  }
}

function tpl(key: string): DailyQuestTemplate {
  const t = DAILY_QUEST_TEMPLATES.find((t) => t.configuration_key === key);
  if (!t) throw new Error(`template not found: ${key}`);
  return t;
}

/* ════════════════════════════════════════════════════════════════════════
   TESTLER
════════════════════════════════════════════════════════════════════════ */

/* ── 0) İçerik üretimi tüm şablonlar için mümkün ──────────────────────── */
console.log("\n[0] İçerik fizibilitesi (65 şablonun tümü)");
{
  let feasible = 0;
  for (const t of DAILY_QUEST_TEMPLATES) {
    try {
      const seed = md5(`feas:${t.configuration_key}`);
      if (t.mode === "flag_quiz") {
        const c = t.config as FlagQuizConfig;
        const codes = pickCodes(seed, c.region, false, c.total_questions);
        if (new Set(codes).size !== c.total_questions) throw new Error("dup codes");
      } else if (t.mode === "wheel_find") {
        const c = t.config as WheelFindConfig;
        const codes = pickCodes(seed, c.region, true, c.target_count);
        if (new Set(codes).size !== c.target_count) throw new Error("dup targets");
        for (const code of codes) {
          if (!CATALOG_BY_CODE.get(code)?.wheelEligible) throw new Error(`ineligible ${code}`);
        }
      } else if (t.mode === "route_complete") {
        const c = t.config as RouteCompleteConfig;
        const pair = pickRoutePair(seed, c.intermediates);
        const path = bfsPath(pair.startKey, pair.targetKey);
        if (!path || path.length - 2 !== c.intermediates) {
          throw new Error(`intermediates mismatch: ${path ? path.length - 2 : "no path"}`);
        }
      } else {
        const c = t.config as CountryWriteConfig;
        const pool = CATALOG.filter((x) => c.region === "world" || x.continents.includes(c.region));
        if (pool.length < c.target_count) throw new Error(`pool ${pool.length} < target ${c.target_count}`);
      }
      feasible++;
    } catch (e) {
      ok(false, `${t.configuration_key} içerik üretilebilir`, (e as Error).message);
    }
  }
  ok(feasible === DAILY_QUEST_TEMPLATES.length,
    `tüm şablonların içeriği canonical veriyle üretilebilir (${feasible}/${DAILY_QUEST_TEMPLATES.length})`);
}

/* ── 1) Attempt yaşam döngüsü ─────────────────────────────────────────── */
console.log("\n[1] Attempt yaşam döngüsü");
{
  const s = new DailyQuestServer(tpl("country_write|world|60|10"));
  ok(s.startAttempt(null, false).code === "unauthenticated", "auth olmayan kullanıcı attempt başlatamaz");

  const r1 = s.startAttempt("userA", false);
  ok(r1.ok && r1.attempt.status === "active", "attempt sunucuda oluşur");
  ok(r1.config.region === "world" && r1.config.duration_seconds === 60 && r1.config.target_count === 10,
    "kilitli ayarlar sunucudan gelir (client parametre GÖNDERMEZ)");

  ok(s.submitCountry("bilinmeyen-attempt", "userA", "tr").code === "attempt_not_found",
    "attempt_id'siz/normal oyun akışı görev ilerletemez (bilinmeyen id reddedilir)");
  ok(s.submitCountry(r1.attempt.id, "userB", "tr").code === "attempt_not_found",
    "başka kullanıcı attempt'i KULLANAMAZ (varlık da sızmaz)");

  const r2 = s.startAttempt("userA", true);
  ok(r2.ok && r2.resumed && r2.attempt.id === r1.attempt.id,
    "refresh/resume aynı attempt'i döndürür (duplicate attempt yok)");

  const r3 = s.startAttempt("userA", false);
  ok(r3.ok && !r3.resumed && r3.attempt.id !== r1.attempt.id, "tekrar dene → yeni attempt");
  ok(s.attempts.get(r1.attempt.id)!.status === "abandoned", "eski aktif attempt abandoned yapılır");
  const actives = [...s.attempts.values()].filter((a) => a.userId === "userA" && a.status === "active");
  ok(actives.length === 1, "aynı anda TEK aktif attempt (iki sekme koruması)");

  // Tamamla → yeni attempt açılamaz, tekrar completed olamaz.
  const cfg = s.quest.template.config as CountryWriteConfig;
  const world = CATALOG.filter((c) => c.continents.length > 0).slice(0, cfg.target_count + 3);
  for (let i = 0; i < cfg.target_count; i++) s.submitCountry(r3.attempt.id, "userA", world[i].code);
  ok(s.attempts.get(r3.attempt.id)!.status === "completed", "hedefe ulaşınca attempt completed");
  ok(s.submitCountry(r3.attempt.id, "userA", world[cfg.target_count].code).code === "attempt_not_active",
    "completed attempt tekrar ilerletilemez/completed olamaz");
  ok(s.startAttempt("userA", false).code === "already_completed",
    "görev tamamlandıktan sonra yeni attempt açılamaz");

  // Eski gün attempt'i yeni UTC gününde ilerleyemez.
  const s2 = new DailyQuestServer(tpl("country_write|world|300|40"));
  const a2 = s2.startAttempt("userA", false);
  s2.nowMs = Date.parse("2026-08-04T00:00:01Z"); // yeni UTC günü
  ok(s2.submitCountry(a2.attempt.id, "userA", "tr").code === "deadline_passed",
    "eski güne ait attempt yeni UTC gününde ilerletilemez");
  ok(s2.attempts.get(a2.attempt.id)!.status === "expired", "gün dönümünde attempt expired olur");

  // Failed sonrası tekrar denenebilir.
  const s3 = new DailyQuestServer(tpl("flag_quiz|world|8|5"));
  const a3 = s3.startAttempt("userA", false);
  for (let i = 0; i < 4; i++) s3.submitFlag(a3.attempt.id, "userA", i, "xx"); // 4 yanlış → fail
  ok(s3.attempts.get(a3.attempt.id)!.status === "failed", "gerekli doğruya ulaşamayınca failed");
  const a3b = s3.startAttempt("userA", false);
  ok(a3b.ok && a3b.attempt.id !== a3.attempt.id, "failed attempt sonrası tekrar denenebilir");
}

/* ── 2) Ülke Yaz ──────────────────────────────────────────────────────── */
console.log("\n[2] Ülke Yaz");
{
  const s = new DailyQuestServer(tpl("country_write|europe|60|8"));
  const a = s.startAttempt("u", false);
  const id = a.attempt.id;

  const de = resolveCountryAnswer("Almanya");
  ok(de === "de", "resolver alias'ı canonical koda çözer (Almanya→de)");
  ok(s.submitCountry(id, "u", de!).accepted === true, "geçerli bölge-içi cevap sayılır");
  const dup = s.submitCountry(id, "u", resolveCountryAnswer("Germany")!);
  ok(dup.accepted === false && dup.reason === "duplicate",
    "farklı alias aynı canonical ülke → duplicate SAYILMAZ");
  const wrongRegion = s.submitCountry(id, "u", "br");
  ok(wrongRegion.accepted === false && wrongRegion.reason === "wrong_region",
    "yanlış bölge ülkesi Avrupa görevinde kabul edilmez");
  const invalid = s.submitCountry(id, "u", "zz");
  ok(invalid.accepted === false && invalid.reason === "invalid_country", "geçersiz cevap sayılmaz");
  // Türkiye MULTI_CONTINENT: hem Avrupa hem Asya görevinde geçerli olmalı.
  ok(s.submitCountry(id, "u", "tr").accepted === true, "Türkiye Avrupa görevinde geçerli (çok-kıtalı üyelik)");

  // Batch/final skor API'si yok: tek tek doğru cevap dışında tamamlama yolu yok.
  const euro = CATALOG.filter((c) => c.continents.includes("europe") && !["de", "tr"].includes(c.code));
  for (let i = 0; i < 5; i++) s.submitCountry(id, "u", euro[i].code);
  ok(s.attempts.get(id)!.status === "active", "hedefin altında (7/8) attempt tamamlanMAZ (client final skor gönderemez)");
  const last = s.submitCountry(id, "u", euro[5].code);
  ok(last.completed === true && s.attempts.get(id)!.status === "completed",
    "gerekli sayıda benzersiz geçerli cevap görevi tamamlar (8/8)");

  // Süre sonrası cevap reddedilir.
  const s2 = new DailyQuestServer(tpl("country_write|world|60|10"));
  const a2 = s2.startAttempt("u", false);
  s2.nowMs += 90_000; // 60sn + 10sn grace aşıldı
  ok(s2.submitCountry(a2.attempt.id, "u", "tr").code === "deadline_passed", "süre sonrası cevap sayılmaz");
}

/* ── 3) Bayrak ────────────────────────────────────────────────────────── */
console.log("\n[3] Bayrak Bilmece");
{
  const t = tpl("flag_quiz|world|10|7");
  const s = new DailyQuestServer(t);
  const a = s.startAttempt("u", false);
  const id = a.attempt.id;
  const codes = (s.content.get(`${s.quest.id}:u`)!.codes as string[]);
  ok(codes.length === 10 && new Set(codes).size === 10, "soru dizisi sunucuda, 10 benzersiz bayrak");

  const r0 = s.submitFlag(id, "u", 0, codes[0]);
  ok(r0.correct === true && r0.correct_count === 1, "doğru cevap sayılır");
  ok(s.submitFlag(id, "u", 0, codes[0]).code === "index_mismatch",
    "aynı soruya ikinci cevap (replay) İLERLETMEZ");
  ok(s.submitFlag(id, "u", 5, codes[5]).code === "index_mismatch",
    "soru sırası client isteğiyle değişmez (ileri atlama reddedilir)");
  const r1 = s.submitFlag(id, "u", 1, "xx");
  ok(r1.correct === false && r1.wrong_count === 1, "yanlış cevap doğru sayısını artırmaz");

  // Reroll engeli: yeni attempt AYNI diziyi kullanır.
  const b = s.startAttempt("u", false);
  const codes2 = (s.content.get(`${s.quest.id}:u`)!.codes as string[]);
  ok(codes2.join(",") === codes.join(","), "tekrar denemede soru dizisi REROLL edilmez");

  // 7 doğru → completed (erken biter); bir eksikte bitmez.
  for (let i = 0; i < 6; i++) s.submitFlag(b.attempt.id, "u", i, codes[i]);
  ok(s.attempts.get(b.attempt.id)!.status === "active", "6/7 doğruda görev TAMAMLANMAZ (bir eksik yetmez)");
  const done = s.submitFlag(b.attempt.id, "u", 6, codes[6]);
  ok(done.completed === true, "gerekli doğru sayısına ulaşınca completed (7/10)");

  // Client final doğru sayısını belirleyemez: sayaç yalnız sunucu karşılaştırmasıyla artar.
  const s3 = new DailyQuestServer(t);
  const c3 = s3.startAttempt("u", false);
  const wrongAll = ["aa", "bb", "cc", "dd"];
  for (let i = 0; i < 4; i++) s3.submitFlag(c3.attempt.id, "u", i, wrongAll[i]);
  const st3 = s3.attempts.get(c3.attempt.id)!;
  ok((st3.progress as any).correct === 0 && st3.status === "failed",
    "yanlış kodlar doğru saymaz; matematiksel olarak imkânsızlaşınca failed");
}

/* ── 4) Rota ──────────────────────────────────────────────────────────── */
console.log("\n[4] Rota Modu");
{
  const t = tpl("route_complete|7|135");
  const s = new DailyQuestServer(t);
  const a = s.startAttempt("u", false);
  const id = a.attempt.id;
  const content = s.content.get(`${s.quest.id}:u`)! as { start_key: string; target_key: string };
  const path = bfsPath(content.start_key, content.target_key)!;
  ok(path.length - 2 === 7, `görev config'indeki ara ülke sayısı gerçek (bfs=${path.length - 2})`);

  const notNeighbor = s.submitRoute(id, "u", content.target_key);
  ok(notNeighbor.accepted === false && notNeighbor.reason === "not_neighbor",
    "komşu olmayan ülke reddedilir (hedefe ışınlanma yok — sahte finished gönderilemez)");

  const r1 = s.submitRoute(id, "u", path[1]);
  ok(r1.accepted === true && r1.current_key === path[1], "komşu hamle kabul edilir");

  // Sahte current: path[3]'e (henüz uzak) atlamayı dene.
  const skip = s.submitRoute(id, "u", path[3]);
  const p3IsNeighborOfP1 = (NEIGHBOR_GRAPH[path[1]] ?? []).includes(path[3]);
  ok(skip.accepted === p3IsNeighborOfP1,
    "hamleler yalnız SUNUCUNUN current'ından doğrulanır (client sahte konum gönderemez)");

  for (let i = 2; i < path.length; i++) s.submitRoute(id, "u", path[i]);
  ok(s.attempts.get(id)!.status === "completed", "hedefe geçerli zincirle ulaşmak completed yapar");

  // Retry → rota çifti değişmez.
  const s2 = new DailyQuestServer(t);
  s2.startAttempt("u", false);
  const c1 = { ...(s2.content.get(`${s2.quest.id}:u`) as object) };
  s2.startAttempt("u", false);
  const c2 = s2.content.get(`${s2.quest.id}:u`) as { pair_key: string };
  ok((c1 as { pair_key: string }).pair_key === c2.pair_key, "retry ile rota çifti REROLL edilmez");

  // Deadline sonrası hamle reddedilir.
  const s3 = new DailyQuestServer(t);
  const a3 = s3.startAttempt("u", false);
  s3.nowMs += (135 + 6) * 1000;
  ok(s3.submitRoute(a3.attempt.id, "u", "Germany").code === "deadline_passed",
    "deadline sonrası hamle kabul edilmez");
}

/* ── 5) Çark ──────────────────────────────────────────────────────────── */
console.log("\n[5] Çark Modu");
{
  const t = tpl("wheel_find|world|4|54");
  const s = new DailyQuestServer(t);
  const a = s.startAttempt("u", false);
  const id = a.attempt.id;
  const targets = s.content.get(`${s.quest.id}:u`)!.targets as string[];
  ok(targets.length === 4, "hedef listesi attempt başlarken sunucuda belirlenir");

  ok(s.submitWheel(id, "u", targets[1]).correct === false,
    "sıradaki hedef dışındaki ülke (ileriki hedef dahil) İLERLETMEZ");
  const r0 = s.submitWheel(id, "u", targets[0]);
  ok(r0.correct === true && r0.target_index === 1, "sunucunun hedefi doğru tıklanınca ilerler");
  ok(s.submitWheel(id, "u", targets[0]).correct === false,
    "aynı hedef ikinci kez tamamlanmaz");

  s.submitWheel(id, "u", targets[1]);
  s.submitWheel(id, "u", targets[2]);
  const done = s.submitWheel(id, "u", targets[3]);
  ok(done.completed === true, "tüm hedefler bulununca completed");

  // Timeout → başarısız (deadline_passed + expired).
  const s2 = new DailyQuestServer(t);
  const a2 = s2.startAttempt("u", false);
  const t2 = s2.content.get(`${s2.quest.id}:u`)!.targets as string[];
  s2.nowMs += (54 + 11) * 1000;
  ok(s2.submitWheel(a2.attempt.id, "u", t2[0]).code === "deadline_passed", "süre aşımı başarısız olur");

  // Retry → hedef dizisi reroll olmaz.
  const s3 = new DailyQuestServer(t);
  s3.startAttempt("u", false);
  const seq1 = (s3.content.get(`${s3.quest.id}:u`)!.targets as string[]).join(",");
  s3.startAttempt("u", false);
  const seq2 = (s3.content.get(`${s3.quest.id}:u`)!.targets as string[]).join(",");
  ok(seq1 === seq2, "retry ile hedef dizisi REROLL edilmez");
}

/* ── 6) Claim + gold ──────────────────────────────────────────────────── */
console.log("\n[6] Claim ve gold");
{
  const t = tpl("wheel_find|world|3|60");
  const s = new DailyQuestServer(t);
  const a = s.startAttempt("u", false);
  const id = a.attempt.id;

  ok(s.claim(id, "u").code === "attempt_not_completed", "tamamlanmamış attempt ödül alamaz");

  const targets = s.content.get(`${s.quest.id}:u`)!.targets as string[];
  for (const target of targets) s.submitWheel(id, "u", target);
  ok(s.attempts.get(id)!.status === "completed", "görev tamamlandı");

  ok(s.claim(id, "eve").code === "attempt_not_found", "başka kullanıcının completed attempt'i claim edilemez");

  const c1 = s.claim(id, "u");
  ok(c1.ok === true && c1.amount === 50 && c1.gold === 50, "completed attempt 50 gold verir (miktar sunucudan)");
  const c2 = s.claim(id, "u");
  ok(c2.ok === false && c2.code === "already_claimed", "çift tıklama/retry ikinci ödül vermez");
  ok(s.balances.get("u") === 50, "gold balance yalnız BİR kez artar");
  ok(s.claims.length === 1, "tek claim satırı oluşur");
  ok(s.goldTx.length === 1 && s.goldTx[0].reason === "daily_quest_reward",
    "tek ledger kaydı (daily_quest_reward)");

  // Süresi bitmiş görev claim edilemez.
  const s2 = new DailyQuestServer(t);
  const a2 = s2.startAttempt("u", false);
  const t2 = s2.content.get(`${s2.quest.id}:u`)!.targets as string[];
  for (const target of t2) s2.submitWheel(a2.attempt.id, "u", target);
  s2.nowMs = Date.parse("2026-08-04T00:00:01Z");
  ok(s2.claim(a2.attempt.id, "u").code === "quest_ended",
    "eski görevin ödülü yeni UTC günü başladıktan sonra alınamaz");
}

/* ── Sonuç ────────────────────────────────────────────────────────────── */
console.log(`\n${passed} geçti, ${failed} kaldı`);
if (failed > 0) process.exit(1);
