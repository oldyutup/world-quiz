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
  return {
    id:                buildConquestChallengeId(roundNumber, "quiz"),
    type:              "quiz",
    roundNumber,
    title:             "Bilgi Sorusu",
    prompt:            entry.prompt,
    eligiblePlayerIds: eligibleIds(players),
    choices:           entry.choices,
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
