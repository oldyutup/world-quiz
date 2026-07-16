/**
 * routeDuelShared.ts — Rota Duel (Online 1v1 Rota Modu) SAF sözleşme katmanı.
 *
 * Yan etkisiz: tipler, seçenek listeleri, sabitler, küçük yardımcılar ve RPC
 * hata çevirisi. Hem RouteDuelGame bileşenleri hem de test scriptleri
 * (scripts/check-route-duel-logic.ts) ağ/env bağımlılığı olmadan import eder.
 *
 * SÖZLEŞME: buradaki değerler 20260802120000_route_duel_init.sql ile BİREBİR
 * aynı olmalıdır (drift = bug):
 *   • total_rounds ∈ {3, 5, 10, 15}
 *   • route_length ∈ {'5', '7', '7plus'} → ara ülke {5} / {7} / {8, 9}
 *   • geri sayım 3 sn, tur süresi 60 sn (sunucu-otoriter; client yalnız gösterir)
 *   • chat anahtarı 'route_duel:<code>' (mod-izole namespaced key)
 */

/* ── DB satır tipleri ── */
export interface RouteDuelRoom {
  id:                     string;
  code:                   string;
  status:                 "waiting" | "playing" | "finished";
  total_rounds:           number;
  route_length:           RouteDuelLength;
  host_player_id:         string | null;
  game_seq:               number;
  current_round:          number;
  round_start_key:        string | null;
  round_target_key:       string | null;
  round_pair_key:         string | null;
  round_started_at:       string | null;
  round_deadline:         string | null;
  round_winner_player_id: string | null;
  round_decided_at:       string | null;
  used_pair_keys:         string[];
  rematch_requested_by:   string[];
  match_seq:              number;
  current_match_id:       string;
  room_source:            "manual" | "quick_match";
  winner_player_id:       string | null;
  finished_reason:        "completed" | "opponent_left" | "disconnect" | string | null;
  started_at:             string | null;
  finished_at:            string | null;
  created_at:             string;
  updated_at:             string;
}

export interface RouteDuelPlayer {
  id:           string;
  room_id:      string;
  name:         string;
  is_host:      boolean;
  score:        number;
  current_key:  string | null;
  path:         string[];
  profile_id?:  string | null;
  guest_id?:    string | null;
  joined_at:    string;
  last_seen_at: string;
}

export interface RouteDuelClaim {
  id:         number;
  room_id:    string;
  player_id:  string;
  game_seq:   number;
  round:      number;
  steps:      number;
  created_at: string;
}

/* ── Oda ayarları (migration check'leriyle birebir) ── */
export type RouteDuelLength = "5" | "7" | "7plus";

export const ROUTE_DUEL_ROUND_OPTIONS: { label: string; value: number }[] = [
  { label: "3 Tur",  value: 3 },
  { label: "5 Tur",  value: 5 },
  { label: "10 Tur", value: 10 },
  { label: "15 Tur", value: 15 },
];

export const ROUTE_DUEL_LENGTH_OPTIONS: { label: string; value: RouteDuelLength }[] = [
  { label: "5 ara ülke",  value: "5" },
  { label: "7 ara ülke",  value: "7" },
  { label: "7+ ara ülke", value: "7plus" },
];

/** Oda ayarı → izinli ara-ülke sayıları. '7plus' GİZLİ olarak 8 veya 9'dur
 *  (kullanıcıya yalnız "7+ ara ülke" yazılır; 10+ asla, 7'ye düşülmez). */
export function intermediatesForLength(len: RouteDuelLength): number[] {
  switch (len) {
    case "5":     return [5];
    case "7":     return [7];
    case "7plus": return [8, 9];
  }
}

export function routeLengthLabel(len: string): string {
  return ROUTE_DUEL_LENGTH_OPTIONS.find(o => o.value === len)?.label ?? len;
}

export function roundsLabel(rounds: number): string {
  return ROUTE_DUEL_ROUND_OPTIONS.find(o => o.value === rounds)?.label ?? `${rounds} Tur`;
}

/* ── Zamanlama sabitleri (sunucu-otoriter değerlerin AYNASI; otorite DB) ── */
export const ROUTE_DUEL_COUNTDOWN_SECONDS = 3;
export const ROUTE_DUEL_ROUND_SECONDS = 60;

/* ── Sırasız çift anahtarı — SQL'deki least|greatest ile birebir ── */
export function routePairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/* ── Chat: mod-izole namespaced anahtar (flag_group modeli) ── */
export function routeDuelChatKey(roomCode: string): string {
  return `route_duel:${roomCode}`;
}

/* ── Oda kodu: 'R' + 5 karakter (W=Çark, M=Çark Grup deseni) — chat ve
 *    resolver çakışma yüzeyini küçültür; benzersizlik yine DB UNIQUE'te. ── */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateRouteDuelRoomCode(): string {
  let out = "R";
  for (let i = 0; i < 5; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

/* ── Tur/maç durumu türetme (client gösterimi + test edilebilir saf mantık;
 *    OTORİTE her zaman sunucu — bunlar yalnız aynayı çizer) ── */

/** Uzatma (sudden-death) turu mu? */
export function isOvertimeRound(currentRound: number, totalRounds: number): boolean {
  return currentRound > totalRounds;
}

/**
 * advance_round SQL kuralının aynası: son tur (veya uzatma turu) sonunda
 * skorlar FARKLI ise maç biter; eşitse yeni (uzatma) turu gelir.
 */
export function matchOutcomeAfterRound(
  currentRound: number,
  totalRounds: number,
  scoreA: number,
  scoreB: number,
): "finalize" | "continue" {
  if (currentRound >= totalRounds && scoreA !== scoreB) return "finalize";
  return "continue";
}

/* ── RPC hata çevirisi (describeWheelDuelRpcError deseni) ── */
export function describeRouteDuelRpcError(
  error: { code?: string; message?: string } | null | undefined,
): string | null {
  if (!error) return null;
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("code_taken"))         return "Bu oda kodu az önce kullanıldı. Tekrar dene.";
  // 'registered_username_taken' kontrolü 'name_taken'den ÖNCE (substring).
  if (msg.includes("registered_username_taken"))
                                          return "Bu nick zaten kayıtlı. Giriş yap ya da farklı bir nick dene.";
  if (msg.includes("display_name_forbidden"))
                                          return "Bu nick kullanılamaz. Lütfen farklı bir nick dene.";
  if (msg.includes("name_taken"))         return "Bu odada bu isim zaten kullanılıyor.";
  if (msg.includes("name_invalid"))       return "Oyuncu adı 2–16 karakter olmalı.";
  if (msg.includes("already_in_room"))    return "Zaten bu odadasın (aynı hesapla ikinci kez katılamazsın).";
  if (msg.includes("room_full"))          return "Oda dolu (2 oyuncu mevcut).";
  if (msg.includes("room_finished"))      return "Bu oda kapanmış.";
  if (msg.includes("room_in_progress"))   return "Maç zaten başlamış. Katılamazsın.";
  if (msg.includes("room_unavailable"))   return "Oda şu an müsait değil.";
  if (msg.includes("room_not_found"))     return "Oda bulunamadı. Kodu kontrol et.";
  if (msg.includes("room_not_waiting"))   return "Oda artık lobby fazında değil.";
  if (msg.includes("room_not_playing"))   return "Oyun durumu değişti.";
  if (msg.includes("room_not_finished"))  return "Maç henüz bitmedi.";
  if (msg.includes("round_not_over"))     return "Tur henüz bitmedi.";
  if (msg.includes("not_enough_players")) return "Başlamak için 2 oyuncu lazım.";
  if (msg.includes("not_enough_votes"))   return "Yeterli oy yok.";
  if (msg.includes("profile_mismatch"))   return "Kimlik uyuşmazlığı. Lütfen yeniden gir.";
  if (msg.includes("guest_id_required"))  return "Misafir kimliği eksik.";
  if (msg.includes("claim_token_required"))
    return "Oturum bilgin eksik. Sayfayı yenileyip tekrar dene.";
  if (msg.includes("player_room_mismatch"))
    return "Bu odanın oyuncusu değilsin.";
  if (msg.includes("unauthorized"))
    return "Bu işlem için yetkin yok. Oturumun bayatlamış olabilir.";
  if (msg.includes("total_rounds_invalid")) return "Geçersiz tur sayısı.";
  if (msg.includes("route_length_invalid")) return "Geçersiz rota uzunluğu.";
  if (msg.includes("route_pool_empty"))     return "Rota havuzu hazır değil. Yöneticiyle iletişime geç.";
  if (msg.includes("code_required"))        return "Oda kodu gerekli.";
  if (msg.includes("player_id_required"))   return "Oyuncu kimliği eksik.";
  if (!error.code) return null;
  if (error.code === "42P01")
    return "Veritabanı tabloları hazır değil. Yöneticiyle iletişime geç.";
  if (error.code === "42501") return "Veritabanı izin hatası. RLS politikalarını kontrol et.";
  // PGRST202: RPC şemada yok → migration deploy edilmemiş.
  if (error.code === "PGRST202") return "Sunucu güncel değil (migration bekleniyor).";
  return null;
}
