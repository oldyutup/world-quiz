/**
 * presence.ts — arkadaş presence'i için tipli RPC sarmalayıcıları.
 *
 * GİZLİLİK: Online verisi istemciye YALNIZ arkadaşlar için gelir. Okuma
 * `friends_presence()` SECURITY DEFINER RPC'sinden geçer; arkadaşlık + block
 * server'da zorlanır (bkz. 20260718180000_friend_presence_heartbeat.sql). Global
 * Realtime Presence kanalı KULLANILMAZ (o, tüm online kullanıcıların id'sini her
 * aboneye sızdırırdı).
 *
 * Heartbeat/expiry modeli: aktif istemci periyodik `presence_heartbeat()` çağırır;
 * online = son N saniye içinde heartbeat. Kalıcı flag yok → kapanış/kopma/logout
 * sonrası pencere dolunca otomatik "offline".
 */
import { supabase } from "./supabase";

/** Online kabul penceresi (saniye). Heartbeat aralığından geniş tutulur. */
export const PRESENCE_WINDOW_SECONDS = 90;

/** Kendi varlığımı bildir (arkadaşlar beni online görsün). Hata → sessiz. */
export async function sendPresenceHeartbeat(): Promise<void> {
  const { error } = await supabase.rpc("presence_heartbeat");
  if (error && import.meta.env.DEV) {
    // RPC henüz deploy değilse (PGRST202) ya da geçici hata: presence opsiyonel.
    console.warn("presence_heartbeat failed:", error.message);
  }
}

/**
 * Şu an çevrimiçi olan ARKADAŞLARIMIN id kümesi. Hata/eksik RPC → boş küme
 * (yani herkes gri; asla yanlış yeşil ve asla yabancı verisi).
 */
export async function fetchOnlineFriendIds(
  windowSeconds = PRESENCE_WINDOW_SECONDS
): Promise<Set<string>> {
  const { data, error } = await supabase.rpc("friends_presence", {
    p_window_seconds: windowSeconds,
  });
  if (error || !Array.isArray(data)) {
    if (error && import.meta.env.DEV) console.warn("friends_presence failed:", error.message);
    return new Set();
  }
  return new Set((data as { profile_id: string }[]).map((r) => r.profile_id));
}
