/**
 * Conquest (Kuşatma) — challenge catalog and factories.
 *
 * Phase-9A: the first three real challenge families ship — quiz, type_race,
 * and flag_guess.  `pickRandomConquestChallenge` is the single entry point
 * used by gameplay transitions; everything else (the bank, validation) is
 * folded behind it.  The legacy `createPlaceholderChallenge` is retained
 * for any future debug path but is no longer wired into the live loop.
 *
 * The host (writer client) calls the picker once per round and stores the
 * resulting ConquestChallenge inside `gameplay_state.round.challenge`; every
 * other client renders that stored payload — they never roll their own.
 *
 * No React, no Supabase — pure data + pure functions.
 */

import {
  pickFlagGuessBankEntry,
  pickQuizBankEntry,
  pickTypeRaceBankEntry,
  type FlagGuessBankEntry,
  type QuizBankEntry,
  type TypeRaceBankEntry,
} from "./conquestChallengeBank";
import type {
  ConquestChallenge,
  ConquestChallengeType,
  ConquestPlayer,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a challenge stays open before the host expires it.  All clients
 * render the same countdown from the synced `endsAt` so timing is in lockstep
 * within network jitter; the host alone fires the actual expiry write.
 */
export const CONQUEST_CHALLENGE_DURATION_MS = 20_000;

/**
 * How long the "reveal" sub-phase stays on screen after the challenge timer
 * ends.  During reveal the correct answer + first-correct player are shown
 * to every client; the host then transitions to the action (or round_result)
 * phase.  Tuned to feel snappy on mobile without flashing past too fast.
 */
export const CONQUEST_REVEAL_DURATION_MS = 3_000;

// ─────────────────────────────────────────────────────────────────────────────
// Type metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface ConquestChallengeTypeMeta {
  type:         ConquestChallengeType;
  /** Short TR label shown on the challenge panel chip. */
  label:        string;
  /** One-line TR description for tooltips / settings copy. */
  description:  string;
  /** Decorative emoji used in chips. */
  icon:         string;
  /** False = the challenge family is declared but not yet playable. */
  implemented:  boolean;
}

export const CONQUEST_CHALLENGE_META: Record<
  ConquestChallengeType,
  ConquestChallengeTypeMeta
> = {
  quiz: {
    type:        "quiz",
    label:       "Bilgi Sorusu",
    description: "Coğrafya sorusu — en hızlı doğru cevap kazanır.",
    icon:        "❓",
    implemented: true,
  },
  map_click: {
    type:        "map_click",
    label:       "Harita Tıklama",
    description: "Verilen yeri haritada en hızlı işaretle.",
    icon:        "🎯",
    implemented: false,
  },
  type_race: {
    type:        "type_race",
    label:       "Ülke Yaz",
    description: "Verilen kurala uyan bir ülke adını ilk yazan kazanır.",
    icon:        "⌨️",
    implemented: true,
  },
  flag_guess: {
    type:        "flag_guess",
    label:       "Bayrak Tahmini",
    description: "Bayraktan ülkeyi tahmin et.",
    icon:        "🚩",
    implemented: true,
  },
  neighbor_question: {
    type:        "neighbor_question",
    label:       "Komşu Sorusu",
    description: "Bir ülkenin komşularını say.",
    icon:        "🧭",
    implemented: false,
  },
  placeholder: {
    type:        "placeholder",
    label:       "Mücadele",
    description: "Test mücadelesi — kazananı seç ve hamleyi dene.",
    icon:        "⚔️",
    implemented: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Id helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic-ish challenge id from round + type + a short random
 * suffix.  Stable within a single mounted challenge (the host writes it once
 * and every client reads the same value); unique within a match so React
 * keys never collide if a player retries a round.
 */
export function buildConquestChallengeId(
  roundNumber: number,
  type:        ConquestChallengeType,
): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `r${roundNumber}-${type}-${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeded shuffle — used to randomise quiz choice order per challenge
//
// Why seeded:  the shuffle has to be stable per ConquestChallenge instance so
// every client that deserialises the same gameplay_state row renders the same
// option order.  Sync isn't broken by Math.random on the host (the result is
// persisted into challenge.choices), but a seeded shuffle keyed by the id
// makes the behaviour debuggable and test-friendly (same id → same order,
// different id → different order).
//
// Answer validation never touches indices — `isChallengeAnswerCorrect`
// compares the raw text against `challenge.acceptedAnswers`, so a shuffled
// `choices` array is always safe.
// ─────────────────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit hash of a string. */
function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — short, fast, good enough for shuffles. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stable Fisher–Yates shuffle.  Same `seed` → same permutation; different
 * seeds → different permutations (with very high probability for small N).
 *
 * Exported for the dev distribution test in scripts/.
 */
export function shuffleWithSeed<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice();
  const rng = mulberry32(seedFromString(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factories — one per real challenge family
// ─────────────────────────────────────────────────────────────────────────────

function eligibleIds(players: ConquestPlayer[]): string[] {
  return players.map(p => p.id);
}

function buildQuizChallenge(
  roundNumber: number,
  players:     ConquestPlayer[],
  entry:       QuizBankEntry,
): ConquestChallenge {
  const id = buildConquestChallengeId(roundNumber, "quiz");
  // Bank entries list the correct answer first by convention.  Shuffle the
  // visible order per challenge instance so A/B/C/D positions are randomised;
  // the seed is the challenge id, which is stable in the persisted gameplay
  // state, so every client renders the same order.  Answer validation runs
  // against `acceptedAnswers` (see conquestChallengeValidation), never index.
  const choices = entry.choices && entry.choices.length > 0
    ? shuffleWithSeed(entry.choices, `${id}|${entry.id}`)
    : undefined;
  return {
    id,
    type:              "quiz",
    roundNumber,
    title:             "Bilgi Sorusu",
    prompt:            entry.prompt,
    eligiblePlayerIds: eligibleIds(players),
    choices,
    acceptedAnswers:   entry.acceptedAnswers,
  };
}

function buildTypeRaceChallenge(
  roundNumber: number,
  players:     ConquestPlayer[],
  entry:       TypeRaceBankEntry,
): ConquestChallenge {
  return {
    id:                buildConquestChallengeId(roundNumber, "type_race"),
    type:              "type_race",
    roundNumber,
    title:             "Ülke Yaz",
    prompt:            entry.prompt,
    eligiblePlayerIds: eligibleIds(players),
    acceptedAnswers:   entry.acceptedAnswers,
  };
}

function buildFlagGuessChallenge(
  roundNumber: number,
  players:     ConquestPlayer[],
  entry:       FlagGuessBankEntry,
): ConquestChallenge {
  return {
    id:                buildConquestChallengeId(roundNumber, "flag_guess"),
    type:              "flag_guess",
    roundNumber,
    title:             "Bayrak Tahmini",
    prompt:            "Bu bayrak hangi ülkeye ait?",
    eligiblePlayerIds: eligibleIds(players),
    flag:              entry.flag,
    acceptedAnswers:   entry.acceptedAnswers,
  };
}

export interface PickedChallenge {
  challenge: ConquestChallenge;
  /** Stable bank entry id — tracked in gameplay_state to prevent repeats. */
  bankId:    string;
}

/**
 * Pick a challenge for the next round.
 *
 * - `usedBankIds`  : bank entry ids already used this match; excluded from
 *                    the pool so the same question never repeats unless the
 *                    bank is exhausted.
 * - `lastType`     : the challenge type shown in the previous round; avoided
 *                    (when alternatives exist) so the same format does not
 *                    appear consecutively.
 *
 * Called exactly once per round by the host; the returned challenge is stored
 * in gameplay_state so every other client renders the identical payload.
 */
export function pickRandomConquestChallenge(
  roundNumber:  number,
  players:      ConquestPlayer[],
  usedBankIds:  string[] = [],
  lastType?:    ConquestChallengeType,
): PickedChallenge {
  const allTypes: ConquestChallengeType[] = ["quiz", "type_race", "flag_guess"];
  // Avoid repeating the last challenge type when alternatives are available.
  const typePool = lastType
    ? allTypes.filter(t => t !== lastType)
    : allTypes;
  const candidateTypes = typePool.length > 0 ? typePool : allTypes;
  const type = candidateTypes[Math.floor(Math.random() * candidateTypes.length)];

  switch (type) {
    case "quiz": {
      const { entry, id } = pickQuizBankEntry(usedBankIds);
      return { challenge: buildQuizChallenge(roundNumber, players, entry), bankId: id };
    }
    case "type_race": {
      const { entry, id } = pickTypeRaceBankEntry(usedBankIds);
      return { challenge: buildTypeRaceChallenge(roundNumber, players, entry), bankId: id };
    }
    case "flag_guess": {
      const { entry, id } = pickFlagGuessBankEntry(usedBankIds);
      return { challenge: buildFlagGuessChallenge(roundNumber, players, entry), bankId: id };
    }
    default: {
      const { entry, id } = pickQuizBankEntry(usedBankIds);
      return { challenge: buildQuizChallenge(roundNumber, players, entry), bankId: id };
    }
  }
}

/**
 * Legacy placeholder challenge — retained for any future debug surface.
 * Not used by the live loop as of Phase 9A.
 */
export function createPlaceholderChallenge(
  roundNumber: number,
  players:     ConquestPlayer[],
): ConquestChallenge {
  return {
    id:                buildConquestChallengeId(roundNumber, "placeholder"),
    type:              "placeholder",
    roundNumber,
    title:             "Mücadele",
    prompt:            "Kazananı seç — kazanan bu turun hamle hakkını alır.",
    eligiblePlayerIds: eligibleIds(players),
  };
}
