/**
 * build-daily-quest-data.ts — Günün Görevi migration seed codegen'i.
 *
 * Kaynaklar:
 *   • src/data/countries.ts  → daily_quest_country_catalog seed'i
 *     (yalnız counted; continents[] = getContinentIds üyeliği → MULTI_CONTINENT
 *     dahil; primary_continent = entry.continent → getFlagPool/getWheelPool
 *     aynası; wheel_eligible + fame_tier merkezî fonksiyonlardan)
 *   • scripts/dailyQuest/templates.ts → daily_quest_templates seed'i
 *
 * Çıktı: supabase/migrations/20260803120000_daily_quest_init.sql içindeki
 * "BEGIN GENERATED: ..." / "END GENERATED: ..." blokları YERİNDE güncellenir.
 *
 * Çalıştır:  npx tsx scripts/dailyQuest/build-daily-quest-data.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  COUNTRIES,
  getContinentIds,
  getFameTier,
  isWheelEligible,
  type Continent,
} from "../../src/data/countries";
import {
  assertTemplateMatrix,
  DAILY_QUEST_TEMPLATES,
} from "./templates";

const MIGRATION = resolve(
  __dirname,
  "../../supabase/migrations/20260803120000_daily_quest_init.sql"
);

const REGIONS: (Continent | "world")[] = [
  "europe", "asia", "africa", "north-america", "south-america", "oceania",
];

function sq(s: string): string {
  return s.replace(/'/g, "''");
}

/* ── Ülke kataloğu ─────────────────────────────────────────────────────── */

function buildCatalogSql(): string {
  const regionSets = new Map<string, Set<string>>(
    REGIONS.map((r) => [r, getContinentIds(r as Continent)])
  );

  const rows: string[] = [];
  for (const c of COUNTRIES) {
    if (!c.counted || !c.code || !c.topoId) continue;
    const continents = REGIONS.filter((r) => regionSets.get(r)!.has(c.topoId));
    if (continents.length === 0) {
      throw new Error(`country ${c.code} has no continent membership`);
    }
    rows.push(
      `  ('${sq(c.code)}','${sq(c.topoId)}','${sq(c.display)}','${sq(c.continent)}','{${continents.join(",")}}',true,${isWheelEligible(c)},${getFameTier(c)})`
    );
  }

  return [
    `-- ${rows.length} counted ülke (src/data/countries.ts).`,
    `insert into public.daily_quest_country_catalog`,
    `  (code, topo_id, display, primary_continent, continents, counted, wheel_eligible, fame_tier)`,
    `values`,
    rows.join(",\n") + "",
    `on conflict (code) do update set`,
    `  topo_id           = excluded.topo_id,`,
    `  display           = excluded.display,`,
    `  primary_continent = excluded.primary_continent,`,
    `  continents        = excluded.continents,`,
    `  counted           = excluded.counted,`,
    `  wheel_eligible    = excluded.wheel_eligible,`,
    `  fame_tier         = excluded.fame_tier;`,
  ].join("\n");
}

/* ── Şablonlar ─────────────────────────────────────────────────────────── */

function buildTemplatesSql(): string {
  const problems = assertTemplateMatrix();
  if (problems.length > 0) {
    for (const p of problems) console.error(`MATRIX PROBLEM: ${p.key}: ${p.problem}`);
    throw new Error(`template matrix has ${problems.length} problem(s) — seed not generated`);
  }

  const rows = DAILY_QUEST_TEMPLATES.map((t) =>
    [
      `  ('${sq(t.configuration_key)}'`,
      `'${sq(t.family_key)}'`,
      `'${sq(t.comparable_key)}'`,
      `'${t.mode}'`,
      `'${t.metric}'`,
      `'${sq(JSON.stringify(t.config))}'::jsonb`,
      `${t.difficulty_score}`,
      `'${t.difficulty_tier}'`,
      `${t.enabled}`,
      `${t.version}`,
      `'${sq(t.title)}'`,
      `'${sq(t.description)}')`,
    ].join(", ")
  );

  const perMode = new Map<string, number>();
  for (const t of DAILY_QUEST_TEMPLATES) {
    perMode.set(t.mode, (perMode.get(t.mode) ?? 0) + 1);
  }
  const modeSummary = [...perMode.entries()].map(([m, n]) => `${m} ${n}`).join(" / ");

  return [
    `-- ${DAILY_QUEST_TEMPLATES.length} config (${modeSummary}) — scripts/dailyQuest/templates.ts.`,
    `insert into public.daily_quest_templates`,
    `  (configuration_key, family_key, comparable_key, mode, metric, config,`,
    `   difficulty_score, difficulty_tier, enabled, version, title, description)`,
    `values`,
    rows.join(",\n"),
    `on conflict (configuration_key) do update set`,
    `  family_key       = excluded.family_key,`,
    `  comparable_key   = excluded.comparable_key,`,
    `  mode             = excluded.mode,`,
    `  metric           = excluded.metric,`,
    `  config           = excluded.config,`,
    `  difficulty_score = excluded.difficulty_score,`,
    `  difficulty_tier  = excluded.difficulty_tier,`,
    `  enabled          = excluded.enabled,`,
    `  version          = excluded.version,`,
    `  title            = excluded.title,`,
    `  description      = excluded.description;`,
  ].join("\n");
}

/* ── Marker bloklarını yerinde güncelle ────────────────────────────────── */

function replaceBlock(source: string, name: string, body: string): string {
  const begin = `-- BEGIN GENERATED: ${name}`;
  const end = `-- END GENERATED: ${name}`;
  const iBegin = source.indexOf(begin);
  const iEnd = source.indexOf(end);
  if (iBegin < 0 || iEnd < 0 || iEnd < iBegin) {
    throw new Error(`markers for "${name}" not found in migration`);
  }
  return (
    source.slice(0, iBegin + begin.length) +
    "\n" + body + "\n" +
    source.slice(iEnd)
  );
}

function main() {
  let sql = readFileSync(MIGRATION, "utf8");
  sql = replaceBlock(sql, "COUNTRY CATALOG", buildCatalogSql());
  sql = replaceBlock(sql, "TEMPLATES", buildTemplatesSql());
  writeFileSync(MIGRATION, sql);
  console.log(`updated ${MIGRATION}`);
  console.log(`  catalog rows: ${COUNTRIES.filter((c) => c.counted && c.code && c.topoId).length}`);
  console.log(`  template rows: ${DAILY_QUEST_TEMPLATES.length}`);
}

main();
