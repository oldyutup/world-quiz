/**
 * ConquestMode — orchestrates the Kuşatma flow against Supabase.
 *
 *   setup      → ConquestSetup        (room creation form)
 *   rooms      → ConquestRoomList     (browse open public rooms)
 *   join-code  → ConquestJoinByCode   (paste 6-char room code)
 *   joining    → loading screen       (auto-join from invite link)
 *   lobby      → ConquestLobby        (3-panel waiting room, realtime)
 *   game       → ConquestGame         (placeholder game screen)
 *
 * Phase 5 wires room state to public.conquest_rooms / public.conquest_players
 * with realtime subscriptions.  Each lobby owns a single Supabase channel
 * filtered by room id — no global fan-out — so the design scales to many
 * small rooms.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "../../lib/auth";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { playSound } from "../../lib/sound";
import {
  getThemeBackgroundStyle,
  getThemeDataAttr,
  readStoredHomeTheme,
} from "../../lib/themeBackgrounds";
import {
  supabase,
  type ConquestPlayerRow,
  type ConquestRoomRow,
} from "../../lib/supabase";
import ConquestSetup from "./ConquestSetup";
import ConquestLobby from "./ConquestLobby";
import ConquestRoomList from "./ConquestRoomList";
import ConquestGame from "./ConquestGame";
import ConquestJoinByCode from "./ConquestJoinByCode";
import {
  CONQUEST_DEFAULT_SETTINGS,
  CONQUEST_MIN_PLAYERS,
  mapLabel,
  type ConquestBonusDistribution,
  type ConquestMapId,
  type ConquestMaxPlayers,
  type ConquestPlayer,
  type ConquestPlayerColor,
  type ConquestRegionBonusType,
  type ConquestRoomSettings,
  type ConquestRoundCount,
  type ConquestTeamId,
  type ConquestTeamMode,
} from "./types";
import {
  EMPTY_LOBBY_BROADCAST_STATE,
  applyVoteToggle,
  clearPlayerVotes,
  subscribeLobbyBroadcast,
  type ConquestLobbyBroadcastHandle,
  type ConquestLobbyBroadcastState,
} from "./conquestLobbyBroadcast";
import { resolveActiveBonusTypesFromVotes, voteBonusCountForPlayers } from "./bonusPool";
import {
  createConquestRoom,
  heartbeatConquestPlayer,
  joinConquestRoomByCode,
  leaveConquestRoom,
  selectConquestTeam,
  setConquestTeamMode,
  shuffleConquestTeams,
  updateConquestPlayerColor,
  updateConquestRoomSettings,
  type ConquestJoinResult,
} from "./conquestService";
import { subscribeToConquestRoom } from "./conquestRealtime";
import { getConquestMapConfig } from "./maps";
import { createInitialConquestGameState } from "./conquestGameplay";
import {
  fetchConquestServerTimeOffset,
  initConquestClockSync,
  isConquestClockSynced,
} from "./conquestClock";
import {
  deserializeConquestGameState,
  initializeConquestGameplayState,
  updateConquestGameplayState,
} from "./conquestGameSync";
import type { ConquestGameState } from "./types";

type Phase = "setup" | "rooms" | "join-code" | "joining" | "lobby" | "game";

interface Props {
  initialPhase: "setup" | "rooms" | "join-code" | "create";
  profile:      Profile | null;
  onHome:       () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → UI mappers
// ─────────────────────────────────────────────────────────────────────────────

function roomToSettings(room: ConquestRoomRow): ConquestRoomSettings {
  return {
    map:        room.map_id as ConquestMapId,
    maxPlayers: room.max_players as ConquestMaxPlayers,
    rounds:     room.round_count as ConquestRoundCount,
    visibility: room.visibility,
    teamMode:   (room.team_mode ?? "individual") as ConquestTeamMode,
  };
}

function rowToPlayer(row: ConquestPlayerRow): ConquestPlayer {
  return {
    id:     row.id,
    name:   row.name,
    profileId: row.profile_id ?? null,
    isHost: row.is_host,
    color:  (row.color ?? undefined) as ConquestPlayerColor | undefined,
    teamId: (row.team_id ?? null) as ConquestTeamId | null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function ConquestMode({ initialPhase, profile, onHome }: Props) {
  const [phase, setPhase] = useState<Phase>(
    initialPhase === "create" ? "joining" : initialPhase,
  );

  // Active room state — populated when phase ∈ { lobby, game }.
  const [roomRow,     setRoomRow]     = useState<ConquestRoomRow | null>(null);
  const [playerRows,  setPlayerRows]  = useState<ConquestPlayerRow[]>([]);
  const [myPlayerId,  setMyPlayerId]  = useState<string | null>(null);
  const [statusMsg,   setStatusMsg]   = useState<string | null>(null);
  const [hostClosed,  setHostClosed]  = useState(false);

  // ── Post-match return-to-lobby flow ────────────────────────────────────
  // Shown when a player still on the finished panel clicks "Lobiye Dön"
  // AFTER the host has already started the next game without them.  The
  // body offers Ana Menüye Dön / Tamam — no auto spectator (V1).
  const [lateReturnModalOpen, setLateReturnModalOpen] = useState(false);
  // Soft banner shown to the new host or remaining players when the host
  // role transfers due to a leave.  Auto-clears after a few seconds.
  const [hostTransferBanner, setHostTransferBanner] = useState<string | null>(null);
  // Inline error surfaced when the host clicks "Yeni Oyunu Başlat" but
  // fewer than CONQUEST_MIN_PLAYERS have returned to lobby.
  const [startBlockedMsg, setStartBlockedMsg] = useState<string | null>(null);
  // 2v2 Takımlı mod — geçici bilgilendirme (örn. "Bu takım dolu.").
  const [teamNotice, setTeamNotice] = useState<string | null>(null);

  // Lobby-only ephemeral state: bonus distribution mode + per-player votes.
  // Synced via Supabase Realtime broadcast (see conquestLobbyBroadcast.ts).
  // Not persisted in any table and intentionally not wired into match start
  // yet — gameplay binding lands in a follow-up.
  const [lobbyExtra, setLobbyExtra] = useState<ConquestLobbyBroadcastState>(EMPTY_LOBBY_BROADCAST_STATE);
  const lobbyExtraRef    = useRef<ConquestLobbyBroadcastState>(lobbyExtra);
  useEffect(() => { lobbyExtraRef.current = lobbyExtra; }, [lobbyExtra]);
  const lobbyChannelRef  = useRef<ConquestLobbyBroadcastHandle | null>(null);

  // Refs that mirror state — read inside realtime callbacks where stale
  // closures would otherwise trip us up.
  const myPlayerIdRef = useRef<string | null>(null);
  const phaseRef      = useRef<Phase>(initialPhase === "create" ? "joining" : initialPhase);
  const roomRowRef    = useRef<ConquestRoomRow | null>(null);
  useEffect(() => { myPlayerIdRef.current = myPlayerId; }, [myPlayerId]);
  useEffect(() => { phaseRef.current      = phase;      }, [phase]);
  useEffect(() => { roomRowRef.current    = roomRow;    }, [roomRow]);

  // ── Per-room ephemeral state reset ──────────────────────────────────────
  // `lobbyExtra` (rematch readyPlayerIds, bonus votes, bonus distribution)
  // lives in component state, so without an explicit reset it would carry
  // over when the same user leaves one room and joins/creates another in
  // the same session. The bug surfaced as: brand-new room with all players
  // tagged "Sonuç ekranında" because a stale readyPlayerIds from the
  // previous room made ConquestLobby think it was in rematch mode.
  const prevRoomIdRef = useRef<string | null>(null);
  useEffect(() => {
    const nextId = roomRow?.id ?? null;
    if (prevRoomIdRef.current !== nextId) {
      prevRoomIdRef.current = nextId;
      setLobbyExtra(EMPTY_LOBBY_BROADCAST_STATE);
    }
  }, [roomRow?.id]);

  const isLoggedIn = !!profile?.username;

  // ── Derived UI shapes ────────────────────────────────────────────────────
  const settings = useMemo<ConquestRoomSettings>(
    () => {
      const base = roomRow ? roomToSettings(roomRow) : CONQUEST_DEFAULT_SETTINGS;
      // Bonus distribution is carried on lobby broadcast state, not on the
      // conquest_rooms row — fold it into settings here so the lobby props
      // can stay a single object.  teamMode is persisted on the row.
      return { ...base, bonusDistribution: lobbyExtra.bonusDistribution };
    },
    [roomRow, lobbyExtra.bonusDistribution],
  );

  // playerId → teamId|null lookup, derived from the live conquest_players rows.
  const teamAssignments = useMemo<Record<string, ConquestTeamId | null>>(
    () => {
      const out: Record<string, ConquestTeamId | null> = {};
      for (const r of playerRows) {
        out[r.id] = (r.team_id ?? null) as ConquestTeamId | null;
      }
      return out;
    },
    [playerRows],
  );

  const uiPlayers = useMemo<ConquestPlayer[]>(
    () => playerRows.map(rowToPlayer),
    [playerRows],
  );

  // playerId → last_seen_at ISO timestamp.  Carried into ConquestGame so the
  // host-only "tek aktif oyuncu kalınca otomatik galibiyet" effect can decide
  // whether a player is fresh (heartbeat within the active window) or stale
  // (no heartbeat past the reconnect tolerance).  Updated by the same realtime
  // stream that drives `playerRows`, so it stays consistent with the live
  // roster without a second fetch.
  const lastSeenByPlayerId = useMemo<Record<string, string>>(
    () => {
      const out: Record<string, string> = {};
      for (const r of playerRows) out[r.id] = r.last_seen_at;
      return out;
    },
    [playerRows],
  );

  const me      = useMemo(
    () => playerRows.find(p => p.id === myPlayerId) ?? null,
    [playerRows, myPlayerId],
  );
  const isHost  = !!me?.is_host;
  const myName  = me?.name ?? "";

  // ── Mount: detect invite link ?conquest=CODE and auto-join ──────────────
  // App.tsx gates routing to this screen on a resolved profile, so by the
  // time we mount with ?conquest= the user is guaranteed to be logged in.
  // The defensive `onHome` fallback exists only for direct deep-link edge
  // cases (e.g. someone forcing the screen via dev tools) — guests should
  // never land here with the manual code-entry screen pre-filled.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code   = params.get("conquest");
    if (!code) return;

    // Always strip the param from the URL so a refresh after leaving the
    // lobby doesn't loop the user back into the join flow.
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("conquest");
    window.history.replaceState({}, "", cleanUrl.toString());

    // Also clear the sessionStorage failsafe App.tsx wrote, so refreshes /
    // re-navigations don't retry the join after a failure.
    try { sessionStorage.removeItem("pending_conquest_invite_code"); }
    catch { /* ignore */ }

    if (profile?.username) {
      void doAutoJoin(code, profile.username);
    } else {
      onHome();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-filled code for the join-code screen — only populated when the user
  // arrives here manually from a "Kod ile katıl" entry point. Invite links
  // skip this state entirely (they auto-join above).
  const [pendingJoinCode, setPendingJoinCode] = useState<string>("");

  // ── Auto-create: when launched from "Oda Kur" menu button ───────────────
  // Fires once on mount; creates a room with defaults so the user lands
  // straight in the lobby without a redundant settings form.
  const didAutoCreate = useRef(false);
  useEffect(() => {
    if (initialPhase !== "create" || didAutoCreate.current) return;
    didAutoCreate.current = true;
    if (!profile?.username) {
      setStatusMsg("Kuşatma odası kurmak için giriş yapmalısın.");
      setPhase("setup");
      return;
    }
    setStatusMsg("Oda kuruluyor…");
    void createConquestRoom(profile, profile.username, CONQUEST_DEFAULT_SETTINGS).then(result => {
      if (!result.ok) {
        setStatusMsg(result.message);
        setPhase("setup");
        return;
      }
      setRoomRow(result.room);
      setPlayerRows([result.me]);
      setMyPlayerId(result.me.id);
      setStatusMsg(null);
      setPhase("lobby");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Realtime subscription bound to the active room ──────────────────────
  useEffect(() => {
    if (!roomRow?.id) return;
    if (phase !== "lobby" && phase !== "game") return;

    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    channel = subscribeToConquestRoom(roomRow.id, {
      onRoomUpdate: (next) => {
        if (cancelled) return;

        // ── New-game detection (rematch path) ─────────────────────────
        // The host writes a fresh gameplay_state every match start, so a
        // change in the inner `startedAt` tells us a new round began —
        // regardless of whether room.status flipped.  Clients in lobby
        // phase who are part of the new players list transition to game;
        // clients on the (frozen) finished panel are handled by
        // ConquestGame's snapshot lock and the late-return modal.
        const prev      = roomRowRef.current;
        const prevState = deserializeConquestGameState(prev?.gameplay_state);
        const nextState = deserializeConquestGameState(next.gameplay_state);
        const myId      = myPlayerIdRef.current;
        const newMatchStarted =
          !!nextState &&
          nextState.phase !== "finished" &&
          (!prevState || prevState.startedAt !== nextState.startedAt);

        // Host transfer detection — surface a one-shot banner so the new
        // host (and everyone else) knows who's in charge now.  Skipped
        // when the host id is unchanged or when the room is being closed.
        if (
          prev &&
          prev.host_player_id !== next.host_player_id &&
          next.host_player_id != null &&
          next.status !== "closed" &&
          next.status !== "finished"
        ) {
          if (myId && next.host_player_id === myId) {
            setHostTransferBanner("Yeni oda yöneticisi sensin.");
          } else {
            setHostTransferBanner(`Host ayrıldı. Yeni oda yöneticisi: ${next.host_name}`);
          }
        }

        setRoomRow(next);

        // Status-driven transitions
        if (
          (next.status === "closed" || next.status === "finished") &&
          next.host_player_id !== myId
        ) {
          // Someone else closed the room — eject locally.
          setHostClosed(true);
          setRoomRow(null);
          setPlayerRows([]);
          setMyPlayerId(null);
          setPhase("setup");
          return;
        }

        // Fresh match started.
        if (newMatchStarted && nextState) {
          const meInNewGame = !!myId && nextState.players.some(p => p.id === myId);
          if (meInNewGame) {
            // I'm part of this round — go to game screen if I was waiting
            // in lobby.  Clients already in game phase (e.g. host who
            // just clicked start) just see their state update.
            if (phaseRef.current === "lobby") setPhase("game");
          } else {
            // I'm NOT included in this round.  If I'm in lobby view,
            // stay there with the start message; if I'm still on the
            // finished panel, ConquestGame's snapshot lock keeps the
            // old standings visible until I click "Lobiye Dön" and hit
            // the late-return modal.
          }
        }
      },
      onRoomDelete: () => {
        if (cancelled) return;
        if (roomRow.host_player_id !== myPlayerIdRef.current) {
          setHostClosed(true);
          setRoomRow(null);
          setPlayerRows([]);
          setMyPlayerId(null);
          setPhase("setup");
        }
      },
      onPlayersChange: (rows) => {
        if (cancelled) return;
        setPlayerRows(rows);

        // Kick detection: if my row is gone while still in lobby, eject.
        const myId = myPlayerIdRef.current;
        if (myId && !rows.some(r => r.id === myId) && phaseRef.current === "lobby") {
          setMyPlayerId(null);
          setRoomRow(null);
          setPlayerRows([]);
          setPhase("setup");
        }
      },
    });

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [roomRow?.id, phase]);

  // ── Server-clock sync ──────────────────────────────────────────────────
  // Kuşatma's per-match timeline (challenge.startedAt/endsAt, gameIntroEndsAt,
  // duel/action timers) is interpreted on every client.  Local Date.now()
  // drift across machines used to land host and guest on different
  // roundIntroMsRemaining values.  initConquestClockSync samples
  // public.get_server_time_ms() so every client converges on the same epoch
  // reference.  Active while the user is in lobby or game; torn down on
  // leave so unrelated screens don't pay the periodic probe cost.
  useEffect(() => {
    if (phase !== "lobby" && phase !== "game") return;
    const handle = initConquestClockSync();
    return () => handle.dispose();
  }, [phase]);

  // ── Lobby-only broadcast channel (bonus mode + votes) ───────────────────
  // Owns its own Supabase channel separate from the postgres_changes one so
  // ephemeral lobby state never touches the DB.  Only active while phase
  // === "lobby"; tears down on game start or leave.
  const isHostRef = useRef(false);
  useEffect(() => { isHostRef.current = !!me?.is_host; }, [me?.is_host]);

  // Active during BOTH lobby and game phases: the post-match
  // "Lobiye Dön" flow needs to broadcast ready-for-next while the
  // sender is technically still in phase==='game' (rendering the
  // finished panel) and the receiver may be in phase==='lobby'.
  useEffect(() => {
    if (!roomRow?.id) return;
    if (phase !== "lobby" && phase !== "game") return;

    const handle = subscribeLobbyBroadcast({
      roomId:   roomRow.id,
      isHost:   !!me?.is_host,
      getState: () => lobbyExtraRef.current,
      handlers: {
        onSnapshot:    (state) => setLobbyExtra(state),
        onModeChange:  (mode)  => setLobbyExtra(prev => ({ ...prev, bonusDistribution: mode })),
        onVoteToggle:  (payload) => {
          // The host enforces the per-player cap so all clients agree on the
          // outcome; non-host clients always apply the toggle as instructed
          // because vote_toggle senders only ever flip their OWN vote.
          setLobbyExtra(prev => ({
            ...prev,
            votes: applyVoteToggle(prev.votes, payload, voteBonusCountForPlayers(playerRows.length || 0) || 99),
          }));
        },
        onClearVotes:  (playerId) => {
          setLobbyExtra(prev => ({ ...prev, votes: clearPlayerVotes(prev.votes, playerId) }));
        },
        onReadyForNext: ({ playerId, ready }) => {
          setLobbyExtra(prev => {
            const has = prev.readyPlayerIds.includes(playerId);
            if (ready && !has) {
              return { ...prev, readyPlayerIds: [...prev.readyPlayerIds, playerId] };
            }
            if (!ready && has) {
              return { ...prev, readyPlayerIds: prev.readyPlayerIds.filter(id => id !== playerId) };
            }
            return prev;
          });
        },
        onClearReady: () => {
          setLobbyExtra(prev => prev.readyPlayerIds.length === 0
            ? prev
            : { ...prev, readyPlayerIds: [] });
        },
        onRequestSnapshot: () => { /* host auto-responds inside the helper */ },
      },
    });
    lobbyChannelRef.current = handle;

    return () => {
      handle.unsubscribe();
      lobbyChannelRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomRow?.id, phase, me?.is_host]);

  // ── Heartbeat: keep conquest_players.last_seen_at fresh ────────────────
  // Lobby: public oda listesi son 60 sn'de heartbeat atan oyuncuları sayar.
  // Game: in-match "tek aktif oyuncu kalınca otomatik galibiyet" mantığı
  // de aynı 60 sn pencereye yaslanıyor — heartbeat olmadığında 60 sn sonra
  // herkes "stale" görünür ve yanlış otomatik finish tetiklenir. 20 sn'lik
  // ping ikisini de güvenli marjla içeride tutar.
  useEffect(() => {
    if (!roomRow?.id || !myPlayerId) return;
    if (phase !== "lobby" && phase !== "game") return;

    void heartbeatConquestPlayer(myPlayerId);
    const interval = window.setInterval(() => {
      void heartbeatConquestPlayer(myPlayerId);
    }, 20_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [roomRow?.id, myPlayerId, phase]);

  // ── Drop votes for any player who has left the room ─────────────────────
  useEffect(() => {
    if (phase !== "lobby") return;
    const alive = new Set(playerRows.map(p => p.id));
    const stale = Object.keys(lobbyExtra.votes).filter(pid => !alive.has(pid));
    if (stale.length === 0) return;
    setLobbyExtra(prev => {
      let next = prev.votes;
      for (const pid of stale) next = clearPlayerVotes(next, pid);
      return { ...prev, votes: next };
    });
    // Host re-broadcasts the cleaned snapshot so everyone agrees.
    if (isHostRef.current && lobbyChannelRef.current) {
      let next = lobbyExtra.votes;
      for (const pid of stale) next = clearPlayerVotes(next, pid);
      lobbyChannelRef.current.emitSnapshot({ ...lobbyExtra, votes: next });
    }
  }, [playerRows, lobbyExtra, phase]);

  // ─────────────────────────────────────────────────────────────────────────
  // Actions
  // ─────────────────────────────────────────────────────────────────────────

  const handleCreateRoom = useCallback(
    async (playerName: string, s: ConquestRoomSettings) => {
      if (!profile) {
        setStatusMsg("Kuşatma odası kurmak için giriş yapmalısın.");
        return;
      }
      setStatusMsg("Oda kuruluyor…");
      setPhase("joining");

      const result = await createConquestRoom(profile, playerName, s);
      if (!result.ok) {
        setStatusMsg(null);
        setPhase("setup");
        // Surface as a transient error via host-closed flag isn't quite right;
        // simplest: lean on browser alert sparingly (matches existing patterns).
        // Reuse setStatusMsg as a soft inline message instead.
        setStatusMsg(result.message);
        return;
      }

      setRoomRow(result.room);
      setPlayerRows([result.me]);
      setMyPlayerId(result.me.id);
      setStatusMsg(null);
      setPhase("lobby");
    },
    [profile],
  );

  const applyJoinResult = useCallback((result: ConquestJoinResult) => {
    if (!result.ok) {
      setStatusMsg(result.message);
      setPhase("setup");
      return;
    }
    setRoomRow(result.room);
    setPlayerRows(result.players);
    setMyPlayerId(result.me.id);
    setStatusMsg(null);
    setPhase("lobby");
  }, []);

  const doAutoJoin = useCallback(
    async (code: string, displayName: string) => {
      setStatusMsg("Odaya bağlanılıyor…");
      setPhase("joining");
      const result = await joinConquestRoomByCode(code, {
        profile,
        name:    displayName,
        source:  "invite",
      });
      applyJoinResult(result);
    },
    [profile, applyJoinResult],
  );

  const handleJoinByCode = useCallback(
    async (code: string, displayName: string) => {
      setStatusMsg("Odaya bağlanılıyor…");
      setPhase("joining");
      const result = await joinConquestRoomByCode(code, {
        profile,
        name:    displayName,
        source:  "code",
      });
      applyJoinResult(result);
    },
    [profile, applyJoinResult],
  );

  const handleJoinFromList = useCallback(
    async (code: string) => {
      if (!profile?.username) return;
      setStatusMsg("Odaya katılınıyor…");
      setPhase("joining");
      const result = await joinConquestRoomByCode(code, {
        profile,
        name:    profile.username,
        source:  "public",
      });
      applyJoinResult(result);
    },
    [profile, applyJoinResult],
  );

  const handleLeaveLobby = useCallback(async () => {
    playSound("click");
    const roomId = roomRow?.id;
    const meId   = myPlayerIdRef.current;
    const wasHost = isHost;

    setRoomRow(null);
    setPlayerRows([]);
    setMyPlayerId(null);
    setStatusMsg(null);
    setPhase("setup");

    if (roomId && meId) {
      await leaveConquestRoom(roomId, meId, wasHost);
    }
  }, [roomRow?.id, isHost]);

  /**
   * Finished-panel "Lobiye Dön" — solo transition.
   *
   * The player stays in the room (no DB delete, no status flip) and just
   * switches their own view to the lobby.  A broadcast tells everyone
   * (host included) that this player is ready to be folded into the next
   * match.  If the host has already started the next game without us,
   * surface the late-return info modal instead.
   */
  const handleReturnToLobby = useCallback(() => {
    if (!myPlayerId) return;
    playSound("click");

    // Check the live gameplay_state, not stale closure state — by the time
    // a slow player taps the button, the host's start may have landed.
    const liveState = deserializeConquestGameState(roomRowRef.current?.gameplay_state);
    const newRoundInFlight =
      !!liveState &&
      liveState.phase !== "finished" &&
      !liveState.players.some(p => p.id === myPlayerId);

    if (newRoundInFlight) {
      setLateReturnModalOpen(true);
      return;
    }

    setLobbyExtra(prev => prev.readyPlayerIds.includes(myPlayerId)
      ? prev
      : { ...prev, readyPlayerIds: [...prev.readyPlayerIds, myPlayerId] });
    lobbyChannelRef.current?.emitReadyForNext(myPlayerId);
    setStartBlockedMsg(null);
    setPhase("lobby");
  }, [myPlayerId]);

  /**
   * Mid-game "Odadan Ayrıl" — leaves the room outright.
   *
   * Used by the in-progress back button and the leave-confirmation modal.
   * Host transfer is handled server-side by conquest_leave_room.
   */
  const handleLeaveRoomFromGame = useCallback(async () => {
    await handleLeaveLobby();
  }, [handleLeaveLobby]);

  const handleStartGame = useCallback(async () => {
    if (!roomRow || !isHost) return;
    const mapConfig = getConquestMapConfig(settings.map);
    if (!mapConfig) return;

    // ── Filter participants to "ready" players only ─────────────────
    // First-start path: nobody is "ready" yet (no prior match), so we
    // fall back to the full player roster — same as before.  Rematch
    // path: only players who clicked "Lobiye Dön" from the finished
    // panel make it in; stragglers on the result screen are skipped.
    // The host gets into readyPlayerIds through their own
    // handleReturnToLobby call, so no silent host-auto-include — that
    // would make the UI roster (which uses the same set) drift from the
    // actual game start filter.
    const ready = new Set(lobbyExtra.readyPlayerIds);
    const isRematch = ready.size > 0;
    const includedPlayers = isRematch
      ? uiPlayers.filter(p => ready.has(p.id))
      : uiPlayers;

    // 2v2 Takımlı mod start gate (Layer 1):
    //   • Kapasite 4 olmalı
    //   • 4 aktif oyuncu olmalı
    //   • 2 Mavi + 2 Kırmızı
    const teamMode = (roomRow.team_mode ?? "individual") as ConquestTeamMode;
    if (teamMode === "teams_2v2") {
      if (roomRow.max_players !== 4) {
        setStartBlockedMsg("2v2 Takımlı mod için oda kapasitesi 4 olmalı.");
        return;
      }
      if (includedPlayers.length !== 4) {
        setStartBlockedMsg("2v2 Takımlı mod için 4 oyuncu gerekli.");
        return;
      }
      const blue = includedPlayers.filter(p => teamAssignments[p.id] === 1).length;
      const red  = includedPlayers.filter(p => teamAssignments[p.id] === 2).length;
      if (blue !== 2 || red !== 2) {
        setStartBlockedMsg("Takımlı mod için takımlar 2'ye 2 olmalı.");
        return;
      }
    } else if (includedPlayers.length < CONQUEST_MIN_PLAYERS) {
      setStartBlockedMsg(
        `Yeni oyun için en az ${CONQUEST_MIN_PLAYERS} aktif oyuncu gerekli.`,
      );
      return;
    }

    setStartBlockedMsg(null);

    // Best-effort: make sure the server-clock offset is fresh before we
    // stamp the initial gameplay state's wall-clock timestamps.  The init
    // effect already started a periodic refresh when the host entered the
    // lobby, so by this point we almost always have a value; the await is
    // a defensive top-up for tabs that just resumed from background.  If
    // the probe fails, we fall through to Date.now() — same as pre-fix for
    // this one tab, with a console.warn surfacing the regression.
    if (!isConquestClockSynced()) {
      await fetchConquestServerTimeOffset();
    }

    const selectedBonusTypes =
      lobbyExtra.bonusDistribution === "vote"
        ? resolveActiveBonusTypesFromVotes(
            lobbyExtra.votes,
            includedPlayers.length,
            Date.now(),
          )
        : undefined;
    const initialState = createInitialConquestGameState(
      mapConfig,
      includedPlayers,
      settings.rounds,
      selectedBonusTypes,
    );

    // Layer 1: takım moduyla başlatılan oyunlarda gameState'e back-compat
    // takım metadatasını yaz.  Gameplay henüz bu alanları kullanmıyor;
    // Layer 2'de saldırı yasağı / skor / kazanan vb. burada okunacak.
    if (teamMode === "teams_2v2") {
      initialState.teamMode = "teams_2v2";
      const assignments: Record<string, ConquestTeamId> = {};
      for (const p of includedPlayers) {
        const tid = teamAssignments[p.id];
        if (tid === 1 || tid === 2) assignments[p.id] = tid;
      }
      initialState.teamAssignments = assignments;
    }

    const updated = await initializeConquestGameplayState(roomRow.id, initialState);
    if (updated) {
      setRoomRow(updated);
      // Clear the local ready set on the host immediately AND broadcast
      // so every client drops the previous match's ready flags before
      // the new finished panel can collect a fresh set.
      setLobbyExtra(prev => prev.readyPlayerIds.length === 0
        ? prev
        : { ...prev, readyPlayerIds: [] });
      lobbyChannelRef.current?.emitClearReady();
      setPhase("game");
    }
  }, [roomRow, isHost, settings.map, settings.rounds, uiPlayers, lobbyExtra, teamAssignments]);

  /**
   * Push a new gameplay snapshot to Supabase.  Centralised here so
   * ConquestGame can stay pure (controlled component); all DB writes flow
   * through this single helper.  Realtime echoes the update back to every
   * client (including the writer) so the UI re-renders from the canonical
   * row, not from optimistic local state.
   */
  const handlePushGameplayState = useCallback(
    async (next: ConquestGameState) => {
      if (!roomRow || !myPlayerId) return;
      await updateConquestGameplayState(roomRow.id, myPlayerId, next);
    },
    [roomRow, myPlayerId],
  );

  // Decoded gameplay state from the synced room row.  Null while the room
  // is still in lobby or while the first state write is in flight.
  const syncedGameState = useMemo<ConquestGameState | null>(
    () => deserializeConquestGameState(roomRow?.gameplay_state),
    [roomRow?.gameplay_state],
  );

  // ── Rematch lobby detection ────────────────────────────────────────────
  // Drives the "Hazır X/Y" counter + per-player "Sonuç ekranında" tags in
  // ConquestLobby. We derive it from the canonical row state rather than
  // from `readyPlayerIds.length > 0`, so a stale ready-set carried in by
  // bug or a transient broadcast cannot accidentally flip a fresh lobby
  // into rematch mode. Reset to false the moment a new gameplay_state is
  // initialized (initializeConquestGameplayState writes a non-finished
  // phase), and re-armed automatically when the next match ends.
  const rematchMode = syncedGameState?.phase === "finished";

  const handleChangeColor = useCallback(
    async (color: ConquestPlayerColor) => {
      if (!roomRow || !myPlayerId) return;
      // Optimistic local update so the picker feels instant; realtime echo
      // confirms (or replaces) it within a frame.
      setPlayerRows(prev =>
        prev.map(r => (r.id === myPlayerId ? { ...r, color } : r)),
      );
      const result = await updateConquestPlayerColor(roomRow.id, myPlayerId, color);
      if (!result.ok) {
        // Roll back optimistic write and surface the reason in the banner.
        const refreshed = await supabase
          .from("conquest_players")
          .select("*")
          .eq("room_id", roomRow.id)
          .order("joined_at", { ascending: true });
        if (refreshed.data) setPlayerRows(refreshed.data as ConquestPlayerRow[]);
        setStatusMsg(result.message);
      }
    },
    [roomRow, myPlayerId],
  );

  const handleChangeBonusDistribution = useCallback(
    (mode: ConquestBonusDistribution) => {
      if (!isHost) return;
      setLobbyExtra(prev => {
        // Flipping back to "random" wipes votes so a future "vote" toggle
        // starts from a clean slate.
        if (mode === "random") {
          return { bonusDistribution: mode, votes: {}, readyPlayerIds: prev.readyPlayerIds };
        }
        return { ...prev, bonusDistribution: mode };
      });
      const handle = lobbyChannelRef.current;
      if (handle) {
        handle.emitModeChange(mode);
        if (mode === "random") {
          // Reset votes everywhere too.
          handle.emitSnapshot({
            bonusDistribution: mode,
            votes: {},
            readyPlayerIds: lobbyExtraRef.current.readyPlayerIds,
          });
        }
      }
    },
    [isHost],
  );

  const handleToggleBonusVote = useCallback(
    (bonusType: ConquestRegionBonusType) => {
      if (!myPlayerId) return;
      const cap = voteBonusCountForPlayers(playerRows.length);
      // Optimistic local apply so the chip feels instant.
      setLobbyExtra(prev => ({
        ...prev,
        votes: applyVoteToggle(prev.votes, { playerId: myPlayerId, bonusType }, cap),
      }));
      lobbyChannelRef.current?.emitVoteToggle({ playerId: myPlayerId, bonusType });
    },
    [myPlayerId, playerRows.length],
  );

  const handleUpdateSettings = useCallback(
    async (patch: Partial<ConquestRoomSettings>) => {
      if (!roomRow || !isHost) return;

      // Guard: maxPlayers cannot drop below current player count.
      if (
        patch.maxPlayers !== undefined &&
        patch.maxPlayers < playerRows.length
      ) {
        return;
      }

      // Kapasite 4 dışına düşerse 2v2 Takımlı modu otomatik bireysele
      // çevir (server-side team_id'leri de temizler).
      const willDropBelow4 =
        patch.maxPlayers !== undefined && patch.maxPlayers !== 4;
      const currentlyTeams = (roomRow.team_mode ?? "individual") === "teams_2v2";

      // Optimistic local update for snappy host UX; realtime UPDATE will
      // confirm.
      const next: ConquestRoomRow = {
        ...roomRow,
        ...(patch.map        !== undefined && { map_id:      patch.map }),
        ...(patch.maxPlayers !== undefined && { max_players: patch.maxPlayers }),
        ...(patch.rounds     !== undefined && { round_count: patch.rounds }),
        ...(patch.visibility !== undefined && { visibility:  patch.visibility }),
        ...(willDropBelow4 && currentlyTeams && { team_mode: "individual" as const }),
      };
      setRoomRow(next);

      await updateConquestRoomSettings(roomRow.id, {
        map:        patch.map,
        maxPlayers: patch.maxPlayers,
        rounds:     patch.rounds,
        visibility: patch.visibility,
      });

      // Kapasite 4 dışına düştü ve halen teams_2v2'ydi → server-side
      // team_mode='individual' set et (RPC team_id'leri temizler).
      if (willDropBelow4 && currentlyTeams && myPlayerId) {
        const result = await setConquestTeamMode(roomRow.id, myPlayerId, "individual");
        if (!result.ok) {
          setTeamNotice(result.message);
        }
      }
    },
    [roomRow, isHost, playerRows.length, myPlayerId],
  );

  // ── 2v2 Takımlı mod handlers ─────────────────────────────────────────────
  const handleChangeTeamMode = useCallback(
    async (mode: ConquestTeamMode) => {
      if (!roomRow || !isHost || !myPlayerId) return;
      if (mode === "teams_2v2" && roomRow.max_players !== 4) {
        setTeamNotice("2v2 Takımlı mod için oda kapasitesi 4 olmalı.");
        return;
      }
      // Optimistic: realtime room update will confirm.
      setRoomRow(prev => prev ? { ...prev, team_mode: mode } : prev);
      const result = await setConquestTeamMode(roomRow.id, myPlayerId, mode);
      if (!result.ok) {
        setTeamNotice(result.message);
        // Rollback: realtime row is authoritative; force a manual reset is
        // not strictly needed because Supabase realtime will echo the actual
        // server state, but we keep the optimistic value for now.
      }
    },
    [roomRow, isHost, myPlayerId],
  );

  const handleSelectTeam = useCallback(
    async (teamId: ConquestTeamId) => {
      if (!roomRow || !myPlayerId) return;
      // Optimistic local update.
      setPlayerRows(prev =>
        prev.map(r => (r.id === myPlayerId ? { ...r, team_id: teamId } : r)),
      );
      const result = await selectConquestTeam(roomRow.id, myPlayerId, teamId);
      if (!result.ok) {
        setTeamNotice(result.message);
        // Roll back from server.
        const refreshed = await supabase
          .from("conquest_players")
          .select("*")
          .eq("room_id", roomRow.id)
          .order("joined_at", { ascending: true });
        if (refreshed.data) setPlayerRows(refreshed.data as ConquestPlayerRow[]);
      }
    },
    [roomRow, myPlayerId],
  );

  const handleShuffleTeams = useCallback(async () => {
    if (!roomRow || !isHost || !myPlayerId) return;
    const result = await shuffleConquestTeams(roomRow.id, myPlayerId);
    if (!result.ok) {
      setTeamNotice(result.message);
      return;
    }
    // Realtime echo will refresh playerRows; also nudge locally so it's
    // instant for the host.
    if (result.players.length > 0) {
      setPlayerRows(result.players);
    }
  }, [roomRow, isHost, myPlayerId]);

  // Auto-clear the host-transfer banner so it doesn't linger forever.
  useEffect(() => {
    if (!hostTransferBanner) return;
    const t = window.setTimeout(() => setHostTransferBanner(null), 6000);
    return () => window.clearTimeout(t);
  }, [hostTransferBanner]);

  // Auto-clear the team-notice banner.
  useEffect(() => {
    if (!teamNotice) return;
    const t = window.setTimeout(() => setTeamNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [teamNotice]);

  // ── Initial phase prop change (e.g. Home → Browse) ──────────────────────
  useEffect(() => {
    if (phase === "lobby" || phase === "game" || phase === "joining") return;
    if (initialPhase === "create") return;
    setPhase(initialPhase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPhase]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const homeTheme  = readStoredHomeTheme();
  const themeStyle = getThemeBackgroundStyle(homeTheme);
  const themeAttr  = getThemeDataAttr(homeTheme);

  // Game screen owns its own full-screen layout.
  if (phase === "game" && roomRow) {
    return (
      <>
        <ConquestGame
          roomCode={roomRow.room_code}
          roomId={roomRow.id}
          settings={settings}
          players={uiPlayers}
          lastSeenByPlayerId={lastSeenByPlayerId}
          gameState={syncedGameState}
          isHost={isHost}
          myPlayerId={myPlayerId}
          profile={profile}
          onPushGameState={handlePushGameplayState}
          onReturnToLobby={handleReturnToLobby}
          onLeaveRoom={handleLeaveRoomFromGame}
        />
        {lateReturnModalOpen && (
          <LateReturnModal
            onHome={() => {
              setLateReturnModalOpen(false);
              void handleLeaveLobby();
              setTimeout(onHome, 0);
            }}
            onDismiss={() => setLateReturnModalOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="app duel-screen cq-screen" style={themeStyle} data-theme={themeAttr}>
      <div className="duel-header">
        <button
          className="back-btn"
          onClick={() => {
            playSound("click");
            // From lobby → leave first; otherwise straight home.
            if (phase === "lobby") {
              void handleLeaveLobby();
              setTimeout(onHome, 0);
            } else {
              onHome();
            }
          }}
          title="Ana Menü"
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label">🛡️ Kuşatma</span>
          {phase === "lobby" && roomRow && (
            <>
              <span className="duel-code-badge">#{roomRow.room_code}</span>
              <span className="duel-region-badge">{mapLabel(settings.map)}</span>
            </>
          )}
        </div>

        <div style={{ width: 80 }} />
      </div>

      {/* Transient notification banner: host-closed event or last action error.
          Shown on setup phase so it sits above the create form. */}
      {phase === "setup" && (hostClosed || statusMsg) && (
        <div className="cq-banner-wrap" role="status">
          <div className="cq-banner">
            <span className="cq-banner-msg">
              {hostClosed ? "🛑 Ev sahibi odayı kapattı." : statusMsg}
            </span>
            <button
              type="button"
              className="cq-banner-close"
              aria-label="Kapat"
              onClick={() => { setHostClosed(false); setStatusMsg(null); }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Host-transfer banner: shown briefly in the lobby after a leave-
          driven promotion so the new admin (and everyone else) knows. */}
      {phase === "lobby" && hostTransferBanner && (
        <div className="cq-banner-wrap" role="status">
          <div className="cq-banner">
            <span className="cq-banner-msg">👑 {hostTransferBanner}</span>
            <button
              type="button"
              className="cq-banner-close"
              aria-label="Kapat"
              onClick={() => setHostTransferBanner(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Start-blocked notice: host clicked "Yeni Oyunu Başlat" but the
          ready-set has fewer than CONQUEST_MIN_PLAYERS active players. */}
      {phase === "lobby" && startBlockedMsg && (
        <div className="cq-banner-wrap" role="status">
          <div className="cq-banner">
            <span className="cq-banner-msg">⚠️ {startBlockedMsg}</span>
            <button
              type="button"
              className="cq-banner-close"
              aria-label="Kapat"
              onClick={() => setStartBlockedMsg(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {phase === "setup" && (
        <ConquestSetup
          profile={profile}
          onBack={onHome}
          onCreate={handleCreateRoom}
        />
      )}

      {phase === "rooms" && (
        <ConquestRoomList
          isLoggedIn={isLoggedIn}
          onBack={onHome}
          onCreate={() => setPhase("setup")}
          onJoin={handleJoinFromList}
        />
      )}

      {phase === "join-code" && (
        <ConquestJoinByCode
          profile={profile}
          initialCode={pendingJoinCode}
          onBack={() => { setPendingJoinCode(""); setPhase("setup"); }}
          onJoin={handleJoinByCode}
        />
      )}

      {phase === "joining" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card cq-setup-card">
            <h2 className="duel-lobby-title">🛡️ Kuşatma</h2>
            <p className="duel-lobby-desc">{statusMsg ?? "Yükleniyor…"}</p>
          </div>
        </div>
      )}

      {phase === "lobby" && roomRow && (
        <ConquestLobby
          roomCode={roomRow.room_code}
          hostName={roomRow.host_name}
          myName={myName}
          myPlayerId={myPlayerId}
          settings={settings}
          players={uiPlayers}
          isHost={isHost}
          isLoggedIn={isLoggedIn}
          bonusVotes={lobbyExtra.votes}
          readyPlayerIds={lobbyExtra.readyPlayerIds}
          rematchMode={rematchMode}
          waitingForHost={!isHost && rematchMode && lobbyExtra.readyPlayerIds.includes(myPlayerId ?? "")}
          onUpdateSettings={handleUpdateSettings}
          onChangeBonusDistribution={handleChangeBonusDistribution}
          onToggleBonusVote={handleToggleBonusVote}
          onChangeColor={handleChangeColor}
          onStart={handleStartGame}
          onLeave={handleLeaveLobby}
          teamAssignments={teamAssignments}
          onChangeTeamMode={handleChangeTeamMode}
          onSelectTeam={handleSelectTeam}
          onShuffleTeams={handleShuffleTeams}
          teamNotice={teamNotice}
          onDismissTeamNotice={() => setTeamNotice(null)}
        />
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LateReturnModal — shown when a player clicks "Lobiye Dön" from the finished
// panel AFTER the host has already started the next game without them.
// No spectator option in V1: the user either leaves to home or dismisses and
// keeps idling on their frozen finished screen.
// ─────────────────────────────────────────────────────────────────────────────

interface LateReturnModalProps {
  onHome:    () => void;
  onDismiss: () => void;
}

function LateReturnModal({ onHome, onDismiss }: LateReturnModalProps) {
  return (
    <div
      className="modal-backdrop cq-confirm-leave-backdrop"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className="modal cq-confirm-leave-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cq-late-return-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="cq-late-return-title" className="cq-confirm-leave-title">
          Yeni oyun başladı
        </h2>
        <p className="cq-confirm-leave-desc">
          Bu lobide yeni oyun başladı. Oyunun bitmesini bekleyebilir veya ana menüye dönebilirsin.
        </p>
        <div className="cq-confirm-leave-actions">
          <button
            type="button"
            className="btn btn-accent cq-confirm-leave-cancel"
            onClick={() => { playSound("click"); onDismiss(); }}
            autoFocus
          >
            Tamam
          </button>
          <button
            type="button"
            className="btn cq-confirm-leave-confirm"
            onClick={() => { playSound("click"); onHome(); }}
          >
            Ana Menüye Dön
          </button>
        </div>
      </div>
    </div>
  );
}
