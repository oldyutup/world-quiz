-- ============================================================================
-- Hesap Silme — davranış + atomiklik testi
-- ============================================================================
-- NEREDE KOŞULUR: YALNIZ lokal Supabase (supabase db reset sonrası) veya
-- staging kopyası. CANLIDA KOŞMA. Script tek transaction'dır ve SONUNDA
-- ROLLBACK eder → hiçbir kalıcı iz bırakmaz; ara adımlardaki kasıtlı hata
-- senaryosu da kendi savepoint'inde izoledir.
--
-- ÖN KOŞUL: 20260804120000_duel_messages_sender_profile.sql ve
-- 20260805120000_account_deletion_trigger.sql uygulanmış olmalı.
--
-- KOŞMA:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f supabase/tests/account_deletion_test.sql
--   Başarı = script sonuna kadar hatasız iner ve "TÜM TESTLER GEÇTİ" notice
--   basar. Her assert başarısızlığı 'ASSERT FAIL: …' exception'ı atar.
--
-- NOT: auth.users fixture insert'i GoTrue şema sürümüne göre ufak kolon
-- ayarı gerektirebilir; duel_players gibi migration-öncesi (Studio dönemi)
-- tablolarda ise burada kullanılmayan ek NOT NULL kolon çıkarsa fixture'a
-- eklenmelidir. Test mantığı değişmez.
-- ============================================================================

begin;

-- ────────────────────────────────────────────────────────────────────────────
-- 0) Fixture — sabit test kimlikleri
--    uid  = 00000000-0000-4000-8000-00000000d001  (silinecek kullanıcı)
--    uid2 = 00000000-0000-4000-8000-00000000d002  (kontrol kullanıcısı)
-- ────────────────────────────────────────────────────────────────────────────

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-4000-8000-00000000d001',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'delete-me@test.local', 'x', now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000d002',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   'keep-me@test.local', 'x', now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb)
on conflict (id) do nothing;

-- handle_new_user benzeri bir trigger profiles satırını otomatik açmış
-- olabilir → upsert.
insert into public.profiles (id, username)
values
  ('00000000-0000-4000-8000-00000000d001', 'testsilinecek'),
  ('00000000-0000-4000-8000-00000000d002', 'testkalacak')
on conflict (id) do update set username = excluded.username;

-- ── Ülke Yazmaca 1v1 (duel_*) ──
insert into public.duel_rooms (code, status, duration_seconds, region, room_source)
values ('ZZTEST1', 'finished', 60, 'world', 'manual'),
       ('ZZTEST2', 'finished', 60, 'world', 'manual');

insert into public.duel_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000a001', r.id, 'testsilinecek',
       '00000000-0000-4000-8000-00000000d001'
  from public.duel_rooms r where r.code = 'ZZTEST1';

-- Aynı görünen ada sahip MİSAFİR, BAŞKA odada (guard-öncesi tarihsel durum):
-- silme bu satıra ve mesajına DOKUNMAMALI.
insert into public.duel_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000a005', r.id, 'testsilinecek', null
  from public.duel_rooms r where r.code = 'ZZTEST2';

insert into public.duel_player_claims (player_id, claim_token)
values ('00000000-0000-4000-8000-00000000a001', gen_random_uuid());

-- ── Tevatür / Kör Nokta (login-only; '#takım' kanalı dahil) ──
insert into public.tevatur_rooms (code, status)
values ('ZZTEST3', 'finished');

insert into public.tevatur_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000a002', r.id, 'testsilinecek',
       '00000000-0000-4000-8000-00000000d001'
  from public.tevatur_rooms r where r.code = 'ZZTEST3';

insert into public.tevatur_player_claims (player_id, claim_token)
values ('00000000-0000-4000-8000-00000000a002', gen_random_uuid());

-- ── Bayrak Bilmece grup (namespaced chat anahtarı) ──
insert into public.flag_group_rooms (code, status)
values ('ZZTEST4', 'finished');

insert into public.flag_group_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000a003', r.id, 'testsilinecek',
       '00000000-0000-4000-8000-00000000d001'
  from public.flag_group_rooms r where r.code = 'ZZTEST4';

insert into public.flag_group_player_claims (player_id, claim_token)
values ('00000000-0000-4000-8000-00000000a003', gen_random_uuid());

-- ── Kuşatma (host_name + host_profile_id anonimleştirmesi) ──
insert into public.conquest_rooms (room_code, host_profile_id, host_name, status, map_id)
values ('ZZTEST5', '00000000-0000-4000-8000-00000000d001', 'testsilinecek',
        'finished', 'turkey');

insert into public.conquest_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000a004', r.id, 'testsilinecek',
       '00000000-0000-4000-8000-00000000d001'
  from public.conquest_rooms r where r.room_code = 'ZZTEST5';

insert into public.conquest_player_claims (player_id, claim_token)
values ('00000000-0000-4000-8000-00000000a004', gen_random_uuid());

-- ── Matchmaking kuyrukları ──
insert into public.route_duel_queue
  (profile_id, player_id, player_name, claim_token, total_rounds, route_length)
values ('00000000-0000-4000-8000-00000000d001', gen_random_uuid(),
        'testsilinecek', gen_random_uuid(), 5, '5');

insert into public.country_duel_queue
  (profile_id, player_id, player_name, duration_seconds, region)
values ('00000000-0000-4000-8000-00000000d001', gen_random_uuid(),
        'testsilinecek', 60, 'world');

insert into public.flag_duel_queue
  (profile_id, player_id, player_name, total_rounds, region)
values ('00000000-0000-4000-8000-00000000d001', gen_random_uuid(),
        'testsilinecek', 5, 'world');

insert into public.conquest_quick_match_queue
  (profile_id, player_id, player_name, round_count, map_id)
values ('00000000-0000-4000-8000-00000000d001', gen_random_uuid(),
        'testsilinecek', 6, 'turkey');

-- wheel_duel_queue migration-öncesi (Studio) tablo: kolonları burada
-- varsaymıyoruz, trigger'daki defansif DELETE zaten profile_id üzerinden.

-- ── duel_messages fixture'ları ──
insert into public.duel_messages (room_code, player_name, message) values
  ('ZZTEST1',            'testsilinecek', 'benim mesajim'),          -- oda-kapsamlı eşleşme
  ('ZZTEST2',            'testsilinecek', 'misafir mesaji'),         -- DOKUNULMAMALI
  ('ZZTEST3',            'testsilinecek', 'kor nokta genel'),        -- tevatur baz kanal
  ('ZZTEST3#blue',       'testsilinecek', 'kor nokta takim'),        -- tevatur takım kanalı
  ('flag_group:ZZTEST4', 'testsilinecek', 'bayrak grup'),            -- namespaced
  ('ZZTEST5',            'testsilinecek', 'kusatma'),                -- conquest room_code
  ('ZZGONE9',            'testsilinecek', 'yetim eski mesaj');       -- oda yok → DOKUNULMAMALI

-- Yeni nesil mesaj: sender_profile_id dolu, odası çoktan silinmiş olsa bile
-- kesin eşleşmeyle anonimleşmeli.
insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
values ('ZZGONE8', 'testsilinecek', 'yetim ama kimlikli',
        '00000000-0000-4000-8000-00000000d001');


-- ────────────────────────────────────────────────────────────────────────────
-- 1) ATOMİKLİK: trigger içinde kasıtlı hata → HİÇBİR ŞEY değişmemeli
-- ────────────────────────────────────────────────────────────────────────────
-- Temizlik zincirinin 4. adımını (player anonimleştirme) patlatan geçici
-- trigger kur; o ana kadar kuyruk/claim/mesaj adımları çalışmış olacak ama
-- exception TÜM DELETE'i (auth.users dahil) geri almalı.

create or replace function public._test_account_del_fail()
returns trigger language plpgsql as
$$ begin raise exception 'forced_test_failure'; end $$;

create trigger trg_test_account_del_fail
  before update on public.duel_players
  for each row execute function public._test_account_del_fail();

do $$
declare v_failed boolean := false;
begin
  begin
    delete from auth.users
     where id = '00000000-0000-4000-8000-00000000d001';
  exception when others then
    v_failed := true;
    if position('forced_test_failure' in sqlerrm) = 0 then
      raise exception 'ASSERT FAIL: beklenmeyen hata: %', sqlerrm;
    end if;
  end;
  if not v_failed then
    raise exception 'ASSERT FAIL: trigger hatası silmeyi durdurmalıydı';
  end if;
end $$;

-- Kısmi değişiklik KALMAMALI:
do $$
begin
  if not exists (select 1 from auth.users
                  where id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'ASSERT FAIL: rollback sonrası auth.users satırı yok';
  end if;
  if not exists (select 1 from public.profiles
                  where id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'ASSERT FAIL: rollback sonrası profiles satırı yok';
  end if;
  if not exists (select 1 from public.route_duel_queue
                  where profile_id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'ASSERT FAIL: rollback sonrası kuyruk satırı silinmiş (kısmi silme!)';
  end if;
  if not exists (select 1 from public.duel_player_claims
                  where player_id = '00000000-0000-4000-8000-00000000a001') then
    raise exception 'ASSERT FAIL: rollback sonrası claim silinmiş (kısmi silme!)';
  end if;
  if not exists (select 1 from public.duel_messages
                  where room_code = 'ZZTEST1' and player_name = 'testsilinecek') then
    raise exception 'ASSERT FAIL: rollback sonrası mesaj anonimleşmiş (kısmi silme!)';
  end if;
  -- Player satırı: name VE profile_id birebir dokunulmamış olmalı (açık
  -- atomiklik kanıtı — dolaylı kapsamaya güvenilmez).
  if not exists (select 1 from public.duel_players
                  where id = '00000000-0000-4000-8000-00000000a001'
                    and name = 'testsilinecek'
                    and profile_id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'ASSERT FAIL: rollback sonrası player name/profile_id değişmiş (kısmi silme!)';
  end if;
  if not exists (select 1 from public.tevatur_players
                  where id = '00000000-0000-4000-8000-00000000a002'
                    and name = 'testsilinecek'
                    and profile_id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'ASSERT FAIL: rollback sonrası tevatur player name/profile_id değişmiş (kısmi silme!)';
  end if;
  raise notice 'ATOMIKLIK TESTI GECTI: hata tum silmeyi geri aldi';
end $$;

drop trigger trg_test_account_del_fail on public.duel_players;
drop function public._test_account_del_fail();


-- ────────────────────────────────────────────────────────────────────────────
-- 2) BAŞARI SENARYOSU: gerçek silme + tüm kapsam assert'leri
-- ────────────────────────────────────────────────────────────────────────────

delete from auth.users where id = '00000000-0000-4000-8000-00000000d001';

do $$
declare
  v_anon_duel     text := 'Silinmiş#' || substr(md5('00000000-0000-4000-8000-00000000a001'), 1, 7);
  v_anon_tevatur  text := 'Silinmiş#' || substr(md5('00000000-0000-4000-8000-00000000a002'), 1, 7);
  v_anon_flaggrp  text := 'Silinmiş#' || substr(md5('00000000-0000-4000-8000-00000000a003'), 1, 7);
  v_anon_conquest text := 'Silinmiş#' || substr(md5('00000000-0000-4000-8000-00000000a004'), 1, 7);
begin
  -- auth + profiles cascade
  if exists (select 1 from auth.users where id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'ASSERT FAIL: auth.users silinmedi';
  end if;
  if exists (select 1 from public.profiles where id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'ASSERT FAIL: profiles cascade silinmedi';
  end if;

  -- Kuyruklar boşalmalı
  if exists (select 1 from public.route_duel_queue
              where profile_id = '00000000-0000-4000-8000-00000000d001')
  or exists (select 1 from public.country_duel_queue
              where profile_id = '00000000-0000-4000-8000-00000000d001')
  or exists (select 1 from public.flag_duel_queue
              where profile_id = '00000000-0000-4000-8000-00000000d001')
  or exists (select 1 from public.conquest_quick_match_queue
              where profile_id = '00000000-0000-4000-8000-00000000d001') then
    raise exception 'ASSERT FAIL: kuyruk satırları silinmedi';
  end if;

  -- Claim token'ları silinmeli
  if exists (select 1 from public.duel_player_claims
              where player_id = '00000000-0000-4000-8000-00000000a001')
  or exists (select 1 from public.tevatur_player_claims
              where player_id = '00000000-0000-4000-8000-00000000a002')
  or exists (select 1 from public.flag_group_player_claims
              where player_id = '00000000-0000-4000-8000-00000000a003')
  or exists (select 1 from public.conquest_player_claims
              where player_id = '00000000-0000-4000-8000-00000000a004') then
    raise exception 'ASSERT FAIL: claim token satırları silinmedi';
  end if;

  -- Player satırları: KALMALI ama anonim (isim + NULL profile_id)
  if not exists (select 1 from public.duel_players
                  where id = '00000000-0000-4000-8000-00000000a001'
                    and name = v_anon_duel and profile_id is null) then
    raise exception 'ASSERT FAIL: duel_players anonimleşmedi';
  end if;
  if not exists (select 1 from public.tevatur_players
                  where id = '00000000-0000-4000-8000-00000000a002'
                    and name = v_anon_tevatur and profile_id is null) then
    raise exception 'ASSERT FAIL: tevatur_players anonimleşmedi (nullable?)';
  end if;
  if not exists (select 1 from public.flag_group_players
                  where id = '00000000-0000-4000-8000-00000000a003'
                    and name = v_anon_flaggrp and profile_id is null) then
    raise exception 'ASSERT FAIL: flag_group_players anonimleşmedi';
  end if;
  if not exists (select 1 from public.conquest_players
                  where id = '00000000-0000-4000-8000-00000000a004'
                    and name = v_anon_conquest and profile_id is null) then
    raise exception 'ASSERT FAIL: conquest_players anonimleşmedi';
  end if;

  -- conquest_rooms host anonim (hash host_player_id NULL → oda id fallback;
  -- bu fixture'da host_player_id NULL bırakıldı → isim 'Silinmiş#%' kalıbında
  -- olmalı ve host_profile_id NULL'lanmalı)
  if not exists (select 1 from public.conquest_rooms
                  where room_code = 'ZZTEST5'
                    and host_profile_id is null
                    and host_name like 'Silinmiş#%') then
    raise exception 'ASSERT FAIL: conquest_rooms host anonimleşmedi';
  end if;

  -- Mesajlar: kullanıcının mesajları anonim, player satırıyla AYNI adla
  if not exists (select 1 from public.duel_messages
                  where room_code = 'ZZTEST1' and message = 'benim mesajim'
                    and player_name = v_anon_duel) then
    raise exception 'ASSERT FAIL: duel mesajı anonimleşmedi';
  end if;
  if not exists (select 1 from public.duel_messages
                  where room_code = 'ZZTEST3' and message = 'kor nokta genel'
                    and player_name = v_anon_tevatur) then
    raise exception 'ASSERT FAIL: tevatur baz kanal mesajı anonimleşmedi';
  end if;
  if not exists (select 1 from public.duel_messages
                  where room_code = 'ZZTEST3#blue' and message = 'kor nokta takim'
                    and player_name = v_anon_tevatur) then
    raise exception 'ASSERT FAIL: tevatur takım kanalı mesajı anonimleşmedi';
  end if;
  if not exists (select 1 from public.duel_messages
                  where room_code = 'flag_group:ZZTEST4' and message = 'bayrak grup'
                    and player_name = v_anon_flaggrp) then
    raise exception 'ASSERT FAIL: flag_group namespaced mesaj anonimleşmedi';
  end if;
  if not exists (select 1 from public.duel_messages
                  where room_code = 'ZZTEST5' and message = 'kusatma'
                    and player_name = v_anon_conquest) then
    raise exception 'ASSERT FAIL: conquest mesajı anonimleşmedi';
  end if;

  -- sender_profile_id kesin eşleşmesi: yetim olsa bile anonim + NULL
  if not exists (select 1 from public.duel_messages
                  where room_code = 'ZZGONE8' and message = 'yetim ama kimlikli'
                    and player_name like 'Silinmiş#%'
                    and sender_profile_id is null) then
    raise exception 'ASSERT FAIL: sender_profile_id mesajı anonimleşmedi';
  end if;

  -- DOKUNULMAMASI gerekenler:
  if not exists (select 1 from public.duel_messages
                  where room_code = 'ZZTEST2' and message = 'misafir mesaji'
                    and player_name = 'testsilinecek') then
    raise exception 'ASSERT FAIL: aynı adlı misafirin mesajına dokunuldu!';
  end if;
  if not exists (select 1 from public.duel_players
                  where id = '00000000-0000-4000-8000-00000000a005'
                    and name = 'testsilinecek') then
    raise exception 'ASSERT FAIL: aynı adlı misafirin player satırına dokunuldu!';
  end if;
  if not exists (select 1 from public.duel_messages
                  where room_code = 'ZZGONE9' and message = 'yetim eski mesaj'
                    and player_name = 'testsilinecek') then
    raise exception 'ASSERT FAIL: kimliksiz yetim mesaja dokunuldu (global süpürme yasak)!';
  end if;
  if not exists (select 1 from public.profiles
                  where id = '00000000-0000-4000-8000-00000000d002'
                    and username = 'testkalacak') then
    raise exception 'ASSERT FAIL: kontrol kullanıcısının profiline dokunuldu!';
  end if;

  raise notice 'TÜM TESTLER GEÇTİ';
end $$;

-- Her koşulda iz bırakma:
rollback;
