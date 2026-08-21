/**
 * check-kornokta-helper-acl.ts
 *
 * 20260821130000 — `tevatur_kn_min_viable_team_size()` ACL sıkılaştırmasını
 * doğrular.
 *
 * NEDEN VAR
 * ─────────
 * Yardımcıyı istemci rollerinden kapatmak tek satırlık bir revoke; RİSK
 * revoke'un kendisinde değil, YAN ETKİSİNDE: `tevatur_kn_leave_match` bu
 * yardımcıyı gövdesinden çağırıyor. Eğer SECURITY DEFINER'ın sahip yetkisi
 * beklendiği gibi devreye girmezse (ya da yardımcı planlayıcı tarafından
 * çağıranın bağlamında çözülürse) revoke, misafirin ve kayıtlı kullanıcının
 * maçtan ÇIKAMAMASINA yol açardı — hem de yalnız canlıda görülecek şekilde.
 * Bu yüzden burada hem "doğrudan çağrı reddediliyor mu" hem de "çıkış akışının
 * TAMAMI hâlâ çalışıyor mu" gerçek Postgres'te koşularak doğrulanır.
 *
 * İKİ KATMAN
 *   A) STATİK — migration yalnız ACL değiştiriyor mu (CREATE/REPLACE yok,
 *      definer yok, search_path yok, başka nesneye dokunma yok).
 *   B) RUNTIME — clean-room: bootstrap → repo-truth bağımlılıklar →
 *      20260821120000 → 20260821130000 → (1) ACL probe'ları, (2) 20260821120000
 *      için yazılmış DAVRANIŞ süitinin TAMAMI yeniden koşulur. İkincisi
 *      "leave flow still works" kanıtıdır: 41 assert, kilitlenmiş ACL altında.
 *      Postgres yoksa katman ATLANIR. Zorunlu: KN_ACL_REQUIRE_RUNTIME=1
 *
 * PRODUCTION'A HİÇBİR ŞEY YAZMAZ — yalnız yerel clean-room veritabanı.
 *
 * Çalıştır:  npx tsx scripts/check-kornokta-helper-acl.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const BASE = "supabase/migrations/20260821120000_kornokta_leave_match_team_viability.sql";
const ACL  = "supabase/migrations/20260821130000_kornokta_helper_acl_hardening.sql";

const acl = readFileSync(join(ROOT, ACL), "utf8");
const naked = acl.replace(/--.*$/gm, "");

/* ════════════════════════════════════════════════════════════════════════
   A) STATİK
════════════════════════════════════════════════════════════════════════ */
console.log("\nA) Statik — migration yalnız ACL değiştiriyor");

ok(/revoke execute on function public\.tevatur_kn_min_viable_team_size\(\) from anon;/.test(naked),
   "anon'dan EXECUTE revoke ediliyor");
ok(/revoke execute on function public\.tevatur_kn_min_viable_team_size\(\) from authenticated;/.test(naked),
   "authenticated'dan EXECUTE revoke ediliyor");
ok(/revoke all\s+on function public\.tevatur_kn_min_viable_team_size\(\) from public;/.test(naked),
   "PUBLIC'ten revoke ediliyor");
ok(/to_regprocedure\('public\.tevatur_kn_min_viable_team_size\(\)'\)/.test(naked),
   "revoke öncesi imza kimliği doğrulanıyor (yanlış imzaya atmıyor)");

ok(!/create or replace function/i.test(naked) && !/create function/i.test(naked),
   "hiçbir fonksiyon CREATE/REPLACE edilmiyor (gövde/imza korunuyor)");
ok(!/security definer/i.test(naked), "yardımcı SECURITY DEFINER yapılmıyor");
ok(!/set search_path/i.test(naked), "gereksiz search_path eklenmiyor");
ok(!/\bgrant\b/i.test(naked), "hiçbir yeni GRANT verilmiyor");

// Başka nesneye dokunmama.
const revokedFns = [...naked.matchAll(/revoke[\s\S]*?on function ([^\s(]+)/gi)].map(m => m[1]);
ok(revokedFns.every(f => f === "public.tevatur_kn_min_viable_team_size"),
   "revoke YALNIZ yardımcıyı hedefliyor", revokedFns);
ok(!/tevatur_kn_leave_match/.test(naked),
   "çıkış RPC'sinin ACL'ine dokunulmuyor");
for (const forbidden of ["create table", "alter table", "drop ", "create policy", "create trigger", "alter role"]) {
  ok(!new RegExp(forbidden, "i").test(naked), `'${forbidden}' içermiyor`);
}
for (const other of ["wheel_duel", "flag_duel", "conquest_", "route_duel", "duel_group"]) {
  ok(!naked.includes(other), `başka moda dokunmuyor (${other})`);
}

// 20260821120000 DEĞİŞMEMİŞ olmalı — üretimde uygulanmış dosya.
const base = readFileSync(join(ROOT, BASE), "utf8");
ok(/grant  execute on function public\.tevatur_kn_min_viable_team_size\(\) to anon, authenticated;/.test(base),
   "uygulanmış 20260821120000 DEĞİŞTİRİLMEDİ (orijinal grant satırı yerinde)");

/* ════════════════════════════════════════════════════════════════════════
   B) RUNTIME — clean-room
════════════════════════════════════════════════════════════════════════ */
function extractFn(file: string, name: string): string {
  const text = readFileSync(join(ROOT, "supabase/migrations", file), "utf8");
  const start = text.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const end = text.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`${name} body end not found in ${file}`);
  return text.slice(start, end + 4);
}

const BOOTSTRAP = String.raw`
drop schema if exists public cascade;
create schema public;
drop schema if exists auth cascade;
create schema auth;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('torble.uid', true), '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated;
create table public.tevatur_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'waiting' check (status in ('waiting','playing','finished')),
  round_count int not null default 10,
  photo_seconds int not null default 10,
  max_players int not null default 10,
  mole_enabled boolean not null default false,
  host_player_id uuid null,
  game_state jsonb null,
  started_at timestamptz null,
  finished_at timestamptz null,
  finished_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.tevatur_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.tevatur_rooms(id) on delete cascade,
  profile_id uuid null,
  guest_id text null,
  name text not null,
  team text null check (team in ('blue','red')),
  score int not null default 0,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table public.tevatur_player_claims (
  player_id uuid primary key references public.tevatur_players(id) on delete cascade,
  claim_token uuid not null,
  created_at timestamptz not null default now()
);
`;

const DB = "kn_acl_check";

function findContainer(): string | null {
  const explicit = process.env.KN_ACL_PG_CONTAINER;
  if (explicit) return explicit;
  try {
    const out = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.trim().split("\n").filter(Boolean)) {
      const [name, image] = line.split("\t");
      if (image?.includes("postgres")) return name;
    }
  } catch { /* docker yok */ }
  return null;
}

function psql(container: string, db: string, input: string, tuples = false) {
  const args = ["exec", "-i", container, "psql", "-U", "postgres", "-d", db,
                "-q", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-A", "-t");
  args.push("-f", "-");
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

const container = findContainer();

if (!container) {
  console.log("\nB) Runtime clean-room");
  console.log("  ⚠ ATLANDI — çalışan postgres container'ı bulunamadı.");
  console.log("    (KN_ACL_PG_CONTAINER=<ad> ile elle gösterilebilir.)");
  if (process.env.KN_ACL_REQUIRE_RUNTIME === "1") {
    console.log("  ✗ KN_ACL_REQUIRE_RUNTIME=1 → runtime katmanı ZORUNLU");
    failed++;
  }
} else {
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, BOOTSTRAP);
  psql(container, DB, extractFn("20260713120000_kornokta_gameplay.sql", "tevatur_kn_now_ms"));
  psql(container, DB, extractFn("20260809120000_guest_browse_gate_and_kornokta.sql", "tevatur_authorize_player"));
  psql(container, DB, extractFn("20260810120000_conquest_guest_read_lockdown_and_host_rules.sql", "tevatur_leave_room"));
  psql(container, DB, readFileSync(join(ROOT, BASE), "utf8"));

  // ── Revoke ÖNCESİ kontrol: yardımcı gerçekten açık mıydı? ──
  console.log(`\nB1) Runtime · revoke ÖNCESİ taban durum · container=${container}`);
  const before = psql(container, DB,
    `select has_function_privilege('anon','public.tevatur_kn_min_viable_team_size()','execute')::text;`,
    true).trim();
  ok(before === "true",
     "revoke öncesi anon EXECUTE'a SAHİPTİ (bu migration gerçekten bir şey değiştiriyor)", before);

  // ── ACL migration'ı uygula ──
  psql(container, DB, readFileSync(join(ROOT, ACL), "utf8"));

  console.log("\nB2) Runtime · ACL probe'ları (revoke SONRASI)");
  for (const line of psql(container, DB,
      readFileSync(join(here, "korNokta/helper-acl-probe.sql"), "utf8"), true)
      .trim().split("\n").filter(Boolean)) {
    const [label, got, want] = line.split("|");
    ok(got === want, label, got === want ? undefined : { got, want });
  }

  // ── LEAVE FLOW STILL WORKS: 20260821120000'in davranış süiti, kilitli ACL altında ──
  console.log("\nB3) Runtime · çıkış akışının TAMAMI (kilitli ACL altında)");
  for (const line of psql(container, DB,
      readFileSync(join(here, "korNokta/leave-match-suite.sql"), "utf8"), true)
      .trim().split("\n").filter(Boolean)) {
    const [label, got, want] = line.split("|");
    ok(got === want, label, got === want ? undefined : { got, want });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
