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
  mapLabel,
  type ConquestBonusDistribution,
  type ConquestMapId,
  type ConquestMaxPlayers,
  type ConquestPlayer,
  type ConquestPlayerColor,
  type ConquestRegionBonusType,
  type ConquestRoomSettings,
  type ConquestRoundCount,
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
  markConquestRoomWaiting,
  normalizeConquestRoomCode,
  updateConquestPlayerColor,
  updateConquestRoomSettings,
  type ConquestJoinResult,
} from "./conquestService";
import { subscribeToConquestRoom } from "./conquestRealtime";
import { getConquestMapConfig } from "./maps";
import { createInitialConquestGameState } from "./conquestGameplay";
import {
  clearConquestGameplayState,
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
  };
}

function rowToPlayer(row: ConquestPlayerRow): ConquestPlayer {
  return {
    id:     row.id,
    name:   row.name,
    isHost: row.is_host,
    color:  (row.color ?? undefined) as ConquestPlayerColor | undefined,
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
  useEffect(() => { myPlayerIdRef.current = myPlayerId; }, [myPlayerId]);
  useEffect(() => { phaseRef.current      = phase;      }, [phase]);

  const isLoggedIn = !!profile?.username;

  // ── Derived UI shapes ────────────────────────────────────────────────────
  const settings = useMemo<ConquestRoomSettings>(
    () => {
      const base = roomRow ? roomToSettings(roomRow) : CONQUEST_DEFAULT_SETTINGS;
      // Bonus distribution is carried on lobby broadcast state, not on the
      // conquest_rooms row — fold it into settings here so the lobby props
      // can stay a single object.
      return { ...base, bonusDistribution: lobbyExtra.bonusDistribution };
    },
    [roomRow, lobbyExtra.bonusDistribution],
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

    // Login-state-aware behaviour:
    //   - Logged in    → auto-join with profile name.
    //   - Guest        → land on join-code screen with code pre-filled so
    //                    they can enter a display name first.
    if (profile?.username) {
      void doAutoJoin(code, profile.username);
    } else {
      setPhase("join-code");
      // Stash the code for ConquestJoinByCode to read via prop.
      setPendingJoinCode(normalizeConquestRoomCode(code));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-filled code for the join-code screen (from invite link redirects).
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
        setRoomRow(next);

        // Status-driven transitions
        if (next.status === "playing" && phaseRef.current === "lobby") {
          setPhase("game");
        } else if (next.status === "waiting" && phaseRef.current === "game") {
          // Host returned to lobby
          setPhase("lobby");
        } else if (
          (next.status === "closed" || next.status === "finished") &&
          next.host_player_id !== myPlayerIdRef.current
        ) {
          // Someone else closed the room — eject locally.
          setHostClosed(true);
          setRoomRow(null);
          setPlayerRows([]);
          setMyPlayerId(null);
          setPhase("setup");
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

  // ── Lobby-only broadcast channel (bonus mode + votes) ───────────────────
  // Owns its own Supabase channel separate from the postgres_changes one so
  // ephemeral lobby state never touches the DB.  Only active while phase
  // === "lobby"; tears down on game start or leave.
  const isHostRef = useRef(false);
  useEffect(() => { isHostRef.current = !!me?.is_host; }, [me?.is_host]);

  useEffect(() => {
    if (!roomRow?.id || phase !== "lobby") return;

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

  const handleBackToLobbyFromGame = useCallback(async () => {
    if (!roomRow || !isHost) {
      // Non-host can't pull the room back to waiting; treat as leave.
      await handleLeaveLobby();
      return;
    }
    // Host returning → flip room status to waiting AND wipe gameplay_state
    // so the next start begins from scratch.  Realtime UPDATE brings every
    // other client back to the lobby too.
    const updated = await markConquestRoomWaiting(roomRow.id);
    if (updated) setRoomRow(updated);
    await clearConquestGameplayState(roomRow.id);
    setPhase("lobby");
  }, [roomRow, isHost, handleLeaveLobby]);

  const handleStartGame = useCallback(async () => {
    if (!roomRow || !isHost) return;
    const mapConfig = getConquestMapConfig(settings.map);
    if (!mapConfig) return;
    // Vote-mode bonus selection: resolve top-N voted open bonuses (with
    // deterministic tie-break + fallback) here on the host so the resulting
    // list goes into the canonical initial state every client deserialises.
    // Random mode leaves `selectedBonusTypes` undefined so the round-bonus
    // builder keeps its legacy seeded random pick.
    const selectedBonusTypes =
      lobbyExtra.bonusDistribution === "vote"
        ? resolveActiveBonusTypesFromVotes(
            lobbyExtra.votes,
            uiPlayers.length,
            Date.now(),
          )
        : undefined;
    // Seed the initial synced state from the current player roster so every
    // client sees the same starting board / round-1 challenge.
    const initialState = createInitialConquestGameState(
      mapConfig,
      uiPlayers,
      settings.rounds,
      selectedBonusTypes,
    );
    const updated = await initializeConquestGameplayState(roomRow.id, initialState);
    if (updated) {
      setRoomRow(updated);
      setPhase("game");
    }
  }, [roomRow, isHost, settings.map, settings.rounds, uiPlayers, lobbyExtra]);

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
        if (mode === "random") return { bonusDistribution: mode, votes: {} };
        return { ...prev, bonusDistribution: mode };
      });
      const handle = lobbyChannelRef.current;
      if (handle) {
        handle.emitModeChange(mode);
        if (mode === "random") {
          // Reset votes everywhere too.
          handle.emitSnapshot({ bonusDistribution: mode, votes: {} });
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

      // Optimistic local update for snappy host UX; realtime UPDATE will
      // confirm.  If the DB rejects, the realtime row replaces our optimistic
      // copy on the next event (or we'd roll back here, but Phase 5 keeps it
      // simple since the only constraint comes from us).
      const next: ConquestRoomRow = {
        ...roomRow,
        ...(patch.map        !== undefined && { map_id:      patch.map }),
        ...(patch.maxPlayers !== undefined && { max_players: patch.maxPlayers }),
        ...(patch.rounds     !== undefined && { round_count: patch.rounds }),
        ...(patch.visibility !== undefined && { visibility:  patch.visibility }),
      };
      setRoomRow(next);

      await updateConquestRoomSettings(roomRow.id, {
        map:        patch.map,
        maxPlayers: patch.maxPlayers,
        rounds:     patch.rounds,
        visibility: patch.visibility,
      });
    },
    [roomRow, isHost, playerRows.length],
  );

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
      <ConquestGame
        roomCode={roomRow.room_code}
        settings={settings}
        players={uiPlayers}
        lastSeenByPlayerId={lastSeenByPlayerId}
        gameState={syncedGameState}
        isHost={isHost}
        myPlayerId={myPlayerId}
        onPushGameState={handlePushGameplayState}
        onBackToLobby={handleBackToLobbyFromGame}
      />
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
          onUpdateSettings={handleUpdateSettings}
          onChangeBonusDistribution={handleChangeBonusDistribution}
          onToggleBonusVote={handleToggleBonusVote}
          onChangeColor={handleChangeColor}
          onStart={handleStartGame}
          onLeave={handleLeaveLobby}
        />
      )}

    </div>
  );
}
