/**
 * check-wheel-advance-if-due.ts — DB'siz drift kilidi (Çark Düello + Çark Grup).
 *
 * Doğrulananlar:
 *   1. FEEDBACK_MS (TSX) == *_feedback_delay_ms() (SQL) — her iki mod
 *   2. İstemci sözleşmesi: yalnız advance_if_due çağrılıyor; sıra ÜRETME /
 *      GÖNDERME / OKUMA yolları istemcide KALMADI
 *   3. Yetki modeli: public RPC'ler anon+authenticated, iç helper'lar KAPALI
 *   4. Sunucu iskeleti: kilit, üyelik, deadline, CAS
 *   5. Çark Düello'ya özel skip + rematch (XP idempotency rotasyonu dâhil)
 *   6. Güvenlik: istemci sıra RPC'leri DROP, sızdıran kolonlar DROP,
 *      katalog + sıra tabloları istemciye KAPALI, sıra sunucuda üretiliyor
 *   7. Katalog drift: countries.ts ⇄ migration satırları birebir
 *   8. Zorluk eğrisi: tier bantları + span formülü iki tarafta aynı
 *
 * Çalıştır:  npx tsx scripts/check-wheel-advance-if-due.ts
 */
import { readFileSync } from "node:fs";
import { buildCatalogRows } from "./build-wheel-target-catalog";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) pass++;
  else fails.push(`${label}${got !== undefined ? `  → ${JSON.stringify(got)}` : ""}`);
}

const duelSql  = read("supabase/migrations/20260814120000_wheel_duel_advance_if_due.sql");
const groupSql = read("supabase/migrations/20260814130000_wheel_group_advance_if_due.sql");
const genSql   = read("supabase/migrations/20260814150000_wheel_server_generated_sequence.sql");
const duelTsx  = read("src/components/WheelDuelGame.tsx");
const groupTsx = read("src/components/WheelGroupGame.tsx");
const srcTs    = read("src/data/countries.ts");

/** Yorum satırlarını atar — prose'daki tanımlayıcılar false-positive vermesin. */
const codeOnly = (s: string) =>
  s.split("\n").filter(l => {
    const t = l.trimStart();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--"));
  }).join("\n");

/* ── 1) Zaman sabitleri tek kaynak ───────────────────────────────────────── */
const sqlConst = (sql: string, fn: string) => {
  const m = sql.match(new RegExp(`function public\\.${fn}\\(\\)[\\s\\S]*?select\\s+(\\d+)`));
  return m ? Number(m[1]) : null;
};
const tsxConst = (tsx: string, name: string) => {
  const m = tsx.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};
const dFb = sqlConst(duelSql, "wheel_duel_feedback_delay_ms");
const gFb = sqlConst(groupSql, "wheel_group_feedback_delay_ms");
ok(dFb === 1200, "Çark Düello SQL feedback = 1200", dFb);
ok(tsxConst(duelTsx, "FEEDBACK_MS") === dFb, "Çark Düello: SQL == TSX", [dFb, tsxConst(duelTsx, "FEEDBACK_MS")]);
ok(gFb === 1000, "Çark Grup SQL feedback = 1000", gFb);
ok(tsxConst(groupTsx, "FEEDBACK_MS") === gFb, "Çark Grup: SQL == TSX", [gFb, tsxConst(groupTsx, "FEEDBACK_MS")]);
ok(dFb !== gFb, "İki modun feedback değeri kasıtlı FARKLI", [dFb, gFb]);

/* ── 2) İstemci sözleşmesi ───────────────────────────────────────────────── */
for (const [label, tsx, mode] of [
  ["Çark Düello", duelTsx,  "wheel_duel"],
  ["Çark Grup",   groupTsx, "wheel_group"],
] as const) {
  ok(tsx.includes(`rpc("${mode}_advance_if_due"`), `${label}: advance_if_due çağrılıyor`);
  for (const p of ["p_room_id:", "p_player_id:", "p_claim_token:", "p_expected_target:"]) {
    ok(new RegExp(`${mode}_advance_if_due"[\\s\\S]{0,320}${p}`).test(tsx),
       `${label}: advance_if_due ${p} parametresi var`);
  }
  for (const ev of ["visibilitychange", "focus", "online"]) {
    ok(tsx.includes(`"${ev}"`), `${label}: watchdog ${ev} olayını dinliyor`);
  }
  // GÜVENLİK: istemcide sıra üretme/gönderme/okuma KALMAMALI.
  const code = codeOnly(tsx);
  for (const banned of ["set_target_sequence", "seed_target_sequence", "target_sequence",
                        "buildProgressionQueue", "pickProgressionTopoId", "pickNextTarget"]) {
    ok(!code.includes(banned), `${label}: istemcide '${banned}' KALMADI`);
  }
}

/* ── 3) Yetki modeli ─────────────────────────────────────────────────────── */
const publicRpcs: [string, string][] = [
  ["wheel_duel_advance_if_due(uuid, uuid, uuid, text)", "duel"],
  ["wheel_duel_process_rematch_if_ready(uuid, uuid, uuid)", "duel"],
  ["wheel_group_advance_if_due(uuid, uuid, uuid, text)", "group"],
];
for (const [sig, which] of publicRpcs) {
  const sql = which === "duel" ? duelSql : groupSql;
  ok(sql.includes(`revoke all     on function public.${sig} from public;`),
     `ACL: ${sig.split("(")[0]} revoke from public`);
  ok(sql.includes(`grant  execute on function public.${sig} to anon, authenticated;`),
     `ACL: ${sig.split("(")[0]} anon+authenticated grant`);
}
// Yeni sürümleri 150000 içinde de aynı grant modelini korumalı.
for (const sig of ["wheel_duel_advance_if_due(uuid, uuid, uuid, text)",
                   "wheel_group_advance_if_due(uuid, uuid, uuid, text)",
                   "wheel_duel_process_rematch_if_ready(uuid, uuid, uuid)"]) {
  ok(genSql.includes(`grant  execute on function public.${sig} to anon, authenticated;`),
     `ACL (150000): ${sig.split("(")[0]} grant korunuyor`);
}
// İç helper'lar: `from public` TEK BAŞINA yetmez (Supabase'de yeni fonksiyonlar
// anon'a DOĞRUDAN EXECUTE ile doğar — bkz. 20260809130000 hotfix'i).
const internals: [string, string][] = [
  ["wheel_duel_next_target(uuid)", "gen"],
  ["wheel_group_next_target(uuid)", "gen"],
  ["wheel_generate_sequence(text, int)", "gen"],
  ["wheel_duel_ensure_sequence(uuid)", "gen"],
  ["wheel_group_ensure_sequence(uuid)", "gen"],
  ["wheel_progression_tier_weights(numeric)", "gen"],
  ["wheel_duel_score_winner(uuid)", "duel"],
  ["wheel_duel_feedback_delay_ms()", "duel"],
  ["wheel_group_feedback_delay_ms()", "group"],
];
for (const [sig, which] of internals) {
  const sql = which === "duel" ? duelSql : which === "group" ? groupSql : genSql;
  const esc = sig.replace(/[()[\]]/g, "\\$&");
  ok(new RegExp(`revoke all on function public\\.${esc} from public, anon, authenticated;`).test(sql),
     `ACL: ${sig.split("(")[0]} anon+authenticated'tan AÇIKÇA revoke`);
}

/* ── 4) Sunucu iskeleti ──────────────────────────────────────────────────── */
for (const [label, mode] of [["Çark Düello", "wheel_duel"], ["Çark Grup", "wheel_group"]] as const) {
  ok(genSql.includes(`select * into v_room from public.${mode}_rooms where id = p_room_id for update;`),
     `${label}: satır kilidi (for update)`);
  ok(genSql.includes(`v_seq := public.${mode}_ensure_sequence(p_room_id);`),
     `${label}: FAZ 0 sırayı kuruyor`);
}
ok((genSql.match(/raise exception 'not_a_member'/g) ?? []).length >= 3, "üyelik kontrolü her RPC'de");
ok((genSql.match(/raise exception 'unauthorized'/g) ?? []).length >= 3, "kimlik kontrolü her RPC'de");
ok((genSql.match(/v_now >= v_room\.started_at \+ make_interval\(secs => v_room\.duration_seconds\)/g) ?? []).length === 2,
   "maç sonu deadline'ı sunucu verisinden (iki mod)");
ok((genSql.match(/is distinct from p_expected_target/g) ?? []).length === 2, "CAS kontrolü (iki mod)");
ok(genSql.includes("and current_target_topoid is null"), "refill CAS guard");

/* ── 5) Çark Düello'ya özel ──────────────────────────────────────────────── */
ok(genSql.includes("if v_pass_count >= 2 then"), "Çark Düello: pas eşiği 2");
ok(genSql.includes("match_seq             = coalesce(match_seq, 1) + 1"),
   "rematch: match_seq rotasyonu (XP idempotency)");
ok(genSql.includes("current_match_id      = gen_random_uuid()"),
   "rematch: current_match_id rotasyonu (XP idempotency)");
ok(genSql.includes("delete from public.wheel_duel_room_sequences where room_id = p_room_id;"),
   "rematch: yeni maç için sıra satırı siliniyor");
ok(genSql.includes("public.wheel_duel_score_winner(p_room_id)"), "kazanan sunucu helper'ından");
ok(!/winner_player_id\s*=/.test(codeOnly(groupSql)), "Çark Grup: winner_player_id ATAMASI YOK");

/* ── 6) GÜVENLİK: istemci sıra yazma/okuma yüzeyi kapatıldı ──────────────── */
for (const sig of [
  "wheel_duel_set_target_sequence(uuid, uuid, uuid, text[])",
  "wheel_duel_seed_target_sequence(uuid, uuid, uuid, text[])",
  "wheel_group_set_target_sequence(uuid, uuid, uuid, text[])",
  "wheel_group_seed_target_sequence(uuid, uuid, uuid, text[])",
]) {
  ok(genSql.includes(`drop function if exists public.${sig};`),
     `güvenlik: ${sig.split("(")[0]} DROP ediliyor`);
}
for (const tbl of ["wheel_duel_rooms", "wheel_group_rooms"]) {
  ok(new RegExp(`alter table public\\.${tbl}\\s+drop column if exists target_sequence;`).test(genSql),
     `güvenlik: ${tbl}.target_sequence düşürülüyor`);
}
for (const tbl of ["wheel_target_catalog", "wheel_duel_room_sequences", "wheel_group_room_sequences"]) {
  ok(genSql.includes(`revoke all on table public.${tbl} from anon, authenticated, public;`),
     `güvenlik: ${tbl} istemciye KAPALI`);
  ok(new RegExp(`alter table public\\.${tbl}\\s+enable row level security;`).test(genSql),
     `güvenlik: ${tbl} RLS açık (policy yok → default-deny)`);
}
ok((genSql.match(/on conflict \(room_id\) do nothing/g) ?? []).length === 2,
   "sıra kurulumu atomik (iki mod)");
ok(genSql.includes("random() * sum_w"), "tier seçimi SUNUCU rastgeleliğiyle");
ok(genSql.includes("order by random()"), "kova içi karıştırma SUNUCUDA");

/* ── 7) Katalog drift: countries.ts ⇄ migration ──────────────────────────── */
{
  const expected = new Set(buildCatalogRows().map(r => `${r.region}|${r.topoId}|${r.tier}`));
  const inMig = new Set<string>();
  for (const m of genSql.matchAll(/\('([a-z_]+)', '([^']+)', (\d)\)/g)) {
    inMig.add(`${m[1]}|${m[2]}|${m[3]}`);
  }
  ok(inMig.size === expected.size, "katalog satır sayısı countries.ts ile aynı",
     [inMig.size, expected.size]);
  const missing = [...expected].filter(x => !inMig.has(x));
  const extra   = [...inMig].filter(x => !expected.has(x));
  ok(missing.length === 0, "migration'da EKSİK katalog satırı yok", missing.slice(0, 3));
  ok(extra.length === 0,   "migration'da FAZLA katalog satırı yok", extra.slice(0, 3));
}

/* ── 8) Zorluk eğrisi iki tarafta aynı ───────────────────────────────────── */
for (const [sqlArr, tsArr] of [
  ["array[10, 3, 0, 0]", "[10, 3, 0, 0]"],
  ["array[2,  8, 2, 0]", "[2,  8, 2, 0]"],
  ["array[0,  2, 7, 2]", "[0,  2, 7, 2]"],
  ["array[0,  0, 2, 8]", "[0,  0, 2, 8]"],
] as const) {
  ok(genSql.includes(sqlArr), `tier bandı SQL'de: ${sqlArr}`);
  ok(srcTs.includes(tsArr),   `tier bandı countries.ts'te: ${tsArr}`);
}
for (const edge of ["0.40", "0.70", "0.90"]) {
  ok(genSql.includes(edge) && srcTs.includes(edge), `bant eşiği iki tarafta: ${edge}`);
}
ok(genSql.includes("greatest(6, round(coalesce(v_room.duration_seconds, 60) / 6.0)::int)"),
   "span formülü SQL'de expectedWheelTargets ile aynı");
ok(srcTs.includes("Math.max(6, Math.round((durationSec || 0) / WHEEL_SECONDS_PER_TARGET))"),
   "span formülü countries.ts'te doğrulandı");

/* ── SONUÇ ───────────────────────────────────────────────────────────────── */
console.log(`\n${pass} PASS / ${fails.length} FAIL  (toplam ${pass + fails.length} assert)`);
if (fails.length) {
  console.log("\nFAIL edenler:");
  fails.forEach(f => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log("✓ Çark Düello + Çark Grup sunucu-üretimli sıra drift kilidi temiz.\n");
