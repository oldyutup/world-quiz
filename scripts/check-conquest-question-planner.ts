/* eslint-disable */
/**
 * Pure-function logic check for the Conquest (Kuşatma) question planner.
 *
 * Verifies the guarantees `buildConquestQuestionPlan` promises:
 *   1. Exact test/write ratio for the headline match lengths:
 *        6 rounds → 4 test / 2 write
 *        8 rounds → 5 test / 3 write
 *       10 rounds → 6 test / 4 write
 *   2. Test-dominant (≥ 60% test) for every other match length.
 *   3. Two write ("Ülke Yaz" / free-text) rounds never land adjacent — so
 *      "A ile başlayan ülke" is never immediately followed by another write.
 *   4. No two consecutive rounds share a question `family`.
 *   5. No exact question (bankId) repeats within a match.
 *   6. No "X harfiyle başlayan ülke" letter repeats within a match.
 *   7. No fixed-target answer repeats within a match.
 *   8. The built challenge's family/answerMode match the pool metadata.
 *   9. Test-pool invariant: the effective test pool is the full set of
 *      multiple-choice questions (quiz + flag-MC + capital-MC), every test
 *      entry is answerMode "test", every write entry is "write", and no two
 *      questions in the whole universe share a bankId.
 *  10. Determinism: same seed + rounds → identical plan; different seeds vary.
 *
 * Run with:  npx tsx scripts/check-conquest-question-planner.ts
 */

import {
  buildConquestQuestionPlan,
  conquestTestRoundCount,
  planAnswerModes,
  CONQUEST_TEST_POOL,
  CONQUEST_WRITE_POOL,
  CONQUEST_TEST_QUESTION_COUNT,
  CONQUEST_WRITE_QUESTION_COUNT,
  type PlannedChallenge,
  type PlannedQuestion,
} from "../src/modes/conquest/conquestQuestionPlanner";
import {
  CONQUEST_QUIZ_BANK,
  CONQUEST_FLAG_GUESS_BANK,
} from "../src/modes/conquest/conquestChallengeBank";
import { normaliseAnswer } from "../src/modes/conquest/conquestChallengeValidation";
import type { ConquestPlayer } from "../src/modes/conquest/types";

let failed = false;
function fail(msg: string) {
  console.error(`  ✗ ${msg}`);
  failed = true;
}
function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

const PLAYERS: ConquestPlayer[] = [
  { id: "p1", name: "Bir",  isHost: true  },
  { id: "p2", name: "İki",  isHost: false },
  { id: "p3", name: "Üç",   isHost: false },
];

/** Authoritative metadata per bankId, used to read back a planned round's
 *  family / target / letter without re-deriving them. */
const META = new Map<string, PlannedQuestion>();
for (const q of [...CONQUEST_TEST_POOL, ...CONQUEST_WRITE_POOL]) META.set(q.bankId, q);

/** Extract the tested letter from a "X harfiyle başlayan …" prompt, if any. */
function letterFromPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const m = prompt.match(/^(.)\s*harfiyle başlayan/i);
  return m ? m[1].toLocaleUpperCase("tr-TR") : undefined;
}

// ── 1. Exact ratios for the headline match lengths ───────────────────────────
console.log("\n[1/10] Exact test/write ratio for 6 / 8 / 10 rounds:");
{
  const expect: Record<number, [number, number]> = {
    6:  [4, 2],
    8:  [5, 3],
    10: [6, 4],
  };
  for (const total of [6, 8, 10]) {
    const [wantTest, wantWrite] = expect[total];
    const gotTest = conquestTestRoundCount(total);
    const gotWrite = total - gotTest;
    if (gotTest === wantTest && gotWrite === wantWrite) {
      ok(`${total} rounds → ${gotTest} test / ${gotWrite} write`);
    } else {
      fail(`${total} rounds → got ${gotTest}/${gotWrite}, want ${wantTest}/${wantWrite}`);
    }
  }
}

// ── 2. ≥ 60% test for every other match length ───────────────────────────────
console.log("\n[2/10] Test-dominant (≥ 60%) for round counts 1..16:");
{
  let bad = 0;
  for (let total = 1; total <= 16; total++) {
    const testCount = conquestTestRoundCount(total);
    if (testCount / total < 0.6 - 1e-9) {
      fail(`${total} rounds → only ${testCount}/${total} test (< 60%)`);
      bad++;
    }
  }
  if (bad === 0) ok("every count 1..16 keeps test rounds ≥ 60%");
}

// ── 9. Test-pool invariant (run early; cheap & order-independent) ─────────────
console.log("\n[3/10] Test-pool invariant — pool composition:");
{
  // Effective test pool = full quiz bank (all multiple-choice) + flag-MC (one
  // per flag entry) + capital-MC (one per capital pair).  No magic number: the
  // count is derived from the banks so the check survives content edits.  The
  // capital-MC count is inferred (= testPool − quiz − flagMC) since CAPITAL_PAIRS
  // is private to the planner.
  const flagMcCount    = CONQUEST_FLAG_GUESS_BANK.length;
  const capitalMcCount = CONQUEST_TEST_QUESTION_COUNT - CONQUEST_QUIZ_BANK.length - flagMcCount;
  const expectedTest   = CONQUEST_QUIZ_BANK.length + flagMcCount + capitalMcCount;
  if (CONQUEST_TEST_QUESTION_COUNT === expectedTest && capitalMcCount > 0) {
    ok(`CONQUEST_TEST_QUESTION_COUNT = ${CONQUEST_TEST_QUESTION_COUNT} `
       + `(quiz ${CONQUEST_QUIZ_BANK.length} + flagMC ${flagMcCount} + capitalMC ${capitalMcCount})`);
  } else {
    fail(`test-pool composition mismatch: count=${CONQUEST_TEST_QUESTION_COUNT}, `
       + `quiz=${CONQUEST_QUIZ_BANK.length}, flagMC=${flagMcCount}, capitalMC=${capitalMcCount}`);
  }
  console.log(`     (write pool = ${CONQUEST_WRITE_QUESTION_COUNT})`);

  const badTestMode = CONQUEST_TEST_POOL.filter((q) => q.answerMode !== "test");
  if (badTestMode.length === 0) ok("every test-pool entry is answerMode \"test\"");
  else fail(`${badTestMode.length} test-pool entries are not answerMode "test"`);

  const badWriteMode = CONQUEST_WRITE_POOL.filter((q) => q.answerMode !== "write");
  if (badWriteMode.length === 0) ok("every write-pool entry is answerMode \"write\"");
  else fail(`${badWriteMode.length} write-pool entries are not answerMode "write"`);

  // No bankId collision across the whole universe.
  const all = [...CONQUEST_TEST_POOL, ...CONQUEST_WRITE_POOL];
  const ids = new Set(all.map((q) => q.bankId));
  if (ids.size === all.length) ok(`all ${all.length} universe bankIds unique`);
  else fail(`bankId collision: ${all.length} entries but ${ids.size} unique ids`);

  // Every quiz bank entry is represented once in the test pool with a family.
  const testIds = new Set(CONQUEST_TEST_POOL.map((q) => q.bankId));
  const missing = CONQUEST_QUIZ_BANK.filter((e) => !testIds.has(e.id));
  if (missing.length === 0) ok(`all ${CONQUEST_QUIZ_BANK.length} quiz entries present in test pool`);
  else fail(`${missing.length} quiz entries missing from test pool (e.g. ${missing[0]?.id})`);

  const noFamily = CONQUEST_TEST_POOL.filter((q) => !q.family);
  if (noFamily.length === 0) ok("every test-pool entry has a family classification");
  else fail(`${noFamily.length} test-pool entries have no family`);
}

// ── 4–8. Per-match invariants across many seeds × match lengths ──────────────
console.log("\n[4/10] Per-match invariants over 300 seeds × {6,7,8,9,10,12} rounds:");
{
  const SEEDS = 300;
  const ROUND_SET = [6, 7, 8, 9, 10, 12];
  let ratioBad = 0, adjWriteBad = 0, adjFamilyBad = 0,
      exactBad = 0, letterBad = 0, targetBad = 0, metaBad = 0;

  for (const total of ROUND_SET) {
    const wantTest = conquestTestRoundCount(total);
    for (let s = 0; s < SEEDS; s++) {
      const seed = 100_000 + s * 31 + total;
      const plan = buildConquestQuestionPlan({ seed, totalRounds: total, players: PLAYERS });

      if (plan.length !== total) {
        fail(`seed ${seed} rounds ${total}: plan length ${plan.length} ≠ ${total}`);
        continue;
      }

      const modes = plan.map((p) => p.challenge.answerMode);
      const fams  = plan.map((p) => p.challenge.family);

      // ratio
      const testRounds = modes.filter((m) => m === "test").length;
      if (testRounds !== wantTest) ratioBad++;

      // adjacency: no two writes back-to-back; no two same family back-to-back
      for (let i = 1; i < plan.length; i++) {
        if (modes[i] === "write" && modes[i - 1] === "write") adjWriteBad++;
        if (fams[i] && fams[i] === fams[i - 1]) adjFamilyBad++;
      }

      // exact / letter / target uniqueness within the match
      const seenBank = new Set<string>();
      const seenLetter = new Set<string>();
      const seenTarget = new Set<string>();
      for (const entry of plan) {
        if (seenBank.has(entry.bankId)) exactBad++;
        seenBank.add(entry.bankId);

        const meta = META.get(entry.bankId);
        // built challenge metadata must agree with the pool entry
        if (!meta
            || meta.family !== entry.challenge.family
            || meta.answerMode !== entry.challenge.answerMode) {
          metaBad++;
        }

        const letter = meta?.letter ?? letterFromPrompt(entry.challenge.prompt);
        if (letter) {
          if (seenLetter.has(letter)) letterBad++;
          seenLetter.add(letter);
        }

        if (meta?.targetKey) {
          const t = meta.targetKey;
          if (seenTarget.has(t)) targetBad++;
          seenTarget.add(t);
        }
      }
    }
  }

  ratioBad     === 0 ? ok("test/write ratio exact in every sampled match")
                     : fail(`${ratioBad} matches had the wrong test/write ratio`);
  adjWriteBad  === 0 ? ok("two write rounds never land adjacent")
                     : fail(`${adjWriteBad} adjacent write-write pairs found`);
  adjFamilyBad === 0 ? ok("no two consecutive rounds share a family")
                     : fail(`${adjFamilyBad} adjacent same-family pairs found`);
  exactBad     === 0 ? ok("no exact question (bankId) repeats within a match")
                     : fail(`${exactBad} exact-question repeats found`);
  letterBad    === 0 ? ok("no 'X harfiyle başlayan' letter repeats within a match")
                     : fail(`${letterBad} letter repeats found`);
  targetBad    === 0 ? ok("no fixed-target answer repeats within a match")
                     : fail(`${targetBad} target-answer repeats found`);
  metaBad      === 0 ? ok("built challenge family/answerMode match pool metadata")
                     : fail(`${metaBad} challenges disagreed with pool metadata`);
}

// ── 10. Determinism ──────────────────────────────────────────────────────────
console.log("\n[5/10] Determinism — same seed reproduces, different seeds vary:");
{
  const keyOf = (plan: PlannedChallenge[]) => plan.map((p) => p.bankId).join(">");
  const a = buildConquestQuestionPlan({ seed: 42, totalRounds: 10, players: PLAYERS });
  const b = buildConquestQuestionPlan({ seed: 42, totalRounds: 10, players: PLAYERS });
  if (keyOf(a) === keyOf(b)) ok("same seed → identical plan");
  else fail("same seed produced two different plans");

  const variants = new Set<string>();
  for (let s = 0; s < 40; s++) {
    variants.add(keyOf(buildConquestQuestionPlan({ seed: s, totalRounds: 10, players: PLAYERS })));
  }
  if (variants.size >= 30) ok(`${variants.size}/40 distinct plans across seeds`);
  else fail(`only ${variants.size}/40 distinct plans — seeding too weak`);
}

// ── Sanity: planAnswerModes spread for the headline lengths (printout) ────────
console.log("\n[6/10] planAnswerModes layout sample (seed 42):");
for (const total of [6, 8, 10]) {
  const modes = planAnswerModes(total, 42).map((m) => (m === "test" ? "T" : "w")).join(" ");
  console.log(`     ${total}: ${modes}`);
}

if (failed) {
  console.error("\nFAIL — see messages above.");
  process.exit(1);
}
console.log("\nOK — Conquest question planner logic checks pass.");
