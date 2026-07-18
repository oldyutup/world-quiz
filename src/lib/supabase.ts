import { createClient } from "@supabase/supabase-js";
import { Capacitor } from "@capacitor/core";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  console.error(
    "Supabase env vars missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env"
  );
}

// Native (Capacitor) Google OAuth returns through a custom-scheme deep link
// (com.kavakgames.torble://auth-callback?code=…) that is exchanged manually via
// supabase.auth.exchangeCodeForSession — and that exchange requires the PKCE
// flow. The callback never arrives as a webview page navigation, so URL-based
// session detection is turned off on native.
//
// WEB IS LEFT EXACTLY AS BEFORE: when not running inside the native shell the
// options collapse to { persistSession, autoRefreshToken, detectSessionInUrl }
// with no flowType key — i.e. the historical default flow — so the existing web
// Google full-page redirect / hash handling is byte-for-byte unchanged.
const isNativeApp = (() => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
})();

export const supabase = createClient(url ?? "", key ?? "", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    ...(isNativeApp
      ? { flowType: "pkce" as const, detectSessionInUrl: false }
      : { detectSessionInUrl: true }),
  },
});

/* ── DB row types ── */
export interface DuelRoom {
  id:               string;
  code:             string;
  status:           "waiting" | "waiting_rematch" | "playing" | "finished";
  duration_seconds: number;
  region:           string;
  created_at:       string;

  /** Set when host starts the game — server-authoritative timer reference */
  started_at:       string | null;

  /** Why the game ended */
  finished_reason:     "timeout" | "forfeit" | "disconnect" | null;
  /** Player who quit (only set if finished_reason === "forfeit") */
  forfeited_player_id: string | null;
  /** Winner player_id — set when finishing */
  winner_player_id:    string | null;

  /** Pointer to the new room when a rematch is accepted */
  rematch_room_id:     string | null;

  /** Disconnect grace: the player who closed the tab (cleared when they return) */
  disconnected_player_id: string | null;
  /** Timestamp when the disconnect was recorded — used to compute remaining grace */
  disconnect_at:          string | null;

  /** Host kararı için server-side authoritative kolon. Manuel akışta
   *  duel_create_room caller'ı host yapar; QM akışında country_duel_quick_match
   *  waiter'ı host yapar. Eski satırlarda NULL kalabilir. */
  host_player_id?:     string | null;

  /** Oda nasıl oluşturuldu:
   *   - 'manual'      → createRoom + kod ile katıl + host startGame (lobby)
   *   - 'quick_match' → country_duel_quick_match / flag_duel_quick_match RPC
   *                     (lobby YOK, started_at +3s buffer ile direkt 'playing')
   *  Default 'manual'; mevcut satırlar bu varsayılan ile çalışır. */
  room_source?:           "manual" | "quick_match";
}

export interface DuelPlayer {
  id:           string;
  room_id:      string;
  name:         string;
  score:        number;
  joined_at:    string;
  last_seen_at: string | null;
  /** auth.users.id — logged-in oyuncuda dolu, misafirde null. Avatar/profil
   *  kartı çözümü için (DB kolonu zaten var; select '*' döndürür). */
  profile_id?:  string | null;
}

export interface DuelClaim {
  id:           string;
  room_id:      string;
  player_id:    string;
  country_code: string;
  created_at:   string;
}

export interface DuelMessage {
  id:          string;
  room_code:   string;
  player_name: string;
  message:     string;
  created_at:  string;
}

/* ── Wheel Duel (Online Çark 1v1) ── */
export interface WheelDuelRoom {
  id:                    string;
  code:                  string;
  status:                "waiting" | "playing" | "finished";
  duration_seconds:      number;
  region:                string;
  host_player_id:        string | null;
  started_at:            string | null;
  finished_at:           string | null;
  finished_reason:       string | null;
  winner_player_id:      string | null;
  current_target_topoid: string | null;
  used_target_topoids:   string[];
  /** Pas oyu vermiş oyuncuların UUID listesi (boş ise []). */
  pass_requested_by:     string[];
  /** pass_requested_by hangi hedef için toplandığını işaretler. */
  pass_target_topoid:    string | null;
  /** status='finished' iken rövanş oyu vermiş oyuncuların UUID listesi.
   *  İki oy toplandığında host atomic UPDATE ile room'u 'waiting'e döndürür
   *  ve bu listeyi sıfırlar. */
  rematch_requested_by:  string[];
  /** Bu odada şu ana kadar oynanan maç sayısı. İlk maç = 1, her rövanş
   *  reset'inde +1. Debug ve ileride leaderboard segmentasyonu için. */
  match_seq:             number;
  /** Aktif maçın benzersiz UUID'si. XP RPC'sine `p_room_id` olarak verilir.
   *  Aynı oda satırında rövanş oynandığı için xp_events UNIQUE constraint'ini
   *  ihlal etmemek adına her rövanş reset'inde yeni UUID atanır (host atomik
   *  UPDATE ile yayar, realtime sayesinde iki client da aynı değeri görür). */
  current_match_id:      string;
  /** Oda nasıl oluşturuldu:
   *   - 'manual'      → "Oda Kur" / "Kodla Katıl" (lobby gösterilir, host start atar)
   *   - 'quick_match' → wheel_duel_quick_match RPC (lobby YOK, started_at +3s
   *                     buffer ile direkt 'playing'; client countdown gösterir) */
  room_source:           "manual" | "quick_match";
  created_at:            string;
  updated_at:            string;
}

export interface WheelDuelPlayer {
  id:           string;
  room_id:      string;
  name:         string;
  score:        number;
  joined_at:    string;
  last_seen_at: string;
  /** auth.users.id — logged-in oyuncuda dolu, misafirde null (avatar çözümü). */
  profile_id?:  string | null;
}

/* ── Wheel Group (Çark Çok Oyunculu — 3–10 kişi) ── */
export interface WheelGroupRoom {
  id:                    string;
  code:                  string;
  status:                "waiting" | "playing" | "finished";
  duration_seconds:      number;
  region:                string;
  penalty_enabled:       boolean;
  max_players:           number;
  host_player_id:        string | null;
  started_at:            string | null;
  finished_at:           string | null;
  finished_reason:       string | null;
  current_target_topoid: string | null;
  used_target_topoids:   string[];
  match_seq:             number;
  current_match_id:      string;
  created_at:            string;
  updated_at:            string;
}

export interface WheelGroupPlayer {
  id:           string;
  room_id:      string;
  name:         string;
  score:        number;
  joined_at:    string;
  last_seen_at: string;
  /** auth.users.id — logged-in oyuncuda dolu, misafirde null (avatar çözümü). */
  profile_id?:  string | null;
}

export interface WheelGroupPassVote {
  id:            string;
  room_id:       string;
  target_topoid: string;
  player_id:     string;
  created_at:    string;
}

/* ── Kör Nokta (çok oyunculu oda/lobi — 3–5 kişi, login-only).
 *    DB tarafı eski Tevatür iskeletini reuse eder; tablolar tevatur_*
 *    adlarını korur, o yüzden tipler de Tevatur* kalır. ── */
export interface TevaturRoom {
  id:              string;
  code:            string;
  status:          "waiting" | "playing" | "finished";
  /** Tur sayısı — 5 | 7 | 10 | 15 | 20 */
  round_count:     number;
  /** Legacy: fotoğraf gösterim süresi (sn). UI'dan kaldırıldı, kolonda duruyor. */
  photo_seconds:   number;
  max_players:     number;
  /** Kör Nokta takım modu: köstebek ayarı (host, yalnız 3v3+ etkin). */
  mole_enabled?:   boolean;
  host_player_id:  string | null;
  started_at:      string | null;
  finished_at:     string | null;
  finished_reason: string | null;
  /**
   * Kör Nokta gameplay V1 sync blob'u (20260713120000 migration'ı).
   * Lobi fazında null; start_game RPC'siyle yazılır, tüm faz/rapor/puan
   * akışını taşır. Şekli korNoktaGameTypes.parseKnGameState doğrular.
   */
  game_state?:     unknown | null;
  created_at:      string;
  updated_at:      string;
}

export interface TevaturPlayer {
  id:           string;
  room_id:      string;
  /** Login-only mod her zaman dolu yazar; NULL yalnız hesap silme
   *  anonimleştirmesinden sonra görülür (trg_account_deletion_cleanup). */
  profile_id:   string | null;
  name:         string;
  score:        number;
  /** Kör Nokta takım modu: "blue" | "red" (lobide atanır). */
  team?:        "blue" | "red" | null;
  joined_at:    string;
  last_seen_at: string;
}

/* ── Conquest (Kuşatma) — Phase 5: Supabase-backed rooms & players ── */
export interface ConquestRoomRow {
  id:               string;
  room_code:        string;
  host_profile_id:  string | null;
  host_player_id:   string | null;
  host_name:        string;
  status:           "waiting" | "playing" | "finished" | "closed";
  /** Frontend ConquestMapId — stored as text so new maps don't need migrations. */
  map_id:           string;
  max_players:      number;
  round_count:      number;
  visibility:       "public" | "private";
  created_at:       string;
  updated_at:       string;
  started_at:       string | null;
  finished_at:      string | null;
  /**
   * Phase-8 sync blob.  Carries the full serialized ConquestGameState.
   * Null while the room is in lobby (status='waiting') or when no match
   * has been initialized yet.  See conquestGameSync.ts for the shape.
   */
  gameplay_state:   unknown | null;
  /**
   * 2v2 Takımlı mod — Layer 1.  "individual" (varsayılan) ya da "teams_2v2".
   * Pre-Layer-1 satırlarda yoksa "individual" varsayılır.
   */
  team_mode?:       "individual" | "teams_2v2";
}

export interface ConquestPlayerRow {
  id:           string;
  room_id:      string;
  /** auth.users.id — null for guests. */
  profile_id:   string | null;
  /** Frontend-generated id for guest users — null for logged-in users. */
  guest_id:     string | null;
  name:         string;
  is_host:      boolean;
  /** ConquestPlayerColor string ("red" | "blue" | ...) — null until assigned. */
  color:        string | null;
  joined_at:    string;
  last_seen_at: string;
  /**
   * 2v2 Takımlı mod — oyuncunun takım numarası.
   *   • null  → henüz takım seçmedi (veya bireysel modda)
   *   • 1     → Mavi Takım
   *   • 2     → Kırmızı Takım
   * Pre-Layer-1 satırlarda yoksa null kabul edilir.
   */
  team_id?:     1 | 2 | null;
}