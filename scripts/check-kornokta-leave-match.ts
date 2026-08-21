/**
 * check-kornokta-leave-match.ts
 *
 * Kör Nokta AKTİF MAÇTAN AYRILMA sözleşmesini kilitler (20260821120000).
 *
 * NEDEN VAR
 * ─────────
 * Kör Nokta'nın tek çıkış yolu `tevatur_leave_room`du ve o fonksiyon oda
 * DURUMUNU hiç sormuyordu: canlı bir 2v2'de ayrılan oyuncunun satırı silinip
 * `status` 'playing' KALIYOR, `game_state.teams` hâlâ o oyuncuyu taşıyordu.
 * Kalan üç oyuncunun maçı, bir takımı tek kişiye düşmüş hâlde sürüyor ve
 * kimseye "oyuncu ayrıldı / maç bitti" DENMİYORDU. Üstelik çıkışta hiçbir onay
 * yoktu — geri tuşuna yanlışlıkla dokunmak maçı terk ettiriyordu.
 *
 * İKİ KATMAN
 * ──────────
 *   A) STATİK — bağımlılıksız. Sunucu kontrollerinin VARLIĞI ve SIRASI, grant
 *      modeli, istemcinin doğru RPC'yi çağırdığı, onay kapısının canlı maça
 *      bağlı olduğu, terkedilmiş maçın XP tetikleyen fazı YAZMADIĞI ve kapsam
 *      koruması (başka mod/şema değişmedi).
 *   B) RUNTIME — gerçek Postgres'te clean-room. Şema + repo-truth
 *      `tevatur_authorize_player` / `tevatur_leave_room` gövdeleri migration
 *      dosyalarından ÇIKARILIP yüklenir (kopya değil), sonra bu turun
 *      migration'ı uygulanır ve 2v2 / 3v3 / güvenlik / idempotency senaryoları
 *      GERÇEKTEN çalıştırılır. Postgres yoksa katman ATLANIR (uyarıyla).
 *      Zorunlu kılmak için: KN_LEAVE_REQUIRE_RUNTIME=1
 *
 * Postgres keşfi: çalışan ilk `postgres*` imajlı docker container.
 * Elle seçmek için: KN_LEAVE_PG_CONTAINER=<container adı>
 *
 * PRODUCTION'A HİÇBİR ŞEY YAZMAZ — yalnız yerel clean-room veritabanı.
 *
 * Çalıştır:  npx tsx scripts/check-kornokta-leave-match.ts
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
const MIGRATION = "supabase/migrations/20260821120000_kornokta_leave_match_team_viability.sql";

const sql  = readFileSync(join(ROOT, MIGRATION), "utf8");
const mode = readFileSync(join(ROOT, "src/modes/korNokta/KorNoktaMode.tsx"), "utf8");

/* ════════════════════════════════════════════════════════════════════════
   A) STATİK
════════════════════════════════════════════════════════════════════════ */
console.log("\nA) Statik — sunucu sözleşmesi");

ok(/create or replace function public\.tevatur_kn_leave_match\(/.test(sql),
   "tevatur_kn_leave_match tanımlanıyor");
ok(/security definer/.test(sql), "SECURITY DEFINER");
ok(/set search_path = public, auth/.test(sql), "search_path sabitlenmiş");

// Kontrol SIRASI: kimlik → kilit → üyelik → durum dalı.
const iAuth   = sql.indexOf("tevatur_authorize_player(p_player_id, p_claim_token)");
const iLock   = sql.indexOf("from public.tevatur_rooms where id = p_room_id for update");
const iMember = sql.indexOf("where id = p_player_id and room_id = p_room_id");
const iBranch = sql.indexOf("v_room.status <> 'playing'");
ok(iAuth > 0 && iLock > iAuth, "kimlik doğrulaması KİLİTTEN önce");
ok(iMember > iLock, "üyelik kontrolü kilitten SONRA (kanonik satır)");
ok(iBranch > iMember, "durum dalı üyelikten SONRA");
ok(/raise exception 'unauthorized' using errcode = '42501'/.test(sql),
   "yetkisiz çağrı exception ile reddediliyor");

// Cross-room: üyelik sorgusu ROOM_ID ile bağlı olmalı.
ok(/from public\.tevatur_players\s*\n\s*where id = p_player_id and room_id = p_room_id/.test(sql),
   "üyelik sorgusu room_id'ye bağlı → cross-room terk imkânsız");

// Lobi/terminal dalı mevcut davranışa devreder.
ok(/perform public\.tevatur_leave_room\(p_room_id, p_player_id, p_claim_token\)/.test(sql),
   "status <> 'playing' → mevcut tevatur_leave_room'a devrediliyor");

// Terminal durum + ödül YOK.
ok(/finished_reason = 'abandoned'/.test(sql), "terminal reason = 'abandoned'");
ok(/status\s*=\s*'finished'/.test(sql), "terminal status = 'finished'");
ok(!/final_results/.test(sql.replace(/--.*$/gm, "")),
   "gövde game_state.phase'i 'final_results' YAPMIYOR (XP tetiklenmez)");
ok(!/winner|xp_events|award_/.test(sql.replace(/--.*$/gm, "")),
   "gövde kazanan/XP/ödül yazmıyor");
ok(/'\{phaseEndsAt\}', 'null'::jsonb/.test(sql),
   "phaseEndsAt null'a çekiliyor → istemci sayaçları durur");

// Yaşayabilirlik kuralı tek yerde.
ok(/create or replace function public\.tevatur_kn_min_viable_team_size\(\)/.test(sql),
   "minimum yaşayabilir takım tek fonksiyonda");
ok(/v_remaining < public\.tevatur_kn_min_viable_team_size\(\)/.test(sql),
   "karar o fonksiyondan okunuyor (dağınık sabit yok)");
ok(/select count\(\*\) into v_remaining[\s\S]{0,160}from public\.tevatur_players/.test(sql),
   "kalan sayı GERÇEK oyuncu satırlarından sayılıyor (game_state'ten değil)");

// Devam eden maç için state kırpma.
ok(/array\['teams', v_team\]/.test(sql), "ayrılan oyuncu teams'ten düşülüyor");
ok(/array\['detectiveOrder', v_team\]/.test(sql),
   "ayrılan oyuncu detectiveOrder'dan düşülüyor (rotasyon hayalet seçmez)");

// Oda silinmemeli (kalan oyuncular terminal ekranı okuyabilsin).
ok(!/delete from public\.tevatur_rooms/.test(sql),
   "terk dalında oda satırı SİLİNMİYOR");

// Grant modeli: misafir + kayıtlı aynı kural.
ok(/grant\s+execute on function public\.tevatur_kn_leave_match\(uuid, uuid, uuid\) to anon/.test(sql),
   "anon (misafir) execute alıyor");
ok(/grant\s+execute on function public\.tevatur_kn_leave_match\(uuid, uuid, uuid\) to authenticated/.test(sql),
   "authenticated execute alıyor");
ok(/revoke all\s+on function public\.tevatur_kn_leave_match\(uuid, uuid, uuid\) from public/.test(sql),
   "public'ten revoke ediliyor");

// Kapsam: şema/başka mod değişmiyor.
for (const forbidden of ["create table", "alter table", "drop table", "create policy", "create trigger"]) {
  ok(!new RegExp(forbidden, "i").test(sql.replace(/--.*$/gm, "")),
     `migration '${forbidden}' içermiyor (şema değişmiyor)`);
}
for (const other of ["wheel_duel", "flag_duel", "conquest_", "route_duel", "duel_group"]) {
  ok(!sql.replace(/--.*$/gm, "").includes(other), `başka moda dokunmuyor (${other})`);
}

// Bu turun düzeltmesi İKİ dış değişmezin üstünde duruyor. İkisi de başka
// dosyalarda yaşıyor, yani sessizce kayabilirler — burada kilitleniyorlar.
console.log("\nA) Statik — dayanılan dış değişmezler");
const advanceSql = readFileSync(join(ROOT,
  "supabase/migrations/20260813120000_kornokta_advance_if_due.sql"), "utf8");
ok(/if v_room\.status <> 'playing' or v_room\.game_state is null then\s*\n\s*return v_room;/
     .test(advanceSql),
   "advance_if_due 'playing' değilse no-op → terminal maç İLERLEMEZ");

const game = readFileSync(join(ROOT, "src/modes/korNokta/KorNoktaGame.tsx"), "utf8");
ok(/if \(phase !== "final_results"\) return;/.test(game),
   "XP yalnız phase==='final_results' iken veriliyor → terk edilen maç XP üretmez");

console.log("\nA) Statik — istemci sözleşmesi");
ok(/supabase\.rpc\("tevatur_kn_leave_match"/.test(mode),
   "istemci yeni durum-duyarlı RPC'yi çağırıyor");
ok(!/supabase\.rpc\("tevatur_leave_room"/.test(mode),
   "istemci artık ham tevatur_leave_room'u DOĞRUDAN çağırmıyor");
ok(/const knMatchActive =[\s\S]{0,140}room\.status === "playing"/.test(mode),
   "onay kapısı CANLI maça bağlı");
ok(/if \(knMatchActive\) \{ setLeaveConfirmOpen\(true\); return; \}/.test(mode),
   "canlı maçta çıkış önce onay açıyor (doğrudan leave YOK)");
ok((mode.match(/if \(knMatchActive\) \{ setLeaveConfirmOpen\(true\); return; \}/g) ?? []).length >= 2,
   "hem header geri düğmesi hem oyun-içi çıkış aynı kapıdan geçiyor");
// `window.confirm` ÇAĞRISI aranır, kelimenin kendisi değil — açıklama
// yorumlarında geçmesi ihlal değildir.
ok(/<ConfirmDialog/.test(mode) && !/window\.confirm\s*\(/.test(mode),
   "paylaşılan ConfirmDialog kullanılıyor, window.confirm çağrısı YOK");
ok(/onCancel=\{\(\) => \{[\s\S]{0,200}setLeaveConfirmOpen\(false\);/.test(mode),
   "Vazgeç yalnız modalı kapatıyor (state değişmiyor)");
ok(/if \(leaving\) return;/.test(mode), "çift onay tıklaması engelleniyor (tek atış)");
ok(/room\.finished_reason === "abandoned"/.test(mode),
   "terminal ekran SUNUCU alanından türetiliyor");
ok(/knInGame && !knAbandoned/.test(mode),
   "terkedilmiş maçta gameplay mount EDİLMİYOR (faz sayaçları durur)");
ok(/Takımda yeterli oyuncu kalmadığı için oyun sona erdi/.test(mode),
   "kalan oyunculara istenen mesaj gösteriliyor");

/* ════════════════════════════════════════════════════════════════════════
   B) RUNTIME — clean-room (gerçek Postgres)
════════════════════════════════════════════════════════════════════════ */

/** Migration metninden bir fonksiyon tanımını AYNEN çıkarır (kopya değil,
 *  repo-truth). `create or replace function public.<ad>(` → ilk `\n$$;`. */
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

-- Repo-truth şekiller (20260711120000 + 20260713120000 + 20260714120000).
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

const DB = "kn_leave_check";

function findContainer(): string | null {
  const explicit = process.env.KN_LEAVE_PG_CONTAINER;
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
  console.log("    (KN_LEAVE_PG_CONTAINER=<ad> ile elle gösterilebilir.)");
  if (process.env.KN_LEAVE_REQUIRE_RUNTIME === "1") {
    console.log("  ✗ KN_LEAVE_REQUIRE_RUNTIME=1 → runtime katmanı ZORUNLU");
    failed++;
  }
} else {
  console.log(`\nB) Runtime clean-room · container=${container}`);
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, BOOTSTRAP);
  // Repo-truth bağımlılıklar — kopyalanmaz, migration dosyalarından çıkarılır.
  psql(container, DB, extractFn("20260713120000_kornokta_gameplay.sql", "tevatur_kn_now_ms"));
  psql(container, DB, extractFn("20260809120000_guest_browse_gate_and_kornokta.sql", "tevatur_authorize_player"));
  psql(container, DB, extractFn("20260810120000_conquest_guest_read_lockdown_and_host_rules.sql", "tevatur_leave_room"));
  // Bu turun migration'ı.
  psql(container, DB, readFileSync(join(ROOT, MIGRATION), "utf8"));

  const SUITE = readFileSync(join(here, "korNokta/leave-match-suite.sql"), "utf8");
  const raw = psql(container, DB, SUITE, true);
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const [label, got, want] = line.split("|");
    ok(got === want, label, got === want ? undefined : { got, want });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
