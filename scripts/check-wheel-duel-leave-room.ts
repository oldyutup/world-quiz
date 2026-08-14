/**
 * check-wheel-duel-leave-room.ts
 *
 * Çark Düello çıkış yolunun (`wheel_duel_leave_room`) GÜVENLİK ve DURUM
 * sözleşmesini kilitler.
 *
 * NEDEN VAR
 * ─────────
 * 2026-08-14 denetiminde gövdede P0 bir yetkilendirme açığı bulundu: RPC
 * yalnız `wheel_duel_authorize_player` çağırıyordu ("bu player_id senin mi?")
 * ama çağıranın hedef odanın ÜYESİ olup olmadığını HİÇ sormuyordu. `playing`
 * dalı da bu kontrolsüz yoldan geçtiği için odaya hiç girmemiş biri
 *
 *     leave_room(<yabancı oda>, <kendi player_id>, <kendi token>)
 *
 * çağrısıyla CANLI bir maçı bitirip kazananı belirleyebiliyordu (kazanan
 * "caller dışındaki en eski oyuncu" seçildiğinden, kaybeden host ikinci bir
 * misafir kimlikle kendi maçını GALİBİYETE çevirebiliyordu). Hedef seçmek
 * serbestti: `wheel_duel_rooms` SELECT policy'si anon'a `using (true)`.
 * Yanında iki bug daha: `host_player_id IS NULL` odada gövde TAM sessiz
 * no-op'tu ve 'finished' oda host dalında DELETE ediliyordu (rakibin sonuç /
 * XP / rövanş akışıyla yarışıyordu).
 *
 * 20260814160000 üçünü de kesti. Bu dosya o düzeltmenin geri açılmamasını
 * garanti eder.
 *
 * İKİ KATMAN
 * ──────────
 *   A) STATİK — bağımlılıksız. Migration gövdesindeki kontrollerin VARLIĞI ve
 *      SIRASI, grant modeli, kapsam koruması (başka moda/şemaya dokunulmadı).
 *   B) RUNTIME — gerçek Postgres'te clean-room. Şema iki FK dünyasında da
 *      kurulur (repo-truth CASCADE + "hiç cascade yok" en kötü durum) ve tüm
 *      davranış gerçekten çalıştırılarak doğrulanır; eşzamanlı çıkış yarışı
 *      dâhil. Postgres bulunamazsa katman ATLANIR (uyarıyla). Zorunlu kılmak
 *      için: WHEEL_DUEL_LEAVE_REQUIRE_RUNTIME=1
 *
 * Postgres keşfi: çalışan ilk `postgres*` imajlı docker container.
 * Elle seçmek için: WHEEL_DUEL_PG_CONTAINER=<container adı>
 *
 * Çalıştır:  npx tsx scripts/check-wheel-duel-leave-room.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION =
  "supabase/migrations/20260814160000_wheel_duel_leave_room_status_aware_child_cleanup.sql";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  ✗ ${label}${got !== undefined ? `  → ${JSON.stringify(got)}` : ""}`);
  }
}

/* ════════════════════════════════════════════════════════════════════════
   A) STATİK — gövde sözleşmesi
════════════════════════════════════════════════════════════════════════ */
console.log("\nA) Statik sözleşme");

const sql = readFileSync(join(ROOT, MIGRATION), "utf8");
/** Yorumları at: prose'daki terimler false-positive üretmesin. */
const code = sql
  .split("\n")
  .filter(l => !l.trimStart().startsWith("--"))
  .join("\n");

const bodyStart = code.indexOf("create or replace function public.wheel_duel_leave_room");
const body = code.slice(bodyStart);
const at = (needle: string | RegExp) =>
  typeof needle === "string" ? body.indexOf(needle) : body.search(needle);

ok(bodyStart >= 0, "wheel_duel_leave_room create or replace ediliyor");
ok(/wheel_duel_leave_room\(\s*p_room_id\s+uuid,\s*p_player_id\s+uuid,\s*p_claim_token\s+uuid\s*\)/.test(body),
   "imza değişmedi: (p_room_id, p_player_id, p_claim_token uuid)");
ok(/\)\s*returns void/.test(body), "dönüş tipi void");
ok(/security definer/.test(body), "SECURITY DEFINER");
ok(/set search_path = public, auth/.test(body), "search_path = public, auth");

// ── Kontrollerin VARLIĞI ──
ok(at("wheel_duel_authorize_player(p_player_id, p_claim_token)") > 0,
   "yetki: authorize_player çağrılıyor");
ok(/raise exception 'unauthorized' using errcode = '42501'/.test(body),
   "yetkisiz çağrı 42501 unauthorized");
ok(/raise exception 'player_room_mismatch' using errcode = '42501'/.test(body),
   "P0 KİLİDİ: üyelik kontrolü player_room_mismatch (42501) VAR");
ok(/select \* into v_room from public\.wheel_duel_rooms where id = p_room_id for update/.test(body),
   "oda satırı FOR UPDATE ile kilitleniyor");
ok(/v_is_host\s*:=\s*\(v_room\.host_player_id is not null/.test(body),
   "NULL-safe host tespiti (host_player_id NULL'da erken çıkış YOK)");
ok(!/into v_is_host\b/.test(body),
   "eski `select (host_player_id = p_player_id) into v_is_host` deseni KALMADI");

// ── Kontrollerin SIRASI (asıl güvence) ──
const iAuth     = at("wheel_duel_authorize_player(p_player_id, p_claim_token)");
const iLock     = at("for update");
const iMismatch = at("player_room_mismatch");
const iFinished = at(/if v_room\.status = 'finished' then/);
const iPlaying  = at(/if v_room\.status = 'playing' then/);
const iDelRooms = at("delete from public.wheel_duel_rooms");

ok(iAuth < iLock,          "sıra: authorize → kilit", [iAuth, iLock]);
ok(iLock < iMismatch,      "sıra: kilit → üyelik kontrolü", [iLock, iMismatch]);
ok(iMismatch < iFinished,  "sıra: üyelik kontrolü → finished dalı (yabancı çağrı finished'da da REDDEDİLİR)",
   [iMismatch, iFinished]);
ok(iMismatch < iPlaying,   "sıra: üyelik kontrolü → playing forfeit dalı (P0 açığının kapandığı yer)",
   [iMismatch, iPlaying]);
ok(iFinished < iDelRooms,  "sıra: finished no-op → oda DELETE'ten ÖNCE", [iFinished, iDelRooms]);

// ── finished = NO-OP ──
const finishedBlock = body.slice(iFinished, iFinished + 200);
ok(/if v_room\.status = 'finished' then\s+return;\s+end if;/.test(finishedBlock),
   "finished dalı KOŞULSUZ return (host/non-host ayrımı YOK)", finishedBlock.slice(0, 90));

// ── playing = forfeit, oda korunur ──
// Dal, host/non-host ayrımının başladığı `if v_is_host then`e kadar sürer.
const iHostBranch = at(/if v_is_host then/);
const playingBlock = body.slice(iPlaying, iHostBranch > 0 ? iHostBranch : undefined);
ok(/finished_reason\s*=\s*'opponent_left'/.test(playingBlock), "playing → finished_reason='opponent_left'");
ok(/winner_player_id\s*=\s*v_other_id/.test(playingBlock),     "playing → winner = kalan oyuncu");
ok(/and status = 'playing'/.test(playingBlock),                "playing UPDATE'i status guard'lı (CAS)");
ok(!/delete from/.test(playingBlock),                          "playing dalında HİÇBİR DELETE yok");
ok(/order by joined_at asc/.test(playingBlock),                "kazanan seçimi joined_at sırasıyla (semantik değişmedi)");

// ── oda kapatma: child'lar parent'tan ÖNCE, doğru sırayla ──
const iQueue  = at("update public.wheel_duel_queue");
const iSeq    = at("delete from public.wheel_duel_room_sequences");
const iClaims = at("delete from public.wheel_duel_player_claims\n   where player_id in");
const iPlayers= at("delete from public.wheel_duel_players where room_id = p_room_id");
ok(iQueue > 0 && iQueue < iSeq, "temizlik sırası: queue işaretçisi → sequences", [iQueue, iSeq]);
ok(iSeq < iClaims,              "temizlik sırası: sequences → claims", [iSeq, iClaims]);
ok(iClaims < iPlayers,          "temizlik sırası: claims → players", [iClaims, iPlayers]);
ok(iPlayers < iDelRooms,        "temizlik sırası: players → rooms (parent EN SON)", [iPlayers, iDelRooms]);
ok(/set matched_room_id = null/.test(body), "QM kuyruk işaretçisi NULL'lanıyor (dangling bırakılmıyor)");

// ── ACL ──
ok(/revoke all\s+on function public\.wheel_duel_leave_room\(uuid, uuid, uuid\) from public;/.test(code),
   "ACL: PUBLIC'ten revoke");
ok(/grant\s+execute on function public\.wheel_duel_leave_room\(uuid, uuid, uuid\) to anon, authenticated;/.test(code),
   "ACL: anon + authenticated EXECUTE (misafir çıkabilmeli)");

// ── Kapsam koruması ──
ok((code.match(/create or replace function/g) ?? []).length === 1,
   "migration TEK fonksiyon tanımlıyor (yeni yüzey açmıyor)");
ok(!/alter table/i.test(code),    "migration şemaya/FK'ye DOKUNMUYOR");
ok(!/drop function/i.test(code),  "migration fonksiyon DROP etmiyor");
ok(!/create policy|drop policy/i.test(code), "migration RLS policy'lerine DOKUNMUYOR");
for (const other of ["duel_leave_room", "flag_duel_leave_room", "route_duel_leave_room",
                     "wheel_group_leave_room", "duel_group_leave_room", "conquest_leave_room",
                     "tevatur_leave_room", "flag_group_leave_room"]) {
  // Sözcük sınırı ŞART: `wheel_duel_leave_room` kendisi `duel_leave_room`u içerir.
  ok(!new RegExp(`(?<![a-z_])${other}\\b`).test(code),
     `başka modun RPC'sine dokunulmuyor: ${other}`);
}

// ── İstemci sözleşmesi (değişmemeli) ──
const tsx = readFileSync(join(ROOT, "src/components/WheelDuelGame.tsx"), "utf8");
ok(tsx.includes('rpc("wheel_duel_leave_room"'), "istemci hâlâ wheel_duel_leave_room çağırıyor");
for (const p of ["p_room_id:", "p_player_id:", "p_claim_token:"]) {
  ok(new RegExp(`wheel_duel_leave_room"[\\s\\S]{0,200}${p}`).test(tsx),
     `istemci ${p} parametresini gönderiyor`);
}

/* ════════════════════════════════════════════════════════════════════════
   B) RUNTIME — clean-room (gerçek Postgres)
════════════════════════════════════════════════════════════════════════ */

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

-- Supabase auth.uid() taklidi (GUC'tan okur).
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('torble.uid', true), '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated;

-- Canlı kolon seti (match_seq/current_match_id repo dışı ama canlıda var).
create table public.wheel_duel_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'waiting' check (status in ('waiting','playing','finished')),
  duration_seconds int not null default 60 check (duration_seconds > 0),
  region text not null default 'world',
  host_player_id uuid null,
  started_at timestamptz null,
  finished_at timestamptz null,
  finished_reason text null,
  winner_player_id uuid null,
  current_target_topoid text null,
  used_target_topoids text[] not null default '{}',
  pass_requested_by uuid[] not null default '{}',
  pass_target_topoid text null,
  rematch_requested_by uuid[] not null default '{}',
  match_seq int not null default 1,
  current_match_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.wheel_duel_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  name text not null,
  score int not null default 0 check (score >= 0),
  profile_id uuid null,
  guest_id text null,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table public.wheel_duel_player_claims (
  player_id uuid primary key,
  claim_token uuid not null,
  created_at timestamptz not null default now()
);
create table public.wheel_duel_room_sequences (
  room_id uuid primary key,
  targets text[] not null,
  created_at timestamptz not null default now()
);
-- QM kuyruğu: gövdesi repoda YOK, country_duel_queue (20260701120000) şekli model.
-- FK'si canlıda DOĞRULANDI: matched_room_id -> wheel_duel_rooms ON DELETE SET NULL.
create table public.wheel_duel_queue (
  profile_id uuid primary key,
  player_id uuid not null,
  player_name text not null,
  duration_seconds int not null default 60,
  region text not null default 'world',
  mode_level int not null default 1,
  max_level_diff int not null default 0,
  matched_room_id uuid null,
  expires_at timestamptz not null default (now() + interval '45 seconds'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- FK varyantı: -v fk=cascade (repo-truth) | -v fk=noaction (en kötü durum)
select set_config('torble.fk', :'fk', false);
do $do$
declare
  v_fk text := current_setting('torble.fk', true);
  v_players text; v_claims text; v_seq text; v_queue text;
begin
  if v_fk = 'cascade' then
    v_players := 'on delete cascade';   -- 20260514120000
    v_claims  := 'on delete cascade';   -- 20260528120000
    v_seq     := 'on delete cascade';   -- 20260814150000
    v_queue   := 'on delete set null';  -- canlıda doğrulandı (precheck 2026-08-14)
  else
    v_players := ''; v_claims := ''; v_seq := ''; v_queue := '';
  end if;
  execute format('alter table public.wheel_duel_players add constraint wdp_room_fk
    foreign key (room_id) references public.wheel_duel_rooms(id) %s', v_players);
  execute format('alter table public.wheel_duel_player_claims add constraint wdc_player_fk
    foreign key (player_id) references public.wheel_duel_players(id) %s', v_claims);
  execute format('alter table public.wheel_duel_room_sequences add constraint wds_room_fk
    foreign key (room_id) references public.wheel_duel_rooms(id) %s', v_seq);
  execute format('alter table public.wheel_duel_queue add constraint wdq_room_fk
    foreign key (matched_room_id) references public.wheel_duel_rooms(id) %s', v_queue);
end
$do$;
create index on public.wheel_duel_players (room_id);

-- 20260528120000 · yetki yardımcıları (BİREBİR)
create or replace function public.wheel_duel_authorize_player(p_player_id uuid, p_claim_token uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.wheel_duel_players p
      left join public.wheel_duel_player_claims c on c.player_id = p.id
     where p.id = p_player_id
       and ((p.profile_id is not null and p.profile_id = auth.uid())
         or (p_claim_token is not null and c.claim_token = p_claim_token))
  );
$$;
grant execute on function public.wheel_duel_authorize_player(uuid, uuid) to anon, authenticated;
`;

const FIXTURES = String.raw`
create or replace function t_call(p_room uuid, p_player uuid, p_token uuid,
                                  p_role text default 'authenticated', p_uid uuid default null)
returns text language plpgsql as $$
declare v_res text;
begin
  perform set_config('torble.uid', coalesce(p_uid::text, ''), true);
  execute format('set local role %I', p_role);
  begin
    perform public.wheel_duel_leave_room(p_room, p_player, p_token);
    v_res := 'OK';
  exception when others then
    v_res := sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('torble.uid', '', true);
  return v_res;
end $$;

-- R1 test odası (H1 host/kayıtlı, G1 misafir) · R2 YABANCI 'playing' oda
create or replace function t_seed(p_status text, p_host_null boolean default false)
returns void language plpgsql as $$
begin
  delete from public.wheel_duel_queue;
  delete from public.wheel_duel_room_sequences;
  delete from public.wheel_duel_player_claims;
  delete from public.wheel_duel_players;
  delete from public.wheel_duel_rooms;

  insert into public.wheel_duel_rooms(id, code, status, host_player_id, started_at,
                                      current_target_topoid, duration_seconds, current_match_id)
  values ('11111111-1111-1111-1111-111111111111', 'WAAA11', p_status,
          case when p_host_null then null else 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid end,
          case when p_status = 'waiting' then null else now() - interval '10 seconds' end,
          case when p_status = 'playing' then '792' else null end,
          60, '99999999-9999-9999-9999-999999999999');

  insert into public.wheel_duel_players(id, room_id, name, score, profile_id, guest_id, joined_at)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
          'Host', 3, 'cccccccc-1111-1111-1111-111111111111'::uuid, null, now() - interval '5 minutes'),
         ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111',
          'Misafir', 7, null, 'guest-1', now() - interval '4 minutes');

  insert into public.wheel_duel_player_claims(player_id, claim_token) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000000-0000-0000-0000-00000000000a'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000000-0000-0000-0000-00000000000b');

  insert into public.wheel_duel_room_sequences(room_id, targets)
  values ('11111111-1111-1111-1111-111111111111', array['792','276','380']);

  insert into public.wheel_duel_queue(profile_id, player_id, player_name, matched_room_id)
  values ('cccccccc-1111-1111-1111-111111111111'::uuid,
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Host',
          '11111111-1111-1111-1111-111111111111');

  insert into public.wheel_duel_rooms(id, code, status, host_player_id, started_at,
                                      current_target_topoid, duration_seconds)
  values ('22222222-2222-2222-2222-222222222222', 'WBBB22', 'playing',
          'ffffffff-ffff-ffff-ffff-ffffffffff11', now() - interval '10 seconds', '250', 60);
  insert into public.wheel_duel_players(id, room_id, name, score, profile_id, guest_id, joined_at)
  values ('ffffffff-ffff-ffff-ffff-ffffffffff11', '22222222-2222-2222-2222-222222222222',
          'Yabanci1', 1, 'dddddddd-2222-2222-2222-222222222222'::uuid, null, now() - interval '9 minutes'),
         ('ffffffff-ffff-ffff-ffff-ffffffffff22', '22222222-2222-2222-2222-222222222222',
          'Yabanci2', 9, null, 'guest-2', now() - interval '8 minutes');
  insert into public.wheel_duel_player_claims(player_id, claim_token) values
    ('ffffffff-ffff-ffff-ffff-ffffffffff11', 'f0000000-0000-0000-0000-0000000000f1'),
    ('ffffffff-ffff-ffff-ffff-ffffffffff22', 'f0000000-0000-0000-0000-0000000000f2');
end $$;

create or replace function t_room_exists(p uuid) returns boolean language sql as
  $$ select exists(select 1 from public.wheel_duel_rooms where id = p) $$;
create or replace function t_players(p uuid) returns int language sql as
  $$ select count(*)::int from public.wheel_duel_players where room_id = p $$;
create or replace function t_claims_all() returns int language sql as
  $$ select count(*)::int from public.wheel_duel_player_claims $$;
create or replace function t_seq(p uuid) returns int language sql as
  $$ select count(*)::int from public.wheel_duel_room_sequences where room_id = p $$;
`;

const SUITE = String.raw`
drop table if exists t_results;
create table t_results (n serial primary key, grp text, label text, ok boolean, got text);
create or replace function t_ok(p_grp text, p_label text, p_cond boolean, p_got text default null)
returns void language sql as $$
  insert into t_results(grp, label, ok, got) values (p_grp, p_label, p_cond, p_got);
$$;

do $$
declare
  R1 uuid := '11111111-1111-1111-1111-111111111111';
  R2 uuid := '22222222-2222-2222-2222-222222222222';
  H1 uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  G1 uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  F1 uuid := 'ffffffff-ffff-ffff-ffff-ffffffffff11';
  F2 uuid := 'ffffffff-ffff-ffff-ffff-ffffffffff22';
  P1 uuid := 'cccccccc-1111-1111-1111-111111111111';
  P2 uuid := 'dddddddd-2222-2222-2222-222222222222';
  TH uuid := 'a0000000-0000-0000-0000-00000000000a';
  TG uuid := 'b0000000-0000-0000-0000-00000000000b';
  TF uuid := 'f0000000-0000-0000-0000-0000000000f1';
  r text;
  v_room public.wheel_duel_rooms;
begin

-- ══ YETKİ / P0 KİLİDİ ═════════════════════════════════════════════════════
perform t_seed('playing');
r := t_call(R1, F1, TF, 'authenticated', P2);
select * into v_room from public.wheel_duel_rooms where id = R1;
perform t_ok('YETKİ', 'CROSS-ROOM kayıtlı oyuncu → 42501 player_room_mismatch',
             r like '42501%player_room_mismatch%', r);
perform t_ok('YETKİ', 'CROSS-ROOM → CANLI maç HÂLÂ playing (P0 kapalı)', v_room.status = 'playing', v_room.status);
perform t_ok('YETKİ', 'CROSS-ROOM → winner yazılmadı', v_room.winner_player_id is null, v_room.winner_player_id::text);
perform t_ok('YETKİ', 'CROSS-ROOM → finished_reason yazılmadı', v_room.finished_reason is null);
perform t_ok('YETKİ', 'CROSS-ROOM → çağıranın kendi odası da dokunulmadı',
             t_room_exists(R2) and t_players(R2) = 2);

perform t_seed('playing');
r := t_call(R1, F2, 'f0000000-0000-0000-0000-0000000000f2', 'anon', null);
select * into v_room from public.wheel_duel_rooms where id = R1;
perform t_ok('YETKİ', 'CROSS-ROOM MİSAFİR (giriş yok) → 42501', r like '42501%', r);
perform t_ok('YETKİ', 'CROSS-ROOM MİSAFİR → maç HÂLÂ playing', v_room.status = 'playing', v_room.status);

perform t_seed('waiting');
r := t_call(R1, F1, TF, 'authenticated', P2);
perform t_ok('YETKİ', 'CROSS-ROOM waiting odada da → 42501', r like '42501%player_room_mismatch%', r);
perform t_ok('YETKİ', 'CROSS-ROOM waiting → hedef oda dokunulmadı', t_room_exists(R1) and t_players(R1) = 2);

perform t_seed('finished');
r := t_call(R1, F1, TF, 'authenticated', P2);
perform t_ok('YETKİ', 'CROSS-ROOM finished odada da → 42501 (üyelik kontrolü finished''tan ÖNCE)',
             r like '42501%player_room_mismatch%', r);

perform t_seed('waiting');
r := t_call(R1, G1, 'deadbeef-dead-beef-dead-beefdeadbeef', 'anon', null);
perform t_ok('YETKİ', 'misafir YANLIŞ token → 42501 unauthorized', r like '42501%unauthorized%', r);
perform t_ok('YETKİ', 'yanlış token → hiçbir şey silinmedi', t_room_exists(R1) and t_players(R1) = 2);

perform t_seed('waiting');
r := t_call(R1, G1, null, 'anon', null);
perform t_ok('YETKİ', 'misafir token YOK → 42501 unauthorized', r like '42501%unauthorized%', r);

perform t_seed('waiting');
r := t_call(R1, H1, TG, 'anon', null);
perform t_ok('YETKİ', 'BAŞKASININ player_id''si + kendi token''ın → 42501', r like '42501%', r);
perform t_ok('YETKİ', 'başkasının player_id''si → oda dokunulmadı', t_room_exists(R1) and t_players(R1) = 2);

perform t_seed('waiting');
r := t_call(R1, G1, null, 'authenticated', P1);
perform t_ok('YETKİ', 'kayıtlı oyuncu misafirin player_id''siyle → 42501', r like '42501%', r);

perform t_seed('waiting');
r := t_call(R1, H1, null, 'authenticated', P1);
perform t_ok('YETKİ', 'kayıtlı oyuncu token OLMADAN (profile_id ile) YETKİLİ', r = 'OK', r);

perform t_seed('waiting');
r := t_call('00000000-0000-0000-0000-0000000000ff', H1, TH, 'authenticated', P1);
perform t_ok('YETKİ', 'oda yok → sessiz no-op', r = 'OK', r);
perform t_ok('YETKİ', 'oda yok → mevcut oda dokunulmadı', t_room_exists(R1) and t_players(R1) = 2);

-- ══ WAITING ═══════════════════════════════════════════════════════════════
perform t_seed('waiting');
delete from public.wheel_duel_player_claims where player_id = G1;
delete from public.wheel_duel_players where id = G1;
r := t_call(R1, H1, TH, 'authenticated', P1);
perform t_ok('WAITING', 'host tek başına çıkar → RPC hatasız', r = 'OK', r);
perform t_ok('WAITING', 'host tek başına çıkar → oda SİLİNDİ', not t_room_exists(R1));
perform t_ok('WAITING', 'host tek başına çıkar → player kalmadı', t_players(R1) = 0);
perform t_ok('WAITING', 'host tek başına çıkar → sıra deposu kalmadı', t_seq(R1) = 0);
perform t_ok('WAITING', 'host tek başına çıkar → QM kuyruk işaretçisi NULL',
             not exists(select 1 from public.wheel_duel_queue where matched_room_id = R1));
perform t_ok('WAITING', 'host tek başına çıkar → YABANCI oda dokunulmadı',
             t_room_exists(R2) and t_players(R2) = 2);

perform t_seed('waiting');
r := t_call(R1, H1, TH, 'authenticated', P1);
perform t_ok('WAITING', 'host + rakip varken host çıkar → RPC hatasız', r = 'OK', r);
perform t_ok('WAITING', 'host + rakip varken host çıkar → oda SİLİNDİ', not t_room_exists(R1));
perform t_ok('WAITING', 'host + rakip varken host çıkar → İKİ player da silindi', t_players(R1) = 0);
perform t_ok('WAITING', 'host çıkışı → claim artığı yok (yalnız yabancı odanınki)',
             t_claims_all() = 2, t_claims_all()::text);

perform t_seed('waiting');
r := t_call(R1, G1, TG, 'anon', null);
perform t_ok('WAITING', 'non-host (misafir) çıkar → RPC hatasız', r = 'OK', r);
perform t_ok('WAITING', 'non-host çıkar → oda DURUYOR', t_room_exists(R1));
perform t_ok('WAITING', 'non-host çıkar → yalnız kendi satırı gitti', t_players(R1) = 1);
perform t_ok('WAITING', 'non-host çıkar → host satırı duruyor',
             exists(select 1 from public.wheel_duel_players where id = H1));
perform t_ok('WAITING', 'non-host çıkar → kendi claim satırı gitti',
             not exists(select 1 from public.wheel_duel_player_claims where player_id = G1));
perform t_ok('WAITING', 'non-host çıkar → sıra deposu DURUYOR', t_seq(R1) = 1);

-- ══ PLAYING ═══════════════════════════════════════════════════════════════
perform t_seed('playing');
r := t_call(R1, H1, TH, 'authenticated', P1);
select * into v_room from public.wheel_duel_rooms where id = R1;
perform t_ok('PLAYING', 'host çıkar → RPC hatasız', r = 'OK', r);
perform t_ok('PLAYING', 'host çıkar → oda SİLİNMEDİ', t_room_exists(R1));
perform t_ok('PLAYING', 'host çıkar → status=finished', v_room.status = 'finished', v_room.status);
perform t_ok('PLAYING', 'host çıkar → reason=opponent_left', v_room.finished_reason = 'opponent_left',
             v_room.finished_reason);
perform t_ok('PLAYING', 'host çıkar → winner = KALAN oyuncu', v_room.winner_player_id = G1,
             v_room.winner_player_id::text);
perform t_ok('PLAYING', 'host çıkar → finished_at yazıldı', v_room.finished_at is not null);
perform t_ok('PLAYING', 'host çıkar → current_target temizlendi', v_room.current_target_topoid is null);
perform t_ok('PLAYING', 'host çıkar → İKİ player satırı da DURUYOR', t_players(R1) = 2);
perform t_ok('PLAYING', 'host çıkar → skorlar korundu',
             (select score from public.wheel_duel_players where id = G1) = 7);
perform t_ok('PLAYING', 'host çıkar → sıra deposu korundu', t_seq(R1) = 1);

perform t_seed('playing');
r := t_call(R1, G1, TG, 'anon', null);
select * into v_room from public.wheel_duel_rooms where id = R1;
perform t_ok('PLAYING', 'non-host çıkar → RPC hatasız', r = 'OK', r);
perform t_ok('PLAYING', 'non-host çıkar → oda SİLİNMEDİ', t_room_exists(R1));
perform t_ok('PLAYING', 'non-host çıkar → status=finished', v_room.status = 'finished', v_room.status);
perform t_ok('PLAYING', 'non-host çıkar → winner = host', v_room.winner_player_id = H1,
             v_room.winner_player_id::text);
perform t_ok('PLAYING', 'non-host çıkar → player satırları DURUYOR', t_players(R1) = 2);

perform t_seed('playing');
r := t_call(R1, H1, TH, 'authenticated', P1);
r := t_call(R1, H1, TH, 'authenticated', P1);
select * into v_room from public.wheel_duel_rooms where id = R1;
perform t_ok('PLAYING', 'çift çağrı → ikinci çağrı hatasız', r = 'OK', r);
perform t_ok('PLAYING', 'çift çağrı → oda HÂLÂ duruyor (ikinci çağrı finished no-op)',
             t_room_exists(R1) and t_players(R1) = 2);
perform t_ok('PLAYING', 'çift çağrı → sonuç bozulmadı', v_room.winner_player_id = G1,
             v_room.winner_player_id::text);

-- ══ FINISHED = NO-OP ══════════════════════════════════════════════════════
perform t_seed('finished');
update public.wheel_duel_rooms
   set winner_player_id = G1, finished_reason = 'timeout', finished_at = now(),
       rematch_requested_by = array[G1]
 where id = R1;

r := t_call(R1, H1, TH, 'authenticated', P1);
select * into v_room from public.wheel_duel_rooms where id = R1;
perform t_ok('FINISHED', 'HOST çıkar → RPC hatasız (istemci ekranından çıkabilir)', r = 'OK', r);
perform t_ok('FINISHED', 'HOST çıkar → oda DURUYOR (NO-OP)', t_room_exists(R1));
perform t_ok('FINISHED', 'HOST çıkar → İKİ player da duruyor', t_players(R1) = 2);
perform t_ok('FINISHED', 'HOST çıkar → sonuç satırı değişmedi',
             v_room.winner_player_id = G1 and v_room.finished_reason = 'timeout',
             coalesce(v_room.winner_player_id::text,'null') || '/' || coalesce(v_room.finished_reason,'null'));
perform t_ok('FINISHED', 'HOST çıkar → rövanş oyları korundu',
             v_room.rematch_requested_by = array[G1], v_room.rematch_requested_by::text);
perform t_ok('FINISHED', 'HOST çıkar → claim/sequence/queue dokunulmadı',
             t_claims_all() = 4 and t_seq(R1) = 1
             and exists(select 1 from public.wheel_duel_queue where matched_room_id = R1));
perform t_ok('FINISHED', 'HOST çıkar → current_match_id korundu (XP idempotency)',
             v_room.current_match_id = '99999999-9999-9999-9999-999999999999',
             v_room.current_match_id::text);

r := t_call(R1, G1, TG, 'anon', null);
select * into v_room from public.wheel_duel_rooms where id = R1;
perform t_ok('FINISHED', 'NON-HOST çıkar → RPC hatasız', r = 'OK', r);
perform t_ok('FINISHED', 'NON-HOST çıkar → oda DURUYOR (NO-OP)', t_room_exists(R1));
perform t_ok('FINISHED', 'NON-HOST çıkar → kendi satırı bile SİLİNMEDİ', t_players(R1) = 2);
perform t_ok('FINISHED', 'NON-HOST çıkar → sonuç satırı değişmedi',
             v_room.winner_player_id = G1 and v_room.finished_reason = 'timeout');

r := t_call(R1, H1, TH, 'authenticated', P1);
perform t_ok('FINISHED', 'tekrar tekrar çağrı → idempotent no-op',
             r = 'OK' and t_room_exists(R1) and t_players(R1) = 2, r);

-- ══ host_player_id NULL (QM/legacy oda) ═══════════════════════════════════
perform t_seed('waiting', true);
r := t_call(R1, G1, TG, 'anon', null);
perform t_ok('NULL-HOST', 'waiting + üye çıkışı → RPC hatasız (sessiz return YOK)', r = 'OK', r);
perform t_ok('NULL-HOST', 'waiting + üye çıkışı → kendi satırı GERÇEKTEN silindi',
             not exists(select 1 from public.wheel_duel_players where id = G1));

perform t_seed('playing', true);
r := t_call(R1, G1, TG, 'anon', null);
select * into v_room from public.wheel_duel_rooms where id = R1;
perform t_ok('NULL-HOST', 'playing + üye çıkışı → FORFEIT yazıldı',
             v_room.status = 'finished' and v_room.finished_reason = 'opponent_left',
             v_room.status || '/' || coalesce(v_room.finished_reason, 'null'));
perform t_ok('NULL-HOST', 'playing + üye çıkışı → winner = kalan oyuncu', v_room.winner_player_id = H1,
             v_room.winner_player_id::text);
perform t_ok('NULL-HOST', 'playing + üye çıkışı → oda silinmedi', t_room_exists(R1));

perform t_seed('finished', true);
r := t_call(R1, G1, TG, 'anon', null);
perform t_ok('NULL-HOST', 'finished + üye çıkışı → NO-OP', r = 'OK' and t_players(R1) = 2, r);

perform t_seed('waiting', true);
r := t_call(R1, G1, TG, 'anon', null);
r := t_call(R1, H1, TH, 'authenticated', P1);
perform t_ok('NULL-HOST', 'son üye de çıkınca oda kapanır (öksüz kalmaz)', not t_room_exists(R1), r);
perform t_ok('NULL-HOST', 'son üye çıkışı → child artığı yok',
             t_seq(R1) = 0 and t_claims_all() = 2
             and not exists(select 1 from public.wheel_duel_queue where matched_room_id = R1));

-- ══ DB DEĞİŞMEZLERİ (tüm süitin ardından) ═════════════════════════════════
perform t_ok('DB', 'öksüz wheel_duel_players yok',
  not exists(select 1 from public.wheel_duel_players p
              where not exists(select 1 from public.wheel_duel_rooms r where r.id = p.room_id)));
perform t_ok('DB', 'öksüz wheel_duel_player_claims yok',
  not exists(select 1 from public.wheel_duel_player_claims c
              where not exists(select 1 from public.wheel_duel_players p where p.id = c.player_id)));
perform t_ok('DB', 'öksüz wheel_duel_room_sequences yok',
  not exists(select 1 from public.wheel_duel_room_sequences s
              where not exists(select 1 from public.wheel_duel_rooms r where r.id = s.room_id)));
perform t_ok('DB', 'dangling queue.matched_room_id yok',
  not exists(select 1 from public.wheel_duel_queue q where q.matched_room_id is not null
              and not exists(select 1 from public.wheel_duel_rooms r where r.id = q.matched_room_id)));

-- ══ CANLI ACL ═════════════════════════════════════════════════════════════
perform t_ok('ACL', 'SECURITY DEFINER',
  (select prosecdef from pg_proc where oid = 'public.wheel_duel_leave_room(uuid,uuid,uuid)'::regprocedure));
perform t_ok('ACL', 'search_path = public, auth',
  (select array_to_string(proconfig, ',') from pg_proc
    where oid = 'public.wheel_duel_leave_room(uuid,uuid,uuid)'::regprocedure) = 'search_path=public, auth');
perform t_ok('ACL', 'anon EXECUTE var', has_function_privilege('anon',
  'public.wheel_duel_leave_room(uuid,uuid,uuid)', 'execute'));
perform t_ok('ACL', 'authenticated EXECUTE var', has_function_privilege('authenticated',
  'public.wheel_duel_leave_room(uuid,uuid,uuid)', 'execute'));
perform t_ok('ACL', 'dönüş tipi void', (select pg_get_function_result(oid) from pg_proc
  where oid = 'public.wheel_duel_leave_room(uuid,uuid,uuid)'::regprocedure) = 'void');

end $$;

select (case when ok then 't' else 'f' end) || '|' || grp || '|' || label || '|' || coalesce(got, '')
  from t_results order by n;
`;

/** Eşzamanlı çıkış: A tx'i kilidi tutarken B beklemeli, sonda artık kalmamalı. */
const RACE_HOLD = String.raw`
select t_seed('waiting');
begin;
set local role anon;
select public.wheel_duel_leave_room(
  '11111111-1111-1111-1111-111111111111',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'b0000000-0000-0000-0000-00000000000b');
select pg_sleep(2);
commit;
`;
const RACE_JOIN = String.raw`
select set_config('torble.uid', 'cccccccc-1111-1111-1111-111111111111', false);
select public.wheel_duel_leave_room(
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'a0000000-0000-0000-0000-00000000000a');
`;
const RACE_ASSERT = String.raw`
select (select count(*) from wheel_duel_rooms   where id      = '11111111-1111-1111-1111-111111111111')::text || '|' ||
       (select count(*) from wheel_duel_players where room_id = '11111111-1111-1111-1111-111111111111')::text || '|' ||
       (select count(*) from wheel_duel_player_claims c
          where not exists(select 1 from wheel_duel_players p where p.id = c.player_id))::text || '|' ||
       (select count(*) from wheel_duel_room_sequences where room_id = '11111111-1111-1111-1111-111111111111')::text || '|' ||
       (select count(*) from wheel_duel_queue q where q.matched_room_id is not null
          and not exists(select 1 from wheel_duel_rooms r where r.id = q.matched_room_id))::text;
`;

const DB = "wd_leave_check";

function findContainer(): string | null {
  const explicit = process.env.WHEEL_DUEL_PG_CONTAINER;
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

function psql(container: string, db: string, input: string, vars: string[] = [], tuples = false) {
  // -q ŞART: quiet olmadan psql komut etiketlerini (DO / CREATE TABLE …) de
  // stdout'a basar ve satır ayrıştırması bozulur.
  const args = ["exec", "-i", container, "psql", "-U", "postgres", "-d", db,
                "-q", "-v", "ON_ERROR_STOP=1", ...vars.flatMap(v => ["-v", v])];
  if (tuples) args.push("-A", "-t");
  args.push("-f", "-");
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

const container = findContainer();

if (!container) {
  console.log("\nB) Runtime clean-room");
  console.log("  ⚠ ATLANDI — çalışan postgres container'ı bulunamadı.");
  console.log("    (WHEEL_DUEL_PG_CONTAINER=<ad> ile elle gösterilebilir.)");
  if (process.env.WHEEL_DUEL_LEAVE_REQUIRE_RUNTIME === "1") {
    console.log("  ✗ WHEEL_DUEL_LEAVE_REQUIRE_RUNTIME=1 → runtime katmanı ZORUNLU");
    failed++;
  }
} else {
  const migrationSql = readFileSync(join(ROOT, MIGRATION), "utf8");

  for (const fk of ["cascade", "noaction"] as const) {
    console.log(`\nB) Runtime clean-room · FK=${fk}${fk === "cascade" ? " (repo-truth)" : " (en kötü durum)"}`);
    psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
    psql(container, DB, BOOTSTRAP, [`fk=${fk}`]);
    psql(container, DB, migrationSql);
    psql(container, DB, FIXTURES);

    const raw = psql(container, DB, SUITE, [], true);
    let localFail = 0;
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      const [okStr, grp, label, got] = line.split("|");
      const good = okStr === "t";
      if (!good) localFail++;
      ok(good, `[${fk}] ${grp} · ${label}`, good ? undefined : got || "(değer yok)");
    }
    console.log(`  · ${raw.trim().split("\n").length} davranış assert'i, ${localFail} fail`);

    // Eşzamanlı çıkış (yalnız bir kez, repo-truth şemada)
    if (fk === "cascade") {
      const hold = spawn("docker",
        ["exec", "-i", container, "psql", "-U", "postgres", "-d", DB, "-q", "-f", "-"],
        { stdio: ["pipe", "ignore", "ignore"] });
      hold.stdin.end(RACE_HOLD);
      await new Promise(res => setTimeout(res, 900));
      const t0 = Date.now();
      let raceErr = "";
      try { psql(container, DB, RACE_JOIN); } catch (e) { raceErr = String(e); }
      const elapsed = Date.now() - t0;
      await new Promise(res => hold.on("close", res));

      ok(raceErr === "", "[race] eşzamanlı ikinci çıkış hatasız tamamlandı", raceErr.slice(0, 160));
      ok(elapsed > 700, "[race] ikinci çağrı kilidi BEKLEDİ (FOR UPDATE gerçekten seri kılıyor)",
         `${elapsed}ms`);
      const state = psql(container, DB, RACE_ASSERT, [], true).trim();
      ok(state === "0|0|0|0|0",
         "[race] sonda: oda yok, oyuncu yok, öksüz claim/sequence yok, dangling queue yok", state);
    }

    psql(container, "postgres", `drop database if exists ${DB};\n`);
  }
}

/* ════════════════════════════════════════════════════════════════════════ */
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
