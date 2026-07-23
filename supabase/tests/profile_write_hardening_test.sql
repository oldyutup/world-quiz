-- ============================================================================
-- PROFILES YAZMA SERTLEŞTİRME — ACL runtime testi (client saldırıları + regresyon)
-- ============================================================================
-- NEREDE KOŞULUR: YALNIZ izole schema-only prod kopyası / lokal Supabase
--   (migration 20260806120000 + 20260807120000 UYGULANMIŞ). CANLIDA KOŞMA.
--   Script tek transaction'dır ve SONUNDA ROLLBACK eder → kalıcı iz bırakmaz.
--
-- KOŞMA:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/profile_write_hardening_test.sql
--   Başarı = "TÜM PROFİL-SERTLEŞTİRME TESTLERİ GEÇTİ" notice. Her sapma exception.
--
-- Bağlam simülasyonu: request.jwt.claims GUC + `set local role authenticated`
--   (kolon-ACL yalnız gerçek rol altında uygulanır; postgres owner/bypass ACL).
-- auth.uid() prod uygulaması request.jwt.claims JSON ->> 'sub' okur.
-- ============================================================================

begin;

-- ── Fixture — 3 kimlik ──
--   e001 = attacker/self (kendi satırına saldırır)
--   e002 = victim/other  (çapraz-kullanıcı hedefi)
--   e003 = yeni kullanıcı (INSERT sertleştirme — henüz profili YOK)
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-00000000e001','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','attacker@test.local','x',now(),now(),now(),
   '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb),
  ('00000000-0000-4000-8000-00000000e002','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','victim@test.local','x',now(),now(),now(),
   '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb),
  ('00000000-0000-4000-8000-00000000e003','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','newuser@test.local','x',now(),now(),now(),
   '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb)
on conflict (id) do nothing;

-- profiller (postgres owner → ACL/RLS bypass, meşru sunucu-tarafı kurulum).
-- Başlangıç gold'u değişkenden veriyoruz ki DEFINER RPC regresyonu net görülsün.
insert into public.profiles (id, username, gold, xp, level) values
  ('00000000-0000-4000-8000-00000000e001','attackerone', 100, 5, 2),
  ('00000000-0000-4000-8000-00000000e002','victimtwo',   100, 5, 2)
on conflict (id) do update set username=excluded.username, gold=excluded.gold;
-- e003 profili YOK (INSERT testleri oluşturacak).


-- ════════════════════════════════════════════════════════════════════════════
-- A) DOĞRUDAN CLIENT SALDIRILARI — authenticated KENDİ satırına (RLS geçer),
--    ama SUNUCU-OTORİTER kolonları YAZAMAZ (kolon-ACL reddi = 42501).
-- ════════════════════════════════════════════════════════════════════════════
-- Aktör = e001; kendi satırı → RLS USING(auth.uid()=id) DOĞRU. Yine de ekonomi/
-- ilerleme/moderasyon/guard/sistem kolonları kolon-UPDATE yetkisi olmadığından
-- statement-seviyesinde reddedilir.
select set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-4000-8000-00000000e001')::text, true);

-- Yardımcı: verilen SET ifadesinin authenticated altında insufficient_privilege
-- (42501) ile reddedildiğini doğrula. Reddedilmezse ASSERT FAIL.
do $$
declare
  v_cols text[] := array[
    'gold = 999999',
    'xp = 999999',
    'level = 999',
    'is_test_account = true',
    'moderation_status = ''active''',
    'suspended_until = now() + interval ''5 days''',
    'profile_code = ''HACKED1''',
    'username_change_count = 0',
    'username_changed_at = now()',
    'created_at = ''2000-01-01''',
    'id = ''00000000-0000-4000-8000-0000000000ff'''
  ];
  v_set text;
  v_denied boolean;
begin
  foreach v_set in array v_cols loop
    v_denied := false;
    begin
      set local role authenticated;
      execute format(
        'update public.profiles set %s where id = %L',
        v_set, '00000000-0000-4000-8000-00000000e001');
      reset role;
    exception
      when insufficient_privilege then
        reset role; v_denied := true;
      when others then
        reset role;
        if position('permission denied' in lower(sqlerrm)) > 0 then
          v_denied := true;
        else
          raise;   -- beklenmeyen bir hata → yükselt
        end if;
    end;
    if not v_denied then
      raise exception 'ASSERT FAIL: authenticated sunucu-otoriter kolonu yazabildi → SET %', v_set;
    end if;
  end loop;
end $$;

-- A-son) gold GERÇEKTEN değişmedi (100 kaldı).
do $$ begin
  if (select gold from public.profiles where id='00000000-0000-4000-8000-00000000e001') <> 100
  then raise exception 'ASSERT FAIL: gold saldırı sonrası değişmiş'; end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- B) ÇAPRAZ-KULLANICI — e001, e002'nin satırını değiştiremez.
-- ════════════════════════════════════════════════════════════════════════════
-- B1) İzin verilen kolonda (username) bile: kolon-ACL geçer ama RLS own-row
--     filtreler → 0 satır (hata değil). e002.username DEĞİŞMEMELİ.
do $$
declare v_before text; v_after text;
begin
  select username into v_before from public.profiles where id='00000000-0000-4000-8000-00000000e002';
  set local role authenticated;
  update public.profiles set username='hijacked'
   where id='00000000-0000-4000-8000-00000000e002';   -- RLS → 0 satır
  reset role;
  select username into v_after from public.profiles where id='00000000-0000-4000-8000-00000000e002';
  if v_after is distinct from v_before then
    raise exception 'ASSERT FAIL: başka kullanıcının username''i değişti (%->%)', v_before, v_after;
  end if;
end $$;

-- B2) Sunucu-otoriter kolonda (gold) başka satır: kolon-ACL reddi (RLS''den önce).
do $$
declare v_denied boolean := false;
begin
  begin
    set local role authenticated;
    update public.profiles set gold=999999
     where id='00000000-0000-4000-8000-00000000e002';
    reset role;
  exception when insufficient_privilege then reset role; v_denied := true;
    when others then reset role;
      if position('permission denied' in lower(sqlerrm))>0 then v_denied := true; else raise; end if;
  end;
  if not v_denied then raise exception 'ASSERT FAIL: başka kullanıcının gold''u yazılabildi'; end if;
  if (select gold from public.profiles where id='00000000-0000-4000-8000-00000000e002') <> 100
  then raise exception 'ASSERT FAIL: e002 gold değişti'; end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- C) ANON — hiçbir yazma yapamaz (yalnız SELECT grant'ı var).
-- ════════════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims','', true);   -- auth.uid()=null
do $$
declare v_denied boolean := false;
begin
  begin
    set local role anon;
    update public.profiles set username='anonhack'
     where id='00000000-0000-4000-8000-00000000e001';
    reset role;
  exception when insufficient_privilege then reset role; v_denied := true;
    when others then reset role;
      if position('permission denied' in lower(sqlerrm))>0 then v_denied := true; else raise; end if;
  end;
  if not v_denied then raise exception 'ASSERT FAIL: anon profiles UPDATE yapabildi'; end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- D) INSERT SERTLEŞTİRME — yeni kullanıcı (e003) ilk profilini oluştururken
--    server-owned başlangıç değeri (gold) GÖNDEREMEZ.
-- ════════════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-4000-8000-00000000e003')::text, true);

-- D1) gold içeren INSERT → kolon-INSERT yetkisi yok → reddedilir.
do $$
declare v_denied boolean := false;
begin
  begin
    set local role authenticated;
    insert into public.profiles (id, username, gold)
    values ('00000000-0000-4000-8000-00000000e003','yeniuser', 999999);
    reset role;
  exception when insufficient_privilege then reset role; v_denied := true;
    when others then reset role;
      if position('permission denied' in lower(sqlerrm))>0 then v_denied := true; else raise; end if;
  end;
  if not v_denied then raise exception 'ASSERT FAIL: ilk INSERT''te keyfi gold verilebildi'; end if;
end $$;

-- D2) İzin verilen kolonlarla INSERT → BAŞARILI + gold DEFAULT (0) olur.
do $$ begin
  set local role authenticated;
  insert into public.profiles (id, username, username_normalized, has_chosen_username, username_source)
  values ('00000000-0000-4000-8000-00000000e003','yeniuser',
          public.username_key('yeniuser'), true, 'onboarding');
  reset role;
exception when others then reset role; raise; end $$;
do $$ begin
  if not exists (select 1 from public.profiles
                 where id='00000000-0000-4000-8000-00000000e003' and gold=0 and xp=0 and level=1)
  then raise exception 'ASSERT FAIL: yeni profil DEFAULT ekonomi değerleriyle oluşmadı'; end if;
  if not exists (select 1 from public.profiles
                 where id='00000000-0000-4000-8000-00000000e003' and profile_code is not null)
  then raise exception 'ASSERT FAIL: profile_code trigger ile atanmadı'; end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- E) İZİN VERİLEN SELF-EDIT — authenticated kendi kullanıcı-editable kolonlarını
--    değiştirebilir.
-- ════════════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-4000-8000-00000000e001')::text, true);

-- E1) temiz username
do $$ begin
  set local role authenticated;
  update public.profiles set username='temizattack' where id='00000000-0000-4000-8000-00000000e001';
  reset role;
exception when others then reset role; raise; end $$;
do $$ begin
  if not exists (select 1 from public.profiles
                 where id='00000000-0000-4000-8000-00000000e001' and username='temizattack')
  then raise exception 'ASSERT FAIL: izin verilen username yazılamadı'; end if;
end $$;

-- E2) avatar_id (geçerli format)
do $$ begin
  set local role authenticated;
  update public.profiles set avatar_id='avatar_fox' where id='00000000-0000-4000-8000-00000000e001';
  reset role;
exception when others then reset role; raise; end $$;
do $$ begin
  if not exists (select 1 from public.profiles
                 where id='00000000-0000-4000-8000-00000000e001' and avatar_id='avatar_fox')
  then raise exception 'ASSERT FAIL: avatar_id yazılamadı'; end if;
end $$;

-- E3) updated_at (kozmetik, izinli)
do $$ begin
  set local role authenticated;
  update public.profiles set updated_at=now() where id='00000000-0000-4000-8000-00000000e001';
  reset role;
exception when others then reset role; raise; end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- F) MEŞRU SUNUCU RPC'LERİ (SECURITY DEFINER, owner=postgres) HÂLÂ ÇALIŞIR —
--    ACL kilidi meşru ekonomi/ilerleme/guard yazımlarını BOZMAZ.
-- ════════════════════════════════════════════════════════════════════════════
-- Bağlam = authenticated (client simülasyonu). DEFINER fn içeride postgres olur.

-- F1) claim_daily_gold_bonus() → +50 gold (proven-vuln kolonuna DEFINER yazar).
do $$
declare r jsonb; v_before int;
begin
  select gold into v_before from public.profiles where id='00000000-0000-4000-8000-00000000e001';
  set local role authenticated;
  r := public.claim_daily_gold_bonus();
  reset role;
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: claim_daily_gold_bonus ok değil (%)', r; end if;
  if (select gold from public.profiles where id='00000000-0000-4000-8000-00000000e001') <> v_before + 50
  then raise exception 'ASSERT FAIL: daily bonus gold''u +50 artırmadı'; end if;
end $$;

-- F2) award_gameplay_gold(50,'gameplay_award') → gold artar.
do $$
declare r jsonb; v_before int;
begin
  select gold into v_before from public.profiles where id='00000000-0000-4000-8000-00000000e001';
  set local role authenticated;
  r := public.award_gameplay_gold(50, 'gameplay_award');
  reset role;
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: award_gameplay_gold ok değil (%)', r; end if;
  if (select gold from public.profiles where id='00000000-0000-4000-8000-00000000e001') <> v_before + 50
  then raise exception 'ASSERT FAIL: award_gameplay_gold gold''u artırmadı'; end if;
end $$;

-- F3) change_username → username + KİLİTLİ guard kolonları (change_count/changed_at)
--     DEFINER üzerinden güncellenir.
do $$
declare r jsonb; v_cnt_before int;
begin
  select username_change_count into v_cnt_before from public.profiles where id='00000000-0000-4000-8000-00000000e001';
  set local role authenticated;
  r := public.change_username('yenikadi');
  reset role;
  if (r->>'ok')::boolean is not true then raise exception 'ASSERT FAIL: change_username ok değil (%)', r; end if;
  if (select username_change_count from public.profiles where id='00000000-0000-4000-8000-00000000e001') <> v_cnt_before + 1
  then raise exception 'ASSERT FAIL: change_username kilitli guard kolonu (change_count) yazamadı'; end if;
  if not exists (select 1 from public.profiles where id='00000000-0000-4000-8000-00000000e001' and username='yenikadi')
  then raise exception 'ASSERT FAIL: change_username username''i yazamadı'; end if;
end $$;

-- F4) XP ödül RPC'si (award_xp_event) — profiles'a DOKUNMAZ (player_*_stats yazar),
--     ACL değişiminden ETKİLENMEZ; yine de çalıştığı doğrulanır.
do $$
declare r jsonb;
begin
  set local role authenticated;
  r := public.award_xp_event('00000000-0000-4000-8000-00000000e001','country_duel',
        gen_random_uuid(), 100, 'win');
  reset role;
  if r is null then raise exception 'ASSERT FAIL: award_xp_event null döndü'; end if;
  if not exists (select 1 from public.player_overall_stats where profile_id='00000000-0000-4000-8000-00000000e001')
  then raise exception 'ASSERT FAIL: award_xp_event player_overall_stats yazamadı'; end if;
end $$;

-- F5) SİSTEM/MODERATÖR yolu — postgres (SQL Editor eşdeğeri) gold''u doğrudan
--     güncelleyebilir (owner → ACL bypass).
update public.profiles set gold = 12345 where id='00000000-0000-4000-8000-00000000e002';
do $$ begin
  if (select gold from public.profiles where id='00000000-0000-4000-8000-00000000e002') <> 12345
  then raise exception 'ASSERT FAIL: postgres sistem yolu gold yazamadı'; end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- G) ACL KATALOG DOĞRULAMASI — has_table_privilege / has_column_privilege
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  -- tablo-seviyesi yazma authenticated'da YOK
  if has_table_privilege('authenticated','public.profiles','UPDATE') then raise exception 'ASSERT FAIL: authenticated table UPDATE var'; end if;
  if has_table_privilege('authenticated','public.profiles','INSERT') then raise exception 'ASSERT FAIL: authenticated table INSERT var'; end if;
  if has_table_privilege('authenticated','public.profiles','DELETE') then raise exception 'ASSERT FAIL: authenticated table DELETE var'; end if;
  if has_table_privilege('anon','public.profiles','UPDATE') then raise exception 'ASSERT FAIL: anon UPDATE var'; end if;
  -- SELECT (dünya-okunur) VAR
  if not has_table_privilege('authenticated','public.profiles','SELECT') then raise exception 'ASSERT FAIL: authenticated SELECT yok'; end if;
  if not has_table_privilege('anon','public.profiles','SELECT') then raise exception 'ASSERT FAIL: anon SELECT yok'; end if;
  -- sunucu-otoriter kolonlar KAPALI (UPDATE)
  if has_column_privilege('authenticated','public.profiles','gold','UPDATE')              then raise exception 'ASSERT FAIL: gold UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','xp','UPDATE')                then raise exception 'ASSERT FAIL: xp UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','level','UPDATE')             then raise exception 'ASSERT FAIL: level UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','is_test_account','UPDATE')   then raise exception 'ASSERT FAIL: is_test_account UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','moderation_status','UPDATE') then raise exception 'ASSERT FAIL: moderation_status UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','suspended_until','UPDATE')   then raise exception 'ASSERT FAIL: suspended_until UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','profile_code','UPDATE')      then raise exception 'ASSERT FAIL: profile_code UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','username_changed_at','UPDATE')    then raise exception 'ASSERT FAIL: username_changed_at UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','username_change_count','UPDATE')  then raise exception 'ASSERT FAIL: username_change_count UPDATE açık'; end if;
  if has_column_privilege('authenticated','public.profiles','created_at','UPDATE')        then raise exception 'ASSERT FAIL: created_at UPDATE açık'; end if;
  -- gold INSERT KAPALI
  if has_column_privilege('authenticated','public.profiles','gold','INSERT') then raise exception 'ASSERT FAIL: gold INSERT açık'; end if;
  -- kullanıcı-editable kolonlar AÇIK (UPDATE)
  if not has_column_privilege('authenticated','public.profiles','username','UPDATE')  then raise exception 'ASSERT FAIL: username UPDATE kapalı'; end if;
  if not has_column_privilege('authenticated','public.profiles','avatar_id','UPDATE') then raise exception 'ASSERT FAIL: avatar_id UPDATE kapalı'; end if;
  if not has_column_privilege('authenticated','public.profiles','updated_at','UPDATE') then raise exception 'ASSERT FAIL: updated_at UPDATE kapalı'; end if;
  -- INSERT izinli kolonlar AÇIK
  if not has_column_privilege('authenticated','public.profiles','username','INSERT') then raise exception 'ASSERT FAIL: username INSERT kapalı'; end if;
  if not has_column_privilege('authenticated','public.profiles','id','INSERT')       then raise exception 'ASSERT FAIL: id INSERT kapalı'; end if;
end $$;


do $$ begin raise notice 'TÜM PROFİL-SERTLEŞTİRME TESTLERİ GEÇTİ'; end $$;

rollback;
