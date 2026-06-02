/**
 * gold.ts
 *
 * Tek noktadan Gold persistence katmanı.
 *
 *  - Giriş yapmış kullanıcı → public.profiles.gold (source of truth)
 *  - Misafir kullanıcı       → localStorage("geoquiz_gold") (fallback)
 *
 * Tasarım:
 *  - Uygulama içinde bir modül-global cache (cachedGold) tutuyoruz; UI senkron
 *    okuyabilsin diye. Supabase yazımları arka planda asenkron yapılır.
 *  - setActiveProfile(profileId, profile.gold) login/logout anında çağrılır;
 *    sadece profile.id değiştiğinde tetiklenmesi gerek (yoksa fresh local
 *    değeri stale profile.gold ile override edebiliriz).
 *  - addGold/spendGold optimistic; başarısız Supabase yazımı UI'da geri
 *    rollback ETMEZ — sadece error log'lar. Sebep: oyunlar hızlı akar,
 *    rollback flicker yapar. Manuel reload Supabase'i otorite kabul eder.
 *  - localStorage misafir verisini koruyoruz; login Supabase'in lehine yazsın
 *    diye burada migration yok.
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

/** Senkron okuma — UI initial state için. */
export function getGold(): number {
  return cachedGold;
}

/**
 * Login/logout anında çağır. Supabase profile.gold ile cache'i set eder.
 *
 *  - profileId === null → misafir moduna döner, cache localStorage'tan yüklenir.
 *  - profileId verilirse goldFromProfile değerini KAYNAĞIN OTORİTESİ kabul
 *    eder; misafir localStorage değeri Supabase'e KOPYALANMAZ.
 *
 * profileId hiç değişmediyse no-op'tur — her render'da çağrılması güvenli
 * ama tipik kullanım useEffect içinde profile.id dependency ile.
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
    const next = Math.max(0, Math.floor(goldFromProfile ?? 0));
    cachedGold = next;
    writeLocal(next);
    emit(next);
  } else {
    const next = readLocal();
    cachedGold = next;
    emit(next);
  }
}

function applyDelta(delta: number): number {
  const next = Math.max(0, cachedGold + delta);
  cachedGold = next;
  writeLocal(next);
  emit(next);

  if (activeProfileId) {
    const id = activeProfileId;
    supabase
      .from("profiles")
      .update({ gold: next, updated_at: new Date().toISOString() })
      .eq("id", id)
      .then(({ error }) => {
        if (error) {
          console.error("[gold] Supabase profile gold update failed:", error);
        }
      });
  }

  return next;
}

/**
 * Server-side bir RPC (örn. change_username) Gold'u zaten düştüğünde
 * UI cache'ini güncellemek için kullanılır. Burada Supabase'e tekrar
 * yazmıyoruz — sadece local cache & localStorage senkronize edilir.
 */
export function syncGoldFromServer(value: number): number {
  const next = Math.max(0, Math.floor(value || 0));
  cachedGold = next;
  writeLocal(next);
  emit(next);
  return next;
}

/** Pozitif değer ekler. Sonuçtaki toplamı döner. */
export function addGold(amount: number): number {
  const amt = Math.max(0, Math.floor(amount || 0));
  if (amt === 0) return cachedGold;
  return applyDelta(amt);
}

/**
 * Gold harcar. Yeterli değilse false döner ve hiçbir state güncellenmez.
 * Başarıyla harcanırsa true döner.
 */
export function spendGold(amount: number): boolean {
  const amt = Math.max(0, Math.floor(amount || 0));
  if (amt === 0) return true;
  if (cachedGold < amt) return false;
  applyDelta(-amt);
  return true;
}

/** Günlük bonus — her cihaz/oturumda lokal flag ile tutulur. */
export function canClaimDailyBonus(): boolean {
  try {
    const last = localStorage.getItem(GOLD_BONUS_KEY);
    return !last || last !== new Date().toDateString();
  } catch {
    return true;
  }
}

/** Bonus claim eder. Zaten alındıysa null, alındıysa yeni toplam döner. */
export function claimDailyBonus(): number | null {
  if (!canClaimDailyBonus()) return null;
  try {
    localStorage.setItem(GOLD_BONUS_KEY, new Date().toDateString());
  } catch {
    /* ignore */
  }
  return addGold(DAILY_BONUS);
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
