/**
 * check-route-duel-data.ts — Rota Duel üretilmiş veri bütünlüğü.
 *
 * Üretilmiş havuzu (src/data/routeDuelData.generated.ts) canonical graf
 * (src/data/countries.ts NEIGHBOR_GRAPH) üzerinde CANLI BFS ile yeniden
 * doğrular — codegen çıktısı bozulur/bayatlar/elle değiştirilirse burada
 * yakalanır. Migration'a gömülü SQL seed'i aynı codegen'in ürünü olduğundan
 * bu doğrulama sunucu havuzunu da temsilen kapsar (drift = codegen'i tekrar
 * çalıştır: npx tsx scripts/routeDuel/build-route-duel-data.ts).
 *
 * Doğrulanan sözleşme (görev spesifikasyonu):
 *   • '5' bandı gerçekten 5 ara ülke (en kısa yol 6 sınır geçişi)
 *   • '7' bandı gerçekten 7 ara ülke (8 geçiş)
 *   • '7plus' yalnız 8 veya 9 ara ülke; ASLA 10+; 7'ye düşme yok
 *   • start ≠ end; a<b sıralı (sırasız çift temsili); duplicate yok
 *   • Her bant boş değil (rota üretimi hiçbir ayarda tıkanmaz)
 *
 * Çalıştır:  npx tsx scripts/check-route-duel-data.ts
 */
import { NEIGHBOR_GRAPH, GRAPH_KEYS } from "../src/data/countries";
import {
  ROUTE_DUEL_POOL,
  ROUTE_DUEL_GRAPH_NODE_COUNT,
} from "../src/data/routeDuelData.generated";
import { intermediatesForLength, routePairKey } from "../src/lib/routeDuelShared";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, a);
}

/* ── Canonical graf üzerinde bağımsız BFS (codegen'den ayrı implementasyon) ── */
function bfsDist(start: string, end: string): number {
  if (start === end) return 0;
  const seen = new Set<string>([start]);
  let frontier = [start];
  let d = 0;
  while (frontier.length) {
    d++;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of NEIGHBOR_GRAPH[cur] ?? []) {
        if (seen.has(nb)) continue;
        if (nb === end) return d;
        seen.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return Infinity;
}

console.log("\n▶ Rota Duel üretilmiş veri bütünlüğü\n");

/* 1) Graf sanity: simetri + düğüm sayısı. */
console.log("· 1. Canonical graf sanity");
eq(GRAPH_KEYS.length, ROUTE_DUEL_GRAPH_NODE_COUNT, "graf düğüm sayısı codegen ile aynı");
{
  let symmetric = true;
  for (const [k, nbs] of Object.entries(NEIGHBOR_GRAPH)) {
    for (const nb of nbs) {
      if (!(NEIGHBOR_GRAPH[nb] ?? []).includes(k)) { symmetric = false; break; }
    }
  }
  ok(symmetric, "graf simetrik (her kenar çift yönlü)");
}

/* 2) Havuz girdileri: yapı + start≠end + a<b + duplicate yok. */
console.log("· 2. Havuz yapısal bütünlüğü");
{
  const keys = new Set<string>();
  let structural = true;
  let ordered = true;
  let selfPair = false;
  for (const [a, b, mid] of ROUTE_DUEL_POOL) {
    if (!NEIGHBOR_GRAPH[a] || !NEIGHBOR_GRAPH[b] || typeof mid !== "number") structural = false;
    if (!(a < b)) ordered = false;
    if (a === b) selfPair = true;
    keys.add(routePairKey(a, b));
  }
  ok(structural, "her girdi grafta var + mid sayısal");
  ok(ordered, "a < b (sırasız çift temsili tutarlı)");
  ok(!selfPair, "başlangıç ≠ hedef (self-pair yok)");
  eq(keys.size, ROUTE_DUEL_POOL.length, "duplicate çift yok (pair_key benzersiz)");
}

/* 3) Bant doğruluğu: her girdinin GERÇEK BFS mesafesi = mid + 1. */
console.log("· 3. Ara ülke sayısı = en kısa yol − 1 (tam doğrulama, canlı BFS)");
{
  let allExact = true;
  let bandOk = true;
  const counts = new Map<number, number>();
  for (const [a, b, mid] of ROUTE_DUEL_POOL) {
    const d = bfsDist(a, b);
    if (d !== mid + 1) {
      allExact = false;
      console.error(`    ! ${a} → ${b}: beklenen ${mid + 1} geçiş, gerçek ${d}`);
    }
    if (mid !== 5 && mid !== 7 && mid !== 8 && mid !== 9) bandOk = false;
    counts.set(mid, (counts.get(mid) ?? 0) + 1);
  }
  ok(allExact, `tüm ${ROUTE_DUEL_POOL.length} çiftin en kısa yolu birebir doğru`);
  ok(bandOk, "yalnız izinli bantlar: 5 / 7 / 8 / 9 ara ülke");
  ok((counts.get(5) ?? 0) > 0, `'5' bandı dolu (${counts.get(5)} çift → gerçekten 5 ara ülke)`);
  ok((counts.get(7) ?? 0) > 0, `'7' bandı dolu (${counts.get(7)} çift → gerçekten 7 ara ülke)`);
  ok((counts.get(8) ?? 0) > 0, `'7plus' 8'lik alt bandı dolu (${counts.get(8)} çift)`);
  ok((counts.get(9) ?? 0) > 0, `'7plus' 9'luk alt bandı dolu (${counts.get(9)} çift)`);
}

/* 4) '7plus' sözleşmesi: yalnız 8 veya 9; asla 10+; 7'ye düşme yok. */
console.log("· 4. '7plus' bandı sözleşmesi");
{
  const bands = intermediatesForLength("7plus");
  eq(bands, [8, 9], "'7plus' → {8, 9}");
  ok(!bands.includes(7), "'7plus' 7'ye sessizce düşmez");
  ok(bands.every(x => x < 10), "'7plus' asla 10+ ara ülke üretmez");
  eq(intermediatesForLength("5"), [5], "'5' → {5}");
  eq(intermediatesForLength("7"), [7], "'7' → {7}");
}

/* 5) Havuzdaki hiçbir girdi bant dışı mesafe taşımıyor (10+ koruması). */
console.log("· 5. Havuz bant dışına taşmıyor");
{
  const tooLong = ROUTE_DUEL_POOL.filter(([, , mid]) => mid >= 10).length;
  const tooShort = ROUTE_DUEL_POOL.filter(([, , mid]) => mid < 5 || mid === 6).length;
  eq(tooLong, 0, "10+ ara ülkeli girdi yok");
  eq(tooShort, 0, "5 altı / 6'lık girdi yok (bantlar ayrık)");
}

/* 6) Ters çift aynı anahtara düşüyor (A→B ≡ B→A). */
console.log("· 6. Sırasız çift anahtarı");
eq(routePairKey("Turkey", "France"), routePairKey("France", "Turkey"), "A|B ≡ B|A");
eq(routePairKey("France", "Turkey"), "France|Turkey", "anahtar = least|greatest");

console.log(failed === 0 ? `\n✅ ${passed} passed, 0 failed` : `\n❌ ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
