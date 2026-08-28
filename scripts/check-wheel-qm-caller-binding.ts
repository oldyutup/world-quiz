/**
 * check-wheel-qm-caller-binding.ts — 20260827150000'in clean-room doğrulaması
 * (GERÇEK Postgres, docker; canlıya DOKUNMAZ).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DOĞRULANAN SORUN
 * ────────────────
 *   `wheel_duel_quick_match` eşleşme bulduğunda ÇAĞIRAN taraf için hiçbir
 *   kuyruk YAZIMI yapmaz (bekleyenin satırını UPDATE eder, çağıranın eski
 *   satırını DELETE eder). 20260827140000'in sahiplik trigger'ı kuyruğa bağlı
 *   olduğu için çağıran sahipsiz kalır → authorize=false → claim 42501.
 *
 *   Bu dosya önce AÇIĞI ÜRETİR (yalnız 140000 ile), sonra 150000 ile
 *   KAPANDIĞINI gösterir.
 *
 * ŞEMA KAYNAĞI — VARSAYIM YOK
 * ───────────────────────────
 *   `wheel_duel_queue` şeması ve KISITLARI üretimden alınan yetkili listedir:
 *     PK(profile_id) · UNIQUE(player_id)
 *     FK matched_room_id → wheel_duel_rooms(id) ON DELETE SET NULL
 *     FK profile_id     → auth.users(id)        ON DELETE CASCADE
 *     CHECK duration_seconds IN (60,120,180,300)
 *     CHECK max_level_diff >= 0
 *     CHECK region IN (world, europe, asia, africa, north_america,
 *                      south_america, oceania)
 *     kolonlar: profile_id, player_id, player_name, duration_seconds, region,
 *               mode_xp, mode_level, max_level_diff, matched_room_id,
 *               created_at, expires_at   (updated_at YOK)
 *
 *   `wheel_duel_quick_match` MODELİ, üretimden bildirilen ALTI ADIMIN birebir
 *   karşılığıdır (oda → bekleyen oyuncu → çağıran oyuncu → bekleyenin kuyruk
 *   UPDATE'i → çağıranın kuyruk DELETE'i → matched=true) + bekleyen tarafın
 *   YOKLAMA dalı. Gerçek gövde repoda olmadığı için MODELDİR.
 *
 * 150000 TASARIMI — FONKSİYON TABANLI, GENEL TRIGGER YOK
 * ─────────────────────────────────────────────────────
 *   Canlı fonksiyon `_wheel_duel_quick_match_core` adına TAŞINIR (rename →
 *   gövde bit-bit aynı pg_proc satırı) ve AYNI imzayla yeni
 *   `wheel_duel_quick_match` kurulur: çekirdeği çağırır, sonucu değiştirmeden
 *   döndürür, matched=true ise İKİ tarafın sahipliğini bağlar.
 *
 *   Bu yüzden testin doğruluğu çekirdeğin İÇERİĞİNE bağlı DEĞİLDİR; bölüm 4
 *   bunu TAMAMEN FARKLI yazım sıralı bir çekirdekle ayrıca kanıtlar ve
 *   bölüm 6 çekirdek gövdesinin `prosrc` md5'inin DEĞİŞMEDİĞİNİ doğrular.
 *
 * Çalıştır:  npx tsx scripts/check-wheel-qm-caller-binding.ts
 *   Konteyner: WHEEL_SEC_PG_CONTAINER=<ad> (varsayılan: çalışan ilk
 *   `postgres:` imajlı konteyner; `supabase_*` adları dışlanır).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = "wheel_qm_caller";
const MIG_140 = readFileSync(join(ROOT, "supabase/migrations/20260827140000_wheel_duel_quick_match_durable_identity.sql"), "utf8");
const MIG_150 = readFileSync(join(ROOT, "supabase/migrations/20260827150000_wheel_duel_quick_match_bind_players.sql"), "utf8");

let passed = 0, failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `   (got ${JSON.stringify(got)})` : ""}`); }
}
const section = (t: string) => console.log(`\n${t}`);
function errText(e: unknown): string {
  const x = e as { stderr?: string | Buffer; message?: string };
  return ((x?.stderr ? String(x.stderr) : "") || x?.message || String(e)).replace(/\s+/g, " ").trim();
}

function findContainer(): string | null {
  const explicit = process.env.WHEEL_SEC_PG_CONTAINER;
  if (explicit) return explicit;
  try {
    const out = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.trim().split("\n").filter(Boolean)) {
      const [name, image] = line.split("\t");
      if (name.startsWith("supabase_")) continue;
      if (image?.startsWith("postgres:")) return name;
    }
  } catch { /* docker yok */ }
  return null;
}
function psql(c: string, db: string, input: string, tuples = false): string {
  const args = ["exec", "-i", c, "psql", "-U", "postgres", "-d", db, "-q", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-A", "-t");
  args.push("-f", "-");
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}
const last = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "";

/* ── Kimlikler ─────────────────────────────────────────────────────────── */
const U_A = "00000000-0000-4000-8000-00000000000a";   // bekleyen  (önce girer)
const U_B = "00000000-0000-4000-8000-00000000000b";   // çağıran   (ikinci basar)
const U_X = "00000000-0000-4000-8000-00000000000c";   // saldırgan
const P_A = "00000000-0000-4000-8000-0000000000a1";
const P_B = "00000000-0000-4000-8000-0000000000b1";
const P_VICTIM_CODE = "00000000-0000-4000-8000-0000000000c1";  // oda-kodu oyuncusu
const ROOM_CODE_ROOM = "00000000-0000-4000-8000-00000000cd01";

/* ── L0: ÜRETİM ŞEMASI (yetkili kısıtlarla) ────────────────────────────── */
const L0 = String.raw`
drop schema if exists public cascade;  create schema public;
drop schema if exists auth   cascade;  create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;

create table auth.users (id uuid primary key);
insert into auth.users (id) values ('${U_A}'), ('${U_B}'), ('${U_X}');

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('torble.uid', true), '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated;

create table public.wheel_duel_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'waiting' check (status in ('waiting','playing','finished')),
  duration_seconds int not null default 60,
  region text not null default 'world',
  host_player_id uuid null,
  room_source text not null default 'manual',
  started_at timestamptz null, finished_at timestamptz null,
  finished_reason text null, winner_player_id uuid null,
  current_target_topoid text null,
  used_target_topoids text[] not null default '{}',
  pass_requested_by uuid[] not null default '{}',
  pass_target_topoid text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.wheel_duel_players (
  id uuid primary key,
  room_id uuid not null references public.wheel_duel_rooms(id) on delete cascade,
  name text not null, score int not null default 0,
  profile_id uuid null, guest_id text null,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table public.wheel_duel_player_claims (
  player_id uuid primary key references public.wheel_duel_players(id) on delete cascade,
  claim_token uuid not null
);
-- ÜRETİM KISITLARI BİREBİR
create table public.wheel_duel_queue (
  profile_id       uuid primary key references auth.users(id) on delete cascade,
  player_id        uuid not null unique,
  player_name      text not null,
  duration_seconds int  not null check (duration_seconds in (60,120,180,300)),
  region           text not null check (region in ('world','europe','asia','africa',
                                                   'north_america','south_america','oceania')),
  mode_xp          int  not null default 0,
  mode_level       int  not null default 1,
  max_level_diff   int  not null default 0 check (max_level_diff >= 0),
  matched_room_id  uuid null references public.wheel_duel_rooms(id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '45 seconds')
);
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- 20260814180000 · sertleştirilmiş authorize (140000 öncesi hâli)
create or replace function public.wheel_duel_authorize_player(
  p_player_id uuid, p_claim_token uuid
) returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.wheel_duel_players p
      left join public.wheel_duel_player_claims c on c.player_id = p.id
     where p.id = p_player_id
       and ((p.profile_id is not null and p.profile_id = auth.uid())
         or (p.profile_id is null and p.guest_id is not null
             and p_claim_token is not null and c.claim_token = p_claim_token))
  )
  or exists (select 1 from public.wheel_duel_queue q
              where q.player_id = p_player_id
                and q.profile_id is not null and q.profile_id = auth.uid());
$$;
grant execute on function public.wheel_duel_authorize_player(uuid,uuid) to anon, authenticated;

-- 20260529120000 · claim_target (BİREBİR)
create or replace function public.wheel_duel_claim_target(
  p_room_id uuid, p_player_id uuid, p_claim_token uuid, p_target text
) returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_claimed uuid; v_score int;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode='42501';
  end if;
  if not exists (select 1 from public.wheel_duel_players
                  where id = p_player_id and room_id = p_room_id) then
    raise exception 'player_room_mismatch' using errcode='42501';
  end if;
  update public.wheel_duel_rooms
     set current_target_topoid = null,
         used_target_topoids = array_append(coalesce(used_target_topoids,'{}'), p_target)
   where id = p_room_id and status='playing' and current_target_topoid = p_target
  returning id into v_claimed;
  if v_claimed is null then return jsonb_build_object('claimed', false); end if;
  update public.wheel_duel_players set score = score + 1 where id = p_player_id
    returning score into v_score;
  return jsonb_build_object('claimed', true, 'new_score', v_score);
end $$;
grant execute on function public.wheel_duel_claim_target(uuid,uuid,uuid,text) to anon, authenticated;

-- 20260814160000 · leave_room (yetki kontrolü aynı)
create or replace function public.wheel_duel_leave_room(
  p_room_id uuid, p_player_id uuid, p_claim_token uuid
) returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode='42501';
  end if;
  if not exists (select 1 from public.wheel_duel_players
                  where id = p_player_id and room_id = p_room_id) then
    raise exception 'player_room_mismatch' using errcode='42501';
  end if;
  update public.wheel_duel_rooms set status='finished', finished_at=now()
   where id = p_room_id and status='playing';
end $$;
grant execute on function public.wheel_duel_leave_room(uuid,uuid,uuid) to anon, authenticated;

revoke insert, update, delete on table public.wheel_duel_queue from anon;
revoke insert, update, delete on table public.wheel_duel_queue from authenticated;
revoke insert, update, delete on table public.wheel_duel_queue from public;
`;

/* ── wheel_duel_quick_match MODELİ (bildirilen ALTI ADIM) ──────────────── */
const QM = String.raw`
create or replace function public.wheel_duel_quick_match(
  p_profile_id uuid, p_player_id uuid, p_player_name text,
  p_duration integer, p_region text, p_max_level_diff integer,
  p_room_code text, p_first_target text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_match public.wheel_duel_queue; v_existing public.wheel_duel_queue; v_room uuid;
begin
  if auth.uid() is null then raise exception 'auth_required' using errcode='42501'; end if;
  if auth.uid() <> p_profile_id then raise exception 'auth_mismatch' using errcode='42501'; end if;

  delete from public.wheel_duel_queue
   where expires_at < now() and matched_room_id is null and profile_id = p_profile_id;

  -- YOKLAMA DALI: bekleyen taraf her tick'te tekrar çağırır; satırı eşleşmişse
  -- matched=true döner ve my_player_id KUYRUK SATIRINDAN gelir (istemciden DEĞİL).
  select * into v_existing from public.wheel_duel_queue where profile_id = p_profile_id;
  if found and v_existing.matched_room_id is not null then
    return jsonb_build_object('matched', true, 'room_id', v_existing.matched_room_id,
      'my_player_id', v_existing.player_id, 'opponent_name', null);
  end if;

  select * into v_match from public.wheel_duel_queue q
   where q.profile_id <> p_profile_id
     and q.matched_room_id is null
     and q.duration_seconds = p_duration
     and q.region = p_region
     and q.expires_at > now()
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- 1) oda
    insert into public.wheel_duel_rooms
      (code, status, duration_seconds, region, host_player_id, room_source,
       started_at, current_target_topoid)
    values (p_room_code, 'playing', p_duration, p_region, v_match.player_id,
            'quick_match', now() + interval '3 seconds', p_first_target)
    returning id into v_room;
    -- 2) BEKLEYEN oyuncu satırı  (kimlik kolonu YAZILMAZ)
    insert into public.wheel_duel_players (id, room_id, name)
      values (v_match.player_id, v_room, v_match.player_name);
    -- 3) ÇAĞIRAN oyuncu satırı   (kimlik kolonu YAZILMAZ)
    insert into public.wheel_duel_players (id, room_id, name)
      values (p_player_id, v_room, p_player_name);
    -- 4) YALNIZ bekleyenin kuyruk satırı güncellenir
    update public.wheel_duel_queue set matched_room_id = v_room
     where profile_id = v_match.profile_id;
    -- 5) ÇAĞIRANIN eski kuyruk satırı SİLİNİR (yeni satır YAZILMAZ)
    delete from public.wheel_duel_queue where profile_id = p_profile_id;
    -- 6) dönüş
    return jsonb_build_object('matched', true, 'room_id', v_room,
      'room_code', p_room_code, 'my_player_id', p_player_id,
      'opponent_name', v_match.player_name, 'caller_is_host', false,
      'host_player_id', v_match.player_id);
  end if;

  insert into public.wheel_duel_queue as q
    (profile_id, player_id, player_name, duration_seconds, region, max_level_diff)
  values (p_profile_id, p_player_id, p_player_name, p_duration, p_region, p_max_level_diff)
  on conflict (profile_id) do update
    set player_id = excluded.player_id, player_name = excluded.player_name,
        duration_seconds = excluded.duration_seconds, region = excluded.region,
        max_level_diff = excluded.max_level_diff, matched_room_id = null,
        created_at = now(), expires_at = now() + interval '45 seconds';
  return jsonb_build_object('queued', true, 'matched', false);
end $$;
-- ÜRETİM proacl'i BİREBİR:
--   {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- Baştaki boş grantee (=X/postgres) PUBLIC'in EXECUTE'udur: clean-room bunu
-- MUTLAKA taşımalı, yoksa "PUBLIC üzerinden çekirdeğe erişim" senaryosu hiç
-- test edilmemiş olur.
grant execute on function public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text) to public;
grant execute on function public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text) to anon, authenticated, service_role;
`;

/* ── Kurban: oda-kodu oyuncusu (kimliği DOLU) ──────────────────────────── */
const FIXTURE = String.raw`
insert into public.wheel_duel_rooms (id, code, status, current_target_topoid, started_at)
values ('${ROOM_CODE_ROOM}', 'CODE01', 'playing', '792', now());
insert into public.wheel_duel_players (id, room_id, name, profile_id)
values ('${P_VICTIM_CODE}', '${ROOM_CODE_ROOM}', 'victim', '${U_B}');
`;

/* ══════════════════════════════════════════════════════════════════════════ */
const c = findContainer();
if (!c) { console.error("✗ postgres konteyneri yok (WHEEL_SEC_PG_CONTAINER=<ad>)"); process.exit(1); }
console.log(`clean-room konteyneri: ${c}   (db: ${DB})`);

const asUser = (uid: string, body: string) => String.raw`
begin;
select set_config('torble.uid', '${uid}', false);
set local role authenticated;
${body}
commit;`;

const SIG_PUB  = "public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)";
const SIG_CORE = "public._wheel_duel_quick_match_core(uuid,uuid,text,integer,text,integer,text,text)";

/** 150000 UYGULANMADAN ÖNCEKİ canlı fonksiyonun parmak izi (her build'de tazelenir). */
let BASELINE: { secdef: string; cfg: string; src: string; acl: string };

function build(withMig150: boolean, core: string = QM) {
  psql(c!, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(c!, DB, L0);
  psql(c!, DB, core);
  psql(c!, DB, FIXTURE);
  psql(c!, DB, MIG_140);
  BASELINE = fingerprint(SIG_PUB);          // ← 150000 ÖNCESİ referans
  if (withMig150) psql(c!, DB, MIG_150);
}

/** Fonksiyonun kimlik/ACL parmak izi (rename SONRASI değişmemeli). */
function fingerprint(sig: string):
  { secdef: string; cfg: string; src: string; acl: string; proacl: string; pub: string } {
  const q = (expr: string) => last(psql(c!, DB,
    `select coalesce((${expr})::text, '(null)') from pg_proc where oid = to_regprocedure('${sig}');`, true));
  return {
    secdef: q("prosecdef"),
    cfg:    q("array_to_string(proconfig, '|')"),
    src:    q("md5(prosrc)"),
    proacl: q("array_to_string(proacl, ',')"),
    pub:    q("exists (select 1 from aclexplode(pg_proc.proacl) a where a.grantee = 0)"),
    acl:    last(psql(c!, DB,
      `select has_function_privilege('anon','${sig}','EXECUTE')::text||','||
              has_function_privilege('authenticated','${sig}','EXECUTE')::text||','||
              has_function_privilege('service_role','${sig}','EXECUTE')::text;`, true)),
  };
}

/** A önce kuyruğa girer, B ikinci basıp EŞLEŞMEYİ TETİKLER. */
function runMatch(): { room: string } {
  psql(c!, DB, asUser(U_A,
    `select public.wheel_duel_quick_match('${U_A}','${P_A}','A',60,'world',0,'WAAAAA','792');`));
  const out = psql(c!, DB, asUser(U_B,
    `select (public.wheel_duel_quick_match('${U_B}','${P_B}','B',60,'world',0,'WBBBBB','792'))->>'room_id';`), true);
  return { room: last(out) };
}
const ownerOf = (pid: string) => last(psql(c!, DB,
  `select coalesce((select profile_id::text from public.wheel_duel_quick_match_owners
                     where player_id='${pid}'), '(yok)');`, true));
const authAs = (uid: string, pid: string) => last(psql(c!, DB,
  asUser(uid, `select public.wheel_duel_authorize_player('${pid}'::uuid, null)::text;`), true));
function claimAs(uid: string, pid: string, room: string) {
  try {
    const t = last(psql(c!, DB, `select coalesce(current_target_topoid,'-') from public.wheel_duel_rooms where id='${room}';`, true));
    if (t === "-") return "hedef-yok";
    return last(psql(c!, DB, asUser(uid,
      `select (public.wheel_duel_claim_target('${room}','${pid}',null,'${t}'))->>'claimed';`), true));
  } catch (e) { return "ERR:" + errText(e).slice(0, 80); }
}

/* ═══════════ 1) AÇIK: yalnız 140000 ile çağıran taraf sahipsiz ═══════════ */
section("1) AÇIK ÜRETİLİYOR — yalnız 140000 (canlı hâl)");
{
  build(false);
  const { room } = runMatch();
  ok(room.length > 10, "eşleşme oluştu", room.slice(0, 8));
  ok(ownerOf(P_A) === U_A, "BEKLEYEN taraf sahibi var (kuyruk trigger'ı)", ownerOf(P_A));
  ok(ownerOf(P_B) === "(yok)", "ÇAĞIRAN taraf SAHİPSİZ — canlı hata birebir üretildi", ownerOf(P_B));
  ok(authAs(U_A, P_A) === "true", "bekleyen authorize = true");
  ok(authAs(U_B, P_B) === "false", "çağıran authorize = FALSE (hata)", authAs(U_B, P_B));
  ok(claimAs(U_B, P_B, room).startsWith("ERR:"), "çağıran hedefi KAPAMIYOR (42501)", claimAs(U_B, P_B, room));
}

/* ═══════════ 2) DÜZELTME: 150000 ile iki taraf da bağlı ═══════════ */
section("2) 150000 SONRASI — iki taraf da atomik olarak sahipli");
let room2 = "";
{
  build(true);
  const r = runMatch(); room2 = r.room;
  ok(ownerOf(P_A) === U_A, "BEKLEYEN sahibi doğru", ownerOf(P_A));
  ok(ownerOf(P_B) === U_B, "ÇAĞIRAN sahibi doğru (asıl düzeltme)", ownerOf(P_B));
  ok(authAs(U_A, P_A) === "true", "bekleyen authorize = true");
  ok(authAs(U_B, P_B) === "true", "çağıran authorize = true");
  ok(claimAs(U_A, P_A, room2) === "true", "bekleyen KENDİ hedefini kapıyor");
  psql(c!, DB, `update public.wheel_duel_rooms set current_target_topoid='276' where id='${room2}';`);
  ok(claimAs(U_B, P_B, room2) === "true", "çağıran KENDİ hedefini kapıyor");

  // Atomiklik: matched=true döndüğü ANDA iki sahiplik de var (aynı transaction).
  ok(ownerOf(P_A) !== "(yok)" && ownerOf(P_B) !== "(yok)",
     "matched=true döndüğünde İKİ sahiplik de mevcut (yarış penceresi yok)");
}

/* ═══════════ 3) KUYRUK SIFIRLAMA sonrası yetki ═══════════ */
section("3) Kuyruk silindikten sonra da iki taraf yetkili");
{
  psql(c!, DB, `delete from public.wheel_duel_queue;`);
  ok(authAs(U_A, P_A) === "true", "bekleyen: kuyruk YOKken authorize = true");
  ok(authAs(U_B, P_B) === "true", "çağıran: kuyruk YOKken authorize = true");
  psql(c!, DB, `update public.wheel_duel_rooms set current_target_topoid='036' where id='${room2}';`);
  ok(claimAs(U_A, P_A, room2) === "true", "bekleyen: kuyruk YOKken claim çalışıyor");
  psql(c!, DB, `update public.wheel_duel_rooms set current_target_topoid='392' where id='${room2}';`);
  ok(claimAs(U_B, P_B, room2) === "true", "çağıran: kuyruk YOKken claim çalışıyor");
}

/* ═══════════ 4) GÖVDE BAĞIMSIZLIĞI ═══════════ */
section("4) Bağlama, çekirdek gövdenin adım SIRASINDAN bağımsız");
{
  // 150000 çekirdeğin İÇİNİ bilmez: neyi sarmalarsa onu sarmalar. Bunu
  // kanıtlamak için TAMAMEN FARKLI yazım sıralı bir çekirdekle kurulur:
  //   oyuncular önce, oda sonra değil — kuyruk DELETE'i EN BAŞTA, bekleyenin
  //   UPDATE'i EN SONDA, dönüş anahtarları farklı sırada.
  const QM_ALT = QM
    .replace(
      `    -- 4) YALNIZ bekleyenin kuyruk satırı güncellenir
    update public.wheel_duel_queue set matched_room_id = v_room
     where profile_id = v_match.profile_id;
    -- 5) ÇAĞIRANIN eski kuyruk satırı SİLİNİR (yeni satır YAZILMAZ)
    delete from public.wheel_duel_queue where profile_id = p_profile_id;`,
      `    -- TERS SIRA: önce çağıranın satırı silinir, bekleyenin UPDATE'i EN SONDA
    delete from public.wheel_duel_queue where profile_id = p_profile_id;
    update public.wheel_duel_queue set matched_room_id = v_room
     where profile_id = v_match.profile_id;`)
    .replace(
      `    return jsonb_build_object('matched', true, 'room_id', v_room,
      'room_code', p_room_code, 'my_player_id', p_player_id,`,
      `    return jsonb_build_object('my_player_id', p_player_id, 'matched', true,
      'room_code', p_room_code, 'room_id', v_room,`);
  ok(QM_ALT !== QM, "alternatif çekirdek gövdesi gerçekten farklı");

  build(true, QM_ALT);
  const r = runMatch();
  ok(r.room.length > 10, "alternatif çekirdekle de eşleşme oldu", r.room.slice(0, 8));
  ok(ownerOf(P_A) === U_A, "ters sırada da BEKLEYEN sahibi doğru", ownerOf(P_A));
  ok(ownerOf(P_B) === U_B, "ters sırada da ÇAĞIRAN sahibi doğru", ownerOf(P_B));
  ok(authAs(U_A, P_A) === "true" && authAs(U_B, P_B) === "true",
     "ters sırada da iki taraf yetkili");
  ok(fingerprint(SIG_CORE).src === BASELINE.src,
     "alternatif gövde de çekirdeğe BİREBİR taşındı (prosrc md5 aynı)");
}

/* ═══════════ 4b) YOKLAMA DALI ═══════════ */
section("4b) Bekleyen taraf yoklaması: idempotent, sahiplik devretmiyor");
{
  build(true);
  const { room } = runMatch();
  // A (bekleyen) tick'inde tekrar çağırır: çekirdek matched=true döner.
  const poll = last(psql(c!, DB, asUser(U_A,
    `select (public.wheel_duel_quick_match('${U_A}','${P_A}','A',60,'world',0,'WPOLL1','792'))->>'room_id';`), true));
  ok(poll === room, "yoklama AYNI odayı döndürdü (istemci sözleşmesi korundu)", poll);
  ok(ownerOf(P_A) === U_A, "yoklama sahipliği DEĞİŞTİRMEDİ (idempotent)", ownerOf(P_A));
  ok(ownerOf(P_B) === U_B, "yoklama rakibin sahipliğine DOKUNMADI", ownerOf(P_B));
  ok(last(psql(c!, DB, `select count(*)::text from public.wheel_duel_quick_match_owners;`, true)) === "2",
     "toplam sahiplik kaydı hâlâ 2 (çoğalma yok)");
  // Bekleyen tarafın realtime işaretçisi (matched_room_id) korunuyor.
  ok(last(psql(c!, DB,
     `select coalesce((select matched_room_id::text from public.wheel_duel_queue
                        where profile_id='${U_A}'), 'yok');`, true)) === room,
     "bekleyenin matched_room_id işaretçisi (realtime bildirimi) KORUNDU");
}

/* ═══════════ 5) P0 REGRESYONU ═══════════ */
section("5) P0 — saldırgan kurbanın player_id'siyle hiçbir şey elde edemiyor");
{
  build(true);
  const { room } = runMatch();

  // Kuyruk her denemeden önce TEMİZLENİR ve bekleyen taraf TAZE bir player_id
  // ile girer: aksi hâlde bekleyenin ESKİ oyuncu satırı primary-key ihlaline
  // çarpar ve testin kendi kurgusu saldırıyı maskeler.
  const freshWait = (id: string, code: string) => {
    psql(c!, DB, `delete from public.wheel_duel_queue;`);
    psql(c!, DB, asUser(U_A,
      `select public.wheel_duel_quick_match('${U_A}','${id}','A',60,'world',0,'${code}','792');`));
  };
  const P_A2 = "00000000-0000-4000-8000-0000000000a2";
  const P_A3 = "00000000-0000-4000-8000-0000000000a3";
  const P_A4 = "00000000-0000-4000-8000-0000000000a4";
  const P_CONFLICT = "00000000-0000-4000-8000-0000000000f1";

  // 5a — saldırgan, kurbanın ODA-KODU player_id'siyle Hızlı Eşleş dener.
  freshWait(P_A2, "WAAAAC");
  let e1 = "";
  try {
    psql(c!, DB, asUser(U_X,
      `select public.wheel_duel_quick_match('${U_X}','${P_VICTIM_CODE}','X',60,'world',0,'WXXXX1','792');`));
  } catch (e) { e1 = errText(e); }
  ok(/duplicate key|unique|violat/i.test(e1),
     "5a kurbanın ODA-KODU id'siyle eşleşme PRIMARY KEY ihlaline çarpıp geri alındı", e1.slice(0, 110));
  ok(ownerOf(P_VICTIM_CODE) === "(yok)", "5a kurbanın oda-kodu oyuncusuna sahiplik ÜRETİLMEDİ", ownerOf(P_VICTIM_CODE));
  ok(authAs(U_X, P_VICTIM_CODE) === "false", "5a saldırgan kurban adına yetkilenemiyor");
  ok(last(psql(c!, DB, `select count(*)::text from public.wheel_duel_rooms where code='WXXXX1';`, true)) === "0",
     "5a saldırganın odası HİÇ oluşmadı (atomik geri alma)");

  // 5b — saldırgan, kurbanın QM player_id'siyle dener.
  freshWait(P_A3, "WAAAAE");
  let e2 = "";
  try {
    psql(c!, DB, asUser(U_X,
      `select public.wheel_duel_quick_match('${U_X}','${P_B}','X',60,'world',0,'WXXXX2','792');`));
  } catch (e) { e2 = errText(e); }
  ok(/duplicate key|unique|violat/i.test(e2),
     "5b kurbanın QM id'siyle eşleşme de PRIMARY KEY ihlaline çarptı", e2.slice(0, 110));
  ok(authAs(U_X, P_B) === "false", "5b saldırgan kurbanın QM oyuncusu adına yetkilenemiyor");
  ok(ownerOf(P_B) === U_B, "5b sahiplik HÂLÂ kurbanda (devralınamadı)", ownerOf(P_B));

  // 5c — claim / leave / çapraz oda denemeleri
  const cl = claimAs(U_X, P_B, room);
  ok(cl.startsWith("ERR:"), "5c saldırgan kurban adına claim ATAMIYOR", cl);
  let e3 = "";
  try { psql(c!, DB, asUser(U_X, `select public.wheel_duel_leave_room('${room}','${P_B}',null);`)); }
  catch (e) { e3 = errText(e); }
  ok(/unauthorized|42501/.test(e3), "5c saldırgan kurban adına leave_room ÇAĞIRAMIYOR", e3.slice(0, 80));
  ok(last(psql(c!, DB, `select status from public.wheel_duel_rooms where id='${room}';`, true)) === "playing",
     "5c kurbanın odası DEĞİŞMEDİ");
  let e5 = "";
  try {
    psql(c!, DB, asUser(U_B,
      `select public.wheel_duel_claim_target('${ROOM_CODE_ROOM}','${P_B}',null,'792');`));
  } catch (e) { e5 = errText(e); }
  ok(/player_room_mismatch|42501/.test(e5), "5c ÇAPRAZ ODA yükseltmesi reddedildi", e5.slice(0, 80));

  // 5d — çelişkili sahiplik → RAISE + TAM rollback
  psql(c!, DB, `insert into public.wheel_duel_quick_match_owners (player_id, profile_id)
                values ('${P_CONFLICT}','${U_X}');`);
  freshWait(P_A4, "WAAAAD");
  const roomsBefore   = last(psql(c!, DB, `select count(*)::text from public.wheel_duel_rooms;`, true));
  const playersBefore = last(psql(c!, DB, `select count(*)::text from public.wheel_duel_players;`, true));
  const ownersBefore  = last(psql(c!, DB, `select count(*)::text from public.wheel_duel_quick_match_owners;`, true));
  let e4 = "";
  try {
    // B, SAHİBİ BAŞKASINA AİT olan bir player_id ile eşleşmeyi tetikler:
    // oyuncu satırı yazılır, sarmalayıcı çelişkiyi görüp RAISE eder.
    psql(c!, DB, asUser(U_B,
      `select public.wheel_duel_quick_match('${U_B}','${P_CONFLICT}','B',60,'world',0,'WCONF1','792');`));
  } catch (e) { e4 = errText(e); }
  ok(/çelişkili sahiplik|42501/.test(e4), "5d çelişkili sahiplik RAISE etti", e4.slice(0, 110));
  ok(last(psql(c!, DB, `select count(*)::text from public.wheel_duel_rooms;`, true)) === roomsBefore,
     "5d oda artığı YOK (tam geri alma)", roomsBefore);
  ok(last(psql(c!, DB, `select count(*)::text from public.wheel_duel_players;`, true)) === playersBefore,
     "5d oyuncu artığı YOK", playersBefore);
  ok(last(psql(c!, DB, `select count(*)::text from public.wheel_duel_quick_match_owners;`, true)) === ownersBefore,
     "5d sahiplik artığı YOK", ownersBefore);
  ok(ownerOf(P_CONFLICT) === U_X, "5d çelişkili sahiplik ÜZERİNE YAZILMADI", ownerOf(P_CONFLICT));
  ok(last(psql(c!, DB,
     `select coalesce((select matched_room_id::text from public.wheel_duel_queue
                        where profile_id='${U_A}'), 'null');`, true)) === "null",
     "5d bekleyenin kuyruk satırı da geri alındı (matched_room_id yazılmadı)");
}

/* ═══════════ 6) 140000 INVARIANT'LARI + YAŞAM DÖNGÜSÜ ═══════════ */
section("6) 140000 korumaları ve Hızlı Eşleş yaşam döngüsü bozulmadı");
{
  build(true);
  const acl = last(psql(c!, DB, `
    select has_table_privilege('anon','public.wheel_duel_quick_match_owners','SELECT')::text||','||
           has_table_privilege('authenticated','public.wheel_duel_quick_match_owners','INSERT')::text||','||
           has_table_privilege('authenticated','public.wheel_duel_quick_match_owners','UPDATE')::text||','||
           has_table_privilege('authenticated','public.wheel_duel_quick_match_owners','DELETE')::text;`, true));
  ok(acl === "false,false,false,false", "owners tablosu istemciye KAPALI kaldı", acl);

  const qacl = last(psql(c!, DB, `
    select has_table_privilege('authenticated','public.wheel_duel_queue','INSERT')::text||','||
           has_table_privilege('authenticated','public.wheel_duel_queue','UPDATE')::text||','||
           has_table_privilege('authenticated','public.wheel_duel_queue','DELETE')::text;`, true));
  ok(qacl === "false,false,false", "kuyruk yazma kilidi korundu", qacl);

  const authzDef = psql(c!, DB,
    `select regexp_replace(pg_get_functiondef(to_regprocedure('public.wheel_duel_authorize_player(uuid,uuid)')),
        '--[^' || chr(10) || ']*', '', 'g');`, true);
  ok(!/from\s+public\.wheel_duel_queue/.test(authzDef), "authorize'da kuyruk dalı HÂLÂ yok");
  ok(/wheel_duel_quick_match_owners/.test(authzDef), "authorize kalıcı sahiplik dalını koruyor");

  ok(last(psql(c!, DB, `select count(*)::text from pg_trigger
       where tgrelid='public.wheel_duel_queue'::regclass and not tgisinternal;`, true)) === "1",
     "140000 kuyruk trigger'ı duruyor");

  // ── FONKSİYON KİMLİĞİ: gövde BİREBİR korunmuş mu? ──────────────────────
  const core = fingerprint(SIG_CORE);
  const wrap = fingerprint(SIG_PUB);
  ok(core.src === BASELINE.src,
     "çekirdek gövdesi 150000 ÖNCESİYLE BİREBİR aynı (prosrc md5)", `${core.src} vs ${BASELINE.src}`);
  ok(core.secdef === BASELINE.secdef && core.cfg === BASELINE.cfg,
     "çekirdeğin SECURITY DEFINER + search_path'i korundu", `${core.secdef}/${core.cfg}`);
  ok(wrap.secdef === "true", "sarmalayıcı SECURITY DEFINER", wrap.secdef);
  ok(wrap.cfg === BASELINE.cfg, "sarmalayıcı search_path canlıyla AYNI", `${wrap.cfg} vs ${BASELINE.cfg}`);
  ok(wrap.acl === BASELINE.acl,
     "istemciye açık EXECUTE ACL'i canlıyla BİREBİR (anon,authenticated,service_role)",
     `${wrap.acl} vs ${BASELINE.acl}`);
  ok(core.acl === "false,false,false",
     "çekirdek istemciye KAPALI (bağlama atlanamaz)", core.acl);
  ok(last(psql(c!, DB, `select count(*)::text from pg_proc p, aclexplode(p.proacl) a
        where p.oid in (to_regprocedure('${SIG_PUB}'), to_regprocedure('${SIG_CORE}'))
          and a.grantee = 0;`, true)) === "0", "PUBLIC EXECUTE yok (sürpriz grant yok)");
  ok(/create or replace function public\.wheel_duel_quick_match/.test(MIG_150),
     "150000 TAM imzayı create or replace ediyor (FUNCTION-BASED tasarım)");
  const wrapDef = psql(c!, DB, `select pg_get_functiondef(to_regprocedure('${SIG_PUB}'));`, true);
  ok(/_wheel_duel_quick_match_core/.test(wrapDef) && /_wheel_duel_bind_qm_owner/.test(wrapDef),
     "kurulu sarmalayıcı hem çekirdeği ÇAĞIRIYOR hem sahipliği BAĞLIYOR");

  // ── GENEL OYUNCU TRIGGER'I YOK ────────────────────────────────────────
  ok(last(psql(c!, DB, `select count(*)::text from pg_trigger
       where tgrelid='public.wheel_duel_players'::regclass and not tgisinternal;`, true)) === "0",
     "wheel_duel_players üzerinde HİÇBİR trigger yok (tasarım kararı)");
  ok(!/after\s+insert\s+on\s+public\.wheel_duel_players/i.test(
       MIG_150.replace(/--[^\n]*/g, "")),
     "150000 wheel_duel_players'a AFTER INSERT trigger KURMUYOR");

  // Taze arama → eşleşme → bitmiş maç yeni aramayı kirletmiyor
  psql(c!, DB, asUser(U_A,
    `select public.wheel_duel_quick_match('${U_A}','00000000-0000-4000-8000-0000000000e1','A',60,'world',0,'WFRESH','792');`));
  const freshRoom = last(psql(c!, DB, asUser(U_B,
    `select coalesce((public.wheel_duel_quick_match('${U_B}','00000000-0000-4000-8000-0000000000e2','B',60,'world',0,'WFRES2','792'))->>'room_id','-');`), true));
  ok(freshRoom !== "-" && freshRoom.length > 10, "taze Hızlı Eşleş çalışıyor", freshRoom.slice(0, 8));
  ok(ownerOf("00000000-0000-4000-8000-0000000000e1") === U_A
     && ownerOf("00000000-0000-4000-8000-0000000000e2") === U_B,
     "taze maçta da İKİ taraf sahipli");

  psql(c!, DB, `update public.wheel_duel_rooms set status='finished' where id='${freshRoom}';`);
  psql(c!, DB, `delete from public.wheel_duel_queue;`);
  const again = last(psql(c!, DB, asUser(U_B,
    `select coalesce((public.wheel_duel_quick_match('${U_B}','00000000-0000-4000-8000-0000000000e3','B',60,'world',0,'WNEW01','792'))->>'matched','?');`), true));
  ok(again === "false", "bitmiş maç yeni aramada GERİ DÖNMÜYOR (matched=false → taze arama)", again);
  const qrow = last(psql(c!, DB,
    `select coalesce((select matched_room_id::text from public.wheel_duel_queue where profile_id='${U_B}'),'null');`, true));
  ok(qrow === "null", "yeni arama TAZE kuyruk satırı üretti (matched_room_id null)", qrow);
}

/* ═══════════ 7) ÇEKİRDEK ERİŞİLEMEZ Mİ? (PUBLIC dahil) ═══════════ */
section("7) Sarmalayıcı ATLANAMIYOR — çekirdek her istemci rolüne kapalı");
{
  build(false);   // önce 150000 UYGULANMADAN canlı ACL'i doğrula
  const LIVE_ACL = "{=X/postgres,postgres=X/postgres,anon=X/postgres," +
                   "authenticated=X/postgres,service_role=X/postgres}";
  const base = fingerprint(SIG_PUB);
  ok("{" + base.proacl + "}" === LIVE_ACL,
     "clean-room baseline'ı ÜRETİM proacl'i ile BİREBİR (PUBLIC dahil)", base.proacl);
  ok(base.pub === "true", "baseline'da PUBLIC EXECUTE VAR (=X/postgres) — risk gerçek", base.pub);

  psql(c!, DB, MIG_150);
  const core = fingerprint(SIG_CORE);
  const wrap = fingerprint(SIG_PUB);

  // 7a — ACL kaydı düzeyinde
  ok(core.pub === "false", "çekirdekte PUBLIC EXECUTE kaydı YOK", core.proacl);
  ok(wrap.pub === "false", "sarmalayıcıda PUBLIC EXECUTE kaydı YOK", wrap.proacl);
  ok(/postgres=X\/postgres/.test(core.proacl), "çekirdekte SAHİP (postgres) EXECUTE'u duruyor", core.proacl);
  for (const role of ["anon", "authenticated", "service_role"]) {
    // has_function_privilege PUBLIC'i de hesaba katar: gerçek etkin yetki.
    ok(last(psql(c!, DB,
       `select has_function_privilege('${role}','${SIG_CORE}','EXECUTE')::text;`, true)) === "false",
       `7a çekirdek ETKİN yetkisi yok: ${role} (PUBLIC mirası dahil)`);
    ok(last(psql(c!, DB,
       `select has_function_privilege('${role}','${SIG_PUB}','EXECUTE')::text;`, true)) === "true",
       `7a sarmalayıcı çağrılabilir: ${role}`);
  }

  // 7b — GERÇEK doğrudan çağrı denemesi (yetki kontrolü teoride değil pratikte)
  const callCore = (role: string) => {
    try {
      psql(c!, DB, `begin;
select set_config('torble.uid', '${U_B}', false);
set local role ${role};
select public._wheel_duel_quick_match_core('${U_B}','${P_B}','B',60,'world',0,'WBYP01','792');
commit;`);
      return "İZİN VERİLDİ";
    } catch (e) { return errText(e); }
  };
  for (const role of ["anon", "authenticated", "service_role"]) {
    const r = callCore(role);
    ok(/permission denied/i.test(r), `7b ${role} çekirdeği DOĞRUDAN çağıramıyor`, r.slice(0, 90));
  }
  // …ama meşru yol çalışıyor.
  const legit = last(psql(c!, DB, asUser(U_B,
    `select coalesce((public.wheel_duel_quick_match('${U_B}','${P_B}','B',60,'world',0,'WLEGIT','792'))->>'matched','?');`), true));
  ok(legit === "false", "7b authenticated MEŞRU sarmalayıcıyı çağırabiliyor (kuyruğa girdi)", legit);
  ok(ownerOf(P_B) === U_B, "7b kuyruğa giren taraf 140000 trigger'ıyla sahiplendi", ownerOf(P_B));

  // 7c — yardımcı de kapalı
  for (const role of ["anon", "authenticated", "service_role"]) {
    ok(last(psql(c!, DB,
       `select has_function_privilege('${role}','public._wheel_duel_bind_qm_owner(uuid,uuid,uuid)','EXECUTE')::text;`,
       true)) === "false", `7c bağlama yardımcısı ${role}'e kapalı`);
  }
  ok(last(psql(c!, DB,
     `select (exists (select 1 from pg_proc p, aclexplode(p.proacl) a
        where p.oid = to_regprocedure('public._wheel_duel_bind_qm_owner(uuid,uuid,uuid)')
          and a.grantee = 0))::text;`, true)) === "false",
     "7c yardımcıda PUBLIC EXECUTE yok");
}

/* ═══════════ 8) OID BAĞIMLILIĞI + TEKRAR UYGULAMA ═══════════ */
section("8) Rename güvenliği: OID bağımlılığı denetimi ve idempotentlik");
{
  // 8a — OID'e bağlı bir nesne varsa migration BAŞLAMADAN durmalı.
  build(false);
  psql(c!, DB, `create view public.qm_dep_probe as
    select (public.wheel_duel_quick_match(null,null,null,null,null,null,null,null))->>'matched' as m;`);
  let e = "";
  try { psql(c!, DB, MIG_150); } catch (x) { e = errText(x); }
  ok(/OID/i.test(e) && /bağlı nesne/i.test(e),
     "8a OID'e bağlı nesne varken migration FAIL-CLOSED durdu", e.slice(0, 120));
  ok(last(psql(c!, DB, `select (to_regprocedure('${SIG_CORE}') is null)::text;`, true)) === "true",
     "8a durdurulan denemede rename YAPILMADI (yarım durum yok)");

  // 8b — bağımlılık yokken uygulanır; İKİNCİ kez uygulamak güvenlidir.
  build(false);
  const before = fingerprint(SIG_PUB);
  psql(c!, DB, `begin;\n${MIG_150}\ncommit;`);
  const core1 = fingerprint(SIG_CORE);
  psql(c!, DB, `begin;\n${MIG_150}\ncommit;`);
  const core2 = fingerprint(SIG_CORE);
  ok(core1.src === before.src, "8b çekirdek gövdesi rename ile BİREBİR taşındı");
  ok(core2.src === core1.src, "8b ikinci uygulama çekirdeği DEĞİŞTİRMEDİ (yeniden rename yok)");
  ok(last(psql(c!, DB, `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='_wheel_duel_quick_match_core';`, true)) === "1",
     "8b tam olarak BİR çekirdek var");
  ok(last(psql(c!, DB, `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='wheel_duel_quick_match';`, true)) === "1",
     "8b tam olarak BİR sarmalayıcı var");
  const wrapDef2 = psql(c!, DB, `select pg_get_functiondef(to_regprocedure('${SIG_PUB}'));`, true);
  ok(!/create or replace function public\._wheel_duel_quick_match_core/.test(wrapDef2)
     && /_wheel_duel_quick_match_core\(/.test(wrapDef2),
     "8b sarmalayıcı özyinelemiyor (çekirdeği çağırıyor, kendini değil)");
  ok(fingerprint(SIG_CORE).pub === "false" && fingerprint(SIG_PUB).pub === "false",
     "8b tekrar uygulamadan sonra da ACL MÜHÜRLÜ (PUBLIC yok)");

  // 8c — tekrar uygulamadan sonra meşru akış hâlâ çalışıyor
  const r = runMatch();
  ok(r.room.length > 10, "8c tekrar uygulanmış şemada Hızlı Eşleş çalışıyor", r.room.slice(0, 8));
  ok(ownerOf(P_A) === U_A && ownerOf(P_B) === U_B, "8c iki taraf da sahipli");
}

psql(c!, "postgres", `drop database if exists ${DB};\n`);
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
