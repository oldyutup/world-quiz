/**
 * Conquest (Kuşatma) — Phase 9A answer validation.
 *
 * Pure helpers for turning a player's free-text answer into a yes/no
 * decision against a challenge's acceptedAnswers list.
 *
 * Normalisation rules (locale: TR):
 *   - lowercase
 *   - trim + collapse internal whitespace
 *   - diacritic tolerance:  ı↔i, ş↔s, ğ↔g, ü↔u, ö↔o, ç↔c
 *   - capital İ/I both collapse to "i"
 *
 * Diacritic tolerance is *one-way*: every glyph is mapped to its plain ASCII
 * counterpart on both sides of the comparison, so "İspanya" / "Ispanya" /
 * "ispanya" all collapse to "ispanya".  This is deliberately permissive —
 * the prototype prioritises forgiving typing over strict orthography.
 *
 * No React, no Supabase — pure functions only.
 */

import type { ConquestChallenge } from "./types";
import { normalizeCountryAnswer, areCountryAnswersEquivalent } from "../../data/countries";

/**
 * Collapse a raw user-entered string into the canonical comparison form.
 *
 * Delegates to the central `normalizeCountryAnswer` so every Conquest
 * answer obeys the same rules as Flag/Map/Silhouette modes:
 * Unicode NFD, diacritic stripping, Turkish-letter folding, punctuation
 * tolerance, whitespace collapse. Idempotent.
 */
export function normaliseAnswer(raw: string): string {
  return normalizeCountryAnswer(raw);
}

/**
 * True iff `raw` matches any entry in the challenge's acceptedAnswers list.
 *
 * Uses `areCountryAnswersEquivalent` so that when an acceptedAnswer is a
 * country name (e.g. "Türkiye"), every alias of that country (Turkey,
 * TÜRKİYE, turkiye, …) is accepted automatically. For non-country answers
 * (capitals, mountains, …) it falls back to normalised string equality.
 */
export function isChallengeAnswerCorrect(
  challenge: ConquestChallenge,
  raw:       string,
): boolean {
  if (!challenge.acceptedAnswers || challenge.acceptedAnswers.length === 0) {
    return false;
  }
  const candidate = normaliseAnswer(raw);
  if (!candidate) return false;
  for (const accepted of challenge.acceptedAnswers) {
    if (areCountryAnswersEquivalent(raw, accepted)) return true;
  }
  return false;
}
