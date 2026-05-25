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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { playSound } from "../../lib/sound";
import { useIsMobile } from "../../lib/useIsMobile";
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
import MobileConquestLayout from "./mobile/MobileConquestLayout";
import MobileHeader from "./mobile/MobileHeader";
import MobileScoreStrip from "./mobile/MobileScoreStrip";
import MobileBottomSheet, {
  type MobileBottomSheetState,
} from "./mobile/MobileBottomSheet";
import MobileToastSlot, {
  type MobileToastSpec,
} from "./mobile/MobileToastSlot";
import ConquestEventFeed from "./ConquestEventFeed";
import { useConquestEventFeed } from "./useConquestEventFeed";

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
const AUTO_ADVANCE_MS   = 3_500;
const DUEL_RESULT_TOAST_MS = 5500;
/** How long the Attack Focus intro lingers for non-duel attacks on enemy
 *  regions.  Fits inside the AUTO_ADVANCE_MS round_result window so the
 *  next challenge never collides with the banner.  Duel attacks reuse the
 *  existing intro window (DUEL_INFO_MS) instead of this constant. */
const ATTACK_FOCUS_TOAST_MS = 2_300;
/** Center banner shown to ALL clients when a player consumes Ankara's
 *  Gizli Operasyon hakkı.  Must be fully read before the next challenge
 *  panel appears — keep in sync with HIDDEN_OP_AUTO_ADVANCE_MS. */
const HIDDEN_OP_TOAST_MS = 8500;
/** Host auto-advance delay used instead of AUTO_ADVANCE_MS when the
 *  round_result was caused by a Gizli Operasyon placement.  Slightly
 *  longer than HIDDEN_OP_TOAST_MS so the toast clears before the next
 *  challenge (and its timer) starts. */
const HIDDEN_OP_AUTO_ADVANCE_MS = 9000;

/** Map a round lastResult to a short icon + Turkish title for the transition card. */
function getRoundResultCardData(
  lastResult: ConquestActionResult | null,
): { icon: string; title: string } {
  if (!lastResult || !lastResult.ok) return { icon: "⏭️", title: "Tur tamamlandı" };
  const msg = lastResult.message ?? "";
  switch (lastResult.action) {
    case "capture_neutral":
      return { icon: "🏰", title: "Bölge Fethedildi" };
    case "attack_region":
      if (msg.includes("Kalkan kırıldı")) return { icon: "🛡️", title: "Kalkan Kırıldı" };
      if (msg.startsWith("🕶️"))           return { icon: "🕶️", title: "Gizli Fetih Ortaya Çıktı" };
      return { icon: "⚔️", title: "Bölge Ele Geçirildi" };
    case "defend_region":
      if (msg.startsWith(HIDDEN_OP_PLACED_MESSAGE_PREFIX)) return { icon: "🎭", title: "Gizli Operasyon" };
      if (msg.startsWith("🕶️"))           return { icon: "🕶️", title: "Gizli Operasyon Ortaya Çıktı" };
      if (msg.includes("Gizli kalkan"))   return { icon: "🛡️", title: "Gizli Kalkan Ortaya Çıktı" };
      if (msg.includes("savundu"))        return { icon: "🛡️", title: "Bölge Savunuldu" };
      return { icon: "🛡️", title: "Savunuldu" };
    case "skip":
      if (msg.includes("Süre doldu"))     return { icon: "⏱️", title: "Süre Doldu" };
      return { icon: "⏭️", title: "Tur Atlandı" };
    default:
      return { icon: "⏭️", title: "Tur tamamlandı" };
  }
}

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

  // Mobile shell branches off the same gameplay state — see MobileConquestLayout.
  // Both branches render the same TurkeyConquestMap / ConquestChallengePanel /
  // ConquestActionPanel; only the surrounding chrome differs.
  const { isMobile, orientation } = useIsMobile();

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

  // Clock-skew anchors for host-only expire timers.  actionEndsAt and
  // duel.endsAt are wall-clock timestamps set on the WRITER's machine
  // (whoever answered correctly / who initiated the duel).  When the writer's
  // Date.now() runs behind the host's, naive `endsAt - Date.now()` is small
  // or negative and fires the expire immediately — exactly the cross-browser
  // "Süre doldu — hamle yapılamadı" symptom.  These refs capture the first
  // moment the HOST observed each endsAt so we can floor the delay at
  // (observedAt + duration) and refuse to fire earlier than the writer
  // intended in host-local time.  Floor only — never short-circuits long
  // naive delays, so a writer clock that runs ahead still works correctly.
  const actionExpireAnchorRef = useRef<{ endsAt: number; observedAt: number } | null>(null);
  const duelExpireAnchorRef   = useRef<{ endsAt: number; observedAt: number } | null>(null);

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

  // ── Attack Focus intro (non-duel enemy-region attacks) ─────────────
  // Fires for ALL clients when a player commits an attack_region against
  // an opponent (non-bonus region → no defense duel).  Bonus-region
  // attacks reuse the existing duel intro card; shield-break and
  // hidden-shield reveals stay on their own toasts.  Locally derived
  // from synced state so no new sync surface is needed.
  //
  // The previous owner of the attacked region is captured from the
  // region-state snapshot kept across renders — by the time
  // round_result is observed, the synced regionStates already reflect
  // the flip, so we read the prior owner here, not from lastResult.
  const prevRegionOwnersRef = useRef<Record<string, string | null>>({});
  const prevPhaseForAttackRef = useRef<string | null>(null);
  const [attackFocus, setAttackFocus] = useState<{
    regionId:     string;
    regionLabel:  string;
    attackerName: string;
    defenderName: string;
    at:           number;
  } | null>(null);
  useEffect(() => {
    const prevOwners = prevRegionOwnersRef.current;
    const nextOwners: Record<string, string | null> = {};
    if (gameState) {
      for (const rs of gameState.regionStates) {
        nextOwners[rs.regionId] = rs.ownerPlayerId;
      }
    }

    const prevPhase = prevPhaseForAttackRef.current;
    const phase     = gameState?.phase ?? null;
    prevPhaseForAttackRef.current = phase;

    if (
      gameState
      && prevPhase === "action"
      && phase === "round_result"
    ) {
      const lr = gameState.round.lastResult;
      const msg = lr?.message ?? "";
      // Non-duel attack: ok action, attack_region, no shield-break sentinel,
      // no Gizli reveal — those flows already own their toasts.
      if (
        lr?.ok
        && lr.action === "attack_region"
        && lr.regionId
        && !msg.includes("Kalkan kırıldı")
        && !msg.startsWith("🛡️")
        && !msg.startsWith("🕶️")
        && !msg.startsWith(HIDDEN_OP_PLACED_MESSAGE_PREFIX)
      ) {
        const attackerId = lr.playerId;
        const defenderId = prevOwners[lr.regionId] ?? null;
        // Only show for attacks on enemy regions (not neutral captures —
        // those route through capture_neutral and never reach this branch
        // anyway, but defensively guard).
        if (defenderId && defenderId !== attackerId) {
          const attacker = gameState.players.find(p => p.id === attackerId);
          const defender = gameState.players.find(p => p.id === defenderId);
          const region   = mapConfig?.regions.find(r => r.id === lr.regionId);
          setAttackFocus({
            regionId:     lr.regionId,
            regionLabel:  region?.displayLabel ?? region?.name ?? lr.regionId,
            attackerName: attacker?.name ?? "Saldıran",
            defenderName: defender?.name ?? "Savunan",
            at:           Date.now(),
          });
        }
      }
    }

    prevRegionOwnersRef.current = nextOwners;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState?.phase, gameState?.round.lastResult, gameState?.regionStates]);

  // Auto-dismiss the attack-focus toast after its window.
  useEffect(() => {
    if (!attackFocus) return;
    const t = window.setTimeout(
      () => setAttackFocus(cur => (cur && cur.at === attackFocus.at ? null : cur)),
      ATTACK_FOCUS_TOAST_MS,
    );
    return () => window.clearTimeout(t);
  }, [attackFocus]);

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
  const phaseForTicker    = gameState?.phase ?? null;
  const statusForTicker   = gameState?.round.challenge.status ?? null;
  const actionEndsAt      = gameState?.round.actionEndsAt ?? null;
  const duelEndsAt        = gameState?.defenseDuel?.endsAt ?? null;
  const introEndsAtForTicker = gameState?.gameIntroEndsAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const challengeTicking = phaseForTicker === "challenge"    && statusForTicker === "active";
    const actionTicking    = phaseForTicker === "action"       && actionEndsAt !== null;
    const duelTicking      = phaseForTicker === "defense_duel" && duelEndsAt   !== null;
    const introTicking     = introEndsAtForTicker !== null && Date.now() < introEndsAtForTicker;
    if (!challengeTicking && !actionTicking && !duelTicking && !introTicking) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [phaseForTicker, statusForTicker, challengeId, actionEndsAt, duelEndsAt, introEndsAtForTicker]);

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

  // ── Transient +N / -N score deltas ─────────────────────────────────
  // Each render diffs the current playerPoints against the previous values
  // and surfaces deltas through `pointDeltas` for ~1.5s.  Pure local; the
  // authoritative numbers continue to flow from gameState.regionStates and
  // playerBonuses.  Re-keyed by epoch so the CSS keyframe re-fires when a
  // player accrues multiple deltas in quick succession.
  const POINT_DELTA_MS = 1500;
  const prevPointsRef = useRef<Record<string, number> | null>(null);
  const [pointDeltas, setPointDeltas] = useState<
    Record<string, { value: number; epoch: number }>
  >({});
  useEffect(() => {
    const prev = prevPointsRef.current;
    if (!prev) {
      prevPointsRef.current = { ...playerPoints };
      return;
    }
    const fresh: Record<string, { value: number; epoch: number }> = {};
    const epoch = Date.now();
    for (const pid of Object.keys(playerPoints)) {
      const before = prev[pid] ?? 0;
      const after  = playerPoints[pid] ?? 0;
      if (before !== after) fresh[pid] = { value: after - before, epoch };
    }
    prevPointsRef.current = { ...playerPoints };
    if (Object.keys(fresh).length === 0) return;
    setPointDeltas(cur => ({ ...cur, ...fresh }));
    const timers = Object.keys(fresh).map(pid =>
      window.setTimeout(() => {
        setPointDeltas(cur => {
          const entry = cur[pid];
          if (!entry || entry.epoch !== fresh[pid].epoch) return cur;
          const next = { ...cur };
          delete next[pid];
          return next;
        });
      }, POINT_DELTA_MS),
    );
    return () => timers.forEach(t => window.clearTimeout(t));
  }, [playerPoints]);

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

  // ── Local event feed ───────────────────────────────────────────────
  // Derived from ownership diffs + lastBonusToast id + duel start/end.
  // No new sync surface; each client builds its own list (max 6 rows).
  const eventFeedEntries = useConquestEventFeed(
    gameState,
    players,
    playerColors,
    myPlayerId,
    mapConfig,
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
  //
  // Cross-browser clock-skew guard: actionEndsAt is stamped by whoever won
  // the challenge.  If their Date.now() runs behind the host's, the naive
  // delay can be ~0 and the host would fire expireActionPhase immediately,
  // robbing the holder of their move.  We anchor a host-local floor at
  // observation: the timer never fires before host_observedAt + duration,
  // so writer-side clock skew can only ever GRANT extra time, never steal it.
  useEffect(() => {
    if (!isHost) return;
    if (!gameState || !mapConfig) return;
    if (gameState.phase !== "action") return;
    const endsAt = gameState.round.actionEndsAt;
    if (typeof endsAt !== "number") return;
    const startedAt = gameState.round.actionStartedAt;

    let observedAt: number;
    if (actionExpireAnchorRef.current?.endsAt === endsAt) {
      observedAt = actionExpireAnchorRef.current.observedAt;
    } else {
      observedAt = Date.now();
      actionExpireAnchorRef.current = { endsAt, observedAt };
    }

    const naiveDelay = endsAt - Date.now();
    const anchorDelay = (typeof startedAt === "number" && endsAt > startedAt)
      ? (observedAt + (endsAt - startedAt)) - Date.now()
      : naiveDelay;
    const delay = Math.max(0, naiveDelay, anchorDelay);

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
  //
  // Same clock-skew guard as the action-phase expire above: duel.endsAt is
  // stamped on the action holder's machine when they triggered the duel.
  // We anchor a host-local floor so writer-side clock skew can't fire the
  // duel expire early.
  useEffect(() => {
    if (!isHost) return;
    if (!gameState || !mapConfig) return;
    if (gameState.phase !== "defense_duel") return;
    const duel = gameState.defenseDuel;
    if (!duel || duel.status !== "active") return;

    const endsAt    = duel.endsAt;
    const startedAt = duel.startedAt;

    let observedAt: number;
    if (duelExpireAnchorRef.current?.endsAt === endsAt) {
      observedAt = duelExpireAnchorRef.current.observedAt;
    } else {
      observedAt = Date.now();
      duelExpireAnchorRef.current = { endsAt, observedAt };
    }

    const naiveDelay  = endsAt - Date.now();
    const anchorDelay = endsAt > startedAt
      ? (observedAt + (endsAt - startedAt)) - Date.now()
      : naiveDelay;
    const delay = Math.max(0, naiveDelay, anchorDelay);

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
  const rrcData        = getRoundResultCardData(lastResult);

  const boardDisabled = phase !== "action";

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
  const DUEL_INFO_MS = 5000;
  const duelStartedAt = duel?.startedAt ?? 0;
  const duelQuestionVisibleAt = duel?.questionVisibleAt ?? duelStartedAt;
  const showDuelInfo      = phase === "defense_duel" && !!duel && now < duelStartedAt + DUEL_INFO_MS;
  const showDuelCountdown = phase === "defense_duel" && !!duel && now >= duelStartedAt + DUEL_INFO_MS && now < duelQuestionVisibleAt;
  const showDuelPanel     = phase === "defense_duel" && !!duel && now >= duelQuestionVisibleAt;
  const countdownNum      = showDuelCountdown ? Math.max(1, Math.ceil((duelQuestionVisibleAt - now) / 1000)) : 0;

  // Game-start intro overlay: info card (3s) → 3-2-1 countdown (3s) → first challenge.
  // Only fires on round 1 of a fresh match (gameIntroEndsAt is set only by
  // createInitialConquestGameState); pre-intro rooms have undefined → no overlay.
  const GAME_INTRO_COUNTDOWN_MS = 3_000;
  const gameIntroEndsAt         = gameState?.gameIntroEndsAt ?? 0;
  const showGameIntro           = gameIntroEndsAt > 0 && phase === "challenge" && now < gameIntroEndsAt;
  const showGameIntroText       = showGameIntro && now < gameIntroEndsAt - GAME_INTRO_COUNTDOWN_MS;
  const showGameIntroCountdown  = showGameIntro && now >= gameIntroEndsAt - GAME_INTRO_COUNTDOWN_MS;
  const gameIntroCountdownNum   = showGameIntroCountdown
    ? Math.max(1, Math.ceil((gameIntroEndsAt - now) / 1000))
    : 0;

  // ── Bonus toast lifecycle ────────────────────────────────────────────
  // The toast is part of synced state; we mount it for ~2s after `at` and
  // then dismiss locally.  Re-keying by `id` resets the dismiss timer when
  // a fresh bonus fires before the previous one finished.
  const BONUS_TOAST_MS = 6000;
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

  // ── Attack Focus target marker (map + overlay copy) ────────────
  // The map's red ring + ⚔️ glyph is driven by `attackTargetRegionId`:
  //   - During the duel intro / 3-2-1 countdown window, point it at the
  //     duel target so the attack reads cinematically before the question.
  //   - For non-duel enemy attacks the local `attackFocus` toast owns it
  //     for ATTACK_FOCUS_TOAST_MS.
  // Otherwise null — no marker is drawn.
  const attackTargetRegionId = (() => {
    if (phase === "defense_duel" && duel && (showDuelInfo || showDuelCountdown)) {
      return duel.regionId;
    }
    if (attackFocus) return attackFocus.regionId;
    return null;
  })();

  // ── Slot nodes shared between desktop and mobile shells ────────────
  // The same React elements are reused in both branches so realtime
  // state, refs, and effect ownership stay identical — only the
  // surrounding chrome differs.
  const mapNode = settings.map === "turkey" ? (
    <>
      {/* SVG map: primary interaction on all screens */}
      <TurkeyConquestMap
        regionStates={visibleRegionStates}
        players={players}
        playerColors={playerColors}
        legalTargetIds={legalTargets}
        flashRegionId={flashRegionId}
        attackTargetRegionId={attackTargetRegionId}
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
  );

  // ── Toasts (shared across desktop and mobile) ──────────────────────
  // Stay `position: fixed` for both branches; the mobile shell will get
  // a queued toast slot in a later step.
  const toastsNode = (
    <>
      {/* Bonus toast (transient, centered) */}
      {showBonusToast && lastBonusToast && (() => {
        const copy = getBonusToastCopyForViewer(lastBonusToast, myPlayerId);
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
                {copy.title}
              </div>
              <div className="cq-bonus-toast-detail">
                {copy.detail}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Game-start intro: info card (3s) → 3-2-1 countdown (3s).
       *  Only fires at the very start of a fresh match; never repeats.
       *  Challenge panel and 20-second timer are suppressed until the
       *  countdown ends (first challenge startedAt === gameIntroEndsAt). */}
      {showGameIntroText && (
        <div
          className="cq-duel-overlay-toast cq-game-intro-overlay"
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">⚔️</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">⚔️ Kuşatma başlıyor</div>
            <div className="cq-bonus-toast-detail">
              Ekrana gelen sorulara ilk doğru cevabı veren oyuncu hamle yapma hakkı kazanır.<br />
              Tarafsız bölgeler direkt fethedilir; rakibe ait bölgeler için düello gerekir.<br />
              Hazır ol! Hamle hakkı kazanmak için ilk soru geliyor.
            </div>
          </div>
        </div>
      )}
      {showGameIntroCountdown && (
        <div
          className="cq-duel-overlay-toast cq-duel-countdown-overlay"
          role="status"
          aria-live="polite"
          aria-label="Oyun geri sayımı"
        >
          <div className="cq-duel-countdown-inner">
            <div className="cq-duel-countdown-label">Hazır ol</div>
            <div key={gameIntroCountdownNum} className="cq-duel-countdown-number">
              {gameIntroCountdownNum}
            </div>
          </div>
        </div>
      )}

      {/* Duel attack focus card (replaces the old "Savunma Düellosu
       *  Başladı" header — same window, sharper "Hedef: X" framing).
       *  Question timer doesn't start until questionVisibleAt, so the
       *  player reads the attack before the 8s clock begins. */}
      {showDuelInfo && (
        <div
          className="cq-duel-overlay-toast cq-duel-intro-overlay cq-attack-focus-overlay"
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">⚔️</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">⚔️ Hedef: {duelRegionLabel}</div>
            <div className="cq-bonus-toast-detail">
              {duelAttackerName}, {duelDefenderName} oyuncusunun {duelRegionLabel} bölgesine
              saldırıyor. Bölgenin kaderi savunma düellosunda belirlenecek —
              ilk doğru cevaplayan kazanır.
            </div>
          </div>
        </div>
      )}

      {/* Attack Focus overlay for non-duel enemy attacks.
       *  Renders briefly during round_result so every client sees who
       *  attacked which region before the next challenge begins.
       *  Suppressed during defense duels, hidden-op banner, and shield
       *  reveals — those flows own their own toasts. */}
      {attackFocus && phase !== "defense_duel" && phase !== "round_result" && !hiddenOpToast && !duelResultToast && (
        <div
          key={`af:${attackFocus.at}`}
          className="cq-duel-overlay-toast cq-attack-focus-overlay cq-attack-focus-overlay--solo"
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">⚔️</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">
              ⚔️ Hedef: {attackFocus.regionLabel}
            </div>
            <div className="cq-bonus-toast-detail">
              {attackFocus.attackerName}, {attackFocus.defenderName} oyuncusunun{" "}
              {attackFocus.regionLabel} bölgesine saldırdı.
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

      {/* Duel result toast */}
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

      {/* Gizli Operasyon Başlatıldı (center, all viewers) */}
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
    </>
  );

  // ── Mobile toast queue (Step 8) ─────────────────────────────────────
  // Derive a typed spec list from the same toast state the desktop
  // `toastsNode` reads.  MobileToastSlot picks one to render at a time —
  // higher priority wins; ties broken by array order.  Stable IDs
  // (`<kind>:<source-id-or-title>`) keep the same React mount across
  // re-renders within one toast's lifetime, so the entry animation
  // fires once per toast, not per parent render.
  //
  // Priority order:
  //   120  game-intro-countdown  (3-2-1 at game start)
  //   110  game-intro            (⚔️ Kuşatma başlıyor card)
  //   100  duel-countdown        (3-2-1 just before the duel question shows)
  //    90  duel-intro            ("Savunma Düellosu Başladı" detail card)
  //    80  hidden-op             ("Gizli Operasyon Başlatıldı" — 7s)
  //    70  duel-result           ("Bölge Savunuldu" / "Kalkan Kırıldı" — 4s)
  //    50  bonus                 (Çukurova / Karadeniz / İstanbul — 4.5s)
  //
  // Time-locked duel-* specs win against the informational toasts so
  // they never queue behind a 4.5 s bonus card and miss their window.
  const mobileToastSpecs: MobileToastSpec[] = [];
  if (showGameIntroCountdown) {
    mobileToastSpecs.push({
      id:        "game-intro-countdown",
      kind:      "game-intro-countdown",
      priority:  120,
      className: "cq-duel-overlay-toast cq-duel-countdown-overlay",
      ariaLabel: "Oyun geri sayımı",
      content: (
        <div className="cq-duel-countdown-inner">
          <div className="cq-duel-countdown-label">Hazır ol</div>
          <div key={gameIntroCountdownNum} className="cq-duel-countdown-number">
            {gameIntroCountdownNum}
          </div>
        </div>
      ),
    });
  }
  if (showGameIntroText) {
    mobileToastSpecs.push({
      id:        "game-intro-text",
      kind:      "game-intro",
      priority:  110,
      className: "cq-duel-overlay-toast cq-game-intro-overlay",
      content: (
        <>
          <span className="cq-bonus-toast-icon" aria-hidden="true">⚔️</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">⚔️ Kuşatma başlıyor</div>
            <div className="cq-bonus-toast-detail">
              Ekrana gelen sorulara ilk doğru cevabı veren oyuncu hamle yapma hakkı kazanır.
              Tarafsız bölgeler direkt fethedilir; rakibe ait bölgeler için düello gerekir.
              Hazır ol! Hamle hakkı kazanmak için ilk soru geliyor.
            </div>
          </div>
        </>
      ),
    });
  }
  if (showDuelCountdown && duel) {
    mobileToastSpecs.push({
      id:        `duel-countdown:${duel.id}`,
      kind:      "duel-countdown",
      priority:  100,
      className: "cq-duel-overlay-toast cq-duel-countdown-overlay",
      ariaLabel: "Hazırlık geri sayımı",
      content: (
        <div className="cq-duel-countdown-inner">
          <div className="cq-duel-countdown-label">Hazır ol</div>
          <div key={countdownNum} className="cq-duel-countdown-number">
            {countdownNum}
          </div>
        </div>
      ),
    });
  }
  if (showDuelInfo && duel) {
    mobileToastSpecs.push({
      id:        `duel-intro:${duel.id}`,
      kind:      "duel-intro",
      priority:  90,
      className: "cq-duel-overlay-toast cq-duel-intro-overlay cq-attack-focus-overlay",
      content: (
        <>
          <span className="cq-bonus-toast-icon" aria-hidden="true">⚔️</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">⚔️ Hedef: {duelRegionLabel}</div>
            <div className="cq-bonus-toast-detail">
              {duelAttackerName}, {duelDefenderName} oyuncusunun {duelRegionLabel} bölgesine
              saldırıyor. Bölgenin kaderi savunma düellosunda belirlenecek —
              ilk doğru cevaplayan kazanır.
            </div>
          </div>
        </>
      ),
    });
  }
  // Non-duel enemy attack: same Attack Focus card; priority between
  // duel-intro (90) and hidden-op (80) so it doesn't get queued behind a
  // bonus toast and miss its short window.
  if (attackFocus && phase !== "defense_duel" && phase !== "round_result") {
    mobileToastSpecs.push({
      id:        `attack-focus:${attackFocus.regionId}:${attackFocus.at}`,
      kind:      "attack-focus",
      priority:  85,
      className: "cq-duel-overlay-toast cq-attack-focus-overlay cq-attack-focus-overlay--solo",
      content: (
        <>
          <span className="cq-bonus-toast-icon" aria-hidden="true">⚔️</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">
              ⚔️ Hedef: {attackFocus.regionLabel}
            </div>
            <div className="cq-bonus-toast-detail">
              {attackFocus.attackerName}, {attackFocus.defenderName} oyuncusunun{" "}
              {attackFocus.regionLabel} bölgesine saldırdı.
            </div>
          </div>
        </>
      ),
    });
  }
  if (hiddenOpToast) {
    mobileToastSpecs.push({
      id:        `hidden-op:${hiddenOpToast.title}`,
      kind:      "hidden-op",
      priority:  80,
      className: "cq-duel-overlay-toast cq-hidden-op-overlay",
      content: (
        <>
          <span className="cq-bonus-toast-icon" aria-hidden="true">🎭</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">{hiddenOpToast.title}</div>
            <div className="cq-bonus-toast-detail">{hiddenOpToast.detail}</div>
          </div>
        </>
      ),
    });
  }
  if (duelResultToast) {
    mobileToastSpecs.push({
      id:        `duel-result:${duelResultToast.title}`,
      kind:      "duel-result",
      priority:  70,
      className: "cq-duel-overlay-toast",
      content: (
        <>
          <span className="cq-bonus-toast-icon" aria-hidden="true">
            {duelResultToast.icon}
          </span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">{duelResultToast.title}</div>
          </div>
        </>
      ),
    });
  }
  if (showBonusToast && lastBonusToast) {
    const copy = getBonusToastCopyForViewer(lastBonusToast, myPlayerId);
    mobileToastSpecs.push({
      id:        `bonus:${lastBonusToast.id}`,
      kind:      "bonus",
      priority:  50,
      className: "cq-bonus-toast",
      dataColor: toastPlayerColor ?? undefined,
      content: (
        <>
          <span className="cq-bonus-toast-icon" aria-hidden="true">
            {copy.icon}
          </span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">{copy.title}</div>
            <div className="cq-bonus-toast-detail">{copy.detail}</div>
          </div>
        </>
      ),
    });
  }

  // Mobile branches render the slot instead of the multi-overlay
  // `toastsNode` so only one toast is visible at a time and the
  // positioning is shell-aware (clears header/strip in portrait, the
  // right dock in landscape).
  const mobileToastsNode = <MobileToastSlot specs={mobileToastSpecs} />;

  // ── Phase panel body (shared between desktop floating card and the
  //    mobile bottom sheet). The wrapper chrome differs per branch; this
  //    is just the panel content per phase. ────────────────────────────
  const phasePanelContent: ReactNode = (
    <>
      {phase === "challenge" && !hiddenOpToast && !showGameIntro && (
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
          <div className="cq-rrc-icon" aria-hidden="true">{rrcData.icon}</div>
          <div className="cq-rrc-title">{rrcData.title}</div>
          <p className="cq-rrc-subtitle">{lastResult?.message ?? "Tur tamamlandı."}</p>
          <p className="cq-rrc-hint" role="status">
            {roundNumber >= totalRounds
              ? "Sonuçlar hazırlanıyor…"
              : "Yeni soru hazırlanıyor…"}
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
    </>
  );

  // ── Desktop overlays: toasts + the legacy floating phase card + feed.
  const overlaysNode = (
    <>
      {toastsNode}
      <div className="cq-game-phase-panel" data-phase={phase}>
        {phasePanelContent}
      </div>
      <ConquestEventFeed events={eventFeedEntries} variant="desktop" />
    </>
  );

  // ── Landscape mobile dock content (Step 7) ────────────────────────
  // The same `phasePanelContent` that fills the portrait sheet body
  // renders inside the landscape dock as a flat HUD section — the dock
  // chrome comes from `.mcq-dock-slot`, so we drop the floating-panel
  // wrapper here. `data-phase` is preserved so phase-specific styling
  // (e.g. duel red accent) keeps working.
  const landscapeDockNode = (
    <div className="mcq-dock-panel" data-phase={phase}>
      {phasePanelContent}
      <ConquestEventFeed events={eventFeedEntries} variant="landscape-dock" />
    </div>
  );

  // Landscape overlays: only the transient toasts.  The phase panel
  // moves into the in-grid dock above, so the legacy floating card
  // is no longer rendered in landscape mobile.  The actual toast JSX
  // routes through `mobileToastsNode` (single-slot queue) below.

  // ── Mobile bottom-sheet derivation (Step 4) ───────────────────────
  // Each phase chooses a natural default state for the sheet and whether
  // the user is allowed to collapse it.  The handle string ticks with the
  // existing `now` state so countdowns stay live even when collapsed.
  // The hidden-op center toast suppresses the sheet entirely (matches
  // the existing challenge-panel gating).
  let mobileSheetState: MobileBottomSheetState = "collapsed";
  let mobileSheetDismissible = true;
  let mobileSheetHandle: ReactNode = (
    <span className="mcq-sheet-handle-title">Tur paneli</span>
  );
  const mobileSheetVisible = !hiddenOpToast;
  // Reset the sheet's internal user-toggle whenever any of these
  // identifiers changes (i.e. a meaningfully new phase begins).
  const mobileSheetPhaseKey = [
    phase,
    String(roundNumber),
    challengeState?.challenge?.id ?? "",
    duel?.id ?? "",
    gameState.round.actionHolderId ?? "",
    canActOnRegion ? "h" : "w",
  ].join("|");

  if (phase === "challenge") {
    mobileSheetState = "expanded";
    mobileSheetDismissible = false;
    const sec = Math.max(0, Math.ceil((challengeState.endsAt - now) / 1000));
    mobileSheetHandle = (
      <>
        <span className="mcq-sheet-handle-title">Soru</span>
        <span
          className="mcq-sheet-handle-timer"
          data-low={sec <= 3 ? "true" : undefined}
        >
          {sec}sn
        </span>
      </>
    );
  } else if (phase === "action") {
    if (canActOnRegion) {
      mobileSheetState = "expanded";
      mobileSheetDismissible = true;
      mobileSheetHandle = (
        <>
          <span className="mcq-sheet-handle-title">Hamle sırası sende</span>
          {moveSecondsLeft !== null && (
            <span
              className="mcq-sheet-handle-timer"
              data-low={moveSecondsLeft <= 3 ? "true" : undefined}
            >
              {moveSecondsLeft}sn
            </span>
          )}
        </>
      );
    } else {
      mobileSheetState = "collapsed";
      mobileSheetDismissible = true;
      mobileSheetHandle = (
        <>
          <span className="mcq-sheet-handle-title">
            {actionTurnLine ?? "Hamle bekleniyor"}
          </span>
          {moveSecondsLeft !== null && (
            <span
              className="mcq-sheet-handle-timer"
              data-low={moveSecondsLeft <= 3 ? "true" : undefined}
            >
              {moveSecondsLeft}sn
            </span>
          )}
        </>
      );
    }
  } else if (phase === "defense_duel") {
    if (showDuelPanel && duel) {
      mobileSheetState = "full";
      mobileSheetDismissible = false;
      const sec = Math.max(0, Math.ceil(duelMsRemaining / 1000));
      mobileSheetHandle = (
        <>
          <span className="mcq-sheet-handle-title">⚔️ Savunma Düellosu</span>
          <span
            className="mcq-sheet-handle-timer"
            data-low={sec <= 3 ? "true" : undefined}
          >
            {sec}sn
          </span>
        </>
      );
    } else {
      // Intro / 3-2-1 countdown phase — the overlay toast already owns
      // the screen, so just hide the sheet.
      mobileSheetState = "collapsed";
      mobileSheetDismissible = false;
      mobileSheetHandle = (
        <span className="mcq-sheet-handle-title">⚔️ Düello hazırlanıyor…</span>
      );
    }
  } else if (phase === "round_result") {
    mobileSheetState = "expanded";
    mobileSheetDismissible = true;
    mobileSheetHandle = (
      <span className="mcq-sheet-handle-title">
        {rrcData.icon} {rrcData.title}
      </span>
    );
  } else if (phase === "finished") {
    mobileSheetState = "full";
    mobileSheetDismissible = false;
    mobileSheetHandle = (
      <span className="mcq-sheet-handle-title">🏆 Kuşatma Bitti</span>
    );
  }

  // Portrait peek: tiny single-row chip just below the score strip area.
  // Hidden whenever a major toast is on screen (hidden-op center banner,
  // duel intro/countdown) so the cinematic flow doesn't compete with the
  // log row.  Same `eventFeedEntries` source as desktop and landscape.
  const mobilePeekSuppressed =
    !!hiddenOpToast || showDuelInfo || showDuelCountdown || !!attackFocus;
  const mobileOverlaysNode = (
    <>
      {mobileToastsNode}
      {!mobilePeekSuppressed && (
        <ConquestEventFeed
          events={eventFeedEntries}
          variant="portrait-peek"
        />
      )}
      <MobileBottomSheet
        phaseKey={mobileSheetPhaseKey}
        state={mobileSheetState}
        dismissible={mobileSheetDismissible}
        handle={mobileSheetHandle}
        visible={mobileSheetVisible}
      >
        {phasePanelContent}
      </MobileBottomSheet>
    </>
  );

  // ── Mobile shell branch (Steps 1-4) ────────────────────────────────
  // Desktop layout below is preserved verbatim; the mobile shell uses
  // the same map and reuses `phasePanelContent` inside a real bottom
  // sheet (see MobileBottomSheet) instead of the legacy floating card.
  // Toasts still position:fixed for now — toast-queue lands in a later
  // step.  Landscape uses the same shell for now and inherits the
  // legacy side-dock CSS from `.cq-game-phase-panel` — but only on
  // landscape (the sheet replaces the panel in portrait).
  if (isMobile) {
    return (
      <div
        className="app duel-screen cq-screen cq-game-screen"
        style={themeStyle}
        data-theme={themeAttr}
      >
        <MobileConquestLayout
          orientation={orientation}
          header={
            <MobileHeader
              roundNumber={roundNumber}
              totalRounds={totalRounds}
              onBack={handleBack}
            />
          }
          scoreStrip={
            <MobileScoreStrip
              players={players}
              playerColors={playerColors}
              playerPoints={playerPoints}
              regionCounts={regionCounts}
              playerBonuses={playerBonuses}
              openShieldOwners={openShieldOwners}
              hiddenShieldOwners={hiddenShieldOwners}
              actionHolderId={gameState.round.actionHolderId ?? null}
              myPlayerId={myPlayerId}
              neutralCount={neutralCount}
              neutralPoints={neutralPoints}
              pointDeltas={pointDeltas}
            />
          }
          map={mapNode}
          dock={orientation === "landscape" ? landscapeDockNode : undefined}
          overlays={
            orientation === "portrait"
              ? mobileOverlaysNode
              : mobileToastsNode
          }
        />
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
                <span
                  className="cq-players-panel-points"
                  data-bouncing={pointDeltas[player.id] ? "true" : undefined}
                >
                  {playerPoints[player.id] ?? 0}
                </span>
                <span className="cq-players-panel-regions">{regionCounts[player.id] ?? 0} bölge</span>
                {pointDeltas[player.id] && (
                  <span
                    key={pointDeltas[player.id].epoch}
                    className="cq-players-panel-delta"
                    data-sign={pointDeltas[player.id].value > 0 ? "pos" : "neg"}
                  >
                    {pointDeltas[player.id].value > 0
                      ? `+${pointDeltas[player.id].value}`
                      : pointDeltas[player.id].value}
                  </span>
                )}
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

      {/* ── Board (desktop wrap; mobile shell uses .mcq-map-slot) ─ */}
      <div className="cq-game-board-wrap">
        <div className="cq-game-board-inner">
          <p className="cq-game-map-title" aria-hidden="true">
            {mapIcon(settings.map)} {mapConfig.displayName}
          </p>
          {mapNode}
        </div>
      </div>

      {/* ── Toasts + floating phase card (shared with mobile shell) ── */}
      {overlaysNode}


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
