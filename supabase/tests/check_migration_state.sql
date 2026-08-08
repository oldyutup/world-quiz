-- ============================================================================
-- CANLI MIGRATION DURUMU — TEŞHİS (hiçbir şeyi DEĞİŞTİRMEZ, sadece okur)
-- ============================================================================
-- Supabase Studio → SQL Editor'da çalıştır. Sonuç, hangi migration'ların
-- canlıda olduğunu ve guest-room-join migration'ının çalıştırılabilir olup
-- olmadığını gösterir.
--
-- Sadece SELECT içerir; veri yazmaz, silmez, şema değiştirmez.
-- ============================================================================

select
  m.beklenen_migration,
  m.nesne,
  case when m.var then '✅ CANLIDA' else '❌ EKSİK' end as durum
from (
  values
    ('20260623120000_profile_username_change',
     'profiles.username_normalized kolonu',
     (to_regclass('public.profiles') is not null
      and exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='profiles'
                     and column_name='username_normalized'))),

    ('20260716120000_username_key_system',
     'public.username_key(text)',
     to_regprocedure('public.username_key(text)') is not null),

    ('20260704/20260705 display_name_guard',
     'public.assert_display_name_allowed(text,uuid,text)',
     to_regprocedure('public.assert_display_name_allowed(text,uuid,text)') is not null),

    ('20260801120000_room_code_resolver',
     'duel_rooms.room_kind kolonu',
     exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='duel_rooms'
                and column_name='room_kind')),

    ('20260801/20260802 resolver',
     'public.resolve_torble_room_code(text)',
     to_regprocedure('public.resolve_torble_room_code(text)') is not null),

    ('20260802120000_route_duel_init',
     'public.route_duel_players tablosu',
     to_regclass('public.route_duel_players') is not null),

    ('20260803120000_daily_quest_init',
     'public.daily_quest_claims tablosu',
     to_regclass('public.daily_quest_claims') is not null),

    ('20260805120000_account_deletion_trigger',
     'hesap silme trigger fonksiyonu',
     to_regprocedure('public.trg_account_deletion_cleanup()') is not null),

    ('20260806120000_ugc_safety (ZORUNLU)',
     'public.text_has_forbidden_content(text,text)',
     to_regprocedure('public.text_has_forbidden_content(text,text)') is not null),

    ('20260807120000_profile_write_hardening',
     'profiles kolon-ACL (gold yazma kapalı)',
     not has_column_privilege('anon', 'public.profiles', 'gold', 'UPDATE')),

    ('20260808120000_guest_room_join (YENİ)',
     'public.torble_link_guest_player(text,uuid,uuid)',
     to_regprocedure('public.torble_link_guest_player(text,uuid,uuid)') is not null),

    ('20260808120000_guest_room_join (YENİ)',
     'public.check_guest_display_name(text)',
     to_regprocedure('public.check_guest_display_name(text)') is not null)
) as m(beklenen_migration, nesne, var);


-- ----------------------------------------------------------------------------
-- Guest migration ÖNCESİ / SONRASI kritik güvenlik durumu
-- ----------------------------------------------------------------------------
select 'anon oda kurabiliyor mu? (BEKLENEN: false)' as kontrol,
       coalesce(bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')), false) as sonuc
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname like '%\_create\_room'
union all
select 'anon oyuncu tablolarına INSERT edebiliyor mu? (BEKLENEN: false)',
       coalesce(bool_or(has_table_privilege('anon', c.oid, 'INSERT')), false)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('duel_players','duel_group_players','wheel_duel_players',
                     'wheel_group_players','flag_group_players','conquest_players',
                     'route_duel_players')
union all
select 'anon oda kodu çözebiliyor mu? (guest join için BEKLENEN: true)',
       has_function_privilege('anon', 'public.resolve_torble_room_code(text)', 'EXECUTE')
union all
select 'anon Hızlı Eşleş kuyruğuna girebiliyor mu? (BEKLENEN: false)',
       coalesce(bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')), false)
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname like '%quick\_match%'
union all
select 'anon XP yazabiliyor mu? (BEKLENEN: false)',
       coalesce(bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')), false)
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname like 'award\_%xp%';


-- ----------------------------------------------------------------------------
-- Kayıtlı nick koruması — normalizasyon açığı kapandı mı?
-- ----------------------------------------------------------------------------
-- Türkçe karakter içeren bir kayıtlı kullanıcı adı varsa, misafir onu
-- kullanamamalı. GERÇEK bir kullanıcı adıyla test et.
--
--   select username, username_normalized
--     from public.profiles
--    where username ~ '[çğıöşüÇĞİÖŞÜ]'
--    limit 3;
--
-- Sonra o adı misafir olarak dene — 'registered' dönmeli:
--   select public.check_guest_display_name('<O_KULLANICI_ADI>');
--
-- DÜZELTME ÖNCESİ  : 'ok'          (açık — misafir taklit edebiliyordu)
-- DÜZELTME SONRASI : 'registered'  (kapalı)
-- ============================================================================
