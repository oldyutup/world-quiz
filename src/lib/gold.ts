/**
 * gold.ts
 *
 * Tek noktadan Gold persistence katmanı (server-otoriteli).
 *
 *  - Giriş yapmış kullanıcı → server'da public.profiles.gold (source of truth).
 *    Yazımlar yalnızca SECURITY DEFINER RPC'leri uzerinden yapılır:
 *      - claim_daily_gold_bonus()
 *      - award_gameplay_gold(amount, reason, metadata)
 *      - spend_gameplay_gold(amount, reason, metadata)
 *    Client doğrudan profiles.gold UPDATE etmez (DB tarafında
 *    `revoke update (gold) on profiles from authenticated` ile bloklanır).
 *
 *  - Misafir kullanıcı → localStorage("geoquiz_gold") fallback. RPC çağrılmaz;
 *    misafirlerin Gold'u cihaz-yerel, izlenebilir/transaction log'suz kalır.
 *
 * Tasarım:
 *  - UI'ın senkron `useGold()` / `getGold()` API'sini koruyabilmek için
 *    modül-global cache (`cachedGold`) tutuyoruz. RPC çağrıları arka planda
 *    asenkron yapılır ve sonuç dönünce server'in dönen yeni bakiyesiyle
 *    reconcile edilir.
 *  - addGold/spendGold optimistic: cache anında güncellenir, RPC sonucu
 *    gelince cache server otoritesine senkronize edilir. RPC reddederse
 *    (yetersiz Gold, geçersiz reason, vs.) cache rollback'lenir.
 *  - setActiveProfile(profileId, profile.gold) login/logout anında çağrılır.
 *  - Public API geriye dönük uyumlu: tüm çağrı yerleri (gameplay dahil)
 *    değişmeden çalışır.
 */
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const GOLD_KEY       = "geoquiz_gold";
const GOLD_BONUS_KEY = "geoquiz_daily_bonus";
export const DAILY_BONUS = 50;

/**
 * Kuşatma modunda Kader Kartı çekiminin sabit Gold maliyeti.
 * Client tarafının bu sayıyı yerelde değiştirmesine izin vermemek için
 * harcama her zaman `spend_gameplay_gold` RPC'si üzerinden yapılır;
 * sabit yalnızca UI ve handler için merkezi bir kaynaktır.
 */
export const CONQUEST_FATE_CARD_COST = 200;

let activeProfileId: string | null = null;
let cachedGold = readLocal();
let listeners: Array<(n: number) => void> = [];

/* ── Günlük bonus uygunluğu (server-otoriteli gözlemlenebilir) ──────────────
 * Hem üst-sağ GoldBar ("+50 Günlük Bonus") hem de Bildirimler panelindeki
 * "Günlük bonusun hazır" kartı AYNI kaynaktan beslensin diye günlük uygunluğu
 * burada tutuyoruz. Tek otorite yine server: misafirde localStorage,
 * giriş yapmışta daily_gold_reward_status RPC'si. Hiçbir ikinci timer/sayaç
 * burada yaşamaz; UI yalnızca refreshDailyReward()/claim sonrası bu cache'i okur.
 */
export interface DailyRewardState {
  /** Günlük bonus şu an alınabilir mi? */
  available: boolean;
  /** Alınamıyorsa bir sonraki uygunluk anı (ISO, server). Hafif yenileme için. */
  availableAt: string | null;
}
let dailyAvailable: boolean = canClaimDailyBonus();
let dailyAvailableAt: string | null = null;
let dailyListeners: Array<(s: DailyRewardState) => void> = [];

function emitDaily() {
  const snap: DailyRewardState = { available: dailyAvailable, availableAt: dailyAvailableAt };
  for (const cb of dailyListeners) cb(snap);
}

function setDailyReward(available: boolean, availableAt: string | null): void {
  dailyAvailable = available;
  dailyAvailableAt = availableAt;
  emitDaily();
}

function readLocal(): number {
  try {
    return Math.max(0, parseInt(localStorage.getItem(GOLD_KEY) ?? "0", 10) || 0);
  } catch {
    return 0;
  }
}

function writeLocal(n: number): void {
  try {
    localStorage.setItem(GOLD_KEY, String(Math.max(0, Math.floor(n))));
  } catch {
    /* ignore */
  }
}

function emit(n: number) {
  for (const cb of listeners) cb(n);
}

function setCache(n: number): number {
  const next = Math.max(0, Math.floor(n));
  cachedGold = next;
  writeLocal(next);
  emit(next);
  return next;
}

/** Senkron okuma — UI initial state için. */
export function getGold(): number {
  return cachedGold;
}

/**
 * Login/logout anında çağır. Supabase profile.gold ile cache'i set eder.
 *
 *  - profileId === null → misafir moduna döner, cache localStorage'tan yüklenir.
 *  - profileId verilirse goldFromProfile değerini OTORİTE kabul eder; misafir
 *    localStorage değeri Supabase'e KOPYALANMAZ.
 */
export function setActiveProfile(
  profileId: string | null,
  goldFromProfile?: number | null
): void {
  if (profileId === activeProfileId) {
    return;
  }
  activeProfileId = profileId;
  if (profileId) {
    setCache(goldFromProfile ?? 0);
  } else {
    const next = readLocal();
    cachedGold = next;
    emit(next);
  }
  // Login/logout → günlük bonus uygunluğunu (server-otoriteli) tazele.
  void refreshDailyReward();
}

/**
 * Server-side bir RPC (örn. change_username) Gold'u zaten düştüğünde
 * UI cache'ini güncellemek için kullanılır. Burada Supabase'e tekrar
 * yazmıyoruz — sadece local cache & localStorage senkronize edilir.
 */
export function syncGoldFromServer(value: number): number {
  return setCache(value);
}

/* ── Tipler ──────────────────────────────────────────────────────────── */

type AwardReason =
  | "map_match_reward"
  | "silhouette_match_reward"
  | "flag_match_reward"
  | "route_match_reward"
  | "conquest_liman_income"
  | "conquest_fate_card_refund"
  | "gameplay_award";

type SpendReason =
  | "hint_first_letter"
  | "hint_letter_count"
  | "hint_continent"
  | "hint_region"
  | "hint_coast"
  | "hint_neighbors"
  | "hint_silhouette"
  | "hint_generic"
  | "conquest_fate_card"
  | "gameplay_spend";

/* ── RPC sarmalayicilari ────────────────────────────────────────────── */

async function rpcAward(
  amount: number,
  reason: AwardReason,
  metadata: Record<string, unknown>
): Promise<number | null> {
  const { data, error } = await supabase.rpc("award_gameplay_gold", {
    p_amount:   amount,
    p_reason:   reason,
    p_metadata: metadata,
  });
  if (error) {
    console.error("[gold] award_gameplay_gold RPC error:", error);
    return null;
  }
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok) {
    return Number((data as { gold: number }).gold);
  }
  console.warn("[gold] award_gameplay_gold rejected:", data);
  return null;
}

async function rpcSpend(
  amount: number,
  reason: SpendReason,
  metadata: Record<string, unknown>
): Promise<number | null> {
  const { data, error } = await supabase.rpc("spend_gameplay_gold", {
    p_amount:   amount,
    p_reason:   reason,
    p_metadata: metadata,
  });
  if (error) {
    console.error("[gold] spend_gameplay_gold RPC error:", error);
    return null;
  }
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok) {
    return Number((data as { gold: number }).gold);
  }
  console.warn("[gold] spend_gameplay_gold rejected:", data);
  return null;
}

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Pozitif değer ekler. Sonuçtaki (optimistic) toplamı senkron döner.
 *
 * Giriş yapmış kullanıcılarda arka planda RPC'ye gider; sunucu yeni
 * bakiyeyi onayladığında cache server otoritesine reconcile edilir.
 * RPC reddederse optimistic update geri alınır.
 */
export function addGold(
  amount: number,
  reason: AwardReason = "gameplay_award",
  metadata: Record<string, unknown> = {}
): number {
  const amt = Math.max(0, Math.floor(amount || 0));
  if (amt === 0) return cachedGold;

  const optimistic = setCache(cachedGold + amt);

  if (activeProfileId) {
    void rpcAward(amt, reason, metadata).then((serverGold) => {
      if (serverGold === null) {
        // Reddedildi (geçersiz reason / cap aşıldı / network): optimistic'i geri al.
        setCache(Math.max(0, cachedGold - amt));
      } else {
        setCache(serverGold);
      }
    });
  }

  return optimistic;
}

/**
 * Gold harcar.
 *
 * Misafir kullanıcılarda yalnızca local cache kontrol edilir (yetersizse false).
 * Giriş yapmış kullanıcılarda önce optimistic cache düşürülür; RPC reddederse
 * (yetersiz bakiye / cap / geçersiz reason) optimistic geri alınır.
 *
 * Senkron sonuc — UI flow'unu kırmamak için. Sunucu tarafı reconciliation
 * arka planda yapılır.
 */
export function spendGold(
  amount: number,
  reason: SpendReason = "gameplay_spend",
  metadata: Record<string, unknown> = {}
): boolean {
  const amt = Math.max(0, Math.floor(amount || 0));
  if (amt === 0) return true;
  if (cachedGold < amt) return false;

  setCache(cachedGold - amt);

  if (activeProfileId) {
    void rpcSpend(amt, reason, metadata).then((serverGold) => {
      if (serverGold === null) {
        // Reddedildi: optimistic harcamayı geri yükle.
        setCache(cachedGold + amt);
      } else {
        setCache(serverGold);
      }
    });
  }

  return true;
}

/**
 * Server-onayli (await'li) Gold harcamasi.
 *
 * `spendGold` optimistic — kart çekimi gibi “Gold gerçekten düşmeden önce
 * efekt uygulanmamalı” akışlar için yetersizdir: optimistic harcama UI'ı
 * günceller, RPC reddederse cache geri alınır ama o sırada efekt çoktan
 * uygulanmış olabilir. Bu helper RPC sonucunu bekler ve yalnızca server
 * spend'i onayladıktan sonra `true` döner.
 *
 *  - Misafir kullanıcı (Kuşatma'ya giremese de defansif): yalnızca local
 *    cache kontrol edilir. Local yetersizse `false`; yeterliyse local
 *    düşülür ve `true` döner (RPC çağrılmaz).
 *  - Giriş yapmış kullanıcı: cache yetersizse erkenden `false`. Aksi halde
 *    optimistic cache güncellenir, RPC awaitlenir; başarısızsa optimistic
 *    geri alınır ve `false` döner.
 */
export async function spendGoldAsync(
  amount: number,
  reason: SpendReason,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const amt = Math.max(0, Math.floor(amount || 0));
  if (amt === 0) return true;
  if (cachedGold < amt) return false;

  if (!activeProfileId) {
    setCache(cachedGold - amt);
    return true;
  }

  const before = cachedGold;
  setCache(cachedGold - amt);

  const serverGold = await rpcSpend(amt, reason, metadata);
  if (serverGold === null) {
    setCache(before);
    return false;
  }
  setCache(serverGold);
  return true;
}

/**
 * Günlük bonus için lokal hızlı kontrol — UI butonunu disable etmek için.
 * Otorite server'dır; misafir kullanıcılarda localStorage flag kullanılır.
 * Giriş yapmış kullanıcılarda da localStorage işaretini koruyoruz (yanlış
 * pozitif gösterilse bile server reddedecek).
 */
export function canClaimDailyBonus(): boolean {
  try {
    const last = localStorage.getItem(GOLD_BONUS_KEY);
    return !last || last !== new Date().toDateString();
  } catch {
    return true;
  }
}

/**
 * Daily bonus claim.
 *
 *  - Misafir: hemen +50 local Gold, localStorage flag set.
 *  - Login: claim_daily_gold_bonus RPC'sine git. Server zaten bugün alındıysa
 *    null döner. Başarılıysa cache'i server'in döndürdüğü bakiyeye senkronize
 *    eder.
 *
 * Senkron bir API'ydi — geriye dönük uyum için aynı imzayı tutuyoruz:
 * dönen değer optimistic yeni toplam (veya zaten alındıysa null). RPC
 * reddederse asenkron olarak cache geri alınır.
 */
export function claimDailyBonus(): number | null {
  if (!canClaimDailyBonus()) return null;
  try {
    localStorage.setItem(GOLD_BONUS_KEY, new Date().toDateString());
  } catch {
    /* ignore */
  }
  // Optimistic: bonus alındı → her iki UI (GoldBar + bildirim kartı) gizlensin.
  setDailyReward(false, dailyAvailableAt);

  if (!activeProfileId) {
    // Misafir: lokal mod, RPC yok.
    return setCache(cachedGold + DAILY_BONUS);
  }

  const optimistic = setCache(cachedGold + DAILY_BONUS);

  void supabase
    .rpc("claim_daily_gold_bonus")
    .then(({ data, error }) => {
      if (error) {
        console.error("[gold] claim_daily_gold_bonus RPC error:", error);
        setCache(Math.max(0, cachedGold - DAILY_BONUS));
        // Hata: gerçek durumu server'dan tazele (optimistic geri alınabilir).
        void refreshDailyReward();
        return;
      }
      if (data && typeof data === "object") {
        const res = data as { ok?: boolean; gold?: number; code?: string };
        if (res.ok && typeof res.gold === "number") {
          setCache(res.gold);
          return;
        }
        // already_claimed: server otorite, cache'i server bakiyesine cek.
        if (res.code === "already_claimed" && typeof res.gold === "number") {
          setCache(res.gold);
          return;
        }
        // Diger durumlar: optimistic'i geri al + durumu tazele.
        setCache(Math.max(0, cachedGold - DAILY_BONUS));
        void refreshDailyReward();
      }
    });

  return optimistic;
}

/**
 * Günlük bonus durumunu server'dan tazeler (tek otorite). Sonucu
 * gözlemlenebilir cache'e yazar; UI useDailyReward() ile dinler.
 *
 *  - Misafir: localStorage işaretine göre (cihaz-yerel).
 *  - Giriş yapmış: daily_gold_reward_status RPC (gold_transactions üzerinden,
 *    client saatine güvenmez).
 */
export async function refreshDailyReward(): Promise<void> {
  if (!activeProfileId) {
    setDailyReward(canClaimDailyBonus(), null);
    return;
  }
  const { data, error } = await supabase.rpc("daily_gold_reward_status");
  if (error) {
    console.error("[gold] daily_gold_reward_status RPC error:", error);
    return; // mevcut durumu koru
  }
  const res = (data ?? {}) as { ok?: boolean; available?: boolean; available_at?: string | null };
  if (res.ok) {
    setDailyReward(!!res.available, res.available_at ?? null);
  }
}

/**
 * Awaited günlük bonus claim — Bildirimler panelindeki "+50 Gold'u Al" kartı
 * için. claimDailyBonus() ile AYNI server kaynağını (claim_daily_gold_bonus)
 * kullanır; iki sekme aynı anda çağırsa bile server idempotent/atomik olduğu
 * için yalnızca bir kez +50 verir. Donus: { ok, gold?, code? }.
 */
export async function claimDailyBonusAsync(): Promise<{ ok: boolean; gold?: number; code?: string }> {
  if (!activeProfileId) {
    // Misafir: lokal mod.
    if (!canClaimDailyBonus()) {
      setDailyReward(false, dailyAvailableAt);
      return { ok: false, code: "already_claimed", gold: cachedGold };
    }
    try {
      localStorage.setItem(GOLD_BONUS_KEY, new Date().toDateString());
    } catch {
      /* ignore */
    }
    setDailyReward(false, null);
    return { ok: true, gold: setCache(cachedGold + DAILY_BONUS) };
  }

  const { data, error } = await supabase.rpc("claim_daily_gold_bonus");
  if (error) {
    console.error("[gold] claim_daily_gold_bonus RPC error:", error);
    return { ok: false, code: "error" };
  }
  const res = (data ?? {}) as { ok?: boolean; gold?: number; code?: string };

  if (res.ok && typeof res.gold === "number") {
    try {
      localStorage.setItem(GOLD_BONUS_KEY, new Date().toDateString());
    } catch {
      /* ignore */
    }
    setCache(res.gold);
    setDailyReward(false, dailyAvailableAt);
    return { ok: true, gold: res.gold };
  }
  if (res.code === "already_claimed") {
    if (typeof res.gold === "number") setCache(res.gold);
    setDailyReward(false, dailyAvailableAt);
    return { ok: false, code: "already_claimed", gold: res.gold };
  }
  return { ok: false, code: res.code ?? "error" };
}

/** Senkron okuma — UI initial state için. */
export function getDailyReward(): DailyRewardState {
  return { available: dailyAvailable, availableAt: dailyAvailableAt };
}

/**
 * React hook: günlük bonus uygunluğunu abone olarak okur. GoldBar ve bildirim
 * kartı bu tek kaynaktan beslenir; biri claim edince diğeri de güncellenir.
 */
export function useDailyReward(): DailyRewardState {
  const [state, setState] = useState<DailyRewardState>(getDailyReward);
  useEffect(() => {
    dailyListeners.push(setState);
    setState(getDailyReward());
    return () => {
      dailyListeners = dailyListeners.filter((l) => l !== setState);
    };
  }, []);
  return state;
}

/**
 * React hook: cachedGold'u abone olarak okur. Tek satır yazımıyla bütün
 * componentlerin gold UI'ı senkron kalır.
 */
export function useGold(): number {
  const [gold, setGold] = useState<number>(getGold);
  useEffect(() => {
    listeners.push(setGold);
    setGold(getGold());
    return () => {
      listeners = listeners.filter((l) => l !== setGold);
    };
  }, []);
  return gold;
}
