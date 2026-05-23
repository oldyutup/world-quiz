/**
 * Conquest (Kuşatma) — challenge catalog and factories.
 *
 * Phase-6 scope: type metadata for every planned challenge family + a single
 * implemented placeholder factory.  Real minigames (quiz, map_click, type_race
 * …) plug in here later by adding a factory and flipping `implemented:true`
 * in CONQUEST_CHALLENGE_META.  No factory is consumed outside this file, so
 * new types can be added without ripple changes.
 *
 * No React, no Supabase — pure data + pure functions.
 */

import type {
  ConquestChallenge,
  ConquestChallengeType,
  ConquestPlayer,
} from "./types";

/**
 * Static descriptor for one challenge family.  Used by the UI to render
 * a "type" label and by future code to gate selection on implemented status.
 */
export interface ConquestChallengeTypeMeta {
  type:         ConquestChallengeType;
  /** Short TR label shown on the challenge panel ("Hızlı Soru"). */
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
    label:       "Bilgi Yarışı",
    description: "Coğrafya sorusu — en hızlı doğru cevap kazanır.",
    icon:        "❓",
    implemented: false,
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
    label:       "Yazma Yarışı",
    description: "Ülke adını ilk doğru yazan kazanır.",
    icon:        "⌨️",
    implemented: false,
  },
  flag_guess: {
    type:        "flag_guess",
    label:       "Bayrak Bil",
    description: "Bayraktan ülkeyi tahmin et.",
    icon:        "🚩",
    implemented: false,
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

/**
 * Build a deterministic challenge id from a round number and type.  Stable
 * across re-renders so React keys behave; unique within a single match.
 */
export function buildConquestChallengeId(
  roundNumber: number,
  type:        ConquestChallengeType,
): string {
  return `r${roundNumber}-${type}`;
}

/**
 * Create the placeholder "Mücadele" challenge for a round.
 *
 * Every active player is eligible.  The challenge is "active" the moment it
 * is created; resolution happens via `resolveChallengeWithWinner` in
 * `conquestGameplay.ts` (typically driven by the local viewer clicking
 * a "Kazananı seç" button — see ConquestChallengePanel).
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
    eligiblePlayerIds: players.map(p => p.id),
  };
}
