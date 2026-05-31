/**
 * Conquest (Kuşatma) — lobby-only broadcast channel.
 *
 * Carries ephemeral state that lives only while players are in the waiting
 * room and has no gameplay binding yet:
 *   - bonus distribution mode ("random" | "vote")
 *   - per-player bonus votes (which bonus types each player picked)
 *
 * No Supabase tables back this — it rides on a dedicated Supabase Realtime
 * broadcast channel keyed by room id.  Late joiners request a snapshot; the
 * room host (when present) replies with the current state.  Toggle/mode
 * events fan out to every connected client.
 *
 * Persistence note: when the host disconnects with the lobby otherwise empty,
 * state is lost.  That's intentional for this phase — the votes never make
 * it into a match (gameplay wiring lands later).
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabase";
import type {
  ConquestBonusDistribution,
  ConquestRegionBonusType,
} from "./types";

/** playerId → set of bonus types they have voted for. */
export type ConquestLobbyVotes = Record<string, ConquestRegionBonusType[]>;

export interface ConquestLobbyBroadcastState {
  bonusDistribution: ConquestBonusDistribution;
  votes:             ConquestLobbyVotes;
}

export const EMPTY_LOBBY_BROADCAST_STATE: ConquestLobbyBroadcastState = {
  bonusDistribution: "random",
  votes:             {},
};

interface SnapshotPayload {
  state: ConquestLobbyBroadcastState;
}

interface ModeChangePayload {
  bonusDistribution: ConquestBonusDistribution;
}

interface VoteTogglePayload {
  playerId:  string;
  bonusType: ConquestRegionBonusType;
  /** When true, force-add (vote in). When false, force-remove (vote out).
   *  When undefined, the receiver toggles. */
  add?:      boolean;
}

interface ClearVotesPayload {
  playerId: string;
}

export interface ConquestLobbyBroadcastHandlers {
  /** Called when a snapshot arrives from another client. */
  onSnapshot:    (state: ConquestLobbyBroadcastState) => void;
  /** Called when the host emits a mode change. */
  onModeChange:  (mode:  ConquestBonusDistribution)   => void;
  /** Called when any client emits a vote toggle. */
  onVoteToggle:  (payload: VoteTogglePayload)         => void;
  /** Called when a client clears all their own votes (e.g. mode flip back). */
  onClearVotes:  (playerId: string)                   => void;
  /** Called when another client requests a snapshot — only the host
   *  responds (caller decides), but every client receives the ping so they
   *  could fall back if needed. */
  onRequestSnapshot: () => void;
}

/**
 * Apply a vote toggle to a votes map.  Pure helper exposed for reducers in
 * components — the broadcast layer itself is stateless.
 *
 * Caps the player's vote count at `cap` when the toggle would add a new vote
 * AND the player is already at cap — the toggle is rejected (no-op).
 */
export function applyVoteToggle(
  votes:    ConquestLobbyVotes,
  payload:  VoteTogglePayload,
  cap:      number,
): ConquestLobbyVotes {
  const cur = votes[payload.playerId] ?? [];
  const has = cur.includes(payload.bonusType);
  const shouldAdd = payload.add !== undefined ? payload.add : !has;
  if (shouldAdd && has) return votes;
  if (!shouldAdd && !has) return votes;
  if (shouldAdd && !has && cur.length >= cap) {
    // Reject add-when-full silently.
    return votes;
  }
  const nextList = shouldAdd
    ? [...cur, payload.bonusType]
    : cur.filter(t => t !== payload.bonusType);
  return { ...votes, [payload.playerId]: nextList };
}

/**
 * Drop every vote held by a player.  Used when a player leaves OR when the
 * mode flips back to "random" and we reset.
 */
export function clearPlayerVotes(
  votes:    ConquestLobbyVotes,
  playerId: string,
): ConquestLobbyVotes {
  if (!(playerId in votes)) return votes;
  const next = { ...votes };
  delete next[playerId];
  return next;
}

/** Aggregate vote count per bonus type. */
export function tallyVotes(
  votes: ConquestLobbyVotes,
): Map<ConquestRegionBonusType, number> {
  const out = new Map<ConquestRegionBonusType, number>();
  for (const list of Object.values(votes)) {
    for (const t of list) out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

interface SubscribeArgs {
  roomId:   string;
  isHost:   boolean;
  /** Read latest local snapshot.  Used so the host can respond to a
   *  newcomer's snapshot request without us holding the state. */
  getState: () => ConquestLobbyBroadcastState;
  handlers: ConquestLobbyBroadcastHandlers;
}

/**
 * Returns a handle exposing emit functions and an unsubscribe.  The caller
 * is responsible for calling `unsubscribe()` on unmount.
 */
export interface ConquestLobbyBroadcastHandle {
  emitSnapshot:    (state: ConquestLobbyBroadcastState) => void;
  emitModeChange:  (mode:  ConquestBonusDistribution)   => void;
  emitVoteToggle:  (payload: VoteTogglePayload)         => void;
  emitClearVotes:  (playerId: string)                   => void;
  emitRequestSnapshot: ()                                => void;
  unsubscribe:     () => void;
}

export function subscribeLobbyBroadcast(
  args: SubscribeArgs,
): ConquestLobbyBroadcastHandle {
  const { roomId, isHost, getState, handlers } = args;

  const channel: RealtimeChannel = supabase.channel(
    `conquest-lobby:${roomId}`,
    { config: { broadcast: { self: false } } },
  );

  channel
    .on("broadcast", { event: "snapshot" }, ({ payload }) => {
      const p = payload as SnapshotPayload | undefined;
      if (p?.state) handlers.onSnapshot(p.state);
    })
    .on("broadcast", { event: "mode_change" }, ({ payload }) => {
      const p = payload as ModeChangePayload | undefined;
      if (p) handlers.onModeChange(p.bonusDistribution);
    })
    .on("broadcast", { event: "vote_toggle" }, ({ payload }) => {
      const p = payload as VoteTogglePayload | undefined;
      if (p) handlers.onVoteToggle(p);
    })
    .on("broadcast", { event: "clear_votes" }, ({ payload }) => {
      const p = payload as ClearVotesPayload | undefined;
      if (p) handlers.onClearVotes(p.playerId);
    })
    .on("broadcast", { event: "request_snapshot" }, () => {
      handlers.onRequestSnapshot();
      // Host auto-responds with current snapshot so newcomers stay in sync.
      if (isHost) {
        void channel.send({
          type:    "broadcast",
          event:   "snapshot",
          payload: { state: getState() } satisfies SnapshotPayload,
        });
      }
    })
    .subscribe(status => {
      // Once we're in, ask whoever's listening for the latest snapshot so we
      // don't render against an empty state for our first frames.
      if (status === "SUBSCRIBED" && !isHost) {
        void channel.send({
          type:    "broadcast",
          event:   "request_snapshot",
          payload: {},
        });
      }
    });

  return {
    emitSnapshot: (state) =>
      void channel.send({
        type:    "broadcast",
        event:   "snapshot",
        payload: { state } satisfies SnapshotPayload,
      }),
    emitModeChange: (bonusDistribution) =>
      void channel.send({
        type:    "broadcast",
        event:   "mode_change",
        payload: { bonusDistribution } satisfies ModeChangePayload,
      }),
    emitVoteToggle: (payload) =>
      void channel.send({
        type:    "broadcast",
        event:   "vote_toggle",
        payload,
      }),
    emitClearVotes: (playerId) =>
      void channel.send({
        type:    "broadcast",
        event:   "clear_votes",
        payload: { playerId } satisfies ClearVotesPayload,
      }),
    emitRequestSnapshot: () =>
      void channel.send({
        type:    "broadcast",
        event:   "request_snapshot",
        payload: {},
      }),
    unsubscribe: () => {
      supabase.removeChannel(channel);
    },
  };
}
