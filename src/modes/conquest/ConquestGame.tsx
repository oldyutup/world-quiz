/**
 * ConquestGame — Kuşatma game screen.
 *
 * Phase-4 scope: static game board foundation.
 *   - Displays the selected map's regions with initial ownership.
 *   - Shows a compact player HUD strip with region counts.
 *   - Provides a "Lobiye Dön" escape hatch.
 *   - No turns, questions, or conquest actions yet.
 *
 * This component owns its own full-screen layout (header + strip + board)
 * and is rendered by ConquestMode as a standalone screen when phase="game".
 * The board grid is intentionally CSS-driven so real polygon rendering can
 * replace ConquestBoard without touching the data/state wiring here.
 */

import { useMemo } from "react";
import { playSound } from "../../lib/sound";
import {
  getThemeBackgroundStyle,
  getThemeDataAttr,
  readStoredHomeTheme,
} from "../../lib/themeBackgrounds";
import {
  mapIcon,
  type ConquestPlayer,
  type ConquestRoomSettings,
} from "./types";
import { getConquestMapConfig } from "./maps";
import {
  assignConquestPlayerColors,
  createInitialRegionStates,
  getRegionOwnerCounts,
} from "./conquestState";
import ConquestBoard from "./ConquestBoard";

interface Props {
  /** Room code — kept for future Supabase game-room linking and chat. */
  roomCode:      string;
  settings:      ConquestRoomSettings;
  players:       ConquestPlayer[];
  onBackToLobby: () => void;
}

export default function ConquestGame({
  roomCode: _roomCode,
  settings,
  players,
  onBackToLobby,
}: Props) {
  const homeTheme  = readStoredHomeTheme();
  const themeStyle = getThemeBackgroundStyle(homeTheme);
  const themeAttr  = getThemeDataAttr(homeTheme);

  const mapConfig = useMemo(
    () => getConquestMapConfig(settings.map),
    [settings.map],
  );

  const playerColors = useMemo(
    () => assignConquestPlayerColors(players),
    [players],
  );

  const regionStates = useMemo(
    () => mapConfig ? createInitialRegionStates(mapConfig, players) : [],
    [mapConfig, players],
  );

  const regionCounts = useMemo(
    () => getRegionOwnerCounts(regionStates),
    [regionStates],
  );

  const neutralCount = regionStates.filter(rs => rs.ownerPlayerId === null).length;

  function handleBack() {
    playSound("click");
    onBackToLobby();
  }

  /* Safety fallback — should never be reached with valid settings. */
  if (!mapConfig) {
    return (
      <div className="app duel-screen cq-screen" style={themeStyle} data-theme={themeAttr}>
        <div className="duel-header">
          <button className="back-btn" onClick={handleBack}>
            <span>←</span>
            <span className="back-label">Lobi</span>
          </button>
          <div className="duel-header-center">
            <span className="duel-mode-label">🛡️ Kuşatma</span>
          </div>
          <div style={{ width: 80 }} />
        </div>
        <div className="duel-lobby">
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            Harita yapılandırması bulunamadı.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="app duel-screen cq-screen cq-game-screen"
      style={themeStyle}
      data-theme={themeAttr}
    >
      {/* ── Top header ─────────────────────────────────────────── */}
      <div className="duel-header cq-game-header">
        <button
          className="back-btn"
          onClick={handleBack}
          title="Lobiye Dön"
        >
          <span>←</span>
          <span className="back-label">Lobi</span>
        </button>

        <div className="duel-header-center">
          <span className="duel-mode-label">🛡️ Kuşatma</span>
          <span className="duel-region-badge">
            {mapIcon(settings.map)} {mapConfig.shortName}
          </span>
          <span className="cq-game-round-badge">
            Tur — / {settings.rounds}
          </span>
        </div>

        <div style={{ width: 80 }} />
      </div>

      {/* ── Player summary strip ────────────────────────────────── */}
      <div className="cq-game-players-strip" role="list" aria-label="Oyuncular">
        {players.map(player => (
          <div
            key={player.id}
            className="cq-game-player-chip"
            data-color={playerColors[player.id]}
            role="listitem"
            aria-label={`${player.name} — ${regionCounts[player.id] ?? 0} bölge`}
          >
            <span className="cq-game-player-dot" aria-hidden="true" />
            <span className="cq-game-player-name">{player.name}</span>
            {player.isHost && (
              <span className="cq-game-player-host" aria-label="Ev sahibi">
                👑
              </span>
            )}
            <span className="cq-game-player-regions" aria-hidden="true">
              {regionCounts[player.id] ?? 0}
            </span>
          </div>
        ))}

        {neutralCount > 0 && (
          <div
            className="cq-game-neutral-chip"
            role="listitem"
            aria-label={`${neutralCount} tarafsız bölge`}
          >
            <span aria-hidden="true">⬜</span>
            <span>Tarafsız</span>
            <span className="cq-game-player-regions" aria-hidden="true">
              {neutralCount}
            </span>
          </div>
        )}
      </div>

      {/* ── Board ───────────────────────────────────────────────── */}
      <div className="cq-game-board-wrap">
        <div className="cq-game-board-inner">
          <p className="cq-game-map-title" aria-hidden="true">
            {mapIcon(settings.map)} {mapConfig.displayName}
          </p>
          <ConquestBoard
            mapConfig={mapConfig}
            regionStates={regionStates}
            players={players}
            playerColors={playerColors}
          />
        </div>
      </div>

      {/* ── Placeholder notice + back button ───────────────────── */}
      <div className="cq-game-footer">
        <p className="cq-game-preview-notice" role="status">
          <span aria-hidden="true">🛡️</span>
          <span>Kuşatma hazır — oyun mekaniği yakında gelecek</span>
        </p>
        <button
          type="button"
          className="btn btn-ghost cq-game-back-btn"
          onClick={handleBack}
        >
          ← Lobiye Dön
        </button>
      </div>
    </div>
  );
}
