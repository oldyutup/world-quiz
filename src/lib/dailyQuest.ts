/**
 * dailyQuest.ts — Günün Görevi client katmanı (sunucu-otoriter).
 *
 * Tek sorumluluk: 20260803120000_daily_quest_init.sql RPC'lerini tipli
 * sarmalamak + üst bar rozeti için hafif gözlemlenebilir durum tutmak.
 *
 *  - Görev seçimi/attempt/ilerleme/claim tamamen SUNUCUDA; buradaki hiçbir
 *    fonksiyon hedef, süre, skor veya ödül miktarı GÖNDERMEZ.
 *  - Gold: claim RPC'si yeni bakiyeyi döndürür; mevcut gold.ts store'una
 *    yalnız İZOLE adapter `syncGoldFromServer` ile senkronlanır (gold.ts
 *    değiştirilmedi — optimistic yol da kullanılmaz, otorite sunucu).
 *  - Zaman: RPC yanıtlarındaki server_now ile oturum-başı offset hesaplanır;
 *    client saati OTORİTE DEĞİLDİR (kalan süre yalnız görüntü biçimlendirir).
 */
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { syncGoldFromServer } from "./gold";

/* ── Mobil görünürlük kararları (ÜRÜN, YÜZEY BAŞINA AYRI ANAHTAR) ───────────
   Eskiden tek bir `MOBILE_DAILY_QUEST_VISIBLE` üç ayrı davranışı birlikte
   açıp kapatıyordu; ana menüyü temizlemek için kapatıldığında intro ve sosyal
   sekme de yanında kapandı. Kararlar artık ayrı — biri diğerini sürüklemez.

   Ortak sabitler (üçü de): özellik, RPC'ler, ödül/ilerleme akışı ve
   DailyQuestModal / DailyQuestGame bileşenleri OLDUĞU GİBİ durur; bayraklar
   yalnız GİRİŞLERİ kapatır. MASAÜSTÜ ETKİLENMEZ — üst bardaki "Günün Görevi"
   butonu bu bayrakların hiçbirini okumaz. */

/** Mobil ANA MENÜ yüzeyi (MobileHome). Kapalı: ana menüde Günün Görevi'ne dair
 *  hiçbir iz yok — kart/entry yok ve alt-nav rozetine +1 EKLENMEZ (sosyal
 *  okunmamış sayacı bundan etkilenmez). Ana menü tasarımı dondurulmuş durumda;
 *  bunu `true` yapmak görsel bir değişikliktir, ürün onayı ister. */
export const MOBILE_DAILY_QUEST_HOME_VISIBLE: boolean = false;

/** Mobil İLK-GİRİŞ intro'su (App.tsx efekti). Açık: uygun koşullarda o görev
 *  günü için BİR KEZ DailyQuestModal otomatik açılır. "Bir kez göster" kaydı
 *  localStorage'da profil+görev-tarihi bazında — gün içinde tekrarlamaz. */
export const MOBILE_DAILY_QUEST_INTRO_ENABLED: boolean = true;

/** Arkadaşlar / SocialCenter sheet'indeki "Görev" sekmesi. Açık: sekme listede
 *  görünür ve mevcut görev paneli (durum + CTA) render edilir. */
export const MOBILE_DAILY_QUEST_SOCIAL_VISIBLE: boolean = true;

/* ── Tipler ─────────────────────────────────────────────────────────────── */

export type DailyQuestMode =
  | "country_write"
  | "flag_quiz"
  | "route_complete"
  | "wheel_find";

export type DailyQuestRegion =
  | "world" | "europe" | "asia" | "africa"
  | "north-america" | "south-america" | "oceania";

export interface DailyQuestInfo {
  id: string;
  quest_date: string;
  mode: DailyQuestMode;
  title: string;
  description: string;
  reward_gold: number;
  starts_at: string;
  ends_at: string;
  config: Record<string, unknown>;
}

/** Sunucunun attempt görünümü (_daily_quest_attempt_view) — mod-özel alanlar. */
export interface DailyQuestAttemptView {
  id: string;
  status: "active" | "completed" | "failed" | "abandoned" | "expired";
  started_at: string;
  deadline: string;
  completed_at: string | null;
  /* country_write */
  found_codes?: string[];
  found_count?: number;
  target?: number;
  /* flag_quiz */
  next_index?: number;
  correct_count?: number;
  wrong_count?: number;
  total?: number;
  required?: number;
  current_code?: string | null; // flag + wheel: yalnız MEVCUT soru/hedef
  /* wheel_find */
  target_index?: number;
  target_count?: number;
  /* route_complete */
  start_key?: string;
  target_key?: string;
  current_key?: string;
  path?: string[];
}

export interface DailyQuestState {
  ok: boolean;
  code?: string;
  server_now?: string;
  quest?: DailyQuestInfo;
  attempt?: DailyQuestAttemptView | null;
  completed_attempt_id?: string | null;
  has_completed?: boolean;
  has_failed_attempt?: boolean;
  claimed?: boolean;
  claimed_at?: string | null;
}

/** Aktif görev oturumu — DailyQuestGame ekranına taşınan kilitli bağlam. */
export interface DailyQuestSession {
  attemptId: string;
  mode: DailyQuestMode;
  config: Record<string, unknown>;
  questTitle: string;
  rewardGold: number;
  /** Sunucu deadline'ı (epoch ms) — client süreyi DEĞİŞTİREMEZ. */
  deadlineMs: number;
  /** server_now − Date.now() (oturum başında); geri sayım görüntüsü için. */
  serverOffsetMs: number;
  view: DailyQuestAttemptView;
}

/* ── RPC sarmalayıcıları ───────────────────────────────────────────────── */

async function rpc<T = Record<string, unknown>>(
  fn: string,
  args?: Record<string, unknown>
): Promise<T | { ok: false; code: string }> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    console.error(`[dailyQuest] ${fn} RPC error:`, error);
    // PGRST202 → migration henüz deploy edilmemiş (DB güncel değil).
    const code = (error as { code?: string }).code === "PGRST202" ? "db_not_ready" : "rpc_error";
    return { ok: false, code };
  }
  return (data ?? { ok: false, code: "empty_response" }) as T;
}

export async function fetchDailyQuestState(): Promise<DailyQuestState> {
  const res = await rpc<DailyQuestState>("daily_quest_get_state");
  const state = res as DailyQuestState;
  updateStatusFromState(state);
  setLastState(state);
  return state;
}

export interface StartAttemptResult {
  ok: boolean;
  code?: string;
  resumed?: boolean;
  server_now?: string;
  quest_id?: string;
  mode?: DailyQuestMode;
  config?: Record<string, unknown>;
  attempt?: DailyQuestAttemptView;
}

export async function startDailyQuestAttempt(resume: boolean): Promise<StartAttemptResult> {
  return (await rpc<StartAttemptResult>("daily_quest_start_attempt", {
    p_resume: resume,
  })) as StartAttemptResult;
}

export interface SubmitCountryResult {
  ok: boolean; code?: string;
  accepted?: boolean; reason?: string;
  found_count?: number; target?: number; completed?: boolean;
}
export async function submitDailyQuestCountry(
  attemptId: string, countryCode: string
): Promise<SubmitCountryResult> {
  return (await rpc<SubmitCountryResult>("daily_quest_submit_country", {
    p_attempt_id: attemptId, p_code: countryCode,
  })) as SubmitCountryResult;
}

export interface SubmitFlagResult {
  ok: boolean; code?: string; next_index?: number;
  correct?: boolean; answer_code?: string;
  correct_count?: number; wrong_count?: number;
  total?: number; required?: number;
  next_code?: string | null; completed?: boolean; failed?: boolean;
}
export async function submitDailyQuestFlagAnswer(
  attemptId: string, index: number, countryCode: string | null
): Promise<SubmitFlagResult> {
  return (await rpc<SubmitFlagResult>("daily_quest_submit_flag_answer", {
    p_attempt_id: attemptId, p_index: index, p_code: countryCode,
  })) as SubmitFlagResult;
}

export interface SubmitRouteResult {
  ok: boolean; code?: string;
  accepted?: boolean; reason?: string;
  current_key?: string; path?: string[]; completed?: boolean;
}
export async function submitDailyQuestRouteMove(
  attemptId: string, countryKey: string
): Promise<SubmitRouteResult> {
  return (await rpc<SubmitRouteResult>("daily_quest_submit_route_move", {
    p_attempt_id: attemptId, p_country_key: countryKey,
  })) as SubmitRouteResult;
}

export interface SubmitWheelResult {
  ok: boolean; code?: string;
  correct?: boolean; found_code?: string;
  target_index?: number; target_count?: number;
  next_code?: string | null; completed?: boolean;
}
export async function submitDailyQuestWheelPick(
  attemptId: string, countryCode: string
): Promise<SubmitWheelResult> {
  return (await rpc<SubmitWheelResult>("daily_quest_submit_wheel_pick", {
    p_attempt_id: attemptId, p_code: countryCode,
  })) as SubmitWheelResult;
}

export interface ClaimResult {
  ok: boolean; code?: string; gold?: number; amount?: number;
}

/**
 * Ödül claim'i. Miktar CLIENT'TAN GİTMEZ — sunucu daily_quests.reward_gold
 * okur. Başarıda (veya idempotent already_claimed dönüşünde) topbar/profil
 * gold görünümü sunucu bakiyesine senkronlanır (izole adapter; gold.ts'e
 * dokunulmaz, optimistic artış YOK).
 */
export async function claimDailyQuestReward(attemptId: string): Promise<ClaimResult> {
  const res = (await rpc<ClaimResult>("daily_quest_claim_reward", {
    p_attempt_id: attemptId,
  })) as ClaimResult;
  if (typeof res.gold === "number") {
    syncGoldFromServer(res.gold);
  }
  if (res.ok || res.code === "already_claimed") {
    setDailyQuestStatus("claimed");
  }
  return res;
}

/* ── Üst bar rozeti için gözlemlenebilir durum ─────────────────────────── */

export type DailyQuestStatus =
  | "unknown"       // henüz sorgulanmadı / giriş yok
  | "available"     // bugünkü görev oynanabilir
  | "active"        // devam eden attempt var
  | "reward_ready"  // tamamlandı, ödül bekliyor
  | "claimed";      // bugünkü ödül alındı

let currentStatus: DailyQuestStatus = "unknown";
let statusListeners: Array<(s: DailyQuestStatus) => void> = [];

export function setDailyQuestStatus(s: DailyQuestStatus): void {
  if (s === currentStatus) return;
  currentStatus = s;
  for (const cb of statusListeners) cb(s);
}

export function getDailyQuestStatus(): DailyQuestStatus {
  return currentStatus;
}

function updateStatusFromState(state: DailyQuestState): void {
  if (!state.ok) {
    // Hata/eksik migration: rozet sessiz kalır (buton yine tıklanabilir).
    setDailyQuestStatus("unknown");
    return;
  }
  if (state.claimed) setDailyQuestStatus("claimed");
  else if (state.has_completed) setDailyQuestStatus("reward_ready");
  else if (state.attempt && state.attempt.status === "active") setDailyQuestStatus("active");
  else setDailyQuestStatus("available");
}

/** Rozet durumunu sunucudan tazeler (giriş yapılmışken). */
export async function refreshDailyQuestStatus(): Promise<void> {
  await fetchDailyQuestState();
}

/** React hook: üst bar / mobil giriş rozeti tek kaynaktan okur. */
export function useDailyQuestStatus(): DailyQuestStatus {
  const [status, setStatus] = useState<DailyQuestStatus>(getDailyQuestStatus);
  useEffect(() => {
    statusListeners.push(setStatus);
    setStatus(getDailyQuestStatus());
    return () => {
      statusListeners = statusListeners.filter((l) => l !== setStatus);
    };
  }, []);
  return status;
}

/* ── Görev anlık görüntüsü (Görev sekmesi özeti + intro auto-open anahtarı) ──
   Son daily_quest_get_state yanıtı, status gözlemlenebiliriyle AYNI fetch'te
   güncellenir (ayrı RPC atılmaz). Görev sekmesi buradan başlık/mod/ödül/açıklama
   okur; intro auto-open buradan quest tarih/id anahtarını türetir. Otorite yine
   status + sunucu; bu yalnız görüntü içindir. */
let lastState: DailyQuestState | null = null;
let stateListeners: Array<(s: DailyQuestState | null) => void> = [];

function setLastState(state: DailyQuestState | null): void {
  lastState = state;
  for (const cb of stateListeners) cb(state);
}

export function getDailyQuestState(): DailyQuestState | null {
  return lastState;
}

/** Bugünkü görevin { id, quest_date } anahtarı — intro "bir kez göster"
 *  localStorage anahtarı (daily_quest_intro_seen:<profil>:<tarih>) için. Yalnız
 *  geçerli+oynanabilir görev yüklüyken dolu; aksi halde null (auto-open atlanır). */
export function getCurrentDailyQuestKey(): { id: string; date: string } | null {
  if (lastState?.ok && lastState.quest) {
    return { id: lastState.quest.id, date: lastState.quest.quest_date };
  }
  return null;
}

/** React hook: Görev sekmesi özet kartı son durumu tek kaynaktan okur. */
export function useDailyQuestState(): DailyQuestState | null {
  const [snapshot, setSnapshot] = useState<DailyQuestState | null>(getDailyQuestState);
  useEffect(() => {
    stateListeners.push(setSnapshot);
    setSnapshot(getDailyQuestState());
    return () => {
      stateListeners = stateListeners.filter((l) => l !== setSnapshot);
    };
  }, []);
  return snapshot;
}

/* ── Yardımcılar ────────────────────────────────────────────────────────── */

/** start/state yanıtından oyun oturumu kurar (deadline + server offset). */
export function buildDailyQuestSession(
  quest: Pick<DailyQuestInfo, "title" | "reward_gold" | "mode" | "config">,
  attempt: DailyQuestAttemptView,
  serverNowIso: string | undefined
): DailyQuestSession {
  const serverNowMs = serverNowIso ? Date.parse(serverNowIso) : Date.now();
  return {
    attemptId: attempt.id,
    mode: quest.mode,
    config: quest.config,
    questTitle: quest.title,
    rewardGold: quest.reward_gold,
    deadlineMs: Date.parse(attempt.deadline),
    serverOffsetMs: serverNowMs - Date.now(),
    view: attempt,
  };
}

/** Kalan süre (sn) — sunucu saat çıpası ile. Görüntü amaçlı; otorite sunucu. */
export function dailyQuestRemainingSeconds(session: {
  deadlineMs: number; serverOffsetMs: number;
}): number {
  const nowServerMs = Date.now() + session.serverOffsetMs;
  return Math.max(0, Math.ceil((session.deadlineMs - nowServerMs) / 1000));
}

/** UTC görev bitişine kalan süreyi kullanıcı lokal biçiminde yazar. */
export function formatQuestCountdown(endsAtIso: string, serverOffsetMs: number): string {
  const remainMs = Date.parse(endsAtIso) - (Date.now() + serverOffsetMs);
  if (remainMs <= 0) return "Süresi doldu";
  const totalMin = Math.floor(remainMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h} sa ${m} dk`;
  const s = Math.floor((remainMs % 60_000) / 1000);
  return m > 0 ? `${m} dk ${s} sn` : `${s} sn`;
}

export const DAILY_QUEST_REGION_LABELS: Record<DailyQuestRegion, string> = {
  world: "Dünya",
  europe: "Avrupa",
  asia: "Asya",
  africa: "Afrika",
  "north-america": "Kuzey Amerika",
  "south-america": "Güney Amerika",
  oceania: "Okyanusya",
};

export const DAILY_QUEST_MODE_META: Record<DailyQuestMode, { label: string; iconPath: string }> = {
  country_write:  { label: "Ülke Yaz",       iconPath: "/assets/icons/home/country-write.png" },
  flag_quiz:      { label: "Bayrak Bilmece", iconPath: "/assets/icons/home/flag-mode.png" },
  route_complete: { label: "Rota Modu",      iconPath: "/assets/icons/home/route-mode.png" },
  wheel_find:     { label: "Çark Modu",      iconPath: "/assets/icons/home/wheel-mode.png" },
};

/** Kilitli görev ayarlarını modal/HUD chip'leri için okunur listeye çevirir. */
export function describeLockedSettings(
  mode: DailyQuestMode,
  config: Record<string, unknown>
): { label: string; value: string }[] {
  const region = (r: unknown) =>
    DAILY_QUEST_REGION_LABELS[(r as DailyQuestRegion) ?? "world"] ?? "Dünya";
  const secs = (s: unknown) => {
    const n = Number(s ?? 0);
    const m = Math.floor(n / 60), r = n % 60;
    return m > 0 ? (r > 0 ? `${m} dk ${r} sn` : `${m} dk`) : `${r} sn`;
  };
  switch (mode) {
    case "country_write":
      return [
        { label: "Bölge", value: region(config.region) },
        { label: "Süre", value: secs(config.duration_seconds) },
        { label: "Hedef", value: `${config.target_count} ülke` },
      ];
    case "flag_quiz":
      return [
        { label: "Bölge", value: region(config.region) },
        { label: "Soru", value: `${config.total_questions} bayrak` },
        { label: "Hedef", value: `${config.required_correct} doğru` },
      ];
    case "route_complete":
      return [
        { label: "Ara ülke", value: `${config.intermediates}` },
        { label: "Süre", value: secs(config.deadline_seconds) },
      ];
    case "wheel_find":
      return [
        { label: "Bölge", value: region(config.region) },
        { label: "Hedef", value: `${config.target_count} ülke` },
        { label: "Süre", value: secs(config.total_seconds) },
      ];
  }
}
