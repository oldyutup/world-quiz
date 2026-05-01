import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  console.error(
    "Supabase env vars missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env"
  );
}

export const supabase = createClient(url ?? "", key ?? "");

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
