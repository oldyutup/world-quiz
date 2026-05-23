/**
 * ConquestGame — Kuşatma game screen (Phase 8: Supabase-synced state).
 *
 * As of Phase 8 the gameplay state is no longer local-only.  The single
 * source of truth is `conquest_rooms.gameplay_state` (JSONB), pushed by
 * the writer client and broadcast to every other client through the
 * existing room realtime subscription.
 *
 * Responsibilities split:
 *   ConquestMode      owns the synced ConquestGameState (decoded from the
 *                     room row) and the `onPushGameState` writer.
 *   ConquestGame      is now a *controlled* component — renders the synced
 *                     state and bubbles transitions back via callbacks.
 *
 * Write gating (frontend-enforced; Phase 8 keeps it simple):
 *   • Challenge winner selection         → host only.
 *     Non-hosts see a "Mücadele sonucu bekleniyor." note.
 *   • Region action / skip               → only the player whose id matches
 *     `gameState.round.actionHolderId`.  Other players see a read-only
 *     turn indicator.
 *   • Next round / final result          → anyone may advance once the
 *     round resolves (last-write-wins; idempotent on the writer side).
 *
 * The pure helpers (createInitialConquestGameState, resolveChallengeWithWinner,
 * applyActionToGame, advanceToNextRound, getCurrentLegalTargets,
 * actionHolderHasNoMoves, buildFinalStandings) are reused unchanged — they
 * already operate on an immutable ConquestGameState; we now feed them the
 * synced copy and push the returned next-state to Supabase.
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
  expireChallenge,
  getCurrentLegalTargets,
  submitChallengeAnswer,
} from "./conquestGameplay";
import { inferActionFromRegionClick } from "./conquestActions";
import ConquestBoard from "./ConquestBoard";
import ConquestChallengePanel from "./ConquestChallengePanel";
import ConquestActionPanel from "./ConquestActionPanel";
import TurkeyConquestMap from "./TurkeyConquestMap";

interface Props {
  /** Room code — kept for future Supabase game-room linking and chat. */
  roomCode:        string;
  settings:        ConquestRoomSettings;
  players:         ConquestPlayer[];
  /** Synced gameplay state from conquest_rooms.gameplay_state — null while
   *  the host's initial UPDATE is in flight. */
  gameState:       ConquestGameState | null;
  isHost:          boolean;
  myPlayerId:      string | null;
  /** Persist a new gameplay snapshot to Supabase.  Called by transition
   *  handlers; realtime echo brings the row back to every client. */
  onPushGameState: (next: ConquestGameState) => Promise<void> | void;
  onBackToLobby:   () => void;
}

const ILLEGAL_FLASH_MS = 900;

export default function ConquestGame({
  roomCode: _roomCode,
  settings,
  players,
  gameState,
  isHost,
  myPlayerId,
  onPushGameState,
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

  // Region id currently flashing red after a *local* illegal click.  Stored
  // locally only — illegal clicks are not committed to gameplay_state.
  const [flashRegionId, setFlashRegionId] = useState<ConquestRegionId | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  // Cleanup flash timer on unmount.
  useEffect(() => () => {
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
  }, []);

  // ── Challenge-local state (per-challenge, NOT synced) ────────────────
  // Tracks "have I (this client) already submitted for the current
  // challenge?" and the last local correct/wrong verdict so the panel can
  // disable input and show feedback.  Reset on every new challenge id.
  const challengeId = gameState?.round.challenge.challenge.id ?? null;
  const [answeredChallengeId, setAnsweredChallengeId] = useState<string | null>(null);
  const [localFeedback, setLocalFeedback] = useState<"correct" | "wrong" | null>(null);
  useEffect(() => {
    setAnsweredChallengeId(null);
    setLocalFeedback(null);
  }, [challengeId]);

  // Live countdown — re-renders the panel ~4×/s so the timer bar animates.
  const phaseForTicker  = gameState?.phase ?? null;
  const statusForTicker = gameState?.round.challenge.status ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phaseForTicker !== "challenge")  return;
    if (statusForTicker !== "active")    return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [phaseForTicker, statusForTicker, challengeId]);

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

  /* Gating flags — every interactive control consults one of these.  Kept
   * separate from the render so the rules are visible in one place. */
  const isActionHolder    = !!myPlayerId && !!gameState && gameState.round.actionHolderId === myPlayerId;
  const canActOnRegion    = !!gameState && gameState.phase === "action"    && isActionHolder;

  // ── Handlers ─────────────────────────────────────────────────────────
  function handleBack() {
    playSound("click");
    onBackToLobby();
  }

  const handleSubmitAnswer = useCallback((rawAnswer: string) => {
    if (!gameState || !myPlayerId) return;
    if (gameState.phase !== "challenge") return;
    if (gameState.round.challenge.status !== "active") return;
    if (answeredChallengeId === gameState.round.challenge.challenge.id) return;

    const { ok, winning, state: next } = submitChallengeAnswer(
      gameState, myPlayerId, rawAnswer,
    );
    if (!ok) return;

    // Lock further submissions for this challenge on this client.
    setAnsweredChallengeId(gameState.round.challenge.challenge.id);
    setLocalFeedback(winning ? "correct" : "wrong");
    playSound(winning ? "correct" : "wrong");

    if (winning && next !== gameState) {
      void onPushGameState(next);
    }
  }, [gameState, myPlayerId, answeredChallengeId, onPushGameState]);

  // ── Host-only: drive challenge expiry from the synced endsAt ─────────
  // Only the host pushes the expire write so two clients don't race.  The
  // timeout is computed from `endsAt - Date.now()` so every client agrees
  // on when it fires (host's clock is authoritative).
  useEffect(() => {
    if (!isHost) return;
    if (!gameState) return;
    if (gameState.phase !== "challenge") return;
    if (gameState.round.challenge.status !== "active") return;

    const endsAt = gameState.round.challenge.endsAt;
    const delay  = Math.max(0, endsAt - Date.now());
    const t = window.setTimeout(() => {
      const expired = expireChallenge(gameState);
      if (expired !== gameState) void onPushGameState(expired);
    }, delay);
    return () => window.clearTimeout(t);
  }, [
    isHost,
    gameState,
    challengeId,
    onPushGameState,
  ]);

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

    // Only the action holder can mutate region state.  Non-holders get a
    // local flash so the click feels acknowledged but never commits.
    if (!canActOnRegion) {
      flashIllegal(regionId);
      return;
    }

    const inferredAction = inferActionFromRegionClick(
      mapConfig, gameState.regionStates, holderId, regionId,
    );

    if (!inferredAction) {
      // Illegal target: surface failure to the holder by writing the failure
      // result into lastResult.  Pushing the same gameState shape (only
      // round.lastResult mutated) keeps the wire payload minimal.
      const failResult: ConquestActionResult = {
        ok:       false,
        action:   "capture_neutral",
        playerId: holderId,
        regionId,
        message:  "Bu bölgeye hamle yapılamaz.",
      };
      const next: ConquestGameState = {
        ...gameState,
        round: { ...gameState.round, lastResult: failResult },
      };
      void onPushGameState(next);
      flashIllegal(regionId);
      return;
    }

    const pending: ConquestPendingAction =
      inferredAction === "capture_neutral"
        ? { type: "capture_neutral", playerId: holderId, regionId }
        : { type: "attack_region",   playerId: holderId, regionId };

    const { state: nextState } = applyActionToGame(gameState, mapConfig, pending);
    void onPushGameState(nextState);
    playSound("click");
  }, [gameState, mapConfig, canActOnRegion, flashIllegal, onPushGameState]);

  const handleSkipAction = useCallback(() => {
    if (!gameState || !mapConfig) return;
    if (gameState.phase !== "action") return;
    const holderId = gameState.round.actionHolderId;
    if (!holderId) return;
    if (!canActOnRegion) return;

    const { state: nextState } = applyActionToGame(gameState, mapConfig, {
      type: "skip", playerId: holderId,
    });
    void onPushGameState(nextState);
  }, [gameState, mapConfig, canActOnRegion, onPushGameState]);

  const handleNextRound = useCallback(() => {
    if (!gameState) return;
    playSound("click");
    const next = advanceToNextRound(gameState);
    if (next === gameState) return;
    void onPushGameState(next);
  }, [gameState, onPushGameState]);

  // ── Safety fallbacks ─────────────────────────────────────────────────
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

  // Synced state not yet arrived (first paint between status='playing' and
  // realtime echo of gameplay_state).  Show a thin loading shell.
  if (!gameState) {
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
            Maç senkronize ediliyor…
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

  /* Turn-indicator copy for the read-only side of the action phase.  These
   * strings are rendered in place of the action panel when the local user
   * is not the action holder. */
  const actionTurnLine = (() => {
    if (phase !== "action" || !actionHolder) return null;
    if (isActionHolder) return "Hamle sırası sende.";
    return `Hamle sırası: ${actionHolder.name}`;
  })();

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
            myPlayerId={myPlayerId}
            alreadyAnswered={
              answeredChallengeId === challengeState.challenge.id
            }
            lastLocalFeedback={
              answeredChallengeId === challengeState.challenge.id
                ? localFeedback
                : null
            }
            msRemaining={Math.max(0, challengeState.endsAt - now)}
            onSubmitAnswer={handleSubmitAnswer}
          />
        )}

        {phase === "action" && canActOnRegion && (
          <ConquestActionPanel
            actionHolder={actionHolder}
            holderColor={actionHolder ? (playerColors[actionHolder.id] ?? null) : null}
            noMovesLeft={noMovesLeft}
            lastResult={lastResult}
            onSkip={handleSkipAction}
          />
        )}

        {phase === "action" && !canActOnRegion && (
          <section className="cq-action-panel" aria-label="Hamle paneli">
            <p className="cq-action-line" role="status">
              {actionTurnLine}
            </p>
            <p className="cq-action-hint">
              Hamle tamamlanana kadar bekle.
            </p>
          </section>
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
          <span aria-hidden="true">📡</span>
          <span>Online senkron açık.</span>
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
