import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  console.error(
    "Supabase env vars missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env"
  );
}

export const supabase = createClient(url ?? "", key ?? "", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
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
}

export interface DuelPlayer {
  id:           string;
  room_id:      string;
  name:         string;
  score:        number;
  joined_at:    string;
  last_seen_at: string | null;
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
}