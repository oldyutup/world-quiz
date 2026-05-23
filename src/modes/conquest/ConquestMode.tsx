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
  type ConquestMapId,
  type ConquestMaxPlayers,
  type ConquestPlayer,
  type ConquestRoomSettings,
  type ConquestRoundCount,
} from "./types";
import {
  createConquestRoom,
  joinConquestRoomByCode,
  leaveConquestRoom,
  markConquestRoomStarted,
  markConquestRoomWaiting,
  normalizeConquestRoomCode,
  updateConquestRoomSettings,
  type ConquestJoinResult,
} from "./conquestService";
import { subscribeToConquestRoom } from "./conquestRealtime";

type Phase = "setup" | "rooms" | "join-code" | "joining" | "lobby" | "game";

interface Props {
  initialPhase: "setup" | "rooms" | "join-code";
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function ConquestMode({ initialPhase, profile, onHome }: Props) {
  const [phase, setPhase] = useState<Phase>(initialPhase);

  // Active room state — populated when phase ∈ { lobby, game }.
  const [roomRow,     setRoomRow]     = useState<ConquestRoomRow | null>(null);
  const [playerRows,  setPlayerRows]  = useState<ConquestPlayerRow[]>([]);
  const [myPlayerId,  setMyPlayerId]  = useState<string | null>(null);
  const [statusMsg,   setStatusMsg]   = useState<string | null>(null);
  const [hostClosed,  setHostClosed]  = useState(false);

  // Refs that mirror state — read inside realtime callbacks where stale
  // closures would otherwise trip us up.
  const myPlayerIdRef = useRef<string | null>(null);
  const phaseRef      = useRef<Phase>(initialPhase);
  useEffect(() => { myPlayerIdRef.current = myPlayerId; }, [myPlayerId]);
  useEffect(() => { phaseRef.current      = phase;      }, [phase]);

  const isLoggedIn = !!profile?.username;

  // ── Derived UI shapes ────────────────────────────────────────────────────
  const settings = useMemo<ConquestRoomSettings>(
    () => roomRow ? roomToSettings(roomRow) : CONQUEST_DEFAULT_SETTINGS,
    [roomRow],
  );

  const uiPlayers = useMemo<ConquestPlayer[]>(
    () => playerRows.map(rowToPlayer),
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
    // Host returning → flip room status to waiting so realtime brings
    // every other client back to the lobby too.
    const updated = await markConquestRoomWaiting(roomRow.id);
    if (updated) setRoomRow(updated);
    setPhase("lobby");
  }, [roomRow, isHost, handleLeaveLobby]);

  const handleStartGame = useCallback(async () => {
    if (!roomRow || !isHost) return;
    const updated = await markConquestRoomStarted(roomRow.id);
    if (updated) {
      setRoomRow(updated);
      setPhase("game");
    }
  }, [roomRow, isHost]);

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
          settings={settings}
          players={uiPlayers}
          isHost={isHost}
          isLoggedIn={isLoggedIn}
          onUpdateSettings={handleUpdateSettings}
          onStart={handleStartGame}
          onLeave={handleLeaveLobby}
        />
      )}

    </div>
  );
}
