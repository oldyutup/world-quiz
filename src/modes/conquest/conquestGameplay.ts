/**
 * Conquest (Kuşatma) — gameplay state factory and transition helpers.
 *
 * Pure module — no React, no Supabase.  All functions are immutable: they
 * take a ConquestGameState and return a new one.  The driver (currently
 * ConquestGame.tsx) owns the live reference and re-renders on swap.
 *
 * Phase-6 scope: the round loop
 *   challenge → action → round_result → next round (or finished)
 *
 * Gameplay state is *local-only* in this phase.  No DB persistence, no
 * realtime sync of region ownership across clients.  Room phase (waiting /
 * playing) is still server-synced via `conquest_rooms.status`, so every
 * client enters this screen together, but each client then runs its own
 * independent local simulation.  See ConquestGame.tsx for the driver and
 * the inline "Yerel önizleme" notice that surfaces this constraint.
 */

import {
  applyConquestAction,
  getAllLegalTargetsForPlayer,
  getLegalActionsForPlayer,
  isLegalTarget,
} from "./conquestActions";
import { getConquestSyncedNowMs } from "./conquestClock";
import {
  CONQUEST_CHALLENGE_DURATION_MS,
  CONQUEST_REVEAL_DURATION_MS,
  pickRandomConquestChallenge,
} from "./conquestChallenges";
import { isChallengeAnswerCorrect } from "./conquestChallengeValidation";
import { createInitialRegionStates } from "./conquestState";
import { getPlayerTotalPoints, getRegionPoints } from "./regionPoints";
import {
  buildBonusToast,
  buildHiddenOpPlacedMessage,
  buildKocbasiCaptureToast,
  buildMevziLossToast,
  createEmptyPlayerBonusState,
  HIDDEN_CONQUEST_REVEAL_MESSAGE,
  HIDDEN_NEUTRAL_TRAP_REVEAL_MESSAGE,
  HIDDEN_SHIELD_REVEAL_MESSAGE,
  KARADENIZ_BONUS_MS,
} from "./regionBonuses";
import {
  buildRoundBonusAssignment,
  findRegionIdForBonusType,
  resolveActiveBonus,
} from "./conquestRoundBonuses";
import {
  buildGizliOpIntelReport,
  buildHiddenBonusPlacements,
  buildHiddenClaimIntelReport,
  consumePendingCurseOnTrigger,
  hasPendingCurse,
  tryClaimHiddenBonus,
  tryConsumePendingAmbush,
  useLanetMuhruHiddenBonus,
  usePusuHiddenBonus,
  useSuikastHiddenBonus,
} from "./conquestHiddenBonuses";
import type {
  ConquestActionResult,
  ConquestBonusToast,
  ConquestChallenge,
  ConquestChallengeAnswer,
  ConquestChallengeState,
  ConquestChallengeType,
  ConquestDefenseDuelState,
  ConquestEliminationEvent,
  ConquestFinalStanding,
  ConquestGameState,
  ConquestMapConfig,
  ConquestPendingAction,
  ConquestPlayer,
  ConquestPlayerBonusState,
  ConquestPlayerHiddenBonus,
  ConquestRegionBonusType,
  ConquestRegionId,
  ConquestRegionState,
  ConquestRoundBonusAssignment,
  ConquestRoundState,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — move (action) phase
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long the hamle (move) phase stays open after a player wins the
 * challenge.  Kept deliberately tight so a 6–10 round match still feels
 * snappy on mobile.  When region bonuses ship, do NOT change this — extend
 * the per-player window inside `getMovePhaseDurationMs` instead.
 */
export const MOVE_PHASE_SECONDS = 15;
export const MOVE_PHASE_MS      = MOVE_PHASE_SECONDS * 1000;

/**
 * Savunma Düellosu süresi — bonuslu bölgeye saldırı sırasında açılan
 * 1-vs-1 sorunun toplam süresi.  Kasten kısa: tempo bozulmasın.  Süre
 * biterse savunan kazanır (bölge korunur).
 */
export const DEFENSE_DUEL_SECONDS   = 8;
export const DEFENSE_DUEL_MS        = DEFENSE_DUEL_SECONDS * 1000;
/**
 * Intro overlay duration before the question becomes visible (ms).
 * = 4000ms info card + 3000ms 3-2-1 countdown.
 */
export const DEFENSE_DUEL_INTRO_MS  = 7000;
export const DEFENSE_DUEL_INFO_MS   = 4000; // info card portion
export const DEFENSE_DUEL_COUNTDOWN_MS = 3000; // 3-2-1 portion

/**
 * Compute the move-phase duration for `holderId` in the given state.  Pure
 * read of the current bonus state — does NOT consume the bonus.  Use
 * `consumeMoveTimeBonus` when actually starting the move phase so the bonus
 * is spent exactly once.
 */
export function getMovePhaseDurationMs(
  state:    ConquestGameState,
  holderId: string,
): number {
  const extra = state.playerBonuses?.[holderId]?.extraNextMoveMs ?? 0;
  return MOVE_PHASE_MS + extra;
}

/**
 * Consume the holder's one-shot move-time bonus (Doğu Karadeniz: +5s) and
 * return both the resulting move-phase duration and the next playerBonuses
 * snapshot with `extraNextMoveMs` zeroed for that holder.
 *
 * Caller must persist `playerBonuses` in the next ConquestGameState — see
 * resolveChallengeWithWinner for the single call site.
 */
export function consumeMoveTimeBonus(
  state:    ConquestGameState,
  holderId: string,
): {
  durationMs:    number;
  playerBonuses: Record<string, ConquestPlayerBonusState>;
} {
  const current = state.playerBonuses ?? {};
  const pb      = current[holderId] ?? createEmptyPlayerBonusState();
  const extra   = pb.extraNextMoveMs;
  if (extra <= 0) {
    return { durationMs: MOVE_PHASE_MS, playerBonuses: current };
  }
  return {
    durationMs:    MOVE_PHASE_MS + extra,
    playerBonuses: { ...current, [holderId]: { ...pb, extraNextMoveMs: 0 } },
  };
}

/**
 * 👁️ İstihbarat Ağı — find the player currently controlling the intel
 * network region (if any).  Returns null when no region carries the
 * istihbarat_agi bonus this match or when the region is neutral.
 *
 * Used by the renderer to decide whether the local viewer should see the
 * `lastIntelReport` toast.  Intel reports are synced to every client, but
 * only the current owner of this region is allowed to display them.
 */
export function getIntelNetworkOwnerId(
  state: ConquestGameState,
): string | null {
  const regionId = findRegionIdForBonusType(state.roundBonuses, "istihbarat_agi");
  if (!regionId) return null;
  const rs = state.regionStates.find(r => r.regionId === regionId);
  return rs?.ownerPlayerId ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the initial ConquestGameState for a brand-new match.
 *
 *  - Distributes regions via createInitialRegionStates (seeded snake-draft,
 *    value-balanced, adjacency-aware; controlled-random with fairness
 *    retry, leftovers neutral)
 *  - Mounts the round-1 placeholder challenge in `active` status
 *  - Phase starts at `challenge` so the UI shows the challenge panel
 *    immediately; the `setup` phase is reserved for any future async
 *    preparation step (deal animation, ready-up, etc.).
 *
 * `totalRounds` is clamped to >=1 to keep downstream math safe.
 */
// Duration of the game-start intro overlay.  The first challenge's timer
// is anchored to `gameIntroEndsAt` so no seconds tick away during the intro.
const GAME_INTRO_TEXT_MS      = 9_000; // info card visible
const GAME_INTRO_COUNTDOWN_MS = 3_000; // 3-2-1 countdown
const GAME_INTRO_TOTAL_MS     = GAME_INTRO_TEXT_MS + GAME_INTRO_COUNTDOWN_MS;

// Per-round intro pacing (rounds 2+).  We push the new challenge's
// startedAt this far into the future so the dedicated intro overlay
// (info card + 3-2-1 countdown) gets airtime before the question and
// its timer appear.  The host's expireChallenge timer reads endsAt
// (= startedAt + CONQUEST_CHALLENGE_DURATION_MS), so it shifts
// forward automatically — no seconds tick away during the intro.
//
// Split into two phases so the renderer can switch overlays without
// re-deriving timings:
//   - ROUND_INTRO_CARD_MS  : "Tur N Başlıyor" info card
//   - ROUND_COUNTDOWN_MS   : "3 → 2 → 1" countdown
// Plus an explicit "sync buffer" tacked onto the front of the intro
// card so even if the realtime payload lands a few seconds late on a
// slow client, the question's `startedAt` is still in the future when
// the payload arrives — preventing the "panel flashes at 0 seconds and
// the game teleports forward" symptom on PC guests with slow channels.
// Total intro window = sum of the three.  Sync buffer is generous (6s) so
// even a PC guest on a degraded realtime channel receives the new
// challenge state with `startedAt` still in the future — the prior 2s was
// too tight in the wild and caused the panel to open with 0 seconds left
// on slow clients.
export const QUESTION_SYNC_BUFFER_MS = 3_000;
export const ROUND_INTRO_CARD_MS  = 2_000;
export const ROUND_COUNTDOWN_MS   = 3_000;
// Extra wall time after the synced `endsAt` before the host pushes the
// expire write.  All clients share the same `challenge.endsAt`; this
// grace gives slower clients a fair chance to submit before the host
// flips the synced `status` to non-active.  Per-client window extension
// has been removed — this grace is the single shared cushion.
export const GUEST_SETTLE_GRACE_MS = 4_000;
const ROUND_INTRO_PACING_MS =
  QUESTION_SYNC_BUFFER_MS + ROUND_INTRO_CARD_MS + ROUND_COUNTDOWN_MS;

export function createInitialConquestGameState(
  mapConfig:           ConquestMapConfig,
  players:             ConquestPlayer[],
  totalRounds:         number,
  selectedBonusTypes?: readonly ConquestRegionBonusType[],
): ConquestGameState {
  const safeRounds = Math.max(1, Math.floor(totalRounds));
  const now        = getConquestSyncedNowMs();
  // `now` doubles as the per-match seed for the controlled-random region
  // allocator. The host computes this once and uploads the result, so the
  // seed itself doesn't need to be persisted or shared with guests.
  const regionStates = createInitialRegionStates(mapConfig, players, now);

  // Seed empty bonus state for every player.  Bonuses only trigger via
  // capture events, so starting ownership never grants them.
  const playerBonuses: Record<string, ConquestPlayerBonusState> = {};
  for (const p of players) playerBonuses[p.id] = createEmptyPlayerBonusState();

  // Match-level bonus assignment — seeded from match start, fixed for
  // every round.  Round transitions never rebuild this; new matches reseed.
  // When `selectedBonusTypes` is supplied (vote mode), the assignment uses
  // those types verbatim; otherwise it falls back to the legacy random pick.
  const roundBonuses = buildRoundBonusAssignment(
    mapConfig, regionStates, players, now, selectedBonusTypes,
  );

  // Hidden bonus placements — computed AFTER the open bonus assignment so
  // open-bonus regions can be excluded by id.  Independently seeded stream
  // off the same `now` match seed; may legitimately be empty (no roll hit).
  const hiddenBonusPlacements = buildHiddenBonusPlacements({
    mapConfig,
    regionStates,
    roundBonuses,
    playerCount: players.length,
    matchSeed:   now,
  });
  // Seed empty hidden-bonus inventory for every player.  Hidden bonuses only
  // enter the inventory via region capture; starting ownership grants nothing
  // (and starting regions are excluded from the candidate pool anyway).
  const playerHiddenBonuses: Record<string, ConquestPlayerHiddenBonus[]> = {};
  for (const p of players) playerHiddenBonuses[p.id] = [];

  const { challenge, bankId } = pickRandomConquestChallenge(1, players, [], undefined);

  // Anchor the first challenge's timer to after the intro so the 20-second
  // clock doesn't start until the player can actually see the question.
  const gameIntroEndsAt = now + GAME_INTRO_TOTAL_MS;

  const round: ConquestRoundState = {
    roundNumber:    1,
    totalRounds:    safeRounds,
    challenge:      buildActiveChallengeState(challenge, gameIntroEndsAt),
    actionHolderId: null,
    lastResult:     null,
  };

  // Kâhin Büyüsü 🔮 — pre-pick the round-2 challenge so the Kâhin region's
  // owner can peek at the upcoming question's type during round 1.  Skipped
  // when the match is only 1 round long (no future round to preview).
  let nextChallenge: ConquestGameState["nextChallenge"];
  let usedChallengeKeys = [bankId];
  if (safeRounds >= 2) {
    const next = pickRandomConquestChallenge(
      2, players, usedChallengeKeys, challenge.type as ConquestChallengeType,
    );
    nextChallenge = { challenge: next.challenge, bankId: next.bankId };
    usedChallengeKeys = [...usedChallengeKeys, next.bankId];
  }

  return {
    mapId:                  mapConfig.id,
    players,
    phase:                  "challenge",
    round,
    regionStates,
    history:                [],
    startedAt:              now,
    finishedAt:             null,
    usedChallengeKeys,
    lastChallengeType:      challenge.type as ConquestChallengeType,
    playerBonuses,
    gameIntroEndsAt,
    roundBonuses,
    nextChallenge,
    hiddenBonusPlacements,
    playerHiddenBonuses,
  };
}

/**
 * Build a fresh `active` ConquestChallengeState wrapping the given challenge.
 * Centralised so every place that mounts a challenge agrees on the duration
 * and on the initial empty submission log.
 */
function buildActiveChallengeState(
  challenge: ConquestChallenge,
  now:       number,
): ConquestChallengeState {
  return {
    challenge,
    status:                "active",
    winnerPlayerId:        null,
    firstCorrectPlayerId:  null,
    answeredPlayerIds:     [],
    startedAt:             now,
    endsAt:                now + CONQUEST_CHALLENGE_DURATION_MS,
    submittedAnswers:      [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the active challenge with the given winner.  Transitions phase
 * from `challenge` → `action`.  Idempotent: if the challenge is already
 * resolved or the phase isn't `challenge`, the state is returned unchanged.
 *
 * `winnerId` must be in the challenge's `eligiblePlayerIds`; otherwise the
 * call is a no-op (defensive — UI buttons should only offer eligible ids).
 *
 * Optional `answer` records the winning submission into `submittedAnswers`
 * so the round panel can show what was typed.  Wrong attempts are tracked
 * client-locally only (see ConquestChallengePanel) to avoid write contention.
 */
export function resolveChallengeWithWinner(
  state:    ConquestGameState,
  winnerId: string,
  answer?:  { text: string; playerName: string },
): ConquestGameState {
  if (state.phase !== "challenge") return state;
  if (state.round.challenge.status !== "active") return state;
  if (!state.round.challenge.challenge.eligiblePlayerIds.includes(winnerId)) {
    return state;
  }

  const now = getConquestSyncedNowMs();
  const winningEntry: ConquestChallengeAnswer | null = answer
    ? {
        playerId:   winnerId,
        playerName: answer.playerName,
        answer:     answer.text,
        correct:    true,
        at:         now,
      }
    : null;

  const { durationMs, playerBonuses } = consumeMoveTimeBonus(state, winnerId);

  return {
    ...state,
    phase: "action",
    playerBonuses,
    round: {
      ...state.round,
      challenge: {
        ...state.round.challenge,
        status:         "resolved",
        winnerPlayerId: winnerId,
        resolvedAt:     now,
        submittedAnswers: winningEntry
          ? [...state.round.challenge.submittedAnswers, winningEntry]
          : state.round.challenge.submittedAnswers,
      },
      actionHolderId:  winnerId,
      actionStartedAt: now,
      actionEndsAt:    now + durationMs,
    },
  };
}

/**
 * Validate `rawAnswer` against the active challenge for `submitterId`.
 *
 * Two-phase semantics (see also `expireChallenge` + `finalizeReveal`):
 *   - The challenge timer runs for its full duration regardless of who
 *     answered when.  A correct submission is *recorded* into the synced
 *     state (so the eventual reveal can attribute it) but the phase does
 *     NOT transition early.  Only the *first* correct submission seen on
 *     a snapshot is recorded; later corrects are accepted-but-not-first.
 *   - When the timer hits zero, `expireChallenge` promotes
 *     `firstCorrectPlayerId` → `winnerPlayerId` and moves the round into
 *     the "reveal" phase.  `finalizeReveal` then drives the transition to
 *     `action` (winner exists) or `round_result` (skip).
 *
 * Result fields:
 *   - `ok`           — was this a legal submission at all?
 *   - `correct`      — did the answer match `acceptedAnswers`?
 *   - `firstCorrect` — did this submission land as the *first* correct
 *     answer on the snapshot the caller passed in?  Drives the host-side
 *     reveal attribution (last-write-wins race semantics inherited from the
 *     pre-reveal code; server-authoritative resolution is future work).
 *   - `winning`      — alias for `firstCorrect`, retained so existing
 *     callers that destructure { winning } stay source-compatible.
 *
 * One-answer-per-player is NOT enforced here; the client (ConquestGame)
 * applies it locally via `answeredChallengeId` so wrong submissions never
 * touch the synced state.
 */
export interface SubmitAnswerResult {
  ok:           boolean;
  correct:      boolean;
  firstCorrect: boolean;
  /** @deprecated — use `firstCorrect`. Kept for backward-compat destructuring. */
  winning:      boolean;
  state:        ConquestGameState;
}

export function submitChallengeAnswer(
  state:       ConquestGameState,
  submitterId: string,
  rawAnswer:   string,
): SubmitAnswerResult {
  if (state.phase !== "challenge") {
    return { ok: false, correct: false, firstCorrect: false, winning: false, state };
  }
  if (state.round.challenge.status !== "active") {
    return { ok: false, correct: false, firstCorrect: false, winning: false, state };
  }
  // Eliminated players cannot submit — defensive guard in addition to the
  // eligibility list, which is rebuilt to exclude them on every round advance.
  if (isPlayerEliminated(state, submitterId)) {
    return { ok: false, correct: false, firstCorrect: false, winning: false, state };
  }
  const challenge = state.round.challenge.challenge;
  if (!challenge.eligiblePlayerIds.includes(submitterId)) {
    return { ok: false, correct: false, firstCorrect: false, winning: false, state };
  }

  const correct          = isChallengeAnswerCorrect(challenge, rawAnswer);
  const existingAnswered = state.round.challenge.answeredPlayerIds ?? [];
  const alreadyInSet     = existingAnswered.includes(submitterId);
  const answeredPlayerIds = alreadyInSet
    ? existingAnswered
    : [...existingAnswered, submitterId];

  const baseChallengeUpdate = {
    ...state.round.challenge,
    answeredPlayerIds,
  };

  // Eleme Yetkisi consumption.  The bonus only applies to multiple-choice
  // challenges (those with a non-empty `choices` array); flag-guess and
  // type-race challenges leave the charge intact for a later MC question.
  // We consume on submission — any answer (correct or wrong) counts as a
  // formal use of the eliminated-option help.  Timeouts preserve the
  // charge by design (no submit = no benefit committed).  Defense duels
  // never reach this path (they route through `submitDuelAnswer`), so the
  // charge survives a duel turn too.
  const submitterPb     = state.playerBonuses?.[submitterId];
  const consumeOnSubmit =
    !!challenge.choices
    && challenge.choices.length > 0
    && (submitterPb?.eliminatorCharges ?? 0) > 0;
  const playerBonusesAfter = consumeOnSubmit
    ? {
        ...(state.playerBonuses ?? {}),
        [submitterId]: {
          ...(submitterPb ?? createEmptyPlayerBonusState()),
          eliminatorCharges: 0,
        },
      }
    : state.playerBonuses;

  if (!correct) {
    // Wrong answer: record participation only.  Push lets the host see
    // every active player has weighed in, enabling early reveal.
    const next: ConquestGameState = {
      ...state,
      playerBonuses: playerBonusesAfter,
      round: {
        ...state.round,
        challenge: baseChallengeUpdate,
      },
    };
    return { ok: true, correct: false, firstCorrect: false, winning: false, state: next };
  }

  // Already-recorded first correct on this snapshot — accept locally but
  // do not overwrite firstCorrect.  Still record participation so the
  // early-reveal check trips.
  if (state.round.challenge.firstCorrectPlayerId) {
    const next: ConquestGameState = {
      ...state,
      playerBonuses: playerBonusesAfter,
      round: {
        ...state.round,
        challenge: baseChallengeUpdate,
      },
    };
    return { ok: true, correct: true, firstCorrect: false, winning: false, state: next };
  }

  const submitter = state.players.find(p => p.id === submitterId);
  const now = getConquestSyncedNowMs();
  const answerEntry: ConquestChallengeAnswer = {
    playerId:   submitterId,
    playerName: submitter?.name ?? "Oyuncu",
    answer:     rawAnswer,
    correct:    true,
    at:         now,
  };

  // Record the first correct WITHOUT transitioning phase — the timer must
  // still run to completion (or the early-reveal check trip) so every
  // client gets to attempt the question.
  const next: ConquestGameState = {
    ...state,
    playerBonuses: playerBonusesAfter,
    round: {
      ...state.round,
      challenge: {
        ...baseChallengeUpdate,
        firstCorrectPlayerId: submitterId,
        submittedAnswers: [
          ...state.round.challenge.submittedAnswers,
          answerEntry,
        ],
      },
    },
  };
  return { ok: true, correct: true, firstCorrect: true, winning: true, state: next };
}

/**
 * Challenge timer hit zero.  Promotes the (possibly null) firstCorrect
 * submission to the round's `winnerPlayerId` and transitions the phase
 * into the new "reveal" sub-phase, where the answer + winner are shown to
 * every client for `CONQUEST_REVEAL_DURATION_MS` before `finalizeReveal`
 * routes the round forward.
 *
 * Idempotent: returns state unchanged if the challenge is already past the
 * "active" status or the phase has moved on.
 *
 * Host-only writer in the live loop (see ConquestGame.tsx) to keep the
 * timeout authoritative and avoid two clients racing to expire.
 */
export function expireChallenge(state: ConquestGameState): ConquestGameState {
  if (state.phase !== "challenge") return state;
  if (state.round.challenge.status !== "active") return state;

  const now = getConquestSyncedNowMs();
  const firstCorrectPlayerId = state.round.challenge.firstCorrectPlayerId ?? null;
  const hasWinner = !!firstCorrectPlayerId
    && state.round.challenge.challenge.eligiblePlayerIds.includes(firstCorrectPlayerId);

  return {
    ...state,
    phase: "reveal",
    round: {
      ...state.round,
      challenge: {
        ...state.round.challenge,
        status:         hasWinner ? "resolved" : "skipped",
        winnerPlayerId: hasWinner ? firstCorrectPlayerId : null,
        resolvedAt:     now,
      },
      revealStartedAt: now,
      revealEndsAt:    now + CONQUEST_REVEAL_DURATION_MS,
    },
  };
}

/**
 * Reveal window ended — drive the round forward.
 *
 * Winner-present case: spend the move-time bonus (if any), set the action
 * holder + action timer, transition to "action" phase.  This mirrors the
 * pre-reveal `resolveChallengeWithWinner` setup, just deferred so the
 * reveal copy gets airtime.
 *
 * No-winner case: jump straight to round_result with the existing skip
 * messaging so downstream flows (round history, mobile sheet, etc.) keep
 * recognising the "kimse bilemedi" branch.
 *
 * Idempotent: returns state unchanged if the phase isn't "reveal".
 */
export function finalizeReveal(state: ConquestGameState): ConquestGameState {
  if (state.phase !== "reveal") return state;

  const now = getConquestSyncedNowMs();
  const winnerId = state.round.challenge.winnerPlayerId ?? null;

  if (winnerId
    && state.round.challenge.challenge.eligiblePlayerIds.includes(winnerId)
  ) {
    // Lanet Mührü 🧿 — if the winner is cursed, the move is mühürlendi.
    // The curse is consumed exactly here (the moment hamle hakkı would
    // otherwise be granted); wrong/no-winner branches never reach this
    // line, so a wrong answer leaves the curse intact.
    if (hasPendingCurse(state.activeHiddenEffects, winnerId)) {
      const winner = state.players.find(p => p.id === winnerId);
      const winnerName = winner?.name ?? "Oyuncu";
      const curseDiff = consumePendingCurseOnTrigger(
        state.activeHiddenEffects,
        winnerId,
        winnerName,
        now,
      );
      const cursedResult: ConquestActionResult = {
        ok:       true,
        action:   "skip",
        playerId: winnerId,
        regionId: null,
        message:  `${winnerName} doğru bildi ancak Lanet Mührü hamle hakkını mühürledi.`,
      };
      return {
        ...state,
        phase: "round_result",
        activeHiddenEffects:  curseDiff?.activeHiddenEffects  ?? state.activeHiddenEffects,
        lastHiddenBonusToast: curseDiff?.lastHiddenBonusToast ?? state.lastHiddenBonusToast,
        round: {
          ...state.round,
          actionHolderId:  null,
          lastResult:      cursedResult,
          revealStartedAt: undefined,
          revealEndsAt:    undefined,
        },
      };
    }

    const { durationMs, playerBonuses } = consumeMoveTimeBonus(state, winnerId);
    return {
      ...state,
      phase: "action",
      playerBonuses,
      round: {
        ...state.round,
        actionHolderId:  winnerId,
        actionStartedAt: now,
        actionEndsAt:    now + durationMs,
        revealStartedAt: undefined,
        revealEndsAt:    undefined,
      },
    };
  }

  // No correct answer in the window → skip the round.
  const expiredResult: ConquestActionResult = {
    ok:       true,
    action:   "skip",
    playerId: "",
    regionId: null,
    message:  "Kimse doğru cevap veremedi. Tur boşa geçti.",
  };
  return {
    ...state,
    phase: "round_result",
    round: {
      ...state.round,
      actionHolderId:  null,
      lastResult:      expiredResult,
      revealStartedAt: undefined,
      revealEndsAt:    undefined,
    },
  };
}

/**
 * Skip the active challenge with no winner (e.g. timer expired, all
 * forfeited).  Records the challenge as `skipped` and jumps straight to
 * `round_result` so the round can advance without an action.
 */
export function skipChallenge(state: ConquestGameState): ConquestGameState {
  if (state.phase !== "challenge") return state;
  const now = getConquestSyncedNowMs();
  const skippedResult: ConquestActionResult = {
    ok:       true,
    action:   "skip",
    playerId: "",
    regionId: null,
    message:  "Mücadelede kazanan çıkmadı — tur atlandı.",
  };
  return {
    ...state,
    phase: "round_result",
    round: {
      ...state.round,
      challenge: {
        ...state.round.challenge,
        status:     "skipped",
        resolvedAt: now,
      },
      actionHolderId: null,
      lastResult:     skippedResult,
    },
  };
}

interface ApplyActionResult {
  state:  ConquestGameState;
  result: ConquestActionResult;
}

/**
 * Apply Ankara/Çukurova/Karadeniz capture-side bonuses *after* a successful
 * ownership flip onto `capturedRegionId`.  Returns the updated regionStates
 * and playerBonuses; never mutates inputs.
 *
 * Per the revised spec, the pending Ankara Gizli Operasyon is NEVER consumed
 * by a capture — it is only spent by manual placement (own-region shield via
 * `placeHiddenShieldOnOwnRegion`, or neutral-region gizli fetih via
 * `placeHiddenConquestOnNeutralRegion`).  This function only applies the
 * captured region's own bonus (stacking forbidden — each branch overwrites).
 */
function triggerCaptureBonus(
  regionStates:      ConquestRegionState[],
  playerBonusesIn:   Record<string, ConquestPlayerBonusState> | undefined,
  roundBonuses:      ConquestRoundBonusAssignment | undefined,
  ownerId:           string,
  ownerName:         string,
  capturedRegionId:  ConquestRegionId,
  now:               number,
  _wasNeutralCapture: boolean,
): {
  regionStates:  ConquestRegionState[];
  playerBonuses: Record<string, ConquestPlayerBonusState>;
  toast?:        ConquestBonusToast;
} {
  const current = playerBonusesIn ?? {};
  const pb = { ...(current[ownerId] ?? createEmptyPlayerBonusState()) };
  let nextRegionStates = regionStates;
  let toast: ConquestBonusToast | undefined;

  // Step 2 — apply the captured region's own bonus, if any.  Each branch
  // also emits a public toast announcing the bonus earned (NOT the hidden
  // placement above).  Resolve through the dynamic per-round assignment so
  // any region carrying a bonus this round triggers; legacy static lookups
  // fall through inside `resolveActiveBonus`.
  const bonus = resolveActiveBonus(roundBonuses, capturedRegionId);
  if (bonus) {
    switch (bonus.type) {
      case "ankara_hidden_shield":
        // Overwrite-not-stack: already-true stays true.
        pb.pendingHiddenShield = true;
        toast = buildBonusToast("ankara_hidden_shield", capturedRegionId, ownerId, ownerName, now);
        break;
      case "karadeniz_extra_time":
        // Overwrite-not-stack.
        pb.extraNextMoveMs = KARADENIZ_BONUS_MS;
        toast = buildBonusToast("karadeniz_extra_time", capturedRegionId, ownerId, ownerName, now);
        break;
      case "cukurova_score":
        // Bereketli Ova 🌾 — every capture of the bereket region pays the
        // new owner +BEREKET_CAPTURE_POINTS on top of the region's own
        // points.  The harvest counter is reset to 0 by the flipOwnership
        // path (see conquestActions.ts) so the new owner has to hold the
        // region for BEREKET_HARVEST_INTERVAL rounds before the next +4
        // harvest fires.  The legacy `cukurovaClaimed` flag is left
        // untouched here — it's no longer consulted for gating.
        pb.bonusPoints = pb.bonusPoints + BEREKET_CAPTURE_POINTS;
        toast = buildBonusToast("cukurova_score", capturedRegionId, ownerId, ownerName, now);
        break;
      case "istanbul_defense":
        // Auto-stamp the open shield onto whichever region carries the
        // istanbul_defense bonus this round.  Stacking is implicit:
        // capturing flipOwnership() clears `shielded`, so a player can
        // never accumulate more than one open shield via this bonus.
        nextRegionStates = nextRegionStates.map(rs =>
          rs.regionId === capturedRegionId
            ? { ...rs, shielded: true }
            : rs,
        );
        toast = buildBonusToast("istanbul_defense", capturedRegionId, ownerId, ownerName, now);
        break;
      case "eleme_yetkisi":
        // Overwrite-not-stack: cap at 1 pending elimination.  Consumed on
        // the owner's next multiple-choice challenge submission only (see
        // submitChallengeAnswer); non-MC challenges leave the charge intact.
        pb.eliminatorCharges = 1;
        toast = buildBonusToast("eleme_yetkisi", capturedRegionId, ownerId, ownerName, now);
        break;
      case "mevzi_bekcisi":
        // Pure region/owner-tied effect: as long as the current owner
        // controls this region, defending it in a duel earns them +3s.
        // No per-player state to mutate — the check is done at duel-start
        // time against `roundBonuses` + region ownership.  Capture just
        // emits the toast so the player sees they unlocked the bonus.
        toast = buildBonusToast("mevzi_bekcisi", capturedRegionId, ownerId, ownerName, now);
        break;
      case "kocbasi":
        // Region/owner-tied effect (shield bypass + +1 on enemy capture).
        // No per-player state to mutate — both effects gate on current
        // ownership of this region (see `attackerHasKocbasiAdvantage`).
        // Capture just announces the unlock.
        toast = buildBonusToast("kocbasi", capturedRegionId, ownerId, ownerName, now);
        break;
      case "mancinik":
        // Overwrite-not-stack: cap at 1 pending uzak-saldırı charge.
        // Consumed exactly once when the owner commits an attack/capture
        // whose target wasn't otherwise adjacency-legal (see
        // `applyActionToGame` and `resolveDuelWithWinner`).
        pb.mancinikCharges = 1;
        toast = buildBonusToast("mancinik", capturedRegionId, ownerId, ownerName, now);
        break;
      case "istihbarat_agi":
        // Pure region/owner-tied effect: while the current owner controls
        // this region, opponents' hidden bonus claims and Gizli Operasyon
        // placements are surfaced to them as intel reports.  No per-player
        // state to mutate — the visibility check happens at render time
        // via findRegionIdForBonusType + region ownership.  Capture just
        // announces the unlock with the standard viewer-aware toast.
        toast = buildBonusToast("istihbarat_agi", capturedRegionId, ownerId, ownerName, now);
        break;
    }
  }

  return {
    regionStates:  nextRegionStates,
    playerBonuses: { ...current, [ownerId]: pb },
    toast,
  };
}

/**
 * Mevzi Bekçisi 🏰 — economic-defense payout applied when the bonus region
 * just changed hands.  The previous owner preserves the region's full point
 * value as `bonusPoints` (added to total score via getPlayerTotalPoints),
 * even though region ownership flips to the new owner.
 *
 * Anti-farm:
 *   - `mevziProtectionClaimedBy` on the region tracks which players have
 *     ALREADY received this payout from this region during the match.
 *   - A player only ever collects the protection ONCE per region — repeat
 *     losses from the same region grant nothing, even if a different owner
 *     held it in between.
 *   - A NEW owner who later loses the same region remains eligible (their
 *     id is appended only on their own first payout).
 *
 * Pure: returns new arrays / maps; never mutates inputs.  Returns the input
 * snapshots verbatim (plus `toast: undefined`) when the region does not
 * carry the mevzi bonus or the previous owner is already in the claim log.
 */
function applyMevziProtectionOnLoss(
  regionStates:      ConquestRegionState[],
  playerBonusesIn:   Record<string, ConquestPlayerBonusState> | undefined,
  roundBonuses:      ConquestRoundBonusAssignment | undefined,
  previousOwnerId:   string,
  previousOwnerName: string,
  regionId:          ConquestRegionId,
  now:               number,
): {
  regionStates:  ConquestRegionState[];
  playerBonuses: Record<string, ConquestPlayerBonusState>;
  toast?:        ConquestBonusToast;
} {
  const current = playerBonusesIn ?? {};
  const bonus = resolveActiveBonus(roundBonuses, regionId);
  if (!bonus || bonus.type !== "mevzi_bekcisi") {
    return { regionStates, playerBonuses: current };
  }

  const target = regionStates.find(rs => rs.regionId === regionId);
  if (!target) return { regionStates, playerBonuses: current };

  const alreadyClaimed = target.mevziProtectionClaimedBy ?? [];
  if (alreadyClaimed.includes(previousOwnerId)) {
    // Anti-farm: this player has already redeemed mevzi on this region in
    // this match.  No payout, no toast.
    return { regionStates, playerBonuses: current };
  }

  const points = getRegionPoints(regionId);
  if (points <= 0) {
    return { regionStates, playerBonuses: current };
  }

  const nextRegionStates = regionStates.map(rs =>
    rs.regionId === regionId
      ? {
          ...rs,
          mevziProtectionClaimedBy: [...alreadyClaimed, previousOwnerId],
        }
      : rs,
  );

  const prevPb = current[previousOwnerId] ?? createEmptyPlayerBonusState();
  const nextPlayerBonuses: Record<string, ConquestPlayerBonusState> = {
    ...current,
    [previousOwnerId]: {
      ...prevPb,
      bonusPoints: prevPb.bonusPoints + points,
    },
  };

  const toast = buildMevziLossToast(
    regionId, previousOwnerId, previousOwnerName, points, now,
  );

  return {
    regionStates:  nextRegionStates,
    playerBonuses: nextPlayerBonuses,
    toast,
  };
}

/**
 * Mancınık 🎯 — return a new playerBonuses map with `playerId`'s charge
 * decremented by 1 (clamped at 0).  Returns the input map verbatim when the
 * player has no charge.  Pure: never mutates inputs.
 */
function consumeMancinikCharge(
  playerBonusesIn: Record<string, ConquestPlayerBonusState> | undefined,
  playerId:        string,
): Record<string, ConquestPlayerBonusState> | undefined {
  if (!playerBonusesIn) return playerBonusesIn;
  const pb = playerBonusesIn[playerId];
  const current = pb?.mancinikCharges ?? 0;
  if (current <= 0) return playerBonusesIn;
  return {
    ...playerBonusesIn,
    [playerId]: { ...(pb ?? createEmptyPlayerBonusState()), mancinikCharges: 0 },
  };
}

/**
 * Muhafız Desteği 🛡️ — return a new playerBonuses map with `playerId`'s
 * `guardianShieldBypassCharges` zeroed.  Returns the input map verbatim when
 * the player has no charge.  Pure: never mutates inputs.  Mirrors the
 * Mancınık consume helper.
 */
function consumeGuardianShieldBypassCharge(
  playerBonusesIn: Record<string, ConquestPlayerBonusState> | undefined,
  playerId:        string,
): Record<string, ConquestPlayerBonusState> | undefined {
  if (!playerBonusesIn) return playerBonusesIn;
  const pb = playerBonusesIn[playerId];
  const current = pb?.guardianShieldBypassCharges ?? 0;
  if (current <= 0) return playerBonusesIn;
  return {
    ...playerBonusesIn,
    [playerId]: {
      ...(pb ?? createEmptyPlayerBonusState()),
      guardianShieldBypassCharges: 0,
    },
  };
}

/**
 * Koçbaşı 🪵 — true when `attackerId` currently owns the region carrying the
 * kocbasi bonus in this match's assignment.  The bonus is region-tied: as
 * soon as the attacker loses that region, this returns false.
 */
function attackerHasKocbasiAdvantage(
  regionStates:  ConquestRegionState[],
  roundBonuses:  ConquestRoundBonusAssignment | undefined,
  attackerId:    string,
): boolean {
  const rid = findRegionIdForBonusType(roundBonuses, "kocbasi");
  if (!rid) return false;
  const rs = regionStates.find(r => r.regionId === rid);
  return !!rs && rs.ownerPlayerId === attackerId;
}

/**
 * Koçbaşı 🪵 — economic-offense payout: when the kocbasi-holder fethes an
 * enemy region (not a neutral capture), they earn +1 bonus point.  Toast
 * differentiates whether the capture also bypassed an open shield.
 *
 * Pure: returns new playerBonuses; never mutates inputs.  Returns the input
 * snapshot verbatim (plus `toast: undefined`) when the attacker does not hold
 * the kocbasi advantage, the capture was a neutral region, or the captured
 * region was itself the kocbasi region (defensive — can't happen since the
 * attacker would already own it).
 */
function applyKocbasiOnEnemyCapture(
  regionStates:      ConquestRegionState[],
  playerBonusesIn:   Record<string, ConquestPlayerBonusState> | undefined,
  roundBonuses:      ConquestRoundBonusAssignment | undefined,
  attackerId:        string,
  attackerName:      string,
  capturedRegionId:  ConquestRegionId,
  wasNeutralCapture: boolean,
  shieldBypassed:    boolean,
  now:               number,
): {
  playerBonuses: Record<string, ConquestPlayerBonusState>;
  toast?:        ConquestBonusToast;
} {
  const current = playerBonusesIn ?? {};
  if (wasNeutralCapture) return { playerBonuses: current };
  if (!attackerHasKocbasiAdvantage(regionStates, roundBonuses, attackerId)) {
    return { playerBonuses: current };
  }
  const pb = current[attackerId] ?? createEmptyPlayerBonusState();
  const nextPlayerBonuses: Record<string, ConquestPlayerBonusState> = {
    ...current,
    [attackerId]: { ...pb, bonusPoints: pb.bonusPoints + 1 },
  };
  const toast = buildKocbasiCaptureToast(
    capturedRegionId, attackerId, attackerName, shieldBypassed, now,
  );
  return { playerBonuses: nextPlayerBonuses, toast };
}

/**
 * Gizli Fetih no longer expires from time / opposing actions per spec — it
 * only reveals when its specific region is attacked.  The previous sweep
 * helper is removed; `tryConsumeHiddenShield` remains the sole reveal path.
 */

/**
 * If `targetRegionId` carries a hidden shield owned by someone other than
 * `attackerId`, returns the cleared region-state array (with the
 * hidden-shield fields stripped) plus the shield owner and kind.
 *
 * Kind drives the reveal message:
 *   "shield"       — own-region cloak (gizli kalkan); region keeps owner
 *   "conquest"     — neutral region secretly captured for the placer (gizli
 *                    fetih); first opposing attack reveals the real owner
 *                    and is wasted.  Old saves without a stored kind are
 *                    treated as "conquest".
 *   "neutral_trap" — LEGACY: pre-spec-rev3 trap that kept the region neutral.
 *                    No new code emits this; kept so older in-flight saves
 *                    still reveal cleanly.
 *
 * Pure: shield is consumed by returning a new array; inputs unchanged.
 */
function tryConsumeHiddenShield(
  regionStates:    ConquestRegionState[],
  attackerId:      string,
  targetRegionId:  ConquestRegionId,
): {
  regionStates:    ConquestRegionState[];
  shieldOwnerId:   string;
  kind:            "conquest" | "shield" | "neutral_trap";
} | null {
  const target = regionStates.find(r => r.regionId === targetRegionId);
  const ownerId = target?.hiddenShieldOwnerId;
  if (!ownerId || ownerId === attackerId) return null;
  const kind = target?.hiddenShieldKind ?? "conquest";
  const cleared = regionStates.map(rs =>
    rs.regionId === targetRegionId
      ? { ...rs, hiddenShieldOwnerId: undefined, hiddenShieldKind: undefined }
      : rs,
  );
  return { regionStates: cleared, shieldOwnerId: ownerId, kind };
}

/**
 * Apply a pending action against the current state and return the new state
 * plus the structured result.
 *
 * Legal flow: action is applied, regionStates updated, phase moves to
 * `round_result`, history grows by one entry.
 *
 * Illegal flow: action is rejected, phase stays at `action`, the result is
 * returned (callers should surface `result.message` to the user but NOT
 * commit the returned state — actually we *do* return the unchanged state,
 * so callers can simply swap unconditionally.  We set `round.lastResult` to
 * the failure so the UI can flash a "Bu bölgeye hamle yapılamaz." notice).
 */
export function applyActionToGame(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
  action:    ConquestPendingAction,
): ApplyActionResult {
  if (state.phase !== "action") {
    return {
      state,
      result: {
        ok:       false,
        action:   action.type,
        playerId: action.playerId,
        regionId: action.type === "skip" ? null : action.regionId,
        message:  "Şu an hamle yapılamaz.",
      },
    };
  }
  if (action.playerId !== state.round.actionHolderId) {
    return {
      state,
      result: {
        ok:       false,
        action:   action.type,
        playerId: action.playerId,
        regionId: action.type === "skip" ? null : action.regionId,
        message:  "Bu oyuncunun şu an hamle hakkı yok.",
      },
    };
  }
  // Eliminated players cannot commit moves.  Defensive guard — the action
  // holder is set from the challenge winner, who is filtered to active
  // players, but a stale snapshot could still arrive on the wire.
  if (isPlayerEliminated(state, action.playerId)) {
    return {
      state,
      result: {
        ok:       false,
        action:   action.type,
        playerId: action.playerId,
        regionId: action.type === "skip" ? null : action.regionId,
        message:  "Elenmiş oyuncu hamle yapamaz.",
      },
    };
  }

  // ── Mancınık 🎯 — long-range attack bypass decision ───────────────────
  // The bypass is "used" iff the holder has a charge AND the target was NOT
  // adjacency-legal without it.  Pre-computed here so the same answer drives
  // duel routing, action validation, and post-success consumption.  A
  // regular adjacent move while the charge is active does NOT consume it.
  const actingPb     = state.playerBonuses?.[action.playerId];
  const hasMancinik  = (actingPb?.mancinikCharges ?? 0) > 0;
  const mancinikBypassUsed =
    hasMancinik
    && (action.type === "attack_region" || action.type === "capture_neutral")
    && !isLegalTarget(mapConfig, state.regionStates, action.playerId, action.regionId);

  // ── Pusu 🕳️ interception ──────────────────────────────────────────────
  // Fires BEFORE the hidden-shield/duel/applyConquestAction chain so an
  // ambushed attack/capture never even reaches resolution.  The ambush is
  // consumed and the round jumps to round_result with a viewer-aware
  // "Pusu Ortaya Çıktı" toast; the saldırı/fetih is treated as if it
  // never happened.  Owner-self attempts (which the legality predicates
  // already reject) are guarded a second time inside
  // `tryConsumePendingAmbush`.
  //
  // Mancınık 🎯 charge consumption: V1 decision — a Mancınık-tagged attack
  // that gets ambushed is still treated as "saldırı teşebbüsü yapıldı",
  // so the charge is spent (mirrors the Ankara hidden-shield branch right
  // below).  This keeps a single rule for "if the shot leaves the silo, the
  // silo is empty"; the alternative (refund on ambush) would also leak
  // info to the attacker that something they hit was ambushed-not-shielded.
  //
  // Muhafız Desteği 🛡️ charge consumption: parallel rule — when the attack
  // was launched against a SHIELDED opponent region (target.shielded === true)
  // and the attacker holds a guardianShieldBypassCharges charge that would
  // have spent on the shield branch below, the ambush still counts as an
  // attempt against the shield.  Charge is consumed so the chip drops on
  // every client and the attacker cannot deduce "ambushed-not-shielded"
  // from a preserved charge.  Koçbaşı priority preserved (free bypass →
  // guardian charge untouched).  Skipped entirely when the target is not
  // an open-shielded opponent region (neutrals, own regions, unshielded
  // enemies, hidden-shield-only regions).
  if (action.type === "attack_region" || action.type === "capture_neutral") {
    const attackerName =
      state.players.find(p => p.id === action.playerId)?.name ?? "Oyuncu";
    const ambushTrigger = tryConsumePendingAmbush(
      state.activeHiddenEffects,
      action.regionId,
      action.playerId,
      attackerName,
      getConquestSyncedNowMs(),
    );
    if (ambushTrigger) {
      const ambushTarget = state.regionStates.find(r => r.regionId === action.regionId);
      const ambushTargetShielded =
        ambushTarget?.shielded === true
        && ambushTarget.ownerPlayerId !== null
        && ambushTarget.ownerPlayerId !== action.playerId;
      const ambushKocbasiBypass = ambushTargetShielded && attackerHasKocbasiAdvantage(
        state.regionStates, state.roundBonuses, action.playerId,
      );
      const ambushHasGuardian = (actingPb?.guardianShieldBypassCharges ?? 0) > 0;
      const guardianAmbushed =
        ambushTargetShielded && !ambushKocbasiBypass && ambushHasGuardian;

      const blockResult: ConquestActionResult = {
        ok:                 true,
        action:             action.type,
        playerId:           action.playerId,
        regionId:           action.regionId,
        message:            "🕳️ Gizli pusu nedeniyle saldırı gerçekleşemedi.",
        mancinikBypassUsed: mancinikBypassUsed || undefined,
      };
      let playerBonusesAfterAmbush = state.playerBonuses;
      if (mancinikBypassUsed) {
        playerBonusesAfterAmbush = consumeMancinikCharge(playerBonusesAfterAmbush, action.playerId);
      }
      if (guardianAmbushed) {
        playerBonusesAfterAmbush = consumeGuardianShieldBypassCharge(
          playerBonusesAfterAmbush, action.playerId,
        );
      }
      return {
        state: {
          ...state,
          phase:                "round_result",
          playerBonuses:        playerBonusesAfterAmbush,
          activeHiddenEffects:  ambushTrigger.activeHiddenEffects,
          lastHiddenBonusToast: ambushTrigger.lastHiddenBonusToast,
          round: {
            ...state.round,
            lastResult: blockResult,
          },
          history: [...state.history, {
            roundNumber:       state.round.roundNumber,
            challengeWinnerId: state.round.challenge.winnerPlayerId,
            result:            blockResult,
          }],
        },
        result: blockResult,
      };
    }
  }

  // ── Ankara hidden-shield interception ──────────────────────────────────
  // Triggered BEFORE applyConquestAction so a shielded attack/capture never
  // flips ownership.  Shield is consumed on trigger and the round resolves
  // with a public "shield broken" message (hidden until this moment).
  if (action.type === "attack_region" || action.type === "capture_neutral") {
    const shieldTrigger = tryConsumeHiddenShield(
      state.regionStates, action.playerId, action.regionId,
    );
    if (shieldTrigger) {
      const blockMessage =
        shieldTrigger.kind === "shield"       ? HIDDEN_SHIELD_REVEAL_MESSAGE :
        shieldTrigger.kind === "neutral_trap" ? HIDDEN_NEUTRAL_TRAP_REVEAL_MESSAGE :
        /* conquest (legacy) */                 HIDDEN_CONQUEST_REVEAL_MESSAGE;
      const blockResult: ConquestActionResult = {
        ok:                 true,
        action:             action.type,
        playerId:           action.playerId,
        regionId:           action.regionId,
        message:            blockMessage,
        mancinikBypassUsed: mancinikBypassUsed || undefined,
      };
      // Mancınık is still consumed even when the shot lands on a hidden
      // shield — the attack was launched.
      const playerBonusesAfterShield = mancinikBypassUsed
        ? consumeMancinikCharge(state.playerBonuses, action.playerId)
        : state.playerBonuses;
      return {
        state: {
          ...state,
          phase:         "round_result",
          regionStates:  shieldTrigger.regionStates,
          playerBonuses: playerBonusesAfterShield,
          round: {
            ...state.round,
            lastResult: blockResult,
          },
          history: [...state.history, {
            roundNumber:       state.round.roundNumber,
            challengeWinnerId: state.round.challenge.winnerPlayerId,
            result:            blockResult,
          }],
        },
        result: blockResult,
      };
    }
  }

  // ── Savunma Düellosu interception ─────────────────────────────────────
  // Any attack on an opponent-owned region triggers a defense duel —
  // bonus status no longer matters.  "Boş yer kolay alınır, rakip
  // toprağı savaş ister."
  //
  // capture_neutral is still exempt ("tarafsız bölge: direkt fetih").
  // Hidden-shield intercepts above already consumed any secret trap so
  // a duel can never start on a hidden-conquest region.
  //
  // The `shieldActive` flag is snapshotted at duel start so resolution
  // can break the shield (attacker wins) vs flip ownership (no shield):
  //   - Attacker wins + shield active → shield breaks, region stays.
  //   - Attacker wins + no shield     → ownership flips to attacker.
  //   - Defender wins / timer expired → region stays, shield untouched.
  if (action.type === "attack_region") {
    const target = state.regionStates.find(r => r.regionId === action.regionId);
    if (
      target
      && target.ownerPlayerId
      && target.ownerPlayerId !== action.playerId
    ) {
      // Koçbaşı 🪵 — bypass an active shield in a single step.  When the
      // attacker owns the kocbasi region and the target is shielded, the
      // duel is tagged `shieldActive: false` so attacker-win flips ownership
      // (instead of just breaking the shield); `kocbasiBypass` records the
      // bypass for UI chips and the post-flip toast.
      const targetShielded = target.shielded === true;
      const kocbasiBypass = targetShielded && attackerHasKocbasiAdvantage(
        state.regionStates, state.roundBonuses, action.playerId,
      );
      // Muhafız Desteği 🛡️ — fate-card-based open-shield bypass.  Resolved
      // ONLY when the target carries an open shield AND Koçbaşı is not
      // already supplying the bypass for free (Koçbaşı priority preserves
      // the once-per-match charge).  Like Koçbaşı, the duel is tagged
      // `shieldActive: false` so attacker-win flips ownership directly.
      // Charge is consumed at duel start — both correct and wrong duel
      // outcomes spend it (Mancınık's "shot leaves the silo" rule).
      const hasGuardianBypass = (actingPb?.guardianShieldBypassCharges ?? 0) > 0;
      const guardianBypassUsed =
        targetShielded && !kocbasiBypass && hasGuardianBypass;
      // Mancınık 🎯 — consume the charge at duel start so opponents see
      // the chip drop the instant the shot leaves the silo.  Routed through
      // the duel state's `mancinikBypass` flag so the eventual attacker-win
      // flip can forward the adjacency bypass into `applyConquestAction`.
      let bonusesForDuel = state.playerBonuses;
      if (mancinikBypassUsed) {
        bonusesForDuel = consumeMancinikCharge(bonusesForDuel, action.playerId);
      }
      if (guardianBypassUsed) {
        bonusesForDuel = consumeGuardianShieldBypassCharge(bonusesForDuel, action.playerId);
      }
      const stateForDuel = (mancinikBypassUsed || guardianBypassUsed)
        ? { ...state, playerBonuses: bonusesForDuel }
        : state;
      const duelState = startDefenseDuel(
        stateForDuel,
        action.playerId,
        target.ownerPlayerId,
        action.regionId,
        targetShielded && !kocbasiBypass && !guardianBypassUsed,
        kocbasiBypass,
        mancinikBypassUsed,
        false,
        guardianBypassUsed,
      );
      const startResult: ConquestActionResult = {
        ok:       true,
        action:   "attack_region",
        playerId: action.playerId,
        regionId: action.regionId,
        message:  "Savunma Düellosu başladı!",
      };
      return {
        state: duelState,
        result: startResult,
      };
    }
  }

  // ── Sınır Karakolu intercept ──────────────────────────────────────────
  // Neutral capture attempt against a region carrying a defender's border
  // outpost: instead of a direct flip, open a defense duel between the
  // attacker and the outpost owner.  Region's `ownerPlayerId` is null and
  // stays null until duel resolution — both outcomes clear the outpost
  // field; attacker-win additionally flips ownership to the attacker via
  // a deferred capture_neutral.
  //
  // Edge: if the outpost owner is already eliminated, the duel is skipped
  // entirely — the attacker captures the region normally (capture_neutral
  // flow below) and `flipOwnership` clears the stale outpost field.  The
  // attacker still owns the action, so eliminated defenders can never
  // contest from beyond the grave.
  if (action.type === "capture_neutral") {
    const target = state.regionStates.find(r => r.regionId === action.regionId);
    const outpostOwner = target?.borderOutpostOwnerId;
    if (
      target
      && outpostOwner
      && outpostOwner !== action.playerId
      && !isPlayerEliminated(state, outpostOwner)
    ) {
      // Mancınık behaves the same here — charge consumed at duel start
      // (the shot WAS launched); the duel attacker-win branch forwards
      // it back into `applyConquestAction` adjacency check.
      const stateForDuel = mancinikBypassUsed
        ? { ...state, playerBonuses: consumeMancinikCharge(state.playerBonuses, action.playerId) }
        : state;
      const duelState = startDefenseDuel(
        stateForDuel,
        action.playerId,
        outpostOwner,
        action.regionId,
        false,   // shieldActive — neutral regions never carry the open shield
        false,   // kocbasiBypass — no shield to bypass
        mancinikBypassUsed,
        true,    // outpostBreak
      );
      const startResult: ConquestActionResult = {
        ok:       true,
        action:   "capture_neutral",
        playerId: action.playerId,
        regionId: action.regionId,
        message:  "🏯 Sınır Karakolu savunması! Düello başladı.",
      };
      return {
        state: duelState,
        result: startResult,
      };
    }
  }

  const appliedRaw = applyConquestAction(
    mapConfig,
    state.regionStates,
    state.players,
    state.round.roundNumber,
    action,
    mancinikBypassUsed,
  );
  // Forward the bypass-used flag onto the action result so the UI's big
  // card (and small-toast suppression) can react to the consumption.
  const applied = mancinikBypassUsed && appliedRaw.result.ok
    ? {
        ...appliedRaw,
        result: { ...appliedRaw.result, mancinikBypassUsed: true },
      }
    : appliedRaw;

  if (!applied.result.ok) {
    return {
      state: {
        ...state,
        round: {
          ...state.round,
          lastResult: applied.result,
        },
      },
      result: applied.result,
    };
  }

  // Trigger capture-side region bonuses (Ankara/Çukurova/Karadeniz/İstanbul).
  // Runs ONLY for capture-style actions whose ownership flip succeeded; skip
  // and defend leave bonuses untouched.
  let postRegionStates  = applied.regionStates;
  // Mancınık 🎯 — consume the bypass charge before triggerCaptureBonus runs
  // so the post-action snapshot reflects the spent shot.  Triggered captures
  // (e.g. landing on the mancinik region itself) will then re-grant a fresh
  // charge if applicable.
  let postPlayerBonuses = mancinikBypassUsed
    ? consumeMancinikCharge(state.playerBonuses, action.playerId)
    : state.playerBonuses;
  let postToast: ConquestBonusToast | undefined;
  let postHiddenPlacements = state.hiddenBonusPlacements;
  let postPlayerHidden     = state.playerHiddenBonuses;
  let postHiddenToast      = state.lastHiddenBonusToast;
  let postIntelReport      = state.lastIntelReport;
  if (action.type === "capture_neutral" || action.type === "attack_region") {
    const actorName = state.players.find(p => p.id === action.playerId)?.name ?? "Oyuncu";
    const now = getConquestSyncedNowMs();
    const bonusOut = triggerCaptureBonus(
      postRegionStates,
      postPlayerBonuses,
      state.roundBonuses,
      action.playerId,
      actorName,
      action.regionId,
      now,
      action.type === "capture_neutral",
    );
    postRegionStates  = bonusOut.regionStates;
    postPlayerBonuses = bonusOut.playerBonuses;
    postToast         = bonusOut.toast;

    // Koçbaşı 🪵 — +1 bonus point on enemy region capture (no-op for neutral
    // captures).  All enemy attacks route through duels today, so this branch
    // only realistically fires for capture_neutral — but call it defensively
    // so any future direct enemy-capture path picks the payout up too.
    const kocbasiOut = applyKocbasiOnEnemyCapture(
      postRegionStates,
      postPlayerBonuses,
      state.roundBonuses,
      action.playerId,
      actorName,
      action.regionId,
      action.type === "capture_neutral",
      false,
      now,
    );
    postPlayerBonuses = kocbasiOut.playerBonuses;
    if (kocbasiOut.toast) postToast = kocbasiOut.toast;

    // Hidden bonus claim — runs AFTER the open-bonus chain because hidden
    // bonuses live on a separate state channel.  No-op when this region
    // never carried a hidden bonus or it was already claimed.
    const hb = tryClaimHiddenBonus(
      postHiddenPlacements,
      postPlayerHidden,
      action.regionId,
      action.playerId,
      actorName,
      state.round.roundNumber,
      now,
    );
    if (hb) {
      postHiddenPlacements = hb.hiddenBonusPlacements;
      postPlayerHidden     = hb.playerHiddenBonuses;
      postHiddenToast      = hb.lastHiddenBonusToast;
      // 👁️ İstihbarat Ağı — sync the real bonus type to every client; the
      // renderer suppresses for non-intel-owners.  Always emitted alongside
      // the standard hidden bonus claim toast; gameplay effect of the
      // hidden bonus itself is unaffected.
      postIntelReport = buildHiddenClaimIntelReport(
        action.playerId,
        actorName,
        hb.lastHiddenBonusToast.type,
        now,
      );
    }
  }

  const historyEntry = {
    roundNumber:        state.round.roundNumber,
    challengeWinnerId:  state.round.challenge.winnerPlayerId,
    result:             applied.result,
  };

  // Elimination diff — any player who lost their last region this hamle is
  // marked eliminated.  Computed before the finish checks so the result
  // screen can rank eliminated players honestly and downstream phases (next
  // challenge / action holder) can skip them.
  const elimDiff = action.type !== "skip"
    ? computeEliminationDiff(state, postRegionStates, getConquestSyncedNowMs())
    : {
        eliminatedPlayerIds:  state.eliminatedPlayerIds ?? [],
        eliminations:         state.eliminations ?? {},
        newlyEliminatedIds:   [],
        lastEliminationEvent: state.lastEliminationEvent,
      };

  // Early finish: one player now owns every region on the map.
  // Only possible after a capture/attack (skip never changes ownership).
  const dominatorId = action.type !== "skip"
    ? getPlayerOwningAllRegions(postRegionStates, mapConfig)
    : null;

  // Last-player-standing finish: after eliminating someone, only one player
  // still has territory.  Covers the 3+ player case where a neutral region
  // remains (so dominatorId is null) AND the 1v1 case where the loser drops
  // to 0 while neutrals remain.
  const survivorId = action.type !== "skip"
    ? getSoleSurvivorId(state.players, elimDiff.eliminatedPlayerIds)
    : null;

  if (dominatorId !== null || survivorId !== null) {
    const winnerId  = dominatorId ?? survivorId!;
    const winner    = state.players.find(p => p.id === winnerId);
    const finishMsg = dominatorId !== null
      ? `${winner?.name ?? "Bir oyuncu"} tüm bölgeleri ele geçirdi!`
      : `${winner?.name ?? "Bir oyuncu"} son ayakta kalan oldu!`;
    const domResult: ConquestActionResult = {
      ok:       true,
      action:   applied.result.action,
      playerId: applied.result.playerId,
      regionId: applied.result.regionId,
      message:  finishMsg,
    };
    return {
      state: {
        ...state,
        phase:                 "finished",
        finishedAt:            getConquestSyncedNowMs(),
        regionStates:          postRegionStates,
        playerBonuses:         postPlayerBonuses,
        lastBonusToast:        postToast ?? state.lastBonusToast,
        hiddenBonusPlacements: postHiddenPlacements,
        playerHiddenBonuses:   postPlayerHidden,
        lastHiddenBonusToast:  postHiddenToast,
        lastIntelReport:       postIntelReport,
        eliminatedPlayerIds:   elimDiff.eliminatedPlayerIds,
        eliminations:          elimDiff.eliminations,
        lastEliminationEvent:  elimDiff.lastEliminationEvent,
        winnerPlayerId:        winnerId,
        winnerName:            winner?.name,
        finishReason:          dominatorId !== null ? undefined : "last_player_standing",
        round: {
          ...state.round,
          lastResult: domResult,
        },
        history: [...state.history, { ...historyEntry, result: domResult }],
      },
      result: domResult,
    };
  }

  return {
    state: {
      ...state,
      phase:                 "round_result",
      regionStates:          postRegionStates,
      playerBonuses:         postPlayerBonuses,
      lastBonusToast:        postToast ?? state.lastBonusToast,
      hiddenBonusPlacements: postHiddenPlacements,
      playerHiddenBonuses:   postPlayerHidden,
      lastHiddenBonusToast:  postHiddenToast,
      lastIntelReport:       postIntelReport,
      eliminatedPlayerIds:   elimDiff.eliminatedPlayerIds,
      eliminations:          elimDiff.eliminations,
      lastEliminationEvent:  elimDiff.lastEliminationEvent,
      round: {
        ...state.round,
        lastResult: applied.result,
      },
      history: [...state.history, historyEntry],
    },
    result: applied.result,
  };
}

/**
 * Place the holder's pending Ankara hidden shield onto one of their own
 * regions.  Counts as the round's hamle: transitions phase → round_result,
 * clears the pending flag, and writes a history entry.  Per spec, no opponent
 * is notified (the shield's existence stays secret until it triggers).
 *
 * Validates: phase is "action", player is the action holder, region is owned
 * by the player, and the player has `pendingHiddenShield = true`.  On failure,
 * returns the state unchanged with `result.ok = false` so the UI can surface
 * a message via lastResult.
 *
 * Per-player cap of 1 is enforced by clearing any prior hidden shield owned
 * by this player before stamping the new one (mirrors the auto-stamp path).
 */
export function placeHiddenShieldOnOwnRegion(
  state:      ConquestGameState,
  _mapConfig: ConquestMapConfig,
  playerId:   string,
  regionId:   ConquestRegionId,
): ApplyActionResult {
  if (state.phase !== "action") {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Şu an hamle yapılamaz.",
      },
    };
  }
  if (state.round.actionHolderId !== playerId) {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Bu oyuncunun şu an hamle hakkı yok.",
      },
    };
  }

  const target = state.regionStates.find(r => r.regionId === regionId);
  if (!target || target.ownerPlayerId !== playerId) {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Yalnızca kendi bölgene gizli koruma yerleştirebilirsin.",
      },
    };
  }

  const pb = state.playerBonuses?.[playerId] ?? createEmptyPlayerBonusState();
  if (!pb.pendingHiddenShield) {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Gizli koruma hakkın yok.",
      },
    };
  }

  // Stamp shield on chosen region; clear any prior hidden shield for this
  // player so the per-player cap of 1 is preserved.
  const nextRegionStates = state.regionStates.map(rs => {
    if (rs.regionId === regionId) {
      return {
        ...rs,
        hiddenShieldOwnerId: playerId,
        hiddenShieldKind:    "shield" as const,
      };
    }
    if (rs.hiddenShieldOwnerId === playerId) {
      return { ...rs, hiddenShieldOwnerId: undefined, hiddenShieldKind: undefined };
    }
    return rs;
  });

  const nextPlayerBonuses: Record<string, ConquestPlayerBonusState> = {
    ...(state.playerBonuses ?? {}),
    [playerId]: { ...pb, pendingHiddenShield: false },
  };

  const playerName  = state.players.find(p => p.id === playerId)?.name ?? "Oyuncu";
  const result: ConquestActionResult = {
    ok:       true,
    action:   "defend_region",
    playerId,
    regionId,
    /* Public message MUST NOT leak the chosen region or distinguish shield
     * vs. fetih — paranoia is the feature.  UI detects the sentinel prefix
     * (HIDDEN_OP_PLACED_MESSAGE_PREFIX) and surfaces a center banner. */
    message:  buildHiddenOpPlacedMessage(playerName),
  };

  // 👁️ İstihbarat Ağı — Gizli Operasyon (own-region shield flavour) intel
  // report.  Carries the target region so the intel owner learns WHERE the
  // secret cloak landed; renderer suppresses for non-intel-owners.
  const intelReport = buildGizliOpIntelReport(
    playerId, playerName, regionId, getConquestSyncedNowMs(),
  );

  return {
    state: {
      ...state,
      phase:           "round_result",
      regionStates:    nextRegionStates,
      playerBonuses:   nextPlayerBonuses,
      lastIntelReport: intelReport,
      round: {
        ...state.round,
        lastResult: result,
      },
      history: [
        ...state.history,
        {
          roundNumber:       state.round.roundNumber,
          challengeWinnerId: state.round.challenge.winnerPlayerId,
          result,
        },
      ],
    },
    result,
  };
}

/**
 * Place the holder's pending Gizli Operasyon onto a NEUTRAL region as a
 * "gizli fetih".  The target must satisfy the canonical adjacency rule
 * (border at least one region the holder owns) — gizli fetih flips
 * ownership for real, so it cannot bypass the legal-target check.
 * Counts as the round's hamle.
 *
 * Per the revised spec this is no longer a trap that leaves the region
 * neutral.  Instead the region is genuinely captured for the player:
 *   - real `ownerPlayerId` becomes the placer
 *   - `hiddenShieldKind = "conquest"` cloaks the capture in opponent
 *     projections (they continue to see the region as neutral)
 *   - first opposing attack reveals the real owner and consumes the shield;
 *     the attack is wasted and the region stays with the original conqueror
 *
 * Validates: phase is "action", player is the action holder, region is
 * truly neutral (ownerPlayerId === null), and the player has
 * `pendingHiddenShield = true`.  Per-player cap of 1 is enforced by
 * clearing any prior hidden shield owned by this player (mirrors the
 * own-region placement path).
 */
export function placeHiddenConquestOnNeutralRegion(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
  playerId:  string,
  regionId:  ConquestRegionId,
): ApplyActionResult {
  if (state.phase !== "action") {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Şu an hamle yapılamaz.",
      },
    };
  }
  if (state.round.actionHolderId !== playerId) {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Bu oyuncunun şu an hamle hakkı yok.",
      },
    };
  }

  const target = state.regionStates.find(r => r.regionId === regionId);
  if (!target || target.ownerPlayerId !== null) {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Yalnızca tarafsız bir bölgeye gizli tuzak kurabilirsin.",
      },
    };
  }

  // Gizli fetih is a real capture (ownership flips), so the canonical
  // adjacency rule applies: target must border at least one region the
  // player already owns.  Without this, the hidden-op path becomes a
  // backdoor that lets the holder grab any neutral on the map.
  if (!isLegalTarget(mapConfig, state.regionStates, playerId, regionId)) {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Bu bölgeye hamle yapılamaz.",
      },
    };
  }

  const pb = state.playerBonuses?.[playerId] ?? createEmptyPlayerBonusState();
  if (!pb.pendingHiddenShield) {
    return {
      state,
      result: {
        ok:       false,
        action:   "defend_region",
        playerId,
        regionId,
        message:  "Gizli koruma hakkın yok.",
      },
    };
  }

  // ── Pusu 🕳️ intercept on gizli fetih ────────────────────────────────────
  // Spec: pusu blocks "direct flip" too.  Gizli fetih is a direct flip on a
  // neutral region, so if an opponent's pusu sits on this region, the flip
  // must not happen.  The hidden-shield pending flag stays intact (the
  // shield wasn't placed) so the holder can use it on a later turn.
  const ambushTriggerHidden = tryConsumePendingAmbush(
    state.activeHiddenEffects,
    regionId,
    playerId,
    state.players.find(p => p.id === playerId)?.name ?? "Oyuncu",
    getConquestSyncedNowMs(),
  );
  if (ambushTriggerHidden) {
    const blockResult: ConquestActionResult = {
      ok:       true,
      action:   "defend_region",
      playerId,
      regionId,
      message:  "🕳️ Gizli pusu nedeniyle saldırı gerçekleşemedi.",
    };
    return {
      state: {
        ...state,
        phase:                "round_result",
        activeHiddenEffects:  ambushTriggerHidden.activeHiddenEffects,
        lastHiddenBonusToast: ambushTriggerHidden.lastHiddenBonusToast,
        round: {
          ...state.round,
          lastResult: blockResult,
        },
        history: [...state.history, {
          roundNumber:       state.round.roundNumber,
          challengeWinnerId: state.round.challenge.winnerPlayerId,
          result:            blockResult,
        }],
      },
      result: blockResult,
    };
  }

  // Flip ownership for real AND cloak the capture with kind="conquest".
  // Clear any prior hidden shield owned by this player so the per-player cap
  // of 1 is preserved (mirrors the own-region placement path).
  const nextRegionStates = state.regionStates.map(rs => {
    if (rs.regionId === regionId) {
      return {
        ...rs,
        ownerPlayerId:       playerId,
        lastCapturedBy:      playerId,
        turnCaptured:        state.round.roundNumber,
        captureCount:        (rs.captureCount ?? 0) + 1,
        /* Capture clears any open shield — matches flipOwnership semantics. */
        shielded:            false,
        /* Liman ⚓ counter reset on ownership change — same as flipOwnership. */
        limanIncomeTicks:    0,
        /* Bereketli Ova 🌾 counter reset on ownership change — same as flipOwnership. */
        bereketHarvestTurns: 0,
        hiddenShieldOwnerId: playerId,
        hiddenShieldKind:    "conquest" as const,
      };
    }
    if (rs.hiddenShieldOwnerId === playerId) {
      return { ...rs, hiddenShieldOwnerId: undefined, hiddenShieldKind: undefined };
    }
    return rs;
  });

  const nextPlayerBonuses: Record<string, ConquestPlayerBonusState> = {
    ...(state.playerBonuses ?? {}),
    [playerId]: { ...pb, pendingHiddenShield: false },
  };

  const playerName  = state.players.find(p => p.id === playerId)?.name ?? "Oyuncu";
  const baseResult: ConquestActionResult = {
    ok:       true,
    action:   "defend_region",
    playerId,
    regionId,
    /* Public message MUST NOT leak region or op kind — same sentinel used by
     * placeHiddenShieldOnOwnRegion so the UI banner fires identically. */
    message:  buildHiddenOpPlacedMessage(playerName),
  };

  const historyEntry = {
    roundNumber:       state.round.roundNumber,
    challengeWinnerId: state.round.challenge.winnerPlayerId,
    result:            baseResult,
  };

  // Hidden bonus claim — gizli fetih flips ownership for real, so a hidden
  // bonus on this region is collected by the placer just like any other
  // first-capture.  Opponent-facing toast copy never names the region, so
  // the cloak is not undermined by the toast itself.
  const nowForHb = getConquestSyncedNowMs();
  const hb = tryClaimHiddenBonus(
    state.hiddenBonusPlacements,
    state.playerHiddenBonuses,
    regionId,
    playerId,
    playerName,
    state.round.roundNumber,
    nowForHb,
  );
  const postHiddenPlacements = hb ? hb.hiddenBonusPlacements : state.hiddenBonusPlacements;
  const postPlayerHidden     = hb ? hb.playerHiddenBonuses   : state.playerHiddenBonuses;
  const postHiddenToast      = hb ? hb.lastHiddenBonusToast  : state.lastHiddenBonusToast;

  // 👁️ İstihbarat Ağı — Gizli Operasyon (gizli fetih flavour) intel report.
  // Carries the target region so the intel owner learns WHERE the secret
  // move landed; renderer suppresses for non-intel-owners.  When the gizli
  // fetih also claimed a hidden bonus, the hidden_claim report would take
  // priority — but since both events are equally meaningful intel, we emit
  // the gizli_op report (the placer's own hidden bonus claim still surfaces
  // through the standard claimer-only toast).
  const intelReportNeutral = buildGizliOpIntelReport(
    playerId, playerName, regionId, nowForHb,
  );

  // Early finish: a gizli fetih on the last neutral region while the player
  // owns every other tile would complete domination.  Mirrors the post-capture
  // check in applyActionToGame so the secret path can't accidentally bypass
  // the natural finish trigger.
  const dominatorId = getPlayerOwningAllRegions(nextRegionStates, mapConfig);
  if (dominatorId !== null) {
    const dominator = state.players.find(p => p.id === dominatorId);
    const domResult: ConquestActionResult = {
      ...baseResult,
      message:  `${dominator?.name ?? "Bir oyuncu"} tüm bölgeleri ele geçirdi!`,
    };
    return {
      state: {
        ...state,
        phase:                 "finished",
        finishedAt:            getConquestSyncedNowMs(),
        regionStates:          nextRegionStates,
        playerBonuses:         nextPlayerBonuses,
        hiddenBonusPlacements: postHiddenPlacements,
        playerHiddenBonuses:   postPlayerHidden,
        lastHiddenBonusToast:  postHiddenToast,
        lastIntelReport:       intelReportNeutral,
        round: {
          ...state.round,
          lastResult: domResult,
        },
        history: [...state.history, { ...historyEntry, result: domResult }],
      },
      result: domResult,
    };
  }

  return {
    state: {
      ...state,
      phase:                 "round_result",
      regionStates:          nextRegionStates,
      playerBonuses:         nextPlayerBonuses,
      hiddenBonusPlacements: postHiddenPlacements,
      playerHiddenBonuses:   postPlayerHidden,
      lastHiddenBonusToast:  postHiddenToast,
      lastIntelReport:       intelReportNeutral,
      round: {
        ...state.round,
        lastResult: baseResult,
      },
      history: [...state.history, historyEntry],
    },
    result: baseResult,
  };
}

/**
 * Auto-skip the action phase when its timer expires.  Host-only writer in the
 * live loop (mirrors expireChallenge) so two clients don't race the same
 * write.  Idempotent: returns the state unchanged if the phase has already
 * moved on, no holder is set, or the timer field is missing.
 *
 * Implementation just routes through `applyActionToGame` with a `skip` action
 * on behalf of the holder — keeps the round-result + history bookkeeping in
 * one place and matches what the manual "Pas Geç" button does.
 */
export function expireActionPhase(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
): ConquestGameState {
  if (state.phase !== "action") return state;
  const holderId = state.round.actionHolderId;
  if (!holderId) return state;
  const { state: next } = applyActionToGame(state, mapConfig, {
    type:     "skip",
    playerId: holderId,
  });
  // Mark the skip message as time-out specific so the round panel can
  // distinguish manual vs. auto skips later. Only overwrite if applyAction
  // actually moved into round_result (the skip succeeded).
  if (next.phase === "round_result" && next.round.lastResult?.ok) {
    return {
      ...next,
      round: {
        ...next.round,
        lastResult: {
          ...next.round.lastResult,
          message: "Süre doldu — hamle yapılamadı.",
        },
      },
    };
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Savunma Düellosu — defense duel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a defense-duel state and switch the game phase to "defense_duel".
 * Picks a fresh challenge from the existing bank, narrows eligibility to the
 * two duellists, and tags the duel with whether the target region currently
 * carries an open shield (İstanbul) so resolution can break vs flip.
 *
 * Pure: returns a new ConquestGameState; never mutates inputs.
 */
function startDefenseDuel(
  state:          ConquestGameState,
  attackerId:     string,
  defenderId:     string,
  regionId:       ConquestRegionId,
  shieldActive:   boolean,
  kocbasiBypass:  boolean = false,
  mancinikBypass: boolean = false,
  outpostBreak:   boolean = false,
  guardianBypass: boolean = false,
): ConquestGameState {
  const now = getConquestSyncedNowMs();
  const usedSoFar = state.usedChallengeKeys ?? [];
  const lastType  = state.lastChallengeType;
  const picked    = pickRandomConquestChallenge(
    state.round.roundNumber,
    state.players,
    usedSoFar,
    lastType,
  );
  // Narrow eligibility to attacker + defender; everyone else watches.
  const challenge: ConquestChallenge = {
    ...picked.challenge,
    eligiblePlayerIds: [attackerId, defenderId],
  };

  // Mevzi Bekçisi 🏰 — bonus repurposed to an economic-defense payout
  // (preserve region points on loss, applied in `resolveDuelWithWinner`).
  // No defender time bonus is granted; the asymmetric-clock infrastructure
  // (`defenderTimeBonusMs`, attacker submission cap in `submitDuelAnswer`,
  // viewer-aware `effectiveEndsAt`) is left in place for future bonuses.
  const defenderTimeBonusMs = 0;

  const questionVisibleAt = now + DEFENSE_DUEL_INTRO_MS;
  const duel: ConquestDefenseDuelState = {
    id:               `duel-${state.round.roundNumber}-${now}`,
    attackerId,
    defenderId,
    regionId,
    shieldActive,
    challenge,
    startedAt:        now,
    questionVisibleAt,
    defenderTimeBonusMs,
    endsAt:           questionVisibleAt + DEFENSE_DUEL_MS + defenderTimeBonusMs,
    status:           "active",
    winnerId:         null,
    submittedAnswers: [],
    kocbasiBypass:    kocbasiBypass || undefined,
    mancinikBypass:   mancinikBypass || undefined,
    outpostBreak:     outpostBreak  || undefined,
    guardianBypass:   guardianBypass || undefined,
  };

  return {
    ...state,
    phase:              "defense_duel",
    defenseDuel:        duel,
    usedChallengeKeys:  [...usedSoFar, picked.bankId],
    lastChallengeType:  challenge.type as ConquestChallengeType,
  };
}

/**
 * Validate `rawAnswer` against the active duel for `submitterId`.
 *
 * Returns `{ ok: true, winning: true, state }` if the answer is correct and
 * resolves the duel; `{ ok: true, winning: false, state }` for a wrong (but
 * legal) submission; `{ ok: false }` for an illegal submission (phase wrong,
 * duel not active, submitter not one of the two duellists).
 *
 * Wrong attempts are NOT recorded in the synced state — they're tracked
 * client-side to avoid write contention (mirrors challenge-phase behaviour).
 */
export interface SubmitDuelAnswerResult {
  ok:      boolean;
  winning: boolean;
  state:   ConquestGameState;
}

export function submitDuelAnswer(
  state:       ConquestGameState,
  mapConfig:   ConquestMapConfig,
  submitterId: string,
  rawAnswer:   string,
): SubmitDuelAnswerResult {
  if (state.phase !== "defense_duel" || !state.defenseDuel) {
    return { ok: false, winning: false, state };
  }
  const duel = state.defenseDuel;
  if (duel.status !== "active") {
    return { ok: false, winning: false, state };
  }
  if (submitterId !== duel.attackerId && submitterId !== duel.defenderId) {
    return { ok: false, winning: false, state };
  }
  if (isPlayerEliminated(state, submitterId)) {
    return { ok: false, winning: false, state };
  }

  // Mevzi Bekçisi attacker-cap.  When the defender holds the bonus, their
  // deadline (`endsAt`) is later than the attacker's by `defenderTimeBonusMs`.
  // Reject attacker submissions landing after that cap so the +3s extension
  // stays defender-exclusive.  Defender submissions are bounded by `endsAt`
  // via the existing host-side `expireDuel`.
  const defenderBonus = duel.defenderTimeBonusMs ?? 0;
  if (defenderBonus > 0 && submitterId === duel.attackerId) {
    const attackerEndsAt = duel.endsAt - defenderBonus;
    if (getConquestSyncedNowMs() >= attackerEndsAt) {
      return { ok: false, winning: false, state };
    }
  }

  const correct = isChallengeAnswerCorrect(duel.challenge, rawAnswer);
  if (!correct) {
    return { ok: true, winning: false, state };
  }

  const next = resolveDuelWithWinner(state, mapConfig, submitterId);
  return { ok: true, winning: true, state: next };
}

/**
 * Resolve the active duel with the given winner.  Branches on who won:
 *   - Attacker wins, shield active → break shield, region preserved.
 *   - Attacker wins, no shield     → flip ownership (+ capture-side bonuses).
 *   - Defender wins                → region preserved.
 *
 * Transitions phase to `round_result` and clears `defenseDuel`.
 */
function resolveDuelWithWinner(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
  winnerId:  string,
): ConquestGameState {
  const duel = state.defenseDuel;
  if (!duel || duel.status !== "active") return state;
  const now = getConquestSyncedNowMs();

  const attackerName = state.players.find(p => p.id === duel.attackerId)?.name ?? "Saldıran";
  const defenderName = state.players.find(p => p.id === duel.defenderId)?.name ?? "Savunan";
  const regionLabel  = mapConfig.regions.find(r => r.id === duel.regionId)?.displayLabel
                   ?? mapConfig.regions.find(r => r.id === duel.regionId)?.name
                   ?? duel.regionId;

  // ── Sınır Karakolu — outpost duel branch ──────────────────────────────
  // Region is NEUTRAL; defender does not own it.  Both outcomes clear the
  // outpost field; attacker-win additionally flips ownership to attacker.
  // Capture-side bonus chains (mevzi/koçbaşı/hidden bonus claim) are
  // skipped — the region's bonus payload belongs to no current owner so
  // calling them would produce wrong toasts.
  if (duel.outpostBreak) {
    if (winnerId === duel.defenderId) {
      const cleared = state.regionStates.map(rs =>
        rs.regionId === duel.regionId
          ? { ...rs, borderOutpostOwnerId: undefined }
          : rs,
      );
      const result: ConquestActionResult = {
        ok:       true,
        action:   "defend_region",
        playerId: duel.defenderId,
        regionId: duel.regionId,
        message:  `🏯 Sınır Karakolu saldırıyı durdurdu. ${regionLabel} boş kaldı.`,
      };
      return {
        ...finishDuelIntoRoundResult(state, result),
        regionStates: cleared,
      };
    }

    // Attacker wins → neutral → attacker, outpost cleared.  Use
    // applyConquestAction's capture_neutral flip so all the usual side
    // effects (lastCapturedBy, turnCaptured, captureCount, shielded/
    // limanIncomeTicks/bereketHarvestTurns reset, and our new
    // borderOutpostOwnerId reset inside flipOwnership) all happen in one
    // place.  Mancınık bypass forwarded to keep long-range outpost takes
    // valid; adjacency was checked when the player clicked.
    const flipApplied = applyConquestAction(
      mapConfig,
      state.regionStates,
      state.players,
      state.round.roundNumber,
      { type: "capture_neutral", playerId: duel.attackerId, regionId: duel.regionId },
      duel.mancinikBypass === true,
    );
    if (!flipApplied.result.ok) {
      // Shouldn't happen — adjacency was valid when the duel started — but
      // stay defensive: treat as defender-wins so the region survives.
      const cleared = state.regionStates.map(rs =>
        rs.regionId === duel.regionId
          ? { ...rs, borderOutpostOwnerId: undefined }
          : rs,
      );
      const result: ConquestActionResult = {
        ok:       true,
        action:   "defend_region",
        playerId: duel.defenderId,
        regionId: duel.regionId,
        message:  `🏯 Sınır Karakolu saldırıyı durdurdu. ${regionLabel} boş kaldı.`,
      };
      return {
        ...finishDuelIntoRoundResult(state, result),
        regionStates: cleared,
      };
    }
    const flipResult: ConquestActionResult = {
      ok:                 true,
      action:             "capture_neutral",
      playerId:           duel.attackerId,
      regionId:           duel.regionId,
      message:            `🏯 ${attackerName} Sınır Karakolunu yıktı ve ${regionLabel} bölgesini ele geçirdi.`,
      mancinikBypassUsed: duel.mancinikBypass === true || undefined,
    };

    // Hidden bonus claim — outpost attacker-win is a real fetih on a
    // neutral region, so the "first capture pockets the bonus" rule must
    // still apply.  Mevzi / Koçbaşı / defender-region bonus chains stay
    // intentionally skipped on this branch (region had no current owner —
    // those bonuses would route through wrong payloads); hidden bonuses
    // live on a SEPARATE state channel and only depend on the region's
    // placement + the first capture flipping ownership.  Defender-win
    // and timeout branches above never reach this code, so neither path
    // claims the bonus — region stays neutral, placement untouched, the
    // attacker who eventually captures the region later collects it.
    const hb = tryClaimHiddenBonus(
      state.hiddenBonusPlacements,
      state.playerHiddenBonuses,
      duel.regionId,
      duel.attackerId,
      attackerName,
      state.round.roundNumber,
      now,
    );
    const postHiddenPlacements = hb ? hb.hiddenBonusPlacements : state.hiddenBonusPlacements;
    const postPlayerHidden     = hb ? hb.playerHiddenBonuses   : state.playerHiddenBonuses;
    const postHiddenToast      = hb ? hb.lastHiddenBonusToast  : state.lastHiddenBonusToast;
    const postIntelReport      = hb
      ? buildHiddenClaimIntelReport(duel.attackerId, attackerName, hb.lastHiddenBonusToast.type, now)
      : state.lastIntelReport;

    return {
      ...finishDuelIntoRoundResult(state, flipResult),
      regionStates:          flipApplied.regionStates,
      hiddenBonusPlacements: postHiddenPlacements,
      playerHiddenBonuses:   postPlayerHidden,
      lastHiddenBonusToast:  postHiddenToast,
      lastIntelReport:       postIntelReport,
    };
  }

  // ── Defender wins → region preserved, shield untouched. ──
  if (winnerId === duel.defenderId) {
    const result: ConquestActionResult = {
      ok:       true,
      action:   "defend_region",
      playerId: duel.defenderId,
      regionId: duel.regionId,
      message:  `🛡️ ${defenderName}, ${regionLabel} bölgesini düelloda savundu.`,
    };
    return finishDuelIntoRoundResult(state, result);
  }

  // ── Attacker wins ──
  // Shield active → break shield only, do not flip.
  if (duel.shieldActive) {
    const cleared = state.regionStates.map(rs =>
      rs.regionId === duel.regionId ? { ...rs, shielded: false } : rs,
    );
    const result: ConquestActionResult = {
      ok:       true,
      action:   "attack_region",
      playerId: duel.attackerId,
      regionId: duel.regionId,
      message:  `🛡️ Kalkan kırıldı! ${regionLabel} bu saldırıda korundu.`,
    };
    return {
      ...finishDuelIntoRoundResult(state, result),
      regionStates: cleared,
    };
  }

  // Attacker wins, no shield → flip ownership and trigger capture bonuses.
  // Mancınık 🎯 — forward the duel-start bypass snapshot so the adjacency
  // check inside `applyConquestAction` doesn't reject a long-range attack.
  const applied = applyConquestAction(
    mapConfig,
    state.regionStates,
    state.players,
    state.round.roundNumber,
    { type: "attack_region", playerId: duel.attackerId, regionId: duel.regionId },
    duel.mancinikBypass === true,
  );
  if (!applied.result.ok) {
    // Shouldn't happen — adjacency was valid when the duel started — but stay
    // defensive: treat as defender-wins so the region survives.
    const result: ConquestActionResult = {
      ok:       true,
      action:   "defend_region",
      playerId: duel.defenderId,
      regionId: duel.regionId,
      message:  `🛡️ ${regionLabel} korundu.`,
    };
    return finishDuelIntoRoundResult(state, result);
  }

  // Capture-side bonus chain (resolved via dynamic round assignment).
  // A duel flip is never a neutral capture, so pendingHiddenShield is not
  // consumed here.  triggerCaptureBonus is a no-op for non-bonus regions.
  const bonusOut = triggerCaptureBonus(
    applied.regionStates,
    state.playerBonuses,
    state.roundBonuses,
    duel.attackerId,
    attackerName,
    duel.regionId,
    now,
    false,
  );

  // Mevzi Bekçisi 🏰 — if the lost region carried the bonus, the previous
  // owner (the defender) keeps the region's point value as a `bonusPoints`
  // payout.  Applied AFTER the capture-side bonus chain so the per-region
  // claim log and the attacker's regional updates layer cleanly.  Loss-
  // flavoured toast takes priority over the capture-flavoured one (which
  // for mevzi is purely descriptive — the new owner gains the same future
  // protection, but the immediate news beat is the points preserved).
  const mevziOut = applyMevziProtectionOnLoss(
    bonusOut.regionStates,
    bonusOut.playerBonuses,
    state.roundBonuses,
    duel.defenderId,
    defenderName,
    duel.regionId,
    now,
  );

  // Koçbaşı 🪵 — duel flip always means an enemy region was fethed, so the
  // +1 payout applies whenever the attacker still owns the kocbasi region.
  // `kocbasiBypass` (snapshotted at duel start) decides whether the toast
  // also announces the shield bypass.
  const kocbasiOut = applyKocbasiOnEnemyCapture(
    mevziOut.regionStates,
    mevziOut.playerBonuses,
    state.roundBonuses,
    duel.attackerId,
    attackerName,
    duel.regionId,
    false,
    duel.kocbasiBypass === true,
    now,
  );
  const postBonusToast = kocbasiOut.toast ?? mevziOut.toast ?? bonusOut.toast;

  // Hidden bonus claim — a duel flip is a fetih, so the attacker collects
  // any unclaimed hidden bonus on the captured region.  Layered after the
  // open-bonus chain; lives on a separate state channel so it never affects
  // points or `lastBonusToast`.
  const hb = tryClaimHiddenBonus(
    state.hiddenBonusPlacements,
    state.playerHiddenBonuses,
    duel.regionId,
    duel.attackerId,
    attackerName,
    state.round.roundNumber,
    now,
  );
  const postHiddenPlacements = hb ? hb.hiddenBonusPlacements : state.hiddenBonusPlacements;
  const postPlayerHidden     = hb ? hb.playerHiddenBonuses   : state.playerHiddenBonuses;
  const postHiddenToast      = hb ? hb.lastHiddenBonusToast  : state.lastHiddenBonusToast;
  // 👁️ İstihbarat Ağı — when the duel flip claimed a hidden bonus, emit an
  // intel report carrying the real bonus type so the intel owner learns
  // WHAT the opponent picked up.  Renderer suppresses for non-intel-owners.
  const postIntelReport = hb
    ? buildHiddenClaimIntelReport(duel.attackerId, attackerName, hb.lastHiddenBonusToast.type, now)
    : state.lastIntelReport;

  const flipResult: ConquestActionResult = {
    ok:                  true,
    action:              "attack_region",
    playerId:            duel.attackerId,
    regionId:            duel.regionId,
    message:             `⚔️ ${attackerName}, düelloda ${regionLabel} bölgesini fethetti.`,
    previousOwnerId:     duel.defenderId,
    kocbasiShieldBypass: duel.kocbasiBypass === true,
    mancinikBypassUsed:  duel.mancinikBypass === true || undefined,
  };

  const base = finishDuelIntoRoundResult(state, flipResult);

  // Elimination diff — the duel flip may have captured the defender's last
  // region.  Computed against the final post-bonus region snapshot so the
  // result screen ranks the defender below active players.
  const elimDiff = computeEliminationDiff(state, mevziOut.regionStates, now);

  // Domination check — attacker may have just captured the last enemy region.
  const dominatorId = getPlayerOwningAllRegions(mevziOut.regionStates, mapConfig);
  // Last-player-standing — covers the 3+ player case where the defender just
  // dropped to 0 but neutral regions still exist (dominatorId stays null).
  const survivorId  = getSoleSurvivorId(state.players, elimDiff.eliminatedPlayerIds);

  if (dominatorId !== null || survivorId !== null) {
    const winnerId  = dominatorId ?? survivorId!;
    const winner    = state.players.find(p => p.id === winnerId);
    const finishMsg = dominatorId !== null
      ? `${winner?.name ?? "Bir oyuncu"} tüm bölgeleri ele geçirdi!`
      : `${winner?.name ?? "Bir oyuncu"} son ayakta kalan oldu!`;
    const domResult: ConquestActionResult = {
      ok:              true,
      action:          "attack_region",
      playerId:        duel.attackerId,
      regionId:        duel.regionId,
      message:         finishMsg,
      previousOwnerId: duel.defenderId,
    };
    return {
      ...base,
      phase:                 "finished",
      finishedAt:            now,
      regionStates:          mevziOut.regionStates,
      playerBonuses:         kocbasiOut.playerBonuses,
      lastBonusToast:        postBonusToast ?? state.lastBonusToast,
      hiddenBonusPlacements: postHiddenPlacements,
      playerHiddenBonuses:   postPlayerHidden,
      lastHiddenBonusToast:  postHiddenToast,
      lastIntelReport:       postIntelReport,
      eliminatedPlayerIds:   elimDiff.eliminatedPlayerIds,
      eliminations:          elimDiff.eliminations,
      lastEliminationEvent:  elimDiff.lastEliminationEvent,
      winnerPlayerId:        winnerId,
      winnerName:            winner?.name,
      finishReason:          dominatorId !== null ? undefined : "last_player_standing",
      round: {
        ...base.round,
        lastResult: domResult,
      },
      history: [
        ...state.history,
        {
          roundNumber:       state.round.roundNumber,
          challengeWinnerId: state.round.challenge.winnerPlayerId,
          result:            domResult,
        },
      ],
    };
  }

  return {
    ...base,
    regionStates:          mevziOut.regionStates,
    playerBonuses:         kocbasiOut.playerBonuses,
    lastBonusToast:        postBonusToast ?? state.lastBonusToast,
    hiddenBonusPlacements: postHiddenPlacements,
    playerHiddenBonuses:   postPlayerHidden,
    lastHiddenBonusToast:  postHiddenToast,
    lastIntelReport:       postIntelReport,
    eliminatedPlayerIds:   elimDiff.eliminatedPlayerIds,
    eliminations:          elimDiff.eliminations,
    lastEliminationEvent:  elimDiff.lastEliminationEvent,
  };
}

/**
 * Auto-expire the active duel: timer elapsed with no correct answer.  By
 * spec the defender keeps the region.  Host-only writer in the live loop.
 */
export function expireDuel(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
): ConquestGameState {
  if (state.phase !== "defense_duel" || !state.defenseDuel) return state;
  if (state.defenseDuel.status !== "active") return state;

  const duel = state.defenseDuel;
  const regionLabel  = mapConfig.regions.find(r => r.id === duel.regionId)?.displayLabel
                   ?? mapConfig.regions.find(r => r.id === duel.regionId)?.name
                   ?? duel.regionId;
  const defenderName = state.players.find(p => p.id === duel.defenderId)?.name ?? "Savunan";

  // Sınır Karakolu — timeout still favours the defender (region stays
  // neutral), but the outpost is consumed and the message reflects the
  // outpost flavour instead of the standard duel copy.  No bonus chain
  // runs (neutral region; matches the resolveDuelWithWinner branch).
  if (duel.outpostBreak) {
    const cleared = state.regionStates.map(rs =>
      rs.regionId === duel.regionId
        ? { ...rs, borderOutpostOwnerId: undefined }
        : rs,
    );
    const result: ConquestActionResult = {
      ok:       true,
      action:   "defend_region",
      playerId: duel.defenderId,
      regionId: duel.regionId,
      message:  `⏰ Süre doldu — Sınır Karakolu saldırıyı durdurdu. ${regionLabel} boş kaldı.`,
    };
    return {
      ...finishDuelIntoRoundResult(state, result),
      regionStates: cleared,
    };
  }

  const result: ConquestActionResult = {
    ok:       true,
    action:   "defend_region",
    playerId: duel.defenderId,
    regionId: duel.regionId,
    message:  `⏰ Süre doldu — ${defenderName}, ${regionLabel} bölgesini savundu.`,
  };
  return finishDuelIntoRoundResult(state, result);
}

/**
 * Shared tail for all duel-resolution paths: transition to round_result,
 * clear the active duel, write the history entry.
 */
function finishDuelIntoRoundResult(
  state:  ConquestGameState,
  result: ConquestActionResult,
): ConquestGameState {
  return {
    ...state,
    phase:       "round_result",
    defenseDuel: undefined,
    round: {
      ...state.round,
      lastResult: result,
    },
    history: [
      ...state.history,
      {
        roundNumber:       state.round.roundNumber,
        challengeWinnerId: state.round.challenge.winnerPlayerId,
        result,
      },
    ],
  };
}

/**
 * Advance to the next round, or finish the match if the last round just
 * completed.  Caller invokes this from the `round_result` panel ("Sonraki
 * Tur") or auto-fires it after a short delay.
 *
 * Bonus assignment is match-stable: `state.roundBonuses` was built once at
 * match creation and is preserved verbatim across rounds.  `mapConfig` is
 * retained for signature compatibility with existing callers, but is no
 * longer used here.
 */
export function advanceToNextRound(
  state:      ConquestGameState,
  _mapConfig?: ConquestMapConfig,
): ConquestGameState {
  if (state.phase !== "round_result") return state;

  // Liman ⚓ — pay the current owner's round-end income before transitioning.
  // Applies to BOTH the final round (where we jump to "finished" right after)
  // and intermediate rounds (where we mount the next challenge).  The income
  // is part of the round-end resolution; the next-round mount is purely a
  // setup step that should never absorb the payout.
  const limanApplied = applyLimanRoundIncome(state);
  // Bereketli Ova 🌾 — tick the held-tenure harvest counter on the bereket
  // region's owner.  Layered after Liman so a harvest toast (which is more
  // headline-worthy) wins the `lastBonusToast` slot when both fire in the
  // same round-end.
  const bereketApplied = applyBereketRoundHarvest(limanApplied);

  const isLast = bereketApplied.round.roundNumber >= bereketApplied.round.totalRounds;
  if (isLast) {
    return {
      ...bereketApplied,
      phase:      "finished",
      finishedAt: getConquestSyncedNowMs(),
    };
  }

  const nextRoundNumber = bereketApplied.round.roundNumber + 1;
  const usedSoFar  = bereketApplied.usedChallengeKeys ?? [];
  const lastType   = bereketApplied.lastChallengeType;
  // Filter out eliminated players from challenge eligibility so they cannot
  // submit answers next round.  Pre-picked Kâhin challenges may still carry
  // a stale roster; the eligibility list is rebuilt below regardless.
  const activeForNext = getActivePlayers(bereketApplied);
  // Kâhin Büyüsü 🔮 — consume the pre-picked next challenge when present
  // (so the round actually delivers the question type Kâhin previewed).
  // Falls back to picking fresh for legacy saves with no `nextChallenge`.
  const picked = bereketApplied.nextChallenge
    ? bereketApplied.nextChallenge
    : pickRandomConquestChallenge(
        nextRoundNumber,
        activeForNext,
        usedSoFar,
        lastType,
      );
  // Always restrict eligibility to active (non-eliminated) players, even on
  // the pre-picked Kâhin path where the cached challenge may carry an older
  // roster.  Pure rewrite of one field; rest of the challenge stays intact.
  const activeIds = activeForNext.map(p => p.id);
  const challenge: ConquestChallenge = {
    ...picked.challenge,
    eligiblePlayerIds: activeIds,
  };
  const bankId = picked.bankId;
  const now = getConquestSyncedNowMs();

  // Refresh the Kâhin preview for the round AFTER the one we're about to
  // mount, unless this transition completes the match.  Skipped when the
  // next round is the last — there's no future round to peek at.
  const totalRounds = bereketApplied.round.totalRounds;
  const usedAfterMount = bereketApplied.nextChallenge
    ? usedSoFar  // already includes bankId from the pre-pick
    : [...usedSoFar, bankId];
  let nextChallenge: ConquestGameState["nextChallenge"];
  if (nextRoundNumber < totalRounds) {
    const peek = pickRandomConquestChallenge(
      nextRoundNumber + 1,
      activeForNext,
      usedAfterMount,
      challenge.type as ConquestChallengeType,
    );
    nextChallenge = {
      challenge: { ...peek.challenge, eligiblePlayerIds: activeIds },
      bankId:    peek.bankId,
    };
  }
  const finalUsedKeys = nextChallenge
    ? [...usedAfterMount, nextChallenge.bankId]
    : usedAfterMount;

  // Preserve the round-end income / harvest toast so the next round still
  // renders it once on every client before the challenge mounts.  Both
  // Liman ⚓ income and Bereketli Ova 🌾 harvest qualify; everything else is
  // cleared so stale capture toasts don't echo on late joiners.
  const pendingToast      = bereketApplied.lastBonusToast;
  const carryToastForward =
    !!pendingToast && (
      (pendingToast.bonusType === "liman"          && pendingToast.id.startsWith("liman_income-")) ||
      (pendingToast.bonusType === "cukurova_score" && pendingToast.id.startsWith("bereket_harvest-"))
    );

  return {
    ...bereketApplied,
    phase:             "challenge",
    usedChallengeKeys: finalUsedKeys,
    lastChallengeType: challenge.type as ConquestChallengeType,
    /* roundBonuses stays as-is — bonus regions are fixed for the match. */
    lastBonusToast:    carryToastForward ? pendingToast : undefined,
    /* Hidden bonus claim toasts are one-shot: clear on round advance so a
     * stale claim doesn't echo to late joiners or replay on next-round mount. */
    lastHiddenBonusToast: undefined,
    /* Elimination events are one-shot: clear on round advance so the rival
     * banner doesn't replay to late joiners.  eliminatedPlayerIds /
     * eliminations stay populated — they are durable match state. */
    lastEliminationEvent: undefined,
    /* 👁️ İstihbarat Ağı intel reports are one-shot: clear on round advance
     * so a stale report doesn't echo to late joiners or to a new intel-
     * region owner who joined after the original event. */
    lastIntelReport: undefined,
    nextChallenge,
    round: {
      roundNumber:    nextRoundNumber,
      totalRounds:    bereketApplied.round.totalRounds,
      challenge:      buildActiveChallengeState(challenge, now + ROUND_INTRO_PACING_MS),
      actionHolderId: null,
      lastResult:     null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bereketli Ova 🌾 — capture bonus + held-tenure harvest
// ─────────────────────────────────────────────────────────────────────────────

/** Bonus points awarded immediately on every capture of the Bereketli Ova
 *  region (in addition to the region's own point value). */
export const BEREKET_CAPTURE_POINTS    = 2;
/** Number of round-end ticks the same owner must hold the Bereketli Ova
 *  region before the one-shot harvest payout fires.  After firing, no more
 *  harvests are produced under the same owner — the counter stays >= this
 *  value as a "harvested" sentinel until ownership flips and resets it. */
export const BEREKET_HARVEST_INTERVAL  = 3;
/** Bonus points awarded when the harvest counter completes (once per owner
 *  tenure on the bereket region). */
export const BEREKET_HARVEST_POINTS    = 4;

/**
 * Apply one round-end Bereketli Ova tick.  Once per owner tenure: when the
 * counter first crosses BEREKET_HARVEST_INTERVAL, pay +BEREKET_HARVEST_POINTS
 * to that owner's bonusPoints (counted by getPlayerTotalPoints so the
 * top-left scoreboard updates immediately).  After that the counter stays at
 * the interval value and ticks are no-ops until ownership flips and resets
 * the counter to 0 (handled in flipOwnership / placeHiddenConquestOnNeutralRegion).
 *
 * No-ops when:
 *   - No region carries the cukurova_score bonus this match.
 *   - The bereket region is neutral (no owner to credit).
 *   - The current owner has already collected this tenure's harvest
 *     (bereketHarvestTurns >= BEREKET_HARVEST_INTERVAL).
 */
export function applyBereketRoundHarvest(
  state: ConquestGameState,
): ConquestGameState {
  const bereketRegionId = findRegionIdForBonusType(state.roundBonuses, "cukurova_score");
  if (!bereketRegionId) return state;

  const regionState = state.regionStates.find(rs => rs.regionId === bereketRegionId);
  if (!regionState) return state;
  const ownerId = regionState.ownerPlayerId;
  if (!ownerId) return state;

  const currentTurns = regionState.bereketHarvestTurns ?? 0;
  // Already harvested under this owner — no more payouts until ownership
  // flips (which resets the counter to 0).  This is the gate that stops
  // the +4 from repeating every round.
  if (currentTurns >= BEREKET_HARVEST_INTERVAL) return state;

  const nextTurns    = currentTurns + 1;
  const harvestFires = nextTurns >= BEREKET_HARVEST_INTERVAL;

  const nextRegionStates = state.regionStates.map(rs =>
    rs.regionId === bereketRegionId
      ? { ...rs, bereketHarvestTurns: nextTurns }
      : rs,
  );

  if (!harvestFires) {
    return { ...state, regionStates: nextRegionStates };
  }

  const currentBonuses = state.playerBonuses ?? {};
  const ownerBonus     = currentBonuses[ownerId] ?? createEmptyPlayerBonusState();
  const nextPlayerBonuses: Record<string, ConquestPlayerBonusState> = {
    ...currentBonuses,
    [ownerId]: {
      ...ownerBonus,
      bonusPoints: ownerBonus.bonusPoints + BEREKET_HARVEST_POINTS,
    },
  };

  const ownerName = state.players.find(p => p.id === ownerId)?.name ?? "Oyuncu";
  const now       = getConquestSyncedNowMs();
  const toast: ConquestBonusToast = {
    id:         `bereket_harvest-${bereketRegionId}-${now}-${ownerId}`,
    bonusType:  "cukurova_score",
    regionId:   bereketRegionId,
    icon:       "🌾",
    title:      `🌾 Hasat Tamamlandı`,
    detail:     `${ownerName} bölgeyi ${BEREKET_HARVEST_INTERVAL} tur elinde tuttu, +${BEREKET_HARVEST_POINTS} hasat puanı kazandı. (Bu tenürde tekrar hasat verilmeyecek.)`,
    playerId:   ownerId,
    playerName: ownerName,
    at:         now,
  };

  return {
    ...state,
    regionStates:   nextRegionStates,
    playerBonuses:  nextPlayerBonuses,
    lastBonusToast: toast,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Liman ⚓ — round-end income
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of income payouts per owner tenure on a Liman region. */
export const LIMAN_MAX_INCOME_TICKS = 10;
/** Bonus points awarded per Liman income tick. */
export const LIMAN_INCOME_POINTS    = 1;
/** Gold awarded per Liman income tick (written by the local owner only). */
export const LIMAN_INCOME_GOLD      = 5;

/**
 * Apply one round-end income payout for the Liman bonus, if any region carries
 * it and the current owner hasn't hit the per-tenure cap yet.  Pure function.
 *
 * Effects:
 *   - Increments the region's `limanIncomeTicks` (1..LIMAN_MAX_INCOME_TICKS).
 *   - Adds LIMAN_INCOME_POINTS to the owner's `bonusPoints` (counted by the
 *     standard scoring pipeline; visible on the leaderboard immediately).
 *   - Emits a `lastBonusToast` with id prefixed `liman_income-` so every
 *     client renders the income notification.  The local owner client
 *     additionally writes +LIMAN_INCOME_GOLD to its own profile.gold when it
 *     consumes the toast (see ConquestGame.tsx).
 *
 * No-ops when:
 *   - No region carries the Liman bonus this match.
 *   - The Liman region is neutral (no owner to pay).
 *   - The current owner already received the cap (10) of payouts this tenure.
 *     Tenure resets on every ownership flip (see flipOwnership /
 *     placeHiddenConquestOnNeutralRegion).
 */
export function applyLimanRoundIncome(
  state: ConquestGameState,
): ConquestGameState {
  const limanRegionId = findRegionIdForBonusType(state.roundBonuses, "liman");
  if (!limanRegionId) return state;

  const regionState = state.regionStates.find(rs => rs.regionId === limanRegionId);
  if (!regionState) return state;
  const ownerId = regionState.ownerPlayerId;
  if (!ownerId) return state;

  const currentTicks = regionState.limanIncomeTicks ?? 0;
  if (currentTicks >= LIMAN_MAX_INCOME_TICKS) return state;

  const nextTicks = currentTicks + 1;

  const nextRegionStates = state.regionStates.map(rs =>
    rs.regionId === limanRegionId
      ? { ...rs, limanIncomeTicks: nextTicks }
      : rs,
  );

  // Bonus state mutation: increment bonusPoints (counted directly by
  // getPlayerTotalPoints so the scoreboard reflects the +1 immediately on
  // every client) AND matchGoldEarned (synced so every viewer can see how
  // much in-match Gold each player has accumulated via Liman).  Account-
  // level Gold is credited *only* by the local owner client — never written
  // here, never mirrored to other players.
  const currentBonuses = state.playerBonuses ?? {};
  const ownerBonus     = currentBonuses[ownerId] ?? createEmptyPlayerBonusState();
  const nextPlayerBonuses: Record<string, ConquestPlayerBonusState> = {
    ...currentBonuses,
    [ownerId]: {
      ...ownerBonus,
      bonusPoints:     ownerBonus.bonusPoints + LIMAN_INCOME_POINTS,
      matchGoldEarned: (ownerBonus.matchGoldEarned ?? 0) + LIMAN_INCOME_GOLD,
    },
  };

  const ownerName = state.players.find(p => p.id === ownerId)?.name ?? "Oyuncu";
  const now       = getConquestSyncedNowMs();
  const toast: ConquestBonusToast = {
    id:         `liman_income-${limanRegionId}-${nextTicks}-${ownerId}`,
    bonusType:  "liman",
    regionId:   limanRegionId,
    icon:       "⚓",
    title:      `⚓ Liman Geliri (${nextTicks}/${LIMAN_MAX_INCOME_TICKS})`,
    detail:     `${ownerName} +${LIMAN_INCOME_POINTS} puan, +${LIMAN_INCOME_GOLD} Gold kazandı.`,
    playerId:   ownerId,
    playerName: ownerName,
    at:         now,
  };

  return {
    ...state,
    regionStates:   nextRegionStates,
    playerBonuses:  nextPlayerBonuses,
    lastBonusToast: toast,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hidden bonuses — consume (Suikast 🗡️)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consume one of `casterId`'s unused Suikast charges to dock `targetId`'s
 * score by SUIKAST_DAMAGE (currently 2).  Returns the next ConquestGameState
 * with:
 *
 *   - inventory entry flipped to `used: true`
 *   - target's `playerBonuses[targetId].bonusPoints` decremented by the
 *     EFFECTIVE loss (clamped so the displayed total never drops below 0)
 *   - `lastHiddenBonusToast` set to a "use" event so every client renders
 *     the viewer-aware Suikast notification at the same moment
 *
 * No-ops (returns the state untouched) when:
 *   - the entry id is missing from the caster's inventory
 *   - the entry is already used
 *   - the entry is not a Suikast charge
 *   - the caster is targeting themselves
 *   - the target id is not a real match player
 *
 * The phase / round / region states are NOT touched here — Suikast is a
 * passive, off-turn consume so the loop continues exactly where it was.
 */
export function applySuikastHiddenBonus(
  state:        ConquestGameState,
  casterId:     string,
  bonusEntryId: string,
  targetId:     string,
): ConquestGameState {
  const caster = state.players.find(p => p.id === casterId);
  const target = state.players.find(p => p.id === targetId);
  if (!caster || !target) return state;

  // Target's CURRENT visible total — region points + bonusPoints.  The pure
  // helper uses this only to clamp the deduction so the displayed score
  // never goes negative.
  const totals = getPlayerTotalPoints(
    state.players, state.regionStates, state.playerBonuses,
  );
  const targetCurrentScore = totals[targetId] ?? 0;

  const diff = useSuikastHiddenBonus({
    playerHiddenBonusesIn: state.playerHiddenBonuses,
    bonusEntryId,
    casterId,
    casterName:         caster.name,
    targetId,
    targetName:         target.name,
    targetCurrentScore,
    now:                getConquestSyncedNowMs(),
  });
  if (!diff) return state;

  // Apply the score deduction onto the target's bonusPoints.  Subtracting
  // from bonusPoints (rather than mutating regionStates) mirrors how every
  // other bonus-driven score change is modelled — total = regionPoints +
  // bonusPoints, see regionPoints.ts.  The deduction is already clamped at
  // the helper level so visible totals stay ≥ 0; the underlying bonusPoints
  // field can legitimately go negative, but the rendered total cannot.
  const currentBonuses = state.playerBonuses ?? {};
  const targetBonus    = currentBonuses[targetId] ?? createEmptyPlayerBonusState();
  const nextPlayerBonuses: Record<string, ConquestPlayerBonusState> = {
    ...currentBonuses,
    [targetId]: {
      ...targetBonus,
      bonusPoints: targetBonus.bonusPoints - diff.pointsLost,
    },
  };

  return {
    ...state,
    playerHiddenBonuses:  diff.playerHiddenBonuses,
    playerBonuses:        nextPlayerBonuses,
    lastHiddenBonusToast: diff.lastHiddenBonusToast,
  };
}

/**
 * Consume one of `casterId`'s unused Lanet Mührü charges against `targetId`.
 * Returns the next ConquestGameState with:
 *
 *   - inventory entry flipped to `used: true`
 *   - `activeHiddenEffects.curses[targetId]` set to the new pending curse
 *   - `lastHiddenBonusToast` set to a "use" event so every client renders
 *     the viewer-aware Lanet notification at the same moment
 *
 * No-ops (returns the state untouched) when:
 *   - the entry id is missing from the caster's inventory
 *   - the entry is already used
 *   - the entry is not a Lanet Mührü charge
 *   - the caster is targeting themselves
 *   - the target already has an active curse (no stacking)
 *   - the target id is not a real match player
 *
 * The phase / round / region states are NOT touched — the curse is purely
 * pending until the target would otherwise be promoted to action holder.
 * Defense duels are explicitly outside the curse window; only the round-level
 * `finalizeReveal` transition consumes it (see hasPendingCurse callsite there).
 */
export function applyLanetMuhruHiddenBonus(
  state:        ConquestGameState,
  casterId:     string,
  bonusEntryId: string,
  targetId:     string,
): ConquestGameState {
  const caster = state.players.find(p => p.id === casterId);
  const target = state.players.find(p => p.id === targetId);
  if (!caster || !target) return state;

  const diff = useLanetMuhruHiddenBonus({
    playerHiddenBonusesIn: state.playerHiddenBonuses,
    activeHiddenEffectsIn: state.activeHiddenEffects,
    bonusEntryId,
    casterId,
    casterName:    caster.name,
    targetId,
    targetName:    target.name,
    currentRound:  state.round.roundNumber,
    now:           getConquestSyncedNowMs(),
  });
  if (!diff) return state;

  return {
    ...state,
    playerHiddenBonuses:  diff.playerHiddenBonuses,
    activeHiddenEffects:  diff.activeHiddenEffects,
    lastHiddenBonusToast: diff.lastHiddenBonusToast,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hidden bonuses — consume (Pusu 🕳️)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consume one of `ownerId`'s unused Pusu charges to arm an ambush on
 * `regionId`.  Returns the next ConquestGameState with:
 *
 *   - inventory entry flipped to `used: true`
 *   - `activeHiddenEffects.ambushes[regionId]` set to the new pending ambush
 *   - `lastHiddenBonusToast` set to a "use" event so the owner's client
 *     renders the "Pusu Kuruldu" notification (opponents must filter this
 *     out — see UI surface).
 *
 * No-ops (returns the state untouched) when:
 *   - the entry id is missing from the owner's inventory
 *   - the entry is already used
 *   - the entry is not a Pusu charge
 *   - the chosen region is enemy-owned or a capital (placement rules)
 *   - the region already carries another active ambush (no stacking)
 *   - the owner id is not a real match player
 *
 * The phase / round / region states are NOT touched here — Pusu is a
 * passive, off-turn place so the loop continues exactly where it was.
 */
export function applyPusuHiddenBonus(
  state:        ConquestGameState,
  ownerId:      string,
  bonusEntryId: string,
  regionId:     ConquestRegionId,
): ConquestGameState {
  const owner = state.players.find(p => p.id === ownerId);
  if (!owner) return state;

  const diff = usePusuHiddenBonus({
    playerHiddenBonusesIn: state.playerHiddenBonuses,
    activeHiddenEffectsIn: state.activeHiddenEffects,
    regionStates:          state.regionStates,
    bonusEntryId,
    ownerId,
    ownerName:    owner.name,
    regionId,
    currentRound: state.round.roundNumber,
    now:          getConquestSyncedNowMs(),
  });
  if (!diff) return state;

  return {
    ...state,
    playerHiddenBonuses:  diff.playerHiddenBonuses,
    activeHiddenEffects:  diff.activeHiddenEffects,
    lastHiddenBonusToast: diff.lastHiddenBonusToast,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the id of the player who owns every region on the map, or null
 * when no single player has full control.  Works for any map/region count.
 *
 * Used to detect early-finish: if this returns non-null after any action,
 * the match is over immediately regardless of how many rounds remain.
 */
export function getPlayerOwningAllRegions(
  regionStates: ConquestRegionState[],
  mapConfig:    ConquestMapConfig,
): string | null {
  if (regionStates.length === 0) return null;
  if (regionStates.length !== mapConfig.regions.length) return null;
  const firstOwner = regionStates[0].ownerPlayerId;
  if (firstOwner === null) return null;
  for (const rs of regionStates) {
    if (rs.ownerPlayerId !== firstOwner) return null;
  }
  return firstOwner;
}

// ─────────────────────────────────────────────────────────────────────────────
// Elimination — players who have lost every region
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when this player has been eliminated (lost every region) earlier in the
 * match.  Eliminated players are skipped by challenge eligibility, action
 * holder selection, and submission gating.
 */
export function isPlayerEliminated(
  state:    ConquestGameState,
  playerId: string,
): boolean {
  return (state.eliminatedPlayerIds ?? []).includes(playerId);
}

/**
 * Active player ids (players minus eliminated).  Order matches the roster's
 * order — never reshuffled — so downstream rotation logic remains stable.
 */
export function getActivePlayerIds(state: ConquestGameState): string[] {
  const elim = new Set(state.eliminatedPlayerIds ?? []);
  return state.players.filter(p => !elim.has(p.id)).map(p => p.id);
}

/**
 * Active players (full ConquestPlayer rows).  Convenience wrapper around
 * getActivePlayerIds used by challenge factories that take the roster.
 */
export function getActivePlayers(state: ConquestGameState): ConquestPlayer[] {
  const elim = new Set(state.eliminatedPlayerIds ?? []);
  return state.players.filter(p => !elim.has(p.id));
}

/**
 * Compute the elimination diff produced by transitioning to `nextRegionStates`.
 * Returns the new eliminated-id list, the elimination metadata map, and an
 * event payload covering the newly-eliminated players (if any).  Pure: does
 * not mutate inputs.
 *
 * A player counts as newly-eliminated when:
 *   - they are not already in `state.eliminatedPlayerIds`, AND
 *   - they own zero regions in `nextRegionStates`.
 *
 * Multiple players can be eliminated by the same hamle (e.g. a single attack
 * captures the last region of two simultaneously-distinct holders); they all
 * land in the same event so the rival banner can chain them.
 */
export function computeEliminationDiff(
  state:            ConquestGameState,
  nextRegionStates: ConquestRegionState[],
  now:              number = getConquestSyncedNowMs(),
): {
  eliminatedPlayerIds: string[];
  eliminations:        Record<string, { at: number; round: number }>;
  newlyEliminatedIds:  string[];
  lastEliminationEvent: ConquestEliminationEvent | undefined;
} {
  const elimSet = new Set(state.eliminatedPlayerIds ?? []);
  const counts: Record<string, number> = {};
  for (const p of state.players) counts[p.id] = 0;
  for (const rs of nextRegionStates) {
    const o = rs.ownerPlayerId;
    if (o && counts[o] !== undefined) counts[o] += 1;
  }
  const newly: string[] = [];
  for (const p of state.players) {
    if (elimSet.has(p.id)) continue;
    if ((counts[p.id] ?? 0) === 0) newly.push(p.id);
  }
  if (newly.length === 0) {
    return {
      eliminatedPlayerIds:  state.eliminatedPlayerIds ?? [],
      eliminations:         state.eliminations ?? {},
      newlyEliminatedIds:   [],
      lastEliminationEvent: state.lastEliminationEvent,
    };
  }
  const eliminatedPlayerIds = [...(state.eliminatedPlayerIds ?? []), ...newly];
  const eliminations: Record<string, { at: number; round: number }> = {
    ...(state.eliminations ?? {}),
  };
  for (const pid of newly) {
    eliminations[pid] = { at: now, round: state.round.roundNumber };
  }
  const playerNames = newly.map(
    pid => state.players.find(p => p.id === pid)?.name ?? "Oyuncu",
  );
  const lastEliminationEvent: ConquestEliminationEvent = {
    id:          `elim-${now}-${newly.join("_")}`,
    playerIds:   newly,
    playerNames,
    at:          now,
    round:       state.round.roundNumber,
  };
  return {
    eliminatedPlayerIds,
    eliminations,
    newlyEliminatedIds: newly,
    lastEliminationEvent,
  };
}

/**
 * Return the lone surviving player id when only one remains active,
 * otherwise null.  Used to trigger the multi-player "last man standing"
 * finish path after an elimination.
 *
 * In 1v1, the legacy domination-based finish still fires first (one player
 * owning every region); this fallback covers the multi-player path where a
 * neutral region remains but only one player still has territory.
 */
export function getSoleSurvivorId(
  players:              ConquestPlayer[],
  eliminatedPlayerIds:  string[],
): string | null {
  const elim = new Set(eliminatedPlayerIds);
  const active = players.filter(p => !elim.has(p.id));
  if (active.length !== 1) return null;
  return active[0].id;
}

/**
 * Count regions owned by each player.  Players with zero regions are still
 * present in the output map (value = 0) so the result screen can list every
 * player without extra merging.
 */
export function getPlayerRegionCounts(
  players:      ConquestPlayer[],
  regionStates: ConquestRegionState[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of players) counts[p.id] = 0;
  for (const rs of regionStates) {
    if (rs.ownerPlayerId !== null && counts[rs.ownerPlayerId] !== undefined) {
      counts[rs.ownerPlayerId] += 1;
    }
  }
  return counts;
}

/**
 * Return the unique player with the most regions, or null on a tie / when
 * no player owns any region.
 */
export function getWinnerByRegionCount(
  players:      ConquestPlayer[],
  regionStates: ConquestRegionState[],
): string | null {
  const counts = getPlayerRegionCounts(players, regionStates);
  let bestId:   string | null = null;
  let bestN:    number        = -1;
  let tied                     = false;
  for (const [id, n] of Object.entries(counts)) {
    if (n > bestN) {
      bestId = id;
      bestN  = n;
      tied   = false;
    } else if (n === bestN) {
      tied = true;
    }
  }
  if (bestN <= 0) return null;
  return tied ? null : bestId;
}

/**
 * Build the sorted final standings for the result screen.  Ties share rank
 * (1,1,3 style) so the UI can show co-winners honestly.
 */
export function buildFinalStandings(
  state: ConquestGameState,
): ConquestFinalStanding[] {
  const counts = getPlayerRegionCounts(state.players, state.regionStates);
  const points = getPlayerTotalPoints(
    state.players, state.regionStates, state.playerBonuses,
  );
  // Elimination order: position in `eliminatedPlayerIds` → first eliminated
  // gets the lowest order so they slot lowest in standings.  Active players
  // get +Infinity so any eliminated row sorts below them, regardless of
  // points / regions.  Reverse-order on ties so a later elimination outranks
  // an earlier one.
  const elimOrder: Record<string, number> = {};
  (state.eliminatedPlayerIds ?? []).forEach((pid, i) => { elimOrder[pid] = i; });
  const isElim = (pid: string) => elimOrder[pid] !== undefined;

  const rows = state.players.map(p => ({
    playerId:    p.id,
    playerName:  p.name,
    regionsHeld: counts[p.id] ?? 0,
    points:      points[p.id] ?? 0,
  }));
  // Primary sort: active players above eliminated.  Among actives: points
  // (desc) then region count (desc).  Among eliminated: later-eliminated
  // (higher elimOrder) outranks earlier-eliminated; remaining ties fall back
  // to points / regions.
  rows.sort((a, b) => {
    const aElim = isElim(a.playerId);
    const bElim = isElim(b.playerId);
    if (aElim !== bElim) return aElim ? 1 : -1;
    if (aElim && bElim) {
      const ord = (elimOrder[b.playerId] ?? 0) - (elimOrder[a.playerId] ?? 0);
      if (ord !== 0) return ord;
    }
    return (b.points - a.points) || (b.regionsHeld - a.regionsHeld);
  });

  // Auto-finish override: when the match ended via "last player standing"
  // (opponent left or stale past the reconnect window), the player still in
  // the room is the winner regardless of who held more points/regions at
  // abandon time.  Promote that row to the top before computing ranks so the
  // result screen and the win/lose audio cue agree.
  const forcedWinnerId = state.winnerPlayerId ?? null;
  if (forcedWinnerId) {
    const idx = rows.findIndex(r => r.playerId === forcedWinnerId);
    if (idx > 0) {
      const [w] = rows.splice(idx, 1);
      rows.unshift(w);
    }
  }

  const out: ConquestFinalStanding[] = [];
  let lastKey: string | null = null;
  let lastRank               = 0;
  rows.forEach((r, i) => {
    let rank: number;
    if (forcedWinnerId && r.playerId === forcedWinnerId) {
      // Force the auto-finish winner to a solo rank 1; everyone else slots
      // beneath without sharing it, even on a points tie.
      rank = 1;
    } else {
      // Tie key includes elimination order so an eliminated row never
      // shares a rank with an active row (or with another player who
      // dropped on a different hamle).
      const elimKey = isElim(r.playerId) ? `E${elimOrder[r.playerId]}` : "A";
      const key = `${elimKey}|${r.points}|${r.regionsHeld}`;
      if (lastKey !== null && key === lastKey) {
        rank = lastRank;
      } else {
        rank = i + 1;
        lastRank = rank;
        lastKey  = key;
      }
    }
    out.push({ ...r, rank });
  });
  return out;
}

/**
 * Set of region ids the action holder can legally click this turn.  Returns
 * an empty set when no one currently holds a hamle.  Cheap to call from
 * render — the underlying scan is O(regions).
 *
 * When the holder has a `pendingHiddenShield` (Ankara Gizli Operasyon),
 * their OWN regions are also legal click targets so they can place a gizli
 * kalkan (a non-capture defensive op, so the adjacency rule does not apply).
 * Neutral regions are NOT widened by the bonus path: gizli fetih flips
 * ownership, so it must still satisfy the canonical adjacency rule and is
 * already covered by `getAllLegalTargetsForPlayer` above.  Enemy-owned
 * regions are never added by the bonus path.
 */
export function getCurrentLegalTargets(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
): Set<ConquestRegionId> {
  if (state.phase !== "action" || !state.round.actionHolderId) {
    return new Set();
  }
  const holderId = state.round.actionHolderId;
  const pb = state.playerBonuses?.[holderId];
  // Mancınık 🎯 — while the holder has an active charge, every non-self
  // region becomes a legal click target.  The charge itself is consumed
  // when the move actually commits (see `applyActionToGame` /
  // `resolveDuelWithWinner`) — never by highlighting alone.
  const mancinikActive = (pb?.mancinikCharges ?? 0) > 0;
  const targets = getAllLegalTargetsForPlayer(
    mapConfig,
    state.regionStates,
    holderId,
    mancinikActive,
  );
  if (pb?.pendingHiddenShield) {
    for (const rs of state.regionStates) {
      if (rs.ownerPlayerId === holderId) {
        targets.add(rs.regionId);
      }
    }
  }
  return targets;
}

/**
 * True if the action holder has *no* legal map move (capture or attack).
 * UI uses this to auto-offer / auto-trigger the skip path so the loop
 * doesn't dead-end.
 *
 * A holder with `pendingHiddenShield` is never stuck so long as they still
 * own at least one region (gizli kalkan placement is always valid on own
 * tiles).  Non-adjacent neutrals no longer count as an escape — gizli
 * fetih now requires adjacency, so any neutral move it could make is
 * already represented in the canonical legal-actions check below.
 */
export function actionHolderHasNoMoves(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
): boolean {
  if (state.phase !== "action" || !state.round.actionHolderId) return false;
  const holderId = state.round.actionHolderId;
  const pb = state.playerBonuses?.[holderId];
  if (pb?.pendingHiddenShield) {
    const ownsAny = state.regionStates.some(rs => rs.ownerPlayerId === holderId);
    if (ownsAny) return false;
  }
  // Mancınık 🎯: with the bypass active, any non-self region counts as a
  // legal target, so the holder is virtually never stuck.
  const mancinikActive = (pb?.mancinikCharges ?? 0) > 0;
  const legal = getLegalActionsForPlayer(
    mapConfig,
    state.regionStates,
    holderId,
    mancinikActive,
  );
  // skip is always present; "no moves" means skip is the only legal action.
  return legal.length === 1 && legal[0] === "skip";
}
