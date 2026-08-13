/**
 * build-wheel-target-catalog.ts — `wheel_target_catalog` tohum verisini üretir.
 *
 * KANONİK KAYNAK src/data/countries.ts'tir. Bu script havuzu ve tier'ı YENİDEN
 * HESAPLAMAZ; gerçek `getWheelPool()` / `getFameTier()` fonksiyonlarını ÇAĞIRIR
 * → `isWheelEligible`, MULTI_CONTINENT ve mikro-devlet dışlamaları birebir
 * korunur (SQL'e elle port edilmez).
 *
 * Çıktı: migration'a gömülecek `insert ... values` bloğu (stdout).
 * Drift kontrolü: scripts/check-wheel-advance-if-due.ts üretimi tekrarlayıp
 * migration'daki satırlarla karşılaştırır.
 *
 * Çalıştır:  npx tsx scripts/build-wheel-target-catalog.ts
 */
import { getWheelPool, getFameTier, type Continent } from "../src/data/countries";

/** Oyun içi bölge seçenekleri (WheelDuelGame REGION_OPTIONS) → DB değeri.
 *  normalizeRegion() ile aynı eşleme; DB'de tire yerine alt çizgi kullanılır. */
const REGIONS: { db: string; continent: Continent | "world" }[] = [
  { db: "world",         continent: "world" },
  { db: "europe",        continent: "europe" as Continent },
  { db: "asia",          continent: "asia" as Continent },
  { db: "africa",        continent: "africa" as Continent },
  { db: "north_america", continent: "north-america" as Continent },
  { db: "south_america", continent: "south-america" as Continent },
  { db: "oceania",       continent: "oceania" as Continent },
];

export function buildCatalogRows(): { region: string; topoId: string; tier: number }[] {
  const rows: { region: string; topoId: string; tier: number }[] = [];
  for (const { db, continent } of REGIONS) {
    const pool = getWheelPool(continent, "all").filter(c => !!c.topoId);
    for (const entry of pool) {
      rows.push({ region: db, topoId: entry.topoId, tier: getFameTier(entry) });
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = buildCatalogRows();
  const values = rows
    .map(r => `  ('${r.region}', '${r.topoId}', ${r.tier})`)
    .join(",\n");
  console.log(`insert into public.wheel_target_catalog (region, topo_id, fame_tier) values\n${values}\non conflict (region, topo_id) do update set fame_tier = excluded.fame_tier;`);
  const perRegion = REGIONS.map(
    r => `${r.db}=${rows.filter(x => x.region === r.db).length}`,
  ).join(" ");
  console.error(`\n-- toplam ${rows.length} satır · ${perRegion}`);
}
