/**
 * roomCodeShared.ts — Oda-kodu MODEL/SÖZLEŞME katmanı (yan-etkisiz, saf TS).
 *
 * Burada YALNIZ ağ/env bağımlılığı OLMAYAN parçalar bulunur: tipler, mod
 * kayıt defteri, normalizasyon ve hata metinleri. `roomCode.ts` bunları
 * re-export eder ve üzerine Supabase RPC çağrısını (resolveRoomCode) ekler.
 *
 * Bu ayrım sayesinde test scripti (scripts/check-room-code-resolver.ts) bu
 * dosyayı tsx altında supabase client'ı (import.meta.env) yüklemeden import
 * edip normalizasyon + sözleşmeyi doğrulayabilir.
 *
 * SÖZLEŞME: bu dosyadaki normalizasyon kuralları ve mod anahtarları,
 * 20260801120000_room_code_resolver.sql'deki sunucu normalizasyonu/mod
 * listesiyle BİREBİR aynı olmalıdır (drift = bug).
 */

/** Çözümlenebilen AKTİF Torble oda-kodlu modlar. Değerler mevcut davet linki
 *  query-param anahtarlarıyla birebir aynıdır (?duel/?flagDuel/?flagGroup/
 *  ?wheelDuel/?duelGroup/?wheelGroup/?conquest/?korNokta). Eshle DAHİL DEĞİL. */
export type RoomCodeModeKey =
  | "duel"
  | "flagDuel"
  | "wheelDuel"
  | "duelGroup"
  | "wheelGroup"
  | "flagGroup"
  | "korNokta"
  | "conquest";

/** Kullanıcıya gösterilecek mod adları (tek doğruluk kaynağı). */
export const ROOM_CODE_MODE_LABELS: Record<RoomCodeModeKey, string> = {
  duel:       "Ülke Yaz 1v1",
  flagDuel:   "Bayrak 1v1",
  wheelDuel:  "Çark 1v1",
  duelGroup:  "Ülke Yaz Grup",
  wheelGroup: "Çark Grup",
  flagGroup:  "Bayrak Bilmece",
  korNokta:   "Kör Nokta",
  conquest:   "Kuşatma",
};

export function isRoomCodeModeKey(v: unknown): v is RoomCodeModeKey {
  return typeof v === "string" && v in ROOM_CODE_MODE_LABELS;
}

export interface RoomCodeMatch {
  mode:  RoomCodeModeKey;
  label: string;
}

/** resolve_torble_room_code sonucunun tiplenmiş hâli. */
export type RoomCodeResolution =
  | { result: "invalid" }
  | { result: "not_found"; code: string }
  | { result: "found"; code: string; match: RoomCodeMatch }
  | { result: "ambiguous"; code: string; matches: RoomCodeMatch[] }
  | { result: "error" };

/** Tüm Torble oda kodları: 6 karakterli A-Z0-9. Client normalizasyonu SUNUCU
 *  normalizasyonunun aynasıdır (trim → yalnız alfanümerik → upper → 6'ya kırp).
 *  Yalnız UX için; asıl kontrol sunucuda. */
export function normalizeRoomCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

/** Girdi anında (RPC'siz) geçerli görünüyor mu? Yalnız buton disable için. */
export function isProbablyValidRoomCode(raw: string): boolean {
  return normalizeRoomCode(raw).length === 6;
}

/** RPC'den gelen ham match nesnesini güvenli RoomCodeMatch'e çevirir. */
export function toMatch(v: unknown): RoomCodeMatch | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  if (!isRoomCodeModeKey(rec.mode)) return null;
  const label =
    typeof rec.label === "string" && rec.label.length > 0
      ? rec.label
      : ROOM_CODE_MODE_LABELS[rec.mode];
  return { mode: rec.mode, label };
}

/** Çözümleme sonucundaki hata durumları için kullanıcı-dostu Türkçe metin.
 *  (found/ambiguous mesaj üretmez; onlar yönlendirme/seçim akışına gider.) */
export function roomCodeErrorMessage(res: RoomCodeResolution): string | null {
  switch (res.result) {
    case "invalid":
      return "Geçersiz oda kodu.";
    case "not_found":
      return "Bu kodla aktif bir oda bulunamadı.";
    case "error":
      return "Bağlantı hatası. Lütfen tekrar dene.";
    default:
      return null;
  }
}
