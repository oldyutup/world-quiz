/**
 * Conquest (Kuşatma) — per-player claim-token storage.
 *
 * Phase 9 RLS hardening introduces a private `conquest_player_claims` table
 * that stores a random claim_token for each player row. Logged-in users
 * authenticate via Supabase JWT (auth.uid() = profile_id); guests prove
 * ownership of their row by replaying the claim_token they generated at
 * join time.
 *
 * The token is held in localStorage keyed by player_id so a tab refresh
 * keeps the player authenticated for color/leave/gameplay writes. The
 * token never appears in any SELECT response, realtime broadcast, or URL —
 * the only ways it could leak are (a) the originating tab persisting it
 * here, or (b) the SECURITY DEFINER RPCs re-reading it server-side (they
 * compare in-place, they don't return it). Cross-tab/cross-device guest
 * access is intentionally not supported in this phase.
 */

/* Önek `lib/guestSession.ts`te tanımlıdır: auth-flip uzlaştırması bu
 * anahtarları TARAYARAK Kuşatma slotunu OAuth reload'undan sonra da devredebilsin
 * diye iki modülün aynı öneki görmesi ZORUNLU. Burada ikinci bir literal
 * tutmak = sessiz drift riski. */
import { CONQUEST_CLAIM_KEY_PREFIX as KEY_PREFIX } from "../../lib/guestSession";

export function generateConquestClaim(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for ancient runtimes: combine two Math.random()-derived chunks
  // into a UUID-shaped string. Not cryptographically strong; an acceptable
  // floor given the threat model (guest privilege escalation by a peer who
  // can already see SQL traffic is out of scope).
  const rand = () => Math.random().toString(16).slice(2, 10).padStart(8, "0");
  return `${rand()}-${rand().slice(0, 4)}-4${rand().slice(0, 3)}-a${rand().slice(0, 3)}-${rand()}${rand().slice(0, 4)}`;
}

export function rememberConquestClaim(playerId: string, token: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + playerId, token);
  } catch {
    /* private mode / quota — caller still has it in memory for this tab */
  }
}

export function recallConquestClaim(playerId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + playerId);
  } catch {
    return null;
  }
}

export function forgetConquestClaim(playerId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + playerId);
  } catch {
    /* ignore */
  }
}
