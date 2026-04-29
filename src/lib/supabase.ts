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
  id:         string;
  code:       string;
  status:     "waiting" | "playing" | "finished";
  created_at: string;
}

export interface DuelPlayer {
  id:        string;
  room_id:   string;
  name:      string;
  score:     number;
  joined_at: string;
}

export interface DuelClaim {
  id:           string;
  room_id:      string;
  player_id:    string;
  country_code: string;   // topoId (e.g. "276")
  created_at:   string;
}
