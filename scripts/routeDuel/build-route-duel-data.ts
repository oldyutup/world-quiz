/**
 * build-route-duel-data.ts — Rota Duel (Online 1v1 Rota Modu) veri codegen'i.
 *
 * TEK CANONICAL KAYNAK: src/data/countries.ts içindeki NEIGHBOR_GRAPH
 * (offline Rota Modu'nun simetrik kara-sınırı grafı). Bu script o grafı
 * import eder, tam BFS ile tüm sırasız (start,end) çiftlerinin EN KISA yol
 * mesafesini hesaplar ve Rota Duel'in ihtiyaç duyduğu iki çıktıyı üretir:
 *
 *   1) src/data/routeDuelData.generated.ts
 *        • ROUTE_DUEL_POOL   — sırasız çift havuzu ({a, b, mid}); mid = ara
 *                              ülke sayısı = BFS mesafe − 1. Yalnız mid ∈
 *                              {5, 7, 8, 9} bantları (oda ayarı 5 / 7 / 7+).
 *        • ROUTE_DUEL_GRAPH_KEYS — graf düğüm sayısı sanity değeri.
 *      Client bu havuzu OYUN İÇİN KULLANMAZ (rota seçimi tamamen sunucuda);
 *      dosya check-route-duel-data.ts testinin ve gelecekteki araçların
 *      offline doğrulama kaynağıdır.
 *
 *   2) scripts/routeDuel/route-duel-seed.generated.sql
 *        • route_duel_graph  seed'i — country_key + neighbors[] (sunucu-otoriter
 *          komşuluk doğrulaması migration'da bu tabloya karşı yapılır).
 *        • route_duel_pool   seed'i — pair_key (least|greatest), a_key, b_key,
 *          intermediates. Migration dosyasına AYNEN gömülür.
 *      Elle yazılmış ikinci bir graf kopyası YOKTUR; sunucu verisi her zaman
 *      bu script'le canonical kaynaktan yeniden üretilebilir.
 *
 * Çalıştır:  npx tsx scripts/routeDuel/build-route-duel-data.ts
 * Determinizm: çıktı alfabetik sıralıdır — aynı graf → bayt-bayt aynı çıktı.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NEIGHBOR_GRAPH, GRAPH_KEYS } from "../../src/data/countries";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

/** Oda ayarı → ara ülke bantları. '5' ve '7' tam değerdir; '7plus' gizli
 *  olarak 8 veya 9 ara ülke seçer (10+ ASLA üretilmez, 7'ye düşülmez). */
const POOL_INTERMEDIATES = [5, 7, 8, 9] as const;

/** start'tan tüm düğümlere BFS mesafesi (sınır geçişi sayısı). */
function bfsDistances(start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  let d = 0;
  while (frontier.length) {
    const next: string[] = [];
    d++;
    for (const cur of frontier) {
      for (const nb of NEIGHBOR_GRAPH[cur] ?? []) {
        if (!dist.has(nb)) {
          dist.set(nb, d);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

interface PoolEntry {
  /** Alfabetik küçük anahtar (a < b garanti — sırasız çift temsili). */
  a: string;
  b: string;
  /** Ara ülke sayısı = en kısa yolun sınır-geçişi sayısı − 1. */
  mid: number;
}

const keys = GRAPH_KEYS.slice().sort();
const wanted = new Set<number>(POOL_INTERMEDIATES);
const pool: PoolEntry[] = [];

for (let i = 0; i < keys.length; i++) {
  const di = bfsDistances(keys[i]);
  for (let j = i + 1; j < keys.length; j++) {
    const d = di.get(keys[j]);
    if (d === undefined) continue;
    const mid = d - 1;
    if (wanted.has(mid)) pool.push({ a: keys[i], b: keys[j], mid });
  }
}
pool.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

const counts = new Map<number, number>();
for (const p of pool) counts.set(p.mid, (counts.get(p.mid) ?? 0) + 1);

/* ── 1) Client generated TS ─────────────────────────────────────────────── */
const tsLines: string[] = [
  "/**",
  " * routeDuelData.generated.ts — Rota Duel sırasız çift havuzu (OTOMATİK ÜRETİM).",
  " *",
  " * ELLE DÜZENLEME — kaynak: src/data/countries.ts NEIGHBOR_GRAPH.",
  " * Yeniden üret:  npx tsx scripts/routeDuel/build-route-duel-data.ts",
  " *",
  " * Rota seçimi SUNUCUDADIR (route_duel_pool tablosu, aynı script'in SQL",
  " * çıktısından seed'lenir). Bu dosya yalnız offline doğrulama/test içindir;",
  " * gameplay client'ı bu havuzdan rota SEÇMEZ.",
  " */",
  "",
  "/** [a, b, araÜlkeSayısı] — a < b (alfabetik, sırasız çift temsili). */",
  "export type RouteDuelPoolEntry = readonly [string, string, number];",
  "",
  `export const ROUTE_DUEL_GRAPH_NODE_COUNT = ${keys.length};`,
  "",
  "export const ROUTE_DUEL_POOL: readonly RouteDuelPoolEntry[] = [",
  ...pool.map((p) => `  [${JSON.stringify(p.a)}, ${JSON.stringify(p.b)}, ${p.mid}],`),
  "];",
  "",
];
writeFileSync(resolve(ROOT, "src/data/routeDuelData.generated.ts"), tsLines.join("\n"));

/* ── 2) Migration seed SQL ──────────────────────────────────────────────── */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const graphRows = keys.map((k) => {
  const nbs = (NEIGHBOR_GRAPH[k] ?? []).slice().sort();
  return `  (${sqlStr(k)}, array[${nbs.map(sqlStr).join(",")}])`;
});

const poolRows = pool.map(
  (p) => `  (${sqlStr(`${p.a}|${p.b}`)}, ${sqlStr(p.a)}, ${sqlStr(p.b)}, ${p.mid})`
);

const sql = [
  "-- route-duel-seed.generated.sql — OTOMATİK ÜRETİM (elle düzenleme).",
  "-- Kaynak: src/data/countries.ts NEIGHBOR_GRAPH.",
  "-- Yeniden üret: npx tsx scripts/routeDuel/build-route-duel-data.ts",
  `-- Graf: ${keys.length} düğüm. Havuz: ${pool.length} sırasız çift ` +
    `(mid=5:${counts.get(5) ?? 0}, mid=7:${counts.get(7) ?? 0}, ` +
    `mid=8:${counts.get(8) ?? 0}, mid=9:${counts.get(9) ?? 0}).`,
  "",
  "insert into public.route_duel_graph (country_key, neighbors) values",
  graphRows.join(",\n"),
  "on conflict (country_key) do update set neighbors = excluded.neighbors;",
  "",
  "insert into public.route_duel_pool (pair_key, a_key, b_key, intermediates) values",
  poolRows.join(",\n"),
  "on conflict (pair_key) do update set",
  "  a_key = excluded.a_key,",
  "  b_key = excluded.b_key,",
  "  intermediates = excluded.intermediates;",
  "",
].join("\n");
writeFileSync(resolve(HERE, "route-duel-seed.generated.sql"), sql);

console.log(`route-duel data üretildi:`);
console.log(`  graf düğümü: ${keys.length}`);
console.log(
  `  havuz: ${pool.length} çift — mid=5:${counts.get(5) ?? 0}, mid=7:${counts.get(7) ?? 0}, mid=8:${counts.get(8) ?? 0}, mid=9:${counts.get(9) ?? 0}`
);
console.log(`  → src/data/routeDuelData.generated.ts`);
console.log(`  → scripts/routeDuel/route-duel-seed.generated.sql`);
