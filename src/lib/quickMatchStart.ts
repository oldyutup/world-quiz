/**
 * quickMatchStart.ts — HIZLI EŞLEŞ MAÇ BAŞLANGICININ SAF KARARI (3-2-1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ÜRÜN SÖZLEŞMESİ
 * ══════════════════════════════════════════════════════════════════════════
 * Hızlı Eşleş kaynaklı bir maç — İLK maç da RÖVANŞ da — şu akışı izler:
 *
 *     sonuç → rövanş mutabakatı → 3 · 2 · 1 → yeni maç
 *
 * ASLA:
 *
 *     sonuç → LOBİ → host "Başlat" → maç
 *
 * Lobi yalnız MANUEL kaynaklı odalara (oda kodu / davet linki / elle kurulan
 * oda) aittir ve orada AYNEN korunur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * KAYNAK OTORİTESİ: `room_source`
 * ══════════════════════════════════════════════════════════════════════════
 * "Bu maç hızlı eşleşmeden mi geldi?" sorusunun cevabı İSTEMCİ UI STATE'İNDE
 * DEĞİL, oda satırının SUNUCU tarafından yazılmış `room_source` kolonundadır
 * ('manual' | 'quick_match'; duel_rooms + wheel_duel_rooms + route_duel_rooms).
 * Kolonu yalnız SECURITY DEFINER eşleştirme/oda-kurma RPC'leri yazar; istemci
 * ne yazar ne de override edebilir. Bu yüzden yeniden yükleme, arka plana
 * alma, reconnect ve rövanş sonrası bile karar AYNI kalır.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * GERİ SAYIM OTORİTESİ: `started_at` (SUNUCU SAATİ), setTimeout DEĞİL
 * ══════════════════════════════════════════════════════════════════════════
 * Hızlı Eşleş odasını sunucu `status='playing'` + `started_at = now() + 3 sn`
 * ile kurar. Rövanş da AYNI mekanizmayı kullanır (bkz.
 * 20260828120000_quick_match_direct_rematch.sql). Yani "maç ne zaman başlar"
 * sorusunun tek cevabı SUNUCUDAKİ satırdır.
 *
 * Buradaki fonksiyonlar `started_at`i SUNUCU-SENKRON saatle (`getSyncedNowMs`)
 * karşılaştırır ve TÜRETİLMİŞ bir değer üretir. Kritik sonuçları:
 *
 *   • İki istemci de AYNI mutlak ana göre sayar → biri erken başlayamaz.
 *   • Sayaç bir istemci-içi zamanlayıcıya SAHİP DEĞİLDİR: yalnızca "şu an ile
 *     sunucunun yazdığı an arasındaki fark" okunur. Sekme arka plana alınıp
 *     geri gelse, throttle edilse, cihaz uyusa bile değer kendini düzeltir.
 *   • Sayfa yenilenir / reconnect olursa oda satırı sunucudan yeniden okunur
 *     ve geri sayım KALDIĞI YERDEN doğru görünür — saklanacak lokal durum yok.
 *
 * Gameplay girdisi de aynı türetilmiş karara bağlanır (`isStartLocked`), ve
 * SUNUCU tarafı da aynı eşiği bağımsız uygular (claim RPC'leri `started_at`
 * geçmeden yazmaz) → istemci guard'ı yalnız UX, otorite sunucudadır.
 *
 * Yan etkisiz + React'sizdir; scripts/check-quick-match-rematch.ts tarafından
 * DB'siz ve tarayıcısız sürülür.
 */

/** Sunucunun Hızlı Eşleş odasına yazdığı başlangıç tamponu (saniye).
 *  SQL karşılığı: `started_at = now() + interval '3 seconds'`. */
export const QUICK_MATCH_START_BUFFER_SECONDS = 3;

/** Karar için gereken minimum oda alanları (mod-agnostik). Üç düello modunun
 *  oda tipleri de bu şekle uyar; ekstra kolonlar önemsizdir. */
export interface QuickMatchStartProbe {
  room_source?: string | null;
  status?:      string | null;
  started_at?:  string | null;
}

/** Maçın kaynağı SUNUCUYA göre hızlı eşleşme mi? Tek otorite `room_source`. */
export function isQuickMatchRoom(room: QuickMatchStartProbe | null | undefined): boolean {
  return room?.room_source === "quick_match";
}

/**
 * Rövanş mutabakatı sağlandığında oyuncular NEREYE gider?
 *   quick_match → "direct" : lobi YOK, 3-2-1, otomatik başlar
 *   manual      → "lobby"  : mevcut oda/lobi davranışı AYNEN korunur
 *
 * Bilinmeyen/boş kaynak MANUEL sayılır: yanlış tarafa düşme maliyeti
 * asimetriktir (lobi göstermek zararsız, lobisiz oda kurmak oyuncuyu
 * kilitleyebilir), bu yüzden varsayılan güvenli taraftır.
 */
export function decideRematchDestination(
  room: QuickMatchStartProbe | null | undefined,
): "direct" | "lobby" {
  return isQuickMatchRoom(room) ? "direct" : "lobby";
}

/**
 * Geri sayımda kaç saniye KALDI? (0 = maç başladı / geri sayım yok)
 *
 * Yalnız `room_source='quick_match'` + `status='playing'` + GELECEKTE bir
 * `started_at` varken pozitif döner. Değer YUVARLANMAZ/KIRPILMAZ: sunucunun
 * yazdığı anla birebir aynı eşiği gösterir; iki istemci aynı saniyeyi görür.
 *
 * `syncedNowMs` geçersizse (saat henüz senkronlanmadı) 0 döner: geri sayımı
 * UYDURMAK yerine göstermemek doğru davranıştır — sunucu zaten kendi eşiğini
 * uygular, istemci sadece geç kalmış olur.
 */
export function computeStartCountdownSeconds(input: {
  room:        QuickMatchStartProbe | null | undefined;
  syncedNowMs: number;
}): number {
  const { room, syncedNowMs } = input;
  if (!isQuickMatchRoom(room)) return 0;
  if (room?.status !== "playing") return 0;
  if (!Number.isFinite(syncedNowMs)) return 0;

  const startedAtMs = room?.started_at ? Date.parse(room.started_at) : Number.NaN;
  if (!Number.isFinite(startedAtMs)) return 0;

  const remainingMs = startedAtMs - syncedNowMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

/**
 * Gameplay girdisi (tıklama/Enter/claim RPC) şu an KİLİTLİ mi?
 * Geri sayım sürerken kilitlidir — "adil başlangıç" kuralı.
 * Not: bu SADECE UX guard'ıdır; sunucu aynı eşiği bağımsız uygular.
 */
export function isStartLocked(input: {
  room:        QuickMatchStartProbe | null | undefined;
  syncedNowMs: number;
}): boolean {
  return computeStartCountdownSeconds(input) > 0;
}
