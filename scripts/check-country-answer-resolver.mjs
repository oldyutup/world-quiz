/**
 * check-country-answer-resolver.mjs
 *
 * Verifies the centralized, multilingual country-answer resolver used by every
 * "type the country name" mode (Ülke Yaz 1v1, Ülke Yaz group, Bayrak Bilmece,
 * solo map / flag / silhouette). Run:  node scripts/check-country-answer-resolver.mjs
 *
 * Fails (exit 1) on any regression. Prints a summary report at the end.
 */

import {
  COUNTRIES,
  normalizeCountryAnswer,
  resolveCountryAnswer,
  findCountryByAnswer,
  NAME_TO_TOPOID,
  NAME_TO_ENTRY,
  CODE_TO_ENTRY,
  ALIAS_CONFLICTS,
  ALIAS_SHADOWED,
} from "../src/data/countries.ts";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
};

const codeOf = (raw) => resolveCountryAnswer(raw);

/* ── Simulators mirroring the real mode handlers ─────────────────── */

// Ülke Yaz 1v1 / group: resolve → topoId, dedup by claimed topoId (country_code).
function ulkeYazSession() {
  const claimed = new Set(); // topoIds already claimed (server's country_code)
  return {
    submit(raw) {
      const norm = normalizeCountryAnswer(raw);
      const topoId = NAME_TO_TOPOID[norm];
      if (!topoId) return "err";
      if (claimed.has(topoId)) return "dup";
      claimed.add(topoId);
      return "ok";
    },
  };
}

// Bayrak Bilmece: resolve → entry, correct iff entry.code === current flag's code.
function bayrakCheck(raw, flagCode) {
  const norm = normalizeCountryAnswer(raw);
  const entry = NAME_TO_ENTRY[norm];
  return !!entry && entry.code === flagCode;
}

/* ── 1) ≥10 locales / scripts resolve to the same country ───────── */
console.log("\n[1] Multilingual resolution → same canonical country");
const germanyForms = [
  "Germany", "Almanya", "Alemania", "Allemagne", "Deutschland",
  "Германия" /* ru */, "Німеччина" /* uk */, "ألمانيا" /* ar */,
  "德国" /* zh-Hans */, "德國" /* zh-Hant */, "ドイツ" /* ja */,
  "독일" /* ko */, "जर्मनी" /* hi */, "Jerman" /* id */,
];
const germanyCodes = new Set(germanyForms.map(codeOf));
ok(germanyCodes.size === 1 && germanyCodes.has("de"),
   `${germanyForms.length} forms of Germany all resolve to "de" (got ${[...germanyCodes].join(",")})`);

// A second country across scripts, for good measure (South Korea).
const koreaForms = ["South Korea", "Güney Kore", "Corea del Sur", "Corée du Sud",
  "Республика Корея", "كوريا الجنوبية", "韓国", "南韓", "대한민국", "Korea Selatan"];
const koreaCodes = new Set(koreaForms.map(codeOf));
ok(koreaCodes.size === 1 && koreaCodes.has("kr"),
   `${koreaForms.length} forms of South Korea all resolve to "kr" (got ${[...koreaCodes].join(",")})`);

// Count how many distinct locale scripts land Germany correctly (spec: ≥10).
const distinctScriptsForDe = germanyForms.filter(f => codeOf(f) === "de").length;
ok(distinctScriptsForDe >= 10, `≥10 distinct forms resolve Germany (got ${distinctScriptsForDe})`);

/* ── 2) Ülke Yaz 1v1: Germany then Almanya = duplicate ──────────── */
console.log("\n[2] Ülke Yaz 1v1 — canonical de-duplication");
{
  const s = ulkeYazSession();
  ok(s.submit("Germany") === "ok", `"Germany" accepted first`);
  ok(s.submit("Almanya") === "dup", `"Almanya" rejected as duplicate of Germany`);
  ok(s.submit("ドイツ") === "dup", `"ドイツ" (ja) also duplicate`);
  ok(s.submit("Fransa") === "ok", `"Fransa" (a different country) still accepted`);
}

/* ── 3) Ülke Yaz group: same canonical de-duplication ───────────── */
console.log("\n[3] Ülke Yaz group — canonical de-duplication (same infra)");
{
  const s = ulkeYazSession();
  ok(s.submit("Германия") === "ok", `"Германия" (ru) accepted first`);
  ok(s.submit("Deutschland") === "dup", `"Deutschland" rejected as duplicate`);
  ok(s.submit("德國") === "dup", `"德國" (zh-Hant) also duplicate`);
}

/* ── 4) Bayrak Bilmece — multilingual correct answers ───────────── */
console.log("\n[4] Bayrak Bilmece — multilingual correct answers");
ok(bayrakCheck("Almanya", "de"), `"Almanya" correct for the German flag`);
ok(bayrakCheck("독일", "de"), `"독일" (ko) correct for the German flag`);
ok(bayrakCheck("日本", "jp"), `"日本" (ja) correct for the Japanese flag`);
ok(bayrakCheck("Fransa", "fr"), `"Fransa" correct for the French flag`);
ok(!bayrakCheck("Almanya", "fr"), `"Almanya" is WRONG for the French flag`);

/* ── 5) Wrong / conflicting aliases are not accepted ────────────── */
console.log("\n[5] Wrong / unknown / conflicting input rejected");
ok(codeOf("Wakanda") === null, `"Wakanda" resolves to null`);
ok(codeOf("askljdfh") === null, `gibberish resolves to null`);
ok(codeOf("") === null, `empty string resolves to null`);
// No dropped (conflicting) alias ever resolves to a country.
let conflictLeak = 0;
for (const c of ALIAS_CONFLICTS) { if (NAME_TO_ENTRY[c.key]) conflictLeak += 1; }
ok(conflictLeak === 0, `no conflicting alias leaks into the resolver (${ALIAS_CONFLICTS.length} conflicts, ${conflictLeak} leaks)`);

/* ── 6) No Latin regression on curated names ────────────────────── */
console.log("\n[6] Curated TR/EN names still resolve (no regression)");
let curatedMiss = 0;
const missSamples = [];
for (const e of COUNTRIES) {
  for (const n of [e.display, ...e.names]) {
    if (resolveCountryAnswer(n) !== e.code) {
      curatedMiss += 1;
      if (missSamples.length < 8) missSamples.push(`${JSON.stringify(n)}→${e.code}`);
    }
  }
}
ok(curatedMiss === 0, `every curated display/name resolves to its own country (${curatedMiss} misses${missSamples.length ? ": " + missSamples.join(", ") : ""})`);

/* ── 7) Requested special aliases ───────────────────────────────── */
console.log("\n[7] Requested special aliases");
const special = [
  ["ABD", "us"], ["USA", "us"], ["Amerika", "us"],
  ["Türkiye", "tr"], ["Turkey", "tr"], ["Turkiye", "tr"],
  ["Çekya", "cz"], ["Czechia", "cz"], ["Czech Republic", "cz"],
  ["Güney Kore", "kr"], ["South Korea", "kr"], ["Republic of Korea", "kr"],
  ["Fildişi Sahili", "ci"], ["Ivory Coast", "ci"], ["Côte d'Ivoire", "ci"],
];
for (const [alias, code] of special) {
  ok(codeOf(alias) === code, `"${alias}" → ${code}`);
}

/* ── 8) Arabic normalization (harakat / tatweel / alef) ─────────── */
console.log("\n[8] Arabic normalization variants collapse");
ok(normalizeCountryAnswer("ألمانيا") === normalizeCountryAnswer("ألـــمانيا"),
   `tatweel-padded Germany == plain Germany`);
ok(codeOf("أَلْمَانِيَا") === "de", `harakat-vocalized Germany → de`);

/* ── Report ─────────────────────────────────────────────────────── */
const resolvableKeys = Object.keys(NAME_TO_ENTRY).length;
console.log("\n──────────────── REPORT ────────────────");
console.log(`Countries in dataset .......... ${COUNTRIES.length}`);
console.log(`Resolvable normalized aliases . ${resolvableKeys}`);
console.log(`Alias conflicts (dropped) ..... ${ALIAS_CONFLICTS.length}`);
for (const c of ALIAS_CONFLICTS) console.log(`   • [${c.tier}] "${c.key}" ↔ ${c.codes.join(", ")}`);
console.log(`Shadowed locale aliases ....... ${ALIAS_SHADOWED.length}`);
for (const s of ALIAS_SHADOWED) console.log(`   • "${s.key}" → ${s.winner} (shadowed: ${s.shadowed.join(", ")})`);
console.log("────────────────────────────────────────");

if (failures) { console.log(`\n❌ ${failures} check(s) failed.`); process.exit(1); }
console.log("\n✅ All country-answer resolver checks passed.");
