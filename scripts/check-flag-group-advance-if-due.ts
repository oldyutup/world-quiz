/**
 * check-flag-group-advance-if-due.ts
 *
 * Bayrak Grup "host-SPOF yok" SÖZLEŞMESİNİ kilitler.
 *
 * NEDEN VAR
 * ─────────
 * Bayrak Grup'ta tur ilerletme ÜÇ ayrı yerden host'un tarayıcısına bağlıydı:
 *   (1) bayrak sırası host'un RAM'indeydi (`buildProgressionQueue` + Math.random,
 *       hiçbir yerde persist DEĞİL → host kaybında yeniden üretilemez),
 *   (2) `flag_group_advance_flag` host-only'di (`flag_group_authorize_host`) ve
 *       sıradaki bayrağı İSTEMCİDEN alıyordu (`p_next_flag`),
 *   (3) non-host güvenlik ağı yalnız "SON tur + pas DEĞİL" dar koşulunda
 *       finalize ediyordu.
 * Host arka plana düşünce maç TÜM oyuncular için donuyordu.
 *
 * 20260814170000 üçünü de kesti: sıra SUNUCUDA üretilip PRIVATE tabloda tutulur,
 * `flag_group_advance_if_due` odanın HER üyesi tarafından çağrılabilir, geçiş
 * anını/karari sunucu kendi saatiyle verir.
 *
 * KATMANLAR
 *   A) STATİK — migration'daki güvenlik kontrolleri ve SIRASI; PRIVATE tablo
 *      kilitleri; eski host-only yolun EXECUTE'unun geri alınmış olması.
 *   B) İSTEMCİ SÖZLEŞMESİ — host-only otomatik yolun tamamen kalkmış olması,
 *      watchdog'un HER istemcide çalışması, uyanma tetikleyicileri, istemcide
 *      bayrak havuzu/sırası KALMAMIŞ olması.
 *   C) DRIFT — (1) zaman sabitleri (10 sn / 2000 ms) istemci ⇄ SQL, (2) tier
 *      ağırlık bantları countries.ts ⇄ SQL, (3) katalog satırları gerçek
 *      `getFlagPool()`/`getFameTier()` çıktısıyla BİREBİR.
 *   D) RUNTIME clean-room (docker postgres) — gerçek davranış: host tamamen
 *      sessizken non-host ilerletme, timeout, pas, CAS, erken no-op, finalize,
 *      skor değişmezliği, yanlış token / cross-room / başka player_id reddi.
 *   E) DAĞILIM PARİTESİ — SQL `flag_group_generate_sequence` ile TS
 *      `buildProgressionQueue` pozisyon-bazlı tier ortalamaları aynı mı
 *      (ürün semantiği "flag dağılımı DEĞİŞMEDİ" iddiasının kanıtı).
 *
 * DRIFT UYARISI: bu dosya migration'ın ve FlagGroupGame'in AYNASIDIR.
 *
 * Çalıştır:  npx tsx scripts/check-flag-group-advance-if-due.ts
 *   Runtime katmanı ZORUNLUDUR (docker postgres gerekir; yoksa test BAŞARISIZ).
 *   Postgres container'ı elle göstermek için: FLAG_GROUP_PG_CONTAINER=<ad>
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getFlagPool,
  getFameTier,
  buildProgressionQueue,
  progressionTierWeights,
} from "../src/data/countries";
import { buildFlagCatalogRows } from "./build-flag-group-catalog";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const MIGRATION   = "supabase/migrations/20260814170000_flag_group_advance_if_due.sql";
const SEQ_BASE    = "supabase/migrations/20260731120000_flag_group_flag_sequence.sql";
const CLIENT      = "src/components/FlagGroupGame.tsx";

const migRaw    = readFileSync(join(ROOT, MIGRATION), "utf8");
const clientRaw = readFileSync(join(ROOT, CLIENT), "utf8");

/** Yorum satırlarını atar — iddialar YALNIZ çalışan SQL üzerinde kurulmalı,
 *  yoksa bir açıklama metni testi yanlışlıkla geçirebilir. */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map(l => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
}
const mig = stripSqlComments(migRaw);
const migFlat = mig.replace(/\s+/g, " ");

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

-- 20260704120000 display-name registry guard'ının taklidi: gerçek gövde bu
-- migration'ın kapsamı DIŞI; burada yalnız adı normalize eden sade sürüm.
create or replace function public.assert_display_name_allowed(
  p_name text, p_profile_id uuid, p_guest_id text
) returns text language plpgsql as $$
begin
  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;
  return btrim(p_name);
end;
$$;

-- Supabase realtime publication taklidi.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;
`;

const FIXTURES = String.raw`
-- 3 oyunculu Bayrak Grup odası (A=host, B, C) + ayrı bir oda (R2/D) cross-room testi için.
-- Hepsi MİSAFİR (profile_id null) → yetki YALNIZ claim_token üzerinden (anon yolu).

insert into public.flag_group_rooms (id, code, status, region, total_rounds, max_players)
values ('11111111-1111-1111-1111-111111111111', 'FG0001', 'waiting', 'world', 5, 10);

insert into public.flag_group_players (id, room_id, name, is_host, status, guest_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Alice', true,  'waiting', 'gA'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Bob',   false, 'waiting', 'gB'),
  ('cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Carol', false, 'waiting', 'gC');

insert into public.flag_group_player_claims (player_id, claim_token) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '0a0a0a0a-0000-0000-0000-00000000000a'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '0b0b0b0b-0000-0000-0000-00000000000b'),
  ('cccccccc-0000-0000-0000-000000000003', '0c0c0c0c-0000-0000-0000-00000000000c');

-- Yabancı oda + yabancı oyuncu (cross-room reddi için)
insert into public.flag_group_rooms (id, code, status, region, total_rounds, max_players)
values ('22222222-2222-2222-2222-222222222222', 'FG0002', 'waiting', 'europe', 5, 10);

insert into public.flag_group_players (id, room_id, name, is_host, status, guest_id) values
  ('dddddddd-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'Dave', true, 'waiting', 'gD');

insert into public.flag_group_player_claims (player_id, claim_token) values
  ('dddddddd-0000-0000-0000-000000000004', '0d0d0d0d-0000-0000-0000-00000000000d');
`;

const SUITE = String.raw`
-- ===========================================================================
-- Bayrak Grup host-SPOF runtime clean-room suite
-- Her satır: ok|grup|etiket|got
-- HOST (Alice) BU DOSYADA HİÇBİR RPC ÇAĞIRMAZ (start_game hariç — ürün gereği
-- maçı host başlatır). Tüm ilerletmeler Bob/Carol tarafından yapılır.
-- ===========================================================================
create temp table res(ord serial, ok boolean, grp text, label text, got text);

create or replace function pg_temp.chk(p_ok boolean, p_grp text, p_label text, p_got text default null)
returns void language sql as $$
  insert into res(ok, grp, label, got) values (coalesce(p_ok,false), p_grp, p_label, p_got);
$$;

-- Bir ifadeyi çalıştırıp SQLSTATE/mesajını döndürür (raise beklenen testler için).
create or replace function pg_temp.errof(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return '';
exception when others then
  return sqlerrm;
end;
$$;


-- ══════════════════════════════════════════════════════════════════════════
-- A) BAŞLANGIÇ — ilk bayrak SUNUCUDAN
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_seq text[]; v_first text;
begin
  -- p_first_flag NULL: eski imza korunur ama değer OKUNMAZ.
  select * into v_room from public.flag_group_start_game(
    '11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
    '0a0a0a0a-0000-0000-0000-00000000000a', null);

  perform pg_temp.chk(v_room.status = 'playing', 'A', 'start_game: oda playing', v_room.status);
  perform pg_temp.chk(v_room.current_flag is not null and v_room.current_flag ~ '^[a-z]{2}$',
    'A', 'ilk bayrak SUNUCUDAN geldi (p_first_flag null olmasına rağmen)', v_room.current_flag);
  perform pg_temp.chk(v_room.current_round = 1 and v_room.flag_seq = 1 and v_room.game_seq = 1,
    'A', 'round=1, flag_seq=1, game_seq=1',
    format('r=%s f=%s g=%s', v_room.current_round, v_room.flag_seq, v_room.game_seq));

  select flags into v_seq from public.flag_group_room_sequences
   where room_id = '11111111-1111-1111-1111-111111111111';
  perform pg_temp.chk(coalesce(array_length(v_seq,1),0) = 196,
    'A', 'PRIVATE sıra üretildi (world havuzu = 196 bayrak)', coalesce(array_length(v_seq,1),0)::text);
  perform pg_temp.chk(v_seq[1] = v_room.current_flag,
    'A', 'ilk bayrak = sıranın BAŞI', format('%s vs %s', v_seq[1], v_room.current_flag));
  perform pg_temp.chk((select array_length(used,1) is null from public.flag_group_room_sequences
                        where room_id = '11111111-1111-1111-1111-111111111111'),
    'A', 'used başlangıçta boş');

  -- Zorluk eğrisi (buildProgressionQueue semantiği): rampa YALNIZ ilk "span"
  -- (=total_rounds=5) pozisyonda ilerler; span'den SONRASI p=1'de kalır, yani
  -- EN ZORDAN başlayarak havuzu boşaltır. Dolayısıyla doğru iddia
  -- "poz 1-2 < poz 6-30"dur (TS ölçümü: 1.22 vs 3.81), "baş < kuyruk" DEĞİL
  -- (kuyrukta yalnız T1/T2 artıkları kalır → TS'te de 1.75).
  perform pg_temp.chk(
    (select avg(fame_tier) from public.flag_group_flag_catalog
      where region='world' and country_code = any(v_seq[1:2]))
    <
    (select avg(fame_tier) from public.flag_group_flag_catalog
      where region='world' and country_code = any(v_seq[6:30])),
    'A', 'progression rampası korunuyor: poz 1-2 tier ort. < poz 6-30 (span sonrası en zor)',
    (select format('%s vs %s',
       round((select avg(fame_tier) from public.flag_group_flag_catalog where region='world' and country_code = any(v_seq[1:2])),2),
       round((select avg(fame_tier) from public.flag_group_flag_catalog where region='world' and country_code = any(v_seq[6:30])),2))));

  perform pg_temp.chk(not exists (
      select 1 from unnest(v_seq) x group by x having count(*) > 1),
    'A', 'sırada TEKRAR eden bayrak yok');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- B) ERKEN ÇAĞRI → NO-OP (mutation yok)
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_before public.flag_group_rooms; v_after public.flag_group_rooms;
begin
  select * into v_before from public.flag_group_rooms where id = '11111111-1111-1111-1111-111111111111';
  select * into v_after from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
    '0b0b0b0b-0000-0000-0000-00000000000b', 1);

  perform pg_temp.chk(v_after.flag_seq = v_before.flag_seq
                  and v_after.current_flag = v_before.current_flag
                  and v_after.current_round = v_before.current_round
                  and v_after.status = 'playing',
    'B', 'çözüm yok + süre dolmadı → NO-OP (hiçbir alan değişmedi)',
    format('f=%s→%s flag=%s→%s', v_before.flag_seq, v_after.flag_seq, v_before.current_flag, v_after.current_flag));
  perform pg_temp.chk((select array_length(used,1) is null from public.flag_group_room_sequences
                        where room_id = '11111111-1111-1111-1111-111111111111'),
    'B', 'erken çağrı used dizisine DOKUNMADI');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- C) CLAIM → NON-HOST ilerletir (host tamamen sessiz)
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_flag text; v_res jsonb; v_new public.flag_group_rooms;
begin
  select * into v_room from public.flag_group_rooms where id = '11111111-1111-1111-1111-111111111111';
  v_flag := v_room.current_flag;

  -- Bob doğru cevabı verir.
  v_res := public.flag_group_submit_claim(
    '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
    '0b0b0b0b-0000-0000-0000-00000000000b', v_flag);
  perform pg_temp.chk((v_res->>'claimed')::boolean, 'C', 'Bob claim KABUL', v_res::text);

  -- Reveal penceresi dolmadan → no-op.
  select * into v_new from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003',
    '0c0c0c0c-0000-0000-0000-00000000000c', 1);
  perform pg_temp.chk(v_new.flag_seq = 1 and v_new.current_round = 1,
    'C', 'claim var ama reveal (2000 ms) dolmadı → NO-OP',
    format('f=%s r=%s', v_new.flag_seq, v_new.current_round));

  -- Reveal penceresini geçmiş say (sunucu saatiyle karşılaştırma testi).
  update public.flag_group_claims set created_at = now() - interval '3 seconds'
   where room_id = '11111111-1111-1111-1111-111111111111';

  -- CAROL (NON-HOST) ilerletir. Host hiçbir şey yapmadı.
  select * into v_new from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003',
    '0c0c0c0c-0000-0000-0000-00000000000c', 1);

  perform pg_temp.chk(v_new.current_round = 2, 'C', 'NON-HOST claim sonrası turu ilerletti (round 1→2)', v_new.current_round::text);
  perform pg_temp.chk(v_new.flag_seq = 2, 'C', 'flag_seq 1→2', v_new.flag_seq::text);
  perform pg_temp.chk(v_new.current_flag is distinct from v_flag,
    'C', 'yeni bayrak geldi ve eskisinden FARKLI', format('%s→%s', v_flag, v_new.current_flag));
  perform pg_temp.chk((select v_flag = any(used) from public.flag_group_room_sequences
                        where room_id = '11111111-1111-1111-1111-111111111111'),
    'C', 'gösterilen bayrak used dizisine eklendi (tekrar gelmez)');
  perform pg_temp.chk((select flags[2] from public.flag_group_room_sequences
                        where room_id = '11111111-1111-1111-1111-111111111111') = v_new.current_flag,
    'C', 'yeni bayrak = PRIVATE sıranın 2. elemanı (sıra korunuyor)');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- D) BAYAT CAS → NO-OP (çift ilerletme yok)
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_new public.flag_group_rooms;
begin
  select * into v_new from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003',
    '0c0c0c0c-0000-0000-0000-00000000000c', 1);   -- hâlâ 1 gönderiyor (bayat)
  perform pg_temp.chk(v_new.flag_seq = 2 and v_new.current_round = 2,
    'D', 'bayat p_expected_flag_seq (1) → NO-OP, flag_seq/round DEĞİŞMEDİ',
    format('f=%s r=%s', v_new.flag_seq, v_new.current_round));
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- E) TIMEOUT — host olmadan, sunucu saatiyle
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_new public.flag_group_rooms; v_flag text;
begin
  select * into v_room from public.flag_group_rooms where id = '11111111-1111-1111-1111-111111111111';
  v_flag := v_room.current_flag;

  -- 10 sn doldu ama reveal (2 sn) dolmadı → HÂLÂ no-op.
  update public.flag_group_rooms set current_flag_at = now() - interval '11 seconds'
   where id = '11111111-1111-1111-1111-111111111111';
  select * into v_new from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
    '0b0b0b0b-0000-0000-0000-00000000000b', 2);
  perform pg_temp.chk(v_new.flag_seq = 2,
    'E', 'timeout(10sn) doldu ama reveal(2sn) dolmadı → NO-OP', v_new.flag_seq::text);

  -- 12 sn geçti → ilerlemeli. Çağıran NON-HOST.
  update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
   where id = '11111111-1111-1111-1111-111111111111';
  select * into v_new from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
    '0b0b0b0b-0000-0000-0000-00000000000b', 2);

  perform pg_temp.chk(v_new.current_round = 3, 'E', 'TIMEOUT non-host tarafından ilerletildi (round 2→3)', v_new.current_round::text);
  perform pg_temp.chk(v_new.flag_seq = 3, 'E', 'flag_seq 2→3', v_new.flag_seq::text);
  perform pg_temp.chk((select v_flag = any(used) from public.flag_group_room_sequences
                        where room_id = '11111111-1111-1111-1111-111111111111'),
    'E', 'TIMEOUT ile geçilen bayrak da used''a girdi (claims''te satırı YOK — tekrar gösterilmez)');
  perform pg_temp.chk(not exists (
      select 1 from public.flag_group_claims
       where room_id = '11111111-1111-1111-1111-111111111111' and game_seq = 1 and flag_seq = 2),
    'E', 'TIMEOUT skor claim''i ÜRETMEDİ (kimseye puan yazılmadı)');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- F) PAS — oylama + ilerletme host olmadan; PAS TURU TÜKETMEZ
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_v jsonb; v_new public.flag_group_rooms; v_flag text; v_round int;
begin
  select * into v_room from public.flag_group_rooms where id = '11111111-1111-1111-1111-111111111111';
  v_flag := v_room.current_flag; v_round := v_room.current_round;

  -- required = floor(3/2)+1 = 2 → Bob + Carol yeter, HOST OY VERMEZ.
  v_v := public.flag_group_toggle_pass_vote(
    '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
    '0b0b0b0b-0000-0000-0000-00000000000b', v_room.game_seq, v_room.current_round, v_room.flag_seq);
  perform pg_temp.chk((v_v->>'required')::int = 2 and (v_v->>'vote_count')::int = 1,
    'F', 'pas eşiği SUNUCUDA hesaplandı: required=2, 1/2', v_v::text);

  v_v := public.flag_group_toggle_pass_vote(
    '11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003',
    '0c0c0c0c-0000-0000-0000-00000000000c', v_room.game_seq, v_room.current_round, v_room.flag_seq);
  perform pg_temp.chk((v_v->>'passed')::boolean, 'F', 'HOST OYU OLMADAN çoğunluk pas geçti', v_v::text);

  update public.flag_group_claims set created_at = now() - interval '3 seconds'
   where room_id = '11111111-1111-1111-1111-111111111111';

  select * into v_new from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003',
    '0c0c0c0c-0000-0000-0000-00000000000c', v_room.flag_seq);

  perform pg_temp.chk(v_new.current_round = v_round,
    'F', 'PAS TURU TÜKETMEZ: round DEĞİŞMEDİ', format('%s→%s', v_round, v_new.current_round));
  perform pg_temp.chk(v_new.flag_seq = v_room.flag_seq + 1,
    'F', 'aynı tur altında YENİ bayrak (flag_seq++)', v_new.flag_seq::text);
  perform pg_temp.chk(v_new.current_flag is distinct from v_flag,
    'F', 'pas sonrası bayrak değişti', format('%s→%s', v_flag, v_new.current_flag));
  perform pg_temp.chk((select v_flag = any(used) from public.flag_group_room_sequences
                        where room_id = '11111111-1111-1111-1111-111111111111'),
    'F', 'paslanan bayrak used''a girdi');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- G) SKOR / KAZANAN DEĞİŞMEDİ
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_scoring int; v_pass int; v_bob int;
begin
  select count(*) into v_scoring from public.flag_group_claims
   where room_id = '11111111-1111-1111-1111-111111111111' and country_code not like '%:%';
  select count(*) into v_pass from public.flag_group_claims
   where room_id = '11111111-1111-1111-1111-111111111111' and country_code like 'pass:%';
  select count(*) into v_bob from public.flag_group_claims
   where room_id = '11111111-1111-1111-1111-111111111111'
     and player_id = 'bbbbbbbb-0000-0000-0000-000000000002' and country_code not like '%:%';

  perform pg_temp.chk(v_scoring = 1, 'G', 'skorlanan claim sayısı 1 (yalnız Bob''un gerçek cevabı)', v_scoring::text);
  perform pg_temp.chk(v_bob = 1, 'G', 'Bob''un puanı 1 — ilerletmeler skoru DEĞİŞTİRMEDİ', v_bob::text);
  perform pg_temp.chk(v_pass = 1, 'G', 'pas sentinel''i 1 adet ve skordan AYRI ("pass:" önekli)', v_pass::text);
  perform pg_temp.chk((select count(*) from public.flag_group_claims
                        where room_id='11111111-1111-1111-1111-111111111111'
                          and player_id='aaaaaaaa-0000-0000-0000-000000000001'
                          and country_code not like '%:%') = 0,
    'G', 'HOST''a (sentinel sahibi) hiç PUAN yazılmadı');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- H) GÜVENLİK — yanlış token / cross-room / başka player_id
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare e text;
begin
  e := pg_temp.errof($q$select public.flag_group_advance_if_due(
        '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
        '99999999-9999-9999-9999-999999999999', 4)$q$);
  perform pg_temp.chk(e = 'unauthorized', 'H', 'YANLIŞ TOKEN → unauthorized', e);

  e := pg_temp.errof($q$select public.flag_group_advance_if_due(
        '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
        null, 4)$q$);
  perform pg_temp.chk(e = 'unauthorized', 'H', 'TOKEN YOK (null) → unauthorized', e);

  -- Dave R2 üyesi, R1''e karışamaz (kendi GEÇERLİ token''ıyla bile).
  e := pg_temp.errof($q$select public.flag_group_advance_if_due(
        '11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000004',
        '0d0d0d0d-0000-0000-0000-00000000000d', 4)$q$);
  perform pg_temp.chk(e = 'player_room_mismatch', 'H', 'CROSS-ROOM (yabancı odanın üyesi) → player_room_mismatch', e);

  -- Bob''un token''ı + Carol''un id''si.
  e := pg_temp.errof($q$select public.flag_group_advance_if_due(
        '11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003',
        '0b0b0b0b-0000-0000-0000-00000000000b', 4)$q$);
  perform pg_temp.chk(e = 'unauthorized', 'H', 'BAŞKA PLAYER_ID + kendi token''ı → unauthorized', e);

  -- Odada hiç olmayan uydurma oyuncu.
  e := pg_temp.errof($q$select public.flag_group_advance_if_due(
        '11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-00000000000e',
        '0b0b0b0b-0000-0000-0000-00000000000b', 4)$q$);
  perform pg_temp.chk(e = 'unauthorized', 'H', 'ODADA OLMAYAN player_id → unauthorized', e);

  perform pg_temp.chk((select flag_seq from public.flag_group_rooms
                        where id = '11111111-1111-1111-1111-111111111111') = 4,
    'H', 'tüm reddedilen çağrılardan sonra oda DEĞİŞMEDİ (flag_seq hâlâ 4)');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- I) MAÇ SONU — son turdan sonra host olmadan finalize
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_new public.flag_group_rooms; i int;
begin
  -- round 3 → 5''e kadar timeout ile ilerlet (hepsi NON-HOST çağrısı).
  for i in 1..2 loop
    select * into v_room from public.flag_group_rooms where id = '11111111-1111-1111-1111-111111111111';
    update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
     where id = '11111111-1111-1111-1111-111111111111';
    select * into v_new from public.flag_group_advance_if_due(
      '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
      '0b0b0b0b-0000-0000-0000-00000000000b', v_room.flag_seq);
  end loop;

  perform pg_temp.chk(v_new.current_round = 5 and v_new.status = 'playing',
    'I', 'son tura (5/5) NON-HOST ilerletmeleriyle gelindi',
    format('r=%s s=%s', v_new.current_round, v_new.status));

  -- Son turu da timeout ile geçir → finalize.
  update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
   where id = '11111111-1111-1111-1111-111111111111';
  select * into v_new from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003',
    '0c0c0c0c-0000-0000-0000-00000000000c', v_new.flag_seq);

  perform pg_temp.chk(v_new.status = 'finished', 'I', 'SON TUR geçilince NON-HOST maçı bitirdi', v_new.status);
  perform pg_temp.chk(v_new.finished_at is not null, 'I', 'finished_at yazıldı');
  perform pg_temp.chk((select count(*) from public.flag_group_players
                        where room_id = '11111111-1111-1111-1111-111111111111' and status = 'finished') = 3,
    'I', 'TÜM oyuncular (host dâhil) sonuç ekranına alındı');

  -- Bitmiş odada tekrar çağrı → idempotent no-op.
  select * into v_new from public.flag_group_advance_if_due(
    '11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002',
    '0b0b0b0b-0000-0000-0000-00000000000b', v_new.flag_seq);
  perform pg_temp.chk(v_new.status = 'finished', 'I', 'bitmiş odada tekrar çağrı → idempotent no-op', v_new.status);
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- J) TEKRAR EDEN BAYRAK YOK + yeni maç yeni sıra
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_used text[]; v_room public.flag_group_rooms; v_old_flags text[]; v_new_flags text[];
begin
  select used into v_used from public.flag_group_room_sequences
   where room_id = '11111111-1111-1111-1111-111111111111';
  perform pg_temp.chk(not exists (select 1 from unnest(v_used) x group by x having count(*) > 1),
    'J', 'used dizisinde TEKRAR yok → hiçbir bayrak iki kez gösterilmedi',
    array_length(v_used,1)::text);

  select flags into v_old_flags from public.flag_group_room_sequences
   where room_id = '11111111-1111-1111-1111-111111111111';

  -- Herkes lobiye döner, host yeni maç başlatır.
  perform public.flag_group_return_to_lobby('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','0a0a0a0a-0000-0000-0000-00000000000a');
  perform public.flag_group_return_to_lobby('11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000002','0b0b0b0b-0000-0000-0000-00000000000b');
  perform public.flag_group_return_to_lobby('11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003','0c0c0c0c-0000-0000-0000-00000000000c');

  select * into v_room from public.flag_group_start_game(
    '11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
    '0a0a0a0a-0000-0000-0000-00000000000a', null);

  perform pg_temp.chk(v_room.game_seq = 2 and v_room.flag_seq = 1 and v_room.current_round = 1,
    'J', 'yeni maç: game_seq=2, flag_seq=1, round=1',
    format('g=%s f=%s r=%s', v_room.game_seq, v_room.flag_seq, v_room.current_round));

  select flags, used into v_new_flags, v_used from public.flag_group_room_sequences
   where room_id = '11111111-1111-1111-1111-111111111111';
  perform pg_temp.chk((select game_seq from public.flag_group_room_sequences
                        where room_id='11111111-1111-1111-1111-111111111111') = 2,
    'J', 'sıra satırı yeni game_seq''e tazelendi');
  perform pg_temp.chk(coalesce(array_length(v_used,1),0) = 0, 'J', 'yeni maçta used SIFIRLANDI',
    coalesce(array_length(v_used,1),0)::text);
  perform pg_temp.chk(v_new_flags is distinct from v_old_flags,
    'J', 'yeni maç YENİ sıra üretti (eski diziyle aynı değil)');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- K) YETKİ YÜZEYİ (grant/revoke)
-- ══════════════════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.chk(has_function_privilege('anon','public.flag_group_advance_if_due(uuid,uuid,uuid,int)','execute'),
    'K', 'advance_if_due anon''a AÇIK (misafir oynayabilir)');
  perform pg_temp.chk(has_function_privilege('authenticated','public.flag_group_advance_if_due(uuid,uuid,uuid,int)','execute'),
    'K', 'advance_if_due authenticated''a AÇIK');

  -- GERİYE UYUMLULUK: eski istemcinin RPC'si ÇAĞRILABİLİR KALMALI (revoke DEĞİL).
  perform pg_temp.chk(has_function_privilege('anon','public.flag_group_advance_flag(uuid,uuid,uuid,int,text)','execute'),
    'K', 'legacy advance_flag anon''a AÇIK KALDI (eski istemci bozulmaz)');
  perform pg_temp.chk(has_function_privilege('authenticated','public.flag_group_advance_flag(uuid,uuid,uuid,int,text)','execute'),
    'K', 'legacy advance_flag authenticated''a AÇIK KALDI');
  perform pg_temp.chk(has_function_privilege('anon','public.flag_group_finalize_game(uuid,uuid,uuid)','execute'),
    'K', 'finalize_game anon''a AÇIK KALDI (eski güvenlik ağı çağrılabilir)');
  perform pg_temp.chk(not has_function_privilege('anon','public.flag_group_advance_core(uuid,int,boolean)','execute'),
    'K', 'advance_core PRIVATE (anon çağıramaz)');
  perform pg_temp.chk(not has_function_privilege('authenticated','public.flag_group_advance_core(uuid,int,boolean)','execute'),
    'K', 'advance_core PRIVATE (authenticated çağıramaz)');
  perform pg_temp.chk(not has_function_privilege('anon','public.flag_group_set_next_round(uuid,uuid,uuid,int,text)','execute'),
    'K', 'set_next_round hâlâ REVOKE (20260731120000 korunuyor)');

  -- Sıra/katalog istemciye KAPALI.
  perform pg_temp.chk(not has_table_privilege('anon','public.flag_group_room_sequences','select'),
    'K', 'flag_group_room_sequences anon SELECT KAPALI (gelecek bayraklar sızmaz)');
  perform pg_temp.chk(not has_table_privilege('authenticated','public.flag_group_room_sequences','select'),
    'K', 'flag_group_room_sequences authenticated SELECT KAPALI');
  perform pg_temp.chk(not has_table_privilege('anon','public.flag_group_flag_catalog','select'),
    'K', 'flag_group_flag_catalog anon SELECT KAPALI');

  -- Yardımcılar istemciden çağrılamaz.
  perform pg_temp.chk(not has_function_privilege('anon','public.flag_group_generate_sequence(text,int)','execute'),
    'K', 'generate_sequence anon''dan REVOKE');
  perform pg_temp.chk(not has_function_privilege('anon','public.flag_group_ensure_sequence(uuid)','execute'),
    'K', 'ensure_sequence anon''dan REVOKE');
  perform pg_temp.chk(not has_function_privilege('anon','public.flag_group_next_flag(uuid)','execute'),
    'K', 'next_flag anon''dan REVOKE (sıradaki bayrak sorgulanamaz)');
  perform pg_temp.chk(not has_function_privilege('authenticated','public.flag_group_next_flag(uuid)','execute'),
    'K', 'next_flag authenticated''dan REVOKE');

  -- RLS + realtime
  perform pg_temp.chk((select relrowsecurity from pg_class where oid = 'public.flag_group_room_sequences'::regclass),
    'K', 'room_sequences RLS AÇIK');
  perform pg_temp.chk((select count(*) from pg_policies where schemaname='public'
                        and tablename in ('flag_group_room_sequences','flag_group_flag_catalog')) = 0,
    'K', 'PRIVATE tablolarda policy YOK → default-deny');
  perform pg_temp.chk((select count(*) from pg_publication_tables where pubname='supabase_realtime'
                        and schemaname='public'
                        and tablename in ('flag_group_room_sequences','flag_group_flag_catalog')) = 0,
    'K', 'PRIVATE tablolar realtime publication DIŞINDA');

  -- SECURITY DEFINER + search_path
  perform pg_temp.chk((select prosecdef from pg_proc where oid = 'public.flag_group_advance_if_due(uuid,uuid,uuid,int)'::regprocedure),
    'K', 'advance_if_due SECURITY DEFINER');
  perform pg_temp.chk((select 'search_path=public, auth' = any(proconfig)
                         from pg_proc where oid = 'public.flag_group_advance_if_due(uuid,uuid,uuid,int)'::regprocedure),
    'K', 'advance_if_due search_path SABİTLENMİŞ',
    (select array_to_string(proconfig,',') from pg_proc where oid='public.flag_group_advance_if_due(uuid,uuid,uuid,int)'::regprocedure));
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- L) KÜÇÜK HAVUZ (Güney Amerika = 12 < 20 tur) → havuz tükenince finalize
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_new public.flag_group_rooms; i int; v_guard int := 0;
begin
  insert into public.flag_group_rooms (id, code, status, region, total_rounds, max_players)
  values ('33333333-3333-3333-3333-333333333333', 'FG0003', 'waiting', 'south_america', 20, 10);
  insert into public.flag_group_players (id, room_id, name, is_host, status, guest_id) values
    ('a3333333-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','Eve',  true,  'waiting','gE'),
    ('b3333333-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','Finn', false, 'waiting','gF');
  insert into public.flag_group_player_claims (player_id, claim_token) values
    ('a3333333-0000-0000-0000-000000000001','03030303-0000-0000-0000-000000000031'),
    ('b3333333-0000-0000-0000-000000000002','03030303-0000-0000-0000-000000000032');

  select * into v_room from public.flag_group_start_game(
    '33333333-3333-3333-3333-333333333333','a3333333-0000-0000-0000-000000000001',
    '03030303-0000-0000-0000-000000000031', null);
  perform pg_temp.chk((select array_length(flags,1) from public.flag_group_room_sequences
                        where room_id='33333333-3333-3333-3333-333333333333') = 12,
    'L', 'Güney Amerika sırası 12 bayrak (total_rounds=20''den KÜÇÜK)');

  -- Hep timeout ile ilerlet; havuz tükenince finalize olmalı (NON-HOST çağırır).
  loop
    v_guard := v_guard + 1;
    exit when v_guard > 40;
    select * into v_room from public.flag_group_rooms where id = '33333333-3333-3333-3333-333333333333';
    exit when v_room.status <> 'playing';
    update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
     where id = '33333333-3333-3333-3333-333333333333';
    select * into v_new from public.flag_group_advance_if_due(
      '33333333-3333-3333-3333-333333333333','b3333333-0000-0000-0000-000000000002',
      '03030303-0000-0000-0000-000000000032', v_room.flag_seq);
  end loop;

  select * into v_room from public.flag_group_rooms where id = '33333333-3333-3333-3333-333333333333';
  perform pg_temp.chk(v_room.status = 'finished',
    'L', 'havuz tükenince NON-HOST finalize etti (sonsuz döngü YOK)', v_room.status);
  perform pg_temp.chk(v_room.current_round = 12,
    'L', 'tur sayısı havuz boyunda durdu (12) — 20''ye zorlanmadı', v_room.current_round::text);
  perform pg_temp.chk(v_guard <= 14, 'L', 'ilerletme adım sayısı havuzla sınırlı', v_guard::text);
end$$;

-- ===========================================================================
-- KARIŞIK SÜRÜM (old client + new client) + LEGACY GÜVENLİK + FINALIZE GRIEFING
-- Her satır: ok|grup|etiket|got
-- ===========================================================================

-- Oda R4: H=host (ESKİ istemci taklidi), M1/M2 = üye (YENİ istemci taklidi)
insert into public.flag_group_rooms (id, code, status, region, total_rounds, max_players)
values ('44444444-4444-4444-4444-444444444444', 'FG0004', 'waiting', 'world', 5, 10);
insert into public.flag_group_players (id, room_id, name, is_host, status, guest_id) values
  ('a4444444-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'Host4', true,  'waiting', 'gH4'),
  ('b4444444-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444444444', 'Mem1',  false, 'waiting', 'gM1'),
  ('c4444444-0000-0000-0000-000000000003', '44444444-4444-4444-4444-444444444444', 'Mem2',  false, 'waiting', 'gM2');
insert into public.flag_group_player_claims (player_id, claim_token) values
  ('a4444444-0000-0000-0000-000000000001', '04040404-0000-0000-0000-000000000041'),
  ('b4444444-0000-0000-0000-000000000002', '04040404-0000-0000-0000-000000000042'),
  ('c4444444-0000-0000-0000-000000000003', '04040404-0000-0000-0000-000000000043');

-- ══════════════════════════════════════════════════════════════════════════
-- M) KARIŞIK SÜRÜM — ESKİ host (advance_flag) + YENİ üye (advance_if_due)
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_new public.flag_group_rooms;
        v_seq text[]; v_flag text; v_expected text; v_res jsonb;
begin
  -- ESKİ istemci start_game'i: kendi RAM'inden bir ilk bayrak GÖNDERİR ('zz'
  -- kasten havuzda OLMAYAN bir değer — sunucu okumuyorsa hiçbir etkisi olmamalı).
  select * into v_room from public.flag_group_start_game(
    '44444444-4444-4444-4444-444444444444','a4444444-0000-0000-0000-000000000001',
    '04040404-0000-0000-0000-000000000041', 'zz');
  select flags into v_seq from public.flag_group_room_sequences
   where room_id = '44444444-4444-4444-4444-444444444444';

  perform pg_temp.chk(v_room.current_flag = v_seq[1] and v_room.current_flag <> 'zz',
    'M', 'ESKİ start_game p_first_flag=''zz'' YOK SAYILDI; ilk bayrak sunucu dizisinden',
    format('current=%s seq[1]=%s', v_room.current_flag, v_seq[1]));
  perform pg_temp.chk(v_room.status = 'playing' and v_room.flag_seq = 1,
    'M', 'ESKİ istemci maçı normal başlatabildi (sözleşme korundu)',
    format('s=%s f=%s', v_room.status, v_room.flag_seq));

  -- ── ESKİ host'un erken advance'i: çözüm YOK + 10 sn dolmadı → round_active
  --    (ESKİ sözleşme birebir; eski istemci bu hatayı bekliyor) ──
  perform pg_temp.chk(
    pg_temp.errof($q$select public.flag_group_advance_flag(
      '44444444-4444-4444-4444-444444444444','a4444444-0000-0000-0000-000000000001',
      '04040404-0000-0000-0000-000000000041', 1, 'us')$q$) = 'round_active',
    'M', 'ESKİ advance_flag erken çağrı → round_active RAISE (eski sözleşme KORUNDU)');

  -- ── Claim + ESKİ host'un ilerletmesi ──
  v_flag := v_room.current_flag;
  v_res := public.flag_group_submit_claim(
    '44444444-4444-4444-4444-444444444444','b4444444-0000-0000-0000-000000000002',
    '04040404-0000-0000-0000-000000000042', v_flag);
  perform pg_temp.chk((v_res->>'claimed')::boolean, 'M', 'Mem1 claim KABUL');

  -- ESKİ istemci reveal'i KENDİ bekler; sunucuda legacy yolda reveal kapısı YOK
  -- → çözüm varken HEMEN ilerlemeli (eski davranış birebir).
  v_expected := v_seq[2];
  select * into v_new from public.flag_group_advance_flag(
    '44444444-4444-4444-4444-444444444444','a4444444-0000-0000-0000-000000000001',
    '04040404-0000-0000-0000-000000000041', 1, 'zz');   -- 'zz' yine YOK SAYILMALI

  perform pg_temp.chk(v_new.current_round = 2 and v_new.flag_seq = 2,
    'M', 'ESKİ host claim sonrası ANINDA ilerletti (reveal beklemeden — eski davranış)',
    format('r=%s f=%s', v_new.current_round, v_new.flag_seq));
  perform pg_temp.chk(v_new.current_flag = v_expected and v_new.current_flag <> 'zz',
    'M', 'ESKİ istemcinin p_next_flag=''zz'' değeri CANONICAL SIRAYI DEĞİŞTİRMEDİ',
    format('current=%s beklenen=%s', v_new.current_flag, v_expected));

  -- ── Aynı anda YENİ üye advance_if_due: bayat flag_seq → TEK GEÇİŞ ──
  select * into v_new from public.flag_group_advance_if_due(
    '44444444-4444-4444-4444-444444444444','c4444444-0000-0000-0000-000000000003',
    '04040404-0000-0000-0000-000000000043', 1);
  perform pg_temp.chk(v_new.current_round = 2 and v_new.flag_seq = 2,
    'M', 'ESKİ advance + YENİ advance_if_due yarışı → TEK transition (CAS)',
    format('r=%s f=%s', v_new.current_round, v_new.flag_seq));

  -- ── YENİ üye devralıyor: host artık HİÇ konuşmuyor (arka planda) ──
  update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
   where id = '44444444-4444-4444-4444-444444444444';
  select * into v_new from public.flag_group_advance_if_due(
    '44444444-4444-4444-4444-444444444444','b4444444-0000-0000-0000-000000000002',
    '04040404-0000-0000-0000-000000000042', 2);
  perform pg_temp.chk(v_new.current_round = 3 and v_new.flag_seq = 3,
    'M', 'ESKİ host sustu → YENİ üye timeout''u ilerletti (host-SPOF YOK)',
    format('r=%s f=%s', v_new.current_round, v_new.flag_seq));

  -- ── Sıra bütünlüğü: iki yol da AYNI diziyi tüketti, tekrar YOK ──
  perform pg_temp.chk((select flags from public.flag_group_room_sequences
                        where room_id='44444444-4444-4444-4444-444444444444') = v_seq,
    'M', 'canonical sıra (flags) İKİ YOL BOYUNCA hiç değişmedi');
  perform pg_temp.chk((select not exists (select 1 from unnest(used) x group by x having count(*) > 1)
                         from public.flag_group_room_sequences
                        where room_id='44444444-4444-4444-4444-444444444444'),
    'M', 'used dizisi bozulmadı (karışık sürümde de tekrar YOK)');
  perform pg_temp.chk(not exists (
      select 1 from public.flag_group_rooms
       where id='44444444-4444-4444-4444-444444444444' and current_flag = 'zz'),
    'M', 'istemcinin uydurduğu ''zz'' hiçbir zaman gösterilmedi');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- N) LEGACY advance_flag — GÜVENLİK (eski semantik korunur)
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare e text; v_fs int;
begin
  select flag_seq into v_fs from public.flag_group_rooms
   where id = '44444444-4444-4444-4444-444444444444';

  -- NON-HOST: eski semantikte de reddediliyordu → RED devam.
  e := pg_temp.errof($q$select public.flag_group_advance_flag(
        '44444444-4444-4444-4444-444444444444','b4444444-0000-0000-0000-000000000002',
        '04040404-0000-0000-0000-000000000042', 3, 'us')$q$);
  perform pg_temp.chk(e = 'unauthorized', 'N', 'legacy: NON-HOST → unauthorized (eski semantik korundu)', e);

  -- Yanlış token.
  e := pg_temp.errof($q$select public.flag_group_advance_flag(
        '44444444-4444-4444-4444-444444444444','a4444444-0000-0000-0000-000000000001',
        '99999999-9999-9999-9999-999999999999', 3, 'us')$q$);
  perform pg_temp.chk(e = 'unauthorized', 'N', 'legacy: YANLIŞ TOKEN → unauthorized', e);

  -- Cross-room: BAŞKA odanın host'u (Dave, R2) bu odaya karışamaz.
  e := pg_temp.errof($q$select public.flag_group_advance_flag(
        '44444444-4444-4444-4444-444444444444','dddddddd-0000-0000-0000-000000000004',
        '0d0d0d0d-0000-0000-0000-00000000000d', 3, 'us')$q$);
  perform pg_temp.chk(e = 'unauthorized', 'N', 'legacy: CROSS-ROOM (yabancı oda host''u) → unauthorized', e);

  perform pg_temp.chk((select flag_seq from public.flag_group_rooms
                        where id='44444444-4444-4444-4444-444444444444') = v_fs,
    'N', 'legacy reddedilen çağrılardan sonra oda DEĞİŞMEDİ');
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- N2) LEGACY p_next_flag manipülasyonu — canonical sıra korunuyor mu?
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_new public.flag_group_rooms;
        v_seq text[]; v_used text[]; v_expected text; i int;
begin
  select flags, used into v_seq, v_used from public.flag_group_room_sequences
   where room_id = '44444444-4444-4444-4444-444444444444';
  select * into v_room from public.flag_group_rooms where id='44444444-4444-4444-4444-444444444444';

  -- Sunucunun SIRADA vereceği bayrak: dizide used'da olmayan ve current olmayan ilk.
  select f.code into v_expected
    from unnest(v_seq) with ordinality as f(code, ord)
   where not (f.code = any (coalesce(v_used,'{}'::text[])))
     and f.code is distinct from v_room.current_flag
   order by f.ord limit 1;

  -- ESKİ host, havuzun EN KOLAY bayrağını (tier 1) zorlamaya çalışıyor.
  update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
   where id = '44444444-4444-4444-4444-444444444444';
  select * into v_new from public.flag_group_advance_flag(
    '44444444-4444-4444-4444-444444444444','a4444444-0000-0000-0000-000000000001',
    '04040404-0000-0000-0000-000000000041', v_room.flag_seq, 'tr');

  perform pg_temp.chk(v_new.current_flag = v_expected,
    'N2', 'host ''tr'' zorladı ama sunucu KENDİ sırasındaki bayrağı verdi',
    format('istenen=tr gelen=%s beklenen=%s', v_new.current_flag, v_expected));
  perform pg_temp.chk((select flags from public.flag_group_room_sequences
                        where room_id='44444444-4444-4444-4444-444444444444') = v_seq,
    'N2', 'canonical dizi (flags) DEĞİŞMEDİ — istemci sıraya yazamaz');

  -- p_next_flag = NULL (eski "havuzum tükendi" sinyali) maçı ERKEN bitirmemeli.
  update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
   where id = '44444444-4444-4444-4444-444444444444';
  select * into v_new from public.flag_group_advance_flag(
    '44444444-4444-4444-4444-444444444444','a4444444-0000-0000-0000-000000000001',
    '04040404-0000-0000-0000-000000000041', v_new.flag_seq, null);
  perform pg_temp.chk(v_new.status = 'playing',
    'N2', 'legacy p_next_flag=NULL maçı ERKEN BİTİRMEDİ (havuz kararı sunucunun)',
    format('s=%s r=%s', v_new.status, v_new.current_round));
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- O) finalize_game — ERKEN BİTİRME (GRIEFING) KAPALI
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_new public.flag_group_rooms; e text;
begin
  -- TAZE oda: R4 önceki bloklarda son tura geldi; orta-oyun griefing'i ancak
  -- gerçekten ORTA turda olan bir odada test edilebilir.
  insert into public.flag_group_rooms (id, code, status, region, total_rounds, max_players)
  values ('66666666-6666-6666-6666-666666666666', 'FG0006', 'waiting', 'world', 10, 10);
  insert into public.flag_group_players (id, room_id, name, is_host, status, guest_id) values
    ('a6666666-0000-0000-0000-000000000001','66666666-6666-6666-6666-666666666666','Host6', true,  'waiting','gH6'),
    ('b6666666-0000-0000-0000-000000000002','66666666-6666-6666-6666-666666666666','Mem6',  false, 'waiting','gM6');
  insert into public.flag_group_player_claims (player_id, claim_token) values
    ('a6666666-0000-0000-0000-000000000001','06060606-0000-0000-0000-000000000061'),
    ('b6666666-0000-0000-0000-000000000002','06060606-0000-0000-0000-000000000062');

  select * into v_room from public.flag_group_start_game(
    '66666666-6666-6666-6666-666666666666','a6666666-0000-0000-0000-000000000001',
    '06060606-0000-0000-0000-000000000061', null);
  -- Tur 2'ye geç (maçın ORTASI), üstelik tur ÇÖZÜLMÜŞ ve reveal DOLMUŞ olsun →
  -- "deadline doldu" bahanesi bile kalmasın; yine de finalize ETMEMELİ.
  update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
   where id = '66666666-6666-6666-6666-666666666666';
  select * into v_room from public.flag_group_advance_if_due(
    '66666666-6666-6666-6666-666666666666','b6666666-0000-0000-0000-000000000002',
    '06060606-0000-0000-0000-000000000062', 1);
  update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
   where id = '66666666-6666-6666-6666-666666666666';
  select * into v_room from public.flag_group_rooms where id='66666666-6666-6666-6666-666666666666';

  perform pg_temp.chk(v_room.status = 'playing' and v_room.current_round = 2
                      and v_room.current_round < v_room.total_rounds,
    'O', 'ön koşul: oda ORTA turda (2/10) ve timeout deadline''i DOLMUŞ',
    format('r=%s/%s', v_room.current_round, v_room.total_rounds));

  -- GRIEFING: kaybeden üye maçı ortada kapatmaya çalışıyor.
  select * into v_new from public.flag_group_finalize_game(
    '66666666-6666-6666-6666-666666666666','b6666666-0000-0000-0000-000000000002',
    '06060606-0000-0000-0000-000000000062');
  perform pg_temp.chk(v_new.status = 'playing',
    'O', 'ERKEN finalize (tur ortasında) → NO-OP, maç BİTMEDİ', v_new.status);
  perform pg_temp.chk((select status from public.flag_group_rooms
                        where id='66666666-6666-6666-6666-666666666666') = 'playing',
    'O', 'DB''de de oda hâlâ playing (mutation yok)');
  perform pg_temp.chk((select count(*) from public.flag_group_players
                        where room_id='66666666-6666-6666-6666-666666666666'
                          and status='finished') = 0,
    'O', 'oyuncular sonuç ekranına ALINMADI');

  -- Süre dolmadan (deadline öncesi) çağrı da NO-OP.
  update public.flag_group_rooms set current_flag_at = now()
   where id = '66666666-6666-6666-6666-666666666666';
  select * into v_new from public.flag_group_finalize_game(
    '66666666-6666-6666-6666-666666666666','a6666666-0000-0000-0000-000000000001',
    '06060606-0000-0000-0000-000000000061');
  perform pg_temp.chk(v_new.status = 'playing',
    'O', 'deadline dolmadan finalize → NO-OP', v_new.status);

  -- Güvenlik: cross-room + yanlış token.
  e := pg_temp.errof($q$select public.flag_group_finalize_game(
        '66666666-6666-6666-6666-666666666666','dddddddd-0000-0000-0000-000000000004',
        '0d0d0d0d-0000-0000-0000-00000000000d')$q$);
  perform pg_temp.chk(e = 'player_room_mismatch', 'O', 'finalize CROSS-ROOM → player_room_mismatch', e);

  e := pg_temp.errof($q$select public.flag_group_finalize_game(
        '66666666-6666-6666-6666-666666666666','b6666666-0000-0000-0000-000000000002',
        '99999999-9999-9999-9999-999999999999')$q$);
  perform pg_temp.chk(e = 'unauthorized', 'O', 'finalize YANLIŞ TOKEN → unauthorized', e);
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- O2) finalize_game — SON TURDA deadline dolunca ÇALIŞIR (eski güvenlik ağı)
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_new public.flag_group_rooms; i int; v_scoring_before int;
begin
  -- Son tura kadar timeout ile ilerlet (YENİ üye yolu).
  for i in 1..10 loop
    select * into v_room from public.flag_group_rooms where id='44444444-4444-4444-4444-444444444444';
    exit when v_room.status <> 'playing' or v_room.current_round >= v_room.total_rounds;
    update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
     where id = '44444444-4444-4444-4444-444444444444';
    select * into v_new from public.flag_group_advance_if_due(
      '44444444-4444-4444-4444-444444444444','b4444444-0000-0000-0000-000000000002',
      '04040404-0000-0000-0000-000000000042', v_room.flag_seq);
  end loop;

  select * into v_room from public.flag_group_rooms where id='44444444-4444-4444-4444-444444444444';
  perform pg_temp.chk(v_room.current_round = 5 and v_room.status = 'playing',
    'O2', 'son tura (5/5) gelindi', format('r=%s s=%s', v_room.current_round, v_room.status));

  -- SON turda henüz süre dolmadı → finalize hâlâ NO-OP.
  update public.flag_group_rooms set current_flag_at = now()
   where id = '44444444-4444-4444-4444-444444444444';
  select * into v_new from public.flag_group_finalize_game(
    '44444444-4444-4444-4444-444444444444','b4444444-0000-0000-0000-000000000002',
    '04040404-0000-0000-0000-000000000042');
  perform pg_temp.chk(v_new.status = 'playing',
    'O2', 'SON turda bile süre dolmadan finalize → NO-OP', v_new.status);

  select count(*) into v_scoring_before from public.flag_group_claims
   where room_id='44444444-4444-4444-4444-444444444444' and country_code not like '%:%';

  -- Süre dolunca ESKİ istemcinin güvenlik ağı çalışmalı.
  update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
   where id = '44444444-4444-4444-4444-444444444444';
  select * into v_new from public.flag_group_finalize_game(
    '44444444-4444-4444-4444-444444444444','b4444444-0000-0000-0000-000000000002',
    '04040404-0000-0000-0000-000000000042');
  perform pg_temp.chk(v_new.status = 'finished',
    'O2', 'SON tur + deadline doldu → ESKİ istemcinin güvenlik ağı ÇALIŞTI', v_new.status);
  perform pg_temp.chk(v_new.finished_at is not null, 'O2', 'finished_at yazıldı');
  perform pg_temp.chk((select count(*) from public.flag_group_players
                        where room_id='44444444-4444-4444-4444-444444444444' and status='finished') = 3,
    'O2', 'tüm oyuncular sonuç ekranına alındı');
  perform pg_temp.chk((select count(*) from public.flag_group_claims
                        where room_id='44444444-4444-4444-4444-444444444444'
                          and country_code not like '%:%') = v_scoring_before,
    'O2', 'SKOR DEĞİŞMEDİ (finalize skor yazmaz — kazanan claim''lerden türetilir)');

  -- Tekrar çağrı → idempotent.
  select * into v_new from public.flag_group_finalize_game(
    '44444444-4444-4444-4444-444444444444','c4444444-0000-0000-0000-000000000003',
    '04040404-0000-0000-0000-000000000043');
  perform pg_temp.chk(v_new.status = 'finished', 'O2', 'finished odada tekrar → idempotent no-op', v_new.status);
end$$;

-- ══════════════════════════════════════════════════════════════════════════
-- O3) finalize_game — SON TURDA PAS maçı BİTİRMEZ (pas turu tüketmez)
-- ══════════════════════════════════════════════════════════════════════════
do $$
declare v_room public.flag_group_rooms; v_new public.flag_group_rooms; v_v jsonb; i int;
begin
  insert into public.flag_group_rooms (id, code, status, region, total_rounds, max_players)
  values ('55555555-5555-5555-5555-555555555555', 'FG0005', 'waiting', 'world', 5, 10);  -- total_rounds ∈ (5,10,15,20)
  insert into public.flag_group_players (id, room_id, name, is_host, status, guest_id) values
    ('a5555555-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555','Host5', true,  'waiting','gH5'),
    ('b5555555-0000-0000-0000-000000000002','55555555-5555-5555-5555-555555555555','Mem5',  false, 'waiting','gM5');
  insert into public.flag_group_player_claims (player_id, claim_token) values
    ('a5555555-0000-0000-0000-000000000001','05050505-0000-0000-0000-000000000051'),
    ('b5555555-0000-0000-0000-000000000002','05050505-0000-0000-0000-000000000052');

  select * into v_room from public.flag_group_start_game(
    '55555555-5555-5555-5555-555555555555','a5555555-0000-0000-0000-000000000001',
    '05050505-0000-0000-0000-000000000051', null);

  -- Son tura (5/5) timeout'larla gel.
  for i in 1..10 loop
    select * into v_room from public.flag_group_rooms where id='55555555-5555-5555-5555-555555555555';
    exit when v_room.status <> 'playing' or v_room.current_round >= v_room.total_rounds;
    update public.flag_group_rooms set current_flag_at = now() - interval '13 seconds'
     where id = '55555555-5555-5555-5555-555555555555';
    select * into v_new from public.flag_group_advance_if_due(
      '55555555-5555-5555-5555-555555555555','b5555555-0000-0000-0000-000000000002',
      '05050505-0000-0000-0000-000000000052', v_room.flag_seq);
  end loop;
  select * into v_new from public.flag_group_rooms where id='55555555-5555-5555-5555-555555555555';
  perform pg_temp.chk(v_new.current_round = 5 and v_new.status = 'playing',
    'O3', 'son tura (5/5) gelindi', format('r=%s s=%s', v_new.current_round, v_new.status));

  -- SON turu PASLA (required = floor(2/2)+1 = 2 → iki oyuncu da oy verir).
  v_v := public.flag_group_toggle_pass_vote(
    '55555555-5555-5555-5555-555555555555','a5555555-0000-0000-0000-000000000001',
    '05050505-0000-0000-0000-000000000051', v_new.game_seq, v_new.current_round, v_new.flag_seq);
  v_v := public.flag_group_toggle_pass_vote(
    '55555555-5555-5555-5555-555555555555','b5555555-0000-0000-0000-000000000002',
    '05050505-0000-0000-0000-000000000052', v_new.game_seq, v_new.current_round, v_new.flag_seq);
  perform pg_temp.chk((v_v->>'passed')::boolean, 'O3', 'SON tur (5/5) paslandı', v_v::text);

  -- finalize ÇALIŞMAMALI (pas turu tüketmez → yeni bayrak gelecek).
  update public.flag_group_claims set created_at = now() - interval '5 seconds'
   where room_id = '55555555-5555-5555-5555-555555555555';
  select * into v_new from public.flag_group_finalize_game(
    '55555555-5555-5555-5555-555555555555','b5555555-0000-0000-0000-000000000002',
    '05050505-0000-0000-0000-000000000052');
  perform pg_temp.chk(v_new.status = 'playing',
    'O3', 'SON TUR PAS + finalize → NO-OP (pas maçı bitirmez)', v_new.status);

  -- advance ise aynı tur altında YENİ bayrak getirmeli.
  select * into v_new from public.flag_group_advance_if_due(
    '55555555-5555-5555-5555-555555555555','b5555555-0000-0000-0000-000000000002',
    '05050505-0000-0000-0000-000000000052', v_new.flag_seq);
  perform pg_temp.chk(v_new.status = 'playing' and v_new.current_round = 5,
    'O3', 'pas sonrası AYNI final tur altında yeni bayrak (oyun bitmedi)',
    format('s=%s r=%s f=%s', v_new.status, v_new.current_round, v_new.flag_seq));
end$$;

select ok::text || '|' || grp || '|' || label || '|' || coalesce(got,'') from res order by ord;
`;

/** Bir fonksiyon gövdesini ($$ … $$ arası) çıkarır. */
function fnBody(sql: string, name: string): string {
  const re = new RegExp(
    `create or replace function public\\.${name}\\s*\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "i",
  );
  const m = sql.match(re);
  return m ? m[1] : "";
}

/* ══════════════════════════════════════════════════════════════════════════
   A) STATİK — migration güvenlik sözleşmesi
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\nA) Migration — güvenlik sözleşmesi (tek otomat + iki giriş kapısı)");
{
  const core   = fnBody(mig, "flag_group_advance_core");
  const gate   = fnBody(mig, "flag_group_advance_if_due");
  const legacy = fnBody(mig, "flag_group_advance_flag");
  const fin    = fnBody(mig, "flag_group_finalize_game");
  ok(core.length > 0,   "flag_group_advance_core tanımlı (paylaşılan otomat)");
  ok(gate.length > 0,   "flag_group_advance_if_due tanımlı (yeni istemci kapısı)");
  ok(legacy.length > 0, "flag_group_advance_flag KORUNDU (eski istemci kapısı)");
  ok(fin.length > 0,    "flag_group_finalize_game tanımlı");

  // ── Yeni kapı: yetki + gerçek üyelik, core'a devretmeden ÖNCE ──
  const iAuth   = gate.indexOf("flag_group_authorize_player");
  const iMember = gate.indexOf("player_room_mismatch");
  const iCore   = gate.indexOf("flag_group_advance_core");
  ok(iAuth >= 0 && iMember >= 0 && iCore >= 0, "advance_if_due: authorize + üyelik + core devri var");
  ok(iAuth < iMember && iMember < iCore,
     "SIRA doğru: authorize → üyelik → core", { iAuth, iMember, iCore });
  ok(/where id = p_player_id\s+and room_id = p_room_id/.test(gate),
     "üyelik kontrolü player_id VE room_id birlikte (cross-room kapalı)");
  ok(/public\.flag_group_advance_core\(p_room_id, p_expected_flag_seq, false\)/.test(gate),
     "advance_if_due core'u p_legacy=false ile çağırıyor");

  // ── Legacy kapı: host-only yetki KORUNDU, core'a p_legacy=true ile devrediyor ──
  ok(/flag_group_authorize_host/.test(legacy),
     "legacy advance_flag hâlâ host-only (eski semantik korundu → non-host RED)");
  ok(/public\.flag_group_advance_core\(p_room_id, p_flag_seq, true\)/.test(legacy),
     "legacy advance_flag core'u p_legacy=true ile çağırıyor (TEK state machine)");
  // `\b` ŞART: düz /p_next_flag/ "grou`p_next_flag`" içinde de eşleşir.
  const legacyUses = [...legacy.matchAll(/\bp_next_flag/g)].length;
  ok(legacyUses === 0,
     "legacy gövdesi p_next_flag'i HİÇ OKUMUYOR (bayrak enjeksiyonu kapalı)", legacyUses);
  ok(!/next_flag_invalid|next_flag_unchanged/.test(legacy),
     "yok sayılan parametre için doğrulama RAISE'i YOK (uydurma hata üretilemez)");

  // ── Core: kilit + CAS + sunucu saati ──
  ok(/select \* into v_room from public\.flag_group_rooms where id = p_room_id for update/.test(core),
     "core oda satırını FOR UPDATE ile kilitliyor (submit_claim/pass ile aynı sıra)");
  ok(/p_expected_flag_seq is distinct from v_room\.flag_seq/.test(core),
     "core CAS: bayat flag_seq → no-op (çift ilerletme guard'ı)");
  ok(/and flag_seq = p_expected_flag_seq/.test(core),
     "core UPDATE'leri de flag_seq CAS'ini WHERE'de taşıyor (çifte guard)");
  ok(/v_now\s+timestamptz\s*:=\s*now\(\)/.test(core), "core geçiş anını sunucunun now()'ı ile ölçüyor");
  ok(/flag_group_flag_timeout_seconds\(\)/.test(core) && /flag_group_reveal_delay_ms\(\)/.test(core),
     "core deadline sabitlerini merkezî fonksiyonlardan okuyor");
  ok(/flag_group_next_flag\(p_room_id\)/.test(core),
     "core sıradaki bayrağı SUNUCU dizisinden seçiyor (her iki yol için de)");
  ok(!/\bp_next_flag/.test(core), "core istemciden bayrak parametresi ALMIYOR");

  // ── Legacy geçiş kapısı ESKİ sözleşme: round_active RAISE korunuyor ──
  ok(/if p_legacy then/.test(core) && /raise exception 'round_active'/.test(core),
     "core p_legacy dalında eski `round_active` reddi KORUNUYOR");
  const legacyGate = core.slice(core.indexOf("if p_legacy then"), core.indexOf("else"));
  ok(!/reveal_delay/.test(legacyGate),
     "legacy dalda reveal kapısı YOK (eski istemcinin retry döngüsü olmadığı için yeni hata modu eklenmez)");
  ok(/if v_now < v_due_at then\s*return v_room;/.test(core.replace(/\s+/g, " ")) ||
     /v_now < v_due_at/.test(core),
     "yeni dalda erken çağrı → return (RAISE değil, mutation YOK)");

  // ── Ürün kuralı korunuyor (core'da) ──
  ok(/v_passed\s*:?=\s*\(v_res is not null and v_res like 'pass:%'\)/.test(core),
     "pas sentinel'i tanınıyor (`pass:%`)");
  ok(/v_next_round\s*:?=\s*v_room\.current_round \+ 1/.test(core), "claim/timeout → current_round + 1");
  ok(/v_next_round > v_room\.total_rounds/.test(core), "son turu geçince finalize");

  // ── GERİYE UYUMLULUK: hiçbir RPC revoke/drop EDİLMEMİŞ ──
  ok(!/revoke execute on function public\.flag_group_advance_flag/i.test(migFlat),
     "advance_flag EXECUTE'u REVOKE EDİLMEDİ (eski istemci bozulmaz)");
  ok(!/drop function if exists public\.flag_group_advance_flag/i.test(migFlat),
     "advance_flag DROP EDİLMEDİ");
  ok(/grant\s+execute on function public\.flag_group_advance_flag\(uuid, uuid, uuid, int, text\) to anon, authenticated/i.test(migFlat),
     "advance_flag anon+authenticated'a GRANT (eski istemci çağırabilir)");
  ok(/grant\s+execute on function public\.flag_group_advance_if_due\(uuid, uuid, uuid, int\) to anon, authenticated/i.test(migFlat),
     "advance_if_due anon+authenticated'a GRANT (misafir oynayabilir)");
  ok(/grant\s+execute on function public\.flag_group_finalize_game\(uuid, uuid, uuid\) to anon, authenticated/i.test(migFlat),
     "finalize_game anon+authenticated'a GRANT (eski güvenlik ağı çağrılabilir)");
  ok(/revoke all on function public\.flag_group_advance_core\(uuid, int, boolean\) from public, anon, authenticated/i.test(migFlat),
     "advance_core PRIVATE (istemci doğrudan çağıramaz)");

  // ── finalize_game: erken bitirme (griefing) kapatıldı ──
  ok(/flag_group_authorize_player/.test(fin) && /player_room_mismatch/.test(fin),
     "finalize: authorize + gerçek üyelik (cross-room/yanlış token RED)");
  ok(/for update/.test(fin), "finalize oda satırını kilitliyor");
  ok(/v_now\s+timestamptz\s*:=\s*now\(\)/.test(fin), "finalize SUNUCU saatini kullanıyor");
  ok(/if v_now < v_due_at then\s*return v_room;/.test(fin.replace(/\s+/g, " ")),
     "finalize: deadline dolmadan → NO-OP (raise değil; eski istemci sözleşmesi korunur)");
  ok(/if v_passed then\s*return v_room;/.test(fin.replace(/\s+/g, " ")),
     "finalize: pas turu maçı BİTİRMEZ");
  ok(/v_room\.current_round \+ 1 <= v_room\.total_rounds and v_next is not null/.test(fin),
     "finalize yalnız 'ilerletme zaten finalize edecekti' ise çalışır");
  ok(/if v_room\.status = 'finished' then\s*return v_room;/.test(fin.replace(/\s+/g, " ")),
     "finalize: finished → idempotent no-op (eski davranış)");
  ok(!/winner|score/i.test(fin), "finalize skor/kazanan YAZMIYOR (semantik değişmedi)");
}

console.log("\nA2) PRIVATE tablolar — sıra/katalog istemciye kapalı");
{
  for (const t of ["flag_group_flag_catalog", "flag_group_room_sequences"]) {
    ok(new RegExp(`alter table public\\.${t} enable row level security`, "i").test(mig),
       `${t}: RLS açık`);
    ok(new RegExp(`revoke all on table public\\.${t} from anon, authenticated, public`, "i").test(mig),
       `${t}: anon/authenticated/public'ten revoke all`);
    ok(!new RegExp(`create policy[^;]*on public\\.${t}`, "i").test(mig),
       `${t}: policy YOK → default-deny`);
    ok(!new RegExp(`alter publication supabase_realtime add table public\\.${t}`, "i").test(mig),
       `${t}: realtime publication'a EKLENMEMİŞ`);
  }
  for (const fn of [
    "flag_group_generate_sequence(text, int)",
    "flag_group_ensure_sequence(uuid)",
    "flag_group_next_flag(uuid)",
    "flag_group_progression_tier_weights(numeric)",
  ]) {
    const esc = fn.replace(/[()]/g, "\\$&");
    ok(new RegExp(`revoke all on function public\\.${esc} from public, anon, authenticated`, "i").test(mig),
       `${fn}: public+anon+authenticated'tan revoke (Supabase default-grant tuzağı kapalı)`);
  }
  // start_game hâlâ host-only ve p_first_flag artık OKUNMUYOR.
  const sg = fnBody(mig, "flag_group_start_game");
  ok(/flag_group_authorize_host/.test(sg), "start_game hâlâ host-only (ürün kuralı korunuyor)");
  ok(!/p_first_flag/.test(sg), "start_game p_first_flag'i ARTIK OKUMUYOR (istemci ilk bayrağı seçemez)");
  ok(/flag_group_generate_sequence\(v_room\.region, v_room\.total_rounds\)/.test(sg),
     "start_game sırayı sunucuda üretiyor (span = total_rounds)");
  ok(/v_first\s*:?=\s*v_seq\[1\]/.test(sg), "ilk bayrak = sıranın başı");
}

/* ══════════════════════════════════════════════════════════════════════════
   B) İSTEMCİ SÖZLEŞMESİ
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\nB) İstemci (FlagGroupGame.tsx) — host-only yol KALKTI");
{
  ok(!/flag_group_advance_flag"/.test(clientRaw) && !/rpc\("flag_group_advance_flag/.test(clientRaw),
     "istemci ARTIK flag_group_advance_flag çağırmıyor");
  ok(/rpc\("flag_group_advance_if_due"/.test(clientRaw),
     "istemci flag_group_advance_if_due çağırıyor");
  ok(!/buildHostSequence/.test(clientRaw), "buildHostSequence KALDIRILDI");
  ok(!/flagSeqCodesRef|usedFlagsRef/.test(clientRaw), "istemcide bayrak sırası/used state'i KALMADI");
  ok(!/pickNextFlagCode/.test(clientRaw), "istemci pickNextFlagCode kullanmıyor (bayrak önermiyor)");
  ok(!/buildProgressionQueue|getFlagPool/.test(clientRaw),
     "istemci havuz/progression kurmuyor (import bile YOK)");

  // Watchdog HER istemcide çalışıyor — host koşulu YOK.
  const wd = clientRaw.slice(clientRaw.indexOf("DEADLINE WATCHDOG"));
  ok(wd.length > 0, "deadline watchdog bloğu mevcut");
  ok(!/if \(!isHost(Ref\.current)?\) return;/.test(wd),
     "watchdog'da host-only erken return YOK");
  ok(/ADVANCE_GRACE_HOST_MS/.test(wd) && /ADVANCE_GRACE_OTHER_MS/.test(wd),
     "host/diğer üye stagger'ı var (gereksiz RPC yok, host kaybında devralma var)");
  ok(/window\.setInterval\(check, 500\)/.test(wd), "watchdog 500 ms'de bir yokluyor");
  ok(/visibilitychange/.test(wd) && /addEventListener\("focus"/.test(wd) && /addEventListener\("online"/.test(wd),
     "uyanma tetikleyicileri (visibilitychange + focus + online) bağlı");
  ok(/p_expected_flag_seq/.test(clientRaw), "istemci CAS için flag_seq gönderiyor");

  // start_game artık bayrak göndermiyor.
  ok(/p_first_flag: null/.test(clientRaw), "istemci start_game'e p_first_flag: null gönderiyor");

  // Non-host'un dar finalize güvenlik ağı kalktı (artık advance_if_due yapıyor).
  ok(!/finalize_game \(safety net\)/.test(clientRaw) && !/rpc\("flag_group_finalize_game"/.test(clientRaw),
     "eski dar non-host finalize güvenlik ağı KALDIRILDI");
}

/* ══════════════════════════════════════════════════════════════════════════
   C) DRIFT
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\nC1) Zaman sabitleri — istemci ⇄ SQL");
{
  const cTimeout = clientRaw.match(/const FLAG_TIMEOUT_SEC = (\d+)/);
  const cReveal  = clientRaw.match(/const REVEAL_DELAY_MS\s+= (\d+)/);
  const sTimeout = mig.match(/flag_group_flag_timeout_seconds\(\)\s*returns int language sql immutable as \$\$ select (\d+) \$\$/);
  const sReveal  = mig.match(/flag_group_reveal_delay_ms\(\)\s*returns int language sql immutable as \$\$ select (\d+) \$\$/);
  ok(!!cTimeout && !!sTimeout && cTimeout[1] === sTimeout[1],
     `bayrak süresi aynı (${cTimeout?.[1]} sn)`, { client: cTimeout?.[1], sql: sTimeout?.[1] });
  ok(!!cReveal && !!sReveal && cReveal[1] === sReveal[1],
     `cevap gösterim süresi aynı (${cReveal?.[1]} ms)`, { client: cReveal?.[1], sql: sReveal?.[1] });
}

console.log("\nC2) Tier ağırlık bantları — countries.ts ⇄ SQL");
{
  const sqlFn = fnBody(mig, "flag_group_progression_tier_weights");
  const bands: { p: number; band: string }[] = [
    { p: 0.10, band: "array[10, 3, 0, 0]" },
    { p: 0.50, band: "array[2,  8, 2, 0]" },
    { p: 0.80, band: "array[0,  2, 7, 2]" },
    { p: 0.95, band: "array[0,  0, 2, 8]" },
  ];
  for (const { p, band } of bands) {
    const ts = progressionTierWeights(p);
    const nums = band.match(/-?\d+/g)!.map(Number);
    ok(JSON.stringify(ts) === JSON.stringify(nums),
       `p=${p}: TS [${ts}] == SQL [${nums}]`, { ts, sql: nums });
    ok(sqlFn.includes(band), `SQL'de "${band.replace(/\s+/g, " ")}" bandı mevcut`);
  }
  ok(/< 0\.40/.test(sqlFn) && /< 0\.70/.test(sqlFn) && /< 0\.90/.test(sqlFn),
     "bant eşikleri 0.40 / 0.70 / 0.90 (countries.ts ile aynı)");
}

console.log("\nC3) Katalog satırları — gerçek getFlagPool()/getFameTier() ile BİREBİR");
{
  const expected = buildFlagCatalogRows();
  const block = migRaw.slice(
    migRaw.indexOf("insert into public.flag_group_flag_catalog"),
    migRaw.indexOf("on conflict (region, country_code)"),
  );
  const actual = [...block.matchAll(/\('([a-z_]+),?\s*'?,?\s*'([a-z]{2})',\s*(\d)\)/g)]
    .map(m => ({ region: m[1].replace(/'$/, ""), code: m[2], tier: Number(m[3]) }));
  // Yukarıdaki regex bölge tırnağını yakalarken esnek; kesin ayrıştırma:
  const parsed = [...block.matchAll(/\('([a-z_]+)',\s*'([a-z]{2})',\s*(\d)\)/g)]
    .map(m => ({ region: m[1], code: m[2], tier: Number(m[3]) }));
  ok(parsed.length === expected.length,
     `katalog satır sayısı eşleşiyor (${expected.length})`, { migration: parsed.length, generated: expected.length });
  void actual;

  const key = (r: { region: string; code: string; tier: number }) => `${r.region}|${r.code}|${r.tier}`;
  const inMig = new Set(parsed.map(key));
  const missing = expected.filter(e => !inMig.has(key(e)));
  const inGen = new Set(expected.map(key));
  const extra = parsed.filter(a => !inGen.has(key(a)));
  ok(missing.length === 0, "countries.ts'teki her (bölge, bayrak, tier) migration'da VAR",
     missing.slice(0, 5));
  ok(extra.length === 0, "migration'da countries.ts'te OLMAYAN satır YOK", extra.slice(0, 5));

  // Bayrak havuzu Çark'tan FARKLI: mikro-devletler DAHİL olmalı.
  ok(parsed.some(r => r.region === "world" && r.code === "mc"),
     "mikro-devletler Bayrak kataloğunda VAR (Çark'taki isWheelEligible filtresi UYGULANMAZ)");
  ok(parsed.filter(r => r.region === "world").length === getFlagPool("world", "all").filter(c => !!c.code).length,
     "world havuzu boyu getFlagPool('world','all') ile aynı");
}

/* ══════════════════════════════════════════════════════════════════════════
   C4) Clean-room zinciri ⇄ canonical repo — fonksiyon kümesi DELTASI
   ──────────────────────────────────────────────────────────────────────────
   NEDEN VAR: precheck bir ara canlıdaki `flag_group_*` fonksiyon SAYISINI
   clean-room'unkiyle karşılaştırıyordu (canlı 18, clean-room 17) ve bu fark
   "production drift" sanıldı. DEĞİLDİ: aradaki tek fonksiyon
   `flag_group_send_message` ve clean-room zinciri onu KASTEN uygulamıyor —
   çünkü onu doğuran 20260729120000 `duel_messages` tablosuna, canlıdaki GÜNCEL
   gövdesini yazan 20260804120000 ise DOKUZ modun tablosuna bağlı. Bu
   flag_group-kapsamlı clean-room'a tüm çok-oyunculu şemayı sürüklemek
   gerekirdi; üstelik YALNIZ 20260729120000'i eklemek sayıyı 18'e getirip
   gövdeyi canlıdan FARKLI bırakırdı (sayı tutar, içerik yalan söyler).
   Bu yüzden zincir dar TUTULUR ve fark burada KİLİTLENİR: delta tam olarak
   {flag_group_send_message} olmalı. Başka bir fonksiyon zincirin dışında
   kalırsa (ör. yeni bir flag_group migration'ı eklenip zincire konmazsa) bu
   test düşer ve mutlak sayı karşılaştırması bir daha kimseyi yanıltmaz.
   ══════════════════════════════════════════════════════════════════════════ */
console.log("\nC4) Clean-room zinciri ⇄ canonical repo — fonksiyon kümesi deltası");
{
  const MIG_DIR = join(ROOT, "supabase/migrations");
  const allMigs = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();

  /** Bir SQL metninin OLUŞTURDUĞU public.flag_group_* fonksiyon adları. */
  const createdIn = (sql: string): Set<string> => new Set(
    [...stripSqlComments(sql).matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(flag_group_[a-z0-9_]+)\s*\(/gi,
    )].map(m => m[1].toLowerCase()),
  );

  // Kalıcı DROP var mı? (aynı dosyada yeniden yaratılmayan bir drop, adı
  // gerçekten öldürür ve aşağıdaki ad-kümesi mantığını geçersiz kılar.)
  const permanentlyDropped: string[] = [];
  for (const f of allMigs) {
    const sql = stripSqlComments(readFileSync(join(MIG_DIR, f), "utf8"));
    const recreated = createdIn(sql);
    for (const m of sql.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?(flag_group_[a-z0-9_]+)/gi)) {
      const name = m[1].toLowerCase();
      if (!recreated.has(name)) permanentlyDropped.push(`${f}:${name}`);
    }
  }
  ok(permanentlyDropped.length === 0,
     "hiçbir flag_group fonksiyonu kalıcı DROP edilmiyor (ad-kümesi mantığı geçerli)",
     permanentlyDropped);

  // Zincirin uyguladığı migration'lar — D) bölümündeki `chain` ile AYNI olmalı.
  const CHAIN_MIGS = [
    "20260728120000_flag_group_init.sql",
    "20260730120000_flag_group_pass_votes.sql",
    "20260731120000_flag_group_flag_sequence.sql",
    "20260814170000_flag_group_advance_if_due.sql",
  ];
  for (const f of CHAIN_MIGS) {
    ok(allMigs.includes(f), `zincir migration'ı repoda var: ${f}`);
  }

  const union = (files: string[]) => {
    const s = new Set<string>();
    for (const f of files) for (const n of createdIn(readFileSync(join(MIG_DIR, f), "utf8"))) s.add(n);
    return s;
  };

  const canonicalAll = union(allMigs);                 // repo'nun TAMAMI
  const chainAll     = union(CHAIN_MIGS);              // clean-room'un gördüğü
  const delta        = [...canonicalAll].filter(n => !chainAll.has(n)).sort();

  ok(delta.length === 1 && delta[0] === "flag_group_send_message",
     "canonical repo ⇄ clean-room zinciri farkı TAM OLARAK {flag_group_send_message}",
     delta);

  // Zincirde OLUP repoda olmayan bir şey olamaz (zincir repo'nun alt kümesi).
  ok([...chainAll].every(n => canonicalAll.has(n)),
     "zincir canonical repo'nun ALT KÜMESİ");

  // Precheck yorumlarındaki sayılar bu kümelerden TÜRETİLİR, elle yazılmaz.
  const beforeChain = union(CHAIN_MIGS.filter(f => f !== "20260814170000_flag_group_advance_if_due.sql"));
  const beforeCanonical = union(allMigs.filter(f => f !== "20260814170000_flag_group_advance_if_due.sql"));
  const addedByMig = [...createdIn(migRaw)].filter(n => !beforeCanonical.has(n)).sort();

  ok(beforeChain.size === 17, "clean-room migration ÖNCESİ 17 fonksiyon", beforeChain.size);
  ok(chainAll.size === 25,    "clean-room migration SONRASI 25 fonksiyon", chainAll.size);
  ok(beforeCanonical.size === 18,
     "canonical repo (= canlı) migration ÖNCESİ 18 fonksiyon — canlı 18 DRIFT DEĞİL",
     beforeCanonical.size);
  ok(canonicalAll.size === 26,
     "canonical repo migration SONRASI 26 fonksiyon", canonicalAll.size);
  ok(addedByMig.length === 8,
     "20260814170000 tam olarak 8 YENİ fonksiyon ekliyor", addedByMig);

  // Eklenen 8 adın hiçbiri migration ÖNCESİ canonical kümede olmamalı → çakışma yok.
  const collisions = addedByMig.filter(n => beforeCanonical.has(n));
  ok(collisions.length === 0, "yeni 8 fonksiyon adı mevcutlarla ÇAKIŞMIYOR", collisions);

  // REPLACE edilen 3 RPC gerçekten ÖNCEDEN de vardı (yani yeni değil, shim).
  for (const n of ["flag_group_advance_flag", "flag_group_start_game", "flag_group_finalize_game"]) {
    ok(beforeCanonical.has(n) && createdIn(migRaw).has(n),
       `${n} migration ÖNCESİ vardı ve REPLACE ediliyor (yeni ad değil)`);
  }

  // 170000 send_message'a DOKUNMUYOR (kapsam kanıtı).
  ok(!createdIn(migRaw).has("flag_group_send_message"),
     "20260814170000 flag_group_send_message'i OLUŞTURMUYOR/REPLACE ETMİYOR");
  ok(!/flag_group_messages|duel_messages/i.test(stripSqlComments(migRaw)),
     "20260814170000 mesaj tablolarına HİÇ dokunmuyor");
}

/* ══════════════════════════════════════════════════════════════════════════
   D + E) RUNTIME clean-room
   ══════════════════════════════════════════════════════════════════════════ */
const DB = "fg_advance_check";

function findContainer(): string | null {
  const explicit = process.env.FLAG_GROUP_PG_CONTAINER;
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
  // -q ŞART: quiet olmadan psql komut etiketlerini de stdout'a basar.
  const args = ["exec", "-i", container, "psql", "-U", "postgres", "-d", db,
                "-q", "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-A", "-t");
  args.push("-f", "-");
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

const container = findContainer();

if (!container) {
  console.log("\nD) Runtime clean-room");
  console.log("  ✗ ZORUNLU runtime katmanı KOŞULAMADI — postgres container'ı bulunamadı.");
  console.log("    Bu test host-SPOF + geriye uyumluluk + griefing garantilerini");
  console.log("    yalnız GERÇEK Postgres'te kanıtlayabilir; statik katman TEK BAŞINA yeterli DEĞİL.");
  console.log("    (FLAG_GROUP_PG_CONTAINER=<ad> ile elle gösterilebilir.)");
  failed++;
} else {
  const chain = [
    BOOTSTRAP,
    readFileSync(join(ROOT, "supabase/migrations/20260728120000_flag_group_init.sql"), "utf8"),
    readFileSync(join(ROOT, "supabase/migrations/20260730120000_flag_group_pass_votes.sql"), "utf8"),
    readFileSync(join(ROOT, SEQ_BASE), "utf8"),
    migRaw,
    FIXTURES,
  ];

  console.log(`\nD) Runtime clean-room (docker: ${container})`);
  psql(container, "postgres", `drop database if exists ${DB};\ncreate database ${DB};\n`);
  for (const step of chain) psql(container, DB, step);

  const raw = psql(container, DB, SUITE, true);
  let localFail = 0;
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    const [okStr, grp, label, got] = line.split("|");
    const good = okStr === "true";
    if (!good) localFail++;
    ok(good, `[${grp}] ${label}`, good ? undefined : got || "(değer yok)");
  }
  console.log(`  · ${raw.trim().split("\n").length} davranış assert'i, ${localFail} fail`);

  /* ── E) Dağılım paritesi: SQL üretimi ⇄ TS buildProgressionQueue ── */
  console.log("\nE) Dağılım paritesi — SQL generate_sequence ⇄ TS buildProgressionQueue");
  const SAMPLES = 200;
  const SPAN = 10;
  // DİKKAT: örnekleme MUTLAKA PL/pgSQL döngüsüyle yapılmalı.
  // `generate_series(1,N) cross join lateral unnest(f(...))` yazımı f'i dış
  // satıra BAĞLAMADIĞI için planlayıcı diziyi BİR KEZ üretip N kez yeniden
  // kullanır → N "örnek" aslında AYNI dizidir ve dağılım ölçümü anlamsız çıkar
  // (bu tuzağa bir kez düşüldü: poz 1-2 ortalaması 1.00 görünüyordu).
  const sqlOut = psql(container, DB, `
    create temp table _samp(iter int, ord int, code text);
    do $$
    declare i int; s text[];
    begin
      for i in 1..${SAMPLES} loop
        s := public.flag_group_generate_sequence('world', ${SPAN});
        insert into _samp select i, ord, code
          from unnest(s) with ordinality as t(code, ord);
      end loop;
    end$$;
    select string_agg(code, ',' order by ord) from _samp group by iter;
  `, true).trim().split("\n").filter(Boolean).map(l => l.split(","));

  const pool = getFlagPool("world", "all");
  const tierOf = new Map(pool.map(e => [e.code, getFameTier(e)]));
  const tsOut: string[][] = [];
  for (let i = 0; i < SAMPLES; i++) tsOut.push(buildProgressionQueue([...pool], SPAN).map(e => e.code));

  ok(sqlOut.length === SAMPLES, `SQL ${SAMPLES} sıra üretti`, sqlOut.length);
  ok(sqlOut.every(s => s.length === pool.length),
     "her SQL sırası TÜM havuzu kapsıyor (TS ile aynı uzunluk)",
     sqlOut[0]?.length);
  ok(sqlOut.every(s => new Set(s).size === s.length), "SQL sıralarında tekrar YOK");

  const meanAt = (seqs: string[][], from: number, to: number) => {
    let sum = 0, n = 0;
    for (const s of seqs) for (let i = from; i < to && i < s.length; i++) { sum += tierOf.get(s[i]) ?? 0; n++; }
    return n ? sum / n : 0;
  };
  const windows: [number, number][] = [[0, 2], [2, 5], [5, 10], [10, 30], [30, 100]];
  for (const [a, b] of windows) {
    const sq = meanAt(sqlOut, a, b);
    const ts = meanAt(tsOut, a, b);
    ok(Math.abs(sq - ts) < 0.15,
       `poz ${a + 1}-${b}: ortalama fame_tier SQL ${sq.toFixed(2)} ≈ TS ${ts.toFixed(2)} (|Δ| < 0.15)`,
       { sql: +sq.toFixed(3), ts: +ts.toFixed(3) });
  }
  // Rampa gerçekten yükseliyor mu (span içinde kolay → zor)?
  ok(meanAt(sqlOut, 0, 2) < meanAt(sqlOut, 5, 10),
     "SQL rampası yükseliyor: poz 1-2 < poz 6-10",
     { head: +meanAt(sqlOut, 0, 2).toFixed(2), late: +meanAt(sqlOut, 5, 10).toFixed(2) });

  psql(container, "postgres", `drop database if exists ${DB};\n`);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
