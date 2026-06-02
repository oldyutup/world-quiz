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

let activeProfileId: string | null = null;
let cachedGold = readLocal();
let listeners: Array<(n: number) => void> = [];

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
        // Diger durumlar: optimistic'i geri al.
        setCache(Math.max(0, cachedGold - DAILY_BONUS));
      }
    });

  return optimistic;
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
