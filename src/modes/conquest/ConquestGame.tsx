/**
 * ConquestGame — Kuşatma game screen with local gameplay loop.
 *
 * Phase-6 scope:
 *   - Round-based loop: challenge → action → round_result → next/finished
 *   - One implemented challenge: placeholder (manual winner-select)
 *   - Two implemented actions: capture_neutral, attack_region
 *   - defend_region is reserved (no UI exposure yet, helpers exist)
 *   - Skip is always available; auto-offered when no legal map move remains
 *   - Result screen ranks players by region count
 *
 * GAMEPLAY STATE IS LOCAL-ONLY in this phase.  The room.status field
 * (waiting / playing) is still server-synced via conquest_rooms, so every
 * client enters this screen together — but each client then runs its own
 * independent gameplay simulation in memory.  This is surfaced inline via
 * the "Yerel önizleme" notice in the footer so testers don't confuse the
 * local sim with a synced match.  No new Supabase tables introduced.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playSound } from "../../lib/sound";
import {
  getThemeBackgroundStyle,
  getThemeDataAttr,
  readStoredHomeTheme,
} from "../../lib/themeBackgrounds";
import {
  mapIcon,
  type ConquestActionResult,
  type ConquestGameState,
  type ConquestPendingAction,
  type ConquestPlayer,
  type ConquestRegionId,
  type ConquestRoomSettings,
} from "./types";
import { getConquestMapConfig } from "./maps";
import {
  assignConquestPlayerColors,
  getRegionOwnerCounts,
} from "./conquestState";
import {
  actionHolderHasNoMoves,
  advanceToNextRound,
  applyActionToGame,
  buildFinalStandings,
  createInitialConquestGameState,
  getCurrentLegalTargets,
  resolveChallengeWithWinner,
} from "./conquestGameplay";
import { inferActionFromRegionClick } from "./conquestActions";
import ConquestBoard from "./ConquestBoard";
import ConquestChallengePanel from "./ConquestChallengePanel";
import ConquestActionPanel from "./ConquestActionPanel";
import TurkeyConquestMap from "./TurkeyConquestMap";

interface Props {
  /** Room code — kept for future Supabase game-room linking and chat. */
  roomCode:      string;
  settings:      ConquestRoomSettings;
  players:       ConquestPlayer[];
  onBackToLobby: () => void;
}

const ILLEGAL_FLASH_MS = 900;

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

  // ── Local gameplay state ─────────────────────────────────────────────
  // Built once per (mapConfig, players, rounds) tuple.  Re-mounting the
  // screen (e.g. host returns to lobby and restarts) rebuilds it from
  // scratch via the dependency-array reset below.
  const [gameState, setGameState] = useState<ConquestGameState | null>(
    () => mapConfig ? createInitialConquestGameState(mapConfig, players, settings.rounds) : null,
  );

  // Region id currently flashing red after an illegal click.  Cleared by a
  // small timer; tracked in state so the board re-renders to drop the flash.
  const [flashRegionId, setFlashRegionId] = useState<ConquestRegionId | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  /* Reset gameplay state when the underlying inputs change.  Player joins
   * during lobby don't reach this screen — but if the host returns to lobby
   * and starts again, the screen re-mounts with potentially different
   * player order or map.  This keeps gameState in lockstep. */
  useEffect(() => {
    if (!mapConfig) {
      setGameState(null);
      return;
    }
    setGameState(createInitialConquestGameState(mapConfig, players, settings.rounds));
    setFlashRegionId(null);
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  }, [mapConfig, players, settings.rounds]);

  // Cleanup the flash timer on unmount.
  useEffect(() => () => {
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────
  const regionStates = gameState?.regionStates ?? [];
  const regionCounts = useMemo(
    () => getRegionOwnerCounts(regionStates),
    [regionStates],
  );
  const neutralCount = regionStates.filter(rs => rs.ownerPlayerId === null).length;

  const legalTargets = useMemo(
    () => (gameState && mapConfig) ? getCurrentLegalTargets(gameState, mapConfig) : new Set<ConquestRegionId>(),
    [gameState, mapConfig],
  );

  const noMovesLeft = useMemo(
    () => (gameState && mapConfig) ? actionHolderHasNoMoves(gameState, mapConfig) : false,
    [gameState, mapConfig],
  );

  const actionHolder = useMemo(() => {
    if (!gameState?.round.actionHolderId) return null;
    return players.find(p => p.id === gameState.round.actionHolderId) ?? null;
  }, [gameState, players]);

  const standings = useMemo(
    () => gameState ? buildFinalStandings(gameState) : [],
    [gameState],
  );

  // ── Handlers ─────────────────────────────────────────────────────────
  function handleBack() {
    playSound("click");
    onBackToLobby();
  }

  const handleSelectWinner = useCallback((playerId: string) => {
    setGameState(prev => prev ? resolveChallengeWithWinner(prev, playerId) : prev);
  }, []);

  const flashIllegal = useCallback((regionId: ConquestRegionId) => {
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    setFlashRegionId(regionId);
    flashTimerRef.current = window.setTimeout(() => {
      setFlashRegionId(null);
      flashTimerRef.current = null;
    }, ILLEGAL_FLASH_MS);
  }, []);

  const handleRegionClick = useCallback((regionId: ConquestRegionId) => {
    if (!gameState || !mapConfig) return;
    if (gameState.phase !== "action") return;
    const holderId = gameState.round.actionHolderId;
    if (!holderId) return;

    const inferredAction = inferActionFromRegionClick(
      mapConfig, gameState.regionStates, holderId, regionId,
    );

    if (!inferredAction) {
      const failResult: ConquestActionResult = {
        ok:       false,
        action:   "capture_neutral",
        playerId: holderId,
        regionId,
        message:  "Bu bölgeye hamle yapılamaz.",
      };
      setGameState(prev => prev ? {
        ...prev,
        round: { ...prev.round, lastResult: failResult },
      } : prev);
      flashIllegal(regionId);
      return;
    }

    const pending: ConquestPendingAction =
      inferredAction === "capture_neutral"
        ? { type: "capture_neutral", playerId: holderId, regionId }
        : { type: "attack_region",   playerId: holderId, regionId };

    setGameState(prev => {
      if (!prev) return prev;
      const { state } = applyActionToGame(prev, mapConfig, pending);
      return state;
    });
    playSound("click");
  }, [gameState, mapConfig, flashIllegal]);

  const handleSkipAction = useCallback(() => {
    if (!gameState || !mapConfig) return;
    if (gameState.phase !== "action") return;
    const holderId = gameState.round.actionHolderId;
    if (!holderId) return;

    setGameState(prev => {
      if (!prev) return prev;
      const { state } = applyActionToGame(prev, mapConfig, {
        type: "skip", playerId: holderId,
      });
      return state;
    });
  }, [gameState, mapConfig]);

  const handleNextRound = useCallback(() => {
    playSound("click");
    setGameState(prev => prev ? advanceToNextRound(prev) : prev);
  }, []);

  // ── Safety fallback ──────────────────────────────────────────────────
  if (!mapConfig || !gameState) {
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

  const phase          = gameState.phase;
  const roundNumber    = gameState.round.roundNumber;
  const totalRounds    = gameState.round.totalRounds;
  const challengeState = gameState.round.challenge;
  const lastResult     = gameState.round.lastResult;

  const boardDisabled = phase !== "action";
  const lastSuccess   = lastResult?.ok ? lastResult : null;

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
            Tur {roundNumber} / {totalRounds}
          </span>
        </div>

        <div style={{ width: 80 }} />
      </div>

      {/* ── Player summary strip ────────────────────────────────── */}
      <div className="cq-game-players-strip" role="list" aria-label="Oyuncular">
        {players.map(player => {
          const isHolder = phase === "action" && gameState.round.actionHolderId === player.id;
          return (
            <div
              key={player.id}
              className={"cq-game-player-chip" + (isHolder ? " cq-game-player-chip--turn" : "")}
              data-color={playerColors[player.id]}
              role="listitem"
              aria-label={`${player.name} — ${regionCounts[player.id] ?? 0} bölge${isHolder ? " (sırada)" : ""}`}
            >
              <span className="cq-game-player-dot" aria-hidden="true" />
              <span className="cq-game-player-name">{player.name}</span>
              {player.isHost && (
                <span className="cq-game-player-host" aria-label="Ev sahibi">
                  👑
                </span>
              )}
              {isHolder && (
                <span className="cq-game-player-turn-tag" aria-hidden="true">
                  Hamle
                </span>
              )}
              <span className="cq-game-player-regions" aria-hidden="true">
                {regionCounts[player.id] ?? 0}
              </span>
            </div>
          );
        })}

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

          {settings.map === "turkey" ? (
            <>
              {/* SVG map: primary interaction on all screens */}
              <TurkeyConquestMap
                regionStates={regionStates}
                players={players}
                playerColors={playerColors}
                legalTargetIds={legalTargets}
                flashRegionId={flashRegionId}
                disabled={boardDisabled}
                onRegionClick={phase === "action" ? handleRegionClick : undefined}
              />
              {/* Mobile fallback: card grid below map (labels hidden on mobile via CSS) */}
              <div className="cq-map-card-fallback">
                <ConquestBoard
                  mapConfig={mapConfig}
                  regionStates={regionStates}
                  players={players}
                  playerColors={playerColors}
                  onRegionClick={phase === "action" ? handleRegionClick : undefined}
                  legalRegionIds={legalTargets}
                  flashRegionId={flashRegionId}
                  disabled={boardDisabled}
                />
              </div>
            </>
          ) : (
            <ConquestBoard
              mapConfig={mapConfig}
              regionStates={regionStates}
              players={players}
              playerColors={playerColors}
              onRegionClick={phase === "action" ? handleRegionClick : undefined}
              legalRegionIds={legalTargets}
              flashRegionId={flashRegionId}
              disabled={boardDisabled}
            />
          )}
        </div>
      </div>

      {/* ── Phase-driven bottom panel ──────────────────────────── */}
      <div className="cq-game-phase-panel">
        {phase === "challenge" && (
          <ConquestChallengePanel
            challengeState={challengeState}
            players={players}
            playerColors={playerColors}
            onSelectWinner={handleSelectWinner}
          />
        )}

        {phase === "action" && (
          <ConquestActionPanel
            actionHolder={actionHolder}
            holderColor={actionHolder ? (playerColors[actionHolder.id] ?? null) : null}
            noMovesLeft={noMovesLeft}
            lastResult={lastResult}
            onSkip={handleSkipAction}
          />
        )}

        {phase === "round_result" && (
          <section className="cq-round-result-panel" aria-label="Tur sonucu">
            <div className="cq-round-result-line">
              <span className="cq-round-result-icon" aria-hidden="true">
                {lastSuccess?.action === "skip" ? "⏭" : "🛡️"}
              </span>
              <span className="cq-round-result-text">
                {lastResult?.message ?? "Tur tamamlandı."}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-accent cq-round-next-btn"
              onClick={handleNextRound}
            >
              {roundNumber >= totalRounds ? "Sonuçları Gör" : "Sonraki Tur →"}
            </button>
          </section>
        )}

        {phase === "finished" && (
          <section className="cq-finished-panel" aria-label="Maç sonucu">
            <header className="cq-finished-head">
              <span className="cq-finished-icon" aria-hidden="true">🏆</span>
              <h3 className="cq-finished-title">Kuşatma Bitti</h3>
            </header>

            <ol className="cq-standings-list">
              {standings.map(row => (
                <li
                  key={row.playerId}
                  className="cq-standings-row"
                  data-color={playerColors[row.playerId]}
                  data-rank={row.rank}
                >
                  <span className="cq-standings-rank">#{row.rank}</span>
                  <span className="cq-standings-dot" aria-hidden="true" />
                  <span className="cq-standings-name">{row.playerName}</span>
                  <span className="cq-standings-count">
                    {row.regionsHeld} bölge
                  </span>
                </li>
              ))}
            </ol>

            <p className="cq-finished-note" role="status">
              Bu maçta XP veya Altın ödül verilmedi — ödüller ilerleyen
              aşamada eklenecek.
            </p>

            <div className="cq-finished-actions">
              <button
                type="button"
                className="btn btn-accent cq-finished-back-btn"
                onClick={handleBack}
              >
                ← Lobiye Dön
              </button>
            </div>
          </section>
        )}
      </div>

      {/* ── Footer notice ──────────────────────────────────────── */}
      <div className="cq-game-footer">
        <p className="cq-game-preview-notice" role="status">
          <span aria-hidden="true">🧪</span>
          <span>
            Yerel önizleme — gameplay henüz senkronize değil. Her oyuncu kendi
            simülasyonunu görür.
          </span>
        </p>
        {phase !== "finished" && (
          <button
            type="button"
            className="btn btn-ghost cq-game-back-btn"
            onClick={handleBack}
          >
            ← Lobiye Dön
          </button>
        )}
      </div>
    </div>
  );
}
