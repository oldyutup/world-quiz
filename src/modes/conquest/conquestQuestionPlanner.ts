/**
 * Conquest (Kuşatma) — deterministic per-match question planner.
 *
 * Why this exists
 * ───────────────
 * The legacy `pickRandomConquestChallenge` rolled a fresh challenge type every
 * round with `Math.random`, so:
 *   • the test/write mix drifted (sometimes a match was mostly "Ülke Yaz"),
 *   • the same *family* could appear back-to-back ("A ile başlayan ülke" then
 *     "B ile başlayan ülke"),
 *   • there was no single, reproducible plan shared across clients.
 *
 * This module builds the **entire** ordered question plan once, up front, from
 * a numeric match seed (the host's `startedAt`).  The host uploads the plan in
 * `gameplay_state.questionPlan`, so every client renders the identical
 * sequence — multiplayer sync is preserved exactly as before (only the host
 * ever picks).  Being a pure function of the seed also makes the rules unit
 * testable (see scripts/check-conquest-question-planner.ts).
 *
 * Guarantees
 * ──────────
 *   1. Test-dominant ratio:  testRounds = ceil(totalRounds * 0.60)
 *      → 6 rounds = 4 test / 2 write, 8 = 5 / 3, 10 = 6 / 4.
 *   2. Write rounds are spread evenly (never two writes adjacent).
 *   3. No two consecutive rounds share a `family` (when alternatives exist).
 *   4. No exact question (bankId) repeats within a match.
 *   5. No target answer repeats within a match (so the same country/capital is
 *      never the answer twice).
 *   6. "X harfiyle başlayan ülke" never reuses a letter (and never appears in
 *      consecutive rounds — covered by rule 3).
 *   7. Same country avoided across rounds where structured data allows (soft).
 *
 * No React, no Supabase — pure data + pure functions.
 */

import {
  CONQUEST_QUIZ_BANK,
  CONQUEST_TYPE_RACE_BANK,
  CONQUEST_FLAG_GUESS_BANK,
  type QuizBankEntry,
  type TypeRaceBankEntry,
  type FlagGuessBankEntry,
} from "./conquestChallengeBank";
import { shuffleWithSeed } from "./conquestChallenges";
import { normaliseAnswer } from "./conquestChallengeValidation";
import type {
  ConquestChallenge,
  ConquestAnswerMode,
  ConquestGameState,
  ConquestPlayer,
  ConquestQuestionFamily,
  ConquestQuestionDifficulty,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Seeded RNG (mirrors conquestChallenges.ts; kept local to avoid widening that
// module's public surface).  FNV-1a hash + Mulberry32 — stable across runs.
// ─────────────────────────────────────────────────────────────────────────────

function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Short, stable, URL-safe hash used for deterministic challenge ids. */
function shortHash(s: string): string {
  return (seedFromString(s) >>> 0).toString(36).slice(0, 6);
}

function makeChallengeId(
  roundNumber: number,
  type:        ConquestChallenge["type"],
  idSeed:      string,
): string {
  return `r${roundNumber}-${type}-${shortHash(`${idSeed}|${type}|${roundNumber}`)}`;
}

// Family classification is now authored per bank entry (entry.family /
// entry.letter / entry.difficulty) rather than derived from id ranges — see
// conquestChallengeBank.ts.  The planner only mints challenges from that
// metadata; it never guesses a family.

// ─────────────────────────────────────────────────────────────────────────────
// Generated test families — built from already-verified project data, never
// from speculative facts.  These are distinct *question shapes*, not "the same
// question with the country swapped".
// ─────────────────────────────────────────────────────────────────────────────

/** Curated capital → country pairs (verified, well-known).  Continent powers
 *  same-continent distractors.  Source of the `capital_to_country_mc` family,
 *  which has no equivalent in the hand-authored quiz bank (which only ever
 *  asks country → capital). */
interface CapitalPair {
  country:   string;
  capital:   string;
  continent: "europe" | "asia" | "africa" | "americas" | "oceania";
  aliases?:  string[];
}

// NOTE: these countries are intentionally disjoint from the quiz bank's
// `country_to_capital_mc` set (Türkiye, Fransa, Japonya, İtalya, Almanya,
// İspanya, Rusya, Mısır, ABD, Çin, İngiltere, Yunanistan, Hindistan, Kanada),
// so a single match can never ask both directions of the same capital.  Kept
// small on purpose — capital questions are a minority of the test pool.
const CAPITAL_PAIRS: CapitalPair[] = [
  // Europe
  { country: "Portekiz",   capital: "Lizbon",       continent: "europe",   aliases: ["Portugal"] },
  { country: "Hollanda",   capital: "Amsterdam",    continent: "europe",   aliases: ["Netherlands"] },
  { country: "İsveç",      capital: "Stockholm",    continent: "europe",   aliases: ["Sweden", "Isvec"] },
  { country: "Norveç",     capital: "Oslo",         continent: "europe",   aliases: ["Norway", "Norvec"] },
  { country: "Avusturya",  capital: "Viyana",       continent: "europe",   aliases: ["Austria", "Wien", "Vienna"] },
  { country: "Polonya",    capital: "Varşova",      continent: "europe",   aliases: ["Poland", "Varsova", "Warszawa", "Warsaw"] },
  // Asia
  { country: "Tayland",    capital: "Bangkok",      continent: "asia",     aliases: ["Thailand"] },
  { country: "Güney Kore", capital: "Seul",         continent: "asia",     aliases: ["South Korea", "Guney Kore", "Kore", "Seoul"] },
  // Africa
  { country: "Kenya",      capital: "Nairobi",      continent: "africa",   aliases: ["Kenya"] },
  { country: "Fas",        capital: "Rabat",        continent: "africa",   aliases: ["Morocco"] },
  // Americas
  { country: "Brezilya",   capital: "Brasília",     continent: "americas", aliases: ["Brazil", "Brasilia"] },
  { country: "Arjantin",   capital: "Buenos Aires", continent: "americas", aliases: ["Argentina"] },
  { country: "Peru",       capital: "Lima",         continent: "americas", aliases: ["Peru"] },
  // Oceania
  { country: "Avustralya", capital: "Canberra",     continent: "oceania",  aliases: ["Australia"] },
];

/** Pick `n` distinct distractor strings ≠ `correct`, preferring `samePool`
 *  then topping up from `globalPool`.  Deterministic via `seedKey`. */
function pickDistractors(
  correct:    string,
  samePool:   string[],
  globalPool: string[],
  n:          number,
  seedKey:    string,
): string[] {
  const correctNorm = normaliseAnswer(correct);
  const seen = new Set<string>([correctNorm]);
  const out: string[] = [];
  const drain = (pool: string[], salt: string) => {
    for (const c of shuffleWithSeed(pool, `${seedKey}|${salt}`)) {
      if (out.length >= n) break;
      const key = normaliseAnswer(c);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  };
  drain(samePool, "same");
  if (out.length < n) drain(globalPool, "global");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Planned-question universe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One selectable question.  `build` mints a concrete, sync-safe
 * `ConquestChallenge` for a specific round with a deterministic id and a
 * per-instance shuffled choice order.
 */
export interface PlannedQuestion {
  bankId:     string;
  answerMode: ConquestAnswerMode;
  family:     ConquestQuestionFamily;
  /** Content difficulty — carried through for the content-balance check. */
  difficulty: ConquestQuestionDifficulty;
  /** Set only for "X harfiyle başlayan ülke" — drives letter anti-repetition. */
  letter?:    string;
  /** Normalised canonical answer — drives target anti-repetition.  Omitted for
   *  open-ended families (letter / criteria) that accept many countries. */
  targetKey?: string;
  /** Normalised country involved — best-effort same-country avoidance. */
  countryKey?: string;
  build: (
    roundNumber: number,
    players:     ConquestPlayer[],
    idSeed:      string,
  ) => ConquestChallenge;
}

const allPlayerIds = (players: ConquestPlayer[]): string[] => players.map((p) => p.id);

function plannedFromQuiz(entry: QuizBankEntry): PlannedQuestion {
  const family = entry.family;
  return {
    bankId:     entry.id,
    answerMode: "test",
    family,
    difficulty: entry.difficulty,
    targetKey:  entry.acceptedAnswers[0] ? normaliseAnswer(entry.acceptedAnswers[0]) : undefined,
    build: (roundNumber, players, idSeed) => {
      const id = makeChallengeId(roundNumber, "quiz", `${idSeed}|${entry.id}`);
      const choices = entry.choices && entry.choices.length > 0
        ? shuffleWithSeed(entry.choices, `${id}|${entry.id}`)
        : undefined;
      return {
        id,
        type:              "quiz",
        roundNumber,
        title:             "Bilgi Sorusu",
        prompt:            entry.prompt,
        eligiblePlayerIds: allPlayerIds(players),
        choices,
        acceptedAnswers:   entry.acceptedAnswers,
        answerMode:        "test",
        family,
      };
    },
  };
}

function plannedFromTypeRace(entry: TypeRaceBankEntry): PlannedQuestion {
  return {
    bankId:     entry.id,
    answerMode: "write",
    family:     entry.family,
    difficulty: entry.difficulty,
    letter:     entry.letter,
    // Open-ended: many countries are valid, so there is no single target to dedupe.
    build: (roundNumber, players, idSeed) => ({
      id:                makeChallengeId(roundNumber, "type_race", `${idSeed}|${entry.id}`),
      type:              "type_race",
      roundNumber,
      title:             "Ülke Yaz",
      prompt:            entry.prompt,
      eligiblePlayerIds: allPlayerIds(players),
      acceptedAnswers:   entry.acceptedAnswers,
      answerMode:        "write",
      family:            entry.family,
    }),
  };
}

function plannedFromFlagGuess(entry: FlagGuessBankEntry): PlannedQuestion {
  const correct = entry.acceptedAnswers[0];
  return {
    bankId:     entry.id,
    answerMode: "write",
    family:     "flag_to_country_text",
    difficulty: entry.difficulty,
    targetKey:  correct ? normaliseAnswer(correct) : undefined,
    countryKey: correct ? normaliseAnswer(correct) : undefined,
    build: (roundNumber, players, idSeed) => ({
      id:                makeChallengeId(roundNumber, "flag_guess", `${idSeed}|${entry.id}`),
      type:              "flag_guess",
      roundNumber,
      title:             "Bayrak Tahmini",
      prompt:            "Bu bayrak hangi ülkeye ait?",
      eligiblePlayerIds: allPlayerIds(players),
      flag:              entry.flag,
      acceptedAnswers:   entry.acceptedAnswers,
      answerMode:        "write",
      family:            "flag_to_country_text",
    }),
  };
}

/** flag → country, multiple choice.  Generated from the (verified, rendering)
 *  flag-guess bank by adding three country-name distractors. */
function buildFlagMcPool(): PlannedQuestion[] {
  const allNames = CONQUEST_FLAG_GUESS_BANK.map((e) => e.acceptedAnswers[0]);
  return CONQUEST_FLAG_GUESS_BANK.map((entry) => {
    const correct = entry.acceptedAnswers[0];
    const distractors = pickDistractors(correct, allNames, allNames, 3, `flagmc|${entry.id}`);
    const choices = [correct, ...distractors];
    return {
      bankId:     `flagmc_${entry.id}`,
      answerMode: "test" as const,
      family:     "flag_to_country_mc" as const,
      difficulty: entry.difficulty,
      targetKey:  normaliseAnswer(correct),
      countryKey: normaliseAnswer(correct),
      build: (roundNumber, players, idSeed) => {
        const id = makeChallengeId(roundNumber, "quiz", `${idSeed}|flagmc_${entry.id}`);
        return {
          id,
          type:              "quiz",
          roundNumber,
          title:             "Bayraktan Ülke",
          prompt:            "Bu bayrak hangi ülkeye ait?",
          eligiblePlayerIds: allPlayerIds(players),
          flag:              entry.flag,
          choices:           shuffleWithSeed(choices, `${id}|flagmc_${entry.id}`),
          acceptedAnswers:   entry.acceptedAnswers,
          answerMode:        "test",
          family:            "flag_to_country_mc",
        };
      },
    };
  });
}

/** capital → country, multiple choice.  Generated from CAPITAL_PAIRS. */
function buildCapitalMcPool(): PlannedQuestion[] {
  const namesByContinent = new Map<string, string[]>();
  for (const p of CAPITAL_PAIRS) {
    const arr = namesByContinent.get(p.continent) ?? [];
    arr.push(p.country);
    namesByContinent.set(p.continent, arr);
  }
  const allNames = CAPITAL_PAIRS.map((p) => p.country);

  return CAPITAL_PAIRS.map((pair) => {
    const bankId = `capmc_${normaliseAnswer(pair.capital).replace(/\s+/g, "_")}`;
    const distractors = pickDistractors(
      pair.country,
      namesByContinent.get(pair.continent) ?? [],
      allNames,
      3,
      `capmc|${bankId}`,
    );
    const choices = [pair.country, ...distractors];
    const accepted = [pair.country, ...(pair.aliases ?? [])];
    return {
      bankId,
      answerMode: "test" as const,
      family:     "capital_to_country_mc" as const,
      // Curated, very well-known capitals → kept at the easy tier.
      difficulty: "easy" as const,
      targetKey:  normaliseAnswer(pair.country),
      countryKey: normaliseAnswer(pair.country),
      build: (roundNumber, players, idSeed) => {
        const id = makeChallengeId(roundNumber, "quiz", `${idSeed}|${bankId}`);
        return {
          id,
          type:              "quiz",
          roundNumber,
          title:             "Başkentin Ülkesi",
          prompt:            `${pair.capital} hangi ülkenin başkentidir?`,
          eligiblePlayerIds: allPlayerIds(players),
          choices:           shuffleWithSeed(choices, `${id}|${bankId}`),
          acceptedAnswers:   accepted,
          answerMode:        "test",
          family:            "capital_to_country_mc",
        };
      },
    };
  });
}

/** All test (multiple-choice) questions in the universe. */
export const CONQUEST_TEST_POOL: PlannedQuestion[] = [
  ...CONQUEST_QUIZ_BANK.map(plannedFromQuiz),
  ...buildFlagMcPool(),
  ...buildCapitalMcPool(),
];

/** All write (free-text) questions in the universe. */
export const CONQUEST_WRITE_POOL: PlannedQuestion[] = [
  ...CONQUEST_TYPE_RACE_BANK.map(plannedFromTypeRace),
  ...CONQUEST_FLAG_GUESS_BANK.map(plannedFromFlagGuess),
];

/** Combined pool (used by off-plan ad-hoc picks like the defense duel). */
const CONQUEST_ALL_POOL: PlannedQuestion[] = [
  ...CONQUEST_TEST_POOL,
  ...CONQUEST_WRITE_POOL,
];

const UNIVERSE_BY_ID: Map<string, PlannedQuestion> = new Map(
  CONQUEST_ALL_POOL.map((q) => [q.bankId, q]),
);

/** Number of distinct, renderable test (multiple-choice) questions. */
export const CONQUEST_TEST_QUESTION_COUNT = CONQUEST_TEST_POOL.length;
/** Number of distinct, renderable write (free-text) questions. */
export const CONQUEST_WRITE_QUESTION_COUNT = CONQUEST_WRITE_POOL.length;

// ─────────────────────────────────────────────────────────────────────────────
// Answer-mode round plan (the test/write ratio + ordering)
// ─────────────────────────────────────────────────────────────────────────────

/** Test rounds for a given match length: ceil(60%).  Matches the required
 *  6→4, 8→5, 10→6 exactly, and stays test-dominant for every other count. */
export function conquestTestRoundCount(totalRounds: number): number {
  const total = Math.max(1, Math.floor(totalRounds));
  return Math.min(total, Math.ceil(total * 0.6));
}

/**
 * Ordered answer-mode plan.  Test-dominant; the (minority) write rounds are
 * spread as evenly as possible so two writes never land adjacent.  A seeded
 * phase offset varies the exact positions between matches while staying fully
 * deterministic for a given seed.
 */
export function planAnswerModes(
  totalRounds: number,
  seed:        number,
): ConquestAnswerMode[] {
  const total = Math.max(1, Math.floor(totalRounds));
  const testCount  = conquestTestRoundCount(total);
  const writeCount = total - testCount;
  const modes: ConquestAnswerMode[] = new Array(total).fill("test");
  if (writeCount <= 0) return modes;

  const step = total / writeCount; // ≥ 2.5 because writeCount ≤ 40% of total
  const rng = mulberry32(seedFromString(`cq-modes|${seed}|${total}`));
  const offset = rng() * step;     // in [0, step) → max index stays < total
  for (let i = 0; i < writeCount; i++) {
    let idx = Math.floor(offset + i * step);
    if (idx >= total) idx = total - 1;
    // Defensive: even spacing makes collisions impossible, but never clobber.
    while (modes[idx] === "write" && idx + 1 < total) idx++;
    modes[idx] = "write";
  }
  return modes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection with anti-repetition
// ─────────────────────────────────────────────────────────────────────────────

interface SelectionCtx {
  rng:           () => number;
  usedBankIds:   Set<string>;
  usedTargets:   Set<string>;
  usedLetters:   Set<string>;
  usedCountries: Set<string>;
  lastFamily?:   ConquestQuestionFamily;
}

function preferBest(
  cands: PlannedQuestion[],
  ctx:   SelectionCtx,
): PlannedQuestion | undefined {
  if (cands.length === 0) return undefined;
  // Tier 1: avoid the previous round's family.
  const diffFamily = ctx.lastFamily
    ? cands.filter((q) => q.family !== ctx.lastFamily)
    : cands;
  let tier = diffFamily.length > 0 ? diffFamily : cands;
  // Tier 2 (soft): prefer a country not yet featured this match.
  const freshCountry = tier.filter(
    (q) => !(q.countryKey && ctx.usedCountries.has(q.countryKey)),
  );
  tier = freshCountry.length > 0 ? freshCountry : tier;
  return tier[Math.floor(ctx.rng() * tier.length)];
}

/**
 * Pick the next question from `pool`, applying the hard no-repeat rules first
 * and relaxing only in a controlled order:
 *   1. never reuse an exact question, target answer, or letter, and avoid the
 *      previous family;
 *   2. if that is empty (more rounds than distinct targets), relax target /
 *      letter dedupe but still never repeat the exact question;
 *   3. if even that is empty (rounds > pool size), allow an exact repeat as a
 *      last resort — still avoiding the previous family when possible.
 */
function selectQuestion(
  pool: PlannedQuestion[],
  ctx:  SelectionCtx,
): PlannedQuestion {
  const hard = pool.filter(
    (q) =>
      !ctx.usedBankIds.has(q.bankId) &&
      !(q.targetKey && ctx.usedTargets.has(q.targetKey)) &&
      !(q.letter && ctx.usedLetters.has(q.letter)),
  );
  const fromHard = preferBest(hard, ctx);
  if (fromHard) return fromHard;

  const noExactRepeat = pool.filter((q) => !ctx.usedBankIds.has(q.bankId));
  const fromNoExact = preferBest(noExactRepeat, ctx);
  if (fromNoExact) return fromNoExact;

  return preferBest(pool, ctx) ?? pool[Math.floor(ctx.rng() * pool.length)];
}

function recordUse(ctx: SelectionCtx, q: PlannedQuestion): void {
  ctx.usedBankIds.add(q.bankId);
  if (q.targetKey) ctx.usedTargets.add(q.targetKey);
  if (q.letter) ctx.usedLetters.add(q.letter);
  if (q.countryKey) ctx.usedCountries.add(q.countryKey);
  ctx.lastFamily = q.family;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface PlannedChallenge {
  challenge: ConquestChallenge;
  bankId:    string;
}

/**
 * Build the full per-round question plan for a match.  Deterministic: the same
 * `seed` + `totalRounds` always yields the same plan (the players list only
 * fills `eligiblePlayerIds`, which the round-mount logic re-narrows anyway).
 */
export function buildConquestQuestionPlan(opts: {
  seed:        number;
  totalRounds: number;
  players:     ConquestPlayer[];
}): PlannedChallenge[] {
  const safeRounds = Math.max(1, Math.floor(opts.totalRounds));
  const modes = planAnswerModes(safeRounds, opts.seed);
  const ctx: SelectionCtx = {
    rng:           mulberry32(seedFromString(`cq-qplan|${opts.seed}|${safeRounds}`)),
    usedBankIds:   new Set(),
    usedTargets:   new Set(),
    usedLetters:   new Set(),
    usedCountries: new Set(),
    lastFamily:    undefined,
  };

  const plan: PlannedChallenge[] = [];
  for (let i = 0; i < safeRounds; i++) {
    const pool = modes[i] === "test" ? CONQUEST_TEST_POOL : CONQUEST_WRITE_POOL;
    const picked = selectQuestion(pool, ctx);
    recordUse(ctx, picked);
    plan.push({
      challenge: picked.build(i + 1, opts.players, `${opts.seed}|${i + 1}`),
      bankId:    picked.bankId,
    });
  }
  return plan;
}

/**
 * Pick a single off-plan challenge (used by the Savunma Düellosu, which fires
 * outside the regular round sequence).  Avoids every question already in the
 * match plan plus anything tracked in `usedChallengeKeys`, and steers away
 * from the current round's family.
 */
export function pickAdHocConquestChallenge(
  state:       ConquestGameState,
  roundNumber: number,
  players:     ConquestPlayer[],
): PlannedChallenge {
  const ctx: SelectionCtx = {
    rng:           mulberry32(seedFromString(`cq-adhoc|${state.startedAt}|${roundNumber}`)),
    usedBankIds:   new Set(state.usedChallengeKeys ?? []),
    usedTargets:   new Set(),
    usedLetters:   new Set(),
    usedCountries: new Set(),
    lastFamily:    state.round?.challenge?.challenge?.family,
  };
  // Reconstruct the used target/letter/country sets from every known used id so
  // the duel question never echoes a planned answer.
  for (const id of ctx.usedBankIds) {
    const meta = UNIVERSE_BY_ID.get(id);
    if (!meta) continue;
    if (meta.targetKey) ctx.usedTargets.add(meta.targetKey);
    if (meta.letter) ctx.usedLetters.add(meta.letter);
    if (meta.countryKey) ctx.usedCountries.add(meta.countryKey);
  }

  const picked = selectQuestion(CONQUEST_ALL_POOL, ctx);
  return {
    challenge: picked.build(roundNumber, players, `adhoc|${state.startedAt}|${roundNumber}`),
    bankId:    picked.bankId,
  };
}

/** Every bankId in the plan — seeded into `usedChallengeKeys` so off-plan
 *  picks (duels) never collide with a future planned round. */
export function planBankIds(plan: PlannedChallenge[]): string[] {
  return plan.map((p) => p.bankId);
}
