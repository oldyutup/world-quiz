-- ════════════════════════════════════════════════════════════════════════════
-- claim-auth-hardening-precheck.sql
--
-- 20260814180000_registered_player_claim_auth_hardening.sql için
-- SALT-OKUNUR (READ-ONLY) production ön kontrolü.
--
--   • HİÇBİR ŞEY YAZMAZ / DEĞİŞTİRMEZ. Yalnız catalog okur + sayım yapar.
--   • Tek sonuç tablosu döndürür: check / result (PASS|BLOCK|INFO) / detail
--   • En sonda tek satır: DEPLOY_READY = YES|NO
--
-- KULLANIM: Supabase SQL editor'e yapıştır ve çalıştır.
-- ════════════════════════════════════════════════════════════════════════════
with
-- ── 0) Yamalanacak 7 helper + repo baseline parmak izleri ────────────────
target(fname, base_md5, base_len, patched_md5) as (
  values
    ('duel_authorize_player',        'b010b290f6ef98f8a7cf3c40944f76b9', 457, 'fd63d6108d0a8a3892acf7e1ac9996c2'),
    ('duel_group_authorize_player',  '27958fc94b4219e7b4c92e64c276bdfb', 469, '80a3017905264ff5599cf8b412352918'),
    ('conquest_authorize_player',    '211f61bfbee7492327209718a9fdc81a', 465, '9e748fef34df70edb27fea41ca412572'),
    ('wheel_duel_authorize_player',  'a659c409bb1faf763591087df14f7d91', 469, 'e019cf9dd11a471db68dd181a57f9947'),
    ('wheel_group_authorize_player', 'd29ccdb6ed4ca1d2b098e68a9d411ad4', 471, '631b4b23316f4e7cf06236abecf22c71'),
    ('flag_group_authorize_player',  '31aaf4227621f6e4fd41b6d8f86f3a23', 343, '2328b708c720402b2eab1c519bec9cbb'),
    ('route_duel_authorize_player',  '6132b455f182c630cc9575a301ed1447', 343, 'd84bf49448c75655ae26a8ddf3f25409')
),
live as (
  select t.fname, t.base_md5, t.base_len, t.patched_md5,
         p.oid, p.prosrc, p.prosecdef, p.proconfig, p.proacl,
         pg_get_function_identity_arguments(p.oid) as sig,
         pg_get_function_result(p.oid)             as rettype,
         (select count(*) from pg_proc x join pg_namespace y on y.oid = x.pronamespace
           where y.nspname = 'public' and x.proname = t.fname) as overloads
    from target t
    left join pg_proc p
      on p.oid = to_regprocedure('public.' || t.fname || '(uuid,uuid)')
),

-- ── 1) Helper var mı + imza doğru mu ─────────────────────────────────────
c_exists as (
  select 'A1 helper mevcut: ' || fname as check_name,
         case when oid is null then 'BLOCK' else 'PASS' end as result,
         coalesce('(' || sig || ') -> ' || rettype, 'BULUNAMADI (uuid,uuid)') as detail
    from live
),
-- ── 2) Overload sayısı = 1 ───────────────────────────────────────────────
c_overload as (
  select 'A2 overload=1: ' || fname,
         case when overloads = 1 then 'PASS' else 'BLOCK' end,
         'overload sayısı = ' || overloads
    from live
),
-- ── 3) Gövde repo baseline'ı ile birebir mi (drift yok) ──────────────────
c_body as (
  select 'A3 gövde baseline ile aynı: ' || fname,
         case
           when oid is null                     then 'BLOCK'
           when md5(prosrc) = base_md5          then 'PASS'
           when md5(prosrc) = patched_md5       then 'BLOCK'
           else 'BLOCK'
         end,
         case
           when oid is null               then 'fonksiyon yok'
           when md5(prosrc) = base_md5    then 'md5=' || base_md5 || ' len=' || length(prosrc) || ' (beklenen)'
           when md5(prosrc) = patched_md5 then 'ZATEN YAMALI — migration daha önce uygulanmış'
           else 'DRIFT! canlı md5=' || md5(prosrc) || ' len=' || length(prosrc)
                || ' ≠ beklenen ' || base_md5 || '/' || base_len
         end
    from live
),
-- ── 4) SECURITY DEFINER + search_path korunuyor mu ───────────────────────
c_secdef as (
  select 'A4 SECURITY DEFINER + search_path: ' || fname,
         case when oid is null then 'BLOCK'
              when prosecdef
               and 'search_path=public, auth' = any(coalesce(proconfig, array[]::text[]))
              then 'PASS' else 'BLOCK' end,
         'secdef=' || coalesce(prosecdef::text,'-') ||
         ' config=' || coalesce(array_to_string(proconfig, ','), '<yok>')
    from live
),
-- ── 5) EXECUTE grant'ları kayda geçir (create or replace bunları KORUR) ──
c_acl as (
  select 'A5 EXECUTE grant kaydı: ' || fname, 'INFO',
         'anon=' || has_function_privilege('anon', oid, 'execute')::text ||
         ' authenticated=' || has_function_privilege('authenticated', oid, 'execute')::text ||
         ' acl=' || coalesce(proacl::text, '<default>')
    from live where oid is not null
),

-- ── 6) Gerekli tablo/kolonlar mevcut mu ──────────────────────────────────
req(tab, col) as (
  values ('duel_players','profile_id'),        ('duel_player_claims','claim_token'),
         ('duel_group_players','profile_id'),  ('duel_group_player_claims','claim_token'),
         ('conquest_players','profile_id'),    ('conquest_player_claims','claim_token'),
         ('wheel_duel_players','profile_id'),  ('wheel_duel_player_claims','claim_token'),
         ('wheel_group_players','profile_id'), ('wheel_group_player_claims','claim_token'),
         ('flag_group_players','profile_id'),  ('flag_group_player_claims','claim_token'),
         ('route_duel_players','profile_id'),  ('route_duel_player_claims','claim_token')
),
c_cols as (
  select 'B1 kolon mevcut: ' || r.tab || '.' || r.col,
         case when a.attname is null then 'BLOCK' else 'PASS' end,
         coalesce(format_type(a.atttypid, a.atttypmod), 'YOK')
    from req r
    left join pg_attribute a
      on a.attrelid = to_regclass('public.' || r.tab)
     and a.attname  = r.col and a.attnum > 0 and not a.attisdropped
),

-- ── 7) Dokunulmayacak helper'lar beklendiği gibi mi ──────────────────────
c_untouched as (
  select 'C1 DOKUNULMAZ flag_duel_authorize_player delege ediyor',
         case when position('duel_authorize_player' in coalesce(prosrc,'')) > 0
              then 'PASS' else 'BLOCK' end,
         case when prosrc is null then 'fonksiyon yok'
              else 'duel_authorize_player çağrısı gövdede: EVET' end
    from pg_proc where oid = to_regprocedure('public.flag_duel_authorize_player(uuid,uuid)')
  union all
  select 'C2 DOKUNULMAZ tevatur_authorize_player guard taşıyor',
         case when position('guest_id is not null' in coalesce(prosrc,'')) > 0
              then 'PASS' else 'BLOCK' end,
         'misafir dalı guest_id guard: ' ||
         case when position('guest_id is not null' in coalesce(prosrc,'')) > 0 then 'VAR' else 'YOK' end
    from pg_proc where oid = to_regprocedure('public.tevatur_authorize_player(uuid,uuid)')
),

-- ── 8) ETKİ ALANI (yalnız bilgi) — canlı oda/oyuncu sayıları ─────────────
c_live_counts as (
  select 'D1 aktif oda (duel_rooms status<>finished)', 'INFO',
         (select count(*)::text from public.duel_rooms where status <> 'finished')
  union all
  select 'D2 kayıtlı oyuncu + claim satırı VAR (yamadan etkilenen yüzey)', 'INFO',
         (select count(*)::text from public.duel_players p
           join public.duel_player_claims c on c.player_id = p.id
          where p.profile_id is not null)
  union all
  select 'D3 misafir oyuncu + claim (yamadan SONRA da çalışmalı)', 'INFO',
         (select count(*)::text from public.duel_players p
           join public.duel_player_claims c on c.player_id = p.id
          where p.profile_id is null)
),

-- ── 9) ÇARK KUYRUĞU — köprünün ÖN KOŞULU ────────────────────────────────
--     Köprü `q.profile_id = auth.uid()` eşitliğine güvenir. İstemci kuyruğa
--     YAZABİLİYORSA saldırgan kendi profile_id'si + kurbanın player_id'si ile
--     satır ekleyip kurban adına yetkilenir. Migration bu yetkileri kapatır;
--     burada UYGULAMA ÖNCESİ durum kayda geçer (BLOCK değil, INFO).
c_queue as (
  select 'E1 wheel_duel_queue mevcut',
         case when to_regclass('public.wheel_duel_queue') is null then 'BLOCK' else 'PASS' end,
         coalesce(to_regclass('public.wheel_duel_queue')::text, 'YOK — köprü kurulamaz')
  union all
  select 'E2 wheel_duel_queue.'||c||' kolonu',
         case when exists (select 1 from pg_attribute
                            where attrelid = to_regclass('public.wheel_duel_queue')
                              and attname = c and attnum > 0 and not attisdropped)
              then 'PASS' else 'BLOCK' end,
         'köprü bu kolona dayanır'
    from unnest(array['profile_id','player_id']) c
  union all
  -- Uygulama ÖNCESİ yazma yetkileri: migration bunları kapatacak.
  select 'E3 UYGULAMA ÖNCESİ wheel_duel_queue yazma yetkisi ('||r||')', 'INFO',
         'insert='||has_table_privilege(r,'public.wheel_duel_queue','INSERT')::text||
         ' update='||has_table_privilege(r,'public.wheel_duel_queue','UPDATE')::text||
         ' delete='||has_table_privilege(r,'public.wheel_duel_queue','DELETE')::text
    from unnest(array['anon','authenticated']) r
  union all
  -- SELECT KORUNMALI: istemci own-row okuma + realtime aboneliği buna bağlı.
  select 'E4 wheel_duel_queue SELECT korunuyor ('||r||')',
         case when has_table_privilege(r,'public.wheel_duel_queue','SELECT')
              then 'PASS' else 'BLOCK' end,
         'migration SELECT''e DOKUNMAZ; kaybolursa istemci/realtime bozulur'
    from unnest(array['authenticated']) r
  union all
  select 'E5 wheel_duel_queue RLS durumu (DEĞİŞTİRİLMEYECEK)', 'INFO',
         coalesce((select case when relrowsecurity then 'RLS AÇIK' else 'RLS KAPALI' end
                     from pg_class where oid = to_regclass('public.wheel_duel_queue')), '?')
),

-- ── 10) KİMLİKSİZ SATIR ENVANTERİ (INFO) ────────────────────────────────
--     profile_id NULL *ve* guest_id NULL = "gerçek misafir DEĞİL".
--     Yamadan sonra claim dalından GEÇEMEZLER. Bayrak/Çark QM sahipleri
--     kuyruk köprüsünden geçer; kalanlar tarihsel (terk edilmiş) satırlardır.
c_identityless as (
  select 'F1 duel_players kimliksiz (aktif odada)', 'INFO',
         (select count(*)::text from public.duel_players p
           join public.duel_rooms r on r.id = p.room_id
          where p.profile_id is null and p.guest_id is null
            and r.status <> 'finished')
  union all
  select 'F2 wheel_duel_players kimliksiz (aktif odada)', 'INFO',
         (select count(*)::text from public.wheel_duel_players p
           join public.wheel_duel_rooms r on r.id = p.room_id
          where p.profile_id is null and p.guest_id is null
            and r.status <> 'finished')
  union all
  select 'F3 gerçek misafir satırı (guest_id dolu, yamadan sonra da çalışmalı)', 'INFO',
         (select count(*)::text from public.duel_players where guest_id is not null)
),

-- ── 11) QM fonksiyon gövdeleri — drift referansı (INFO) ──────────────────
c_qmfn as (
  select 'G1 flag_duel_quick_match mevcut', 'INFO',
         coalesce((select 'oid=' || p.oid::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='flag_duel_quick_match' limit 1), 'YOK')
  union all
  select 'G2 wheel_duel_quick_match mevcut (gövdesi repoda YOK)', 'INFO',
         coalesce((select 'args: ' || pg_get_function_identity_arguments(p.oid)
                     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='wheel_duel_quick_match' limit 1), 'YOK')
  union all
  select 'G3 wheel_duel_quick_match SECURITY DEFINER mi? (revoke sonrası QM buna bağlı)',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                            where n.nspname='public' and p.proname='wheel_duel_quick_match' and p.prosecdef)
              then 'PASS' else 'BLOCK' end,
         coalesce((select 'prosecdef=' || p.prosecdef::text
                     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='wheel_duel_quick_match' limit 1),
                  'fonksiyon yok — kuyruk revoke QM kurulumunu BOZABİLİR')
),

all_checks as (
  select * from c_exists    union all select * from c_overload
  union all select * from c_body      union all select * from c_secdef
  union all select * from c_acl       union all select * from c_cols
  union all select * from c_untouched union all select * from c_live_counts
  union all select * from c_queue     union all select * from c_identityless
  union all select * from c_qmfn
)
select check_name, result, detail from all_checks
union all
select '══ DEPLOY_READY ══',
       case when exists (select 1 from all_checks where result = 'BLOCK')
            then 'NO' else 'YES' end,
       case when exists (select 1 from all_checks where result = 'BLOCK')
            then (select count(*)::text from all_checks where result = 'BLOCK') || ' adet BLOCK var — UYGULAMA'
            else 'Tüm kontroller PASS — migration uygulanabilir' end
order by 1;
