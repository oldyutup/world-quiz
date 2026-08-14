/**
 * build-flag-group-catalog.ts — `flag_group_flag_catalog` tohum verisini üretir.
 *
 * KANONİK KAYNAK src/data/countries.ts'tir. Bu script havuzu ve tier'ı YENİDEN
 * HESAPLAMAZ; gerçek `getFlagPool()` / `getFameTier()` fonksiyonlarını ÇAĞIRIR
 * → `counted`/`code` filtreleri ve tier kuralları (ICONIC / mikro-devlet /
 * difficulty) birebir korunur, SQL'e elle port EDİLMEZ.
 *
 * ÖNEMLİ FARK (Çark kataloğuyla): Bayrak havuzu `isWheelEligible` ile
 * FİLTRELENMEZ — mikro-devletler Bayrak'ta tam olarak bulunur (tier 4'e düşer).
 * Ayrıca MULTI_CONTINENT (Türkiye/Rusya iki kıtada) YALNIZ topoId tabanlı
 * `getContinentIds` için geçerlidir; `getFlagPool` düz `c.continent` eşleşmesi
 * yapar → Bayrak Grup'ta Türkiye SADECE Asya havuzundadır. Bu script gerçek
 * fonksiyonu çağırdığı için bu ayrım kendiliğinden korunur.
 *
 * Çıktı: migration'a gömülecek `insert ... values` bloğu (stdout).
 * Drift kontrolü: scripts/check-flag-group-advance-if-due.ts üretimi tekrarlayıp
 * migration'daki satırlarla karşılaştırır.
 *
 * Çalıştır:  npx tsx scripts/build-flag-group-catalog.ts
 */
import { getFlagPool, getFameTier, type Continent } from "../src/data/countries";

/** Oyun içi bölge seçenekleri (FlagGroupGame REGION_OPTS) → DB değeri.
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

export function buildFlagCatalogRows(): { region: string; code: string; tier: number }[] {
  const rows: { region: string; code: string; tier: number }[] = [];
  for (const { db, continent } of REGIONS) {
    // "all" = band filtresi YOK (online modların kullandığı çağrı — FlagGroupGame
    // buildHostSequence ile birebir aynı).
    const pool = getFlagPool(continent, "all").filter(c => !!c.code);
    for (const entry of pool) {
      rows.push({ region: db, code: entry.code, tier: getFameTier(entry) });
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = buildFlagCatalogRows();
  const values = rows
    .map(r => `  ('${r.region}', '${r.code}', ${r.tier})`)
    .join(",\n");
  console.log(
    `insert into public.flag_group_flag_catalog (region, country_code, fame_tier) values\n${values}\n` +
    `on conflict (region, country_code) do update set fame_tier = excluded.fame_tier;`,
  );
  const perRegion = REGIONS.map(
    r => `${r.db}=${rows.filter(x => x.region === r.db).length}`,
  ).join(" ");
  console.error(`\n-- toplam ${rows.length} satır · ${perRegion}`);
}
