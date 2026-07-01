/**
 * build-country-locale-aliases.mjs
 *
 * Build-time generator for the multilingual country-answer alias table.
 *
 * For every country in the canonical dataset (keyed by ISO 3166-1 alpha-2
 * `code`) it asks the platform's Intl.DisplayNames — the reliable, offline ICU
 * locale data bundled with Node — for the country's endonym/exonym in each
 * locale of FIRST_LOCALE_PACK, and emits them as a static TS module.
 *
 * There is NO runtime API call: this runs once, in the build/dev tooling, and
 * the committed `src/data/countryLocaleAliases.generated.ts` is what ships.
 *
 * Regenerate:  node scripts/build-country-locale-aliases.mjs
 *
 * Notes
 *  • zh-Hans and zh-Hant are separate locales on purpose — Simplified and
 *    Traditional spellings are kept as distinct aliases (never merged).
 *  • The generator does NOT strip/normalise: raw human-readable names are
 *    emitted so the output is auditable. `countries.ts` runs every alias
 *    through the single `normalizeCountryAnswer` authority at load time.
 *  • Conflict detection lives in `countries.ts` (it needs the curated names
 *    too), not here.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";

// First locale pack (order preserved in the emitted file for readability).
const FIRST_LOCALE_PACK = [
  "tr", "en", "es", "pt", "fr", "de", "it", "ru",
  "uk", "ar", "zh-Hans", "zh-Hant", "ja", "ko", "id", "hi",
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = resolve(__dirname, "../src/data/countries.ts");
const OUT_PATH = resolve(__dirname, "../src/data/countryLocaleAliases.generated.ts");

// Read the canonical country codes straight from the source text so this
// codegen tool has NO import-time dependency on the module it feeds (avoids a
// bootstrap cycle where countries.ts imports the file we are generating).
function readCountryCodes() {
  const src = readFileSync(SRC_PATH, "utf8");
  const codes = [];
  const seen = new Set();
  const re = /code\s*:\s*"([a-z]{2})"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const code = m[1];
    if (!seen.has(code)) { seen.add(code); codes.push(code); }
  }
  return codes;
}
const COUNTRY_CODES = readCountryCodes();

const displayNames = new Map(
  FIRST_LOCALE_PACK.map((loc) => [loc, new Intl.DisplayNames([loc], { type: "region" })]),
);

/** Collect distinct raw display names for a country across the locale pack. */
function localeNamesFor(code) {
  const region = code.toUpperCase();
  const seen = new Set();
  const out = [];
  for (const loc of FIRST_LOCALE_PACK) {
    let name;
    try {
      name = displayNames.get(loc).of(region);
    } catch {
      name = undefined;
    }
    // ICU returns the region code itself when it has no localized name.
    if (!name || name === region) continue;
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

const table = {};
let missing = 0;
for (const code of COUNTRY_CODES) {
  const names = localeNamesFor(code);
  if (names.length === 0) {
    missing += 1;
    continue;
  }
  table[code] = names;
}

const jsonBody = Object.entries(table)
  .map(([code, names]) => `  ${JSON.stringify(code)}: ${JSON.stringify(names)},`)
  .join("\n");

const banner = `/**
 * countryLocaleAliases.generated.ts — AUTO-GENERATED, DO NOT EDIT BY HAND.
 *
 * Source of truth: scripts/build-country-locale-aliases.mjs (Intl.DisplayNames).
 * Regenerate with:  node scripts/build-country-locale-aliases.mjs
 *
 * Maps ISO 3166-1 alpha-2 country code -> raw localized country names for the
 * first locale pack. Consumed by src/data/countries.ts, which normalises every
 * entry through \`normalizeCountryAnswer\` and resolves conflicts centrally.
 *
 * Locales: ${FIRST_LOCALE_PACK.join(", ")}
 */`;

const fileContents = `${banner}

export const COUNTRY_LOCALE_ALIAS_LOCALES = ${JSON.stringify(FIRST_LOCALE_PACK)} as const;

export const COUNTRY_LOCALE_ALIASES: Record<string, string[]> = {
${jsonBody}
};
`;

writeFileSync(OUT_PATH, fileContents, "utf8");

const totalAliases = Object.values(table).reduce((n, arr) => n + arr.length, 0);
console.log(
  `[build-country-locale-aliases] wrote ${Object.keys(table).length} countries, ` +
    `${totalAliases} locale aliases (${FIRST_LOCALE_PACK.length} locales) -> ${OUT_PATH}`,
);
if (missing) console.log(`[build-country-locale-aliases] ${missing} countries had no localized name (skipped)`);
