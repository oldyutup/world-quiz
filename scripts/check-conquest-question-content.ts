/* eslint-disable */
/**
 * Content-balance check for the Conquest (Kuşatma) question bank.
 *
 * The 2026-06 content revision moved Kuşatma away from pure country↔capital and
 * flag↔country drilling toward physical geography, country location/features,
 * landmarks & world heritage, world records, history-linked geography, and flag
 * symbolism.  This script is the guardrail that keeps that mix honest, failing
 * the build if it drifts back.
 *
 * Verifies, over the planner's *effective* test (multiple-choice) pool:
 *   1. Capital questions (both directions: country→capital + capital→country)
 *      stay a minority — at most 15% of the MC pool.
 *   2. Direct flag→country questions (flag_to_country_mc) stay at most 15%.
 *   3. The educational families (physical geo, region/location, neighbours,
 *      landmarks, world records, history, flag symbolism) are the majority and
 *      every one of them is actually represented.
 *   4. Difficulty mix is "kolay-orta, eğlenceli ve öğretici": hard ≤ 5%,
 *      easy ≥ 60% (target ~70%), medium ≤ 35%.
 *   5. Every multiple-choice entry has exactly one correct answer present in its
 *      choices, and four distinct choices (no accidental duplicate/typo option).
 *
 * Families are read straight off the authored bank metadata (no id-range
 * guessing), so a mis-tagged question shows up here immediately.
 *
 * Run with:  npx tsx scripts/check-conquest-question-content.ts
 */

import {
  CONQUEST_TEST_POOL,
  CONQUEST_WRITE_POOL,
  type PlannedQuestion,
} from "../src/modes/conquest/conquestQuestionPlanner";
import {
  CONQUEST_QUIZ_BANK,
} from "../src/modes/conquest/conquestChallengeBank";
import { normaliseAnswer } from "../src/modes/conquest/conquestChallengeValidation";
import type {
  ConquestQuestionFamily,
  ConquestQuestionDifficulty,
} from "../src/modes/conquest/types";

let failed = false;
function fail(msg: string) { console.error(`  ✗ ${msg}`); failed = true; }
function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function pct(n: number, d: number): string { return `${((n / d) * 100).toFixed(1)}%`; }

const TEST_TOTAL = CONQUEST_TEST_POOL.length;

// ── helpers ──────────────────────────────────────────────────────────────────
function countBy<T extends string>(pool: PlannedQuestion[], key: (q: PlannedQuestion) => T): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of pool) out[key(q)] = (out[key(q)] ?? 0) + 1;
  return out;
}

const CAPITAL_FAMILIES: ConquestQuestionFamily[] = ["country_to_capital_mc", "capital_to_country_mc"];
const REQUIRED_EDU_FAMILIES: ConquestQuestionFamily[] = [
  "physical_geo_mc", "region_mc", "neighbor_mc",
  "landmark_mc", "world_record_mc", "history_geo_mc", "flag_symbol_mc",
];

// ── 1. Family distribution (printout) ─────────────────────────────────────────
console.log(`\n[1/6] Test (multiple-choice) pool family distribution (total ${TEST_TOTAL}):`);
const famCounts = countBy(CONQUEST_TEST_POOL, (q) => q.family);
{
  const rows = Object.entries(famCounts).sort((a, b) => b[1] - a[1]);
  for (const [fam, n] of rows) {
    console.log(`     ${fam.padEnd(24)} ${String(n).padStart(3)}  (${pct(n, TEST_TOTAL)})`);
  }
}

// ── 2. Capital cap (≤ 15% of MC pool, both directions) ────────────────────────
console.log("\n[2/6] Capital questions stay a minority (cap 15%):");
{
  const capital = CAPITAL_FAMILIES.reduce((s, f) => s + (famCounts[f] ?? 0), 0);
  const ratio = capital / TEST_TOTAL;
  console.log(`     country_to_capital_mc=${famCounts["country_to_capital_mc"] ?? 0}, `
            + `capital_to_country_mc=${famCounts["capital_to_country_mc"] ?? 0} `
            + `→ ${capital}/${TEST_TOTAL} (${pct(capital, TEST_TOTAL)})`);
  if (ratio <= 0.15 + 1e-9) ok(`capital share ${pct(capital, TEST_TOTAL)} ≤ 15%`);
  else fail(`capital share ${pct(capital, TEST_TOTAL)} exceeds the 15% cap`);
}

// ── 3. Direct flag→country cap (≤ 15% of MC pool) ─────────────────────────────
console.log("\n[3/6] Direct flag→country questions stay a minority (cap 15%):");
{
  const flag = famCounts["flag_to_country_mc"] ?? 0;
  const ratio = flag / TEST_TOTAL;
  if (ratio <= 0.15 + 1e-9) ok(`flag_to_country_mc ${flag}/${TEST_TOTAL} (${pct(flag, TEST_TOTAL)}) ≤ 15%`);
  else fail(`flag_to_country_mc share ${pct(flag, TEST_TOTAL)} exceeds the 15% cap`);
}

// ── 4. Educational families dominate and are all present ──────────────────────
console.log("\n[4/6] Educational families dominate the pool:");
{
  let missing = 0;
  for (const fam of REQUIRED_EDU_FAMILIES) {
    if ((famCounts[fam] ?? 0) <= 0) { fail(`required family "${fam}" is absent from the pool`); missing++; }
  }
  if (missing === 0) ok(`all ${REQUIRED_EDU_FAMILIES.length} educational families present`);

  const edu = REQUIRED_EDU_FAMILIES.reduce((s, f) => s + (famCounts[f] ?? 0), 0);
  const ratio = edu / TEST_TOTAL;
  console.log(`     educational core = ${edu}/${TEST_TOTAL} (${pct(edu, TEST_TOTAL)})`);
  if (ratio >= 0.60) ok(`educational families are ${pct(edu, TEST_TOTAL)} (≥ 60%) of the pool`);
  else fail(`educational families only ${pct(edu, TEST_TOTAL)} of the pool (< 60%)`);
}

// ── 5. Difficulty mix (hard ≤ 5%, easy ≥ 60%, medium ≤ 35%) ───────────────────
console.log("\n[5/6] Difficulty mix across the test pool:");
{
  const diff = countBy(CONQUEST_TEST_POOL, (q) => q.difficulty);
  const easy   = diff["easy"]   ?? 0;
  const medium = diff["medium"] ?? 0;
  const hard   = diff["hard"]   ?? 0;
  console.log(`     easy=${easy} (${pct(easy, TEST_TOTAL)}), `
            + `medium=${medium} (${pct(medium, TEST_TOTAL)}), `
            + `hard=${hard} (${pct(hard, TEST_TOTAL)})`);

  hard / TEST_TOTAL   <= 0.05 + 1e-9 ? ok(`hard ${pct(hard, TEST_TOTAL)} ≤ 5%`)
                                     : fail(`hard ${pct(hard, TEST_TOTAL)} exceeds the 5% cap`);
  easy / TEST_TOTAL   >= 0.60        ? ok(`easy ${pct(easy, TEST_TOTAL)} ≥ 60% (target ~70%)`)
                                     : fail(`easy ${pct(easy, TEST_TOTAL)} below the 60% floor`);
  medium / TEST_TOTAL <= 0.35 + 1e-9 ? ok(`medium ${pct(medium, TEST_TOTAL)} ≤ 35%`)
                                     : fail(`medium ${pct(medium, TEST_TOTAL)} exceeds the 35% ceiling`);

  // Every authored quiz entry must declare a known difficulty.
  const validDiff = new Set<ConquestQuestionDifficulty>(["easy", "medium", "hard"]);
  const badDiff = CONQUEST_QUIZ_BANK.filter((e) => !validDiff.has(e.difficulty));
  if (badDiff.length === 0) ok("every quiz entry has a valid difficulty");
  else fail(`${badDiff.length} quiz entries have an invalid difficulty (e.g. ${badDiff[0]?.id})`);
}

// ── 6. Multiple-choice well-formedness (one correct, four distinct) ───────────
console.log("\n[6/6] Multiple-choice entries are well-formed:");
{
  let bad = 0;
  for (const e of CONQUEST_QUIZ_BANK) {
    const distinct = new Set(e.choices.map(normaliseAnswer));
    if (e.choices.length !== 4 || distinct.size !== 4) {
      fail(`entry ${e.id}: expected 4 distinct choices, got ${e.choices.length} (${distinct.size} distinct)`);
      bad++;
      continue;
    }
    const accepted = new Set(e.acceptedAnswers.map(normaliseAnswer));
    const correctInChoices = e.choices.filter((c) => accepted.has(normaliseAnswer(c)));
    if (correctInChoices.length !== 1) {
      fail(`entry ${e.id}: expected exactly 1 correct choice, found ${correctInChoices.length}`);
      bad++;
    }
  }
  if (bad === 0) ok(`all ${CONQUEST_QUIZ_BANK.length} quiz entries are well-formed (4 distinct choices, 1 correct)`);
}

// ── Sample printout: 10 new questions across the new families ─────────────────
console.log("\nSample — 10 new/representative questions across families:");
{
  const wanted: ConquestQuestionFamily[] = [
    "physical_geo_mc", "physical_geo_mc", "region_mc", "region_mc",
    "landmark_mc", "world_record_mc", "world_record_mc",
    "history_geo_mc", "history_geo_mc", "flag_symbol_mc",
  ];
  const usedIds = new Set<string>();
  for (const fam of wanted) {
    const e = CONQUEST_QUIZ_BANK.find((q) => q.family === fam && !usedIds.has(q.id));
    if (!e) continue;
    usedIds.add(e.id);
    console.log(`     [${fam}/${e.difficulty}] ${e.prompt}`);
    console.log(`        → ${e.acceptedAnswers[0]}   (şıklar: ${e.choices.join(" / ")})`);
  }
}

if (failed) {
  console.error("\nFAIL — see messages above.");
  process.exit(1);
}
console.log("\nOK — Conquest question content-balance checks pass.");
