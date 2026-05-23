/**
 * Conquest (Kuşatma) — Phase 8 synced-gameplay glue.
 *
 * Thin layer between the pure gameplay helpers (conquestGameplay.ts,
 * conquestActions.ts) and Supabase.  The strategy is intentionally minimal:
 *
 *   • `conquest_rooms.gameplay_state` (JSONB) carries the *entire*
 *     ConquestGameState as a JSON blob.
 *   • The host writes the initial state at game start.
 *   • Any state-changing transition (winner pick, action commit, advance
 *     round) is committed by the relevant client via a single UPDATE.
 *   • All other clients observe the change through the existing room
 *     realtime subscription (conquestRealtime.ts) — no new channel needed.
 *
 * Concurrency:  last-write-wins.  For the Phase-8 placeholder gameplay this
 * is fine because each transition is gated to a single eligible writer
 * (host for winner-pick; action-holder for region clicks; anyone for
 * next-round once we land in round_result).  Stronger locking can be added
 * later if real minigames introduce contested writes.
 *
 * The serialized shape is the same as ConquestGameState; we re-export it
 * under a `Serialized…` alias so the contract is explicit at the boundary
 * and a future migration to a slimmer wire shape can change one type alias
 * without touching call sites.
 */

import { supabase, type ConquestRoomRow } from "../../lib/supabase";
import type { ConquestGameState } from "./types";

/**
 * JSON-serializable shape stored in conquest_rooms.gameplay_state.
 *
 * Identical to ConquestGameState today (all fields are already primitives,
 * plain objects, or arrays).  Wrapped as a dedicated type so the boundary
 * is explicit and a future schema change can be localised here.
 */
export type SerializedConquestGameState = ConquestGameState;

/**
 * Convert an in-memory ConquestGameState to its JSONB-safe form.
 *
 * The structure is already JSON-clean; we deep-clone via JSON round-trip to
 * (a) strip any accidental non-enumerable / function fields a future
 * refactor might add, and (b) detach the live reference so callers can keep
 * mutating local copies without risking pre-write tearing.
 */
export function serializeConquestGameState(
  state: ConquestGameState,
): SerializedConquestGameState {
  return JSON.parse(JSON.stringify(state)) as SerializedConquestGameState;
}

/**
 * Validate + cast a JSONB row value into a ConquestGameState.  Returns null
 * for nullish / structurally-bogus payloads so callers can fall back to a
 * loading state without crashing.
 *
 * We do a *light* shape check (presence of the load-bearing top-level
 * fields) rather than a full schema validation — the writer is our own
 * code, so we trust field semantics; we only guard against an empty row or
 * a partial Supabase response.
 */
export function deserializeConquestGameState(
  raw: unknown,
): ConquestGameState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.phase  !== "string"  ||
    typeof obj.mapId  !== "string"  ||
    !Array.isArray(obj.players)     ||
    !Array.isArray(obj.regionStates)||
    !obj.round
  ) {
    return null;
  }
  return obj as unknown as ConquestGameState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase writers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically transition the room into the playing phase AND seed its
 * gameplay_state.  Called by the host from ConquestMode.handleStartGame.
 *
 * Combining both writes into one UPDATE keeps the realtime echo tight: every
 * client gets a single row update carrying status='playing' + the initial
 * gameplay snapshot, so the "lobby → game screen" transition and the first
 * paint of the synced board happen in lockstep.
 */
export async function initializeConquestGameplayState(
  roomId:       string,
  initialState: ConquestGameState,
): Promise<ConquestRoomRow | null> {
  const { data, error } = await supabase
    .from("conquest_rooms")
    .update({
      status:         "playing",
      started_at:     new Date().toISOString(),
      gameplay_state: serializeConquestGameState(initialState),
    })
    .eq("id", roomId)
    .select("*")
    .single();
  if (error || !data) return null;
  return data as ConquestRoomRow;
}

/**
 * Patch only the gameplay_state column.  Used for every in-game transition
 * (winner picked, action applied, next round, match finished).  Last-write
 * wins; callers must already have confirmed they are the eligible writer
 * (host for winner pick, action holder for region clicks, etc.).
 */
export async function updateConquestGameplayState(
  roomId: string,
  state:  ConquestGameState,
): Promise<ConquestRoomRow | null> {
  const { data, error } = await supabase
    .from("conquest_rooms")
    .update({ gameplay_state: serializeConquestGameState(state) })
    .eq("id", roomId)
    .select("*")
    .single();
  if (error || !data) return null;
  return data as ConquestRoomRow;
}

/**
 * Clear gameplay_state when the host returns the room to waiting (lobby).
 * Keeps the row tidy so the next match starts from a clean slate rather
 * than re-using stale region ownership.
 */
export async function clearConquestGameplayState(
  roomId: string,
): Promise<void> {
  await supabase
    .from("conquest_rooms")
    .update({ gameplay_state: null })
    .eq("id", roomId);
}
