/**
 * achievementStats.ts
 *
 * Avatar başarım sistemi için merkezi istatistik & kilit-açma katmanı.
 *
 * SOURCE OF TRUTH = Supabase `public.profile_achievements` (stats jsonb).
 *   - Giriş yapmış kullanıcı: stats Supabase'e debounce'lu upsert edilir; profil
 *     değişince (login) server'dan okunur ve server otorite kabul edilir.
 *   - localStorage YALNIZCA cache/fallback: anında UI için senkron okuma ve
 *     offline/guest durumu. Server'dan veri gelince üzerine yazılır (server
 *     öncelikli). Misafir kullanıcı (profileId=null) yalnızca localStorage.
 *
 * GÜVENLİK:
 *   - Client tabloya SADECE `stats` kolonunu yazar (RLS: profile_id=auth.uid()).
 *   - `unlocks.claimedAchievementRewardIds` SADECE server tarafında, idempotent
 *     `claim_achievement_rewards()` RPC'si ile yazılır. Gold client'tan asla
 *     doğrudan verilmez (bkz. claimAllAchievementRewards).
 *   - unlockedAchievementAvatarIds stats'tan türetilir + sticky tutulur (bir kez
 *     açılan avatar geri kilitlenmez); kalıcılık için claim edilmiş tier'lar da
 *     açık sayılır.
 *
 * DOKUNMAZ: mevcut XP / Gold / günlük bonus / curated avatar sistemleri.
 */
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { syncGoldFromServer } from "./gold";

/* ────────────────────────────────────────────────────────────────────────
   Veri modeli
   ──────────────────────────────────────────────────────────────────────── */

export type UserAchievementStats = {
  /** ONLINE ülke modlarında doğru bilinen benzersiz ülke id'leri (Set mantığı).
   *  Offline Ülke Yaz BURAYA YAZMAZ — kasma engeli (bkz. recordOnlineCorrectCountry). */
  uniqueCorrectCountryIds: string[];
  /** Bayrak modlarında toplam doğru bilinen bayrak sayısı (kümülatif). */
  correctFlagsCount: number;
  /** Tamamlanmış benzersiz mod aileleri (country/flag/silhouette/route/...). */
  completedModeIds: string[];
  /** Üst üste en az 1 oyun tamamlanan gün sayısı. */
  dailyPlayStreak: number;
  /** Son oyun tamamlanan yerel tarih (YYYY-MM-DD) — streak hesabı için. */
  lastCompletedGameDate: string | null;
  /** Üst üste alınan online galibiyet sayısı (beraberlik/mağlubiyet sıfırlar). */
  onlineWinStreak: number;
};

export type UserAchievementUnlocks = {
  /** Açılmış achievement avatar id'leri (avatar_ach_*) — sticky. */
  unlockedAchievementAvatarIds: string[];
  /** Gold ödülü claim edilmiş tier id'leri (server-otoriteli idempotency anahtarı). */
  claimedAchievementRewardIds: string[];
};

const EMPTY_STATS: UserAchievementStats = {
  uniqueCorrectCountryIds: [],
  correctFlagsCount: 0,
  completedModeIds: [],
  dailyPlayStreak: 0,
  lastCompletedGameDate: null,
  onlineWinStreak: 0,
};

const EMPTY_UNLOCKS: UserAchievementUnlocks = {
  unlockedAchievementAvatarIds: [],
  claimedAchievementRewardIds: [],
};

/* ────────────────────────────────────────────────────────────────────────
   Tier metadata — tek doğruluk kaynağı (SQL claim_achievement_rewards ile senkron)
   ──────────────────────────────────────────────────────────────────────── */

/** Hangi stat alanı bir tier'ın ilerlemesini besler. */
export type StatKey =
  | "uniqueCorrectCountries"
  | "correctFlags"
  | "dailyStreak"
  | "completedModes"
  | "onlineWinStreak";

export type AchievementTierMeta = {
  /** Tier id (örn. "world_traveler_10"). Aynı zamanda claim anahtarı. */
  tierId: string;
  /** Grup id (örn. "world_traveler"). */
  groupId: string;
  /** İlerlemeyi besleyen stat. */
  statKey: StatKey;
  /** Açılma eşiği. */
  target: number;
  /** Tek-seferlik Gold ödülü. */
  rewardGold: number;
  /** Bu tier'a karşılık gelen achievement avatar id'si (avatar_ach_*). */
  avatarId: string;
};

/**
 * Bir tier id'sinden achievement avatar id'si türetir.
 * profiles.avatar_id format CHECK'i ('^avatar_[a-z0-9_]{1,32}$') ile uyumlu
 * olması için "avatar_ach_" öneki kullanılır (en uzun: 22 karakter ≤ 32).
 */
export function avatarIdForTier(tierId: string): string {
  return `avatar_ach_${tierId}`;
}

function tier(
  groupId: string,
  tierId: string,
  statKey: StatKey,
  target: number,
  rewardGold: number
): AchievementTierMeta {
  return { tierId, groupId, statKey, target, rewardGold, avatarId: avatarIdForTier(tierId) };
}

/** Tüm tier'lar — modal görselleri hariç tek otorite. Sıra = grup içi seviye. */
export const ACHIEVEMENT_TIERS: readonly AchievementTierMeta[] = [
  tier("world_traveler", "world_traveler_10", "uniqueCorrectCountries", 10, 25),
  tier("world_traveler", "world_traveler_50", "uniqueCorrectCountries", 50, 50),
  tier("world_traveler", "world_traveler_100", "uniqueCorrectCountries", 100, 75),

  tier("flag_master", "flag_master_25", "correctFlags", 25, 25),
  tier("flag_master", "flag_master_100", "correctFlags", 100, 50),
  tier("flag_master", "flag_master_250", "correctFlags", 250, 75),

  tier("streak_player", "streak_player_3", "dailyStreak", 3, 25),
  tier("streak_player", "streak_player_5", "dailyStreak", 5, 50),
  tier("streak_player", "streak_player_7", "dailyStreak", 7, 75),

  tier("versatile_player", "versatile_player_3", "completedModes", 3, 25),
  tier("versatile_player", "versatile_player_5", "completedModes", 5, 50),
  tier("versatile_player", "versatile_player_7", "completedModes", 7, 75),

  tier("win_streak", "win_streak_2", "onlineWinStreak", 2, 25),
  tier("win_streak", "win_streak_3", "onlineWinStreak", 3, 50),
  tier("win_streak", "win_streak_5", "onlineWinStreak", 5, 75),
];

const TIER_BY_AVATAR_ID: ReadonlyMap<string, AchievementTierMeta> = new Map(
  ACHIEVEMENT_TIERS.map((t) => [t.avatarId, t])
);

/** Bir avatar id'sinin achievement avatarı olup olmadığını söyler. */
export function isAchievementAvatarId(avatarId: string | null | undefined): boolean {
  return !!avatarId && TIER_BY_AVATAR_ID.has(avatarId);
}

/* ────────────────────────────────────────────────────────────────────────
   İlerleme / kilit hesaplama (saf fonksiyonlar)
   ──────────────────────────────────────────────────────────────────────── */

/** Bir stat anahtarının ham değerini döner. */
export function getStatValue(statKey: StatKey, stats: UserAchievementStats): number {
  switch (statKey) {
    case "uniqueCorrectCountries":
      return stats.uniqueCorrectCountryIds.length;
    case "correctFlags":
      return stats.correctFlagsCount;
    case "dailyStreak":
      return stats.dailyPlayStreak;
    case "completedModes":
      return stats.completedModeIds.length;
    case "onlineWinStreak":
      return stats.onlineWinStreak;
  }
}

/** Bir tier için { progress (target ile sınırlı), unlocked }. */
export function getAchievementProgress(
  meta: AchievementTierMeta,
  stats: UserAchievementStats
): { progress: number; unlocked: boolean } {
  const raw = getStatValue(meta.statKey, stats);
  return { progress: Math.min(raw, meta.target), unlocked: raw >= meta.target };
}

/** Eşiğe göre anlık açıklık (streak düşerse stat de düşebilir). */
function meetsThreshold(meta: AchievementTierMeta, stats: UserAchievementStats): boolean {
  return getStatValue(meta.statKey, stats) >= meta.target;
}

/**
 * Bir tier sticky olarak açık mı? Açıklık kalıcıdır: ya stat şu an eşiği
 * karşılar, ya daha önce açılmış (unlockedAchievementAvatarIds), ya da ödülü
 * claim edilmiş (claimedAchievementRewardIds). Böylece win streak sıfırlansa
 * bile kazanılmış avatar seçilebilir kalır.
 */
export function isAchievementTierUnlocked(
  meta: AchievementTierMeta,
  stats: UserAchievementStats,
  unlocks: UserAchievementUnlocks = cachedUnlocks
): boolean {
  if (meetsThreshold(meta, stats)) return true;
  if (unlocks.unlockedAchievementAvatarIds.includes(meta.avatarId)) return true;
  if (unlocks.claimedAchievementRewardIds.includes(meta.tierId)) return true;
  return false;
}

/** Bir avatar id'sinin verili stats'a göre açık olup olmadığı (sticky). */
export function isAchievementAvatarUnlockedFor(
  avatarId: string,
  stats: UserAchievementStats,
  unlocks: UserAchievementUnlocks = cachedUnlocks
): boolean {
  const meta = TIER_BY_AVATAR_ID.get(avatarId);
  return meta ? isAchievementTierUnlocked(meta, stats, unlocks) : false;
}

/* ────────────────────────────────────────────────────────────────────────
   Profil-başına kalıcılık (Supabase otorite + localStorage cache) + listener
   ──────────────────────────────────────────────────────────────────────── */

const STATS_PREFIX = "torble_ach_stats_";
const UNLOCKS_PREFIX = "torble_ach_unlocks_";
const GUEST_KEY = "guest";

let activeProfileId: string | null = null;
let cachedStats: UserAchievementStats = { ...EMPTY_STATS };
let cachedUnlocks: UserAchievementUnlocks = { ...EMPTY_UNLOCKS };
let listeners: Array<() => void> = [];

/** Profil değişimi sırasında uçan async fetch'lerin yarış koşulunu engeller. */
let loadToken = 0;

function storageKey(profileId: string | null): string {
  return profileId ?? GUEST_KEY;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage kapalı — best effort */
  }
}

function loadLocal(profileId: string | null): void {
  const k = storageKey(profileId);
  cachedStats = readJson(STATS_PREFIX + k, { ...EMPTY_STATS });
  cachedUnlocks = readJson(UNLOCKS_PREFIX + k, { ...EMPTY_UNLOCKS });
}

function persistStatsLocal(): void {
  writeJson(STATS_PREFIX + storageKey(activeProfileId), cachedStats);
}

function persistUnlocksLocal(): void {
  writeJson(UNLOCKS_PREFIX + storageKey(activeProfileId), cachedUnlocks);
}

function emit(): void {
  for (const cb of listeners) cb();
}

/* ── Supabase senkronizasyonu (yalnızca kontrollü RPC'ler) ──────────────── */
//
// GÜVENLİK: Client profile_achievements tablosuna DOĞRUDAN YAZMAZ (DB tarafında
// INSERT/UPDATE/DELETE grant'ı yok). Tüm stat mutasyonları server-side, cap'li,
// source-whitelist'li SECURITY DEFINER RPC'lerinden geçer. Buradaki yerel cache
// güncellemeleri yalnız ANINDA UI içindir (optimistic); RPC dönen otoriter
// stats ile cache reconcile edilir. Tablodan SELECT (okuma) serbesttir.

/** RPC'den dönen otoriter stats ile cache'i hizalar. */
function reconcileStatsFromServer(serverStats: Partial<UserAchievementStats>): void {
  cachedStats = { ...EMPTY_STATS, ...serverStats };
  persistStatsLocal();
  recomputeUnlocks();
  emit();
}

/**
 * Bir stat RPC'sini çağırır ve dönen otoriter stats ile cache'i reconcile eder.
 * Misafir (activeProfileId yok) → RPC çağrılmaz, yalnız local optimistic kalır.
 */
async function callStatRpc(
  fn: string,
  args: Record<string, unknown>
): Promise<void> {
  if (!activeProfileId) return; // misafir: server yok
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return; // ağ/doğrulama hatası → optimistic local kalır, sonraki load düzeltir
    const res = data as { ok?: boolean; stats?: Partial<UserAchievementStats> } | null;
    if (res?.ok && res.stats) reconcileStatsFromServer(res.stats);
  } catch {
    /* ignore — optimistic local cache fallback olarak kalır */
  }
}

/** Server'dan oku → server otorite. Yarış koşuluna karşı token'lı. */
async function fetchFromServer(profileId: string, token: number): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("profile_achievements")
      .select("stats, unlocks")
      .eq("profile_id", profileId)
      .maybeSingle<{ stats: Partial<UserAchievementStats>; unlocks: Partial<UserAchievementUnlocks> }>();

    if (token !== loadToken) return; // bu sırada profil değişti → at

    if (error) return; // ağ/RLS hatası → localStorage fallback'i koru

    if (data) {
      cachedStats = { ...EMPTY_STATS, ...(data.stats ?? {}) };
      cachedUnlocks = { ...EMPTY_UNLOCKS, ...(data.unlocks ?? {}) };
      recomputeUnlocks(); // stats'a göre sticky açık avatarları tazele
      persistStatsLocal();
      persistUnlocksLocal();
      emit();
    }
    // Server'da satır yoksa: ilk record_* RPC'si (_ach_ensure_row ile) satırı
    // lazily oluşturur. Client tablo yazamadığından burada bir şey yapmayız.
  } catch {
    /* ignore — localStorage cache fallback olarak kalır */
  }
}

/**
 * Login/logout anında çağrılır. Profil değişince önce yerel cache'i (anında)
 * yükler, ardından Supabase'den otoriteyi çeker.
 */
export function setActiveAchievementProfile(profileId: string | null): void {
  if (profileId === activeProfileId) return;
  activeProfileId = profileId;
  loadLocal(profileId); // anında senkron UI
  emit();
  loadToken += 1;
  if (profileId) void fetchFromServer(profileId, loadToken);
}

/** Senkron okuma — UI initial state için. */
export function getAchievementStats(): UserAchievementStats {
  return cachedStats;
}

export function getAchievementUnlocks(): UserAchievementUnlocks {
  return cachedUnlocks;
}

/* ────────────────────────────────────────────────────────────────────────
   Kilit-açma yeniden hesaplama (sticky)
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Mevcut stats'a göre yeni eşiği karşılayan avatarları unlocks'a ekler (sticky).
 * Gold OTOMATİK VERİLMEZ — claim yalnızca claim_achievement_rewards RPC ile.
 */
function recomputeUnlocks(): void {
  const already = new Set(cachedUnlocks.unlockedAchievementAvatarIds);
  let changed = false;

  for (const meta of ACHIEVEMENT_TIERS) {
    if (already.has(meta.avatarId)) continue;
    if (meetsThreshold(meta, cachedStats)) {
      already.add(meta.avatarId);
      changed = true;
    }
  }

  if (changed) {
    cachedUnlocks = { ...cachedUnlocks, unlockedAchievementAvatarIds: [...already] };
    persistUnlocksLocal();
  }
}

/** Yalnız OPTIMISTIC yerel stats mutasyonu (anında UI). Server otoritesi ayrı
 *  callStatRpc ile gelir ve reconcileStatsFromServer üzerinden hizalanır. */
function mutateStats(mutator: (s: UserAchievementStats) => UserAchievementStats): void {
  cachedStats = mutator(cachedStats);
  persistStatsLocal();
  recomputeUnlocks();
  emit();
}

/* ────────────────────────────────────────────────────────────────────────
   Tarih yardımcıları (yerel gün, güvenli streak)
   ──────────────────────────────────────────────────────────────────────── */

/** Yerel tarihi YYYY-MM-DD olarak döner (UTC kaymasına karşı güvenli). */
function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** İki YYYY-MM-DD arasındaki tam gün farkı (a - b). */
function dayDiff(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime();
  const db = new Date(`${b}T00:00:00`).getTime();
  return Math.round((da - db) / 86_400_000);
}

/** dailyPlayStreak'i günde tek sefer artırır; gün atlanırsa sıfırlar. */
function applyDailyStreak(
  s: UserAchievementStats
): Pick<UserAchievementStats, "dailyPlayStreak" | "lastCompletedGameDate"> {
  const today = localDateStr();
  const last = s.lastCompletedGameDate;

  if (last === today) {
    // Aynı gün ikinci oyun → streak değişmez.
    return { dailyPlayStreak: s.dailyPlayStreak, lastCompletedGameDate: today };
  }
  if (last && dayDiff(today, last) === 1) {
    return { dailyPlayStreak: s.dailyPlayStreak + 1, lastCompletedGameDate: today };
  }
  // İlk oyun veya gün atlanmış → 1'den başla.
  return { dailyPlayStreak: 1, lastCompletedGameDate: today };
}

/* ────────────────────────────────────────────────────────────────────────
   Kaynaklar + mod aileleri
   ──────────────────────────────────────────────────────────────────────── */

/** Çok Yönlü Oyuncu için kanonik mod aileleri. */
export type ModeFamily =
  | "country"
  | "flag"
  | "silhouette"
  | "route"
  | "wheel"
  | "conquest"
  | "blindspot";

/**
 * Achievement besleme kaynağı etiketi. Online/offline ayrımı ve gelecekteki
 * grup modları için tek tip. Yeni kaynak eklemek = bu union'a + ilgili Set'e
 * eklemek (örn. flag_group_future zaten hazır, henüz çağrılmıyor).
 */
export type AchievementSource =
  | "country_duel"
  | "country_group"
  | "country_offline"
  | "flag_offline"
  | "flag_duel"
  | "flag_group_future"
  | "silhouette"
  | "wheel"
  | "route"
  | "conquest"
  | "blindspot";

/** Dünya Gezgini'ni besleyebilen ONLINE ülke kaynakları (offline HARİÇ). */
const ONLINE_COUNTRY_SOURCES: ReadonlySet<AchievementSource> = new Set([
  "country_duel",
  "country_group",
]);

/** Bayrak Ustası'nı besleyebilen kaynaklar (offline + online + gelecekteki grup). */
const FLAG_SOURCES: ReadonlySet<AchievementSource> = new Set([
  "flag_offline",
  "flag_duel",
  "flag_group_future",
]);

/* ────────────────────────────────────────────────────────────────────────
   Merkezi kayıt fonksiyonları — bileşenler doğrudan JSON yazmaz
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Dünya Gezgini: ONLINE bir ülke modunda doğru bilinen bir ülkeyi sayar.
 * Yalnızca online country kaynakları (country_duel / country_group) geçerlidir;
 * offline kaynak verilse bile uniqueCorrectCountryIds'e EKLENMEZ (kasma engeli).
 * Aynı ülke tekrar gelirse Set sayesinde tekrar sayılmaz.
 */
export function recordOnlineCorrectCountry(
  countryId: string | null | undefined,
  source: AchievementSource
): void {
  if (!countryId) return;
  if (!ONLINE_COUNTRY_SOURCES.has(source)) return;
  if (cachedStats.uniqueCorrectCountryIds.includes(countryId)) return;
  mutateStats((s) => ({
    ...s,
    uniqueCorrectCountryIds: [...s.uniqueCorrectCountryIds, countryId],
  }));
  void callStatRpc("record_online_correct_countries", {
    p_country_ids: [countryId],
    p_source: source,
  });
}

/** Birden çok ülkeyi tek seferde işler (online duel sonu için kullanışlı). */
export function recordOnlineCorrectCountries(
  countryIds: Iterable<string>,
  source: AchievementSource
): void {
  if (!ONLINE_COUNTRY_SOURCES.has(source)) return;
  const set = new Set(cachedStats.uniqueCorrectCountryIds);
  let changed = false;
  for (const id of countryIds) {
    if (id && !set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (changed) {
    mutateStats((s) => ({ ...s, uniqueCorrectCountryIds: [...set] }));
  }
  // Server'a ham listeyi gönder; RPC source whitelist + Set dedupe uygular.
  const ids = [...countryIds].filter(Boolean);
  if (ids.length > 0) {
    void callStatRpc("record_online_correct_countries", {
      p_country_ids: ids,
      p_source: source,
    });
  }
}

/**
 * Bayrak Ustası: bir doğru bayrak cevabını sayar. count ile toplu eklenebilir.
 * Yalnızca flag kaynakları (flag_offline / flag_duel / flag_group_future) geçerli.
 */
export function recordCorrectFlag(source: AchievementSource, count = 1): void {
  if (!FLAG_SOURCES.has(source)) return;
  const inc = Math.floor(count);
  if (inc <= 0) return;
  mutateStats((s) => ({ ...s, correctFlagsCount: s.correctFlagsCount + inc }));
  void callStatRpc("record_correct_flag", { p_source: source, p_amount: inc });
}

/** Çok Yönlü Oyuncu: bir mod ailesinin tamamlandığını (benzersiz) işaretler. */
export function recordCompletedMode(modeId: ModeFamily, source?: AchievementSource): void {
  if (!cachedStats.completedModeIds.includes(modeId)) {
    mutateStats((s) => ({ ...s, completedModeIds: [...s.completedModeIds, modeId] }));
  }
  void callStatRpc("record_completed_mode", { p_mode_id: modeId, p_source: source ?? null });
}

/** Seri Oyuncu: geçerli bir oyun tamamlandı → günlük streak güncelle. */
export function recordDailyGameCompletion(source?: AchievementSource): void {
  mutateStats((s) => ({ ...s, ...applyDailyStreak(s) }));
  void callStatRpc("record_daily_game_completion", {
    p_local_date: localDateStr(),
    p_source: source ?? null,
  });
}

/**
 * Online maç sonucu kesinleştiğinde (yalnızca online modlar):
 *   - "win"  → onlineWinStreak +1
 *   - "loss" / "draw" → onlineWinStreak = 0
 */
export function recordOnlineMatchResult(
  result: "win" | "loss" | "draw",
  _source?: AchievementSource
): void {
  mutateStats((s) => ({
    ...s,
    onlineWinStreak: result === "win" ? s.onlineWinStreak + 1 : 0,
  }));
  void callStatRpc("record_online_match_result", { p_result: result });
}

/**
 * Bir oyun tamamlandığında çağrılan kolaylık sarmalayıcı: her zaman günlük
 * streak + benzersiz mod ailesini günceller (tek mutasyonda).
 *
 * ÖNEMLİ: Ülke/bayrak SAYIMI artık BURADA yapılmaz. Dünya Gezgini yalnızca
 * recordOnlineCorrectCountry ile (online), Bayrak Ustası yalnızca
 * recordCorrectFlag ile beslenir. Böylece offline Ülke Yaz Dünya Gezgini'ni
 * besleyemez.
 */
export function recordGameComplete(params: { modeFamily: ModeFamily }): void {
  mutateStats((s) => {
    const streak = applyDailyStreak(s);
    const completedModeIds = s.completedModeIds.includes(params.modeFamily)
      ? s.completedModeIds
      : [...s.completedModeIds, params.modeFamily];
    return { ...s, ...streak, completedModeIds };
  });
  // Birleşik RPC: completedModeIds + daily streak tek transaction'da.
  void callStatRpc("record_game_complete", {
    p_mode_id: params.modeFamily,
    p_local_date: localDateStr(),
    p_source: params.modeFamily,
  });
}

/* ────────────────────────────────────────────────────────────────────────
   Gold ödülü — "Ödülleri Topla" (server-otoriteli, idempotent RPC)
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Gold ödülü achievement açılınca OTOMATİK verilsin mi? — Hayır.
 * Ödüller yalnızca kullanıcı "Ödülleri Topla" deyince, server-side
 * claim_achievement_rewards RPC'si ile tek seferlik verilir.
 */
export const AUTO_CLAIM_ACHIEVEMENT_GOLD = false;

export type ClaimableSummary = {
  /** Tamamlanmış ama henüz claim edilmemiş tier id'leri. */
  tierIds: string[];
  /** Bu claim'de alınacak toplam Gold. */
  totalGold: number;
  /** Hazır ödül sayısı. */
  count: number;
};

/** Tamamlanmış ama claim edilmemiş ödülleri (client tahmini) hesaplar. */
export function getClaimableRewards(
  stats: UserAchievementStats = cachedStats,
  unlocks: UserAchievementUnlocks = cachedUnlocks
): ClaimableSummary {
  const claimed = new Set(unlocks.claimedAchievementRewardIds);
  const tierIds: string[] = [];
  let totalGold = 0;
  for (const meta of ACHIEVEMENT_TIERS) {
    if (claimed.has(meta.tierId)) continue;
    // Claim için stat'ın ŞU AN eşiği karşılaması gerekir (server da böyle hesaplar).
    if (meetsThreshold(meta, stats)) {
      tierIds.push(meta.tierId);
      totalGold += meta.rewardGold;
    }
  }
  return { tierIds, totalGold, count: tierIds.length };
}

export function isRewardClaimed(tierId: string): boolean {
  return cachedUnlocks.claimedAchievementRewardIds.includes(tierId);
}

export type ClaimRewardsResult = {
  ok: boolean;
  claimedTierIds: string[];
  goldAwarded: number;
  /** ok=false olduğunda neden. */
  code?: string;
};

/**
 * Tamamlanmış ama claim edilmemiş TÜM achievement ödüllerini tek seferde toplar.
 * Gold server tarafında (claim_achievement_rewards RPC) verilir; aynı ödül ikinci
 * kez verilemez. Başarılıysa local cache (claimedAchievementRewardIds) + Gold
 * bakiyesi server otoritesine senkronize edilir.
 *
 * Misafir kullanıcıda RPC çağrılmaz (server yok) → { ok:false, code:"guest" }.
 */
export async function claimAllAchievementRewards(): Promise<ClaimRewardsResult> {
  if (!activeProfileId) {
    return { ok: false, claimedTierIds: [], goldAwarded: 0, code: "guest" };
  }
  try {
    const { data, error } = await supabase.rpc("claim_achievement_rewards");
    if (error) {
      return { ok: false, claimedTierIds: [], goldAwarded: 0, code: "network" };
    }
    const res = data as {
      ok?: boolean;
      claimedTierIds?: string[];
      goldAwarded?: number;
      gold?: number;
      code?: string;
    } | null;

    if (!res || !res.ok) {
      return { ok: false, claimedTierIds: [], goldAwarded: 0, code: res?.code ?? "rejected" };
    }

    const claimedTierIds = res.claimedTierIds ?? [];
    const goldAwarded = res.goldAwarded ?? 0;

    if (claimedTierIds.length > 0) {
      const merged = new Set([
        ...cachedUnlocks.claimedAchievementRewardIds,
        ...claimedTierIds,
      ]);
      cachedUnlocks = { ...cachedUnlocks, claimedAchievementRewardIds: [...merged] };
      persistUnlocksLocal();
    }
    if (typeof res.gold === "number") syncGoldFromServer(res.gold);
    emit();

    return { ok: true, claimedTierIds, goldAwarded };
  } catch {
    return { ok: false, claimedTierIds: [], goldAwarded: 0, code: "network" };
  }
}

/* ────────────────────────────────────────────────────────────────────────
   React hook
   ──────────────────────────────────────────────────────────────────────── */

/** stats + unlocks'a abone olur; her mutasyonda yeniden render eder. */
export function useAchievementState(): {
  stats: UserAchievementStats;
  unlocks: UserAchievementUnlocks;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    listeners.push(cb);
    return () => {
      listeners = listeners.filter((l) => l !== cb);
    };
  }, []);
  return { stats: cachedStats, unlocks: cachedUnlocks };
}
