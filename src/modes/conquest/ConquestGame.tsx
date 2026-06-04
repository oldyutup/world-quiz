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
import {
  addGold,
  useGold,
  spendGoldAsync,
  CONQUEST_FATE_CARD_COST,
} from "../../lib/gold";
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
  type ConquestHiddenBonusType,
  type ConquestPendingAction,
  type ConquestPlayer,
  type ConquestPlayerHiddenBonus,
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
import {
  findRegionIdForBonusType,
  getActiveBonusEntries,
  resolveActiveBonus,
} from "./conquestRoundBonuses";
import {
  getHiddenBonusToastCopyForViewer,
  getIntelReportCopy,
} from "./conquestHiddenBonuses";
import { getQuestionPreviewLabel } from "./conquestChallenges";
import { CAPITAL_REGION_IDS, CAPITAL_REVEAL_HOLD_MS } from "./conquestCapital";
import {
  actionHolderHasNoMoves,
  advanceToNextRound,
  applyActionToGame,
  applyLanetMuhruHiddenBonus,
  applyPusuHiddenBonus,
  applySuikastHiddenBonus,
  buildFinalStandings,
  expireActionPhase,
  expireChallenge,
  expireDuel,
  finalizeReveal,
  getCurrentLegalTargets,
  getIntelNetworkOwnerId,
  getPlayerOwningAllRegions,
  GUEST_SETTLE_GRACE_MS,
  isPlayerEliminated,
  LIMAN_INCOME_GOLD,
  placeHiddenConquestOnNeutralRegion,
  placeHiddenShieldOnOwnRegion,
  ROUND_COUNTDOWN_MS,
  submitChallengeAnswer,
  submitDuelAnswer,
} from "./conquestGameplay";
import {
  canAttackRegion,
  canCaptureNeutral,
  inferActionFromRegionClick,
  isLegalTarget,
} from "./conquestActions";
import { normaliseAnswer } from "./conquestChallengeValidation";
import ConquestBoard from "./ConquestBoard";
import ConquestChallengePanel from "./ConquestChallengePanel";
import ConquestActionPanel from "./ConquestActionPanel";
import ConquestFateCardWidget from "./ConquestFateCardWidget";
import ConquestFateCardReveal from "./ConquestFateCardReveal";
import {
  applyFateCardEffectToBonuses,
  applyFateCardEffectToRound,
  drawRandomFateCard,
  FATE_REVEAL_MS,
  playerCanDrawFateCard,
} from "./conquestFateCards";
import DefenseDuelPanel from "./DefenseDuelPanel";
import TurkeyConquestMap from "./TurkeyConquestMap";
import MobileConquestLayout from "./mobile/MobileConquestLayout";
import MobileHeader from "./mobile/MobileHeader";
import MobileScoreStrip from "./mobile/MobileScoreStrip";
import MobileBonusStrip from "./mobile/MobileBonusStrip";
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
import XpGainBar from "../../components/XpGainBar";
import {
  awardXpEvent,
  calculateConquestXp,
  type ConquestXpBreakdown,
} from "../../lib/progression";
import type { Profile } from "../../lib/auth";

// Temporary diagnostic flag for desktop-vs-mobile guest panel timing.
// Read once at module init so the per-render check is a cheap boolean.
// Activate by appending `?debugConquest=1` to the URL.
const debugConquestEnabled: boolean = (() => {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("debugConquest") === "1";
  } catch {
    return false;
  }
})();

interface Props {
  /** Room code — kept for future Supabase game-room linking and chat. */
  roomCode:        string;
  /** conquest_rooms.id (UUID).  Combined with gameState.startedAt to build
   *  the stable per-match XP idempotency key. */
  roomId:          string;
  settings:        ConquestRoomSettings;
  players:         ConquestPlayer[];
  /**
   * playerId → last_seen_at ISO timestamp from conquest_players.  Used by the
   * host-only auto-finish effect to decide whether a player who's still in
   * the roster but missed heartbeats has burned through their reconnect
   * window yet.  Absent ids (player row deleted via leave) are treated as
   * "left" by the same effect.
   */
  lastSeenByPlayerId?: Record<string, string>;
  /** Synced gameplay state from conquest_rooms.gameplay_state — null while
   *  the host's initial UPDATE is in flight. */
  gameState:       ConquestGameState | null;
  isHost:          boolean;
  myPlayerId:      string | null;
  /** Logged-in profile (null for guests).  Drives the match-end XP award
   *  flow — guests skip XP entirely. */
  profile:         Profile | null;
  /** Persist a new gameplay snapshot to Supabase.  Called by transition
   *  handlers; realtime echo brings the row back to every client. */
  onPushGameState: (next: ConquestGameState) => Promise<void> | void;
  /** Finished-panel "Lobiye Dön" — switches the local view to the lobby
   *  without leaving the room and signals ready-for-next.  ConquestMode
   *  handles late-return detection (info modal) on the other side. */
  onReturnToLobby: () => void;
  /** Mid-match "Odadan Ayrıl" — leaves the room.  Used by the in-progress
   *  header back button and the leave-confirmation modal. */
  onLeaveRoom:     () => void;
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

/** Liman ⚓ capture-card flavour copy, keyed by region id and grouped by
 *  the coast that region sits on.  Used by the round_result card override
 *  (see `limanCaptureCard`) to replace the generic "Bölge Fethedildi"
 *  subtitle with a sea-flavoured line on the first capture of a Liman
 *  bonus region.  Adding a new Liman region = add its id here. */
const LIMAN_COAST_FLAVOR: Record<string, string> = {
  // Akdeniz
  bati_akdeniz:     "sıcak denizlere indi!",
  cukurova:         "sıcak denizlere indi!",
  // Ege
  guney_marmara:    "Ege Denizi'ne açılıyor!",
  kuzey_ege:        "Ege Denizi'ne açılıyor!",
  guney_ege:        "Ege Denizi'ne açılıyor!",
  // Karadeniz
  istanbul_kocaeli: "Karadeniz'in hırçın sularına açılıyor!",
  bati_karadeniz:   "Karadeniz'in hırçın sularına açılıyor!",
  orta_karadeniz:   "Karadeniz'in hırçın sularına açılıyor!",
  dogu_karadeniz:   "Karadeniz'in hırçın sularına açılıyor!",
};

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
  // Pusu 🕳️ trigger short-circuit — fires before any action-specific copy.
  // Public message is the same across action types ("Gizli pusu nedeniyle…")
  // so a single check covers attack/capture/gizli-fetih paths.
  if (msg.startsWith("🕳️")) return { icon: "🕳️", title: "Pusu Ortaya Çıktı" };
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

/**
 * Build a deterministic UUID-shaped key for the XP idempotency guard.
 *
 * The XP RPC's `(profile_id, mode_key, room_id)` UNIQUE constraint is what
 * makes the conquest XP award idempotent across re-renders and refreshes.
 * `room_id` is typed `uuid` in postgres, so we need a string in 8-4-4-4-12
 * hex format.  Two requirements:
 *   - Stable per match: same (roomId, startedAt) MUST produce the same key
 *     so a refresh-after-finish or a second realtime finished echo
 *     collapses into the SAME row.
 *   - Distinct per match: a fresh match in the same room (new startedAt)
 *     MUST produce a NEW key so the next match can award XP again.
 *
 * Implementation is a small FNV-1a 32-bit hash sampled with 4 different
 * salts → 32 hex chars → standard 8-4-4-4-12 layout.  Collision risk is
 * irrelevant for our scale (it's a uniqueness key per profile, not a
 * security primitive).
 */
function deriveConquestMatchUuid(roomId: string, startedAt: number): string {
  const fnv32 = (s: string): number => {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const seed = `${roomId}|${startedAt}`;
  const hex = [0, 1, 2, 3]
    .map(salt => fnv32(`${seed}:${salt}`).toString(16).padStart(8, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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
  roomId,
  settings,
  players,
  lastSeenByPlayerId,
  gameState: liveGameState,
  isHost,
  myPlayerId,
  profile,
  onPushGameState,
  onReturnToLobby,
  onLeaveRoom,
}: Props) {
  // ── Finished-panel snapshot lock ──────────────────────────────────────
  // Once a match enters the "finished" phase we capture the gameplay
  // state.  From then on, if the host writes a fresh state (rematch) for
  // the next round WITHOUT including this client, we keep rendering from
  // the locked snapshot so the standings UI doesn't blink to a half-
  // broken new-game screen.  The snapshot is cleared implicitly by
  // ConquestGame unmounting (ConquestMode switches us to lobby when the
  // user clicks "Lobiye Dön", or to setup when they leave).
  const lockedFinishedRef = useRef<ConquestGameState | null>(null);
  if (liveGameState?.phase === "finished" && !lockedFinishedRef.current) {
    lockedFinishedRef.current = liveGameState;
  }
  const isLateReturner =
    !!lockedFinishedRef.current &&
    !!liveGameState &&
    liveGameState.phase !== "finished" &&
    !!myPlayerId &&
    !liveGameState.players.some(p => p.id === myPlayerId);
  const gameState: ConquestGameState | null = isLateReturner
    ? lockedFinishedRef.current
    : liveGameState;

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

  // Account-level Gold (own profile) — surfaced as a small chip in the
  // header.  Updates live when Liman income credits the local owner via
  // addGold(); read-only here.  Not synced into gameplay state.
  const accountGold = useGold();

  // Region id currently flashing red after a *local* illegal click.  Stored
  // locally only — illegal clicks are not committed to gameplay_state.
  const [flashRegionId, setFlashRegionId] = useState<ConquestRegionId | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  /** Forward-reference ref to `flashIllegal` so handlers declared earlier in
   *  the component (e.g. Pusu placement) can fire the same flash effect
   *  without depending on the callback's identity in a closure. */
  const flashIllegalRef = useRef<((id: ConquestRegionId) => void) | null>(null);

  // Stable refs so timeout callbacks always see the latest values without
  // needing to be in the dependency arrays (avoids restarting timers on every
  // gameState reference change).
  const gameStateRef    = useRef<ConquestGameState | null>(null);
  const onPushStateRef  = useRef(onPushGameState);
  useEffect(() => { gameStateRef.current   = gameState;       }, [gameState]);
  useEffect(() => { onPushStateRef.current = onPushGameState; }, [onPushGameState]);

  // Wall-clock timestamp of the most recent gameState reference change.
  // Surfaced by the ?debugConquest=1 log so we can correlate "how stale is
  // the panel" against "when did the last realtime payload land".
  const lastStateReceivedAtRef = useRef<number | null>(null);
  // Monotonically incremented every time a new gameState identity arrives.
  // Acts as a synthetic "version counter" we can grep in the debug log to
  // pair host writes with guest receives in time-order.
  const gameStateUpdateCounterRef = useRef<number>(0);
  useEffect(() => {
    if (gameState) {
      lastStateReceivedAtRef.current = Date.now();
      gameStateUpdateCounterRef.current += 1;
    }
  }, [gameState]);

  // Per-client "first time I saw this challenge id" timestamp.  Used both
  // by the debug log (to surface staleness) and by the late-arrival grace
  // gate below — so a PC guest who receives the realtime payload after the
  // host's intro window already elapsed still gets a brief readable
  // "Hazırlanıyor" pause instead of a flash of the question at 0 seconds.
  const challengeFirstSeenRef = useRef<{ id: string | null; at: number }>({
    id: null,
    at: 0,
  });
  // Track previous challenge id and previous shouldShowQuestionPanel value
  // so the debug log emits on TRANSITIONS (not every render).  Render-time
  // refs are read/written below right next to where the values are derived.
  const prevDebugChallengeIdRef = useRef<string | null>(null);
  const prevDebugShouldShowPanelRef = useRef<boolean | null>(null);

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
  // Ticker. Broadened on purpose:
  //   - challenge phase ticks regardless of `status` (so round-intro pacing
  //     for rounds 2+ stays live even if the new challenge briefly arrives
  //     with a non-"active" status in transit, and so the intro window
  //     itself — where status is set but `now` still has to march toward
  //     `startedAt` — keeps re-rendering on guest clients).
  //   - defense_duel phase ticks regardless of `endsAt` (the intro/countdown
  //     window between phase entry and `questionVisibleAt` still needs `now`
  //     to advance so the duel panel can appear).
  // Previously this gated too tightly and could leave `now` frozen during a
  // phase transition; some Chromium-based browsers (Brave) then never
  // recovered, latching `showRoundIntro` / `showDuelPanel` and hiding the
  // question UI until the very end of the window.  Always-on while a
  // relevant phase is loaded is cheap and removes the failure mode.
  useEffect(() => {
    const challengeTicking = phaseForTicker === "challenge";
    const revealTicking    = phaseForTicker === "reveal";
    const actionTicking    = phaseForTicker === "action"       && actionEndsAt !== null;
    const duelTicking      = phaseForTicker === "defense_duel";
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

  // ── Hidden bonuses — Suikast inventory + target picker ─────────────
  // Only renders the consume UI for the LOCAL viewer; opponents never see
  // anyone else's hidden-bonus inventory (paranoia is the feature).  The
  // target picker state is fully local — only the `applySuikastHiddenBonus`
  // call writes synced state, and only when the user confirms a target.
  const myUnusedSuikastEntries = useMemo(() => {
    if (!myPlayerId) return [];
    const bag = gameState?.playerHiddenBonuses?.[myPlayerId] ?? [];
    return bag.filter(e => !e.used && e.type === "suikast");
  }, [gameState?.playerHiddenBonuses, myPlayerId]);
  // Picker state: the bonus entry id whose target the user is choosing.
  // Null when the picker is closed.  Cleared after a successful use, on
  // cancel, or when the underlying entry vanishes (e.g. realtime echo).
  const [suikastPickerEntryId, setSuikastPickerEntryId] = useState<string | null>(null);
  useEffect(() => {
    if (!suikastPickerEntryId) return;
    const stillPresent = myUnusedSuikastEntries.some(e => e.id === suikastPickerEntryId);
    if (!stillPresent) setSuikastPickerEntryId(null);
  }, [suikastPickerEntryId, myUnusedSuikastEntries]);

  const handleUseSuikast = useCallback((bonusEntryId: string, targetId: string) => {
    if (!gameState || !myPlayerId) return;
    if (targetId === myPlayerId) return;
    const next = applySuikastHiddenBonus(gameState, myPlayerId, bonusEntryId, targetId);
    if (next === gameState) return;
    setSuikastPickerEntryId(null);
    void onPushGameState(next);
  }, [gameState, myPlayerId, onPushGameState]);

  // ── Hidden bonuses — Lanet Mührü inventory + target picker ─────────
  // Mirrors the Suikast wiring: local-viewer only, opponents never see anyone
  // else's inventory.  The use call writes synced state ONLY on confirm.
  const myUnusedLanetEntries = useMemo(() => {
    if (!myPlayerId) return [];
    const bag = gameState?.playerHiddenBonuses?.[myPlayerId] ?? [];
    return bag.filter(e => !e.used && e.type === "lanet_muhru");
  }, [gameState?.playerHiddenBonuses, myPlayerId]);
  const [lanetPickerEntryId, setLanetPickerEntryId] = useState<string | null>(null);
  useEffect(() => {
    if (!lanetPickerEntryId) return;
    const stillPresent = myUnusedLanetEntries.some(e => e.id === lanetPickerEntryId);
    if (!stillPresent) setLanetPickerEntryId(null);
  }, [lanetPickerEntryId, myUnusedLanetEntries]);

  const handleUseLanetMuhru = useCallback((bonusEntryId: string, targetId: string) => {
    if (!gameState || !myPlayerId) return;
    if (targetId === myPlayerId) return;
    const next = applyLanetMuhruHiddenBonus(gameState, myPlayerId, bonusEntryId, targetId);
    if (next === gameState) return;
    setLanetPickerEntryId(null);
    void onPushGameState(next);
  }, [gameState, myPlayerId, onPushGameState]);

  // ── Hidden bonuses — Pusu placement mode ───────────────────────────
  // Pusu chooses a REGION (not a player target) so the UI flow is a
  // "placement mode" toggle instead of a modal picker.  While the mode
  // is active, the map's legal-affordance set is replaced with the
  // owner's ambush-eligible regions; tapping one of them commits.
  // Eligibility rules (mirrored exactly by the pure helper
  // `usePusuHiddenBonus`): owner-self or neutral; never enemy; never a
  // capital; never a region that already carries an active ambush.
  const myUnusedPusuEntries = useMemo(() => {
    if (!myPlayerId) return [];
    const bag = gameState?.playerHiddenBonuses?.[myPlayerId] ?? [];
    return bag.filter(e => !e.used && e.type === "pusu");
  }, [gameState?.playerHiddenBonuses, myPlayerId]);
  const [pusuPlacementEntryId, setPusuPlacementEntryId] = useState<string | null>(null);
  useEffect(() => {
    if (!pusuPlacementEntryId) return;
    const stillPresent = myUnusedPusuEntries.some(e => e.id === pusuPlacementEntryId);
    if (!stillPresent) setPusuPlacementEntryId(null);
  }, [pusuPlacementEntryId, myUnusedPusuEntries]);
  // Auto-exit placement mode if the match finishes or the viewer changes.
  useEffect(() => {
    if (!pusuPlacementEntryId) return;
    if (gameState?.phase === "finished") setPusuPlacementEntryId(null);
  }, [pusuPlacementEntryId, gameState?.phase]);

  /** Region ids the local viewer can legally place a Pusu on RIGHT NOW.
   *  Owner-self or neutral (truly null owner), never capital, never
   *  already-ambushed.  Derived from REAL regionStates so projection
   *  never leaks (the viewer is the owner anyway, so they see truth). */
  const pusuPlacementCandidates = useMemo(() => {
    if (!gameState || !myPlayerId) return new Set<ConquestRegionId>();
    const existingAmbushes = gameState.activeHiddenEffects?.ambushes ?? {};
    const out = new Set<ConquestRegionId>();
    for (const rs of gameState.regionStates) {
      if (CAPITAL_REGION_IDS.has(rs.regionId)) continue;
      if (existingAmbushes[rs.regionId])       continue;
      if (rs.ownerPlayerId !== null && rs.ownerPlayerId !== myPlayerId) continue;
      out.add(rs.regionId);
    }
    return out;
  }, [gameState, myPlayerId]);

  const handlePlaceAmbush = useCallback((regionId: ConquestRegionId) => {
    if (!gameState || !myPlayerId || !pusuPlacementEntryId) return;
    if (!pusuPlacementCandidates.has(regionId)) {
      flashIllegalRef.current?.(regionId);
      return;
    }
    const next = applyPusuHiddenBonus(gameState, myPlayerId, pusuPlacementEntryId, regionId);
    if (next === gameState) {
      flashIllegalRef.current?.(regionId);
      return;
    }
    setPusuPlacementEntryId(null);
    playSound("click");
    void onPushGameState(next);
  }, [gameState, myPlayerId, pusuPlacementEntryId, pusuPlacementCandidates, onPushGameState]);

  /** Region ids the local viewer has armed with a Pusu.  Used to render an
   *  owner-only marker on the map — opponents NEVER see these.  Empty when
   *  no ambush is armed by this viewer (the common case for non-Pusu
   *  matches). */
  const myAmbushRegionIds = useMemo(() => {
    if (!gameState || !myPlayerId) return new Set<ConquestRegionId>();
    const out = new Set<ConquestRegionId>();
    const ambushes = gameState.activeHiddenEffects?.ambushes ?? {};
    for (const [regionId, ambush] of Object.entries(ambushes)) {
      if (ambush.ownerPlayerId === myPlayerId) out.add(regionId);
    }
    return out;
  }, [gameState?.activeHiddenEffects, myPlayerId]);

  // ── DEV-ONLY: inject a hidden bonus directly into local player's inventory ─
  const handleDebugGiveBonus = useCallback((type: ConquestHiddenBonusType) => {
    if (!gameState || !myPlayerId) return;
    const now = Date.now();
    const entry: ConquestPlayerHiddenBonus = {
      id:              `hb-debug-${type}-${now}-${myPlayerId}`,
      type,
      used:            false,
      claimedRegionId: "__debug__",
      claimedRound:    gameState.round.roundNumber,
    };
    const currentInventory = gameState.playerHiddenBonuses ?? {};
    const currentBag = currentInventory[myPlayerId] ?? [];
    const next: ConquestGameState = {
      ...gameState,
      playerHiddenBonuses: {
        ...currentInventory,
        [myPlayerId]: [...currentBag, entry],
      },
    };
    void onPushGameState(next);
  }, [gameState, myPlayerId, onPushGameState]);

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

  // Kâhin Büyüsü 🔮 — preview of the *current* round's challenge type, shown
  // only to the player who currently holds the Kâhin region.
  //
  // Correctness contract: the label is derived strictly from the same
  // ConquestChallenge object that is mounted on screen for this round
  // (`gameState.round.challenge.challenge`).  No independent type-prediction,
  // no Math.random pick, no inference from `lastChallengeType` or
  // `nextChallenge` (which is the round-after-this pre-pick) — the preview
  // and the on-screen question share one source object, so they can never
  // disagree and the preview is never a round ahead.
  //
  // Anti-leak: the label intentionally never carries prompt/answer content;
  // we resolve the region owner from real (unprojected) regionStates so the
  // chip doesn't accidentally surface on a viewer projection that masks the
  // true owner.  Returns null when no challenge is mounted yet, no region
  // carries the bonus, or the local viewer is not the bonus holder (lost
  // the region → no more vision).
  const kahinPreview = useMemo(() => {
    const current = gameState?.round.challenge?.challenge;
    if (!current) return null;
    if (!myPlayerId) return null;
    const kahinRegionId = findRegionIdForBonusType(gameState?.roundBonuses, "kahin");
    if (!kahinRegionId) return null;
    const rs = gameState?.regionStates.find(r => r.regionId === kahinRegionId);
    if (!rs || rs.ownerPlayerId !== myPlayerId) return null;
    return getQuestionPreviewLabel(current);
  }, [gameState?.round.challenge, gameState?.roundBonuses, gameState?.regionStates, myPlayerId]);

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

  // ── XP: oyun bitince bir kez yaz (sadece giriş yapmış kullanıcı) ──
  // Same pattern as FlagDuelGame: server-side idempotency on
  // (profile_id, mode_key, room_id), client-side ref to skip re-renders.
  // The match-level room_id is derived deterministically from
  // (conquest_rooms.id, gameState.startedAt) so a fresh match in the same
  // room produces a NEW key, but the SAME match (refresh, late finished
  // realtime echo) keeps the same key → no duplicate insert.
  const [xpResult, setXpResult] = useState<{
    awarded:     boolean;
    xpEarned:    number;
    prevTotalXp: number;
    totalXp:     number;
    prevModeXp:  number;
    modeXp:      number;
    breakdown:   ConquestXpBreakdown;
    roomKey:     string;
    dismissed:   boolean;
  } | null>(null);
  const xpAwardedRef = useRef<string | null>(null);
  const isLoggedInPlayer = !!profile?.id;

  const matchKey = useMemo(() => {
    const startedAt = gameState?.startedAt ?? 0;
    if (!roomId || !startedAt) return null;
    return deriveConquestMatchUuid(roomId, startedAt);
  }, [roomId, gameState?.startedAt]);

  const finishedPhase = gameState?.phase === "finished";
  const finishReason  = gameState?.finishReason ?? null;
  const winnerPlayerId = gameState?.winnerPlayerId ?? null;

  useEffect(() => {
    if (!finishedPhase) return;
    if (!isLoggedInPlayer || !profile?.id) return;
    if (!myPlayerId) return;
    if (!matchKey) return;
    // Per-match guard: same match → exit; new match → fall through.
    if (xpAwardedRef.current === matchKey) return;
    xpAwardedRef.current = matchKey;

    const myStanding = standings.find(r => r.playerId === myPlayerId);
    if (!myStanding) {
      // Player not in standings (shouldn't happen if they're in players[]).
      // Don't lock the ref forever — release so a later realtime update can retry.
      xpAwardedRef.current = null;
      return;
    }

    const totalPlayers = standings.length;
    const finalRank    = myStanding.rank;
    // Draw: top points/regions shared at rank 1 and no walkover override.
    const top = standings[0];
    const isDraw = !winnerPlayerId
      && standings.filter(r => r.rank === 1).length > 1
      && top?.rank === 1;

    const breakdown = calculateConquestXp({
      finalRank,
      totalPlayers,
      finishReason,
      isDraw,
    });

    const matchResult =
      breakdown.resultBonusLabel === "win"
        ? "win"
        : breakdown.resultBonusLabel === "draw"
          ? "draw"
          : "loss";

    const profileId = profile.id;
    const xpRoomId  = matchKey;

    (async () => {
      const res = await awardXpEvent({
        profileId,
        modeKey:  "conquest",
        roomId:   xpRoomId,
        xpEarned: breakdown.total,
        result:   matchResult,
        details: {
          final_rank:    finalRank,
          total_players: totalPlayers,
          finish_reason: finishReason,
          is_draw:       isDraw,
          breakdown,
          real_room_id:  roomId,
        },
      });

      if (res.error) {
        xpAwardedRef.current = null;
        console.error("[ConquestGame] XP yazılamadı:", res.error);
        return;
      }

      const prevModeXp  = res.awarded ? Math.max(0, res.modeXp  - res.xpEarned) : res.modeXp;
      const prevTotalXp = res.awarded ? Math.max(0, res.totalXp - res.xpEarned) : res.totalXp;

      setXpResult({
        awarded:     res.awarded,
        xpEarned:    res.xpEarned,
        prevTotalXp,
        totalXp:     res.totalXp,
        prevModeXp,
        modeXp:      res.modeXp,
        breakdown,
        roomKey:     matchKey,
        dismissed:   false,
      });
    })();
    // standings is derived from gameState, finishReason/winnerPlayerId are
    // primitives; matchKey changes only when a new match starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedPhase, matchKey, isLoggedInPlayer, profile?.id, myPlayerId]);

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
  /* Finished-panel button — purely a view switch on the player's side;
   * ConquestMode decides whether to accept (broadcast ready) or to
   * surface the late-return modal because a new game already started. */
  function handleReturnToLobby() {
    playSound("click");
    onReturnToLobby();
  }

  /* Mid-match leave guard.  A single active survivor wins automatically
   * (see conquestGameSync), so a stray tap on the back arrow can throw a
   * real match.  We gate every active-play exit through requestBack: it
   * opens the confirm modal only while a match is in progress, and falls
   * through to onLeaveRoom on the pre-sync safety screens (where
   * gameState is null).  The finished panel uses its own dedicated
   * "Lobiye Dön" button — it never routes through this leave path. */
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);

  // Elimination — the local viewer just dropped to 0 regions.  Modal shows
  // once until dismissed (V1: per-mount, no persistence; reconnects will
  // re-show it which we consider acceptable for the spectator flow).
  const localEliminated =
    !!gameState && !!myPlayerId && isPlayerEliminated(gameState, myPlayerId);
  const [eliminationModalDismissed, setEliminationModalDismissed] = useState(false);
  // Reset the dismissed flag if the player somehow re-enters a fresh match
  // (matchKey-driven) so the modal can re-appear if needed in a new room.
  useEffect(() => {
    if (!localEliminated) setEliminationModalDismissed(false);
  }, [localEliminated]);

  function isMatchInProgress(): boolean {
    if (!gameState) return false;
    const p = gameState.phase;
    return p !== "finished" && p !== "setup";
  }

  function requestBack() {
    if (isMatchInProgress()) {
      playSound("click");
      setConfirmLeaveOpen(true);
      return;
    }
    // Pre-sync / setup safety screen (gameState null) — straight out.
    playSound("click");
    onLeaveRoom();
  }

  function cancelLeave() {
    playSound("click");
    setConfirmLeaveOpen(false);
  }

  function confirmLeave() {
    setConfirmLeaveOpen(false);
    onLeaveRoom();
  }

  // ESC closes the confirm modal (treated as "Vazgeç").  Listener only
  // mounts while open so we don't intercept other ESC-driven UI.
  useEffect(() => {
    if (!confirmLeaveOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setConfirmLeaveOpen(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmLeaveOpen]);

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
    // Host holds the expire write for GUEST_SETTLE_GRACE_MS past the
    // synced `endsAt` so late-arriving guests — whose effective answer
    // window is reckoned from when they first saw the challenge rather
    // than the host's startedAt — get a real chance to submit before
    // the phase advances.  The "all answered" fast-path effect below
    // still snaps to reveal the instant everyone has submitted.
    const delay  = Math.max(0, endsAt + GUEST_SETTLE_GRACE_MS - Date.now());
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

  // ── Host-only: auto-finish when a single active player remains ─────────
  // Eğer maç başladıktan sonra rakipler ya bilinçli leave ile player rowunu
  // sildirip listeden düşerse, ya da heartbeat'i durup 60 sn boyunca dönmezse
  // (tarayıcı kapatma / internet kopması), kalan tek aktif oyuncuyu otomatik
  // kazanan olarak işaretliyoruz.
  //
  // Aktif oyuncu tanımı:
  //   • match.players içinde olacak (lobby'de değil, maçta başladı),
  //   • players prop'unda (live conquest_players roster) hâlâ var olacak,
  //   • last_seen_at son `RECONNECT_TOLERANCE_MS` içinde olacak.
  // Bu üç koşulu sağlayan oyuncular kümesi 1 elemana inerse, finish.
  //
  // 60 sn'lik reconnect penceresi: ani kopmalarda oyuncuya geri dönme şansı
  // vermek için sadece last_seen_at eski (> 60 sn) olduğunda stale sayıyoruz.
  // Heartbeat hâlâ canlıysa stale sayılmaz; oyun olduğu gibi devam eder.
  //
  // Re-check kadansı: roster veya last_seen_at değiştiğinde anında, ek olarak
  // 5 sn'de bir poll — böylece stale eşiği gerçek zamanlı yakalanır.
  const RECONNECT_TOLERANCE_MS = 60_000;
  const matchPlayerIdsKey = useMemo(
    () => (gameState?.players ?? []).map(p => p.id).sort().join(","),
    [gameState?.players],
  );
  const lastSeenSig = useMemo(
    () => Object.entries(lastSeenByPlayerId ?? {})
      .map(([id, ts]) => `${id}:${ts}`)
      .sort()
      .join("|"),
    [lastSeenByPlayerId],
  );
  const presentPlayerIdsKey = useMemo(
    () => players.map(p => p.id).sort().join(","),
    [players],
  );
  useEffect(() => {
    const phase = gameState?.phase;
    // Only run after the match has actually started and before it ends.
    // Lobby aşaması (no gameState) ve normal/early finish dışarıda tutulur,
    // double-finish hiç yazılmaz.
    if (!gameState) return;
    if (phase === "setup" || phase === "finished") return;
    const matchPlayers = gameState.players;
    if (matchPlayers.length < 2) return;

    // Writer gate: the host is the canonical writer (matches the rest of the
    // timer-driven flow), BUT if the host itself disconnected/stale, the
    // lone surviving player has to be allowed to rescue the match too —
    // otherwise an absent host blocks the finish forever (no host transfer
    // system in Phase 9.x).  We tolerate the (very narrow) race of "host +
    // last player both write" via idempotency on `phase === 'finished'`
    // plus the canonical winnerPlayerId.
    const check = () => {
      const gs = gameStateRef.current;
      if (!gs) return;
      if (gs.phase === "finished" || gs.phase === "setup") return;
      const now = Date.now();
      const presentIds = new Set(players.map(p => p.id));
      const active = gs.players.filter(p => {
        if (!presentIds.has(p.id)) return false; // explicit leave → removed from roster
        const ts = lastSeenByPlayerId?.[p.id];
        if (!ts) return false;
        const seen = Date.parse(ts);
        if (Number.isNaN(seen)) return false;
        return now - seen <= RECONNECT_TOLERANCE_MS;
      });
      if (active.length !== 1) return;
      const winner = active[0];
      // Non-host writers may only push the finish when they themselves are
      // the lone active player — otherwise a non-host spectator could race
      // the host into writing the wrong winner.
      if (!isHost && winner.id !== myPlayerId) return;
      // Whether the abandon was a clean leave (player row deleted) or a
      // stale heartbeat decides finishReason.  Same winner either way.
      const anyMissingFromRoster = gs.players.some(p => p.id !== winner.id && !presentIds.has(p.id));
      const reason: NonNullable<ConquestGameState["finishReason"]> =
        anyMissingFromRoster ? "opponent_left" : "last_player_standing";
      const next: ConquestGameState = {
        ...gs,
        phase:          "finished",
        finishedAt:     now,
        winnerPlayerId: winner.id,
        winnerName:     winner.name,
        finishReason:   reason,
      };
      void onPushStateRef.current(next);
    };

    check();
    const t = window.setInterval(check, 5_000);
    return () => window.clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isHost,
    myPlayerId,
    gameState?.phase,
    matchPlayerIdsKey,
    presentPlayerIdsKey,
    lastSeenSig,
  ]);

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
  useEffect(() => { flashIllegalRef.current = flashIllegal; }, [flashIllegal]);

  const handleRegionClick = useCallback((regionId: ConquestRegionId) => {
    if (!gameState || !mapConfig) return;

    // Pusu 🕳️ placement short-circuit — runs outside the normal action-phase
    // flow so the owner can arm an ambush even while it's not their turn.
    // Eligibility is enforced by `applyPusuHiddenBonus` server-side (matches
    // `pusuPlacementCandidates` here); invalid taps just flash-flag illegal.
    if (pusuPlacementEntryId) {
      handlePlaceAmbush(regionId);
      return;
    }

    if (gameState.phase !== "action") return;
    const holderId = gameState.round.actionHolderId;
    if (!holderId) return;

    // DEV-only diagnostic snapshot: surface every input the legality decision
    // depends on so a sporadic "yellow region, illegal click" repro can be
    // root-caused from a single console group.  Computed against the same
    // holder-projected board the highlight memo uses, so the parity checks
    // below mirror the user-visible affordance.  Guarded by import.meta.env.DEV
    // — stripped from production bundles by Vite's dead-code elimination.
    if (import.meta.env.DEV) {
      const holderViewForDebug = projectRegionStatesForViewer(
        gameState.regionStates, holderId,
      );
      const clickedRegionDef = mapConfig.regions.find(r => r.id === regionId) ?? null;
      const clickedRegionRealRs = gameState.regionStates.find(r => r.regionId === regionId) ?? null;
      const clickedRegionHolderRs = holderViewForDebug.find(r => r.regionId === regionId) ?? null;
      const viewerOwnedIds = (myPlayerId
        ? gameState.regionStates.filter(r => r.ownerPlayerId === myPlayerId).map(r => r.regionId)
        : []);
      const holderOwnedIds = gameState.regionStates
        .filter(r => r.ownerPlayerId === holderId)
        .map(r => r.regionId);
      const declaredNeighbors = clickedRegionDef?.neighbors ?? [];
      const holderAdjacency = declaredNeighbors.filter(nbId =>
        holderOwnedIds.includes(nbId),
      );
      const reverseAdjacency = holderOwnedIds.filter(ownedId => {
        const ownedDef = mapConfig.regions.find(r => r.id === ownedId);
        return !!ownedDef && ownedDef.neighbors.includes(regionId);
      });
      const orphanReverseAdjacency = reverseAdjacency.filter(
        id => !declaredNeighbors.includes(id),
      );
      const inferAgainstHolderView = inferActionFromRegionClick(
        mapConfig, holderViewForDebug, holderId, regionId,
      );
      const inferAgainstRealState = inferActionFromRegionClick(
        mapConfig, gameState.regionStates, holderId, regionId,
      );
      const canCaptureNeutralHolderView = canCaptureNeutral(
        mapConfig, holderViewForDebug, holderId, regionId,
      );
      const canAttackHolderView = canAttackRegion(
        mapConfig, holderViewForDebug, holderId, regionId,
      );
      const isLegalHolderView = isLegalTarget(
        mapConfig, holderViewForDebug, holderId, regionId,
      );
      const isLegalRealState = isLegalTarget(
        mapConfig, gameState.regionStates, holderId, regionId,
      );
      const inHighlightSet = legalTargets.has(regionId);
      const holderPbDbg = gameState.playerBonuses?.[holderId];
      const roundBonuses = gameState.roundBonuses ?? null;
      const activeBonusEntries = roundBonuses
        ? Object.entries(roundBonuses).map(([rid, type]) => {
            const rs = gameState.regionStates.find(r => r.regionId === rid);
            return { regionId: rid, type, ownerPlayerId: rs?.ownerPlayerId ?? null };
          })
        : [];
      const istanbulShieldOpenOnHolder = gameState.regionStates.some(
        r => r.ownerPlayerId === holderId && r.shielded,
      );

      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `[CQ click] region=${regionId} viewer=${myPlayerId ?? "—"} holder=${holderId} phase=${gameState.phase}`,
      );
      // eslint-disable-next-line no-console
      console.log({
        viewerPlayerId:           myPlayerId,
        actionHolderId:           holderId,
        viewerIsHolder:           myPlayerId === holderId,
        phase:                    gameState.phase,
        roundNumber:              gameState.round.roundNumber,
        actionStartedAt:          gameState.round.actionStartedAt ?? null,
        actionEndsAt:             gameState.round.actionEndsAt ?? null,
        clickedRegionId:          regionId,
        clickedRegionName:        clickedRegionDef?.name ?? null,
        clickedRegionOwner_real:        clickedRegionRealRs?.ownerPlayerId ?? null,
        clickedRegionOwner_holderView:  clickedRegionHolderRs?.ownerPlayerId ?? null,
        clickedRegionShielded:    clickedRegionRealRs?.shielded ?? null,
        hiddenShieldOwnerId:      clickedRegionRealRs?.hiddenShieldOwnerId ?? null,
        hiddenShieldKind:         clickedRegionRealRs?.hiddenShieldKind ?? null,
        legalTargetIds:           Array.from(legalTargets),
        inHighlightSet,
        inferAction_holderView:   inferAgainstHolderView,
        inferAction_realState:    inferAgainstRealState,
        canCaptureNeutral_holderView: canCaptureNeutralHolderView,
        canAttackRegion_holderView:   canAttackHolderView,
        isLegalTarget_holderView:     isLegalHolderView,
        isLegalTarget_realState:      isLegalRealState,
        declaredNeighbors,
        viewerOwnedRegionIds:     viewerOwnedIds,
        holderOwnedRegionIds:     holderOwnedIds,
        holderAdjacencyToClicked: holderAdjacency,
        reverseAdjacency_holderOwnedListingClicked: reverseAdjacency,
        canActOnRegion,
        pendingHiddenShield:      !!holderPbDbg?.pendingHiddenShield,
        holderEliminatorCharges:  holderPbDbg?.eliminatorCharges ?? 0,
        holderBonusPoints:        holderPbDbg?.bonusPoints ?? 0,
        holderExtraNextMoveMs:    holderPbDbg?.extraNextMoveMs ?? 0,
        holderCukurovaClaimed:    !!holderPbDbg?.cukurovaClaimed,
        istanbulShieldOpenOnHolder,
        activeBonusEntries,
      });

      if (
        inHighlightSet
        && inferAgainstRealState === null
        && !holderPbDbg?.pendingHiddenShield
        && (holderPbDbg?.mancinikCharges ?? 0) === 0
      ) {
        // Region rendered as a legal target but the action inference rejected
        // it.  This is the bug the user is hunting — the gameplay layer and
        // the highlight memo disagree on legality for the SAME holder + state.
        // eslint-disable-next-line no-console
        console.warn(
          "[CQ click] LEGAL PARITY MISMATCH — region is in legalTargetIds but inferActionFromRegionClick returned null",
          { regionId, holderId, isLegalRealState, isLegalHolderView },
        );
      }
      if (inHighlightSet && !canActOnRegion) {
        // eslint-disable-next-line no-console
        console.warn(
          "[CQ click] highlighted region clicked by a non-holder viewer",
          { regionId, viewerPlayerId: myPlayerId, actionHolderId: holderId },
        );
      }
      if (orphanReverseAdjacency.length > 0) {
        // A region the holder owns lists the clicked region as a neighbor,
        // but the clicked region's own neighbor array does not list it back
        // — asymmetric adjacency in the map config.  Logs the offending ids
        // so the topology can be fixed.
        // eslint-disable-next-line no-console
        console.warn(
          "[CQ click] ADJACENCY ASYMMETRY — holder-owned regions list clicked region as neighbor but reverse list is missing",
          { clickedRegionId: regionId, asymmetricFrom: orphanReverseAdjacency },
        );
      }
      // eslint-disable-next-line no-console
      console.groupEnd();
    }

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

    const holderPbForInfer = gameState.playerBonuses?.[holderId];
    const inferBypass = (holderPbForInfer?.mancinikCharges ?? 0) > 0;
    const inferredAction = inferActionFromRegionClick(
      mapConfig, gameState.regionStates, holderId, regionId, inferBypass,
    );

    if (!inferredAction) {
      if (import.meta.env.DEV && legalTargets.has(regionId)) {
        // The user clicked something the board rendered as a legal yellow
        // target but the gameplay layer rejected it — this is the exact bug
        // surface.  The detailed snapshot above already logged the inputs;
        // this warn ties the failure to the failed click for easy scrolling.
        // eslint-disable-next-line no-console
        console.warn(
          "[CQ click] HIGHLIGHTED BUT ILLEGAL — region was in highlight set but inferAction returned null at commit time",
          { regionId, holderId, viewerPlayerId: myPlayerId },
        );
      }
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
  }, [gameState, mapConfig, canActOnRegion, flashIllegal, onPushGameState, legalTargets, myPlayerId, pusuPlacementEntryId, handlePlaceAmbush]);

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

  // ── Kader Kartı V1 — once-per-match fate-card draw ─────────────────────
  // The draw is gated to the action phase + action holder (so it never
  // collides with challenge / duel / round_result transitions) AND a local
  // in-flight ref so a double-click can't issue two draws before the
  // realtime echo lands. Eligibility is re-checked against the LATEST
  // gameState inside the callback so a stale snapshot can't bypass the
  // once-per-match cap.
  //
  // Akis: eligibility → cift-tiklama kilidi → spend → state push.
  // Spend basariyla finalize olduktan sonra herhangi bir asama basarisiz
  // olursa (post-spend re-check, state push hatasi, vs.) 200 Gold
  // `conquest_fate_card_refund` reason'i ile geri iade edilir. Boylece
  // oyuncu Gold kaybedip kart efekti alamama durumuna dusmez.
  const fateCardDrawingRef = useRef(false);
  const [fateCardSpending, setFateCardSpending] = useState(false);
  const handleDrawFateCard = useCallback(async () => {
    const gs = gameStateRef.current;
    if (!gs || !myPlayerId)                return;
    if (fateCardDrawingRef.current)        return;
    if (!playerCanDrawFateCard(gs, myPlayerId)) return;

    fateCardDrawingRef.current = true;
    setFateCardSpending(true);
    const player = gs.players.find(p => p.id === myPlayerId);
    const card   = drawRandomFateCard();
    const now    = Date.now();

    let spent = false;
    let success = false;
    let failureReason: string | null = null;

    try {
      // Server-otoriteli Gold harcamasi. RPC sonucu beklenmeden kart efekti
      // uygulanmaz; yetersiz Gold ya da reddedilen istek durumunda erkenden
      // cikilir ve UI eski haline doner.
      try {
        spent = await spendGoldAsync(
          CONQUEST_FATE_CARD_COST,
          "conquest_fate_card",
          {
            roomId,
            playerId: myPlayerId,
            cardId:   card.id,
            cardName: card.name,
          },
        );
      } catch (err) {
        console.error("[conquest] fate card spend RPC threw:", err);
        spent = false;
      }
      if (!spent) return;

      // Eligibility'i RPC sonrasinda yeniden dogrula — bu sirada baska bir
      // event (faz/sira degisimi, oyuncu kart kullanmis) gelmis olabilir.
      // Bu race'de Gold zaten dustugu icin asagidaki finally block refund
      // tetikler.
      const latest = gameStateRef.current;
      if (!latest || !playerCanDrawFateCard(latest, myPlayerId)) {
        failureReason = "post_spend_recheck_failed";
        return;
      }

      const nextBonuses = applyFateCardEffectToBonuses(latest, myPlayerId, card.id);

      // Pause the move clock while the reveal overlay is up.  We do this by
      // pushing the synced `actionEndsAt` (and the matching `actionStartedAt`,
      // so the total-duration math stays correct) forward by exactly the reveal
      // window.  Both the local countdown render (`actionEndsAt - now`) and the
      // host-side auto-skip setTimeout consume `actionEndsAt`, so a single
      // atomic bump freezes the visible timer behind the backdrop AND prevents
      // `expireActionPhase` from firing during the reveal.  Net effect: after
      // the overlay closes, the holder still sees roughly the same remaining
      // time they had when they tapped Çek.
      const pausedRound = (latest.phase === "action"
        && typeof latest.round.actionEndsAt    === "number"
        && typeof latest.round.actionStartedAt === "number")
        ? {
            ...latest.round,
            actionStartedAt: latest.round.actionStartedAt + FATE_REVEAL_MS,
            actionEndsAt:    latest.round.actionEndsAt    + FATE_REVEAL_MS,
          }
        : latest.round;
      // Layer card-specific time effects (Son Hamle / Sis Çöktü) on top of the
      // reveal pause.  No-op for any other card.
      const nextRound = applyFateCardEffectToRound(pausedRound, latest.phase, card.id, now);

      const next: ConquestGameState = {
        ...latest,
        round: nextRound,
        playerBonuses: nextBonuses,
        fateCardsUsedByPlayerId: {
          ...(latest.fateCardsUsedByPlayerId ?? {}),
          [myPlayerId]: true,
        },
        lastFateCardEvent: {
          id:          `fate-${now}-${myPlayerId}`,
          playerId:    myPlayerId,
          playerName:  player?.name ?? "Bir oyuncu",
          cardId:      card.id,
          cardName:    card.name,
          cardType:    card.type,
          description: card.description,
          createdAt:   now,
          round:       latest.round.roundNumber,
        },
      };

      playSound("click");
      try {
        await Promise.resolve(onPushGameState(next));
        success = true;
      } catch (err) {
        console.error("[conquest] fate card state push failed:", err);
        failureReason = "state_push_failed";
      }
    } finally {
      // Gold dustu ama kart efekti uygulanamadi → refund. Tek source of
      // truth: `spent && !success`. Bu sayede ayni oyuncudan ikinci kez
      // Gold dusmez ve gold_transactions log'unda spend + refund cifti
      // tutarli kalir.
      if (spent && !success) {
        addGold(
          CONQUEST_FATE_CARD_COST,
          "conquest_fate_card_refund",
          {
            roomId,
            playerId: myPlayerId,
            reason:   failureReason ?? "post_spend_recheck_failed",
          },
        );
      }
      fateCardDrawingRef.current = false;
      setFateCardSpending(false);
    }
  }, [myPlayerId, onPushGameState, roomId]);

  const eligibleForFateCardDraw = playerCanDrawFateCard(gameState, myPlayerId);
  const fateCardAlreadyUsed = !!(
    myPlayerId
    && gameState?.fateCardsUsedByPlayerId?.[myPlayerId]
  );
  const canAffordFateCard = accountGold >= CONQUEST_FATE_CARD_COST;
  // Çekim için tum kosullar: faz + sira + maliyet. UI butonunu yalnizca
  // tum kosullar saglandiginda aktif birakiyoruz; aksi halde widget mode'u
  // duruma uygun bilgilendirici state'lere dusuyor.
  const canDrawFateCard = eligibleForFateCardDraw && canAffordFateCard;
  const fateCardWidgetMode: "active" | "used" | "waiting" | "insufficient" =
    fateCardAlreadyUsed ? "used"
      : eligibleForFateCardDraw
        ? (canAffordFateCard ? "active" : "insufficient")
        : "waiting";
  // Widget visibility — render only when there's an in-progress match the
  // viewer is participating in.  Hides on setup/finished/lobby and for
  // spectators (myPlayerId not in players[]).  The widget is rendered
  // even when the viewer can't draw right now; the "waiting" state keeps
  // the affordance visible so the player doesn't miss it.
  const fateCardWidgetVisible = !!(
    gameState
    && myPlayerId
    && gameState.phase !== "setup"
    && gameState.phase !== "finished"
    && gameState.players.some(p => p.id === myPlayerId)
  );
  const lastFateCardEvent = gameState?.lastFateCardEvent ?? null;

  // ── Safety fallbacks ─────────────────────────────────────────────────
  if (!mapConfig) {
    return (
      <div className="app duel-screen cq-screen conquest-war-bg" style={themeStyle} data-theme={themeAttr}>
        <div className="duel-header">
          <button className="back-btn" onClick={() => { playSound("click"); onLeaveRoom(); }}>
            <span>←</span>
            <span className="back-label">Çık</span>
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
          <button className="back-btn" onClick={() => { playSound("click"); onLeaveRoom(); }}>
            <span>←</span>
            <span className="back-label">Çık</span>
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

  // ── Liman ⚓ capture card override ───────────────────────────────────
  // When the round_result card is showing because someone just captured /
  // flipped a region that *currently carries the liman bonus*, swap the
  // generic copy for a sea-flavoured liman card.  Detection is by bonus
  // TYPE (resolveActiveBonus), never by region id — so the override fires
  // for whichever coastal region holds the liman bonus this match and
  // never fires on non-liman regions.
  //
  //   - capture_neutral (first take of an unowned liman): "Limanı Alındı"
  //     card with the existing coastal-flavour subtitle.
  //   - attack_region (rakipten ele geçirme): viewer-aware control-flip
  //     copy — three perspectives for attacker / previous owner / spectator.
  //
  // Liman *income* never triggers round_result, so the existing small
  // income toast + log is untouched.
  const limanCaptureCard = useMemo<{
    icon:     string;
    title:    string;
    subtitle: string;
    extra?:   string;
  } | null>(() => {
    if (!lastResult || !lastResult.ok || !lastResult.regionId) return null;
    if (lastResult.action !== "capture_neutral" && lastResult.action !== "attack_region") {
      return null;
    }
    const bonus = resolveActiveBonus(gameState.roundBonuses, lastResult.regionId);
    if (!bonus || bonus.type !== "liman") return null;

    const attacker     = players.find(p => p.id === lastResult.playerId) ?? null;
    const attackerName = attacker?.name ?? "Oyuncu";

    // Control-flip path: rakipten ele geçirme.  Requires a previous owner
    // to address them by name in the loss / spectator variants.
    if (lastResult.action === "attack_region" && lastResult.previousOwnerId) {
      const previousOwner     = players.find(p => p.id === lastResult.previousOwnerId) ?? null;
      const previousOwnerName = previousOwner?.name ?? "Eski sahip";

      if (myPlayerId === lastResult.playerId) {
        return {
          icon:     "⚔️",
          title:    "Kontrol Ele Geçirildi!",
          subtitle: "Liman bölgesi artık senin kontrolünde. Elinde tuttuğun her tur +1 puan ve +5 Gold kazanacaksın. Düşman saldırılarına dikkat et!",
        };
      }
      if (myPlayerId === lastResult.previousOwnerId) {
        return {
          icon:     "🔥",
          title:    "Liman Bölgesi Düştü!",
          subtitle: "Liman bölgesindeki kontrolün saldırılar sonucu kayboldu. Tekrar ele geçirmek için karşı saldırı başlatabilirsin!",
        };
      }
      return {
        icon:     "⚔️",
        title:    `${attackerName}, ${previousOwnerName}’nun Liman Bölgesini Ele Geçirdi!`,
        subtitle: `Liman bölgesini ele geçiren ${attackerName}, bölgeyi elinde tuttuğu her tur +1 puan ve +5 Gold kazanacak.`,
      };
    }

    // Empty-liman first-capture path: keep the original sea-flavoured card.
    if (lastResult.action === "capture_neutral") {
      const rs = gameState.regionStates.find(r => r.regionId === lastResult.regionId);
      if (!rs || (rs.captureCount ?? 0) !== 1) return null;
      const region      = mapConfig?.regions.find(r => r.id === lastResult.regionId) ?? null;
      const regionLabel = region?.displayLabel ?? region?.name ?? lastResult.regionId;
      const flavor      = LIMAN_COAST_FLAVOR[lastResult.regionId] ?? "limanı bayrağına ekledi!";
      return {
        icon:     "⚓",
        title:    `${regionLabel} Limanı Alındı!`,
        subtitle: `${attackerName} ${flavor}`,
        extra:    "Bu liman her tur sahibine +1 puan ve +5 Gold geliri kazandıracak.",
      };
    }

    return null;
  }, [lastResult, gameState.regionStates, gameState.roundBonuses, mapConfig, players, myPlayerId]);

  // ── Kale Surları 🛡️ capture-card override ──────────────────────────────
  // Mirrors `limanCaptureCard` for the istanbul_defense (Kale Surları) bonus.
  // Always returns non-null for an attack/capture against a Kale Surları
  // region so the matching small bonus toast (suppressed via
  // `hasMajorCaptureCard`) never doubles up on the same beat.
  //
  // Variants:
  //   - First neutral capture: bespoke "kale ele geçirildi" card.
  //   - Region fell (attack flipped ownership): scenarios 1/2/3 — viewer-aware
  //     attacker / previous-owner / spectator copy.  When the flip rode on a
  //     Koçbaşı bypass (`kocbasiShieldBypass`), prepend a 🪵 note so the
  //     bypass shows up in the big card text.
  //   - Walls broken only (region survived): scenarios 4/5/6 — viewer-aware
  //     copy.  Detected via the absence of `previousOwnerId` on the
  //     attack_region result (shield-active path leaves ownership untouched).
  const kaleSurlariCaptureCard = useMemo<{
    icon:     string;
    title:    string;
    subtitle: string;
  } | null>(() => {
    if (!lastResult || !lastResult.ok || !lastResult.regionId) return null;
    if (lastResult.action !== "attack_region" && lastResult.action !== "capture_neutral") return null;
    const bonus = resolveActiveBonus(gameState.roundBonuses, lastResult.regionId);
    if (!bonus || bonus.type !== "istanbul_defense") return null;

    // First take of an unowned Kale Surları region.  captureCount is bumped
    // before this card resolves, so the very first capture reads as 1; any
    // later neutral re-takes fall through to the generic capture card.
    if (lastResult.action === "capture_neutral") {
      const rs = gameState.regionStates.find(r => r.regionId === lastResult.regionId);
      if (!rs || (rs.captureCount ?? 0) !== 1) return null;
      const attackerName = players.find(p => p.id === lastResult.playerId)?.name ?? "Oyuncu";
      if (myPlayerId === lastResult.playerId) {
        return {
          icon:     "🏰",
          title:    "🏰 Kale Ele Geçirildi, Surlar Aktif!",
          subtitle: "Bu bölge artık senin kontrolünde. Kale Surları ilk başarılı saldırıyı durduracak; surlar yıkılsa bile bölge bir saldırı daha dayanacak.",
        };
      }
      return {
        icon:     "🏰",
        title:    "🏰 Rakip Kaleyi Ele Geçirdi! Surlar Aktif!",
        subtitle: `${attackerName}, Kale Surları bulunan bölgeyi kontrol altına aldı. Bu bölgeye yapılacak ilk başarılı saldırı önce surları yıkacak.`,
      };
    }

    // attack_region from here on.
    const attackerId      = lastResult.playerId;
    const attackerName    = players.find(p => p.id === attackerId)?.name ?? "Saldıran";
    const previousOwnerId = lastResult.previousOwnerId ?? null;
    const regionFell      = previousOwnerId !== null;
    const isKocbasiBypass = lastResult.kocbasiShieldBypass === true;

    if (regionFell) {
      const previousOwnerName = players.find(p => p.id === previousOwnerId)?.name ?? "Eski sahip";

      // Scenario 1 — attacker (me) captured the kale region.
      if (myPlayerId === attackerId) {
        const base = "⚔️ Kale Surları aktif! Eğer rakibinde Koçbaşı bonusu yoksa kaleye gelen ilk saldırı bölgeyi değil kalkanı kırar.";
        return {
          icon:     "🏰",
          title:    "🏰 Kaleyi Ele Geçirdin!",
          subtitle: isKocbasiBypass
            ? `🪵 Koçbaşı gücün surları yararak bölgeyi tek hamlede ele geçirdi. ${base}`
            : base,
        };
      }
      // Scenario 2 — defender (me) lost the kale region.
      if (myPlayerId === previousOwnerId) {
        const base = "Düşman kalenin içine kadar sızdı ve ele geçirdi! Kaleyi daha hızlı geri kazanmak için oyunda varsa Koçbaşı bonusuyla saldırabilirsin.";
        return {
          icon:     "🔥",
          title:    "🔥 Düşman Kaleyi Ele Geçirdi!",
          subtitle: isKocbasiBypass
            ? `🪵 Rakibin Koçbaşı bonusu Kale Surları'nı yok sayıp kaleyi tek hamlede aldı. ${base}`
            : base,
        };
      }
      // Scenario 3 — spectator view, kale changed hands.
      const base = `⚔️ ${attackerName}, ${previousOwnerName} oyuncusunun Kale Surları bulunan bölgesini ele geçirdi! Daha kolay fethetmek için varsa Koçbaşı bonusu iyi fikir.`;
      return {
        icon:     "🔥",
        title:    "🔥 Kale El Değiştirdi!",
        subtitle: isKocbasiBypass
          ? `🪵 ${attackerName} Koçbaşı bonusuyla surları aşıp bölgeyi tek hamlede ele geçirdi. ${base}`
          : base,
      };
    }

    // Walls broken, region survived.  Defender is still the current owner.
    const defenderId = gameState.regionStates.find(r => r.regionId === lastResult.regionId)?.ownerPlayerId ?? null;

    // Scenario 4 — attacker (me) broke the walls but the region didn't fall.
    if (myPlayerId === attackerId) {
      return {
        icon:     "🏰",
        title:    "🏰 Surlar Aşıldı!",
        subtitle: "🔥 Rakibin surlarını yıktın! Bir sonraki başarılı saldırı bölgeyi düşürecek.",
      };
    }
    // Scenario 5 — defender (me), walls broken but region kept.
    if (defenderId && myPlayerId === defenderId) {
      return {
        icon:     "🏰",
        title:    "🏰 Düşman Surları Aştı!",
        subtitle: "🔥 Düşman surları yıktı! Bir sonraki başarılı saldırısı kaleyi kaybetmeme neden olacak, dikkat et!",
      };
    }
    // Scenario 6 — spectator view, walls broken only.
    return {
      icon:     "🏰",
      title:    "🏰 Surlar Aşıldı!",
      subtitle: "🔥 Kale Surları aşıldı! Bölgeye yapılan bir sonraki başarılı saldırı kaleyi düşürecek. İlk saldırıyı sen yaparsan bölge senin kontrolüne geçecek!",
    };
  }, [lastResult, gameState.roundBonuses, gameState.regionStates, players, myPlayerId]);

  // ── Bereketli Ova 🌾 capture-card override ─────────────────────────────
  // Mirrors `limanCaptureCard` for the cukurova_score bonus.  Five viewer
  // scenarios on capture; the harvest-payout banner is handled separately
  // via the major bonus notice path (harvest fires at round-end, not in
  // round_result phase).  Detection by bonus TYPE so it works whichever
  // region carries the bereket bonus this match.
  const bereketCaptureCard = useMemo<{
    icon:     string;
    title:    string;
    subtitle: string;
  } | null>(() => {
    if (!lastResult || !lastResult.ok || !lastResult.regionId) return null;
    if (lastResult.action !== "capture_neutral" && lastResult.action !== "attack_region") {
      return null;
    }
    const bonus = resolveActiveBonus(gameState.roundBonuses, lastResult.regionId);
    if (!bonus || bonus.type !== "cukurova_score") return null;

    const attackerId   = lastResult.playerId;
    const attackerName = players.find(p => p.id === attackerId)?.name ?? "Oyuncu";

    // Neutral first-capture: cases 1 & 2.
    if (lastResult.action === "capture_neutral") {
      if (myPlayerId === attackerId) {
        return {
          icon:     "🌾",
          title:    "🌾 Bereketli Ova Ele Geçirildi!",
          subtitle: "Bu bölge sana anında +2 puan kazandırdı. Elinde 3 tur tutarsan +4 puanlık Hasat alacaksın.",
        };
      }
      return {
        icon:     "🌾",
        title:    "🌾 Rakip Bereketli Ova’yı Aldı!",
        subtitle: "Rakibin anında +2 puan kazandı. Bölgeyi 3 tur elinde tutarsa +4 puanlık Hasat alacak.",
      };
    }

    // attack_region — needs a previous owner to read as a true takeover.
    const previousOwnerId = lastResult.previousOwnerId ?? null;
    if (!previousOwnerId) return null;
    const previousOwnerName = players.find(p => p.id === previousOwnerId)?.name ?? "Eski sahip";

    // Case 3 — attacker (me) took the bereket region from an opponent.
    if (myPlayerId === attackerId) {
      return {
        icon:     "🌾",
        title:    "🌾 Hasat Kontrolü Sana Geçti!",
        subtitle: "Bereketli Ova artık senin kontrolünde. Anında +2 puan kazandın; bölgeyi 3 tur elinde tutarsan +4 puanlık Hasat alacaksın.",
      };
    }
    // Case 4 — defender (me) lost the bereket region.
    if (myPlayerId === previousOwnerId) {
      return {
        icon:     "🔥",
        title:    "🔥 Bereketli Ova Kaybedildi!",
        subtitle: "Rakip Bereketli Ova’nın kontrolünü ele geçirdi. Anında +2 puan kazandı; bölgeyi 3 tur elinde tutarsa +4 puanlık Hasat alacak.",
      };
    }
    // Case 5 — spectator view, bereket changed hands.
    return {
      icon:     "🌾",
      title:    "🌾 Bereketli Ova El Değiştirdi!",
      subtitle: `${attackerName}, ${previousOwnerName} oyuncusunun Bereketli Ova bölgesini ele geçirdi. Anında +2 puan kazandı; bölgeyi 3 tur elinde tutarsa +4 puanlık Hasat alacak.`,
    };
  }, [lastResult, gameState.roundBonuses, players, myPlayerId]);

  // ── Kâhin Büyüsü 🔮 capture-card override ──────────────────────────────
  // Mirrors `bereketCaptureCard` for the kahin bonus.  Five viewer-aware
  // scenarios: neutral take by me / by opponent, opponent flip to me,
  // my loss, and spectator-side flip.  Detection by bonus TYPE so it
  // works whichever region carries the kahin bonus this match.
  const kahinCaptureCard = useMemo<{
    icon:     string;
    title:    string;
    subtitle: string;
  } | null>(() => {
    if (!lastResult || !lastResult.ok || !lastResult.regionId) return null;
    if (lastResult.action !== "capture_neutral" && lastResult.action !== "attack_region") {
      return null;
    }
    const bonus = resolveActiveBonus(gameState.roundBonuses, lastResult.regionId);
    if (!bonus || bonus.type !== "kahin") return null;

    const attackerId   = lastResult.playerId;

    // Neutral first-capture: cases 1 & 2.
    if (lastResult.action === "capture_neutral") {
      if (myPlayerId === attackerId) {
        return {
          icon:     "🔮",
          title:    "🔮 Kâhin Büyüsü Kazanıldı!",
          subtitle: "Bu bölge artık senin kontrolünde. Elinde tuttuğun sürece sıradaki sorunun türünü önceden görebileceksin.",
        };
      }
      return {
        icon:     "🔮",
        title:    "🔮 Rakip Kâhin Büyüsü Kazandı!",
        subtitle: "Rakibin Kâhin bölgesini kontrol altına aldı. Bu bölgeyi elinde tuttuğu sürece sıradaki sorunun türünü önceden görebilecek.",
      };
    }

    // attack_region — needs a previous owner to read as a true takeover.
    const previousOwnerId = lastResult.previousOwnerId ?? null;
    if (!previousOwnerId) return null;
    const attackerName      = players.find(p => p.id === attackerId)?.name      ?? "Saldıran";
    const previousOwnerName = players.find(p => p.id === previousOwnerId)?.name ?? "Eski sahip";

    // Case 3 — attacker (me) took the kahin region from an opponent.
    if (myPlayerId === attackerId) {
      return {
        icon:     "🔮",
        title:    "🔮 Görü Gücü Sana Geçti!",
        subtitle: "Kâhin Büyüsü artık senin kontrolünde. Bölge sende kaldığı sürece sıradaki sorunun türünü önceden göreceksin.",
      };
    }
    // Case 4 — defender (me) lost the kahin region.
    if (myPlayerId === previousOwnerId) {
      return {
        icon:     "🔥",
        title:    "🔥 Kâhin Büyüsü Kaybedildi!",
        subtitle: "Kâhin bölgesindeki kontrolünü kaybettin. Artık sıradaki soru türünü önceden göremeyeceksin.",
      };
    }
    // Case 5 — spectator view, kahin changed hands.
    return {
      icon:     "🔮",
      title:    "🔮 Kâhin Büyüsü El Değiştirdi!",
      subtitle: `${attackerName}, ${previousOwnerName} oyuncusunun Kâhin bölgesini ele geçirdi. Görü avantajı artık yeni sahibinde.`,
    };
  }, [lastResult, gameState.roundBonuses, players, myPlayerId]);

  // ── Mancınık 🎯 capture-card override ──────────────────────────────────
  // Mirrors the Liman / Bereket / Kâhin capture cards for the mancinik
  // bonus.  Five viewer-aware scenarios on capture/flip:
  //   1: I take a neutral mancinik region    → "🎯 Mancınık Hazır!"
  //   2: An opponent takes the neutral one   → "🎯 Rakip Mancınık Kurdu!"
  //   3: I take a mancinik from an opponent  → "🎯 Mancınık Kontrolü Sana Geçti!"
  //   4: An opponent takes mine              → "🔥 Mancınık Kaybedildi!"
  //   5: Spectator view, mancinik flipped    → "🎯 Mancınık El Değiştirdi!"
  const mancinikCaptureCard = useMemo<{
    icon:     string;
    title:    string;
    subtitle: string;
  } | null>(() => {
    if (!lastResult || !lastResult.ok || !lastResult.regionId) return null;
    if (lastResult.action !== "capture_neutral" && lastResult.action !== "attack_region") {
      return null;
    }
    const bonus = resolveActiveBonus(gameState.roundBonuses, lastResult.regionId);
    if (!bonus || bonus.type !== "mancinik") return null;

    const attackerId   = lastResult.playerId;
    const attackerName = players.find(p => p.id === attackerId)?.name ?? "Oyuncu";

    // Cards 1 & 2 — neutral first capture (or re-capture from neutral).
    if (lastResult.action === "capture_neutral") {
      if (myPlayerId === attackerId) {
        return {
          icon:     "🎯",
          title:    "🎯 Mancınık Hazır!",
          subtitle: "Tek kullanımlık uzak saldırı hakkı kazandın. Bir sonraki saldırında komşuluk sınırı olmadan haritadaki herhangi bir bölgeyi hedef alabilirsin.",
        };
      }
      return {
        icon:     "🎯",
        title:    "🎯 Rakip Mancınık Kurdu!",
        subtitle: "Rakibin tek kullanımlık uzak saldırı hakkı kazandı. Bir sonraki saldırısında haritadaki herhangi bir bölgeyi hedef alabilir.",
      };
    }

    // attack_region — needs a previous owner to read as a true takeover.
    const previousOwnerId = lastResult.previousOwnerId ?? null;
    if (!previousOwnerId) return null;
    const previousOwnerName = players.find(p => p.id === previousOwnerId)?.name ?? "Eski sahip";

    // Card 3 — attacker (me) took the mancinik region from an opponent.
    if (myPlayerId === attackerId) {
      return {
        icon:     "🎯",
        title:    "🎯 Mancınık Kontrolü Sana Geçti!",
        subtitle: "Mancınık bölgesini ele geçirdin ve tek kullanımlık uzak saldırı hakkı kazandın. Bir sonraki saldırında haritanın herhangi bir noktasını hedef alabilirsin.",
      };
    }
    // Card 4 — defender (me) lost the mancinik region.
    if (myPlayerId === previousOwnerId) {
      return {
        icon:     "🔥",
        title:    "🔥 Mancınık Kaybedildi!",
        subtitle: "Rakip Mancınık bölgesini ele geçirdi ve tek kullanımlık uzak saldırı hakkı kazandı. Bir sonraki saldırısında haritadaki herhangi bir bölgeyi hedef alabilir.",
      };
    }
    // Card 5 — spectator view, mancinik changed hands.
    return {
      icon:     "🎯",
      title:    "🎯 Mancınık El Değiştirdi!",
      subtitle: `${attackerName}, ${previousOwnerName} oyuncusunun Mancınık bölgesini ele geçirdi. Artık tek kullanımlık uzak saldırı hakkına sahip.`,
    };
  }, [lastResult, gameState.roundBonuses, players, myPlayerId]);

  // ── Mancınık 🎯 combo / fired card ─────────────────────────────────────
  // Two flavours, gated on `lastResult.mancinikBypassUsed` set by gameplay
  // when the charge is actually consumed:
  //   - Card 7 (combo): also `kocbasiShieldBypass` → "🎯🪵 Kuşatma Darbesi!".
  //     Wins over the Kale Surları card so the headline reads the combo move.
  //   - Card 6 (solo):  bypass used but no kocbasi combo → "🎯 Mancınık
  //     Ateşlendi!".  Used as a fallback after the dedicated region cards
  //     (Liman / Bereket / Kâhin / Kale Surları / mancinik-region) so those
  //     stay intact when mancinik happens to target their region.
  const mancinikComboCard = useMemo<{
    icon:     string;
    title:    string;
    subtitle: string;
  } | null>(() => {
    if (!lastResult || !lastResult.ok) return null;
    if (lastResult.mancinikBypassUsed !== true) return null;
    if (lastResult.kocbasiShieldBypass !== true) return null;
    return {
      icon:     "🎯",
      title:    "🎯🪵 Kuşatma Darbesi!",
      subtitle: "Mancınık uzak hedefi açtı, Koçbaşı ise Kale Surları'nı aşmaya hazır. Başarılı saldırı kaleyi doğrudan düşürebilir.",
    };
  }, [lastResult]);

  const mancinikUsedCard = useMemo<{
    icon:     string;
    title:    string;
    subtitle: string;
  } | null>(() => {
    if (!lastResult || !lastResult.ok) return null;
    if (lastResult.mancinikBypassUsed !== true) return null;
    if (lastResult.kocbasiShieldBypass === true) return null;
    return {
      icon:     "🎯",
      title:    "🎯 Mancınık Ateşlendi!",
      subtitle: "Komşuluk sınırı aşıldı. Uzak bölgeye saldırı başlatıldı; Mancınık hakkı kullanıldı.",
    };
  }, [lastResult]);

  const rrcIcon     = mancinikComboCard?.icon     ?? kaleSurlariCaptureCard?.icon     ?? bereketCaptureCard?.icon     ?? kahinCaptureCard?.icon     ?? limanCaptureCard?.icon     ?? mancinikCaptureCard?.icon     ?? mancinikUsedCard?.icon     ?? rrcData.icon;
  const rrcTitle    = mancinikComboCard?.title    ?? kaleSurlariCaptureCard?.title    ?? bereketCaptureCard?.title    ?? kahinCaptureCard?.title    ?? limanCaptureCard?.title    ?? mancinikCaptureCard?.title    ?? mancinikUsedCard?.title    ?? rrcData.title;
  const rrcSubtitle = mancinikComboCard?.subtitle ?? kaleSurlariCaptureCard?.subtitle ?? bereketCaptureCard?.subtitle ?? kahinCaptureCard?.subtitle ?? limanCaptureCard?.subtitle ?? mancinikCaptureCard?.subtitle ?? mancinikUsedCard?.subtitle ?? (lastResult?.message ?? "Tur tamamlandı.");

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

  // Safety clamp: ratchet `now` forward to real time when the React-state
  // ticker lags (Chromium background-tab throttling, transient effect-cleanup
  // race during phase change, etc.).  All "should the question/duel panel be
  // visible yet?" gating reads `safeNow` instead of `now`, so even if a
  // ticker tick is missed the gating can't latch in the "still waiting"
  // state forever.  Countdown *numbers* still read `now` so the displayed
  // seconds tick smoothly in lockstep with the setInterval cadence.
  const safeNow = Math.max(now, Date.now());

  // Intro overlay: info card (4s) → 3-2-1 countdown (3s) → question panel.
  const DUEL_INFO_MS = 5000;
  const duelStartedAt = duel?.startedAt ?? 0;
  const duelQuestionVisibleAt = duel?.questionVisibleAt ?? duelStartedAt;
  const showDuelInfo      = phase === "defense_duel" && !!duel && safeNow < duelStartedAt + DUEL_INFO_MS;
  const showDuelCountdown = phase === "defense_duel" && !!duel && safeNow >= duelStartedAt + DUEL_INFO_MS && safeNow < duelQuestionVisibleAt;
  const showDuelPanel     = phase === "defense_duel" && !!duel && safeNow >= duelQuestionVisibleAt;
  const countdownNum      = showDuelCountdown ? Math.max(1, Math.ceil((duelQuestionVisibleAt - now) / 1000)) : 0;

  // Game-start intro overlay: info card (3s) → 3-2-1 countdown (3s) → first challenge.
  // Only fires on round 1 of a fresh match (gameIntroEndsAt is set only by
  // createInitialConquestGameState); pre-intro rooms have undefined → no overlay.
  const GAME_INTRO_COUNTDOWN_MS = 3_000;
  const gameIntroEndsAt         = gameState?.gameIntroEndsAt ?? 0;
  const showGameIntro           = gameIntroEndsAt > 0 && phase === "challenge" && safeNow < gameIntroEndsAt;
  const showGameIntroText       = showGameIntro && safeNow < gameIntroEndsAt - GAME_INTRO_COUNTDOWN_MS;
  const showGameIntroCountdown  = showGameIntro && safeNow >= gameIntroEndsAt - GAME_INTRO_COUNTDOWN_MS;
  const gameIntroCountdownNum   = showGameIntroCountdown
    ? Math.max(1, Math.ceil((gameIntroEndsAt - now) / 1000))
    : 0;

  // Per-round intro pacing (rounds 2+): challenge.startedAt is anchored
  // ROUND_INTRO_CARD_MS + ROUND_COUNTDOWN_MS into the future by
  // advanceToNextRound so the dedicated intro overlay (info card →
  // 3-2-1 countdown) gets airtime before the question and timer appear.
  // challengeState.endsAt = startedAt + duration, so no seconds tick away
  // during the intro.  Round 1 uses the game-intro flow instead.
  //
  // Stamp the first time THIS client saw the current challenge id.  We
  // keep this purely for the debug log — it lets us see when realtime
  // payloads landed late on a particular client.  IT MUST NOT feed the
  // gameplay timeline: per-client windows desynced the room (one screen
  // showed a question while another was blank, the timer drifted, etc).
  // Every client now reads the shared `challenge.startedAt` / `endsAt`.
  const currentChallengeIdForSeen = challengeState.challenge.id;
  if (challengeFirstSeenRef.current.id !== currentChallengeIdForSeen) {
    challengeFirstSeenRef.current = {
      id: currentChallengeIdForSeen,
      at: Date.now(),
    };
  }
  const challengeFirstSeenAt = challengeFirstSeenRef.current.at;

  // ── Shared challenge timing ──────────────────────────────────────────
  // The host writes `challenge.startedAt` (already padded by
  // QUESTION_SYNC_BUFFER_MS + ROUND_INTRO_CARD_MS + ROUND_COUNTDOWN_MS)
  // and `challenge.endsAt = startedAt + duration`.  Every viewer reads
  // the same two numbers — intro overlay, timer label, progress bar,
  // input enablement, and the host's expire timer all derive from the
  // SAME wall-clock window.  No per-client extension.
  //
  // Late-arriving guests (realtime payload landed near or past endsAt)
  // simply see a short or empty window; the host has its own
  // GUEST_SETTLE_GRACE_MS cushion before flipping the synced status, so
  // a slow-arriving client still gets a real chance to submit.  This is
  // intentional: any per-client extension here would push that viewer
  // out of sync with the rest of the room, which is the bug we're
  // fixing.  Late arrivals are surfaced in the debug log (see below).
  const serverStartedAt   = challengeState.startedAt;
  const serverEndsAt      = challengeState.endsAt;
  const serverTimeLeftMs  = Math.max(0, serverEndsAt - safeNow);
  const remainingAtFirstSeen = serverEndsAt - challengeFirstSeenAt;
  const isLateArrival = !isHost && remainingAtFirstSeen < 10_000;

  // Small SHARED submit grace so an Enter keystroke landing the same
  // frame the timer renders 0 isn't dropped — applied uniformly for
  // host and guests.  Does NOT extend the gameplay window; the host's
  // GUEST_SETTLE_GRACE_MS still gates when `status` flips.
  const SUBMIT_GRACE_MS = 700;
  const canAnswerByServerTime = challengeState.status === "active"
    && safeNow >= serverStartedAt
    && safeNow < serverEndsAt + SUBMIT_GRACE_MS;

  const roundIntroMsRemaining = Math.max(0, serverStartedAt - safeNow);
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
  const [desktopVolumeCloseKey, setDesktopVolumeCloseKey] = useState(0);
  const bonusGuideAutoShownRef = useRef(false);
  useEffect(() => {
    if (bonusGuideAutoShownRef.current) return;
    if (!hasBonusGuide) return;
    // Mobile uses the inline `MobileBonusStrip` chip row instead of the
    // auto-opening modal — the modal would cover too much of the small
    // viewport.  The mobile `?` header button still toggles it manually.
    if (isMobile) {
      bonusGuideAutoShownRef.current = true;
      return;
    }
    // Round 1 is the only auto-open moment.  Players joining mid-match see
    // the "?" button but no pop-up — the active question must stay readable.
    if (gameState?.round?.roundNumber === 1) {
      setBonusGuideOpen(true);
      bonusGuideAutoShownRef.current = true;
    }
  }, [hasBonusGuide, gameState?.round?.roundNumber, isMobile]);
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

  // Hidden bonus claim toast (viewer-aware).  Lives on a separate state
  // channel (`gameState.lastHiddenBonusToast`) so it never collides with the
  // open bonus toast above.  The claimer sees the real bonus name; everyone
  // else sees a generic "rakip gizli bonus keşfetti" message — the renderer
  // picks copy from `getHiddenBonusToastCopyForViewer` based on viewerId.
  const HIDDEN_BONUS_TOAST_MS = 6000;
  const lastHiddenBonusToast = gameState.lastHiddenBonusToast ?? null;
  const [dismissedHiddenToastId, setDismissedHiddenToastId] = useState<string | null>(null);
  useEffect(() => {
    if (!lastHiddenBonusToast) return;
    if (dismissedHiddenToastId === lastHiddenBonusToast.id) return;
    const remaining = lastHiddenBonusToast.at + HIDDEN_BONUS_TOAST_MS - Date.now();
    if (remaining <= 0) {
      setDismissedHiddenToastId(lastHiddenBonusToast.id);
      return;
    }
    const t = window.setTimeout(() => {
      setDismissedHiddenToastId(lastHiddenBonusToast.id);
    }, remaining);
    return () => window.clearTimeout(t);
  }, [lastHiddenBonusToast?.id, lastHiddenBonusToast?.at, dismissedHiddenToastId]);
  const showHiddenBonusToast =
    !!lastHiddenBonusToast
    && dismissedHiddenToastId !== lastHiddenBonusToast.id;
  const hiddenToastPlayerColor = lastHiddenBonusToast
    ? (playerColors[lastHiddenBonusToast.claimerId] ?? null)
    : null;
  const hiddenBonusToastCopy = lastHiddenBonusToast
    ? getHiddenBonusToastCopyForViewer(lastHiddenBonusToast, myPlayerId)
    : null;
  // Pusu 🕳️ "use" (placement) events are STRICTLY owner-only — opponents must
  // never see any notification that an ambush was placed.  The viewer-aware
  // copy returns an empty stub for non-owners; we suppress the toast entirely
  // when that stub appears so no empty bubble flashes on opponents' screens.
  const suppressHiddenBonusToast =
    !!lastHiddenBonusToast
    && lastHiddenBonusToast.event === "use"
    && lastHiddenBonusToast.type  === "pusu"
    && lastHiddenBonusToast.claimerId !== myPlayerId;

  // 👁️ İstihbarat Ağı — intel report toast (owner-only).  The synced payload
  // is identical on every client; the renderer suppresses it for anyone
  // other than the current istihbarat_agi region owner.  Two flavours:
  //   - hidden_claim → "X gizli bonus keşfetti: <real bonus name>."
  //   - gizli_op     → "X Gizli Operasyon kullandı. Hedef bölge: <region>."
  const INTEL_REPORT_TOAST_MS = 6000;
  const lastIntelReport = gameState.lastIntelReport ?? null;
  const intelNetworkOwnerId = getIntelNetworkOwnerId(gameState);
  const [dismissedIntelReportId, setDismissedIntelReportId] = useState<string | null>(null);
  useEffect(() => {
    if (!lastIntelReport) return;
    if (dismissedIntelReportId === lastIntelReport.id) return;
    const remaining = lastIntelReport.at + INTEL_REPORT_TOAST_MS - Date.now();
    if (remaining <= 0) {
      setDismissedIntelReportId(lastIntelReport.id);
      return;
    }
    const t = window.setTimeout(
      () => setDismissedIntelReportId(lastIntelReport.id),
      remaining,
    );
    return () => window.clearTimeout(t);
  }, [lastIntelReport?.id, lastIntelReport?.at, dismissedIntelReportId]);
  const intelTargetRegionLabel = lastIntelReport?.targetRegionId && mapConfig
    ? (mapConfig.regions.find(r => r.id === lastIntelReport.targetRegionId)?.displayLabel
       ?? mapConfig.regions.find(r => r.id === lastIntelReport.targetRegionId)?.name
       ?? null)
    : null;
  const intelReportCopy = lastIntelReport
    ? getIntelReportCopy(lastIntelReport, intelTargetRegionLabel)
    : null;
  const showIntelReportToast =
    !!lastIntelReport
    && dismissedIntelReportId !== lastIntelReport.id
    && intelNetworkOwnerId !== null
    && intelNetworkOwnerId === myPlayerId;
  const intelReportToastColor =
    myPlayerId ? (playerColors[myPlayerId] ?? null) : null;
  const toastPlayerColor = lastBonusToast
    ? (playerColors[lastBonusToast.playerId] ?? null)
    : null;

  // Liman ⚓ — local owner credits its own gold when an income toast lands.
  // We never write another player's gold from this client (RLS would refuse
  // anyway).  Idempotent per toast id: the synced toast id encodes the tick
  // number, so a re-render or realtime echo of the same toast does not
  // double-credit.  Errors inside addGold log silently — gameplay state is
  // never affected by a gold write failure.
  const limanCreditedToastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lastBonusToast) return;
    if (lastBonusToast.bonusType !== "liman") return;
    if (!lastBonusToast.id.startsWith("liman_income-")) return;
    if (lastBonusToast.playerId !== myPlayerId) return;
    if (limanCreditedToastIdRef.current === lastBonusToast.id) return;
    limanCreditedToastIdRef.current = lastBonusToast.id;
    try {
      addGold(LIMAN_INCOME_GOLD);
    } catch (e) {
      // gold.ts already swallows Supabase failures; this guard covers any
      // pre-write throw so a corrupted gold layer never breaks the match.
      // eslint-disable-next-line no-console
      console.error("[conquest] Liman gold credit failed:", e);
    }
  }, [lastBonusToast?.id, lastBonusToast?.bonusType, lastBonusToast?.playerId, myPlayerId]);

  // ── Major bonus notice (premium first-capture banner) ────────────────
  // Liman ⚓ — the first time the region carrying this bonus is captured in
  // the match, suppress the standard small bonus toast and render a larger
  // premium notice instead.  Subsequent captures + per-round income payouts
  // continue to use the existing small toast + log path unchanged.
  //
  // Structure is generic (kind/title/body/playerColor) so other bonuses can
  // graduate to the same banner later by adding a branch in the effect below.
  const MAJOR_BONUS_NOTICE_MS = 3800;
  const MAJOR_BONUS_NOTICE_FRESH_MS = 5000;
  const majorBonusHandledIdRef = useRef<string | null>(null);
  const [majorBonusNotice, setMajorBonusNotice] = useState<{
    id:    string;
    icon:  string;
    title: string;
    body:  string;
    color: string | null;
  } | null>(null);
  useEffect(() => {
    if (!lastBonusToast) return;
    if (lastBonusToast.bonusType !== "liman") return;
    // Income ticks share the bonus toast channel but must never trigger the
    // major notice — they keep the existing small message.
    if (lastBonusToast.id.startsWith("liman_income-")) return;
    if (majorBonusHandledIdRef.current === lastBonusToast.id) return;

    // First capture in this match only.  `captureCount` on the region state
    // is incremented before the bonus toast is written, so the first capture
    // resolves to 1.  Subsequent re-captures fall through to the small toast.
    const regionId = lastBonusToast.regionId;
    if (!regionId) return;
    const regionState = gameState.regionStates.find(r => r.regionId === regionId);
    if (!regionState || (regionState.captureCount ?? 0) !== 1) return;

    // Guard against stale toasts replayed on mount (e.g. rejoining a match
    // after the first capture already happened): ignore anything that is no
    // longer fresh enough to be the live capture event.
    if (Date.now() - lastBonusToast.at > MAJOR_BONUS_NOTICE_FRESH_MS) return;

    majorBonusHandledIdRef.current = lastBonusToast.id;

    const region = mapConfig?.regions.find(r => r.id === regionId) ?? null;
    const regionLabel = region?.displayLabel ?? region?.name ?? "Liman";
    const isMine = lastBonusToast.playerId === myPlayerId;
    const notice = isMine
      ? {
          id:    lastBonusToast.id,
          icon:  "⚓",
          title: "Liman Ele Geçirildi!",
          body:  `${regionLabel} artık senin kontrolünde. Her tur +1 puan ve +5 Gold geliri kazanacaksın.`,
          color: playerColors[lastBonusToast.playerId] ?? null,
        }
      : {
          id:    lastBonusToast.id,
          icon:  "⚓",
          title: "Rakip Limanı Ele Geçirdi!",
          body:  `${lastBonusToast.playerName}, ${regionLabel} limanını aldı. Bu bölge artık her tur sahibine +1 puan ve +5 Gold kazandıracak.`,
          color: playerColors[lastBonusToast.playerId] ?? null,
        };
    setMajorBonusNotice(notice);
    // Suppress the duplicate small toast for this exact capture event.
    setDismissedToastId(lastBonusToast.id);

    const t = window.setTimeout(() => {
      setMajorBonusNotice(cur => (cur && cur.id === notice.id ? null : cur));
    }, MAJOR_BONUS_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [
    lastBonusToast?.id,
    lastBonusToast?.bonusType,
    lastBonusToast?.regionId,
    lastBonusToast?.playerId,
    lastBonusToast?.playerName,
    lastBonusToast?.at,
    gameState.regionStates,
    mapConfig,
    myPlayerId,
    playerColors,
  ]);

  // Bereketli Ova 🌾 harvest — round-end +4 payout is delivered through
  // `lastBonusToast` (id prefix `bereket_harvest-`) and carries forward
  // to the next round's challenge phase.  Promote it to the same major
  // notice slot so the moment reads as a headline event, and suppress
  // the duplicate small toast.
  useEffect(() => {
    if (!lastBonusToast) return;
    if (lastBonusToast.bonusType !== "cukurova_score") return;
    if (!lastBonusToast.id.startsWith("bereket_harvest-")) return;
    if (majorBonusHandledIdRef.current === lastBonusToast.id) return;
    if (Date.now() - lastBonusToast.at > MAJOR_BONUS_NOTICE_FRESH_MS) return;
    majorBonusHandledIdRef.current = lastBonusToast.id;

    const notice = {
      id:    lastBonusToast.id,
      icon:  "🌾",
      title: "🌾 Hasat Zamanı!",
      body:  `Bereketli Ova 3 tur boyunca elde tutuldu. ${lastBonusToast.playerName} +4 puanlık Hasat kazandı.`,
      color: playerColors[lastBonusToast.playerId] ?? null,
    };
    setMajorBonusNotice(notice);
    setDismissedToastId(lastBonusToast.id);

    const t = window.setTimeout(() => {
      setMajorBonusNotice(cur => (cur && cur.id === notice.id ? null : cur));
    }, MAJOR_BONUS_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [
    lastBonusToast?.id,
    lastBonusToast?.bonusType,
    lastBonusToast?.playerId,
    lastBonusToast?.playerName,
    lastBonusToast?.at,
    playerColors,
  ]);

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
  //
  // Pusu 🕳️ placement mode override: while the local viewer has
  // `pusuPlacementEntryId` set, the map's legal-affordance set is replaced
  // with the placement candidate set, the viewer is forced to act (so the
  // affordance actually renders), the board is enabled regardless of
  // phase, and the click handler is attached unconditionally so the
  // owner can arm an ambush mid-challenge or mid-reveal.
  const inAmbushMode      = pusuPlacementEntryId !== null;
  const mapLegalTargets   = inAmbushMode ? pusuPlacementCandidates : legalTargets;
  const mapViewerIsHolder = inAmbushMode ? true                    : isActionHolder;
  const mapBoardDisabled  = inAmbushMode ? false                   : boardDisabled;
  const mapClickHandler   = inAmbushMode
    ? handleRegionClick
    : (phase === "action" ? handleRegionClick : undefined);
  const mapNode = settings.map === "turkey" ? (
    <>
      {/* SVG map: primary interaction on all screens */}
      <TurkeyConquestMap
        regionStates={visibleRegionStates}
        players={players}
        playerColors={playerColors}
        legalTargetIds={mapLegalTargets}
        flashRegionId={flashRegionId}
        attackTargetRegionId={attackTargetRegionId}
        disabled={mapBoardDisabled}
        viewerIsHolder={mapViewerIsHolder}
        roundBonuses={gameState.roundBonuses}
        onRegionClick={mapClickHandler}
        myAmbushRegionIds={myAmbushRegionIds}
      />
      {/* Mobile fallback: card grid below map (labels hidden on mobile via CSS) */}
      <div className="cq-map-card-fallback">
        <ConquestBoard
          mapConfig={mapConfig}
          regionStates={visibleRegionStates}
          players={players}
          playerColors={playerColors}
          onRegionClick={mapClickHandler}
          legalRegionIds={mapLegalTargets}
          flashRegionId={flashRegionId}
          disabled={mapBoardDisabled}
          viewerIsHolder={mapViewerIsHolder}
          myAmbushRegionIds={myAmbushRegionIds}
        />
      </div>
    </>
  ) : (
    <ConquestBoard
      mapConfig={mapConfig}
      regionStates={visibleRegionStates}
      players={players}
      playerColors={playerColors}
      onRegionClick={mapClickHandler}
      legalRegionIds={mapLegalTargets}
      flashRegionId={flashRegionId}
      disabled={mapBoardDisabled}
      viewerIsHolder={mapViewerIsHolder}
      myAmbushRegionIds={myAmbushRegionIds}
    />
  );

  // ── Toasts (shared across desktop and mobile) ──────────────────────
  // Stay `position: fixed` for both branches; the mobile shell will get
  // a queued toast slot in a later step.
  //
  // True while a premium bonus/capture card (Kale Surları, Liman) owns the
  // moment via the round_result overlay or the major-bonus notice.  Used to
  // suppress the small red bonus toast for the same event — it would just
  // restate what the big card already says.
  const hasMajorCaptureCard =
    (phase === "round_result" && (
      !!kaleSurlariCaptureCard
      || !!limanCaptureCard
      || !!bereketCaptureCard
      || !!kahinCaptureCard
      || !!mancinikCaptureCard
      || !!mancinikComboCard
      || !!mancinikUsedCard
    ))
    || !!majorBonusNotice;

  const toastsNode = (
    <>
      {/* Bonus toast (transient, centered).  Suppressed while a major
       *  capture card (Kale Surları, Liman, or the Liman major-bonus
       *  notice) owns the moment so the same event isn't restated twice. */}
      {showBonusToast && lastBonusToast && !hasMajorCaptureCard && (() => {
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

      {/* Hidden bonus claim toast (viewer-aware).  Separate state channel
       *  from `lastBonusToast` so it never gets suppressed by major-bonus
       *  card logic — hidden bonuses are a parallel surface.  The renderer
       *  picks copy locally:
       *    - claimer sees the real bonus name + "envantere eklendi" detail
       *    - everyone else sees the generic "rakip gizli bonus keşfetti" copy
       *  The toast payload contains a `regionId` for future use, but the
       *  copy here deliberately never names it — paranoia is the feature. */}
      {showHiddenBonusToast && lastHiddenBonusToast && hiddenBonusToastCopy && !suppressHiddenBonusToast && (
        <div
          key={lastHiddenBonusToast.id}
          className="cq-bonus-toast"
          data-color={hiddenToastPlayerColor ?? undefined}
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">
            {hiddenBonusToastCopy.icon}
          </span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">
              {hiddenBonusToastCopy.title}
            </div>
            <div className="cq-bonus-toast-detail">
              {hiddenBonusToastCopy.detail}
            </div>
          </div>
        </div>
      )}

      {/* 👁️ İstihbarat Ağı — intel report toast.  Synced to every client but
       *  rendered ONLY for the current owner of the istihbarat_agi bonus
       *  region.  showIntelReportToast already gates on
       *  `intelNetworkOwnerId === myPlayerId`, so opponents never see this
       *  surface even though the payload reaches them. */}
      {showIntelReportToast && lastIntelReport && intelReportCopy && (
        <div
          key={lastIntelReport.id}
          className="cq-bonus-toast"
          data-color={intelReportToastColor ?? undefined}
          role="status"
          aria-live="polite"
        >
          <span className="cq-bonus-toast-icon" aria-hidden="true">
            {intelReportCopy.icon}
          </span>
          <div className="cq-bonus-toast-text">
            <div className="cq-bonus-toast-title">
              {intelReportCopy.title}
            </div>
            <div className="cq-bonus-toast-detail">
              {intelReportCopy.detail}
            </div>
          </div>
        </div>
      )}

      {/* Major bonus notice — premium first-capture banner.  Currently wired
       *  for Liman ⚓ only; suppresses the small bonus toast for the same
       *  capture event.  Subsequent captures + income ticks fall through to
       *  the existing small toast path. */}
      {majorBonusNotice && (
        <div
          key={majorBonusNotice.id}
          className="cq-major-bonus-notice"
          data-color={majorBonusNotice.color ?? undefined}
          role="status"
          aria-live="polite"
        >
          <span className="cq-major-bonus-notice-icon" aria-hidden="true">
            {majorBonusNotice.icon}
          </span>
          <div className="cq-major-bonus-notice-text">
            <div className="cq-major-bonus-notice-title">
              {majorBonusNotice.title}
            </div>
            <div className="cq-major-bonus-notice-body">
              {majorBonusNotice.body}
            </div>
          </div>
        </div>
      )}

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
            {duel?.kocbasiBypass && (
              <div
                className="cq-duel-mevzi-chip"
                role="note"
                aria-label="Koçbaşı avantajı"
              >
                🪵 Koçbaşı: Kalkan aşılır
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
  // Mirror the desktop suppression: skip the small bonus toast when a
  // major capture card (Kale Surları, Liman, or the Liman major-bonus
  // notice) already covers the same event.
  if (showBonusToast && lastBonusToast && !hasMajorCaptureCard) {
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

  const shouldShowQuestionPanel =
    phase === "challenge" && !hiddenOpToast && !showGameIntro && !showRoundIntro;

  // ── Debug log (?debugConquest=1) ──────────────────────────────────
  // Diagnostic to compare desktop/mobile/guest behaviour during the
  // round-intro → challenge → result transitions.  Disabled by default;
  // when the flag is on we emit only on TRANSITIONS (new challenge id,
  // panel visibility flip) so the console isn't flooded with per-render
  // noise that hides the moments that matter.  An extra "ping" log fires
  // on every render so we can still measure tick cadence if needed.
  if (debugConquestEnabled) {
    const ch = challengeState?.challenge;
    const currentChallengeId = ch?.id ?? null;
    const challengeChanged = prevDebugChallengeIdRef.current !== currentChallengeId;
    const panelVisibilityChanged =
      prevDebugShouldShowPanelRef.current !== shouldShowQuestionPanel;
    if (challengeChanged || panelVisibilityChanged) {
      const reason = challengeChanged
        ? (panelVisibilityChanged ? "challenge-change+panel-flip" : "challenge-change")
        : "panel-flip";
      // Single-line entry keyed by reason — easy to filter in DevTools.
      // eslint-disable-next-line no-console
      console.debug("[conquestPanel]", {
        reason,
        role:                    isHost ? "host" : "guest",
        isMobile,
        roomId,
        playerId:                myPlayerId,
        phase,
        roundNumber,
        challengeId:             currentChallengeId,
        challengeStatus:         challengeState?.status ?? null,
        challengePrompt:         ch?.title ?? ch?.prompt ?? null,
        challengeStartedAt:      challengeState?.startedAt ?? null,
        challengeEndsAt:         challengeState?.endsAt ?? null,
        duelId:                  duel?.id ?? null,
        duelStartedAt:           duel?.startedAt ?? null,
        duelQuestionVisibleAt:   duel?.questionVisibleAt ?? null,
        duelEndsAt:              duel?.endsAt ?? null,
        now,
        safeNow,
        dateNow:                 Date.now(),
        nowDrift:                Date.now() - now,
        serverTimeLeftMs,
        isLateArrival,
        remainingAtFirstSeen,
        roundIntroMsRemaining,
        challengeFirstSeenAt,
        msSinceFirstSeen:        Date.now() - challengeFirstSeenAt,
        showGameIntro,
        showRoundIntro,
        showDuelInfo,
        showDuelCountdown,
        showDuelPanel,
        shouldShowQuestionPanel,
        canAnswerByServerTime,
        canAnswer:
          shouldShowQuestionPanel
          && answeredChallengeId !== currentChallengeId
          && canAnswerByServerTime,
        alreadyAnswered:         answeredChallengeId === currentChallengeId,
        answeredDuelId,
        answeredChallengeId,
        lastRealtimeReceivedAt:  lastStateReceivedAtRef.current,
        msSinceLastRealtimeReceived:
          lastStateReceivedAtRef.current
            ? Date.now() - lastStateReceivedAtRef.current
            : null,
        gameStateUpdateCounter:  gameStateUpdateCounterRef.current,
        // We only ever consume gameState from the realtime row in
        // ConquestMode (no local optimistic apply), so the source is
        // always realtime by construction.  Surfaced explicitly so the
        // log line stays self-describing for whoever reads it later.
        source:                  "realtime",
        hiddenOpToast:           !!hiddenOpToast,
        actionHolderId:          gameState?.round.actionHolderId ?? null,
      });
    }
    prevDebugChallengeIdRef.current  = currentChallengeId;
    prevDebugShouldShowPanelRef.current = shouldShowQuestionPanel;
  }

  // ── Phase panel body (shared between desktop floating card and the
  //    mobile bottom sheet). The wrapper chrome differs per branch; this
  //    is just the panel content per phase. ────────────────────────────
  const phasePanelContent: ReactNode = (
    <>
      {shouldShowQuestionPanel && (
        <ConquestChallengePanel
          challengeState={challengeState}
          players={players}
          playerColors={playerColors}
          myPlayerId={myPlayerId}
          alreadyAnswered={
            answeredChallengeId === challengeState.challenge.id
          }
          msRemaining={Math.max(0, serverEndsAt - now)}
          onSubmitAnswer={handleSubmitAnswer}
          eliminatedChoice={localEliminatedChoice}
        />
      )}

      {/* Reveal phase intentionally renders no panel content here — the
       *  result card is a centered overlay (see cq-reveal-overlay below)
       *  so it doesn't get buried in the side card or mobile sheet body. */}

      {phase === "action" && canActOnRegion && (
        <>
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
            hasMancinikCharge={
              !!actionHolder
              && (gameState.playerBonuses?.[actionHolder.id]?.mancinikCharges ?? 0) > 0
            }
            onSkip={handleSkipAction}
          />
          {/* Mobile-only fate-card surface — desktop already shows the
           *  widget inside the player panel.  Inline here keeps the
           *  button inside the bottom sheet / dock so it never overlaps
           *  the map fit or the bonus strip. */}
          {isMobile && (
            <ConquestFateCardWidget
              mode={fateCardWidgetMode}
              visible={fateCardWidgetVisible}
              disabled={!canDrawFateCard || fateCardSpending}
              spending={fateCardSpending}
              cost={CONQUEST_FATE_CARD_COST}
              variant="mobile"
              onDraw={handleDrawFateCard}
            />
          )}
        </>
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
          kocbasiBypass={duel.kocbasiBypass === true}
          onSubmitAnswer={handleSubmitDuelAnswer}
        />
      )}

      {phase === "round_result" && (
        <section
          className="cq-round-result-panel"
          data-variant={limanCaptureCard ? "liman" : undefined}
          aria-label="Tur sonucu"
        >
          <div className="cq-rrc-icon" aria-hidden="true">{rrcIcon}</div>
          <div className="cq-rrc-title">{rrcTitle}</div>
          <p className="cq-rrc-subtitle">{rrcSubtitle}</p>
          {limanCaptureCard?.extra && (
            <p className="cq-rrc-liman-info">{limanCaptureCard.extra}</p>
          )}
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

          {!isLoggedInPlayer && (
            <p className="cq-finished-note" role="status">
              XP kazanmak için giriş yap.
            </p>
          )}

          <div className="cq-finished-actions">
            <button
              type="button"
              className="btn btn-accent cq-finished-back-btn"
              onClick={handleReturnToLobby}
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
      <ConquestFateCardReveal event={lastFateCardEvent} />
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
        {rrcIcon} {rrcTitle}
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
      {/* Kader Kartı reveal stays full-overlay on mobile so it isn't
       *  clipped by the bottom sheet or the map fit. */}
      <ConquestFateCardReveal event={lastFateCardEvent} />
      {bonusGuideNode}
    </>
  );

  // ── Mobile shell branch (Steps 1-4) ────────────────────────────────
  // Desktop layout below is preserved verbatim; the mobile shell uses
  // the same map and reuses `phasePanelContent` inside a real bottom
  // sheet (see MobileBottomSheet) instead of the legacy floating card.
  // Toasts still position:fixed for now — toast-queue lands in a later
  // step.  Landscape uses the same shell for now and inherits the
  // Mid-match leave confirmation.  Rendered into both the mobile and the
  // desktop return trees so the modal sits above whichever shell is active.
  const confirmLeaveNode = confirmLeaveOpen ? (
    <div
      className="modal-backdrop cq-confirm-leave-backdrop"
      role="presentation"
      onClick={cancelLeave}
    >
      <div
        className="modal cq-confirm-leave-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cq-confirm-leave-title"
        aria-describedby="cq-confirm-leave-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="cq-confirm-leave-title" className="cq-confirm-leave-title">
          Maçtan ayrılmak istiyor musun?
        </h2>
        <p id="cq-confirm-leave-desc" className="cq-confirm-leave-desc">
          Maç devam ederken ayrılırsan çekilmiş sayılabilirsin.
        </p>
        <ul className="cq-confirm-leave-points" role="list">
          <li>Bu maçtan çekilmiş sayılabilirsin.</li>
          <li>Geri dönemezsin, ilerlemen kaybolur.</li>
          <li>Tek aktif oyuncu rakibin kalırsa maçı otomatik kazanır.</li>
        </ul>
        <div className="cq-confirm-leave-actions">
          <button
            type="button"
            className="btn btn-accent cq-confirm-leave-cancel"
            onClick={cancelLeave}
            autoFocus
          >
            Vazgeç
          </button>
          <button
            type="button"
            className="btn cq-confirm-leave-confirm"
            onClick={confirmLeave}
          >
            Maçtan Ayrıl
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // Elimination modal — surfaced to the eliminated viewer the moment their
  // region count reaches 0 (and the match is still in progress).  Two
  // actions: "Oyunu İzle" dismisses the modal so the player can spectate
  // (the rest of the UI already disables input for eliminated players), and
  // "Odadan Ayrıl" routes through the existing confirm-leave flow.
  const eliminationModalNode =
    localEliminated
    && !eliminationModalDismissed
    && gameState?.phase !== "finished"
    && gameState?.phase !== "setup"
      ? (
        <div
          className="modal-backdrop cq-elimination-backdrop"
          role="presentation"
        >
          <div
            className="modal cq-elimination-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cq-elimination-title"
            aria-describedby="cq-elimination-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cq-elimination-icon" aria-hidden="true">💀</div>
            <h2 id="cq-elimination-title" className="cq-elimination-title">
              Hanedanlığının kontrolünü kaybettin!
            </h2>
            <p id="cq-elimination-desc" className="cq-elimination-desc">
              Tüm bölgelerini kaybettin. Bu maçta artık hamle yapamazsın.
            </p>
            <p className="cq-elimination-desc cq-elimination-desc--soft">
              Bir sonraki oyuna daha güçlü hazırlanman dileğiyle.
            </p>
            <div className="cq-elimination-actions">
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => {
                  playSound("click");
                  setEliminationModalDismissed(true);
                }}
                autoFocus
              >
                Oyunu İzle
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  playSound("click");
                  setEliminationModalDismissed(true);
                  onLeaveRoom();
                }}
              >
                Odadan Ayrıl
              </button>
            </div>
          </div>
        </div>
      ) : null;

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
              onBack={requestBack}
              onHelp={hasBonusGuide ? handleToggleBonusGuide : undefined}
              helpActive={bonusGuideOpen}
              onVolumeOpen={() => setBonusGuideOpen(false)}
              accountGold={accountGold}
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
              kahinPreview={kahinPreview}
            />
          }
          bonusStrip={
            orientation === "portrait" && hasBonusGuide
              ? <MobileBonusStrip entries={bonusGuideEntries} />
              : undefined
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
        {phase === "finished" && (
          <div className="cq-finished-backdrop" aria-hidden="true" />
        )}
        {confirmLeaveNode}
        {eliminationModalNode}
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
          onClick={requestBack}
          title="Odadan Ayrıl"
        >
          <span>←</span>
          <span className="back-label">Çık</span>
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
          <span
            className="cq-gold-chip"
            title="Hesap Gold bakiyen"
            aria-label={`Hesap Gold: ${accountGold}`}
          >
            <span className="cq-gold-chip-icon" aria-hidden="true">🟡</span>
            <span className="cq-gold-chip-value">{accountGold}g</span>
          </span>
          <ConquestVolumeControl
            variant="desktop"
            closeKey={desktopVolumeCloseKey}
            onOpen={() => setBonusGuideOpen(false)}
          />
          {hasBonusGuide ? (
            <button
              type="button"
              className="cq-help-btn"
              onClick={() => { setDesktopVolumeCloseKey(k => k + 1); handleToggleBonusGuide(); }}
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
          const mancinikPres   = getBonusTypePresentation("mancinik");
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
          if ((pb.mancinikCharges ?? 0) > 0) {
            bonusChips.push({
              key:   "mancinik",
              icon:  mancinikPres.icon,
              title: isMe
                ? "Mancınık hazır: bir sonraki saldırın komşuluk şartı olmadan haritadaki herhangi bir bölgeyi vurabilir"
                : `${player.name} Mancınık hakkına sahip: bir sonraki saldırısı uzak bir bölgeye gelebilir`,
            });
          }

          const eliminated = !!gameState && isPlayerEliminated(gameState, player.id);
          return (
            <div
              key={player.id}
              className={"cq-players-panel-row" + (isHolder ? " cq-players-panel-row--active" : "")}
              data-color={color}
              data-eliminated={eliminated || undefined}
              role="listitem"
              aria-label={
                `${player.name} — ${playerPoints[player.id] ?? 0} puan, `
                + `${regionCounts[player.id] ?? 0} bölge`
                + (eliminated ? " (elendi)" : isHolder ? " (sırada)" : "")
              }
            >
              <span className="cq-players-panel-dot" aria-hidden="true" />
              <span className="cq-players-panel-name">{player.name}</span>
              {eliminated && (
                <span
                  className="cq-eliminated-chip"
                  title="Tüm bölgelerini kaybetti — bu maçta artık aktif değil."
                >
                  💀 Elendi
                </span>
              )}
              <span
                className="cq-players-panel-gold"
                title={`Bu maçta kazanılan Gold: ${pb.matchGoldEarned ?? 0}g`}
                aria-label={`Bu maçta ${pb.matchGoldEarned ?? 0} Gold`}
              >
                <span aria-hidden="true">🟡</span>
                <span className="cq-players-panel-gold-amount">{pb.matchGoldEarned ?? 0}g</span>
              </span>
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
        {kahinPreview && (
          <div
            className="cq-kahin-preview"
            role="status"
            aria-label={`Kâhin görüsü: sıradaki soru ${kahinPreview}`}
            title="Kâhin Büyüsü — Kâhin bölgesini elinde tuttuğun sürece bu görü senin için açık kalır."
          >
            <span className="cq-kahin-preview-icon" aria-hidden="true">🔮</span>
            <span className="cq-kahin-preview-text">
              <span className="cq-kahin-preview-label">Kâhin Görüsü</span>
              <span className="cq-kahin-preview-value">Sıradaki soru: {kahinPreview}</span>
            </span>
          </div>
        )}
        {/* Gizli bonuslar — local-viewer only.  Opponents never see anyone's
         *  hidden bonus inventory — the section unmounts when the local
         *  viewer has nothing to consume. */}
        {(
          myUnusedSuikastEntries.length > 0
          || myUnusedLanetEntries.length  > 0
          || myUnusedPusuEntries.length   > 0
        ) && (
          <div className="cq-hidden-inventory" role="group" aria-label="Gizli bonusların">
            <div className="cq-hidden-inventory-title">🎁 Gizli Bonusların</div>
            {myUnusedSuikastEntries.map(entry => (
              <button
                key={entry.id}
                type="button"
                className="cq-hidden-inventory-btn"
                onClick={() => setSuikastPickerEntryId(entry.id)}
                aria-label="Suikast kullan — rakip oyuncu seç"
                title="Suikast: seçtiğin rakip oyuncudan 2 puan götürür (tek kullanımlık)."
              >
                <span aria-hidden="true">🗡️</span>
                <span className="cq-hidden-inventory-btn-text">Suikast Kullan</span>
              </button>
            ))}
            {myUnusedLanetEntries.map(entry => (
              <button
                key={entry.id}
                type="button"
                className="cq-hidden-inventory-btn"
                onClick={() => setLanetPickerEntryId(entry.id)}
                aria-label="Lanet Mührü kullan — rakip oyuncu seç"
                title="Lanet Mührü: seçtiğin rakibin bir sonraki doğru cevabında hamle hakkı mühürlenir (tek kullanımlık)."
              >
                <span aria-hidden="true">🧿</span>
                <span className="cq-hidden-inventory-btn-text">Lanet Mührü Kullan</span>
              </button>
            ))}
            {myUnusedPusuEntries.map(entry => {
              const isActive = pusuPlacementEntryId === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="cq-hidden-inventory-btn"
                  data-active={isActive ? "" : undefined}
                  onClick={() =>
                    setPusuPlacementEntryId(isActive ? null : entry.id)
                  }
                  aria-pressed={isActive}
                  aria-label="Pusu kur — haritadan bölge seç"
                  title="Pusu: kendi bölgene veya tarafsız bir bölgeye gizli pusu kurarsın. Rakip o bölgeye saldırırsa saldırısı iptal olur (tek kullanımlık)."
                >
                  <span aria-hidden="true">🕳️</span>
                  <span className="cq-hidden-inventory-btn-text">
                    {isActive ? "Pusu Kurulumu Açık" : "Pusu Kur"}
                  </span>
                </button>
              );
            })}
            {pusuPlacementEntryId && (
              <button
                type="button"
                className="btn btn-ghost cq-hidden-inventory-cancel"
                onClick={() => setPusuPlacementEntryId(null)}
                aria-label="Pusu kurulumunu iptal et"
              >
                İptal
              </button>
            )}
          </div>
        )}
        {/* Kader Kartı V1 — always-on widget that anchors the bottom of
         *  the player panel.  Visibility is gated on (a) the viewer being
         *  a match participant and (b) the match being in-progress; the
         *  active / waiting / used state then chooses what to show. */}
        <ConquestFateCardWidget
          mode={fateCardWidgetMode}
          visible={fateCardWidgetVisible}
          disabled={!canDrawFateCard || fateCardSpending}
          spending={fateCardSpending}
          cost={CONQUEST_FATE_CARD_COST}
          variant="desktop"
          onDraw={handleDrawFateCard}
        />
      </div>
      {/* Pusu placement-mode hint banner — only the owner sees it.  Floats
       *  above the map so the player understands which clicks are armed.
       *  Opponents never render this; the placement state is owner-local. */}
      {pusuPlacementEntryId && (
        <div className="cq-pusu-placement-banner" role="status" aria-live="polite">
          <span aria-hidden="true">🕳️</span>
          <span className="cq-pusu-placement-banner-text">
            Pusu kurmak için kendi bölgenden veya tarafsız bir bölgeden birini seç.
            Başkentlere ve rakip bölgelerine pusu kurulamaz.
          </span>
          <button
            type="button"
            className="btn btn-ghost cq-pusu-placement-banner-cancel"
            onClick={() => setPusuPlacementEntryId(null)}
          >
            İptal
          </button>
        </div>
      )}

      {/* Suikast target picker — modal overlay.  Lists opponents only; the
       *  local viewer is filtered out so self-targeting is impossible at the
       *  UI layer too (gameplay rejects it as a second guard). */}
      {suikastPickerEntryId && (
        <div
          className="cq-suikast-picker-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Suikast hedefi seç"
          onClick={() => setSuikastPickerEntryId(null)}
        >
          <div
            className="cq-suikast-picker"
            onClick={e => e.stopPropagation()}
          >
            <div className="cq-suikast-picker-header">
              <span aria-hidden="true">🗡️</span>
              <span>Suikast Hedefi Seç</span>
            </div>
            <p className="cq-suikast-picker-hint">
              Seçtiğin rakip 2 puan kaybedecek. Bu bonus tek kullanımlık.
            </p>
            <div className="cq-suikast-picker-list">
              {players
                .filter(p => p.id !== myPlayerId)
                .map(opponent => (
                  <button
                    key={opponent.id}
                    type="button"
                    className="cq-suikast-picker-row"
                    data-color={playerColors[opponent.id] ?? undefined}
                    onClick={() => handleUseSuikast(suikastPickerEntryId, opponent.id)}
                  >
                    <span className="cq-suikast-picker-dot" aria-hidden="true" />
                    <span className="cq-suikast-picker-name">{opponent.name}</span>
                    <span className="cq-suikast-picker-points" aria-hidden="true">
                      {playerPoints[opponent.id] ?? 0} puan
                    </span>
                  </button>
                ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost cq-suikast-picker-cancel"
              onClick={() => setSuikastPickerEntryId(null)}
            >
              İptal
            </button>
          </div>
        </div>
      )}

      {/* Lanet Mührü target picker — modal overlay.  Same shape as the Suikast
       *  picker (opponents-only, self-target filtered out, gameplay rejects
       *  self-target as a second guard). */}
      {lanetPickerEntryId && (
        <div
          className="cq-suikast-picker-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Lanet Mührü hedefi seç"
          onClick={() => setLanetPickerEntryId(null)}
        >
          <div
            className="cq-suikast-picker"
            onClick={e => e.stopPropagation()}
          >
            <div className="cq-suikast-picker-header">
              <span aria-hidden="true">🧿</span>
              <span>Lanet Mührü Hedefi Seç</span>
            </div>
            <p className="cq-suikast-picker-hint">
              Seçtiğin rakibin bir sonraki doğru cevabında hamle hakkı mühürlenecek. Bu bonus tek kullanımlık.
            </p>
            <div className="cq-suikast-picker-list">
              {players
                .filter(p => p.id !== myPlayerId)
                .map(opponent => (
                  <button
                    key={opponent.id}
                    type="button"
                    className="cq-suikast-picker-row"
                    data-color={playerColors[opponent.id] ?? undefined}
                    onClick={() => handleUseLanetMuhru(lanetPickerEntryId, opponent.id)}
                  >
                    <span className="cq-suikast-picker-dot" aria-hidden="true" />
                    <span className="cq-suikast-picker-name">{opponent.name}</span>
                    <span className="cq-suikast-picker-points" aria-hidden="true">
                      {playerPoints[opponent.id] ?? 0} puan
                    </span>
                  </button>
                ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost cq-suikast-picker-cancel"
              onClick={() => setLanetPickerEntryId(null)}
            >
              İptal
            </button>
          </div>
        </div>
      )}

      {/* ── Board (desktop wrap; mobile shell uses .mcq-map-slot) ─ */}
      <div className="cq-game-board-wrap">
        <div className="cq-game-board-inner">
          <p className="cq-game-map-title" aria-hidden="true">
            {mapIcon(settings.map)} {mapConfig.displayName}
          </p>
          {mapNode}
        </div>
      </div>

      {/* ── Sonuç ekranı arka plan blur + hafif koyu overlay ── */}
      {phase === "finished" && (
        <div className="cq-finished-backdrop" aria-hidden="true" />
      )}

      {/* ── Toasts + floating phase card (shared with mobile shell) ── */}
      {overlaysNode}


      {/* ── DEV-ONLY: hidden bonus test panel ──────────────────── */}
      {import.meta.env.DEV && myPlayerId && gameState && (
        <div className="cq-debug-panel" aria-label="Dev: Gizli Bonus Test">
          <div className="cq-debug-panel-title">🧪 Gizli Bonus Test</div>
          <button
            type="button"
            className="cq-debug-panel-btn"
            onClick={() => handleDebugGiveBonus("suikast")}
          >
            🗡️ Bana Suikast Ver
          </button>
          <button
            type="button"
            className="cq-debug-panel-btn"
            onClick={() => handleDebugGiveBonus("lanet_muhru")}
          >
            🧿 Bana Lanet Mührü Ver
          </button>
          <button
            type="button"
            className="cq-debug-panel-btn"
            onClick={() => handleDebugGiveBonus("pusu")}
          >
            🪤 Bana Pusu Ver
          </button>
        </div>
      )}

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
            onClick={requestBack}
          >
            ← Odadan Ayrıl
          </button>
        )}
      </div>
      {confirmLeaveNode}
      {eliminationModalNode}

      {/* ════════ XP KAZANIMI — fixed footer (reusable XpGainBar) ════════ */}
      {xpResult && !xpResult.dismissed && (
        <XpGainBar
          key={xpResult.roomKey}
          modeLabel="KUŞATMA"
          prevTotalXp={xpResult.prevTotalXp}
          newTotalXp={xpResult.totalXp}
          prevModeXp={xpResult.prevModeXp}
          newModeXp={xpResult.modeXp}
          xpEarned={xpResult.xpEarned}
          awarded={xpResult.awarded}
          breakdown={xpResult.breakdown}
          onDismiss={() =>
            setXpResult(prev => (prev ? { ...prev, dismissed: true } : null))
          }
        />
      )}
    </div>
  );
}
