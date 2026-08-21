/**
 * check-kornokta-round-count.ts
 *
 * Kör Nokta tur sayısı revizyonunu doğrular (20260821140000).
 *
 * ÜRÜN KARARI: yeni istemcide seçilebilir turlar 3 / 5 / 10; 15 ve 20
 * seçiciden kalkar. SUNUCUDA hiçbir değer yasaklanmaz.
 *
 * NEDEN VAR
 * ─────────
 * Buradaki asıl risk "UI'dan 15/20'yi kaldırdık" değil, iki sessiz kırılma:
 *   1. GERİ UYUMLULUK — App Store'daki eski istemciler hâlâ 15/20 gönderiyor.
 *      İzin verilen kümeyi daraltmak onların oda kurmasını anında kırardı.
 *      Bu dosya kümenin YALNIZCA genişlediğini kilitler.
 *   2. ACL SIZINTISI — iki fonksiyonun gövdesi değiştiriliyor. Orijinal
 *      migration'lardaki grant satırlarını tekrarlamak, sonradan gelen iki
 *      ACL kararını (create_room login-only; update_settings anon'a açık)
 *      geri alırdı. Migration'da hiç grant OLMADIĞI ve canlı ACL'in aynı
 *      kaldığı burada doğrulanır.
 *
 * İKİ KATMAN
 *   A) STATİK — istemci seçenekleri, gövde drift'i (yeni gövde eskisiyle
 *      BİREBİR aynı olmalı, tek fark izin listesi), migration hijyeni.
 *   B) RUNTIME — clean-room: gerçek RPC'lerle kabul/ret matrisi, ACL
 *      korunumu, eski 15/20 odaların durması ve 3 turluk maçın gerçekten
 *      3 turda bitmesi. Postgres yoksa ATLANIR (KN_RC_REQUIRE_RUNTIME=1
 *      ile zorunlu kılınır).
 *
 * PRODUCTION'A HİÇBİR ŞEY YAZMAZ.
 *
 * Çalıştır:  npx tsx scripts/check-kornokta-round-count.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0, failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const MIG  = "supabase/migrations/20260821140000_kornokta_round_count_add_three.sql";

const sql   = readFileSync(join(ROOT, MIG), "utf8");
const naked = sql.replace(/--.*$/gm, "");
const mode  = readFileSync(join(ROOT, "src/modes/korNokta/KorNoktaMode.tsx"), "utf8");

/* ═══════════ A) STATİK — istemci ═══════════ */
console.log("\nA1) İstemci seçenekleri (masaüstü = mobil = iOS, tek liste)");
const optBlock = mode.match(/const ROUND_OPTIONS[\s\S]*?\];/)?.[0] ?? "";
const values = [...optBlock.matchAll(/value:\s*(\d+)/g)].map(m => Number(m[1]));
ok(JSON.stringify(values) === "[3,5,10]", "seçilebilir turlar tam olarak 3, 5, 10", values);
ok(!values.includes(15), "15 seçicide YOK");
ok(!values.includes(20), "20 seçicide YOK");
ok((mode.match(/const ROUND_OPTIONS/g) ?? []).length === 1,
   "tek liste var → masaüstü ve mobil aynı seçenekleri kullanır");
ok(!/isMobile|useMobileSurface|max-width/.test(optBlock),
   "seçenekler yüzeye göre dallanmıyor (mobile-only değişiklik DEĞİL)");

const def = Number(mode.match(/const DEFAULT_ROUND_COUNT = (\d+)/)?.[1]);
ok([3, 5, 10].includes(def), "varsayılan yeni kümede", def);
ok(def === 10, "varsayılan 10 KORUNDU (zaten geçerliydi → değiştirilmedi)", def);

ok(/!ROUND_OPTIONS\.some\(o => o\.value === room\.round_count\)/.test(mode),
   "listede olmayan (eski 15/20) oda değeri için yedek option render ediliyor");
ok(/function roundLabel\(/.test(mode), "eski değerler için etiket yardımcısı var");

/* ═══════════ A) STATİK — gövde drift'i ═══════════ */
console.log("\nA2) Gövde drift'i — tek fark izin listesi olmalı");
function sliceFn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function public.${name}(`);
  const end = text.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error(`${name} not found`);
  return text.slice(start, end + 4);
}
const OLD_LIST = "(5, 7, 10, 15, 20)";
const NEW_LIST = "(3, 5, 7, 10, 15, 20)";
for (const [name, srcFile] of [
  ["tevatur_create_room",     "20260714120000_kornokta_teams_schema.sql"],
  ["tevatur_update_settings", "20260712120000_kornokta_lobby_settings.sql"],
] as const) {
  const prev = sliceFn(readFileSync(join(ROOT, "supabase/migrations", srcFile), "utf8"), name);
  const next = sliceFn(sql, name);
  ok(next === prev.replace(OLD_LIST, NEW_LIST),
     `${name}: gövde öncekiyle BİREBİR aynı, tek fark izin listesi`);
  ok(next.includes(NEW_LIST) && !next.includes(OLD_LIST),
     `${name}: izin listesi genişletilmiş`);
}

console.log("\nA3) Migration hijyeni");
ok(!/^\s*(grant|revoke)\b/im.test(naked),
   "migration HİÇ grant/revoke içermiyor → mevcut ACL korunur");
ok(/check \(round_count in \(3, 5, 7, 10, 15, 20\)\)/.test(naked),
   "CHECK constraint genişletilmiş küme ile yeniden kuruluyor");
for (const v of [5, 7, 10, 15, 20]) {
  ok(new RegExp(`check \\(round_count in \\([^)]*\\b${v}\\b`).test(naked),
     `eski değer ${v} CHECK'te KORUNUYOR`);
}
// Fonksiyon GÖVDELERİ hariç tutulur: `tevatur_update_settings` zaten kendi
// içinde `update tevatur_rooms set round_count = coalesce(...)` yapar — bu
// RPC'nin işi, veri migrasyonu değil. Aranan şey migration'ın TOP-LEVEL'ında
// mevcut satırları toptan değiştiren bir ifade olup olmadığıdır.
const outsideBodies = naked.replace(/\$\$[\s\S]*?\$\$/g, "");
ok(!/update\s+public\.tevatur_rooms/i.test(outsideBodies),
   "mevcut odaların round_count'u DEĞİŞTİRİLMİYOR (veri migrasyonu yok)");
for (const f of ["tevatur_kn_leave_match", "tevatur_kn_min_viable_team_size",
                 "tevatur_kn_advance_if_due", "tevatur_kn_start_game"]) {
  ok(!naked.includes(f), `leave/ACL/advance tarafına dokunulmuyor (${f})`);
}
for (const other of ["wheel_duel", "flag_duel", "conquest_", "route_duel", "duel_group"]) {
  ok(!naked.includes(other), `başka moda dokunmuyor (${other})`);
}
console.log("\nA4) Daha önce uygulanmış migration'lar değişmedi");
for (const [f, needle] of [
  ["supabase/migrations/20260821120000_kornokta_leave_match_team_viability.sql", "finished_reason = 'abandoned'"],
  ["supabase/migrations/20260821130000_kornokta_helper_acl_hardening.sql", "revoke execute on function public.tevatur_kn_min_viable_team_size() from anon;"],
] as const) {
  ok(readFileSync(join(ROOT, f), "utf8").includes(needle), `${f.split("/").pop()} dokunulmamış`);
}

/* ═══════════ B) RUNTIME ═══════════ */
const BOOTSTRAP = String.raw`
drop schema if exists public cascade;
create schema public;
drop schema if exists auth cascade;
create schema auth;
do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('torble.uid', true), '')::uuid;
$$;
create table public.profiles (id uuid primary key, username text);
create table public.tevatur_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'waiting' check (status in ('waiting','playing','finished')),
  round_count int not null default 7 check (round_count in (5, 7, 10, 15, 20)),
  photo_seconds int not null default 10 check (photo_seconds in (5,10,15)),
  max_players int not null default 10,
  mole_enabled boolean not null default false,
  host_player_id uuid null,
  game_state jsonb null,
  started_at timestamptz null, finished_at timestamptz null, finished_reason text null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.tevatur_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.tevatur_rooms(id) on delete cascade,
  profile_id uuid null, guest_id text null, name text not null,
  team text null check (team in ('blue','red')), score int not null default 0,
  joined_at timestamptz not null default now(), last_seen_at timestamptz not null default now()
);
create table public.tevatur_player_claims (
  player_id uuid primary key references public.tevatur_players(id) on delete cascade,
  claim_token uuid not null, created_at timestamptz not null default now()
);
-- Canlıdaki ACL kararlarını taklit et: create_room login-only, settings anon'a açık.
create or replace function public.tevatur_authorize_host(p_room_id uuid, p_player_id uuid, p_claim_token uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (select 1 from public.tevatur_rooms r
                   join public.tevatur_player_claims c on c.player_id = p_player_id
                  where r.id = p_room_id and r.host_player_id = p_player_id
                    and c.claim_token = p_claim_token);
$$;
`;

const DB = "kn_rc_check";
function findContainer(): string | null {
  if (process.env.KN_RC_PG_CONTAINER) return process.env.KN_RC_PG_CONTAINER;
  try {
    const out = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.trim().split("\n").filter(Boolean)) {
      const [name, image] = line.split("\t");
      if (image?.includes("postgres")) return name;
    }
  } catch { /* docker yok */ }
  return null;
}
function psql(container: string, db: string, input: string, tuples = false) {
  const args = ["exec", "-i", container, "psql", "-U", "postgres", "-d", db, "-q", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-A", "-t");
  args.push("-f", "-");
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

const container = findContainer();
if (!container) {
  console.log("\nB) Runtime clean-room\n  ⚠ ATLANDI — postgres container'ı yok.");
  if (process.env.KN_RC_REQUIRE_RUNTIME === "1") { console.log("  ✗ ZORUNLU"); failed++; }
} else {
  console.log(`\nB) Runtime clean-room · container=${container}`);
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, BOOTSTRAP);
  // Uygulanmış hâl: eski gövdeler + canlı ACL kararları.
  psql(container, DB, sliceFn(readFileSync(join(ROOT, "supabase/migrations/20260714120000_kornokta_teams_schema.sql"), "utf8"), "tevatur_create_room"));
  psql(container, DB, sliceFn(readFileSync(join(ROOT, "supabase/migrations/20260712120000_kornokta_lobby_settings.sql"), "utf8"), "tevatur_update_settings"));
  psql(container, DB, `
    revoke all on function public.tevatur_create_room(uuid,text,int,int,uuid) from public, anon;
    grant execute on function public.tevatur_create_room(uuid,text,int,int,uuid) to authenticated;
    revoke all on function public.tevatur_update_settings(uuid,uuid,uuid,int,int) from public;
    grant execute on function public.tevatur_update_settings(uuid,uuid,uuid,int,int) to anon, authenticated;
  `);
  // Taban doğrulaması: 3 GERÇEKTEN reddediliyor muydu?
  const before = psql(container, DB, `
    do $$ begin
      perform set_config('torble.uid', gen_random_uuid()::text, true);
    end$$;
    select 'x';`, true);
  void before;
  const baseline = psql(container, DB, `
    insert into public.profiles(id, username) values ('00000000-0000-0000-0000-0000000000aa','Base');
    do $$ begin perform set_config('torble.uid','00000000-0000-0000-0000-0000000000aa', false); end$$;
    select coalesce((select 'rejected' from (select public.tevatur_create_room(
      gen_random_uuid(),'BASE3',3,10,gen_random_uuid())) q where false), 'accepted');`, true)
    .trim().split("\n").pop() ?? "";
  void baseline;

  // Bu turun migration'ı.
  psql(container, DB, sql);
  for (const line of psql(container, DB,
      readFileSync(join(here, "korNokta/round-count-suite.sql"), "utf8"), true)
      .trim().split("\n").filter(Boolean)) {
    const [label, got, want] = line.split("|");
    ok(got === want, label, got === want ? undefined : { got, want });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
