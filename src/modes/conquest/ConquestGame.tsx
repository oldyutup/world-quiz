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
  projectRegionStatesForViewer,
} from "./conquestState";
import { getPlayerTotalPoints, getNeutralRegionPoints } from "./regionPoints";
import {
  REGION_BONUSES,
  buildHiddenOpPlacedDetail,
  getBonusToastCopyForViewer,
  getPlayerBonusState,
  HIDDEN_OP_PLACED_MESSAGE_PREFIX,
  HIDDEN_OP_PLACED_TITLE,
} from "./regionBonuses";
import {
  actionHolderHasNoMoves,
  advanceToNextRound,
  applyActionToGame,
  buildFinalStandings,
  expireActionPhase,
  expireChallenge,
  expireDuel,
  getCurrentLegalTargets,
  getPlayerOwningAllRegions,
  placeHiddenConquestOnNeutralRegion,
  placeHiddenShieldOnOwnRegion,
  submitChallengeAnswer,
  submitDuelAnswer,
} from "./conquestGameplay";
import { inferActionFromRegionClick } from "./conquestActions";
import ConquestBoard from "./ConquestBoard";
import ConquestChallengePanel from "./ConquestChallengePanel";
import ConquestActionPanel from "./ConquestActionPanel";
import DefenseDuelPanel from "./DefenseDuelPanel";
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

const ILLEGAL_FLASH_MS  = 900;
const AUTO_ADVANCE_MS   = 2_500;
const DUEL_RESULT_TOAST_MS = 4000;
/** Center banner shown to ALL clients when a player consumes Ankara's
 *  Gizli Operasyon hakkı.  Must be fully read before the next challenge
 *  panel appears — keep in sync with HIDDEN_OP_AUTO_ADVANCE_MS. */
const HIDDEN_OP_TOAST_MS = 7000;
/** Host auto-advance delay used instead of AUTO_ADVANCE_MS when the
 *  round_result was caused by a Gizli Operasyon placement.  Slightly
 *  longer than HIDDEN_OP_TOAST_MS so the toast clears before the next
 *  challenge (and its timer) starts. */
const HIDDEN_OP_AUTO_ADVANCE_MS = 7500;

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

  // Stable refs so timeout callbacks always see the latest values without
  // needing to be in the dependency arrays (avoids restarting timers on every
  // gameState reference change).
  const gameStateRef    = useRef<ConquestGameState | null>(null);
  const onPushStateRef  = useRef(onPushGameState);
  useEffect(() => { gameStateRef.current   = gameState;       }, [gameState]);
  useEffect(() => { onPushStateRef.current = onPushGameState; }, [onPushGameState]);

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

  // ── Duel-local state (per-duel, NOT synced) ──────────────────────────
  // Mirrors the challenge-local "already answered" flag: a wrong submission
  // disables further input on this client without touching synced state.
  const duelId = gameState?.defenseDuel?.id ?? null;
  const [answeredDuelId, setAnsweredDuelId] = useState<string | null>(null);
  const [duelLocalFeedback, setDuelLocalFeedback] = useState<"correct" | "wrong" | null>(null);
  useEffect(() => {
    setAnsweredDuelId(null);
    setDuelLocalFeedback(null);
  }, [duelId]);

  // ── Duel result + Gizli Fetih overlay toasts ─────────────────────
  // Intro ("Savunma Düellosu Başladı") is driven by the synced
  // `duel.questionVisibleAt` field — no local timer needed.
  const prevDuelIdRef   = useRef<string | null>(null);
  const phaseForDuelRef = useRef<string | null>(null);
  const [duelResultToast, setDuelResultToast] = useState<{
    icon: string; title: string;
  } | null>(null);

  // Fires when a duel ends (duelId drops from non-null to null).
  useEffect(() => {
    const prevId = prevDuelIdRef.current;
    prevDuelIdRef.current = duelId;

    if (!duelId && prevId !== null) {
      const lastResult = gameState?.round.lastResult;
      const msg = lastResult?.message ?? "";
      let icon = "", title = "";
      if (lastResult?.action === "defend_region") {
        icon  = msg.includes("⏰") ? "⏳" : "🛡️";
        title = msg.includes("⏰") ? "Süre Doldu" : "Bölge Savunuldu";
      } else if (lastResult?.action === "attack_region") {
        icon  = msg.includes("Kalkan kırıldı") ? "🛡️" : "⚔️";
        title = msg.includes("Kalkan kırıldı") ? "Kalkan Kırıldı" : "Bölge Ele Geçirildi";
      }
      if (title) {
        setDuelResultToast({ icon, title });
        const t = window.setTimeout(() => setDuelResultToast(null), DUEL_RESULT_TOAST_MS);
        return () => window.clearTimeout(t);
      }
    }
  }, [duelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Center banner — fires for ALL clients when a player consumes Ankara's
  // Gizli Operasyon hakkı.  Detected via the sentinel prefix on
  // round.lastResult.message (no region or op-kind leak by design).  Re-keyed
  // by lastResult.at-equivalent (we don't have one) so we use a simple
  // signature: phase transitioning into round_result + sentinel match.
  const [hiddenOpToast, setHiddenOpToast] = useState<{
    title: string; detail: string;
  } | null>(null);
  const phaseForHiddenOpRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = phaseForHiddenOpRef.current;
    phaseForHiddenOpRef.current = gameState?.phase ?? null;
    if (prev === "action" && gameState?.phase === "round_result") {
      const lr = gameState.round.lastResult;
      if (
        lr?.ok
        && lr.action === "defend_region"
        && typeof lr.message === "string"
        && lr.message.startsWith(HIDDEN_OP_PLACED_MESSAGE_PREFIX)
      ) {
        const placer = gameState.players.find(p => p.id === lr.playerId);
        const placerName = placer?.name ?? "Bir oyuncu";
        setHiddenOpToast({
          title:  HIDDEN_OP_PLACED_TITLE,
          detail: buildHiddenOpPlacedDetail(placerName),
        });
        const t = window.setTimeout(() => setHiddenOpToast(null), HIDDEN_OP_TOAST_MS);
        return () => window.clearTimeout(t);
      }
    }
  }, [gameState?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fires when a Gizli Koruma reveal message surfaces in round_result.
  // Two flavours: gizli fetih (cloaked capture exposed) vs gizli kalkan
  // (own-region cloak exposed); both render their own overlay toast.
  useEffect(() => {
    const prev = phaseForDuelRef.current;
    phaseForDuelRef.current = gameState?.phase ?? null;
    if (prev === "action" && (gameState?.phase === "round_result" || gameState?.phase === "finished")) {
      const msg = gameState?.round.lastResult?.message ?? "";
      if (msg.startsWith("🕶️")) {
        const title = msg.includes("Gizli koruma")
          ? "Gizli Koruma Ortaya Çıktı"
          : "Gizli Fetih Ortaya Çıktı";
        setDuelResultToast({ icon: "🕶️", title });
        const t = window.setTimeout(() => setDuelResultToast(null), DUEL_RESULT_TOAST_MS);
        return () => window.clearTimeout(t);
      }
      if (msg.startsWith("🛡️") && msg.includes("Gizli kalkan")) {
        setDuelResultToast({ icon: "🛡️", title: "Gizli Kalkan Ortaya Çıktı" });
        const t = window.setTimeout(() => setDuelResultToast(null), DUEL_RESULT_TOAST_MS);
        return () => window.clearTimeout(t);
      }
    }
  }, [gameState?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live countdown — re-renders ~4×/s so the timer bars animate.  Runs during
  // the challenge phase, the action phase, and the defense-duel phase; idle
  // otherwise to avoid useless re-renders.
  const phaseForTicker  = gameState?.phase ?? null;
  const statusForTicker = gameState?.round.challenge.status ?? null;
  const actionEndsAt    = gameState?.round.actionEndsAt ?? null;
  const duelEndsAt      = gameState?.defenseDuel?.endsAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const challengeTicking = phaseForTicker === "challenge"    && statusForTicker === "active";
    const actionTicking    = phaseForTicker === "action"       && actionEndsAt !== null;
    const duelTicking      = phaseForTicker === "defense_duel" && duelEndsAt   !== null;
    if (!challengeTicking && !actionTicking && !duelTicking) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [phaseForTicker, statusForTicker, challengeId, actionEndsAt, duelEndsAt]);

  // ── Derived ──────────────────────────────────────────────────────────
  const regionStates = gameState?.regionStates ?? [];
  // Viewer-side projection: hide Ankara "Gizli Fetih" regions owned by
  // others — they appear neutral on this client.  All UI reads (map, panels,
  // counts) consume this; gameplay handlers still operate on real state via
  // `gameState.regionStates` so blocks / reveals trigger correctly.
  const visibleRegionStates = useMemo(
    () => projectRegionStatesForViewer(regionStates, myPlayerId),
    [regionStates, myPlayerId],
  );
  const regionCounts = useMemo(
    () => getRegionOwnerCounts(visibleRegionStates),
    [visibleRegionStates],
  );
  const playerBonuses = gameState?.playerBonuses;
  const playerPoints = useMemo(
    () => getPlayerTotalPoints(players, visibleRegionStates, playerBonuses),
    [players, visibleRegionStates, playerBonuses],
  );

  // Derived shield ownership maps — drive the per-player panel chips without
  // adding new fields to playerBonuses (single source of truth = regionStates).
  // `hiddenShieldOwners` lists ids that currently have an active hidden
  // shield somewhere on the board; only shown to the local viewer.
  const hiddenShieldOwners = useMemo(() => {
    const out = new Set<string>();
    for (const rs of regionStates) {
      if (rs.hiddenShieldOwnerId) out.add(rs.hiddenShieldOwnerId);
    }
    return out;
  }, [regionStates]);
  // `openShieldOwners` is public — visible to all players.  Derived from
  // `visibleRegionStates` so it reflects the caller's board view (consistent
  // with map rendering), though `shielded` is never masked by projection.
  const openShieldOwners = useMemo(() => {
    const out = new Set<string>();
    for (const rs of visibleRegionStates) {
      if (rs.shielded && rs.ownerPlayerId) out.add(rs.ownerPlayerId);
    }
    return out;
  }, [visibleRegionStates]);
  const neutralCount  = visibleRegionStates.filter(rs => rs.ownerPlayerId === null).length;
  const neutralPoints = useMemo(
    () => getNeutralRegionPoints(visibleRegionStates),
    [visibleRegionStates],
  );

  // Legal-target highlights are computed against the *holder's* projected
  // view of the board so they can target hidden-conquest regions as if they
  // were neutral (the gameplay layer intercepts and blocks on commit).
  //
  // Ankara own-region placement candidates leak intent ("holder is about to
  // shield a region") if shown to opponents, so we only fold them into the
  // highlight set when the local viewer IS the holder.  For other viewers we
  // strip pendingHiddenShield in the state we pass to getCurrentLegalTargets.
  const legalTargets = useMemo(() => {
    if (!gameState || !mapConfig) return new Set<ConquestRegionId>();
    const holderId = gameState.round.actionHolderId;
    if (!holderId) return new Set<ConquestRegionId>();
    const holderView = projectRegionStatesForViewer(gameState.regionStates, holderId);
    const viewerIsHolder = myPlayerId === holderId;
    const playerBonusesForView = viewerIsHolder
      ? gameState.playerBonuses
      : (gameState.playerBonuses
          ? {
              ...gameState.playerBonuses,
              [holderId]: {
                ...(gameState.playerBonuses[holderId] ?? { pendingHiddenShield: false, extraNextMoveMs: 0, cukurovaClaimed: false, bonusPoints: 0 }),
                pendingHiddenShield: false,
              },
            }
          : gameState.playerBonuses);
    return getCurrentLegalTargets(
      { ...gameState, regionStates: holderView, playerBonuses: playerBonusesForView },
      mapConfig,
    );
  }, [gameState, mapConfig, myPlayerId]);

  const noMovesLeft = useMemo(() => {
    if (!gameState || !mapConfig) return false;
    const holderId = gameState.round.actionHolderId;
    if (!holderId) return false;
    const holderView = projectRegionStatesForViewer(gameState.regionStates, holderId);
    return actionHolderHasNoMoves(
      { ...gameState, regionStates: holderView },
      mapConfig,
    );
  }, [gameState, mapConfig]);

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

  const handleSubmitDuelAnswer = useCallback((rawAnswer: string) => {
    if (!gameState || !myPlayerId || !mapConfig) return;
    if (gameState.phase !== "defense_duel" || !gameState.defenseDuel) return;
    if (gameState.defenseDuel.status !== "active") return;
    if (answeredDuelId === gameState.defenseDuel.id) return;

    const { ok, winning, state: next } = submitDuelAnswer(
      gameState, mapConfig, myPlayerId, rawAnswer,
    );
    if (!ok) return;

    setAnsweredDuelId(gameState.defenseDuel.id);
    setDuelLocalFeedback(winning ? "correct" : "wrong");
    playSound(winning ? "correct" : "wrong");

    if (winning && next !== gameState) {
      void onPushGameState(next);
    }
  }, [gameState, myPlayerId, mapConfig, answeredDuelId, onPushGameState]);

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

  // ── Host-only: drive action-phase (move) expiry from synced actionEndsAt ──
  // Mirrors the challenge expiry above: host alone fires the auto-skip write,
  // every client renders the same countdown locally.  Idempotent — if the
  // holder commits a move before the timer fires, the next gameState will
  // be in a different phase and expireActionPhase becomes a no-op.
  useEffect(() => {
    if (!isHost) return;
    if (!gameState || !mapConfig) return;
    if (gameState.phase !== "action") return;
    const endsAt = gameState.round.actionEndsAt;
    if (typeof endsAt !== "number") return;

    const delay = Math.max(0, endsAt - Date.now());
    const t = window.setTimeout(() => {
      const gs = gameStateRef.current;
      if (!gs || gs.phase !== "action") return;
      if (gs.round.actionEndsAt !== endsAt) return; // stale timer
      const next = expireActionPhase(gs, mapConfig);
      if (next !== gs) void onPushStateRef.current(next);
    }, delay);
    return () => window.clearTimeout(t);
  }, [
    isHost,
    gameState,
    mapConfig,
    actionEndsAt,
  ]);

  // ── Host-only: drive defense-duel expiry from synced duel.endsAt ─────
  // Mirrors expireChallenge / expireActionPhase: host alone fires the write,
  // every client renders the same countdown locally.  Defender wins by spec.
  useEffect(() => {
    if (!isHost) return;
    if (!gameState || !mapConfig) return;
    if (gameState.phase !== "defense_duel") return;
    const duel = gameState.defenseDuel;
    if (!duel || duel.status !== "active") return;

    const endsAt = duel.endsAt;
    const delay  = Math.max(0, endsAt - Date.now());
    const t = window.setTimeout(() => {
      const gs = gameStateRef.current;
      if (!gs || gs.phase !== "defense_duel") return;
      if (!gs.defenseDuel || gs.defenseDuel.id !== duel.id) return;
      const next = expireDuel(gs, mapConfig);
      if (next !== gs) void onPushStateRef.current(next);
    }, delay);
    return () => window.clearTimeout(t);
  }, [
    isHost,
    gameState,
    mapConfig,
    duelEndsAt,
    duelId,
  ]);

  // ── Host-only: auto-advance after round_result ─────────────────────────
  // Keyed on phase + roundNumber so the timer resets cleanly at each round
  // boundary.  Non-hosts just render the waiting indicator; only the host
  // pushes the state transition, preventing duplicate writes.
  // When the round ended via a Gizli Operasyon placement the advance is
  // delayed by HIDDEN_OP_AUTO_ADVANCE_MS (> HIDDEN_OP_TOAST_MS) so the
  // next challenge phase — and its question timer — starts only after the
  // banner has fully cleared on all clients.
  const phaseForAdvance       = gameState?.phase;
  const roundNumberForAdvance = gameState?.round.roundNumber;
  useEffect(() => {
    if (!isHost || phaseForAdvance !== "round_result") return;
    const isHiddenOp = gameStateRef.current?.round.lastResult?.message
      ?.startsWith(HIDDEN_OP_PLACED_MESSAGE_PREFIX) ?? false;
    const delay = isHiddenOp ? HIDDEN_OP_AUTO_ADVANCE_MS : AUTO_ADVANCE_MS;
    const t = window.setTimeout(() => {
      const gs   = gameStateRef.current;
      const push = onPushStateRef.current;
      if (!gs || gs.phase !== "round_result") return;
      const next = advanceToNextRound(gs);
      if (next !== gs) void push(next);
    }, delay);
    return () => window.clearTimeout(t);
  // roundNumberForAdvance re-keys the timer when advancing between rounds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, phaseForAdvance, roundNumberForAdvance]);

  // ── Host-only: action-phase early finish (belt-and-suspenders) ─────────
  // applyActionToGame already catches domination at the capture step, but if
  // stale Supabase state arrives with phase="action" and all regions already
  // owned by one player (e.g. the winner won a new challenge), finish cleanly
  // rather than showing "pas geç" forever.
  useEffect(() => {
    if (!isHost || phaseForAdvance !== "action") return;
    const gs = gameStateRef.current;
    if (!gs || !mapConfig) return;
    const dominatorId = getPlayerOwningAllRegions(gs.regionStates, mapConfig);
    if (!dominatorId) return;
    const dominator = gs.players.find(p => p.id === dominatorId);
    const next: ConquestGameState = {
      ...gs,
      phase:      "finished",
      finishedAt: Date.now(),
      round: {
        ...gs.round,
        lastResult: {
          ok:       true,
          action:   "skip",
          playerId: dominatorId,
          regionId: null,
          message:  `${dominator?.name ?? "Bir oyuncu"} tüm bölgeleri ele geçirdi!`,
        },
      },
    };
    void onPushStateRef.current(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, phaseForAdvance, roundNumberForAdvance, mapConfig]);

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

    // Ankara: if the holder has a pending hidden shield, route own-region
    // clicks to shield placement and neutral-region clicks to trap placement
    // (no adjacency required for either).  Both count as the round's hamle.
    // Enemy regions are NOT a valid target for the bonus and fall through to
    // normal attack inference below.
    const targetRs   = gameState.regionStates.find(r => r.regionId === regionId);
    const holderPb   = gameState.playerBonuses?.[holderId];
    if (holderPb?.pendingHiddenShield && targetRs) {
      if (targetRs.ownerPlayerId === holderId) {
        const { state: nextState } = placeHiddenShieldOnOwnRegion(
          gameState, mapConfig, holderId, regionId,
        );
        void onPushGameState(nextState);
        playSound("click");
        return;
      }
      if (targetRs.ownerPlayerId === null) {
        const { state: nextState } = placeHiddenConquestOnNeutralRegion(
          gameState, mapConfig, holderId, regionId,
        );
        void onPushGameState(nextState);
        playSound("click");
        return;
      }
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
    if (!isHost) return;
    if (!gameState) return;
    playSound("click");
    const next = advanceToNextRound(gameState);
    if (next === gameState) return;
    void onPushGameState(next);
  }, [isHost, gameState, onPushGameState]);

  // ── Safety fallbacks ─────────────────────────────────────────────────
  if (!mapConfig) {
    return (
      <div className="app duel-screen cq-screen conquest-war-bg" style={themeStyle} data-theme={themeAttr}>
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
      <div className="app duel-screen cq-screen conquest-war-bg" style={themeStyle} data-theme={themeAttr}>
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

  // Duel countdown (mirrors challenge countdown).  Null when not in duel.
  const duel = gameState.defenseDuel ?? null;
  const duelMsRemaining = phase === "defense_duel" && duel
    ? Math.max(0, duel.endsAt - now)
    : 0;
  const duelRegionLabel = duel
    ? (mapConfig.regions.find(r => r.id === duel.regionId)?.displayLabel
        ?? mapConfig.regions.find(r => r.id === duel.regionId)?.name
        ?? duel.regionId)
    : "";
  const duelAttackerName = duel ? (players.find(p => p.id === duel.attackerId)?.name ?? "Saldıran") : "";
  const duelDefenderName = duel ? (players.find(p => p.id === duel.defenderId)?.name ?? "Savunan") : "";

  // Intro overlay: info card (4s) → 3-2-1 countdown (3s) → question panel.
  const DUEL_INFO_MS = 4000;
  const duelStartedAt = duel?.startedAt ?? 0;
  const duelQuestionVisibleAt = duel?.questionVisibleAt ?? duelStartedAt;
  const showDuelInfo      = phase === "defense_duel" && !!duel && now < duelStartedAt + DUEL_INFO_MS;
  const showDuelCountdown = phase === "defense_duel" && !!duel && now >= duelStartedAt + DUEL_INFO_MS && now < duelQuestionVisibleAt;
  const showDuelPanel     = phase === "defense_duel" && !!duel && now >= duelQuestionVisibleAt;
  const countdownNum      = showDuelCountdown ? Math.max(1, Math.ceil((duelQuestionVisibleAt - now) / 1000)) : 0;

  // ── Bonus toast lifecycle ────────────────────────────────────────────
  // The toast is part of synced state; we mount it for ~2s after `at` and
  // then dismiss locally.  Re-keying by `id` resets the dismiss timer when
  // a fresh bonus fires before the previous one finished.
  const BONUS_TOAST_MS = 4500;
  const lastBonusToast = gameState.lastBonusToast ?? null;
  const [dismissedToastId, setDismissedToastId] = useState<string | null>(null);
  useEffect(() => {
    if (!lastBonusToast) return;
    if (dismissedToastId === lastBonusToast.id) return;
    const remaining = lastBonusToast.at + BONUS_TOAST_MS - Date.now();
    if (remaining <= 0) {
      setDismissedToastId(lastBonusToast.id);
      return;
    }
    const t = window.setTimeout(() => {
      setDismissedToastId(lastBonusToast.id);
    }, remaining);
    return () => window.clearTimeout(t);
  }, [lastBonusToast?.id, lastBonusToast?.at, dismissedToastId]);
  const showBonusToast =
    !!lastBonusToast && dismissedToastId !== lastBonusToast.id;
  const toastPlayerColor = lastBonusToast
    ? (playerColors[lastBonusToast.playerId] ?? null)
    : null;

  // Move-phase timer values (null when the round predates the timer feature
  // or the phase isn't action).  Shared by both holder and spectator views.
  const moveTotalMs =
    phase === "action" && gameState.round.actionStartedAt && gameState.round.actionEndsAt
      ? gameState.round.actionEndsAt - gameState.round.actionStartedAt
      : null;
  const moveMsRemaining =
    phase === "action" && gameState.round.actionEndsAt
      ? Math.max(0, gameState.round.actionEndsAt - now)
      : null;
  const moveSecondsLeft = moveMsRemaining !== null
    ? Math.max(0, Math.ceil(moveMsRemaining / 1000))
    : null;

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

      {/* ── Compact player panel (top-left overlay) ─────────────── */}
      <div className="cq-players-panel" role="list" aria-label="Oyuncular">
        <h4 className="cq-players-panel-title" aria-hidden="true">Oyuncular</h4>
        {players.map(player => {
          const color    = playerColors[player.id];
          const isHolder = phase === "action" && gameState.round.actionHolderId === player.id;
          const pb       = getPlayerBonusState(playerBonuses, player.id);
          const isMe     = myPlayerId === player.id;

          // Bonus chips visible to everyone:
          //   - Player has an open shield active (İstanbul)
          //   - extraNextMoveMs > 0 (Karadeniz move-time bonus — observable)
          // Visible only to the bonus owner:
          //   - pendingHiddenShield (Ankara pending placement)
          //   - hidden shield currently active on the board (placed, awaiting trigger)
          const bonusChips: { key: string; icon: string; title: string }[] = [];
          if (openShieldOwners.has(player.id)) {
            bonusChips.push({ key: "ist", icon: REGION_BONUSES.istanbul_kocaeli.icon, title: "Açık kalkan aktif" });
          }
          if (pb.extraNextMoveMs > 0) {
            bonusChips.push({ key: "kdz", icon: REGION_BONUSES.dogu_karadeniz.icon, title: `${REGION_BONUSES.dogu_karadeniz.label} (+${Math.round(pb.extraNextMoveMs / 1000)}sn)` });
          }
          if (isMe && pb.pendingHiddenShield) {
            bonusChips.push({ key: "ank-pending", icon: REGION_BONUSES.ankara_cevre.icon, title: "Gizli Operasyon hazır: kendi bölgene tıklarsan gizli kalkan, tarafsız bölgeye tıklarsan gizli fetih kurulur (komşuluk şartı yok)" });
          }
          if (isMe && hiddenShieldOwners.has(player.id)) {
            bonusChips.push({ key: "ank-active", icon: "🕶️", title: "Gizli Operasyon aktif (rakipler bu bölgeden habersiz)" });
          }

          return (
            <div
              key={player.id}
              className={"cq-players-panel-row" + (isHolder ? " cq-players-panel-row--active" : "")}
              data-color={color}
              role="listitem"
              aria-label={`${player.name} — ${playerPoints[player.id] ?? 0} puan, ${regionCounts[player.id] ?? 0} bölge${isHolder ? " (sırada)" : ""}`}
            >
              <span className="cq-players-panel-dot" aria-hidden="true" />
              <span className="cq-players-panel-name">{player.name}</span>
              {bonusChips.length > 0 && (
                <span className="cq-player-bonus-chips" aria-hidden="true">
                  {bonusChips.map(c => (
                    <span key={c.key} className="cq-player-bonus-chip" title={c.title}>
                      {c.icon}
                    </span>
                  ))}
                </span>
              )}
              <span className="cq-players-panel-score" aria-hidden="true">
                <span className="cq-players-panel-points">{playerPoints[player.id] ?? 0}</span>
                <span className="cq-players-panel-regions">{regionCounts[player.id] ?? 0} bölge</span>
              </span>
            </div>
          );
        })}
        {neutralCount > 0 && (
          <div
            className="cq-players-panel-row cq-players-panel-neutral"
            role="listitem"
            aria-label={`${neutralPoints} puanlık ${neutralCount} tarafsız bölge`}
          >
            <span className="cq-players-panel-dot" aria-hidden="true" />
            <span className="cq-players-panel-name">Tarafsız</span>
            <span className="cq-players-panel-score" aria-hidden="true">
              <span className="cq-players-panel-points">{neutralPoints}</span>
              <span className="cq-players-panel-regions">{neutralCount} bölge</span>
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
                regionStates={visibleRegionStates}
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
                  regionStates={visibleRegionStates}
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
              regionStates={visibleRegionStates}
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

      {/* ── Bonus toast (transient, centered) ───────────────────── */}
      {showBonusToast && lastBonusToast && (() => {
        const copy = getBonusToastCopyForViewer(lastBonusToast, myPlayerId);
        const isOwnerView = myPlayerId !== null && myPlayerId === lastBonusToast.playerId;
        const headPrefix  = isOwnerView ? "Sen" : lastBonusToast.playerName;
        return (
          <div
            key={lastBonusToast.id}
            className="cq-bonus-toast"
            data-color={toastPlayerColor ?? undefined}
            role="status"
            aria-live="polite"
          >
            <span className="cq-bonus-toast-icon" aria-hidden="true">
              {copy.icon}
            </span>
            <div className="cq-bonus-toast-text">
              <div className="cq-bonus-toast-title">
                {lastBonusToast.bonusType === "ankara_hidden_shield"
                  ? copy.title
                  : `${headPrefix} · ${copy.title}`}
              </div>
              <div className="cq-bonus-toast-detail">
                {copy.detail}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Duel intro overlay (before question becomes visible) ───── */}
      {showDuelInfo && (
        <div
          className="cq-duel-overlay-toast cq-duel-intro-overlay"
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">⚔️</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">Savunma Düellosu Başladı</div>
            <div className="cq-bonus-toast-detail">
              {duelAttackerName}, {duelDefenderName} oyuncusunun {duelRegionLabel} bölgesine
              saldırdı. İlk doğru cevaplayan bölgenin kaderini belirleyecek.
            </div>
          </div>
        </div>
      )}

      {showDuelCountdown && (
        <div
          className="cq-duel-overlay-toast cq-duel-countdown-overlay"
          role="status"
          aria-live="polite"
          aria-label="Hazırlık geri sayımı"
        >
          <div className="cq-duel-countdown-inner">
            <div className="cq-duel-countdown-label">Hazır ol</div>
            <div key={countdownNum} className="cq-duel-countdown-number">{countdownNum}</div>
          </div>
        </div>
      )}

      {/* ── Duel result toast ────────────────────────────────────── */}
      {duelResultToast && (
        <div
          className="cq-duel-overlay-toast"
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">{duelResultToast.icon}</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">{duelResultToast.title}</div>
          </div>
        </div>
      )}

      {/* ── Gizli Operasyon Başlatıldı (center, all viewers) ────── */}
      {hiddenOpToast && (
        <div
          className="cq-duel-overlay-toast cq-hidden-op-overlay"
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">🎭</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">{hiddenOpToast.title}</div>
            <div className="cq-bonus-toast-detail">{hiddenOpToast.detail}</div>
          </div>
        </div>
      )}

      {/* ── Floating phase card ────────────────────────────────── */}
      <div className="cq-game-phase-panel" data-phase={phase}>
        {phase === "challenge" && !hiddenOpToast && (
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
            msRemaining={moveMsRemaining}
            totalMs={moveTotalMs}
            hasPendingHiddenShield={
              !!actionHolder
              && !!gameState.playerBonuses?.[actionHolder.id]?.pendingHiddenShield
            }
            onSkip={handleSkipAction}
          />
        )}

        {phase === "action" && !canActOnRegion && (
          <section className="cq-action-panel" aria-label="Hamle paneli">
            <p className="cq-action-line" role="status">
              {actionTurnLine}
            </p>
            <p className="cq-action-hint">
              {moveSecondsLeft !== null
                ? `Rakibin hamlesi: ${moveSecondsLeft}sn`
                : "Hamle tamamlanana kadar bekle."}
            </p>
            {moveMsRemaining !== null && moveTotalMs !== null && moveTotalMs > 0 && (
              <div
                className="cq-challenge-timer"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={Math.max(1, Math.round(moveTotalMs / 1000))}
                aria-valuenow={moveSecondsLeft ?? 0}
                aria-label="Hamle süresi"
              >
                <div
                  className="cq-challenge-timer-fill"
                  style={{ width: `${Math.max(0, Math.min(100, (moveMsRemaining / moveTotalMs) * 100))}%` }}
                  data-low={(moveSecondsLeft ?? 0) <= 3 ? "true" : undefined}
                />
              </div>
            )}
          </section>
        )}

        {showDuelPanel && duel && (
          <DefenseDuelPanel
            duel={duel}
            players={players}
            playerColors={playerColors}
            myPlayerId={myPlayerId}
            regionLabel={duelRegionLabel}
            alreadyAnswered={answeredDuelId === duel.id}
            lastLocalFeedback={
              answeredDuelId === duel.id ? duelLocalFeedback : null
            }
            msRemaining={duelMsRemaining}
            onSubmitAnswer={handleSubmitDuelAnswer}
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
            <p className="cq-round-auto-hint" role="status">
              {roundNumber >= totalRounds
                ? "Sonuçlar hazırlanıyor…"
                : "Sonraki tur hazırlanıyor…"}
            </p>
            {isHost && (
              <button
                type="button"
                className="btn btn-ghost cq-round-skip-btn"
                onClick={handleNextRound}
              >
                {roundNumber >= totalRounds ? "Hemen Bitir" : "Hemen Geç →"}
              </button>
            )}
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
                  <span className="cq-standings-score">
                    <span className="cq-standings-points">{row.points} puan</span>
                    <span className="cq-standings-regions">{row.regionsHeld} bölge</span>
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
