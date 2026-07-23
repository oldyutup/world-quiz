-- ============================================================================
-- UGC Güvenlik — Raporlama + Moderasyon + Filtre ZORLAMASI entegrasyon testi
-- ============================================================================
-- NEREDE KOŞULUR: YALNIZ tam şemalı lokal/staging Supabase kopyası (proje
-- tablolarının + migration 20260806120000'in UYGULANMIŞ olduğu). CANLIDA KOŞMA.
-- Script tek transaction'dır ve SONUNDA ROLLBACK eder → kalıcı iz bırakmaz.
--
-- KOŞMA:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/ugc_moderation_test.sql
--   Başarı = "TÜM UGC TESTLERİ GEÇTİ" notice. Her sapma 'ASSERT FAIL: …' exception.
--
-- auth.uid() simülasyonu: request.jwt.claims GUC'u set edilir (Supabase auth.uid()
-- bunu okur). GoTrue/şema sürümüne göre auth.users fixture kolonları ufak ayar
-- gerektirebilir (bkz. account_deletion_test.sql notu). Test MANTIĞI değişmez.
--
-- NOT: Saf içerik filtresi (tablo bağımsız) ayrıca supabase/tests/ugc_filter_test.sql
-- ile şemasız da doğrulanır (o dosya bu oturumda PG16'da koşuldu ve GEÇTİ).
-- ============================================================================

begin;

-- ── Sabit kimlikler ──
--   d001 = reporterOne (bildiren, authenticated)
--   d002 = targetTwo   (bildirilen)
-- ────────────────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','ugc-reporter@test.local','x',now(),now(),now(),
   '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb),
  ('00000000-0000-4000-8000-00000000a002','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','ugc-target@test.local','x',now(),now(),now(),
   '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb)
on conflict (id) do nothing;

insert into public.profiles (id, username) values
  ('00000000-0000-4000-8000-00000000a001','reporterone'),
  ('00000000-0000-4000-8000-00000000a002','targettwo')
on conflict (id) do update set username = excluded.username;

-- ── Oda + oyuncular (duel_*) ──
insert into public.duel_rooms (code, status, duration_seconds, region, room_source)
values ('ZZUGC1','finished',60,'world','manual'),
       ('ZZUGC2','finished',60,'world','manual');

-- reporterOne ZZUGC1'de (authenticated katılım); targetTwo ZZUGC1'de; guest G ZZUGC1'de.
insert into public.duel_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000b001', r.id, 'reporterone',
       '00000000-0000-4000-8000-00000000a001' from public.duel_rooms r where r.code='ZZUGC1';
insert into public.duel_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000b002', r.id, 'targettwo',
       '00000000-0000-4000-8000-00000000a002' from public.duel_rooms r where r.code='ZZUGC1';
insert into public.duel_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000b003', r.id, 'guestthree', null
  from public.duel_rooms r where r.code='ZZUGC1';

insert into public.duel_player_claims (player_id, claim_token)
values ('00000000-0000-4000-8000-00000000b003',
        '00000000-0000-4000-8000-00000000c111');

-- targetTwo'nun ZZUGC1'deki (temiz) mesajı — sabit id ile.
insert into public.duel_messages (id, room_code, player_name, message, sender_profile_id)
values ('00000000-0000-4000-8000-00000000c001','ZZUGC1','targettwo','merhaba dunya',
        '00000000-0000-4000-8000-00000000a002');


-- ════════════════════════════════════════════════════════════════════════════
-- A) İÇERİK FİLTRESİ ZORLAMASI (trigger'lar)
-- ════════════════════════════════════════════════════════════════════════════

-- A1) profiles.username trigger: uygunsuz ad REDDEDİLİR.
do $$ begin
  begin
    update public.profiles set username='orospucocugu'
     where id='00000000-0000-4000-8000-00000000a002';
    raise exception 'ASSERT FAIL: uygunsuz username kabul edildi';
  exception when others then
    if position('UGC_USERNAME_NOT_ALLOWED' in sqlerrm)=0 then raise; end if;
  end;
end $$;

-- A2) profiles.username trigger: temiz ad KABUL edilir.
update public.profiles set username='temizhedef'
 where id='00000000-0000-4000-8000-00000000a002';
do $$ begin
  if not exists (select 1 from public.profiles
                 where id='00000000-0000-4000-8000-00000000a002' and username='temizhedef')
  then raise exception 'ASSERT FAIL: temiz username yazılamadı'; end if;
end $$;
-- geri al (sonraki snapshot testleri için ad tutarlı kalsın)
update public.profiles set username='targettwo'
 where id='00000000-0000-4000-8000-00000000a002';

-- A3) duel_messages trigger: uygunsuz mesaj INSERT'i REDDEDİLİR.
do $$ begin
  begin
    insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
    values ('ZZUGC1','targettwo','siktir git buradan','00000000-0000-4000-8000-00000000a002');
    raise exception 'ASSERT FAIL: uygunsuz mesaj kabul edildi';
  exception when others then
    if position('UGC_MESSAGE_NOT_ALLOWED' in sqlerrm)=0 then raise; end if;
  end;
end $$;

-- A4) duel_messages trigger: banned gönderen REDDEDİLİR.
update public.profiles set moderation_status='banned'
 where id='00000000-0000-4000-8000-00000000a002';
do $$ begin
  begin
    insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
    values ('ZZUGC1','targettwo','temiz mesaj','00000000-0000-4000-8000-00000000a002');
    raise exception 'ASSERT FAIL: banned gönderen mesaj atabildi';
  exception when others then
    if position('ACCOUNT_BANNED' in sqlerrm)=0 then raise; end if;
  end;
end $$;
update public.profiles set moderation_status='active'
 where id='00000000-0000-4000-8000-00000000a002';


-- ════════════════════════════════════════════════════════════════════════════
-- B) MODERASYON DURUM HELPER'LARI
-- ════════════════════════════════════════════════════════════════════════════

-- B1) banned → ACCOUNT_BANNED
update public.profiles set moderation_status='banned' where id='00000000-0000-4000-8000-00000000a002';
do $$ begin
  begin perform public.assert_profile_moderation_active('00000000-0000-4000-8000-00000000a002');
    raise exception 'ASSERT FAIL: banned aktif sayıldı';
  exception when others then if position('ACCOUNT_BANNED' in sqlerrm)=0 then raise; end if; end;
end $$;

-- B2) süresi GEÇMİŞ suspension → engellenmez (auto-expiry)
update public.profiles set moderation_status='suspended', suspended_until=now()-interval '1 day'
 where id='00000000-0000-4000-8000-00000000a002';
do $$ begin
  perform public.assert_profile_moderation_active('00000000-0000-4000-8000-00000000a002');
  -- exception atmamalı
end $$;

-- B3) get_my_moderation_status — banned kullanıcı kendi durumunu okur
update public.profiles set moderation_status='banned', suspended_until=null
 where id='00000000-0000-4000-8000-00000000a002';
select set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-4000-8000-00000000a002')::text, true);
do $$
declare v jsonb;
begin
  v := public.get_my_moderation_status();
  if v->>'status' <> 'banned' then raise exception 'ASSERT FAIL: get_my_moderation_status banned dönmedi (%)', v; end if;
end $$;
-- Önce moderatör bağlamına dön (jwt temizle), SONRA durumu sıfırla — aksi hâlde
-- self-update guard (F3) bu temizliği haklı olarak engellerdi.
select set_config('request.jwt.claims','', true);
update public.profiles set moderation_status='active' where id='00000000-0000-4000-8000-00000000a002';


-- ════════════════════════════════════════════════════════════════════════════
-- C) PROFİL RAPORLAMA (report_profile)
-- ════════════════════════════════════════════════════════════════════════════
-- reporterOne bağlamı
select set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-4000-8000-00000000a001')::text, true);

-- C1) başka profili raporla → ok + snapshot SUNUCUDAN (reporterone gönderemez)
do $$
declare r jsonb;
begin
  r := public.report_profile('00000000-0000-4000-8000-00000000a002','harassment');
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: report_profile ok değil'; end if;
end $$;
do $$ begin
  if not exists (
    select 1 from public.reports
     where target_type='profile' and target_profile_id='00000000-0000-4000-8000-00000000a002'
       and reporter_profile_id='00000000-0000-4000-8000-00000000a001'
       and reported_username_snapshot='targettwo')
  then raise exception 'ASSERT FAIL: profil raporu/snapshot yazılmadı'; end if;
end $$;

-- C2) duplicate → REPORT_ALREADY_SUBMITTED
do $$ begin
  begin perform public.report_profile('00000000-0000-4000-8000-00000000a002','spam_scam');
    raise exception 'ASSERT FAIL: duplicate rapor kabul edildi';
  exception when others then if position('REPORT_ALREADY_SUBMITTED' in sqlerrm)=0 then raise; end if; end;
end $$;

-- C3) kendini raporlayamaz → REPORT_NOT_ALLOWED
do $$ begin
  begin perform public.report_profile('00000000-0000-4000-8000-00000000a001','other');
    raise exception 'ASSERT FAIL: self-report kabul edildi';
  exception when others then if position('REPORT_NOT_ALLOWED' in sqlerrm)=0 then raise; end if; end;
end $$;

-- C4) olmayan hedef → REPORT_TARGET_NOT_FOUND
do $$ begin
  begin perform public.report_profile('00000000-0000-4000-8000-00000000dead','harassment');
    raise exception 'ASSERT FAIL: olmayan hedef kabul edildi';
  exception when others then if position('REPORT_TARGET_NOT_FOUND' in sqlerrm)=0 then raise; end if; end;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- D) ODA MESAJI RAPORLAMA (report_room_message) — auth + guest
-- ════════════════════════════════════════════════════════════════════════════

-- D1) authenticated katılımcı, başka oyuncunun mesajını raporlar → ok
do $$
declare r jsonb;
begin
  r := public.report_room_message('00000000-0000-4000-8000-00000000c001','inappropriate_language','duel');
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: room report ok değil'; end if;
end $$;
do $$ begin
  if not exists (
    select 1 from public.reports
     where target_type='room_message' and target_id='00000000-0000-4000-8000-00000000c001'
       and reporter_profile_id='00000000-0000-4000-8000-00000000a001'
       and content_snapshot='merhaba dunya' and reported_username_snapshot='targettwo'
       and room_code='ZZUGC1')
  then raise exception 'ASSERT FAIL: room raporu/snapshot yazılmadı'; end if;
end $$;

-- D2) başka odanın mesajını raporlayamaz — reporterOne ZZUGC2'de değil.
--     ZZUGC2'de bir mesaj oluştur (guard'sız fixture: doğrudan insert).
insert into public.duel_players (id, room_id, name, profile_id)
select '00000000-0000-4000-8000-00000000b009', r.id, 'someoneelse', null
  from public.duel_rooms r where r.code='ZZUGC2';
insert into public.duel_messages (id, room_code, player_name, message, sender_profile_id)
values ('00000000-0000-4000-8000-00000000c009','ZZUGC2','someoneelse','baska oda',null);
do $$ begin
  begin perform public.report_room_message('00000000-0000-4000-8000-00000000c009','harassment','duel');
    raise exception 'ASSERT FAIL: başka odanın mesajı raporlanabildi';
  exception when others then if position('REPORT_NOT_ALLOWED' in sqlerrm)=0 then raise; end if; end;
end $$;

-- D3) kendi mesajını raporlayamaz — reporterOne kendi mesajını oluşturup dener.
insert into public.duel_messages (id, room_code, player_name, message, sender_profile_id)
values ('00000000-0000-4000-8000-00000000c002','ZZUGC1','reporterone','kendi mesajim',
        '00000000-0000-4000-8000-00000000a001');
do $$ begin
  begin perform public.report_room_message('00000000-0000-4000-8000-00000000c002','other','duel');
    raise exception 'ASSERT FAIL: kendi mesajı raporlanabildi';
  exception when others then if position('REPORT_NOT_ALLOWED' in sqlerrm)=0 then raise; end if; end;
end $$;

-- D4) MİSAFİR (auth yok) geçerli claim ile raporlar → ok; raw token SAKLANMAZ.
select set_config('request.jwt.claims','', true);   -- auth.uid() = null
do $$
declare r jsonb;
begin
  r := public.report_room_message(
        '00000000-0000-4000-8000-00000000c001','sexual_content','duel',
        '00000000-0000-4000-8000-00000000b003',           -- guest player id
        '00000000-0000-4000-8000-00000000c111');          -- doğru claim token
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: guest room report ok değil'; end if;
end $$;
do $$
declare v_hash text;
begin
  select reporter_guest_key_hash into v_hash from public.reports
   where target_type='room_message' and target_id='00000000-0000-4000-8000-00000000c001'
     and reporter_profile_id is null;
  if v_hash is null then raise exception 'ASSERT FAIL: guest raporu/hash yazılmadı'; end if;
  -- Raw claim token HİÇBİR yerde saklanmamalı + hash SHA-256 hex (64 hane) olmalı.
  if v_hash = '00000000-0000-4000-8000-00000000c111'
    then raise exception 'ASSERT FAIL: raw claim token saklanmış'; end if;
  if v_hash !~ '^[0-9a-f]{64}$'
    then raise exception 'ASSERT FAIL: guest hash SHA-256 hex(64) değil: %', v_hash; end if;
end $$;

-- D5) MİSAFİR sahte claim ile → REPORT_NOT_ALLOWED
do $$ begin
  begin perform public.report_room_message(
        '00000000-0000-4000-8000-00000000c001','harassment','duel',
        '00000000-0000-4000-8000-00000000b003',
        '00000000-0000-4000-8000-00000000dead');   -- yanlış token
    raise exception 'ASSERT FAIL: sahte claim raporu kabul edildi';
  exception when others then if position('REPORT_NOT_ALLOWED' in sqlerrm)=0 then raise; end if; end;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- E) reports RLS — anon/authenticated DOĞRUDAN erişemez
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  begin
    set local role authenticated;
    perform 1 from public.reports limit 1;   -- SELECT grant yok → hata beklenir
    reset role;
    raise exception 'ASSERT FAIL: authenticated reports SELECT yapabildi';
  exception when insufficient_privilege then
    reset role;   -- beklenen
  when others then
    reset role;
    if position('permission denied' in lower(sqlerrm))=0 then raise; end if;
  end;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- F) MODERASYON ENFORCE — friend_requests (banned istek atamaz)
-- ════════════════════════════════════════════════════════════════════════════
update public.profiles set moderation_status='banned' where id='00000000-0000-4000-8000-00000000a001';
do $$ begin
  begin
    insert into public.friend_requests (requester_profile_id, recipient_profile_id)
    values ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a002');
    raise exception 'ASSERT FAIL: banned kullanıcı arkadaşlık isteği atabildi';
  exception when others then if position('ACCOUNT_BANNED' in sqlerrm)=0 then raise; end if; end;
end $$;
update public.profiles set moderation_status='active' where id='00000000-0000-4000-8000-00000000a001';


-- ════════════════════════════════════════════════════════════════════════════
-- F2) moderation_note GİZLİLİĞİ — not profiles'ta DEĞİL; PRIVATE tablo client'a kapalı
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  -- (a) profiles'ta moderation_note kolonu OLMAMALI (dünya-okunur tablo).
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='profiles' and column_name='moderation_note')
  then raise exception 'ASSERT FAIL: moderation_note hâlâ dünya-okunur profiles tablosunda'; end if;
  -- (b) PRIVATE tablo VAR + RLS açık olmalı.
  if not exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='profile_moderation')
  then raise exception 'ASSERT FAIL: profile_moderation private tablosu yok'; end if;
  if not (select relrowsecurity from pg_class where oid='public.profile_moderation'::regclass)
  then raise exception 'ASSERT FAIL: profile_moderation RLS kapalı'; end if;
  -- (c) anon/authenticated bu tabloya HİÇBİR erişime sahip OLMAMALI (grant yok).
  if has_table_privilege('authenticated','public.profile_moderation','select')
     or has_table_privilege('anon','public.profile_moderation','select')
     or has_table_privilege('authenticated','public.profile_moderation','insert')
     or has_table_privilege('authenticated','public.profile_moderation','update')
  then raise exception 'ASSERT FAIL: profile_moderation client rollerine açık'; end if;
end $$;

-- (d) RUNTIME: authenticated rolüyle private tablodan okuma REDDEDİLİR.
do $$ begin
  begin
    set local role authenticated;
    perform 1 from public.profile_moderation limit 1;
    reset role;
    raise exception 'ASSERT FAIL: authenticated profile_moderation okudu';
  exception when insufficient_privilege then reset role;
  when others then reset role; if position('permission denied' in lower(sqlerrm))=0 then raise; end if; end;
end $$;

-- (e) postgres (SQL Editor / SECURITY DEFINER eşdeğeri) notu yazıp okuyabilir.
insert into public.profile_moderation (profile_id, note)
values ('00000000-0000-4000-8000-00000000a002','ic not: hakaret')
on conflict (profile_id) do update set note=excluded.note, updated_at=now();
do $$ begin
  if not exists (select 1 from public.profile_moderation
                 where profile_id='00000000-0000-4000-8000-00000000a002' and note='ic not: hakaret')
  then raise exception 'ASSERT FAIL: postgres private not yazamadı/okuyamadı'; end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- F3) SELF-UPDATE ENGELİ — kullanıcı kendi moderation_status/suspended_until'unu
--     değiştiremez (self-unban savunması). Kolon-REVOKE tablo-GRANT-ALL yüzünden
--     NO-OP; gerçek zorlama _profiles_ugc_enforce trigger'ında. Guard auth.uid()=id
--     ile tetiklenir → role değiştirmeye gerek yok, jwt claim yeterli.
-- ════════════════════════════════════════════════════════════════════════════
-- a002 şu an 'active'. Aktör = a002 (kendi profili) iken 'banned'e çekme DENEMESİ.
select set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-4000-8000-00000000a002')::text, true);
do $$ begin
  begin
    update public.profiles set moderation_status='banned'
     where id='00000000-0000-4000-8000-00000000a002';
    raise exception 'ASSERT FAIL: kullanıcı kendi moderation_status''unu değiştirdi (self-unban açığı)';
  exception when others then
    if position('MODERATION_SELF_UPDATE_FORBIDDEN' in sqlerrm)=0 then raise; end if;
  end;
end $$;
do $$ begin
  begin
    update public.profiles set suspended_until = now() + interval '5 days'
     where id='00000000-0000-4000-8000-00000000a002';
    raise exception 'ASSERT FAIL: kullanıcı kendi suspended_until''unu değiştirdi';
  exception when others then
    if position('MODERATION_SELF_UPDATE_FORBIDDEN' in sqlerrm)=0 then raise; end if;
  end;
end $$;
-- Değeri DEĞİŞTİRMEYEN self no-op update engellenmez (regresyon).
update public.profiles set moderation_status='active'
 where id='00000000-0000-4000-8000-00000000a002';

-- Moderatör bağlamı (auth.uid() NULL = service_role/postgres) SERBEST değiştirir.
select set_config('request.jwt.claims','', true);
update public.profiles set moderation_status='suspended', suspended_until=now()+interval '1 day'
 where id='00000000-0000-4000-8000-00000000a002';
do $$ begin
  if not exists (select 1 from public.profiles
                 where id='00000000-0000-4000-8000-00000000a002' and moderation_status='suspended')
  then raise exception 'ASSERT FAIL: moderatör (auth.uid null) moderation_status değiştiremedi'; end if;
end $$;
update public.profiles set moderation_status='active', suspended_until=null
 where id='00000000-0000-4000-8000-00000000a002';


-- ════════════════════════════════════════════════════════════════════════════
-- F4) EK RUNTIME KAPSAMI — temiz mesaj, change_username, DM filtre, DM raporu
-- ════════════════════════════════════════════════════════════════════════════
-- (i) TEMİZ lobi mesajı trigger'ı GEÇER (normal akış çalışıyor).
insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
values ('ZZUGC1','targettwo','iyi oyunlar herkese','00000000-0000-4000-8000-00000000a002');
do $$ begin
  if not exists (select 1 from public.duel_messages where room_code='ZZUGC1' and message='iyi oyunlar herkese')
  then raise exception 'ASSERT FAIL: temiz lobi mesajı yazılamadı'; end if;
end $$;

-- (ii) change_username: uygunsuz ad graceful REDDEDİLİR, temiz ad KABUL edilir.
select set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-4000-8000-00000000a001')::text, true);
do $$
declare r jsonb;
begin
  r := public.change_username('orospucocugu');
  if (r->>'ok')::boolean is not false then raise exception 'ASSERT FAIL: change_username uygunsuz adı kabul etti (%)', r; end if;
end $$;
do $$
declare r jsonb;
begin
  r := public.change_username('temizreporter');
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: change_username temiz adı reddetti (%)', r; end if;
end $$;

-- (iii) dm_send_message: arkadaşlar arası TEMİZ DM çalışır, UYGUNSUZ DM reddedilir.
insert into public.friends (profile_id, friend_profile_id) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a002'),
  ('00000000-0000-4000-8000-00000000a002','00000000-0000-4000-8000-00000000a001')
on conflict do nothing;
do $$
declare r jsonb;
begin
  r := public.dm_send_message('00000000-0000-4000-8000-00000000a002','selam nasilsin');
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: temiz DM gönderilemedi (%)', r; end if;
end $$;
do $$ begin
  begin
    perform public.dm_send_message('00000000-0000-4000-8000-00000000a002','siktir git');
    raise exception 'ASSERT FAIL: uygunsuz DM gönderildi';
  exception when others then
    if position('UGC_MESSAGE_NOT_ALLOWED' in sqlerrm)=0 then raise; end if;
  end;
end $$;

-- (iv) report_dm_message: ALICI, karşı tarafın DM'ini raporlar → ok + snapshot SUNUCUDAN.
--      Konuşma (iii)'teki temiz DM ile zaten oluştu → pair-uniq ihlali olmasın diye
--      _dm_resolve_conversation ile mevcut konuşma id'sini al, mesajı ona ekle.
do $$
declare v_conv uuid; r jsonb;
begin
  v_conv := public._dm_resolve_conversation(
    '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a002');
  insert into public.dm_messages (id, conversation_id, sender_id, recipient_id, content)
  values ('00000000-0000-4000-8000-00000000dd01', v_conv,
          '00000000-0000-4000-8000-00000000a002','00000000-0000-4000-8000-00000000a001','kaba dm sozu')
  on conflict (id) do nothing;
  r := public.report_dm_message('00000000-0000-4000-8000-00000000dd01','harassment');
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: report_dm_message ok değil (%)', r; end if;
end $$;
do $$ begin
  if not exists (
    select 1 from public.reports
     where target_type='dm_message' and target_id='00000000-0000-4000-8000-00000000dd01'
       and reporter_profile_id='00000000-0000-4000-8000-00000000a001'
       and target_profile_id='00000000-0000-4000-8000-00000000a002'
       and content_snapshot='kaba dm sozu' and conversation_id is not null)
  then raise exception 'ASSERT FAIL: DM raporu/snapshot sunucudan yazılmadı'; end if;
end $$;

-- (v) kendi DM'ini raporlayamaz.
do $$
declare v_conv uuid;
begin
  v_conv := public._dm_resolve_conversation(
    '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a002');
  insert into public.dm_messages (id, conversation_id, sender_id, recipient_id, content)
  values ('00000000-0000-4000-8000-00000000dd02', v_conv,
          '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a002','kendi dmim')
  on conflict (id) do nothing;
  begin
    perform public.report_dm_message('00000000-0000-4000-8000-00000000dd02','other');
    raise exception 'ASSERT FAIL: kendi DM raporlanabildi';
  exception when others then
    if position('REPORT_NOT_ALLOWED' in sqlerrm)=0 then raise; end if;
  end;
end $$;
select set_config('request.jwt.claims','', true);


-- ════════════════════════════════════════════════════════════════════════════
-- G) HESAP SİLME İLİŞKİSİ — reports FK set null, snapshot KALIR
-- ════════════════════════════════════════════════════════════════════════════
-- targetTwo profili silinince (BEFORE DELETE cleanup + FK), o kullanıcıyı hedef
-- alan raporlar SİLİNMEZ; target_profile_id NULL olur, snapshot korunur.
do $$
declare v_before int; v_after int; v_null_ok boolean;
begin
  select count(*) into v_before from public.reports
   where target_id='00000000-0000-4000-8000-00000000c001';
  delete from public.profiles where id='00000000-0000-4000-8000-00000000a002';
  select count(*) into v_after from public.reports
   where target_id='00000000-0000-4000-8000-00000000c001';
  if v_after <> v_before then
    raise exception 'ASSERT FAIL: hesap silinince rapor kayboldu (%->%)', v_before, v_after;
  end if;
  select bool_and(target_profile_id is null and content_snapshot='merhaba dunya')
    into v_null_ok from public.reports
   where target_id='00000000-0000-4000-8000-00000000c001';
  if not v_null_ok then
    raise exception 'ASSERT FAIL: silme sonrası FK NULL / snapshot korunumu bozuk';
  end if;
end $$;


do $$ begin raise notice 'TÜM UGC TESTLERİ GEÇTİ'; end $$;

rollback;
