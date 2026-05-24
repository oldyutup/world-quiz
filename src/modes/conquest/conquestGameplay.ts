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
  pickRandomConquestChallenge,
} from "./conquestChallenges";
import { isChallengeAnswerCorrect } from "./conquestChallengeValidation";
import { createInitialRegionStates } from "./conquestState";
import { getPlayerRegionPoints } from "./regionPoints";
import type {
  ConquestActionResult,
  ConquestChallenge,
  ConquestChallengeAnswer,
  ConquestChallengeState,
  ConquestChallengeType,
  ConquestFinalStanding,
  ConquestGameState,
  ConquestMapConfig,
  ConquestPendingAction,
  ConquestPlayer,
  ConquestRegionId,
  ConquestRegionState,
  ConquestRoundState,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the initial ConquestGameState for a brand-new match.
 *
 *  - Distributes regions evenly via createInitialRegionStates (round-robin,
 *    leftovers neutral)
 *  - Mounts the round-1 placeholder challenge in `active` status
 *  - Phase starts at `challenge` so the UI shows the challenge panel
 *    immediately; the `setup` phase is reserved for any future async
 *    preparation step (deal animation, ready-up, etc.).
 *
 * `totalRounds` is clamped to >=1 to keep downstream math safe.
 */
export function createInitialConquestGameState(
  mapConfig:   ConquestMapConfig,
  players:     ConquestPlayer[],
  totalRounds: number,
): ConquestGameState {
  const safeRounds = Math.max(1, Math.floor(totalRounds));
  const now        = Date.now();
  const regionStates = createInitialRegionStates(mapConfig, players);

  const { challenge, bankId } = pickRandomConquestChallenge(1, players, [], undefined);

  const round: ConquestRoundState = {
    roundNumber:    1,
    totalRounds:    safeRounds,
    challenge:      buildActiveChallengeState(challenge, now),
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
    status:           "active",
    winnerPlayerId:   null,
    startedAt:        now,
    endsAt:           now + CONQUEST_CHALLENGE_DURATION_MS,
    submittedAnswers: [],
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

  return {
    ...state,
    phase: "action",
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
      actionHolderId: winnerId,
    },
  };
}

/**
 * Validate `rawAnswer` against the active challenge for `submitterId`.
 *
 * Returns `{ ok: true, state, winning: true }` if the answer is correct and
 * resolves the challenge; `{ ok: true, winning: false }` if the answer is
 * wrong (state unchanged — caller surfaces "Yanlış cevap." locally);
 * `{ ok: false }` if the submission is illegal (phase wrong, challenge not
 * active, submitter not eligible).
 *
 * This is the single funnel ConquestGame uses for player-typed submissions.
 * It does NOT enforce one-answer-per-player — that's a client-local
 * convenience to avoid write races on wrong attempts.
 */
export interface SubmitAnswerResult {
  ok:       boolean;
  winning:  boolean;
  state:    ConquestGameState;
}

export function submitChallengeAnswer(
  state:       ConquestGameState,
  submitterId: string,
  rawAnswer:   string,
): SubmitAnswerResult {
  if (state.phase !== "challenge") {
    return { ok: false, winning: false, state };
  }
  if (state.round.challenge.status !== "active") {
    return { ok: false, winning: false, state };
  }
  const challenge = state.round.challenge.challenge;
  if (!challenge.eligiblePlayerIds.includes(submitterId)) {
    return { ok: false, winning: false, state };
  }

  const correct = isChallengeAnswerCorrect(challenge, rawAnswer);
  if (!correct) {
    return { ok: true, winning: false, state };
  }

  const submitter = state.players.find(p => p.id === submitterId);
  const next = resolveChallengeWithWinner(state, submitterId, {
    text:       rawAnswer,
    playerName: submitter?.name ?? "Oyuncu",
  });
  return { ok: true, winning: true, state: next };
}

/**
 * Mark the active challenge as expired (timer hit zero with no winner).
 * Distinct from `skipChallenge` only in messaging — both routes leave the
 * round resultless and ready to advance.  Idempotent: returns the state
 * unchanged if the challenge is already resolved/skipped or the phase has
 * moved on.
 *
 * Host-only writer in the live loop (see ConquestGame.tsx) to keep the
 * timeout authoritative and avoid two clients racing to expire.
 */
export function expireChallenge(state: ConquestGameState): ConquestGameState {
  if (state.phase !== "challenge") return state;
  if (state.round.challenge.status !== "active") return state;

  const now = Date.now();
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
      challenge: {
        ...state.round.challenge,
        status:     "skipped",
        resolvedAt: now,
      },
      actionHolderId: null,
      lastResult:     expiredResult,
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

  const historyEntry = {
    roundNumber:        state.round.roundNumber,
    challengeWinnerId:  state.round.challenge.winnerPlayerId,
    result:             applied.result,
  };

  // Early finish: one player now owns every region on the map.
  // Only possible after a capture/attack (skip never changes ownership).
  const dominatorId = action.type !== "skip"
    ? getPlayerOwningAllRegions(applied.regionStates, mapConfig)
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
        phase:        "finished",
        finishedAt:   Date.now(),
        regionStates: applied.regionStates,
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
      phase:        "round_result",
      regionStates: applied.regionStates,
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
    round: {
      roundNumber:    nextRoundNumber,
      totalRounds:    state.round.totalRounds,
      challenge:      buildActiveChallengeState(challenge, now),
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
  const points = getPlayerRegionPoints(state.players, state.regionStates);
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
 */
export function getCurrentLegalTargets(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
): Set<ConquestRegionId> {
  if (state.phase !== "action" || !state.round.actionHolderId) {
    return new Set();
  }
  return getAllLegalTargetsForPlayer(
    mapConfig,
    state.regionStates,
    state.round.actionHolderId,
  );
}

/**
 * True if the action holder has *no* legal map move (capture or attack).
 * UI uses this to auto-offer / auto-trigger the skip path so the loop
 * doesn't dead-end.
 */
export function actionHolderHasNoMoves(
  state:     ConquestGameState,
  mapConfig: ConquestMapConfig,
): boolean {
  if (state.phase !== "action" || !state.round.actionHolderId) return false;
  const legal = getLegalActionsForPlayer(
    mapConfig,
    state.regionStates,
    state.round.actionHolderId,
  );
  // skip is always present; "no moves" means skip is the only legal action.
  return legal.length === 1 && legal[0] === "skip";
}
