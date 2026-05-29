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
import { playConquestSound, unlockConquestSounds } from "./conquestSound";
import { useConquestSound } from "./useConquestSound";
import { useIsMobile } from "../../lib/useIsMobile";
import {
  getThemeBackgroundStyle,
  getThemeDataAttr,
  readStoredHomeTheme,
} from "../../lib/themeBackgrounds";
import {
  mapIcon,
  type ConquestActionResult,
  type ConquestChallenge,
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
  buildHiddenOpPlacedDetail,
  getBonusToastCopyForViewer,
  getBonusTypePresentation,
  getPlayerBonusState,
  HIDDEN_OP_PLACED_MESSAGE_PREFIX,
  HIDDEN_OP_PLACED_TITLE,
} from "./regionBonuses";
import { getActiveBonusEntries } from "./conquestRoundBonuses";
import { CAPITAL_REGION_IDS, CAPITAL_REVEAL_HOLD_MS } from "./conquestCapital";
import {
  actionHolderHasNoMoves,
  advanceToNextRound,
  applyActionToGame,
  buildFinalStandings,
  expireActionPhase,
  expireChallenge,
  expireDuel,
  finalizeReveal,
  getCurrentLegalTargets,
  getPlayerOwningAllRegions,
  placeHiddenConquestOnNeutralRegion,
  placeHiddenShieldOnOwnRegion,
  ROUND_COUNTDOWN_MS,
  submitChallengeAnswer,
  submitDuelAnswer,
} from "./conquestGameplay";
import { inferActionFromRegionClick, isLegalTarget } from "./conquestActions";
import { normaliseAnswer } from "./conquestChallengeValidation";
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
import ConquestVolumeControl from "./ConquestVolumeControl";
import { useConquestEventFeed } from "./useConquestEventFeed";
import ConquestSignalBanner from "./ConquestSignalBanner";
import { useConquestSignals } from "./useConquestSignals";
import ConquestBonusGuide, {
  type ConquestBonusGuideEntry,
} from "./ConquestBonusGuide";

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

/** Subtitles rotated under the "Tur N Başlıyor" intro card; copy stays
 *  generic on purpose so it never lies about gameplay state. */
const ROUND_INTRO_SUBTITLES = [
  "Cepheler yeniden şekilleniyor",
  "Yeni hamle, yeni şans",
  "Savunmalar zayıflıyor",
  "Bonus bölgeler bekliyor",
  "Hat yeniden çiziliyor",
  "Hedef: en güçlü cephe",
];

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

// ─────────────────────────────────────────────────────────────────────────────
// Eleme Yetkisi — local elimination helper
//
// Pure, deterministic, and viewer-local.  Given a challenge + viewer id,
// returns the exact `choices` string to render as struck-through.  Seeding
// by `challengeId + viewerId` keeps the choice stable across refreshes
// (same viewer always sees the same option eliminated) without leaking to
// other clients (each viewer's seed is unique).  Only one player holds the
// charge per match (the bonus is grant-on-capture, max 1 stack), so the
// "leak between viewers" surface is theoretical — but the seed shape is
// already future-safe.
//
// Correctness is enforced via the challenge's `acceptedAnswers` list — the
// same path used by `isChallengeAnswerCorrect`.  Any choice whose
// normalised form matches an accepted answer is excluded from the wrong
// pool, so the correct option is guaranteed to never be eliminated.
// ─────────────────────────────────────────────────────────────────────────────

function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) + s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function eliminatorRng(seed: number): () => number {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickEliminatedWrongChoice(
  challenge: ConquestChallenge,
  viewerId:  string,
): string | null {
  const choices = challenge.choices ?? [];
  if (choices.length === 0) return null;
  const accepted = (challenge.acceptedAnswers ?? []).map(normaliseAnswer);
  if (accepted.length === 0) return null;
  const wrongChoices = choices.filter(
    c => !accepted.includes(normaliseAnswer(c)),
  );
  if (wrongChoices.length === 0) return null;
  const rng = eliminatorRng(djb2Hash(`${challenge.id}:${viewerId}`));
  return wrongChoices[Math.floor(rng() * wrongChoices.length)];
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

  // Eleme Yetkisi — latched per-challenge eliminated choice for the local
  // viewer.  The ref is the source of truth so the eliminated option stays
  // visually struck through for the full challenge lifetime, even after
  // `submitChallengeAnswer` decrements the synced `eliminatorCharges` to 0.
  // We decide on the first render of each new challenge id (read charges
  // from the synced state at that moment); subsequent renders read the
  // latch.  Idempotent ref-during-render — same challenge id always yields
  // the same outcome.
  const eliminationLatchRef = useRef<{
    challengeId:      string;
    eliminatedChoice: string | null;
  } | null>(null);

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
  // Stable dedupe keys for the attack-focus sound — keyed by
  // round + attacker + target so a re-render or returning client can't
  // double-fire the cue for the same event. Distinct from duel-start
  // so the two sounds never collide. Set is local to this client.
  const attackFocusSoundSeenRef = useRef<Set<string>>(new Set());
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
          // Pair the toast with its audio cue. Stable key prevents a
          // re-render of the same attack from re-firing the sound; the
          // sound layer itself no-ops when the asset is missing.
          const soundKey = `attack-focus:${gameState.round.roundNumber}:${attackerId}:${lr.regionId}`;
          if (!attackFocusSoundSeenRef.current.has(soundKey)) {
            attackFocusSoundSeenRef.current.add(soundKey);
            playConquestSound("attack-focus");
          }
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
        // Resolve the region currently carrying the gizli-operasyon bonus
        // from the match-stable assignment, so the banner names the actual
        // bonus region instead of a stale "Ankara" hardcode.
        const opRegionId = gameState.roundBonuses
          ? (Object.keys(gameState.roundBonuses) as ConquestRegionId[]).find(
              rid => gameState.roundBonuses?.[rid] === "ankara_hidden_shield",
            )
          : null;
        const opRegion = opRegionId
          ? mapConfig?.regions.find(r => r.id === opRegionId) ?? null
          : null;
        const opRegionLabel =
          opRegion?.displayLabel ?? opRegion?.name ?? null;
        setHiddenOpToast({
          title:  HIDDEN_OP_PLACED_TITLE,
          detail: buildHiddenOpPlacedDetail(placerName, opRegionLabel),
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
    const revealTicking    = phaseForTicker === "reveal";
    const actionTicking    = phaseForTicker === "action"       && actionEndsAt !== null;
    const duelTicking      = phaseForTicker === "defense_duel" && duelEndsAt   !== null;
    const introTicking     = introEndsAtForTicker !== null && Date.now() < introEndsAtForTicker;
    if (!challengeTicking && !revealTicking && !actionTicking && !duelTicking && !introTicking) return;
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

  // Cinematic signal layer — ONE major/critical banner at a time.
  // Minor events stay in the event feed above; this hook only fires for
  // the round_intro / bonus_capture / last_stand / match_over moments.
  const activeSignal = useConquestSignals(
    gameState,
    players,
    playerColors,
    myPlayerId,
    mapConfig,
  );

  // Battle-atmosphere sound FX layer.  Pure local diff against gameState
  // — fires sounds for round-start, reveal, turn ownership, captures,
  // bonus captures, shield breaks, and defense duels.  No-op when sound
  // is muted or when asset files are missing.
  useConquestSound(gameState, myPlayerId);

  // Browser autoplay: first user interaction inside the game screen
  // unlocks the conquest sound palette.  After this, subsequent
  // background `.play()` calls (synced state transitions) are treated
  // as user-initiated by the browser.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      unlockConquestSounds();
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
    };
    window.addEventListener("pointerdown", handler);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
    };
  }, []);

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

    const { ok, correct, firstCorrect, state: next } = submitChallengeAnswer(
      gameState, myPlayerId, rawAnswer,
    );
    if (!ok) return;

    // Lock further submissions for this challenge on this client.
    setAnsweredChallengeId(gameState.round.challenge.challenge.id);
    // We still track the local verdict — the reveal-phase panel uses it
    // (`showCorrectButLost`) to render the "Doğru bildin ama ilk cevap …"
    // line *after* the timer ends.  No audio/visual reveal happens here:
    // the per-submission feedback is intentionally neutral.
    setLocalFeedback(correct ? "correct" : "wrong");
    playConquestSound("answer-submit");

    // Push every successful submission so the synced answeredPlayerIds set
    // updates — that's what the host's early-reveal check watches.  The
    // first correct submission additionally records firstCorrectPlayerId
    // for the eventual reveal attribution.
    if (next !== gameState) {
      void onPushGameState(next);
    }
    // Suppress the unused-var warning while keeping the destructure
    // self-documenting for future readers.
    void firstCorrect;
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
    // Neutral "answer submitted" cue — win/lose verdict for the duel is
    // played by useConquestSound when the duel resolves on every client,
    // so the per-submission sound here stays nondescript.
    playConquestSound("answer-submit");

    if (winning && next !== gameState) {
      void onPushGameState(next);
    }
  }, [gameState, myPlayerId, mapConfig, answeredDuelId, onPushGameState]);

  // ── Host-only: drive challenge expiry from the synced endsAt ─────────
  // Only the host pushes the expire write so two clients don't race.  The
  // timeout is computed from `endsAt - Date.now()` so every client agrees
  // on when it fires (host's clock is authoritative).  expireChallenge
  // transitions the round into the "reveal" sub-phase (see gameplay.ts);
  // the next effect below schedules the reveal → action/round_result step.
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

  // ── Host-only: fire reveal early when every still-in-room eligible
  //    player has submitted (correct OR wrong).  Two-player rooms snap
  //    into reveal the moment both answer; >2 player rooms still wait on
  //    the slowest active player.  Disconnect/leave handled by intersecting
  //    eligible ids with the live `players` array.
  useEffect(() => {
    if (!isHost) return;
    if (!gameState) return;
    if (gameState.phase !== "challenge") return;
    if (gameState.round.challenge.status !== "active") return;

    const eligible = gameState.round.challenge.challenge.eligiblePlayerIds
      .filter(id => players.some(p => p.id === id));
    if (eligible.length === 0) return;

    const answered = gameState.round.challenge.answeredPlayerIds ?? [];
    const allAnswered = eligible.every(id => answered.includes(id));
    if (!allAnswered) return;

    // Skip a microtask so a stale snapshot mid-render can't race us into
    // an extra expireChallenge write.  expireChallenge is idempotent, so
    // the duplicate is cosmetic — but the microtask gives the timer
    // effect cleanup a chance to run first.
    const t = window.setTimeout(() => {
      const expired = expireChallenge(gameState);
      if (expired !== gameState) void onPushGameState(expired);
    }, 0);
    return () => window.clearTimeout(t);
  }, [
    isHost,
    gameState,
    players,
    onPushGameState,
  ]);

  // ── Host-only: drive reveal phase finalisation from revealEndsAt ─────
  // Mirrors the challenge expiry above. The reveal window is short (~3s)
  // but each client renders the same countdown locally so the reveal copy
  // lands at the same wall-clock moment everywhere. The host alone pushes
  // the finalize write to avoid two clients racing the transition.
  useEffect(() => {
    if (!isHost) return;
    if (!gameState) return;
    if (gameState.phase !== "reveal") return;
    const endsAt = gameState.round.revealEndsAt;
    if (typeof endsAt !== "number") return;

    const delay = Math.max(0, endsAt - Date.now());
    const t = window.setTimeout(() => {
      const next = finalizeReveal(gameState);
      if (next !== gameState) void onPushGameState(next);
    }, delay);
    return () => window.clearTimeout(t);
  }, [
    isHost,
    gameState,
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
      const next = advanceToNextRound(gs, mapConfig ?? undefined);
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
    // clicks to shield placement (no adjacency needed — it's a defensive
    // op, not a capture) and neutral-region clicks to gizli fetih ONLY when
    // the neutral satisfies the canonical adjacency rule.  Non-adjacent
    // neutrals fall through to inferActionFromRegionClick below, where
    // they're rejected as illegal — the hidden-op path must never bypass
    // adjacency for captures.  Enemy regions always fall through.
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
      if (
        targetRs.ownerPlayerId === null
        && isLegalTarget(mapConfig, gameState.regionStates, holderId, regionId)
      ) {
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
    const next = advanceToNextRound(gameState, mapConfig ?? undefined);
    if (next === gameState) return;
    void onPushGameState(next);
  }, [isHost, gameState, mapConfig, onPushGameState]);

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

  // Eleme Yetkisi — decide once per challenge whether to render an
  // elimination for the local viewer, then latch the answer.  Decision
  // gates: (1) phase is the normal challenge phase (defense duels route
  // through a separate panel and intentionally don't get the bonus), (2)
  // the challenge has multiple-choice options, (3) the local viewer is
  // eligible to answer, and (4) the viewer holds at least one eliminator
  // charge at the moment the challenge first renders here.  Once latched,
  // the eliminated choice stays stable for the rest of this challenge's
  // lifetime so consumption via `submitChallengeAnswer` (charges → 0)
  // doesn't make the struck-through option pop back as plain disabled.
  let localEliminatedChoice: string | null = null;
  if (phase === "challenge" && myPlayerId) {
    const cid = challengeState.challenge.id;
    const latch = eliminationLatchRef.current;
    if (latch && latch.challengeId === cid) {
      localEliminatedChoice = latch.eliminatedChoice;
    } else {
      const ch          = challengeState.challenge;
      const hasChoices  = !!ch.choices && ch.choices.length > 0;
      const eligible    = ch.eligiblePlayerIds.includes(myPlayerId);
      const chargesNow  = playerBonuses?.[myPlayerId]?.eliminatorCharges ?? 0;
      const chosen      = (hasChoices && eligible && chargesNow > 0)
        ? pickEliminatedWrongChoice(ch, myPlayerId)
        : null;
      eliminationLatchRef.current = { challengeId: cid, eliminatedChoice: chosen };
      localEliminatedChoice = chosen;
    }
  }

  const boardDisabled = phase !== "action";

  // Duel countdown (mirrors challenge countdown).  Null when not in duel.
  //
  // Mevzi Bekçisi: when the target region carries the bonus, `duel.endsAt`
  // is the defender's deadline (= base + 3s).  Attackers see a clock capped
  // at the base window so the timer doesn't promise time they can't use —
  // their submissions are also rejected past the cap (see submitDuelAnswer).
  // Defenders and spectators see the full extended clock so the +3s
  // advantage is honestly displayed.
  const duel = gameState.defenseDuel ?? null;
  const duelDefenderBonusMs = duel?.defenderTimeBonusMs ?? 0;
  const duelEndsAtForViewer = duel
    ? (myPlayerId === duel.attackerId
        ? duel.endsAt - duelDefenderBonusMs
        : duel.endsAt)
    : 0;
  const duelMsRemaining = phase === "defense_duel" && duel
    ? Math.max(0, duelEndsAtForViewer - now)
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

  // Per-round intro pacing (rounds 2+): challenge.startedAt is anchored
  // ROUND_INTRO_CARD_MS + ROUND_COUNTDOWN_MS into the future by
  // advanceToNextRound so the dedicated intro overlay (info card →
  // 3-2-1 countdown) gets airtime before the question and timer appear.
  // challengeState.endsAt = startedAt + duration, so no seconds tick away
  // during the intro.  Round 1 uses the game-intro flow instead.
  const roundIntroMsRemaining = Math.max(0, challengeState.startedAt - now);
  const showRoundIntro =
    phase === "challenge"
    && !showGameIntro
    && roundIntroMsRemaining > 0;
  const showRoundIntroCard      = showRoundIntro && roundIntroMsRemaining > ROUND_COUNTDOWN_MS;
  const showRoundIntroCountdown = showRoundIntro && roundIntroMsRemaining <= ROUND_COUNTDOWN_MS;
  const roundIntroCountdownNum  = showRoundIntroCountdown
    ? Math.max(1, Math.ceil(roundIntroMsRemaining / 1000))
    : 0;
  // Round intro subtitle.  When a dynamic bonus assignment exists, surface
  // the bonus region labels in the order "X · Y · Z" so the player sees at
  // a glance where this round's bonuses landed.  Falls back to the generic
  // rotating subtitles for pre-dynamic saves or when no assignment is set.
  const roundIntroBonusEntries = getActiveBonusEntries(gameState.roundBonuses);
  const roundIntroBonusLabels  = mapConfig
    ? roundIntroBonusEntries
        .map(e => {
          const region = mapConfig.regions.find(r => r.id === e.regionId);
          const label  = region?.displayLabel ?? region?.name ?? e.regionId;
          return `${e.def.icon} ${label}`;
        })
        .join(" · ")
    : "";
  const roundIntroSubtitle = roundIntroBonusLabels
    ? `Bu tur bonuslar: ${roundIntroBonusLabels}`
    : ROUND_INTRO_SUBTITLES[
        (gameState.round.roundNumber - 1) % ROUND_INTRO_SUBTITLES.length
      ];

  // ── Bonus guide (onboarding card) ────────────────────────────────────
  // Compact card listing which bonus type lives in which region this match.
  // Auto-opens once at the start of round 1 so first-time players see what
  // the bonus icons on the map mean; reopenable via the "?" header button.
  const bonusGuideEntries: ConquestBonusGuideEntry[] = mapConfig
    ? roundIntroBonusEntries.map(e => {
        const region = mapConfig.regions.find(r => r.id === e.regionId);
        const label  = region?.displayLabel ?? region?.name ?? e.regionId;
        return { regionId: e.regionId, def: e.def, regionLabel: label };
      })
    : [];
  const hasBonusGuide = bonusGuideEntries.length > 0;
  const [bonusGuideOpen, setBonusGuideOpen] = useState(false);
  const bonusGuideAutoShownRef = useRef(false);
  useEffect(() => {
    if (bonusGuideAutoShownRef.current) return;
    if (!hasBonusGuide) return;
    // Round 1 is the only auto-open moment.  Players joining mid-match see
    // the "?" button but no pop-up — the active question must stay readable.
    if (gameState?.round?.roundNumber === 1) {
      setBonusGuideOpen(true);
      bonusGuideAutoShownRef.current = true;
    }
  }, [hasBonusGuide, gameState?.round?.roundNumber]);
  const handleToggleBonusGuide = useCallback(() => {
    setBonusGuideOpen(v => !v);
  }, []);
  const handleCloseBonusGuide = useCallback(() => {
    setBonusGuideOpen(false);
  }, []);
  const bonusGuideNode = hasBonusGuide && bonusGuideOpen ? (
    <ConquestBonusGuide
      entries={bonusGuideEntries}
      onClose={handleCloseBonusGuide}
    />
  ) : null;

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
  // Capital-reveal coordination: the Ankara bonus toast is suppressed for
  // CAPITAL_REVEAL_HOLD_MS after `at` so the cinematic capital_fell signal
  // banner (rendered by useConquestSignals → ConquestSignalBanner) owns
  // the moment alone. After the hold elapses, the toast appears with its
  // remaining lifetime intact and carries the gameplay info (Gizli
  // Operasyon copy). Non-Ankara bonuses are revealed immediately.
  const [bonusToastReadyId, setBonusToastReadyId] = useState<string | null>(null);
  useEffect(() => {
    if (!lastBonusToast) {
      setBonusToastReadyId(null);
      return;
    }
    // Coordinate with the capital cinematic ONLY when the bonus actually
    // landed on the capital region for this round.  Pre-dynamic-bonus saves
    // lack `regionId` on the toast → no hold (matches legacy behaviour for
    // those rooms).  Static fallback: tie the hold to whichever region
    // currently carries the legacy ankara_hidden_shield bonus.
    const toastRegion = lastBonusToast.regionId ?? null;
    const isCapitalToast = toastRegion !== null && CAPITAL_REGION_IDS.has(toastRegion);
    if (!isCapitalToast) {
      setBonusToastReadyId(lastBonusToast.id);
      return;
    }
    const remaining = lastBonusToast.at + CAPITAL_REVEAL_HOLD_MS - Date.now();
    if (remaining <= 0) {
      setBonusToastReadyId(lastBonusToast.id);
      return;
    }
    setBonusToastReadyId(null);
    const t = window.setTimeout(
      () => setBonusToastReadyId(lastBonusToast.id),
      remaining,
    );
    return () => window.clearTimeout(t);
  }, [lastBonusToast?.id, lastBonusToast?.at, lastBonusToast?.regionId]);
  const showBonusToast =
    !!lastBonusToast
    && dismissedToastId   !== lastBonusToast.id
    && bonusToastReadyId  === lastBonusToast.id;
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

  /* Challenge winner attribution — drives the post-finalize UX so a player
   * who answered correctly but lost the race understands *why* the turn
   * went to the opponent. winnerPlayerId stays populated on the round
   * snapshot after the phase transitions to "action", so we can derive
   * this purely from synced state. */
  const challengeWinnerId = gameState.round.challenge.winnerPlayerId ?? null;
  const challengeWinner   = challengeWinnerId
    ? players.find(p => p.id === challengeWinnerId) ?? null
    : null;
  const challengeWinnerName = challengeWinner?.name ?? null;
  const iSubmittedCorrectThisRound =
    localFeedback === "correct"
    && answeredChallengeId === gameState.round.challenge.challenge.id;
  const iWonChallenge =
    !!myPlayerId && !!challengeWinnerId && challengeWinnerId === myPlayerId;
  const showCorrectButLost =
    iSubmittedCorrectThisRound && !iWonChallenge && !!challengeWinnerName;

  /* Reveal-phase answer copy.
   *
   * Single-canonical challenges (quiz, flag_guess) have one "correct"
   * string — `acceptedAnswers[0]` is authoritative.
   *
   * `type_race` ("Ülke Yaz") is multi-canonical: every entry in
   * `acceptedAnswers` is equally correct.  Showing `[0]` made the panel
   * lie when the winner typed a different valid country (e.g. winner
   * typed "Belarus" but the reveal claimed "Doğru cevap: Brezilya").  For
   * type_race we therefore prefer the winner's actual submission, falling
   * back to a short list of example accepted answers when nobody got it.
   */
  const challengeForReveal = gameState.round.challenge.challenge;
  const winningSubmission = challengeWinnerId
    ? gameState.round.challenge.submittedAnswers.find(
        a => a.playerId === challengeWinnerId && a.correct,
      ) ?? null
    : null;
  const canonicaliseRaceAnswer = (raw: string): string => {
    const norm = normaliseAnswer(raw);
    if (!norm) return raw.trim();
    const match = challengeForReveal.acceptedAnswers?.find(
      a => normaliseAnswer(a) === norm,
    );
    return match ?? raw.trim();
  };
  const challengeCorrectAnswer: string | null = (() => {
    const accepted = challengeForReveal.acceptedAnswers;
    if (!accepted || accepted.length === 0) return null;
    if (challengeForReveal.type === "type_race") {
      if (winningSubmission?.answer) {
        return canonicaliseRaceAnswer(winningSubmission.answer);
      }
      return null;
    }
    return accepted[0];
  })();
  const challengeAnswerExamples: string[] =
    challengeForReveal.type === "type_race"
      && !challengeCorrectAnswer
      && challengeForReveal.acceptedAnswers
      ? challengeForReveal.acceptedAnswers.slice(0, 3)
      : [];

  /* Reveal-phase countdown — drives the small "Xsn" chip on the reveal
   * panel.  Null outside the reveal phase / for pre-reveal rooms without a
   * revealEndsAt stamp. */
  const revealSecondsLeft = (() => {
    if (phase !== "reveal") return null;
    const endsAt = gameState.round.revealEndsAt;
    if (typeof endsAt !== "number") return null;
    return Math.max(0, Math.ceil((endsAt - now) / 1000));
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
        viewerIsHolder={isActionHolder}
        roundBonuses={gameState.roundBonuses}
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
          viewerIsHolder={isActionHolder}
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
      viewerIsHolder={isActionHolder}
    />
  );

  // ── Toasts (shared across desktop and mobile) ──────────────────────
  // Stay `position: fixed` for both branches; the mobile shell will get
  // a queued toast slot in a later step.
  const toastsNode = (
    <>
      {/* Bonus toast (transient, centered) */}
      {showBonusToast && lastBonusToast && (() => {
        const toastRegion = lastBonusToast.regionId
          ? mapConfig?.regions.find(r => r.id === lastBonusToast.regionId) ?? null
          : null;
        const toastRegionLabel = toastRegion?.displayLabel ?? toastRegion?.name ?? null;
        const copy = getBonusToastCopyForViewer(lastBonusToast, myPlayerId, toastRegionLabel);
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
            <div className="cq-bonus-toast-title">Kuşatma başlıyor</div>
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

      {/* Round intro: "Tur N Başlıyor" info card (4s) → 3-2-1 countdown (3s).
       *  Fires for rounds 2+ only — round 1 uses the game-intro flow above.
       *  Challenge panel and timer are suppressed until the countdown ends
       *  (challenge.startedAt anchors the question reveal). */}
      {showRoundIntroCard && (
        <div
          className="cq-duel-overlay-toast cq-round-intro-overlay"
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">🚩</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">
              Tur {gameState.round.roundNumber} Başlıyor
            </div>
            <div className="cq-bonus-toast-detail">
              {roundIntroSubtitle}
            </div>
          </div>
        </div>
      )}
      {showRoundIntroCountdown && (
        <div
          className="cq-duel-overlay-toast cq-duel-countdown-overlay"
          role="status"
          aria-live="polite"
          aria-label="Tur geri sayımı"
        >
          <div className="cq-duel-countdown-inner">
            <div className="cq-duel-countdown-label">Yeni soru hazırlanıyor</div>
            <div key={roundIntroCountdownNum} className="cq-duel-countdown-number">
              {roundIntroCountdownNum}
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
            {duelDefenderBonusMs > 0 && (
              <div
                className="cq-duel-mevzi-chip"
                role="note"
                aria-label="Mevzi Bekçisi avantajı"
              >
                🏰 Mevzi Bekçisi: Savunmacıya +{Math.round(duelDefenderBonusMs / 1000)} sn
              </div>
            )}
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

      {/* Reveal/results card — premium center overlay shown for
       *  CONQUEST_REVEAL_DURATION_MS between the question and the move
       *  phase.  Same `position: fixed` chrome as the other duel overlays
       *  so it stays above the map without occluding it. */}
      {phase === "reveal" && (
        <div
          className="cq-duel-overlay-toast cq-reveal-overlay"
          role="status"
          aria-live="polite"
          aria-label="Soru sonucu"
        >
          <div className="cq-reveal-card-head">
            <span className="cq-reveal-card-chip">SONUÇ</span>
            {revealSecondsLeft !== null && (
              <span
                className="cq-reveal-card-countdown"
                data-low={revealSecondsLeft <= 1 ? "true" : undefined}
                aria-label="Reveal kalan süre"
              >
                {revealSecondsLeft}sn
              </span>
            )}
          </div>
          {challengeCorrectAnswer ? (
            <p className="cq-reveal-card-line cq-reveal-card-answer">
              Doğru cevap: <strong>{challengeCorrectAnswer}</strong>
            </p>
          ) : challengeAnswerExamples.length > 0 ? (
            <p className="cq-reveal-card-line cq-reveal-card-answer">
              Geçerli cevap örnekleri:{" "}
              <strong>{challengeAnswerExamples.join(", ")}</strong>
            </p>
          ) : null}
          {challengeWinnerName ? (
            <>
              <p className="cq-reveal-card-line cq-reveal-card-winner">
                🏆 İlk doğru cevap:{" "}
                <strong>
                  {iWonChallenge ? "sen" : challengeWinnerName}
                </strong>
              </p>
              {showCorrectButLost && (
                <p className="cq-reveal-card-line cq-reveal-card-second">
                  ✅ Doğru bildin, ama ilk cevap{" "}
                  <strong>{challengeWinnerName}</strong> tarafından verildi.
                </p>
              )}
              <p className="cq-reveal-card-line cq-reveal-card-turn">
                Hamle hakkı:{" "}
                <strong>
                  {iWonChallenge ? "sen" : challengeWinnerName}
                </strong>
              </p>
            </>
          ) : (
            <>
              <p className="cq-reveal-card-line cq-reveal-card-miss">
                Doğru cevap gelmedi.
              </p>
              <p className="cq-reveal-card-line cq-reveal-card-turn cq-reveal-card-turn--miss">
                Hamle yapılamadı.
              </p>
            </>
          )}
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
  //   130  reveal                (Soru sonuç kartı — 3s, gameplay-critical)
  //   125  round-intro-countdown (3-2-1 between rounds 2+, before question)
  //   120  game-intro-countdown  (3-2-1 at game start)
  //   115  round-intro           (🚩 Tur N Başlıyor card — 4s)
  //   110  game-intro            (⚔️ Kuşatma başlıyor card)
  //   100  duel-countdown        (3-2-1 just before the duel question shows)
  //    90  duel-intro            ("Savunma Düellosu Başladı" detail card)
  //    80  hidden-op             ("Gizli Operasyon Başlatıldı" — 7s)
  //    70  duel-result           ("Bölge Savunuldu" / "Kalkan Kırıldı" — 4s)
  //    50  bonus                 (Çukurova / Karadeniz / İstanbul — 4.5s)
  //
  // Time-locked duel-* specs win against the informational toasts so
  // they never queue behind a 4.5 s bonus card and miss their window.
  // Reveal sits at the top — it's the gameplay-critical "kim hamle yapacak"
  // moment that everyone needs to read before the action phase begins.
  const mobileToastSpecs: MobileToastSpec[] = [];
  if (phase === "reveal") {
    mobileToastSpecs.push({
      id:        `reveal:${challengeState.challenge.id}`,
      kind:      "reveal",
      priority:  130,
      className: "cq-duel-overlay-toast cq-reveal-overlay",
      ariaLabel: "Soru sonucu",
      content: (
        <>
          <div className="cq-reveal-card-head">
            <span className="cq-reveal-card-chip">SONUÇ</span>
            {revealSecondsLeft !== null && (
              <span
                className="cq-reveal-card-countdown"
                data-low={revealSecondsLeft <= 1 ? "true" : undefined}
              >
                {revealSecondsLeft}sn
              </span>
            )}
          </div>
          {challengeCorrectAnswer ? (
            <p className="cq-reveal-card-line cq-reveal-card-answer">
              Doğru cevap: <strong>{challengeCorrectAnswer}</strong>
            </p>
          ) : challengeAnswerExamples.length > 0 ? (
            <p className="cq-reveal-card-line cq-reveal-card-answer">
              Geçerli cevap örnekleri:{" "}
              <strong>{challengeAnswerExamples.join(", ")}</strong>
            </p>
          ) : null}
          {challengeWinnerName ? (
            <>
              <p className="cq-reveal-card-line cq-reveal-card-winner">
                🏆 İlk doğru cevap:{" "}
                <strong>
                  {iWonChallenge ? "sen" : challengeWinnerName}
                </strong>
              </p>
              {showCorrectButLost && (
                <p className="cq-reveal-card-line cq-reveal-card-second">
                  ✅ Doğru bildin, ama ilk cevap{" "}
                  <strong>{challengeWinnerName}</strong> tarafından verildi.
                </p>
              )}
              <p className="cq-reveal-card-line cq-reveal-card-turn">
                Hamle hakkı:{" "}
                <strong>
                  {iWonChallenge ? "sen" : challengeWinnerName}
                </strong>
              </p>
            </>
          ) : (
            <>
              <p className="cq-reveal-card-line cq-reveal-card-miss">
                Doğru cevap gelmedi.
              </p>
              <p className="cq-reveal-card-line cq-reveal-card-turn cq-reveal-card-turn--miss">
                Hamle yapılamadı.
              </p>
            </>
          )}
        </>
      ),
    });
  }
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
  if (showRoundIntroCountdown) {
    mobileToastSpecs.push({
      id:        `round-intro-countdown:${gameState.round.roundNumber}`,
      kind:      "round-intro-countdown",
      priority:  125,
      className: "cq-duel-overlay-toast cq-duel-countdown-overlay",
      ariaLabel: "Tur geri sayımı",
      content: (
        <div className="cq-duel-countdown-inner">
          <div className="cq-duel-countdown-label">Yeni soru hazırlanıyor</div>
          <div key={roundIntroCountdownNum} className="cq-duel-countdown-number">
            {roundIntroCountdownNum}
          </div>
        </div>
      ),
    });
  }
  if (showRoundIntroCard) {
    mobileToastSpecs.push({
      id:        `round-intro-card:${gameState.round.roundNumber}`,
      kind:      "round-intro",
      priority:  115,
      className: "cq-duel-overlay-toast cq-round-intro-overlay",
      content: (
        <>
          <span className="cq-bonus-toast-icon" aria-hidden="true">🚩</span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">
              Tur {gameState.round.roundNumber} Başlıyor
            </div>
            <div className="cq-bonus-toast-detail">
              {roundIntroSubtitle}
            </div>
          </div>
        </>
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
    const toastRegion = lastBonusToast.regionId
      ? mapConfig?.regions.find(r => r.id === lastBonusToast.regionId) ?? null
      : null;
    const toastRegionLabel = toastRegion?.displayLabel ?? toastRegion?.name ?? null;
    const copy = getBonusToastCopyForViewer(lastBonusToast, myPlayerId, toastRegionLabel);
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
      {phase === "challenge" && !hiddenOpToast && !showGameIntro && !showRoundIntro && (
        <ConquestChallengePanel
          challengeState={challengeState}
          players={players}
          playerColors={playerColors}
          myPlayerId={myPlayerId}
          alreadyAnswered={
            answeredChallengeId === challengeState.challenge.id
          }
          msRemaining={Math.max(0, challengeState.endsAt - now)}
          onSubmitAnswer={handleSubmitAnswer}
          eliminatedChoice={localEliminatedChoice}
        />
      )}

      {/* Reveal phase intentionally renders no panel content here — the
       *  result card is a centered overlay (see cq-reveal-overlay below)
       *  so it doesn't get buried in the side card or mobile sheet body. */}

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
        <section
          className="cq-action-panel cq-action-panel--waiting"
          data-active="false"
          aria-label="Hamle paneli"
        >
          <div className="cq-action-head">
            <span
              className="cq-action-holder-chip cq-action-holder-chip--waiting"
              data-color={actionHolder ? (playerColors[actionHolder.id] ?? undefined) : undefined}
            >
              <span className="cq-action-holder-dot" aria-hidden="true" />
              <span className="cq-action-holder-name">
                {actionHolder?.name ?? "Rakip"}
              </span>
              <span className="cq-action-holder-tag">⏳ SIRADA</span>
            </span>
          </div>
          <p className="cq-action-hint cq-action-hint--waiting" role="status">
            {moveSecondsLeft !== null
              ? `Bekleniyor… (${moveSecondsLeft}sn)`
              : "Bekleniyor…"}
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
          effectiveEndsAt={duelEndsAtForViewer}
          defenderTimeBonusMs={duelDefenderBonusMs}
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

  // Turn-ownership attribute used by the dock + sheet styling. "mine" lights
  // up the active-turn glow; "theirs" mutes the panel. Only set during the
  // action phase — the other phases own their own visual states.
  const turnAttr: "mine" | "theirs" | undefined =
    phase === "action" ? (isActionHolder ? "mine" : "theirs") : undefined;

  // ── Desktop overlays: toasts + the legacy floating phase card + feed.
  const overlaysNode = (
    <>
      {toastsNode}
      <ConquestSignalBanner signal={activeSignal} />
      <div className="cq-game-phase-panel" data-phase={phase} data-turn={turnAttr}>
        {phasePanelContent}
      </div>
      <ConquestEventFeed events={eventFeedEntries} variant="desktop" />
      {bonusGuideNode}
    </>
  );

  // ── Landscape mobile dock content (Step 7) ────────────────────────
  // The same `phasePanelContent` that fills the portrait sheet body
  // renders inside the landscape dock as a flat HUD section — the dock
  // chrome comes from `.mcq-dock-slot`, so we drop the floating-panel
  // wrapper here. `data-phase` is preserved so phase-specific styling
  // (e.g. duel red accent) keeps working.
  const landscapeDockNode = (
    <div className="mcq-dock-panel" data-phase={phase} data-turn={turnAttr}>
      {phasePanelContent}
      <ConquestEventFeed events={eventFeedEntries} variant="landscape-dock" />
    </div>
  );

  // Signal banner is position:fixed + pointer-events:none, so it can sit
  // alongside the rest of the mobile overlays without participating in
  // sheet/dock layout. Same node served to both portrait and landscape.
  const signalBannerNode = (
    <ConquestSignalBanner signal={activeSignal} />
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
  } else if (phase === "reveal") {
    // Body content is intentionally empty during reveal — the centered
    // overlay card owns the moment. Collapse the sheet so it doesn't
    // claim screen space while the card is on screen.
    mobileSheetState = "collapsed";
    mobileSheetDismissible = false;
    mobileSheetHandle = (
      <>
        <span className="mcq-sheet-handle-title">Sonuç</span>
        {revealSecondsLeft !== null && (
          <span
            className="mcq-sheet-handle-timer"
            data-low={revealSecondsLeft <= 1 ? "true" : undefined}
          >
            {revealSecondsLeft}sn
          </span>
        )}
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
      {signalBannerNode}
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
      {bonusGuideNode}
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
              onHelp={hasBonusGuide ? handleToggleBonusGuide : undefined}
              helpActive={bonusGuideOpen}
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
              : (
                  <>
                    {mobileToastsNode}
                    {signalBannerNode}
                    {bonusGuideNode}
                  </>
                )
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

        <div className="cq-game-header-actions">
          <ConquestVolumeControl variant="desktop" />
          {hasBonusGuide ? (
            <button
              type="button"
              className="cq-help-btn"
              onClick={handleToggleBonusGuide}
              aria-label="Bonus rehberi"
              aria-pressed={bonusGuideOpen}
              title="Bonus rehberi"
            >
              ?
            </button>
          ) : null}
        </div>
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
          // Icons follow the bonus *type*, not a fixed region — the type is
          // canonical (open shield / time bonus / hidden op), even when the
          // round assignment shifts which region carries it.
          const istanbulPres   = getBonusTypePresentation("istanbul_defense");
          const karadenizPres  = getBonusTypePresentation("karadeniz_extra_time");
          const ankaraPres     = getBonusTypePresentation("ankara_hidden_shield");
          const eliminatorPres = getBonusTypePresentation("eleme_yetkisi");
          if (openShieldOwners.has(player.id)) {
            bonusChips.push({ key: "ist", icon: istanbulPres.icon, title: "Açık kalkan aktif" });
          }
          if (pb.extraNextMoveMs > 0) {
            bonusChips.push({ key: "kdz", icon: karadenizPres.icon, title: `${karadenizPres.label} (+${Math.round(pb.extraNextMoveMs / 1000)}sn)` });
          }
          if (isMe && pb.pendingHiddenShield) {
            bonusChips.push({ key: "ank-pending", icon: ankaraPres.icon, title: "Gizli Operasyon hazır: kendi bölgene tıklarsan gizli kalkan, tarafsız bölgeye tıklarsan gizli fetih kurulur (komşuluk şartı yok)" });
          }
          if (isMe && hiddenShieldOwners.has(player.id)) {
            bonusChips.push({ key: "ank-active", icon: "🕶️", title: "Gizli Operasyon aktif (rakipler bu bölgeden habersiz)" });
          }
          if (isMe && (pb.eliminatorCharges ?? 0) > 0) {
            bonusChips.push({
              key:   "elem",
              icon:  eliminatorPres.icon,
              title: "Eleme Yetkisi hazır: sonraki test sorunda 1 yanlış şık silinir",
            });
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
