/**
 * check-wheel-identity-security.ts — ÇARK HIZLI EŞLEŞ KİMLİK ZİNCİRİ
 * clean-room güvenlik testi (GERÇEK Postgres, docker; canlıya DOKUNMAZ).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SORU
 * ────
 *   Kimliği doğrulanmış A kullanıcısı, B'ye ait bir `player_id` ile
 *   `wheel_duel_quick_match` çağırıp kendini B'nin Çark oyuncusu olarak
 *   yetkilendirebilir mi?
 *
 *   Zincir (20260814180000):
 *     wheel_duel_authorize_player 3. dal ("kuyruk köprüsü")
 *       q.player_id = p_player_id AND q.profile_id = auth.uid()
 *   `wheel_duel_quick_match` ise p_player_id'yi ÇAĞIRANDAN alır.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NEDEN İKİ QM MODELİ
 * ───────────────────
 *   `wheel_duel_quick_match` gövdesi REPODA YOKTUR (Studio döneminde
 *   yazılmış; 20260530120000 bunu açıkça not eder). Gövdeyi okuyamadığımız
 *   için test onu İKİ uçta modeller:
 *
 *     V1 "permissive"  — p_player_id'yi doğrulamadan kuyruğa yazar
 *                        (20260814180000'in kendi tehdit modeli bu varsayımı
 *                         yapıyor: "saldırgan KENDİ profile_id'si + KURBANIN
 *                         player_id'si ile satır ekleyip kurban adına
 *                         yetkilenir").
 *     V2 "validating"  — p_player_id zaten bir oyuncu satırıysa reddeder.
 *
 *   Sertleştirmenin DEĞERİ, İKİ modelde de saldırının başarısız olmasıdır:
 *   böylece güvenlik okunamayan bir gövdenin davranışına BAĞLI KALMAZ.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * KATMANLAR
 *   L0  şema + roller + auth.uid() taklidi (canlı kolon seti; leave-room
 *       clean-room'unda doğrulanmış şekil)
 *   L1  tarihsel fonksiyonlar: 20260529120000 claim_target,
 *       20260814180000 authorize + kuyruk ACL'i, 20260815130000 claims ACL'i
 *   L2  hazırlanan migration: 20260827140000 (kalıcı sahiplik + kimlik bağlama
 *       TEK DOSYADA — atomik deploy; ayrı bir bağlama migration'ı YOKTUR)
 *   S   senaryolar: meşru akış, saldırı, sahiplik devri, ACL
 *
 * Çalıştır:  npx tsx scripts/check-wheel-identity-security.ts
 *   Konteyner seçimi: WHEEL_SEC_PG_CONTAINER=<ad> (varsayılan: çalışan ilk
 *   `postgres:` imajlı konteyner — `supabase_*` adları BİLEREK dışlanır,
 *   başka bir projenin yığınına dokunulmaz).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = "wheel_identity_sec";

/** `wheel_duel_leave_room` gövdesi 20260814160000'den BİREBİR alınır — elle
 *  yeniden yazmak testin kendi kopyasını doğrulamasına yol açardı. */
const LEAVE_ROOM_SQL = (() => {
  const src = readFileSync(join(ROOT,
    "supabase/migrations/20260814160000_wheel_duel_leave_room_status_aware_child_cleanup.sql"), "utf8");
  const i = src.indexOf("create or replace function public.wheel_duel_leave_room");
  if (i < 0) throw new Error("leave_room gövdesi bulunamadı");
  const j = src.indexOf("$$;", i) + 3;
  return src.slice(i, j) + `
revoke all     on function public.wheel_duel_leave_room(uuid,uuid,uuid) from public;
grant  execute on function public.wheel_duel_leave_room(uuid,uuid,uuid) to anon, authenticated;`;
})();

let passed = 0, failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `   (got ${JSON.stringify(got)})` : ""}`); }
}
const section = (t: string) => console.log(`\n${t}`);

/* ── docker/psql yardımcıları ───────────────────────────────────────────── */
function findContainer(): string | null {
  const explicit = process.env.WHEEL_SEC_PG_CONTAINER;
  if (explicit) return explicit;
  try {
    const out = execFileSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.trim().split("\n").filter(Boolean)) {
      const [name, image] = line.split("\t");
      // supabase_* → BAŞKA bir projenin yığını; asla kullanılmaz.
      if (name.startsWith("supabase_")) continue;
      if (image?.startsWith("postgres:")) return name;
    }
  } catch { /* docker yok */ }
  return null;
}

function psql(container: string, db: string, input: string, tuples = false): string {
  const args = ["exec", "-i", container, "psql", "-U", "postgres", "-d", db,
                "-q", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-A", "-t");
  args.push("-f", "-");
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/* ── Sabit kimlikler ────────────────────────────────────────────────────── */
const A_UID   = "00000000-0000-4000-8000-00000000000a";  // saldırgan hesap
const B_UID   = "00000000-0000-4000-8000-00000000000b";  // kurban hesap
const P_B_CODE = "00000000-0000-4000-8000-0000000000b1"; // B'nin ODA-KODU oyuncusu
const P_B_QM   = "00000000-0000-4000-8000-0000000000b2"; // B'nin HIZLI EŞLEŞ oyuncusu
const P_A_QM   = "00000000-0000-4000-8000-0000000000a2"; // A'nın kendi QM oyuncusu
const ROOM_C   = "00000000-0000-4000-8000-00000000c0de"; // oda-kodu odası
const ROOM_Q   = "00000000-0000-4000-8000-00000000c0df"; // QM odası

/* ── L0: şema ───────────────────────────────────────────────────────────── */
const L0 = String.raw`
drop schema if exists public cascade;  create schema public;
drop schema if exists auth   cascade;  create schema auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;

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
  rematch_requested_by uuid[] not null default '{}',
  match_seq int not null default 1, current_match_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.wheel_duel_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.wheel_duel_rooms(id) on delete cascade,
  name text not null, score int not null default 0 check (score >= 0),
  profile_id uuid null, guest_id text null,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table public.wheel_duel_player_claims (
  player_id uuid primary key references public.wheel_duel_players(id) on delete cascade,
  claim_token uuid not null,
  created_at timestamptz not null default now()
);
create table public.wheel_duel_room_sequences (
  room_id uuid primary key references public.wheel_duel_rooms(id) on delete cascade,
  targets text[] not null,
  created_at timestamptz not null default now()
);
-- ÜRETİM ŞEMASI (yetkili kısıt listesi — varsayım YOK):
--   PK(profile_id) · UNIQUE(player_id)
--   FK matched_room_id -> wheel_duel_rooms(id) ON DELETE SET NULL
--   FK profile_id     -> auth.users(id)        ON DELETE CASCADE
--   CHECK duration_seconds IN (60,120,180,300) · max_level_diff >= 0
--   CHECK region IN (world,europe,asia,africa,north_america,south_america,oceania)
--   updated_at YOKTUR (ilk üretim denemesi tam da bu uydurma kolon yüzünden
--   42703 ile düşmüştü).
create table auth.users (id uuid primary key);
insert into auth.users (id) values
  ('00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-00000000000b');
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
`;

/* ── L1: tarihsel fonksiyonlar (BİREBİR) ────────────────────────────────── */
const L1 = String.raw`
-- 20260814180000 · sertleştirilmiş authorize (3 dal)
create or replace function public.wheel_duel_authorize_player(
  p_player_id uuid, p_claim_token uuid
) returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.wheel_duel_players p
      left join public.wheel_duel_player_claims c on c.player_id = p.id
     where p.id = p_player_id
       and ( (p.profile_id is not null and p.profile_id = auth.uid())
          or (p.profile_id is null and p.guest_id is not null
              and p_claim_token is not null and c.claim_token = p_claim_token) )
  )
  or exists (
    select 1 from public.wheel_duel_queue q
     where q.player_id = p_player_id
       and q.profile_id is not null and q.profile_id = auth.uid()
  );
$$;
revoke all     on function public.wheel_duel_authorize_player(uuid,uuid) from public;
grant  execute on function public.wheel_duel_authorize_player(uuid,uuid) to anon, authenticated;

-- 20260529120000 · claim_target (BİREBİR)
create or replace function public.wheel_duel_claim_target(
  p_room_id uuid, p_player_id uuid, p_claim_token uuid, p_target text
) returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_claimed_id uuid; v_new_score int;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target is null or length(btrim(p_target)) = 0 then
    raise exception 'target_required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.wheel_duel_players
                  where id = p_player_id and room_id = p_room_id) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;
  update public.wheel_duel_rooms
     set current_target_topoid = null,
         used_target_topoids = array_append(coalesce(used_target_topoids,'{}'), p_target),
         pass_requested_by = '{}', pass_target_topoid = null
   where id = p_room_id and status = 'playing' and current_target_topoid = p_target
  returning id into v_claimed_id;
  if v_claimed_id is null then
    return jsonb_build_object('claimed', false, 'new_score', null);
  end if;
  update public.wheel_duel_players set score = score + 1
   where id = p_player_id returning score into v_new_score;
  return jsonb_build_object('claimed', true, 'new_score', v_new_score);
end; $$;
revoke all     on function public.wheel_duel_claim_target(uuid,uuid,uuid,text) from public;
grant  execute on function public.wheel_duel_claim_target(uuid,uuid,uuid,text) to anon, authenticated;

${LEAVE_ROOM_SQL}

-- 20260814180000 · kuyruk yazma kilidi (BİREBİR)
revoke insert, update, delete on table public.wheel_duel_queue from anon;
revoke insert, update, delete on table public.wheel_duel_queue from authenticated;
revoke insert, update, delete on table public.wheel_duel_queue from public;

-- 20260815130000 · claims INSERT anon'dan geri alınır (authenticated KALIR)
revoke insert on table public.wheel_duel_player_claims from anon;
revoke insert on table public.wheel_duel_player_claims from public;
`;

/* ── QM modelleri (gövde repoda YOK) ────────────────────────────────────── */
const QM_MODEL = (variant: "permissive" | "validating") => String.raw`
create or replace function public.wheel_duel_quick_match(
  p_profile_id uuid, p_player_id uuid, p_player_name text,
  p_duration int, p_region text, p_max_level_diff int,
  p_room_code text, p_first_target text
) returns jsonb language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null or auth.uid() <> p_profile_id then
    raise exception 'auth_required' using errcode = '42501';
  end if;
${variant === "validating" ? String.raw`
  -- V2: p_player_id zaten bir oyuncu satırıysa reddet.
  if exists (select 1 from public.wheel_duel_players where id = p_player_id) then
    raise exception 'player_id_in_use' using errcode = '42501';
  end if;
` : String.raw`
  -- V1: p_player_id DOĞRULANMAZ (20260814180000'in tehdit modeli).
`}
  -- NOT: gerçek gövde repoda yok. Model YALNIZ kanıtlanmış kolonları yazar.
  -- ON CONFLICT dalı created_ati BİLEREK TAZELEMEZ: gerçek gövdenin bunu
  -- yapıp yapmadığı bilinmiyor ve backfill'in doğruluğu buna DAYANMAMALI
  -- (eski "en eski kazanır" kuralı tam da burada saldırganı seçebiliyordu).
  insert into public.wheel_duel_queue as q
    (profile_id, player_id, player_name, duration_seconds, region, max_level_diff, matched_room_id)
  values (p_profile_id, p_player_id, p_player_name, p_duration, p_region, p_max_level_diff, null)
  on conflict (profile_id) do update
    set player_id = excluded.player_id, player_name = excluded.player_name,
        matched_room_id = null;
  return jsonb_build_object('matched', false);
end; $$;
revoke all     on function public.wheel_duel_quick_match(uuid,uuid,text,int,text,int,text,text) from public;
grant  execute on function public.wheel_duel_quick_match(uuid,uuid,text,int,text,int,text,text) to authenticated;
`;

/* ── Fixture: odalar + B'nin ODA-KODU oyuncusu ──────────────────────────
   HIZLI EŞLEŞ oyuncu satırları BURADA KURULMAZ: gerçek akışta önce kuyruğa
   girilir, oyuncu satırı ancak EŞLEŞME OLUŞUNCA doğar. Sıralamayı yanlış
   kurmak V2 modelini yapay olarak patlatır (ilk denemede olan buydu). */
const FIXTURES = String.raw`
insert into public.wheel_duel_rooms (id, code, status, room_source, current_target_topoid, started_at)
values ('${ROOM_C}', 'CODE01', 'playing', 'manual',      '792', now()),
       ('${ROOM_Q}', 'QMR001', 'playing', 'quick_match', '276', now());

-- B'nin ODA-KODU oyuncusu: kimlik kolonu DOLU (profile_id = B)
insert into public.wheel_duel_players (id, room_id, name, profile_id)
values ('${P_B_CODE}', '${ROOM_C}', 'B-code', '${B_UID}');
`;

/* ── 1) B ve A meşru şekilde kuyruğa girer (sahiplik kaydı bu anda doğar) ── */
const ENQUEUE_LEGIT = String.raw`
begin;
  select set_config('torble.uid', '${B_UID}', false);
  set local role authenticated;
  select public.wheel_duel_quick_match('${B_UID}','${P_B_QM}','B',60,'world',0,'QMR001','276');
commit;
begin;
  select set_config('torble.uid', '${A_UID}', false);
  set local role authenticated;
  select public.wheel_duel_quick_match('${A_UID}','${P_A_QM}','A',60,'world',0,'QMR002','276');
commit;
`;

/* ── 2) Eşleşme oluşur: sunucu KİMLİKSİZ oyuncu satırlarını kurar ────────
   (canlıda doğrulandı: son 11 QM oyuncu satırının 11'inde profile_id NULL
    VE guest_id NULL) */
const MATCH_FORMS = String.raw`
insert into public.wheel_duel_players (id, room_id, name, profile_id, guest_id)
values ('${P_B_QM}', '${ROOM_Q}', 'B-qm', null, null),
       ('${P_A_QM}', '${ROOM_Q}', 'A-qm', null, null);
update public.wheel_duel_queue set matched_room_id = '${ROOM_Q}'
 where profile_id in ('${A_UID}','${B_UID}');
`;

/* ── Ölçüm: A, verilen player_id ile yetkili mi / claim atabiliyor mu ───── */
function probeSql(uid: string, playerId: string, roomId: string, target: string) {
  return String.raw`
begin;
select set_config('torble.uid', '${uid}', false);
set local role authenticated;
select
  (select public.wheel_duel_authorize_player('${playerId}'::uuid, null))::text
  || '|' ||
  (select case
     when (select public.wheel_duel_authorize_player('${playerId}'::uuid, null)) then
       coalesce((public.wheel_duel_claim_target('${roomId}'::uuid, '${playerId}'::uuid, null, '${target}')->>'claimed'), 'null')
     else 'blocked' end);
commit;
`;
}

/* ══════════════════════════════════════════════════════════════════════════ */
const container = findContainer();
if (!container) {
  console.error("✗ Çalışan postgres konteyneri yok (WHEEL_SEC_PG_CONTAINER=<ad> ile göster).");
  process.exit(1);
}
console.log(`clean-room konteyneri: ${container}   (db: ${DB})`);

const MIG_140 = readFileSync(join(ROOT, "supabase/migrations/20260827140000_wheel_duel_quick_match_durable_identity.sql"), "utf8");
const MIG_130 = readFileSync(join(ROOT, "supabase/migrations/20260827130000_wheel_duel_reset_quick_match.sql"), "utf8");
type Stage = "baseline" | "merged";
/** merged = 20260827140000 (kalıcı sahiplik + kimlik bağlama TEK DOSYADA). */
const STAGES: Stage[] = ["baseline", "merged"];
const results: Record<string, string> = {};

for (const variant of ["permissive", "validating"] as const) {
  for (const stage of STAGES) {
    const tag = `${variant}/${stage}`;
    psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
    psql(container, DB, L0);
    psql(container, DB, L1);
    psql(container, DB, QM_MODEL(variant));
    psql(container, DB, FIXTURES);
    if (stage !== "baseline") psql(container, DB, MIG_140);
    // Meşru sıra: önce kuyruk (sahiplik doğar), SONRA eşleşme (oyuncu satırı).
    psql(container, DB, ENQUEUE_LEGIT);
    psql(container, DB, MATCH_FORMS);

    // ── SALDIRI: A, B'nin player_id'leriyle kuyruğa girmeye çalışır ──
    for (const [name, pid] of [["code", P_B_CODE], ["qm", P_B_QM]] as const) {
      let enqueueErr = "";
      try {
        psql(container, DB, String.raw`
begin;
  select set_config('torble.uid', '${A_UID}', false);
  set local role authenticated;
  select public.wheel_duel_quick_match('${A_UID}','${pid}','A',60,'world',0,'ATK001','792');
commit;`);
      } catch (e) { enqueueErr = String((e as Error).message ?? e).slice(0, 200); }
      results[`${tag}/enqueue_${name}`] = enqueueErr ? "REJECTED" : "ACCEPTED";

      const room = name === "code" ? ROOM_C : ROOM_Q;
      const target = name === "code" ? "792" : "276";
      let probe = "";
      try { probe = psql(container, DB, probeSql(A_UID, pid, room, target), true).trim(); }
      catch (e) { probe = "ERR:" + String((e as Error).message ?? e).slice(0, 120); }
      results[`${tag}/attack_${name}`] = probe;
    }

    // ── MEŞRU: B kendi QM oyuncusuyla hâlâ yetkili mi? ──
    try {
      results[`${tag}/legit_B`] = psql(container, DB,
        `begin;
         select set_config('torble.uid','${B_UID}',false);
         set local role authenticated;
         select public.wheel_duel_authorize_player('${P_B_QM}'::uuid, null)::text;
         commit;`, true).trim();
    } catch (e) { results[`${tag}/legit_B`] = "ERR:" + String(e).slice(0, 120); }

    // ── MEŞRU: kuyruk satırı SİLİNDİKTEN sonra da yetki ayakta mı? ──
    try {
      psql(container, DB, `delete from public.wheel_duel_queue where profile_id = '${B_UID}';`);
      results[`${tag}/legit_B_after_reset`] = psql(container, DB,
        `begin;
         select set_config('torble.uid','${B_UID}',false);
         set local role authenticated;
         select public.wheel_duel_authorize_player('${P_B_QM}'::uuid, null)::text;
         commit;`, true).trim();
    } catch (e) { results[`${tag}/legit_B_after_reset`] = "ERR:" + String(e).slice(0, 120); }

    // ── ODA-KODU regresyonu: B kendi kayıtlı oyuncusuyla yetkili ──
    try {
      results[`${tag}/legit_B_code`] = psql(container, DB,
        `begin;
         select set_config('torble.uid','${B_UID}',false);
         set local role authenticated;
         select public.wheel_duel_authorize_player('${P_B_CODE}'::uuid, null)::text;
         commit;`, true).trim();
    } catch (e) { results[`${tag}/legit_B_code`] = "ERR:" + String(e).slice(0, 120); }

    // ── ACL: istemci owners tablosuna dokunabiliyor mu? ──
    if (stage !== "baseline") {
      const aclSql = String.raw`
select
  has_table_privilege('anon','public.wheel_duel_quick_match_owners','SELECT')::text || ',' ||
  has_table_privilege('anon','public.wheel_duel_quick_match_owners','INSERT')::text || ',' ||
  has_table_privilege('authenticated','public.wheel_duel_quick_match_owners','SELECT')::text || ',' ||
  has_table_privilege('authenticated','public.wheel_duel_quick_match_owners','INSERT')::text || ',' ||
  has_table_privilege('authenticated','public.wheel_duel_quick_match_owners','UPDATE')::text || ',' ||
  has_table_privilege('authenticated','public.wheel_duel_quick_match_owners','DELETE')::text;`;
      results[`${tag}/owners_acl`] = psql(container, DB, aclSql, true).trim();
      results[`${tag}/owners_rows`] = psql(container, DB,
        `select coalesce(string_agg(player_id::text || '->' || profile_id::text, ' ' order by player_id::text), '(yok)')
           from public.wheel_duel_quick_match_owners;`, true).trim();
    }
  }
}

psql(container, "postgres", `drop database if exists ${DB};\n`);

/* ══════════════════════════════════════════════════════════════════════════
   DEĞERLENDİRME
   ══════════════════════════════════════════════════════════════════════════ */
/** psql -A -t çıktısında `select set_config(...)` da bir satır basar; ölçüm
 *  DAİMA SON satırdır. (İlk sürümde ilk satır okunuyordu ve tüm meşru-akış
 *  iddiaları yalancı-kırmızı veriyordu.) */
/** execFileSync hatasında asıl PostgreSQL mesajı `.stderr`dedir; `.message`
 *  yalnız "Command failed: docker exec …" der ve hata SEBEBİNİ gizler. */
function errText(e: unknown): string {
  const anyE = e as { stderr?: string | Buffer; message?: string };
  const raw = (anyE?.stderr ? String(anyE.stderr) : "") || anyE?.message || String(e);
  return raw.replace(/\s+/g, " ").trim();
}

const lastLine = (s?: string) => (s ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
const yes = (s?: string) => lastLine(s).startsWith("true");
const attackWon = (s?: string) => lastLine(s).startsWith("true");   // authorize=true

section("Ham ölçümler");
for (const k of Object.keys(results).sort()) console.log(`   ${k.padEnd(34)} = ${results[k]}`);

section("A) TEHDİT — A, B'nin player_id'siyle yetkilenebiliyor mu?");
for (const variant of ["permissive", "validating"] as const) {
  // ODA-KODU kurbanı: kuyrukta satırı YOKTUR → UNIQUE(player_id) korumaz.
  // Gerçek P0 yüzeyi budur.
  const baseCode = results[`${variant}/baseline/attack_code`];
  if (variant === "permissive") {
    ok(attackWon(baseCode),
       "[permissive] BASELINE: ODA-KODU kurbanında saldırı BAŞARILI (asıl P0)", lastLine(baseCode));
  } else {
    ok(!attackWon(baseCode),
       "[validating] BASELINE: QM RPC'si p_player_id'yi doğruluyorsa saldırı zaten düşer", lastLine(baseCode));
  }
  const fixedCode = results[`${variant}/merged/attack_code`];
  ok(!attackWon(fixedCode),
     `[${variant}] 140000 SONRASI: oda-kodu kurbanında saldırı ENGELLENDİ`, lastLine(fixedCode));
  ok(lastLine(fixedCode).endsWith("|blocked"),
     `[${variant}] ve claim_target hiç çağrılamıyor (oda-kodu)`, lastLine(fixedCode));

  // QM kurbanı: kuyruk satırı DURUYOR → üretimdeki UNIQUE(player_id) kısıtı
  // saldırganın satırı yazmasını ZATEN engelliyor (bağımsız savunma katmanı).
  ok(results[`${variant}/baseline/enqueue_qm`] === "REJECTED",
     `[${variant}] kuyrukta satırı OLAN oyuncuya ekim UNIQUE(player_id) ile reddediliyor`,
     results[`${variant}/baseline/enqueue_qm`]);
  const fixedQm = results[`${variant}/merged/attack_qm`];
  ok(!attackWon(fixedQm),
     `[${variant}] 140000 SONRASI: QM kurbanında da yetki YOK`, lastLine(fixedQm));
}

section("B) BİRLEŞTİRME — iki koruma AYNI dosyada, atomik");
{
  const body = MIG_140.replace(/--[^\n]*/g, "");
  ok(/create table if not exists public\.wheel_duel_quick_match_owners/.test(body),
     "merged: kalıcı sahiplik tablosu bu dosyada");
  ok(/p\.joined_at < now\(\)/.test(body),
     "merged: kimlik bağlama guard'ı (joined_at < now()) bu dosyada");
  ok(!/from\s+public\.wheel_duel_queue q\s*\n?\s*where q\.player_id/.test(body),
     "merged: authorize'da mutable kuyruk dalı YOK");
  ok(/delete from public\.wheel_duel_quick_match_owners o/.test(body),
     "merged: çelişkili sahiplik temizliği bu dosyada");
  ok(/raise exception 'owners tablosu istemciye AÇIK kaldı'/.test(MIG_140)
     && /raise exception 'sahiplik trigger''ı kurulmadı'/.test(MIG_140),
     "merged: yarım durumu COMMIT ettirmeyen doğrulama bloğu var");
  ok(!/begin;|commit;/i.test(body),
     "merged: açık BEGIN/COMMIT yok (çalıştırıcının transaction'ıyla çakışmaz)");
}

section("C) MEŞRU AKIŞ KORUNUYOR (her aşama, her model)");
for (const variant of ["permissive", "validating"] as const) {
  for (const stage of STAGES) {
    const tag = `${variant}/${stage}`;
    ok(yes(results[`${tag}/legit_B`]),
       `[${tag}] B kendi QM oyuncusuyla YETKİLİ`, results[`${tag}/legit_B`]);
    ok(yes(results[`${tag}/legit_B_code`]),
       `[${tag}] B kendi ODA-KODU oyuncusuyla YETKİLİ (regresyon yok)`, results[`${tag}/legit_B_code`]);
    if (stage !== "baseline") {
      ok(yes(results[`${tag}/legit_B_after_reset`]),
         `[${tag}] kuyruk satırı SİLİNDİKTEN sonra da yetki AYAKTA (kalıcı sahiplik)`,
         results[`${tag}/legit_B_after_reset`]);
    } else {
      ok(!yes(results[`${tag}/legit_B_after_reset`]),
         `[${tag}] 140000 ÖNCESİ: kuyruk silinince yetki DÜŞÜYOR (düzeltilen kusur)`,
         results[`${tag}/legit_B_after_reset`]);
    }
  }
}

section("D) OWNERS TABLOSU — sunucu-özel mi?");
for (const variant of ["permissive", "validating"] as const) {
  for (const stage of STAGES.filter(s => s !== "baseline")) {
    const acl = results[`${variant}/${stage}/owners_acl`];
    ok(acl === "false,false,false,false,false,false",
       `[${variant}/${stage}] anon/authenticated owners tablosunda HİÇBİR yetkiye sahip değil`, acl);
  }
}

section("E) SAHİPLİK DEVREDİLEMEZ (ilk meşru sahip kalıcı)");
{
  const rows = results["permissive/merged/owners_rows"] ?? "";
  ok(rows.includes(`${P_B_QM}->${B_UID}`), "B'nin QM oyuncusunun sahibi HÂLÂ B", rows);
  ok(!rows.includes(`${P_B_QM}->${A_UID}`), "A, B'nin QM oyuncusunun sahibi OLAMADI", rows);
  ok(!rows.includes(`${P_B_CODE}->${A_UID}`), "A, B'nin ODA-KODU oyuncusunun sahibi OLAMADI", rows);
  ok(rows.includes(`${P_A_QM}->${A_UID}`), "A kendi QM oyuncusunun sahibi (meşru akış korunuyor)", rows);
}

/* ══════════════════════════════════════════════════════════════════════════
   F) 20260827130000 — wheel_duel_reset_quick_match (kapsam + ACL + yarış)
   ══════════════════════════════════════════════════════════════════════════ */
section("F) Hızlı Eşleş RESET RPC'si — kapsam, ACL, yarış");
{
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, L0);
  psql(container, DB, L1);
  psql(container, DB, QM_MODEL("permissive"));
  psql(container, DB, FIXTURES);
  psql(container, DB, MIG_140);
  psql(container, DB, MIG_130);
  psql(container, DB, ENQUEUE_LEGIT);
  psql(container, DB, MATCH_FORMS);   // iki kuyruk satırı da matched_room_id taşır

  const queueOf = (uid: string) => psql(container, DB,
    `select coalesce(string_agg(coalesce(matched_room_id::text,'null'), ','), '(satır yok)')
       from public.wheel_duel_queue where profile_id = '${uid}';`, true).trim();

  ok(queueOf(B_UID).includes(ROOM_Q), "başlangıç: B'nin kuyruk satırı BİTMİŞ maçın odasını taşıyor", queueOf(B_UID));

  // 1) ACL
  const aclFn = psql(container, DB, `
    select has_function_privilege('anon','public.wheel_duel_reset_quick_match(uuid)','EXECUTE')::text || '/' ||
           has_function_privilege('authenticated','public.wheel_duel_reset_quick_match(uuid)','EXECUTE')::text || '/' ||
           (select prosecdef::text from pg_proc where oid = 'public.wheel_duel_reset_quick_match(uuid)'::regprocedure) || '/' ||
           (select array_to_string(proconfig,',') from pg_proc where oid = 'public.wheel_duel_reset_quick_match(uuid)'::regprocedure);`,
    true).trim();
  ok(aclFn === "false/true/true/search_path=public, pg_temp",
     "reset: anon EXECUTE YOK, authenticated VAR, SECURITY DEFINER, sabit search_path", aclFn);

  const aclQueue = psql(container, DB, `
    select has_table_privilege('authenticated','public.wheel_duel_queue','DELETE')::text || '/' ||
           has_table_privilege('authenticated','public.wheel_duel_queue','INSERT')::text || '/' ||
           has_table_privilege('authenticated','public.wheel_duel_queue','UPDATE')::text || '/' ||
           has_table_privilege('anon','public.wheel_duel_queue','DELETE')::text;`, true).trim();
  ok(aclQueue === "false/false/false/false",
     "reset GENİŞ bir DELETE yetkisi AÇMIYOR (kuyruk DML'i hâlâ kapalı)", aclQueue);

  // 2) Kapsam: A, B'nin kuyruğunu sıfırlayamaz
  let crossErr = "";
  try {
    psql(container, DB, `begin;
      select set_config('torble.uid','${A_UID}',false);
      set local role authenticated;
      select public.wheel_duel_reset_quick_match('${B_UID}');
      commit;`);
  } catch (e) { crossErr = String((e as Error).message ?? e); }
  ok(/does not match p_profile_id/.test(crossErr),
     "A, B'nin kuyruk durumunu SIFIRLAYAMAZ (auth.uid() kapsamı)", crossErr.slice(0, 110));
  ok(queueOf(B_UID).includes(ROOM_Q), "reddedilen çağrı B'nin satırına DOKUNMADI", queueOf(B_UID));

  // 3) Kimliksiz (anon) çağrı reddedilir
  let anonErr = "";
  try {
    psql(container, DB, `begin;
      select set_config('torble.uid','',false);
      set local role authenticated;
      select public.wheel_duel_reset_quick_match('${B_UID}');
      commit;`);
  } catch (e) { anonErr = String((e as Error).message ?? e); }
  ok(/not authenticated/.test(anonErr), "kimliksiz çağrı reddedilir", anonErr.slice(0, 90));

  // 4) Kendi satırını sıfırlama: bayat matched_room_id GERÇEKTEN gider
  psql(container, DB, `begin;
    select set_config('torble.uid','${B_UID}',false);
    set local role authenticated;
    select public.wheel_duel_reset_quick_match('${B_UID}');
    commit;`);
  ok(queueOf(B_UID) === "(satır yok)",
     "kendi satırını sıfırlama: bayat matched_room_id SİLİNDİ → eski oda yeniden açılamaz", queueOf(B_UID));
  ok(queueOf(A_UID).includes(ROOM_Q), "A'nın satırı ETKİLENMEDİ (kapsam sızmıyor)", queueOf(A_UID));

  // 5) Reset SONRASI aktif maçta yetki AYAKTA (kalıcı sahiplik sayesinde)
  const stillAuth = psql(container, DB, `begin;
    select set_config('torble.uid','${B_UID}',false);
    set local role authenticated;
    select public.wheel_duel_authorize_player('${P_B_QM}'::uuid, null)::text;
    commit;`, true).trim();
  ok(yes(stillAuth), "reset SONRASI B hâlâ kendi aktif maçında yetkili", lastLine(stillAuth));

  // 6) Yarış: reset + hemen yeni arama → taze satır, matched_room_id NULL
  psql(container, DB, `begin;
    select set_config('torble.uid','${B_UID}',false);
    set local role authenticated;
    select public.wheel_duel_reset_quick_match('${B_UID}');
    select public.wheel_duel_quick_match('${B_UID}','00000000-0000-4000-8000-0000000000b9','B',60,'world',0,'NEW001','276');
    commit;`);
  ok(queueOf(B_UID) === "null",
     "reset + yeni arama AYNI transaction'da güvenli: taze satır, matched_room_id NULL", queueOf(B_UID));

  // 7) Reset İKİ KEZ çağrılabilir (idempotent, satır yoksa hata yok)
  let twiceErr = "";
  try {
    psql(container, DB, `begin;
      select set_config('torble.uid','${A_UID}',false);
      set local role authenticated;
      select public.wheel_duel_reset_quick_match('${A_UID}');
      select public.wheel_duel_reset_quick_match('${A_UID}');
      commit;`);
  } catch (e) { twiceErr = String((e as Error).message ?? e); }
  ok(twiceErr === "", "reset idempotent (satır yokken de hatasız)", twiceErr.slice(0, 90));

  psql(container, "postgres", `drop database if exists ${DB};\n`);
}

/* ══════════════════════════════════════════════════════════════════════════
   G) SIRA BAĞIMSIZLIĞI — RPC oyuncu satırını ÖNCE yazsa bile sahiplik doğar
   ══════════════════════════════════════════════════════════════════════════
   Birleşik 20260827140000'in guard'ı "zaten var olan oyuncu satırı" ölçütünü
   `p.joined_at < now()` ile kurar. now() = transaction_timestamp olduğundan
   AYNI transaction'da yazılan satır bu ölçütü SAĞLAMAZ. Bu, görülmeyen
   `wheel_duel_quick_match` gövdesinin yazım SIRASINI bilmek zorunda
   kalmadığımızın kanıtıdır — ve yanlışsa MEŞRU Hızlı Eşleş kırılırdı. */
section("G) Sahiplik, RPC'nin yazım sırasından BAĞIMSIZ doğuyor");
{
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, L0);
  psql(container, DB, L1);
  psql(container, DB, FIXTURES);
  psql(container, DB, MIG_140);

  // Eşleşme ANINDA kurulan RPC: ÖNCE oyuncu satırları, SONRA kuyruk upsert'ü.
  const P_NEW = "00000000-0000-4000-8000-0000000000c1";
  psql(container, DB, String.raw`
create or replace function public.wheel_duel_quick_match_playerfirst(
  p_profile_id uuid, p_player_id uuid
) returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null or auth.uid() <> p_profile_id then
    raise exception 'auth_required' using errcode='42501';
  end if;
  -- 1) oyuncu satırı (eşleşme kuruluyor)
  insert into public.wheel_duel_players (id, room_id, name, profile_id, guest_id)
  values (p_player_id, '${ROOM_Q}', 'qm', null, null);
  -- 2) kuyruk satırı AYNI transaction'da
  insert into public.wheel_duel_queue as q
    (profile_id, player_id, player_name, duration_seconds, region, matched_room_id)
  values (p_profile_id, p_player_id, 'qm', 60, 'world', '${ROOM_Q}')
  on conflict (profile_id) do update set player_id = excluded.player_id,
        matched_room_id = excluded.matched_room_id;
end $$;
grant execute on function public.wheel_duel_quick_match_playerfirst(uuid,uuid) to authenticated;`);

  psql(container, DB, `begin;
    select set_config('torble.uid','${B_UID}',false);
    set local role authenticated;
    select public.wheel_duel_quick_match_playerfirst('${B_UID}','${P_NEW}');
    commit;`);

  const owner = psql(container, DB,
    `select coalesce((select profile_id::text from public.wheel_duel_quick_match_owners
                       where player_id = '${P_NEW}'), '(sahip yok)');`, true).trim();
  ok(lastLine(owner) === B_UID,
     "oyuncu satırı ÖNCE yazılsa bile sahiplik B'ye kaydedildi (meşru QM kırılmıyor)", lastLine(owner));

  const auth = psql(container, DB, `begin;
    select set_config('torble.uid','${B_UID}',false);
    set local role authenticated;
    select public.wheel_duel_authorize_player('${P_NEW}'::uuid, null)::text;
    commit;`, true).trim();
  ok(yes(auth), "ve bu oyuncu gameplay için YETKİLİ", lastLine(auth));

  // Aynı id'ye SONRADAN başka hesap bağlanamaz (ayrı transaction → satır ARTIK
  // var). Saldırının gerçek yolu SADECE kuyruğa yazmaktır (oyuncu satırını da
  // yazmayı denemek zaten primary-key ihlaline çarpar — ayrıca ölçülür).
  psql(container, DB, QM_MODEL("permissive"));
  let plantErr = "";
  try {
    psql(container, DB, `begin;
      select set_config('torble.uid','${A_UID}',false);
      set local role authenticated;
      select public.wheel_duel_quick_match('${A_UID}','${P_NEW}','A',60,'world',0,'ATK9','792');
      commit;`);
  } catch (e) { plantErr = errText(e); }
  ok(/duplicate key|unique/i.test(plantErr),
     "B'nin kuyruk satırı dururken A aynı player_id'yi EKEMİYOR (üretimdeki UNIQUE(player_id))",
     plantErr.slice(0, 90));
  const owner2 = psql(container, DB,
    `select profile_id::text from public.wheel_duel_quick_match_owners where player_id='${P_NEW}';`, true).trim();
  ok(lastLine(owner2) === B_UID, "sahiplik hâlâ B'de (A devralamadı)", lastLine(owner2));

  const aAuth = psql(container, DB, `begin;
    select set_config('torble.uid','${A_UID}',false);
    set local role authenticated;
    select public.wheel_duel_authorize_player('${P_NEW}'::uuid, null)::text;
    commit;`, true).trim();
  ok(!yes(aAuth), "A, kuyruğa yazsa bile B'nin oyuncusu olarak YETKİLENEMİYOR", lastLine(aAuth));

  psql(container, "postgres", `drop database if exists ${DB};\n`);
}

/* ══════════════════════════════════════════════════════════════════════════
   H) UÇTAN UCA HEDEF YETKİSİ — tüm migration'lar uygulanmış hâlde
   ══════════════════════════════════════════════════════════════════════════ */
section("H) Hedef claim'i uçtan uca (registered QM + oda-kodu)");
{
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, L0);
  psql(container, DB, L1);
  psql(container, DB, QM_MODEL("permissive"));
  psql(container, DB, FIXTURES);
  psql(container, DB, MIG_140);
  psql(container, DB, MIG_130);
  psql(container, DB, ENQUEUE_LEGIT);
  psql(container, DB, MATCH_FORMS);

  const claim = (uid: string | null, player: string, room: string, target: string, token: string | null = null) => {
    try {
      return lastLine(psql(container, DB, `begin;
        select set_config('torble.uid', ${uid ? `'${uid}'` : "''"}, false);
        set local role authenticated;
        select coalesce(public.wheel_duel_claim_target('${room}','${player}',${token ? `'${token}'` : "null"},'${target}')->>'claimed','?');
        commit;`, true));
    } catch (e) { return "ERR:" + errText(e).slice(0, 90); }
  };
  const targetOf = (room: string) => lastLine(psql(container, DB,
    `select coalesce(current_target_topoid,'-') from public.wheel_duel_rooms where id='${room}';`, true));

  // 1) Kayıtlı Hızlı Eşleş: doğru hedefi kapabiliyor
  ok(claim(B_UID, P_B_QM, ROOM_Q, "276") === "true",
     "registered QM: B doğru hedefi KAPTI (claimed=true)");
  ok(targetOf(ROOM_Q) === "-", "claim sonrası sunucu hedefi düşürdü");

  // 2) Rakip, B adına claim ATAMAZ
  psql(container, DB, `update public.wheel_duel_rooms set current_target_topoid='036' where id='${ROOM_Q}';`);
  ok(claim(A_UID, P_B_QM, ROOM_Q, "036").startsWith("ERR:"),
     "rakip (A), B'nin player_id'siyle claim ATAMIYOR", claim(A_UID, P_B_QM, ROOM_Q, "036"));
  ok(targetOf(ROOM_Q) === "036", "reddedilen claim hedefi DEĞİŞTİRMEDİ");

  // 3) A kendi oyuncusuyla claim atabiliyor (meşru rakip akışı bozulmadı)
  ok(claim(A_UID, P_A_QM, ROOM_Q, "036") === "true",
     "A kendi QM oyuncusuyla doğru hedefi KAPABİLİYOR");

  // 4) Kuyruk sıfırlandıktan SONRA da B aktif maçında claim atabiliyor
  psql(container, DB, `update public.wheel_duel_rooms set current_target_topoid='392' where id='${ROOM_Q}';`);
  psql(container, DB, `begin;
    select set_config('torble.uid','${B_UID}',false);
    set local role authenticated;
    select public.wheel_duel_reset_quick_match('${B_UID}');
    commit;`);
  ok(claim(B_UID, P_B_QM, ROOM_Q, "392") === "true",
     "kuyruk RESET edildikten sonra da B AKTİF maçında claim atabiliyor (kalıcı sahiplik)");

  // 5) Oda-kodu akışı: kayıtlı oyuncu regresyonsuz
  ok(claim(B_UID, P_B_CODE, ROOM_C, "792") === "true",
     "oda-kodu: B kendi kayıtlı oyuncusuyla claim atabiliyor (regresyon yok)");

  // 6) Çapraz oda: B'nin QM oyuncusu ODA-KODU odasında claim atamaz
  psql(container, DB, `update public.wheel_duel_rooms set current_target_topoid='792' where id='${ROOM_C}';`);
  ok(claim(B_UID, P_B_QM, ROOM_C, "792").startsWith("ERR:"),
     "çapraz oda yükseltmesi YOK (player_room_mismatch)", claim(B_UID, P_B_QM, ROOM_C, "792"));

  psql(container, "postgres", `drop database if exists ${DB};\n`);
}

/* ══════════════════════════════════════════════════════════════════════════
   I) FORFEIT — A, B adına maçı DÜŞÜREMEZ (gerçek wheel_duel_leave_room)
   ══════════════════════════════════════════════════════════════════════════ */
section("I) A, B adına maçı terk edip düşüremiyor");
{
  const build = (withMerged: boolean) => {
    psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
    psql(container, DB, L0);
    psql(container, DB, L1);
    psql(container, DB, QM_MODEL("permissive"));
    psql(container, DB, FIXTURES);
    if (withMerged) psql(container, DB, MIG_140);
    psql(container, DB, ENQUEUE_LEGIT);
    psql(container, DB, MATCH_FORMS);
    // Saldırgan kurbanın player_id'siyle kuyruğa girer.
    // ODA-KODU kurbanı seçilir: üretimdeki UNIQUE(player_id) kısıtı, kuyrukta
    // satırı OLAN bir oyuncuya ekimi ZATEN reddediyor (bağımsız katman);
    // gerçek P0 yüzeyi kuyrukta satırı OLMAYAN oyuncudur.
    try {
      psql(container, DB, `begin;
        select set_config('torble.uid','${A_UID}',false);
        set local role authenticated;
        select public.wheel_duel_quick_match('${A_UID}','${P_B_CODE}','A',60,'world',0,'ATK','792');
        commit;`);
    } catch { /* UNIQUE ile reddedilirse saldırı zaten kurulamaz */ }
  };
  const leaveAs = (uid: string, player: string, room: string) => {
    try {
      psql(container, DB, `begin;
        select set_config('torble.uid','${uid}',false);
        set local role authenticated;
        select public.wheel_duel_leave_room('${room}','${player}',null);
        commit;`);
      return "OK";
    } catch (e) { return "ERR:" + errText(e).slice(0, 90); }
  };
  const roomAlive = () => lastLine(psql(container, DB,
    `select coalesce((select status from public.wheel_duel_rooms where id='${ROOM_C}'), 'SİLİNDİ');`, true));

  // Önce açığı göster: merged migration OLMADAN forfeit mümkün.
  build(false);
  const before = leaveAs(A_UID, P_B_CODE, ROOM_C);
  ok(before === "OK", "BASELINE: A, B adına leave_room çağırabiliyor (açık)", before);
  ok(roomAlive() !== "playing", "BASELINE: kurbanın maçı düştü", roomAlive());

  // Sonra kapat.
  build(true);
  const after = leaveAs(A_UID, P_B_CODE, ROOM_C);
  ok(after.startsWith("ERR:") && /unauthorized/.test(after),
     "MERGED: A, B adına leave_room çağıramıyor (unauthorized)", after);
  ok(roomAlive() === "playing", "MERGED: kurbanın maçı AYAKTA kaldı", roomAlive());
  // Meşru sahibi hâlâ çıkabilmeli.
  ok(leaveAs(B_UID, P_B_CODE, ROOM_C) === "OK", "MERGED: B kendi maçından ÇIKABİLİYOR (regresyon yok)");
}

/* ══════════════════════════════════════════════════════════════════════════
   J) BACKFILL — deploy anında ÇEKİŞMELİ kuyruk satırı: en eski (meşru) kazanır
   ══════════════════════════════════════════════════════════════════════════ */
section("J) Backfill — iç tutarlılık + çekişmede ARIZADA-KAPANIR");
{
  /** Deploy ÖNCESİ durumu kurar (migration henüz yok → trigger yok), sonra
   *  migration'ı uygular ve sahiplik tablosunu okur. */
  const backfillCase = (label: string, setup: string) => {
    psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
    psql(container, DB, L0);
    psql(container, DB, L1);
    psql(container, DB, FIXTURES);
    psql(container, DB, setup);
    psql(container, DB, MIG_140);
    return {
      owner: (pid: string) => lastLine(psql(container, DB,
        `select coalesce((select profile_id::text from public.wheel_duel_quick_match_owners
                           where player_id='${pid}'), '(yok)');`, true)),
      authAs: (uid: string, pid: string) => lastLine(psql(container, DB, `begin;
        select set_config('torble.uid','${uid}',false);
        set local role authenticated;
        select public.wheel_duel_authorize_player('${pid}'::uuid, null)::text;
        commit;`, true)),
      label,
    };
  };
  const liveMatch = `
    insert into public.wheel_duel_players (id, room_id, name, profile_id, guest_id)
    values ('${P_B_QM}', '${ROOM_Q}', 'B-qm', null, null);`;

  // J1 — çekişmesiz CANLI maç: sahiplik taşınır, oyuncu yetkisini KORUR.
  {
    const c = backfillCase("J1", liveMatch + `
      insert into public.wheel_duel_queue (profile_id, player_id, player_name, duration_seconds, region, matched_room_id)
      values ('${B_UID}', '${P_B_QM}', 'B', 60, 'world', '${ROOM_Q}');`);
    ok(c.owner(P_B_QM) === B_UID, "J1 çekişmesiz canlı maç: sahiplik B'ye taşındı", c.owner(P_B_QM));
    ok(c.authAs(B_UID, P_B_QM) === "true", "J1 B'nin canlı maç yetkisi deploy'da KOPMADI");
  }

  // J2 — ÇEKİŞME ÜRETİMDE YAPISAL OLARAK İMKÂNSIZ.
  //      `wheel_duel_queue` üzerinde UNIQUE(player_id) var: aynı player_id'yi
  //      iddia eden İKİNCİ kuyruk satırı YAZILAMAZ. Backfill'deki
  //      "arızada-kapanır çekişme" koşulu bu yüzden hiç tetiklenemeyen bir
  //      kuşak-kemeridir. Burada kısıtın gerçekten koruduğu ÖLÇÜLÜR.
  {
    psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
    psql(container, DB, L0);
    psql(container, DB, L1);
    psql(container, DB, FIXTURES);
    psql(container, DB, liveMatch);
    psql(container, DB, `insert into public.wheel_duel_queue
      (profile_id, player_id, player_name, duration_seconds, region, matched_room_id)
      values ('${B_UID}', '${P_B_QM}', 'B', 60, 'world', '${ROOM_Q}');`);
    let dupErr = "";
    try {
      psql(container, DB, `insert into public.wheel_duel_queue
        (profile_id, player_id, player_name, duration_seconds, region, matched_room_id)
        values ('${A_UID}', '${P_B_QM}', 'A', 60, 'world', null);`);
    } catch (e) { dupErr = errText(e); }
    ok(/duplicate key|unique/i.test(dupErr),
       "J2 aynı player_id'yi iddia eden İKİNCİ kuyruk satırı YAZILAMIYOR (UNIQUE(player_id))",
       dupErr.slice(0, 90));
    psql(container, DB, MIG_140);
    const owner = lastLine(psql(container, DB,
      `select coalesce((select profile_id::text from public.wheel_duel_quick_match_owners
                         where player_id='${P_B_QM}'), '(yok)');`, true));
    ok(owner === B_UID, "J2 tek meşru satır sahiplik üretti", owner);
  }

  // J3 — ekilmiş satır TEK BAŞINA (eşleşmemiş): kanıt sayılmaz.
  {
    const c = backfillCase("J3", liveMatch + `
      insert into public.wheel_duel_queue (profile_id, player_id, player_name, duration_seconds, region, matched_room_id)
      values ('${A_UID}', '${P_B_QM}', 'A', 60, 'world', null);`);
    ok(c.owner(P_B_QM) === "(yok)", "J3 eşleşmemiş ekilmiş satır sahiplik ÜRETMEZ", c.owner(P_B_QM));
    ok(c.authAs(A_UID, P_B_QM) === "false", "J3 saldırgan yetkilenemedi");
  }

  // J4 — ekilmiş satır SALDIRGANIN KENDİ odasını gösteriyor: iç tutarlılık düşer
  //      (kurbanın oyuncusu o odanın üyesi değil).
  {
    const c = backfillCase("J4", liveMatch + `
      insert into public.wheel_duel_players (id, room_id, name, profile_id, guest_id)
      values ('${P_A_QM}', '${ROOM_C}', 'A-own', null, null);
      insert into public.wheel_duel_queue (profile_id, player_id, player_name, duration_seconds, region, matched_room_id)
      values ('${A_UID}', '${P_B_QM}', 'A', 60, 'world', '${ROOM_C}');`);
    ok(c.owner(P_B_QM) === "(yok)",
       "J4 saldırganın kendi odasını gösteren satır sahiplik ÜRETMEZ", c.owner(P_B_QM));
    ok(c.authAs(A_UID, P_B_QM) === "false", "J4 saldırgan yetkilenemedi");
  }

  // J5 — kurbanın ODA-KODU oyuncusu (kimliği DOLU): asla ele geçirilemez.
  {
    const c = backfillCase("J5", `
      insert into public.wheel_duel_queue (profile_id, player_id, player_name, duration_seconds, region, matched_room_id)
      values ('${A_UID}', '${P_B_CODE}', 'A', 60, 'world', '${ROOM_C}');`);
    ok(c.owner(P_B_CODE) === "(yok)",
       "J5 kayıtlı kurbanın oyuncusuna sahiplik ÜRETİLMEDİ (kimlik çelişkisi)", c.owner(P_B_CODE));
    ok(c.authAs(A_UID, P_B_CODE) === "false", "J5 saldırgan yetkilenemedi");
    ok(c.authAs(B_UID, P_B_CODE) === "true", "J5 gerçek sahibi (kayıtlı dal) etkilenmedi");
  }

  // J6 — BİTMİŞ oda: kalıcı sahiplik gereksiz, yazılmaz (yüzey daralır).
  {
    const c = backfillCase("J6", liveMatch + `
      update public.wheel_duel_rooms set status='finished' where id='${ROOM_Q}';
      insert into public.wheel_duel_queue (profile_id, player_id, player_name, duration_seconds, region, matched_room_id)
      values ('${B_UID}', '${P_B_QM}', 'B', 60, 'world', '${ROOM_Q}');`);
    ok(c.owner(P_B_QM) === "(yok)", "J6 bitmiş maç için sahiplik yazılmaz", c.owner(P_B_QM));
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   L) ŞEMA SAĞLAMLIĞI — üretimdeki 42703 bir daha olmasın
   ══════════════════════════════════════════════════════════════════════════ */
section("L) Şema sağlamlığı: yalnız kanıtlanmış kuyruk kolonları");
{
  // L1 — statik: migration'ın kuyruğa dair kullandığı kolonlar allowlist'te mi?
  const code = MIG_140.replace(/--[^\n]*/g, "");
  const used = new Set((code.match(/\bq2?\.[a-z_]+/g) ?? []).map(x => x.split(".")[1]));
  const allowed = new Set(["profile_id", "player_id", "matched_room_id"]);
  const extra = [...used].filter(c => !allowed.has(c));
  ok(extra.length === 0,
     "migration YALNIZ kanıtlanmış kuyruk kolonlarını kullanıyor", extra.join(","));
  ok(!/updated_at/.test(MIG_140), "dosyada 'updated_at' geçmiyor (0 occurrence)");

  // L2 — davranışsal: fazladan kolonu OLAN bir kuyrukta da sorunsuz uygulanır
  //      (migration kolonların YOKLUĞUNA da VARLIĞINA da bağlı olmamalı).
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, L0);
  // Üst-küme: şemada OLMAYAN ek kolonlar (gerçek şema zaten player_name/
  // region/expires_at içeriyor; onları tekrar eklemek anlamsız olurdu).
  psql(container, DB, `alter table public.wheel_duel_queue
                         add column extra_note text,
                         add column extra_flag boolean default false;`);
  psql(container, DB, L1);
  psql(container, DB, FIXTURES);
  let supersetErr = "";
  try { psql(container, DB, MIG_140); } catch (e) { supersetErr = errText(e).slice(0, 140); }
  ok(supersetErr === "", "üst-küme şemada da hatasız uygulanıyor", supersetErr);

  // L3 — eksik kolon → TEMİZ ön koşul hatası (yarım uygulama değil)
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, L0);
  psql(container, DB, L1);
  psql(container, DB, `alter table public.wheel_duel_queue drop column matched_room_id;`);
  let missingErr = "";
  try {
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", DB,
                            "-q", "-1", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                 { input: MIG_140, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) { missingErr = errText(e); }
  ok(/ÖN KOŞUL EKSİK: wheel_duel_queue\.matched_room_id/.test(missingErr),
     "eksik kolon MIGRATION BAŞLAMADAN temiz ön koşul hatası veriyor", missingErr.slice(0, 140));
  ok(lastLine(psql(container, DB,
       `select (to_regclass('public.wheel_duel_quick_match_owners') is not null)::text;`, true)) === "false",
     "ve hiçbir şey kurulmadı (geri alındı)");

  psql(container, "postgres", `drop database if exists ${DB};\n`);
}

/* ══════════════════════════════════════════════════════════════════════════
   K) ATOMİKLİK — yarım durum COMMIT EDİLEMEZ
   ══════════════════════════════════════════════════════════════════════════
   Dosyanın sonundaki doğrulama bloğu, korumalardan biri eksikse RAISE eder.
   `psql -1` (tek transaction) altında bu, TÜM migration'ın geri alınması
   demektir: "tablo var ama bağlama yok" penceresi oluşamaz. */
section("K) Atomiklik: koruma eksikse migration TÜMÜYLE geri alınır");
{
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  psql(container, DB, L0);
  psql(container, DB, L1);
  psql(container, DB, FIXTURES);
  // Regresyon taklidi: kuyruk yazma kilidi gevşetilmiş olsun (6e tetiklenir).
  psql(container, DB, `grant insert, update, delete on table public.wheel_duel_queue to authenticated;`);

  let err = "";
  try {
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", DB,
                            "-q", "-1", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                 { input: MIG_140, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) { err = errText(e); }
  ok(/yazma kilidi gevşedi/.test(err), "doğrulama bloğu eksik korumayı YAKALADI", err.slice(0, 120));

  const tableLeft = lastLine(psql(container, DB,
    `select (to_regclass('public.wheel_duel_quick_match_owners') is not null)::text;`, true));
  ok(tableLeft === "false",
     "GERİ ALINDI: sahiplik tablosu ortada KALMADI (yarım durum yok)", tableLeft);

  const authzLeft = lastLine(psql(container, DB,
    `select (position('wheel_duel_queue' in regexp_replace(
       pg_get_functiondef(to_regprocedure('public.wheel_duel_authorize_player(uuid,uuid)')),
       '--[^' || chr(10) || ']*', '', 'g')) > 0)::text;`, true));
  ok(authzLeft === "true",
     "GERİ ALINDI: authorize eski (20260814180000) hâlinde kaldı", authzLeft);

  psql(container, "postgres", `drop database if exists ${DB};\n`);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
