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
} from "./conquestActions";
import {
  CONQUEST_CHALLENGE_DURATION_MS,
  CONQUEST_REVEAL_DURATION_MS,
  pickRandomConquestChallenge,
} from "./conquestChallenges";
import { isChallengeAnswerCorrect } from "./conquestChallengeValidation";
import { createInitialRegionStates } from "./conquestState";
import { getPlayerTotalPoints } from "./regionPoints";
import {
  buildBonusToast,
  buildHiddenOpPlacedMessage,
  createEmptyPlayerBonusState,
  getRegionBonus,
  HIDDEN_CONQUEST_REVEAL_MESSAGE,
  HIDDEN_NEUTRAL_TRAP_REVEAL_MESSAGE,
  HIDDEN_SHIELD_REVEAL_MESSAGE,
  KARADENIZ_BONUS_MS,
} from "./regionBonuses";
import type {
  ConquestActionResult,
  ConquestBonusToast,
  ConquestChallenge,
  ConquestChallengeAnswer,
  ConquestChallengeState,
  ConquestChallengeType,
  ConquestDefenseDuelState,
  ConquestFinalStanding,
  ConquestGameState,
  ConquestMapConfig,
  ConquestPendingAction,
  ConquestPlayer,
  ConquestPlayerBonusState,
  ConquestRegionId,
  ConquestRegionState,
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
// Total intro window = sum of the two.
export const ROUND_INTRO_CARD_MS  = 4_000;
export const ROUND_COUNTDOWN_MS   = 3_000;
const ROUND_INTRO_PACING_MS = ROUND_INTRO_CARD_MS + ROUND_COUNTDOWN_MS;

export function createInitialConquestGameState(
  mapConfig:   ConquestMapConfig,
  players:     ConquestPlayer[],
  totalRounds: number,
): ConquestGameState {
  const safeRounds = Math.max(1, Math.floor(totalRounds));
  const now        = Date.now();
  // `now` doubles as the per-match seed for the controlled-random region
  // allocator. The host computes this once and uploads the result, so the
  // seed itself doesn't need to be persisted or shared with guests.
  const regionStates = createInitialRegionStates(mapConfig, players, now);

  // Seed empty bonus state for every player.  Bonuses only trigger via
  // capture events, so starting ownership never grants them.
  const playerBonuses: Record<string, ConquestPlayerBonusState> = {};
  for (const p of players) playerBonuses[p.id] = createEmptyPlayerBonusState();

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

  return {
    mapId:              mapConfig.id,
    players,
    phase:              "challenge",
    round,
    regionStates,
    history:            [],
    startedAt:          now,
    finishedAt:         null,
    usedChallengeKeys:  [bankId],
    lastChallengeType:  challenge.type as ConquestChallengeType,
    playerBonuses,
    gameIntroEndsAt,
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

  const now = Date.now();
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

  if (!correct) {
    // Wrong answer: record participation only.  Push lets the host see
    // every active player has weighed in, enabling early reveal.
    const next: ConquestGameState = {
      ...state,
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
      round: {
        ...state.round,
        challenge: baseChallengeUpdate,
      },
    };
    return { ok: true, correct: true, firstCorrect: false, winning: false, state: next };
  }

  const submitter = state.players.find(p => p.id === submitterId);
  const now = Date.now();
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

  const now = Date.now();
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

  const now = Date.now();
  const winnerId = state.round.challenge.winnerPlayerId ?? null;

  if (winnerId
    && state.round.challenge.challenge.eligiblePlayerIds.includes(winnerId)
  ) {
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
  const now = Date.now();
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
  // placement above).
  const bonus = getRegionBonus(capturedRegionId);
  if (bonus) {
    switch (bonus.type) {
      case "ankara_hidden_shield":
        // Overwrite-not-stack: already-true stays true.
        pb.pendingHiddenShield = true;
        toast = buildBonusToast("ankara_hidden_shield", ownerId, ownerName, now);
        break;
      case "karadeniz_extra_time":
        // Overwrite-not-stack.
        pb.extraNextMoveMs = KARADENIZ_BONUS_MS;
        toast = buildBonusToast("karadeniz_extra_time", ownerId, ownerName, now);
        break;
      case "cukurova_score":
        if (!pb.cukurovaClaimed) {
          pb.bonusPoints     = pb.bonusPoints + 1;
          pb.cukurovaClaimed = true;
          toast = buildBonusToast("cukurova_score", ownerId, ownerName, now);
        }
        break;
      case "istanbul_defense":
        // Auto-stamp the open shield onto İstanbul itself.  Stacking is
        // implicit: capturing flipOwnership() clears `shielded`, so a player
        // can never accumulate more than one open shield via İstanbul.
        nextRegionStates = nextRegionStates.map(rs =>
          rs.regionId === capturedRegionId
            ? { ...rs, shielded: true }
            : rs,
        );
        toast = buildBonusToast("istanbul_defense", ownerId, ownerName, now);
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
        ok:       true,
        action:   action.type,
        playerId: action.playerId,
        regionId: action.regionId,
        message:  blockMessage,
      };
      return {
        state: {
          ...state,
          phase:        "round_result",
          regionStates: shieldTrigger.regionStates,
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
      const duelState = startDefenseDuel(
        state,
        action.playerId,
        target.ownerPlayerId,
        action.regionId,
        target.shielded === true,
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

  const applied = applyConquestAction(
    mapConfig,
    state.regionStates,
    state.players,
    state.round.roundNumber,
    action,
  );

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
  let postPlayerBonuses = state.playerBonuses;
  let postToast: ConquestBonusToast | undefined;
  if (action.type === "capture_neutral" || action.type === "attack_region") {
    const actorName = state.players.find(p => p.id === action.playerId)?.name ?? "Oyuncu";
    const bonusOut = triggerCaptureBonus(
      postRegionStates,
      postPlayerBonuses,
      action.playerId,
      actorName,
      action.regionId,
      Date.now(),
      action.type === "capture_neutral",
    );
    postRegionStates  = bonusOut.regionStates;
    postPlayerBonuses = bonusOut.playerBonuses;
    postToast         = bonusOut.toast;
  }

  const historyEntry = {
    roundNumber:        state.round.roundNumber,
    challengeWinnerId:  state.round.challenge.winnerPlayerId,
    result:             applied.result,
  };

  // Early finish: one player now owns every region on the map.
  // Only possible after a capture/attack (skip never changes ownership).
  const dominatorId = action.type !== "skip"
    ? getPlayerOwningAllRegions(postRegionStates, mapConfig)
    : null;

  if (dominatorId !== null) {
    const dominator   = state.players.find(p => p.id === dominatorId);
    const domResult: ConquestActionResult = {
      ok:       true,
      action:   applied.result.action,
      playerId: applied.result.playerId,
      regionId: applied.result.regionId,
      message:  `${dominator?.name ?? "Bir oyuncu"} tüm bölgeleri ele geçirdi!`,
    };
    return {
      state: {
        ...state,
        phase:          "finished",
        finishedAt:     Date.now(),
        regionStates:   postRegionStates,
        playerBonuses:  postPlayerBonuses,
        lastBonusToast: postToast ?? state.lastBonusToast,
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
      phase:          "round_result",
      regionStates:   postRegionStates,
      playerBonuses:  postPlayerBonuses,
      lastBonusToast: postToast ?? state.lastBonusToast,
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

  return {
    state: {
      ...state,
      phase:         "round_result",
      regionStates:  nextRegionStates,
      playerBonuses: nextPlayerBonuses,
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
 * "gizli fetih" (any neutral on the map — adjacency is intentionally not
 * required).  Counts as the round's hamle.
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
        phase:         "finished",
        finishedAt:    Date.now(),
        regionStates:  nextRegionStates,
        playerBonuses: nextPlayerBonuses,
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
      phase:         "round_result",
      regionStates:  nextRegionStates,
      playerBonuses: nextPlayerBonuses,
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
  state:        ConquestGameState,
  attackerId:   string,
  defenderId:   string,
  regionId:     ConquestRegionId,
  shieldActive: boolean,
): ConquestGameState {
  const now = Date.now();
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
    endsAt:           questionVisibleAt + DEFENSE_DUEL_MS,
    status:           "active",
    winnerId:         null,
    submittedAnswers: [],
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
  const now = Date.now();

  const attackerName = state.players.find(p => p.id === duel.attackerId)?.name ?? "Saldıran";
  const defenderName = state.players.find(p => p.id === duel.defenderId)?.name ?? "Savunan";
  const regionLabel  = mapConfig.regions.find(r => r.id === duel.regionId)?.displayLabel
                   ?? mapConfig.regions.find(r => r.id === duel.regionId)?.name
                   ?? duel.regionId;

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
  const applied = applyConquestAction(
    mapConfig,
    state.regionStates,
    state.players,
    state.round.roundNumber,
    { type: "attack_region", playerId: duel.attackerId, regionId: duel.regionId },
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

  // Capture-side bonus chain (Ankara/Çukurova/Karadeniz/İstanbul).
  // A duel flip is never a neutral capture, so pendingHiddenShield is not
  // consumed here.  triggerCaptureBonus is a no-op for non-bonus regions.
  const bonusOut = triggerCaptureBonus(
    applied.regionStates,
    state.playerBonuses,
    duel.attackerId,
    attackerName,
    duel.regionId,
    now,
    false,
  );

  const flipResult: ConquestActionResult = {
    ok:       true,
    action:   "attack_region",
    playerId: duel.attackerId,
    regionId: duel.regionId,
    message:  `⚔️ ${attackerName}, düelloda ${regionLabel} bölgesini fethetti.`,
  };

  const base = finishDuelIntoRoundResult(state, flipResult);

  // Domination check — attacker may have just captured the last enemy region.
  const dominatorId = getPlayerOwningAllRegions(bonusOut.regionStates, mapConfig);
  if (dominatorId !== null) {
    const dominator = state.players.find(p => p.id === dominatorId);
    const domResult: ConquestActionResult = {
      ok:       true,
      action:   "attack_region",
      playerId: duel.attackerId,
      regionId: duel.regionId,
      message:  `${dominator?.name ?? "Bir oyuncu"} tüm bölgeleri ele geçirdi!`,
    };
    return {
      ...base,
      phase:          "finished",
      finishedAt:     now,
      regionStates:   bonusOut.regionStates,
      playerBonuses:  bonusOut.playerBonuses,
      lastBonusToast: bonusOut.toast ?? state.lastBonusToast,
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
    regionStates:   bonusOut.regionStates,
    playerBonuses:  bonusOut.playerBonuses,
    lastBonusToast: bonusOut.toast ?? state.lastBonusToast,
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
 */
export function advanceToNextRound(state: ConquestGameState): ConquestGameState {
  if (state.phase !== "round_result") return state;

  const isLast = state.round.roundNumber >= state.round.totalRounds;
  if (isLast) {
    return {
      ...state,
      phase:      "finished",
      finishedAt: Date.now(),
    };
  }

  const nextRoundNumber = state.round.roundNumber + 1;
  const usedSoFar  = state.usedChallengeKeys ?? [];
  const lastType   = state.lastChallengeType;
  const { challenge, bankId } = pickRandomConquestChallenge(
    nextRoundNumber,
    state.players,
    usedSoFar,
    lastType,
  );
  const now = Date.now();

  return {
    ...state,
    phase:             "challenge",
    usedChallengeKeys: [...usedSoFar, bankId],
    lastChallengeType: challenge.type as ConquestChallengeType,
    /* Clear the bonus toast so a fresh round doesn't echo the previous
     * round's banner on late-joining clients. */
    lastBonusToast:    undefined,
    round: {
      roundNumber:    nextRoundNumber,
      totalRounds:    state.round.totalRounds,
      challenge:      buildActiveChallengeState(challenge, now + ROUND_INTRO_PACING_MS),
      actionHolderId: null,
      lastResult:     null,
    },
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
  const rows = state.players.map(p => ({
    playerId:    p.id,
    playerName:  p.name,
    regionsHeld: counts[p.id] ?? 0,
    points:      points[p.id] ?? 0,
  }));
  // Primary sort: points (desc). Tiebreak: region count (desc).
  rows.sort((a, b) => (b.points - a.points) || (b.regionsHeld - a.regionsHeld));

  const out: ConquestFinalStanding[] = [];
  let lastKey: string | null = null;
  let lastRank               = 0;
  rows.forEach((r, i) => {
    const key = `${r.points}|${r.regionsHeld}`;
    let rank: number;
    if (lastKey !== null && key === lastKey) {
      rank = lastRank;
    } else {
      rank = i + 1;
      lastRank = rank;
      lastKey  = key;
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
 * every region they own AND every neutral region on the map (no adjacency
 * required) is also a legal click target — clicking own places a gizli kalkan,
 * clicking neutral places a gizli fetih.  Both count as the round's move (see
 * `placeHiddenShieldOnOwnRegion` / `placeHiddenConquestOnNeutralRegion`).
 * Enemy-owned regions are never added by the bonus path (no shielding
 * opponents' regions per spec).
 */
export function getCurrentLegalTargets(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
): Set<ConquestRegionId> {
  if (state.phase !== "action" || !state.round.actionHolderId) {
    return new Set();
  }
  const holderId = state.round.actionHolderId;
  const targets = getAllLegalTargetsForPlayer(
    mapConfig,
    state.regionStates,
    holderId,
  );
  const pb = state.playerBonuses?.[holderId];
  if (pb?.pendingHiddenShield) {
    for (const rs of state.regionStates) {
      if (rs.ownerPlayerId === holderId || rs.ownerPlayerId === null) {
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
 * A holder with `pendingHiddenShield` is never stuck so long as the map
 * still has either at least one region they own OR at least one neutral
 * region — both are valid trap/shield placement targets.
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
    const anyNeutral = state.regionStates.some(rs => rs.ownerPlayerId === null);
    if (ownsAny || anyNeutral) return false;
  }
  const legal = getLegalActionsForPlayer(
    mapConfig,
    state.regionStates,
    holderId,
  );
  // skip is always present; "no moves" means skip is the only legal action.
  return legal.length === 1 && legal[0] === "skip";
}
