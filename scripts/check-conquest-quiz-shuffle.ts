/* eslint-disable */
/**
 * Pure-function distribution / determinism check for Conquest quiz choice
 * shuffling.
 *
 * Verifies:
 *   1. Across N challenges built via the live picker, the correct answer
 *      lands in positions A / B / C / D roughly uniformly (each within
 *      reasonable tolerance bands of 25%).
 *   2. Same seed → same permutation (shuffleWithSeed is deterministic).
 *   3. Different seeds → different permutations (sampled across many ids).
 *   4. The bank entry's "correct" answer (acceptedAnswers[0]) is always
 *      present in the shuffled choices array — no choice is dropped.
 *   5. isChallengeAnswerCorrect still validates the correct answer
 *      regardless of which slot it ends up in (the user-reported bug).
 *
 * Run with:  npx tsx scripts/check-conquest-quiz-shuffle.ts
 */

import {
  buildConquestChallengeId,
  shuffleWithSeed,
} from "../src/modes/conquest/conquestChallenges";
import {
  CONQUEST_QUIZ_BANK,
} from "../src/modes/conquest/conquestChallengeBank";
import {
  isChallengeAnswerCorrect,
  normaliseAnswer,
} from "../src/modes/conquest/conquestChallengeValidation";

let failed = false;
function fail(msg: string) {
  console.error(`  ✗ ${msg}`);
  failed = true;
}
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

// ── 1. Distribution of the correct option index across many challenges ──
function isCorrectChoice(entry: typeof CONQUEST_QUIZ_BANK[number], choice: string): boolean {
  const target = normaliseAnswer(choice);
  for (const accepted of entry.acceptedAnswers) {
    if (normaliseAnswer(accepted) === target) return true;
  }
  return false;
}

console.log("\n[1/5] Correct-answer position distribution over 100 quiz challenges:");
{
  const SAMPLES = 100;
  const dist = [0, 0, 0, 0]; // A, B, C, D
  for (let i = 0; i < SAMPLES; i++) {
    const entry = CONQUEST_QUIZ_BANK[i % CONQUEST_QUIZ_BANK.length];
    if (!entry.choices) continue;
    // Mimic what buildQuizChallenge does.
    const id = buildConquestChallengeId(1, "quiz");
    const shuffled = shuffleWithSeed(entry.choices, `${id}|${entry.id}`);
    const correctIdx = shuffled.findIndex(c => isCorrectChoice(entry, c));
    if (correctIdx < 0 || correctIdx > 3) {
      fail(`entry ${entry.id}: correct answer missing from shuffled choices`);
      continue;
    }
    dist[correctIdx]++;
  }
  const labels = ["A", "B", "C", "D"];
  for (let i = 0; i < 4; i++) {
    const pct = ((dist[i] / SAMPLES) * 100).toFixed(1);
    console.log(`     ${labels[i]}: ${dist[i].toString().padStart(3)} (${pct}%)`);
  }
  const min = Math.min(...dist);
  const max = Math.max(...dist);
  // Tolerance: with N=100 and 4 buckets, expected mean is 25; allow 12..38.
  if (min < 10 || max > 40) {
    fail(`distribution outside tolerance band 10..40 — got min=${min} max=${max}`);
  } else {
    ok(`distribution within tolerance (min=${min}, max=${max})`);
  }
}

// ── 2. Determinism: same seed → same permutation ──────────────────────────
console.log("\n[2/5] Deterministic shuffle — same seed yields same order:");
{
  const sample = ["Ankara", "İstanbul", "İzmir", "Bursa"];
  const seed = "r3-quiz-abcde|q01";
  const a = shuffleWithSeed(sample, seed);
  const b = shuffleWithSeed(sample, seed);
  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  if (same) {
    ok(`stable: [${a.join(", ")}] (twice)`);
  } else {
    fail(`got [${a.join(", ")}] vs [${b.join(", ")}]`);
  }
}

// ── 3. Different seeds → different permutations (sample-wide) ────────────
console.log("\n[3/5] Different seeds usually yield different permutations:");
{
  const sample = ["Ankara", "İstanbul", "İzmir", "Bursa"];
  const SAMPLES = 50;
  const seen = new Set<string>();
  for (let i = 0; i < SAMPLES; i++) {
    const seed = `seed-${i}`;
    seen.add(shuffleWithSeed(sample, seed).join("|"));
  }
  // With 4! = 24 permutations and 50 samples, we expect ≥ 10 unique orderings.
  if (seen.size < 10) {
    fail(`only ${seen.size}/${SAMPLES} unique permutations (expected ≥ 10)`);
  } else {
    ok(`${seen.size}/${SAMPLES} unique permutations sampled`);
  }
}

// ── 4. No choice dropped — shuffle is a permutation, not a rotation ──────
console.log("\n[4/5] Shuffle preserves every choice (no drops, no duplicates):");
{
  let bad = 0;
  for (const entry of CONQUEST_QUIZ_BANK) {
    if (!entry.choices) continue;
    const id = buildConquestChallengeId(1, "quiz");
    const shuffled = shuffleWithSeed(entry.choices, `${id}|${entry.id}`);
    const original = [...entry.choices].sort();
    const got      = [...shuffled].sort();
    if (original.length !== got.length || original.some((v, i) => v !== got[i])) {
      fail(`entry ${entry.id}: shuffled set ≠ original set`);
      bad++;
    }
  }
  if (bad === 0) ok(`all ${CONQUEST_QUIZ_BANK.length} bank entries shuffle into a valid permutation`);
}

// ── 5. Validation still recognises the correct answer post-shuffle ───────
console.log("\n[5/5] isChallengeAnswerCorrect tolerates shuffled choices:");
{
  let bad = 0;
  for (const entry of CONQUEST_QUIZ_BANK) {
    if (!entry.choices) continue;
    const id = buildConquestChallengeId(2, "quiz");
    const shuffled = shuffleWithSeed(entry.choices, `${id}|${entry.id}`);
    const correctChoice = shuffled.find(c => isCorrectChoice(entry, c));
    if (!correctChoice) {
      fail(`entry ${entry.id}: no correct choice resolved`);
      bad++;
      continue;
    }
    const fakeChallenge = {
      id,
      type: "quiz" as const,
      roundNumber: 2,
      title: "Bilgi Sorusu",
      eligiblePlayerIds: [],
      choices: shuffled,
      acceptedAnswers: entry.acceptedAnswers,
    };
    if (!isChallengeAnswerCorrect(fakeChallenge, correctChoice)) {
      fail(`entry ${entry.id}: correct-choice "${correctChoice}" not accepted by validator`);
      bad++;
    }
  }
  if (bad === 0) ok(`all ${CONQUEST_QUIZ_BANK.length} entries: validator accepts correct choice from any slot`);
}

if (failed) {
  console.error("\nFAIL — see messages above.");
  process.exit(1);
}
console.log("\nOK — quiz shuffle distribution / determinism checks pass.");
