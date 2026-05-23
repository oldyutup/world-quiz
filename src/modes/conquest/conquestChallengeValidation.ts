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

/**
 * Collapse a raw user-entered string into the canonical comparison form.
 * Idempotent: normaliseAnswer(normaliseAnswer(s)) === normaliseAnswer(s).
 *
 * Exported so tests / future server-side validation can share the exact
 * same rule set.  Keep this in sync with the answer set in
 * conquestChallengeBank.ts — the bank entries are normalised on read.
 */
export function normaliseAnswer(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase().trim();
  // Normalise Turkish capital İ first (its toLowerCase result varies by env).
  s = s
    .replace(/i̇/g, "i")  // U+0069 + combining dot, occasionally produced
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/û/g, "u");
  // Collapse whitespace runs to a single space.
  s = s.replace(/\s+/g, " ");
  return s;
}

/**
 * True iff `raw` matches any entry in the challenge's acceptedAnswers list
 * after normalisation.  Returns false for empty input or challenges that
 * carry no accepted-answer list (e.g. the legacy placeholder).
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
    if (normaliseAnswer(accepted) === candidate) return true;
  }
  return false;
}
