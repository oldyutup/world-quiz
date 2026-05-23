/**
 * Conquest (Kuşatma) — Supabase realtime subscriptions.
 *
 * One channel per active room: filtered by room id so we never receive events
 * for other lobbies.  The public room list does not use realtime (a manual
 * refresh + on-mount fetch keeps the cost low at scale; thousands of small
 * rooms × global listener would be wasteful).
 *
 * Lifecycle: callers store the returned RealtimeChannel and call
 * `supabase.removeChannel(channel)` on unmount.
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  supabase,
  type ConquestPlayerRow,
  type ConquestRoomRow,
} from "../../lib/supabase";

export interface ConquestRoomSubscriptionHandlers {
  /** Fired on conquest_rooms UPDATE (settings, status, etc.). */
  onRoomUpdate?:  (room: ConquestRoomRow) => void;
  /** Fired when the room row itself is deleted (rare — usually host close). */
  onRoomDelete?:  () => void;
  /**
   * Fired on ANY conquest_players change (INSERT/UPDATE/DELETE) for this room.
   * Receives the latest full player list — the subscription helper does the
   * re-fetch so the caller has authoritative ordering.
   */
  onPlayersChange?: (players: ConquestPlayerRow[]) => void;
}

/**
 * Subscribe to a single room's row + its player list.
 * Returns a Supabase RealtimeChannel for cleanup.
 */
export function subscribeToConquestRoom(
  roomId:   string,
  handlers: ConquestRoomSubscriptionHandlers,
): RealtimeChannel {
  const channel = supabase
    .channel(`conquest:${roomId}`)
    // Room row updates
    .on(
      "postgres_changes",
      {
        event:  "UPDATE",
        schema: "public",
        table:  "conquest_rooms",
        filter: `id=eq.${roomId}`,
      },
      payload => {
        if (handlers.onRoomUpdate && payload.new) {
          handlers.onRoomUpdate(payload.new as ConquestRoomRow);
        }
      },
    )
    // Room deletion (rare — closeRoom typically updates status instead)
    .on(
      "postgres_changes",
      {
        event:  "DELETE",
        schema: "public",
        table:  "conquest_rooms",
        filter: `id=eq.${roomId}`,
      },
      () => {
        handlers.onRoomDelete?.();
      },
    )
    // Any player change → refetch full list so ordering & counts stay
    // authoritative.  Cheap because conquest rooms cap at 4 players.
    .on(
      "postgres_changes",
      {
        event:  "*",
        schema: "public",
        table:  "conquest_players",
        filter: `room_id=eq.${roomId}`,
      },
      () => {
        if (!handlers.onPlayersChange) return;
        supabase
          .from("conquest_players")
          .select("*")
          .eq("room_id", roomId)
          .order("joined_at", { ascending: true })
          .then(({ data }) => {
            handlers.onPlayersChange!((data ?? []) as ConquestPlayerRow[]);
          });
      },
    )
    .subscribe();

  return channel;
}
