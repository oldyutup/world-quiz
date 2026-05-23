/**
 * ConquestMode — orchestrates the Kuşatma flow.
 *
 *   setup  → ConquestSetup       (room creation form)
 *   rooms  → ConquestRoomList    (browse open public rooms; placeholder list)
 *   lobby  → ConquestLobby       (3-panel waiting room)
 *
 * Phase 2 is intentionally backend-free. Creating a room flips local state
 * to "lobby" with a generated code and a single host slot. No persistence,
 * no real-time, no gameplay handoff.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Profile } from "../../lib/auth";
import { playSound } from "../../lib/sound";
import {
  getThemeBackgroundStyle,
  getThemeDataAttr,
  readStoredHomeTheme,
} from "../../lib/themeBackgrounds";
import ConquestSetup from "./ConquestSetup";
import ConquestLobby from "./ConquestLobby";
import ConquestRoomList from "./ConquestRoomList";
import {
  CONQUEST_DEFAULT_SETTINGS,
  mapLabel,
  type ConquestPlayer,
  type ConquestRoomSettings,
  type ConquestRoomSummary,
} from "./types";
import {
  freshConquestPlayerId,
  generateConquestRoomCode,
} from "./utils";

type Phase = "setup" | "rooms" | "lobby";

interface Props {
  initialPhase: Phase;
  profile:      Profile | null;
  onHome:       () => void;
}

export default function ConquestMode({ initialPhase, profile, onHome }: Props) {
  const [phase,    setPhase]    = useState<Phase>(initialPhase);
  const [roomCode, setRoomCode] = useState<string>("");
  const [settings, setSettings] = useState<ConquestRoomSettings>(CONQUEST_DEFAULT_SETTINGS);
  const [players,  setPlayers]  = useState<ConquestPlayer[]>([]);
  const [hostName, setHostName] = useState<string>("");

  /* If the parent ever swaps initialPhase (e.g. Home → Browse), respect it
   *  as long as the user isn't already inside a live lobby. */
  useEffect(() => {
    if (phase !== "lobby") setPhase(initialPhase);
  }, [initialPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateRoom = useCallback((playerName: string, s: ConquestRoomSettings) => {
    const code = generateConquestRoomCode();
    const me: ConquestPlayer = {
      id: freshConquestPlayerId(),
      name: playerName,
      isHost: true,
      colorIndex: 0,
    };
    setRoomCode(code);
    setSettings(s);
    setPlayers([me]);
    setHostName(playerName);
    setPhase("lobby");
  }, []);

  const handleLeaveLobby = useCallback(() => {
    playSound("click");
    setRoomCode("");
    setPlayers([]);
    setHostName("");
    setSettings(CONQUEST_DEFAULT_SETTINGS);
    setPhase("setup");
  }, []);

  /** Phase 2 stub: gameplay handoff lands in a later phase. */
  const handleStartGame = useCallback(() => {
    /* no-op — gameplay not implemented yet */
  }, []);

  const handleUpdateSettings = useCallback((patch: Partial<ConquestRoomSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      /* Guard: maxPlayers must not drop below current player count. */
      if (patch.maxPlayers !== undefined && patch.maxPlayers < players.length) {
        return prev;
      }
      return next;
    });
    /* When Supabase persistence arrives, issue an UPDATE here:
     *   await supabase
     *     .from("conquest_rooms")
     *     .update(patch)
     *     .eq("code", roomCode);
     */
  }, [players.length]);

  /** Backend-less mock list. Empty for now; intentionally exported as a
   *  hook seam so a future Supabase fetch can plug in here. */
  const mockRooms: ConquestRoomSummary[] = useMemo(() => [], []);

  /* ── Theme background (only for non-game phases, which is all of Phase 2) ── */
  const homeTheme    = readStoredHomeTheme();
  const themeStyle   = getThemeBackgroundStyle(homeTheme);
  const themeAttr    = getThemeDataAttr(homeTheme);
  const isHost       = phase === "lobby" && players.some(p => p.isHost && p.name === hostName);
  const isLoggedIn   = !!profile?.username;

  return (
    <div className="app duel-screen cq-screen" style={themeStyle} data-theme={themeAttr}>
      <div className="duel-header">
        <button
          className="back-btn"
          onClick={() => {
            playSound("click");
            onHome();
          }}
          title="Ana Menü"
        >
          <span>←</span>
          <span className="back-label">Menü</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label">🛡️ Kuşatma</span>
          {phase === "lobby" && roomCode && (
            <>
              <span className="duel-code-badge">#{roomCode}</span>
              <span className="duel-region-badge">{mapLabel(settings.map)}</span>
            </>
          )}
        </div>

        <div style={{ width: 80 }} />
      </div>

      {phase === "setup" && (
        <ConquestSetup
          profile={profile}
          onBack={onHome}
          onCreate={handleCreateRoom}
        />
      )}

      {phase === "rooms" && (
        <ConquestRoomList
          rooms={mockRooms}
          isLoggedIn={isLoggedIn}
          onBack={onHome}
          onCreate={() => setPhase("setup")}
          onJoin={() => {
            /* Phase 2 stub: real join arrives with the backend table.
             *  Intentionally a no-op so the disabled-state path is exercised
             *  but no fake room is fabricated. */
          }}
        />
      )}

      {phase === "lobby" && roomCode && (
        <ConquestLobby
          roomCode={roomCode}
          hostName={hostName}
          settings={settings}
          players={players}
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
