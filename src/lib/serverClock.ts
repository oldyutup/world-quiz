/**
 * serverClock — uygulama geneli server-synced clock.
 *
 * Why this exists
 * ───────────────
 * Çok oyunculu modlarda (Ülke Yazmaca, Bayrak, Çark, vb.) `room.started_at`,
 * `current_flag_at`, `endsAt` gibi mutlak timestamp'ler server tarafında
 * `now()` ile yazılıyor; ama her client onları kendi `Date.now()` değerine
 * göre yorumluyor. İki PC arasında birkaç saniyelik saat farkı varsa timer
 * ve countdown'lar farklı zamanda biter — host hâlâ oynarken guest "süren
 * doldu" görür.
 *
 * Kuşatma için `conquestClock.ts` bu sorunu zaten çözmüştü; bu modül aynı
 * mantığı uygulama geneline (mod-agnostik) sunar. Kuşatma kendi modülünü
 * kullanmaya devam eder; bu dosya diğer modlar içindir.
 *
 * Fix shape
 * ─────────
 *   - Server-side RPC `public.get_server_time_ms()` `clock_timestamp()`'i
 *     epoch ms olarak döndürür.
 *   - `initServerClockSync()` mount'ta iki probe (best-of-two RTT) atar,
 *     `serverOffsetMs = serverTime − localTime` cache'ler ve 45 sn'de bir
 *     yeniler.
 *   - Tüm gameplay yazımları ve UI gate'leri `getSyncedNowMs()` —
 *     `Date.now() + serverOffsetMs` — kullanır.
 *
 * Failure mode
 * ────────────
 * RPC başarısız olursa `getSyncedNowMs()` bare `Date.now()`'a düşer ve
 * davranış fix öncesi haline döner. Tek seferlik `console.warn` ile bu
 * regresyon DevTools'ta görünür.
 *
 * Modül-seviyesi state process-singleton; tüm çağıranlar aynı offset'i
 * paylaşır.
 */

import { supabase } from "./supabase";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state (process-singleton)
// ─────────────────────────────────────────────────────────────────────────────

let serverOffsetMs: number = 0;
let lastSyncAtMs:   number = 0;
let isOffsetKnown:  boolean = false;
let warnedFallback: boolean = false;

const REFRESH_INTERVAL_MS = 45_000;
/** Two probes per sync; we keep the one with the smaller RTT. */
const PROBE_COUNT = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server saat referansındaki şu anki epoch ms. Offset bilindikten sonra
 * `Date.now() + serverOffsetMs`; ilk başarılı sync öncesi bare `Date.now()`.
 *
 * Her yerden çağrılabilir (async değil, throw etmez). Tek bir toplama.
 */
export function getSyncedNowMs(): number {
  if (!isOffsetKnown && !warnedFallback) {
    warnedFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[serverClock] Server offset not yet known — falling back to Date.now(). " +
      "This is expected for the very first call before initServerClockSync resolves.",
    );
  }
  return Date.now() + serverOffsetMs;
}

/** Sayfa yüklendikten sonra en az bir probe başarılı olduysa true. */
export function isServerClockSynced(): boolean {
  return isOffsetKnown;
}

/** Geçerli offset (server − local) milisaniye. İlk sync öncesi 0. */
export function getServerClockOffsetMs(): number {
  return serverOffsetMs;
}

/** En son başarılı sync'in wall-clock ms değeri. İlk sync öncesi 0. */
export function getServerClockLastSyncedAtMs(): number {
  return lastSyncAtMs;
}

/**
 * Offset'i Supabase'den çek. İki probe, küçük RTT olan kazanır.
 * Başarıda true, başarısızlıkta false döner (fail'de offset değişmez).
 */
export async function fetchServerTimeOffset(): Promise<boolean> {
  let bestRtt    = Number.POSITIVE_INFINITY;
  let bestOffset: number | null = null;

  for (let i = 0; i < PROBE_COUNT; i++) {
    const sentAt = Date.now();
    const { data, error } = await supabase.rpc("get_server_time_ms");
    const recvAt = Date.now();
    if (error || typeof data !== "number" || !Number.isFinite(data)) continue;
    const rtt        = recvAt - sentAt;
    // Aldığımız server time RTT penceresinin yaklaşık ortasını temsil eder;
    // recvAt'tan RTT'nin yarısını çıkarmak o örneğe karşılık gelen lokal
    // zamanı verir.
    const localAtSample = sentAt + Math.floor(rtt / 2);
    const offset        = data - localAtSample;
    if (rtt < bestRtt) {
      bestRtt    = rtt;
      bestOffset = offset;
    }
  }

  if (bestOffset === null) return false;
  serverOffsetMs = bestOffset;
  isOffsetKnown  = true;
  lastSyncAtMs   = Date.now();
  return true;
}

/**
 * One-shot init + periodic refresh. Dispose handle döndürür.
 *
 * İlk probe hemen atılır (fire-and-forget); sonraki probe'lar
 * REFRESH_INTERVAL_MS'de bir. Probe başarısız olursa offset eski değerinde
 * kalır (veya hiç başarılı olmadıysa 0 / fallback).
 */
export function initServerClockSync(): { dispose: () => void } {
  void fetchServerTimeOffset();

  const intervalId = window.setInterval(() => {
    void fetchServerTimeOffset();
  }, REFRESH_INTERVAL_MS);

  return {
    dispose: () => {
      window.clearInterval(intervalId);
    },
  };
}
