/**
 * roomCode.ts — MERKEZİ oda-kodu çözümleme (client tarafı).
 *
 * Ana sayfa üst barındaki tek "Oda Kodu" alanı ve mobil "Kod" sheet'i buradan
 * beslenir. Kullanıcının girdiği kod SUNUCUDA çözülür (resolve_torble_room_code
 * RPC, bkz. 20260801120000_room_code_resolver.sql). Saf sözleşme/normalizasyon
 * parçaları roomCodeShared.ts'te (yan-etkisiz, test edilebilir); bu dosya yalnız
 * RPC çağrısını tiplenmiş bir birliğe sarar.
 *
 * Gerçek katılma yetkisi client'ta DEĞİL, her modun kendi join RPC'sindedir.
 * Bu dosya bir güvenlik otoritesi değildir; asıl doğrulama sunucudadır.
 */
import { supabase } from "./supabase";
import {
  normalizeRoomCode,
  isProbablyValidRoomCode,
  toMatch,
  type RoomCodeMatch,
  type RoomCodeResolution,
} from "./roomCodeShared";

// Saf sözleşme/yardımcıları tek import noktasından yeniden dışa aç (mevcut
// tüketiciler "./roomCode"'dan almaya devam edebilsin).
export {
  ROOM_CODE_MODE_LABELS,
  isRoomCodeModeKey,
  normalizeRoomCode,
  isProbablyValidRoomCode,
  roomCodeErrorMessage,
  type RoomCodeModeKey,
  type RoomCodeMatch,
  type RoomCodeResolution,
} from "./roomCodeShared";

/**
 * Oda kodunu SUNUCUDA çözer. Ağ/RPC hatasında `{ result: "error" }` döner
 * (ham Postgres mesajı UI'ya sızmaz). Giriş yapmamış kullanıcı bu RPC'yi
 * çağırmamalıdır (grant yalnız authenticated) — çağırırsa error döner; guest
 * akışı App.tsx'te login-öncesi ele alınır.
 */
export async function resolveRoomCode(raw: string): Promise<RoomCodeResolution> {
  // Hızlı client tarafı geçersizlik: boş/kısa kodu RPC'ye hiç göndermeyiz.
  if (!isProbablyValidRoomCode(raw)) return { result: "invalid" };

  const { data, error } = await supabase.rpc("resolve_torble_room_code", {
    p_code: raw,
  });
  if (error || !data || typeof data !== "object") return { result: "error" };

  const rec = data as Record<string, unknown>;
  const result = rec.result;
  const code = typeof rec.code === "string" ? rec.code : normalizeRoomCode(raw);

  if (result === "invalid") return { result: "invalid" };
  if (result === "not_found") return { result: "not_found", code };
  if (result === "found") {
    const match = toMatch({ mode: rec.mode, label: rec.label });
    if (!match) return { result: "error" };
    return { result: "found", code, match };
  }
  if (result === "ambiguous") {
    const rawMatches = Array.isArray(rec.matches) ? rec.matches : [];
    const matches = rawMatches
      .map(toMatch)
      .filter((m): m is RoomCodeMatch => m !== null);
    if (matches.length === 0) return { result: "not_found", code };
    if (matches.length === 1) return { result: "found", code, match: matches[0] };
    return { result: "ambiguous", code, matches };
  }
  return { result: "error" };
}
