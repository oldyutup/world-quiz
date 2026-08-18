-- ════════════════════════════════════════════════════════════════════════════
-- precheck-final-sweep.sql  ·  M1 + M2 DEPLOYMENT PRECHECK  ·  100% READ-ONLY
--
-- Supabase Studio → SQL Editor'a YAPIŞTIR, çalıştır. TEK bir SELECT'tir:
--   • hiçbir DDL yok, hiçbir DML yok, DO bloğu yok, fonksiyon çağrısı yan
--     etkisiz (yalnız pg_catalog introspection + has_*_privilege)
--   • hiçbir satır okunmaz DIŞINDA: §3 duel_rooms'tan SELECT yapar (read-only)
--
-- İlk satır DEPLOY_READY = YES / NO. Geri kalan satırlar kanıttır.
-- Bölümler:  0 karar · 1 flag_sequence bağımlılıkları · 2 flag_duel_* RPC'ler
--            3 canlı 'playing' odalar · 4 M2 ön koşulları · 5 drift · 9 ortam
-- ════════════════════════════════════════════════════════════════════════════
with
-- ── hedef nesneler ────────────────────────────────────────────────────────
v_rel as (
  select to_regclass('public.duel_rooms') as reloid
),
v_att as (
  select a.attnum, a.attname, a.attgenerated::text as attgenerated, a.atthasdef
    from pg_attribute a, v_rel
   where a.attrelid = v_rel.reloid
     and a.attname  = 'flag_sequence'
     and a.attnum   > 0
     and not a.attisdropped
),
-- ── fonksiyon envanteri + ACL ─────────────────────────────────────────────
fn as (
  select p.oid, p.proname, p.proowner, p.prokind, p.prosecdef, p.proconfig,
         p.proacl, coalesce(p.prosrc, '') as prosrc,
         p.prorettype, p.proargtypes,
         pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
),
fng as (
  select f.oid,
         coalesce(bool_or(g.grantee = to_regrole('anon')::oid
                          and g.privilege_type = 'EXECUTE'), false) as anon_direct,
         coalesce(bool_or(g.grantee = to_regrole('authenticated')::oid
                          and g.privilege_type = 'EXECUTE'), false) as auth_direct,
         coalesce(bool_or(g.grantee = 0 and g.privilege_type = 'EXECUTE'), false) as public_direct
    from fn f
    left join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) g on true
   group by f.oid
),
fnx as (
  select f.*, g.anon_direct, g.auth_direct, g.public_direct,
         has_function_privilege('anon',          f.oid, 'EXECUTE') as anon_eff,
         has_function_privilege('authenticated', f.oid, 'EXECUTE') as auth_eff
    from fn f join fng g on g.oid = f.oid
),
-- ── tablo ACL ─────────────────────────────────────────────────────────────
tb as (
  select c.oid, c.relname, c.relrowsecurity, c.relowner, c.relacl
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
),
tbg as (
  select t.oid,
         coalesce(bool_or(g.grantee = to_regrole('anon')::oid and g.privilege_type='SELECT'), false) as anon_sel_d,
         coalesce(bool_or(g.grantee = to_regrole('anon')::oid and g.privilege_type='INSERT'), false) as anon_ins_d,
         coalesce(bool_or(g.grantee = 0 and g.privilege_type='SELECT'), false) as pub_sel_d,
         coalesce(bool_or(g.grantee = 0 and g.privilege_type='INSERT'), false) as pub_ins_d
    from tb t
    left join lateral aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) g on true
   group by t.oid
),
tbx as (
  select t.*, g.anon_sel_d, g.anon_ins_d, g.pub_sel_d, g.pub_ins_d,
         has_table_privilege('anon',          t.oid, 'SELECT') as anon_sel,
         has_table_privilege('anon',          t.oid, 'INSERT') as anon_ins,
         has_table_privilege('anon',          t.oid, 'UPDATE') as anon_upd,
         has_table_privilege('anon',          t.oid, 'DELETE') as anon_del,
         has_table_privilege('authenticated', t.oid, 'SELECT') as auth_sel,
         has_table_privilege('authenticated', t.oid, 'INSERT') as auth_ins
    from tb t join tbg g on g.oid = t.oid
),

-- ══════════════════════════════════════════════════════════════════════════
-- §1  flag_sequence KOLONUNA TÜM BAĞIMLILIKLAR
-- ══════════════════════════════════════════════════════════════════════════

-- 1a) pg_depend üzerinden KATALOG-KAYITLI her bağımlılık (catch-all).
--     View / matview / index / constraint / default / trigger / statistics /
--     SQL-body fonksiyon — hepsi buraya düşer.
dep_raw as (
  select d.classid::regclass::text as dep_kind,
         d.objid, d.objsubid, d.deptype::text as deptype
    from pg_depend d, v_rel, v_att
   where d.refclassid  = 'pg_class'::regclass
     and d.refobjid    = v_rel.reloid
     and d.refobjsubid = v_att.attnum
),
dep_named as (
  select r.dep_kind, r.deptype,
         case r.dep_kind
           when 'pg_rewrite'   then coalesce((select 'VIEW/RULE ' || rw.ev_class::regclass::text
                                                from pg_rewrite rw where rw.oid = r.objid), 'pg_rewrite#'||r.objid)
           when 'pg_class'     then coalesce((select c.relkind::text || ' ' || c.oid::regclass::text
                                                from pg_class c where c.oid = r.objid), 'pg_class#'||r.objid)
           when 'pg_constraint'then coalesce((select 'CONSTRAINT ' || con.conname || ' on ' || con.conrelid::regclass::text
                                                from pg_constraint con where con.oid = r.objid), 'pg_constraint#'||r.objid)
           when 'pg_attrdef'   then 'COLUMN DEFAULT'
           when 'pg_trigger'   then coalesce((select 'TRIGGER ' || tg.tgname || ' on ' || tg.tgrelid::regclass::text
                                                from pg_trigger tg where tg.oid = r.objid), 'pg_trigger#'||r.objid)
           when 'pg_proc'      then coalesce((select 'FUNCTION ' || p.oid::regprocedure::text
                                                from pg_proc p where p.oid = r.objid), 'pg_proc#'||r.objid)
           when 'pg_policy'    then coalesce((select 'POLICY ' || pol.polname || ' on ' || pol.polrelid::regclass::text
                                                from pg_policy pol where pol.oid = r.objid), 'pg_policy#'||r.objid)
           when 'pg_statistic_ext' then 'EXTENDED STATISTICS'
           when 'pg_publication_rel' then 'PUBLICATION COLUMN LIST'
           else r.dep_kind || '#' || r.objid
         end as obj
    from dep_raw r
),
-- 1b) İndeks / kısıt / default / generated — doğrudan katalogdan (yedek yol)
idx_dep as (
  select i.indexrelid::regclass::text as obj
    from pg_index i, v_rel, v_att
   where i.indrelid = v_rel.reloid
     and v_att.attnum = any (string_to_array(i.indkey::text, ' ')::int[])
),
con_dep as (
  select con.conname || ' (' || con.contype::text || ')' as obj
    from pg_constraint con, v_rel, v_att
   where (con.conrelid = v_rel.reloid  and v_att.attnum = any (con.conkey))
      or (con.confrelid = v_rel.reloid and v_att.attnum = any (con.confkey))
),
-- 1c) PL/pgSQL gövdeleri pg_depend'e KAYIT DÜŞMEZ → metin taraması şart
fn_body_dep as (
  select f.oid, f.proname, f.args, f.anon_eff, f.auth_eff,
         (f.proname in ('flag_duel_advance_if_due','flag_duel_set_flag_sequence')) as expected
    from fnx f
   where f.prosrc ilike '%flag_sequence%'
),
-- 1d) duel_rooms BİLEŞİK TİPİNİ imzasında kullanan fonksiyonlar
--     (kolon düşünce satır şekilleri değişir — kırılmaz ama PostgREST
--      şema önbelleği yenilenmeli)
fn_rowtype as (
  select f.proname, f.args,
         case when f.prorettype = (select reltype from pg_class where oid = (select reloid from v_rel))
              then 'RETURNS duel_rooms' else 'ARG duel_rooms' end as how
    from fnx f, v_rel
   where f.prorettype = (select reltype from pg_class where oid = v_rel.reloid)
      or (select reltype from pg_class where oid = v_rel.reloid)
         = any (case when coalesce(f.proargtypes::text, '') = '' then array[]::oid[]
                     else string_to_array(f.proargtypes::text, ' ')::oid[] end)
),
-- 1e) HER TABLODAKİ politikalar kolona atıf yapıyor mu
pol_dep as (
  select pol.polrelid::regclass::text as tbl, pol.polname,
         coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') as q,
         coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') as wc
    from pg_policy pol
),
pol_hit as (
  select tbl, polname from pol_dep where q ilike '%flag_sequence%' or wc ilike '%flag_sequence%'
),
-- 1f) duel_rooms üzerindeki trigger'lar (kolon-kapsamlı olanlar ayrı)
trg_all as (
  select tg.tgname,
         tg.tgfoid::regprocedure::text as fn,
         case when tg.tgattr::text <> '' and (select attnum from v_att) =
                   any (string_to_array(tg.tgattr::text, ' ')::int[])
              then true else false end as col_scoped
    from pg_trigger tg, v_rel
   where tg.tgrelid = v_rel.reloid and not tg.tgisinternal
),
-- 1g) publication kolon listesi (PG15+; sürümden bağımsız güvenli okuma)
pub_collist as (
  select pr.prpubid::regclass::text as dummy,
         (to_jsonb(pr.*) ->> 'prattrs') as prattrs
    from pg_publication_rel pr, v_rel
   where pr.prrelid = v_rel.reloid
),

-- ══════════════════════════════════════════════════════════════════════════
-- §2  flag_duel_* RPC ENVANTERİ
-- ══════════════════════════════════════════════════════════════════════════
-- Yayınlanmış App Store bundle'ının çağırdığı 12 flag_duel RPC'si —
-- ÜRÜN ROLÜNE göre sınıflandırılmış. "Eski istemci çağırıyor" TEK BAŞINA
-- anon gerektirmez: Torble invariant'ı gereği oda kurma ve Hızlı Eşleş
-- KAYITLI kullanıcıya özeldir; misafir yalnız kayıtlı host'un özel odasına
-- katılır. Bu yüzden rol matrisi:
--   GUEST      → misafir fiilen çağırır  → anon EXECUTE ŞART (kapalıysa BLOKER)
--   REGISTERED → yalnız kayıtlı çağırır  → authenticated ŞART; anon KAPALI
--                OLMASI BEKLENEN durumdur (bloker değil, doğru davranış)
old_client_fd(name, rrole, why) as (
  values
    -- ── GUEST: misafir bu RPC'yi gerçekten çağırır ────────────────────────
    ('flag_duel_submit_claim',       'GUEST',      'gameplay — misafir her turda çağırır'),
    ('flag_duel_leave_room',         'GUEST',      'odadan çıkış'),
    ('flag_duel_send_message',       'GUEST',      'lobi sohbeti'),
    ('flag_duel_accept_rematch',     'GUEST',      'rövanş'),
    ('flag_duel_start_game',         'GUEST',      'host-only ama grant≠yetki; karar authorize_host''ta'),
    ('flag_duel_update_settings',    'GUEST',      'host-only ama grant≠yetki; karar authorize_host''ta'),
    ('flag_duel_set_next_round',     'GUEST',      'LEGACY SHIM (yalnız eski bundle) + host-only gate'),
    ('flag_duel_finalize_game',      'GUEST',      'LEGACY SHIM (yalnız eski bundle) + host-only gate'),
    -- ── REGISTERED: ürün invariant'ı — misafir çağıramaz ─────────────────
    ('flag_duel_create_room',        'REGISTERED', 'oda KURMA — istemci isLoggedInPlayer ile gate''li, sunucuda anon revoke''lu'),
    ('flag_duel_quick_match',        'REGISTERED', 'Hızlı Eşleş — profil + level bracket gerekir'),
    ('flag_duel_cancel_quick_match', 'REGISTERED', 'QM kuyruğundan çıkış'),
    ('flag_duel_reset_quick_match',  'REGISTERED', 'QM kuyruğu sıfırlama')
),
-- Ürün kuralı gereği REGISTERED olan TÜM RPC'ler (yalnız Bayrak Düello değil).
-- Bunlarda anon EXECUTE gereksizdir; açık bulunursa ADVISORY üretilir —
-- bu turda REVOKE EDİLMEZ, yalnız raporlanır.
registered_only(name) as (
  values ('duel_create_room'),('duel_group_create_room'),('wheel_duel_create_room'),
         ('wheel_group_create_room'),('flag_group_create_room'),('route_duel_create_room'),
         ('flag_duel_create_room'),('tevatur_create_room'),
         ('country_duel_quick_match'),('flag_duel_quick_match'),('wheel_duel_quick_match'),
         ('conquest_quick_match'),('route_duel_quick_match'),
         ('country_duel_cancel_quick_match'),('flag_duel_cancel_quick_match'),
         ('wheel_duel_cancel_quick_match'),('conquest_cancel_quick_match'),
         ('route_duel_cancel_quick_match'),
         ('country_duel_reset_quick_match'),('flag_duel_reset_quick_match'),
         ('conquest_reset_quick_match'),('route_duel_reset_quick_match')
),
-- M1'in DEĞİŞTİRECEĞİ fonksiyonlar (create or replace → grant korunur)
m1_touch(name) as (
  values ('flag_duel_set_flag_sequence'),('flag_duel_advance_if_due'),('flag_duel_next_flag')
),
fd_rpc as (
  select f.proname, f.args, f.prosecdef,
         coalesce((select c from unnest(f.proconfig) c where c like 'search_path=%'), '(YOK)') as sp,
         f.anon_eff, f.auth_eff, f.anon_direct,
         (f.prosrc ilike '%flag_sequence%') as touches_col,
         (select o.rrole from old_client_fd o where o.name = f.proname) as rrole,
         (f.proname in (select name from m1_touch))      as m1_touched
    from fnx f
   where f.proname like 'flag\_duel\_%'
),
-- ══════════════════════════════════════════════════════════════════════════
-- §3  CANLI 'playing' BAYRAK DÜELLO ODALARI
-- ══════════════════════════════════════════════════════════════════════════
live_rooms as (
  select r.id, r.code, r.status, r.room_kind, r.current_round, r.total_rounds,
         r.current_flag, r.started_at,
         (r.flag_sequence is null)                as seq_null,
         coalesce(cardinality(r.flag_sequence), 0) as seq_len
    from public.duel_rooms r
   where r.status = 'playing'
),
seq_rows as (
  select count(*) filter (where flag_sequence is not null) as with_seq,
         count(*)                                          as all_rooms,
         count(*) filter (where status = 'playing' and flag_sequence is not null) as playing_with_seq
    from public.duel_rooms
),

-- ══════════════════════════════════════════════════════════════════════════
-- §4  M2 ÖN KOŞULLARI
-- ══════════════════════════════════════════════════════════════════════════
-- Misafirin ihtiyaç duyduğu join/register RPC'leri (anon AÇIK KALMALI)
guest_rpc(name) as (
  values ('duel_join_room'),('duel_group_join_room'),('wheel_duel_join_room'),
         ('wheel_group_join_room'),('flag_group_join_room'),('route_duel_join_room'),
         ('tevatur_join_room'),('conquest_register_player')
),
-- Eski istemcinin tek başına kullandığı shim'ler (anon AÇIK KALMALI)
legacy_shim(name) as (
  values ('flag_duel_finalize_game'),('flag_duel_set_next_round'),
         ('flag_group_advance_flag'),('flag_group_finalize_game'),
         ('wheel_duel_pick_target'),('wheel_group_pick_target')
),
-- M2'nin anon INSERT'i kapatacağı claim tabloları
claim_tbl(name) as (
  values ('duel_player_claims'),('duel_group_player_claims'),
         ('wheel_duel_player_claims'),('wheel_group_player_claims'),
         ('flag_group_player_claims'),('conquest_player_claims')
),
-- 7 authorize helper'ın P0 invariant'ı
authz(name) as (
  values ('duel_authorize_player'),('duel_group_authorize_player'),
         ('conquest_authorize_player'),('wheel_duel_authorize_player'),
         ('wheel_group_authorize_player'),('flag_group_authorize_player'),
         ('route_duel_authorize_player')
),

-- ══════════════════════════════════════════════════════════════════════════
-- BLOKERLER — DEPLOY_READY = NO yapan her koşul
-- ══════════════════════════════════════════════════════════════════════════
blockers as (
      select 'B1 flag_sequence kolonu bulunamadı (M1 uygulanmış olabilir)' as why
       where not exists (select 1 from v_att)
  union all
      select 'B2 KATALOG BAĞIMLILIĞI: ' || obj from dep_named
  union all
      select 'B3 INDEX bağımlı: ' || obj from idx_dep
  union all
      select 'B4 CONSTRAINT bağımlı: ' || obj from con_dep
  union all
      select 'B5 kolon DEFAULT/GENERATED taşıyor' from v_att
       where atthasdef or attgenerated <> ''
  union all
      select 'B6 POLICY atıf yapıyor: ' || tbl || '.' || polname from pol_hit
  union all
      select 'B7 kolon-kapsamlı TRIGGER: ' || tgname from trg_all where col_scoped
  union all
      select 'B8 PUBLICATION KOLON LİSTESİ var (drop hata verir): ' || prattrs
        from pub_collist where prattrs is not null and prattrs <> ''
  union all
      select 'B9 BEKLENMEYEN fonksiyon gövdesi flag_sequence içeriyor: '
             || proname || '(' || args || ')'
        from fn_body_dep where not expected
  union all
      select 'B10 M1''in değiştireceği fonksiyon CANLIDA YOK: ' || m.name
        from m1_touch m where not exists (select 1 from fnx f where f.proname = m.name)
  union all
      -- B11a — GUEST rolündeki eski-istemci RPC'si: anon EXECUTE ŞART
      select 'B11a MİSAFİR-ÇAĞIRIR RPC yok/anon kapalı: ' || o.name || '  (' || o.why || ')'
        from old_client_fd o
       where o.rrole = 'GUEST'
         and not exists (select 1 from fnx f where f.proname = o.name and f.anon_eff)
  union all
      -- B11b — REGISTERED rolündeki eski-istemci RPC'si: authenticated ŞART.
      --        anon'un KAPALI olması BEKLENEN durumdur, bloker DEĞİLDİR.
      select 'B11b KAYITLI-ÇAĞIRIR RPC yok/authenticated kapalı: ' || o.name || '  (' || o.why || ')'
        from old_client_fd o
       where o.rrole = 'REGISTERED'
         and not exists (select 1 from fnx f where f.proname = o.name and f.auth_eff)
  union all
      select 'B12 LEGACY SHIM anon kapalı: ' || l.name
        from legacy_shim l
       where not exists (select 1 from fnx f where f.proname = l.name and f.anon_eff)
  union all
      select 'B13 MİSAFİR RPC''si anon kapalı: ' || g.name
        from guest_rpc g
       where not exists (select 1 from fnx f where f.proname = g.name and f.anon_eff)
  union all
      select 'B14 wheel_duel_queue authenticated SELECT KAYIP (M2 bunu korumalı)'
        from tbx where relname = 'wheel_duel_queue' and not auth_sel
  union all
      select 'B15 wheel_duel_player_claims authenticated INSERT KAYIP (eski istemci kırılır)'
        from tbx where relname = 'wheel_duel_player_claims' and not auth_ins
  union all
      select 'B16 P0 REGRESYON: wheel_duel_queue anon yazma açık'
        from tbx where relname = 'wheel_duel_queue' and (anon_ins or anon_upd or anon_del)
  union all
      select 'B17 P0 REGRESYON: ' || a.name || ' guest_id invariant''ı yok'
        from authz a
       where not exists (select 1 from fnx f where f.proname = a.name and f.prosrc ilike '%guest_id%')
  union all
      select 'B18 wheel_duel_queue anon SELECT yalnız PUBLIC''ten geliyor — '
             || 'M2''nin "revoke from anon" satırı ETKİSİZ kalır'
        from tbx where relname = 'wheel_duel_queue' and anon_sel and not anon_sel_d and pub_sel_d
  union all
      select 'B19 tevatur_create_room anon EXECUTE''u PUBLIC''ten geliyor — '
             || 'M2''nin "revoke from anon" satırı ETKİSİZ kalır'
        from fnx where proname = 'tevatur_create_room'
         and anon_eff and not anon_direct and public_direct
  union all
      select 'B20 GİZLİ SIRA TABLOSU realtime publication''da: ' || tablename
        from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename like '%\_room\_sequences'
  union all
      select 'B21 CLAIM-TOKEN tablosu realtime publication''da: ' || tablename
        from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename like '%\_player\_claims'
),

-- ══════════════════════════════════════════════════════════════════════════
-- RAPOR SATIRLARI
-- ══════════════════════════════════════════════════════════════════════════
report as (

  -- ── §0 KARAR ───────────────────────────────────────────────────────────
  select 0 as ord, '0 KARAR' as section,
         case when (select count(*) from blockers) = 0 then 'YES' else 'NO' end as status,
         'DEPLOY_READY' as object,
         'DEPLOY_READY = ' || case when (select count(*) from blockers) = 0 then 'YES' else 'NO' end
           || '   (bloker sayısı: ' || (select count(*) from blockers) || ')' as detail
  union all
  select 1, '0 KARAR', 'BLOCK', 'blocker', why from blockers

  -- ── §1 flag_sequence bağımlılıkları ───────────────────────────────────
  union all
  select 10, '1 DEPENDENCY',
         case when exists (select 1 from v_att) then 'OK' else 'BLOCK' end,
         'duel_rooms.flag_sequence',
         case when exists (select 1 from v_att)
              then 'kolon MEVCUT (attnum=' || (select attnum from v_att)
                   || ', default=' || (select atthasdef from v_att)
                   || ', generated=' || coalesce(nullif((select attgenerated from v_att), ''), 'hayır') || ')'
              else 'KOLON YOK' end
  union all
  select 11, '1 DEPENDENCY', 'DEP', 'pg_depend: ' || dep_kind, obj || '   [deptype=' || deptype || ']'
    from dep_named
  union all
  select 12, '1 DEPENDENCY',
         case when exists (select 1 from dep_named) then 'DEP' else 'OK' end,
         'pg_depend ÖZET',
         'kolona kayıtlı bağımlılık sayısı: ' || (select count(*) from dep_named)
         || '  → 0 ise view/matview/index/constraint/default/trigger/statistics/'
         || 'publication-kolon-listesi HİÇBİRİ kolona bağlı DEĞİL'
  union all
  select 13, '1 DEPENDENCY', case when exists (select 1 from idx_dep) then 'DEP' else 'OK' end,
         'INDEX', coalesce((select string_agg(obj, ', ') from idx_dep), 'kolonu kullanan indeks YOK')
  union all
  select 14, '1 DEPENDENCY', case when exists (select 1 from con_dep) then 'DEP' else 'OK' end,
         'CONSTRAINT', coalesce((select string_agg(obj, ', ') from con_dep), 'kolonu kullanan kısıt YOK')
  union all
  select 15, '1 DEPENDENCY', case when exists (select 1 from pol_hit) then 'DEP' else 'OK' end,
         'POLICY (TÜM tablolar)',
         coalesce((select string_agg(tbl || '.' || polname, ', ') from pol_hit),
                  'hiçbir RLS politikası flag_sequence''e atıf yapmıyor')
  union all
  select 16, '1 DEPENDENCY', case when col_scoped then 'DEP' else 'OK' end,
         'TRIGGER on duel_rooms',
         tgname || ' → ' || fn || case when col_scoped then '  [KOLON-KAPSAMLI]' else '  [tüm satır]' end
    from trg_all
  union all
  select 17, '1 DEPENDENCY', 'INFO', 'TRIGGER ÖZET',
         'duel_rooms üzerinde kullanıcı trigger''ı: ' || (select count(*) from trg_all)
  union all
  select 18, '1 DEPENDENCY',
         case when expected then 'OK' else 'BLOCK' end,
         'FUNCTION BODY (metin taraması)',
         proname || '(' || args || ')  anon=' || anon_eff || ' auth=' || auth_eff
         || case when expected then '  ← M1 bunu zaten değiştiriyor'
                 else '  ← BEKLENMEYEN: M1 kapsamına alınmalı' end
    from fn_body_dep
  union all
  select 19, '1 DEPENDENCY', 'INFO', 'ROWTYPE KULLANIMI',
         proname || '(' || args || ')  ' || how
         || '  → kolon düşünce satır şekli değişir (kırılmaz; PostgREST şema önbelleği yenilenir)'
    from fn_rowtype
  union all
  select 20, '1 DEPENDENCY',
         case when (select count(*) from pub_collist where prattrs is not null and prattrs <> '') > 0
              then 'BLOCK' else 'OK' end,
         'PUBLICATION KOLON LİSTESİ',
         coalesce((select 'prattrs=' || prattrs from pub_collist where prattrs is not null and prattrs <> ''),
                  'kolon listesi YOK (tüm tablo yayınlanıyor) → DROP COLUMN engellenmez')

  -- ── §2 flag_duel_* RPC envanteri ──────────────────────────────────────
  union all
  select 30, '2 FLAG_DUEL RPC',
         case when rrole = 'GUEST'      and not anon_eff then 'BLOCK'
              when rrole = 'REGISTERED' and not auth_eff then 'BLOCK'
              when rrole = 'REGISTERED' and anon_eff     then 'ADVISORY'
              when m1_touched then 'M1' else 'OK' end,
         proname || '(' || args || ')',
         'anon=' || anon_eff || ' auth=' || auth_eff
         || ' secdef=' || prosecdef || ' ' || sp
         || case when touches_col then '  [flag_sequence GÖVDEDE]' else '' end
         || case when rrole is not null then '  [ESKİ İSTEMCİ · rol=' || rrole || ']' else '' end
         || case when rrole = 'REGISTERED' and not anon_eff
                 then '  ✓ anon KAPALI = ÜRÜN KURALI GEREĞİ DOĞRU' else '' end
         || case when rrole = 'REGISTERED' and anon_eff
                 then '  ⚠ anon AÇIK ama gerekli değil (gövde auth.uid() ile gate''li) → yalnız rapor' else '' end
         || case when m1_touched  then '  [M1 create-or-replace edecek → grant KORUNUR]' else '' end
    from fd_rpc
  union all
  select 31, '2 FLAG_DUEL RPC',
         case when exists (select 1 from old_client_fd o
                            where (o.rrole = 'GUEST'
                                   and not exists (select 1 from fd_rpc f where f.proname = o.name and f.anon_eff))
                               or (o.rrole = 'REGISTERED'
                                   and not exists (select 1 from fd_rpc f where f.proname = o.name and f.auth_eff)))
              then 'BLOCK' else 'OK' end,
         'ESKİ İSTEMCİ UYUMU (rol-bazlı)',
         'GUEST rolü anon''a açık: '
         || (select count(*) from old_client_fd o where o.rrole='GUEST'
              and exists (select 1 from fd_rpc f where f.proname=o.name and f.anon_eff))
         || '/' || (select count(*) from old_client_fd where rrole='GUEST')
         || '  ·  REGISTERED rolü authenticated''a açık: '
         || (select count(*) from old_client_fd o where o.rrole='REGISTERED'
              and exists (select 1 from fd_rpc f where f.proname=o.name and f.auth_eff))
         || '/' || (select count(*) from old_client_fd where rrole='REGISTERED')
         || '  → M1 yalnız 3 fonksiyonu create-or-replace ediyor, imza/grant değişmiyor'
  union all
  -- REGISTERED olması gereken TÜM RPC'lerde gereksiz anon grant taraması
  select 33, '2 FLAG_DUEL RPC',
         case when f.anon_eff then 'ADVISORY' else 'OK' end,
         'registered-only: ' || f.proname,
         case when f.anon_eff
              then 'anon EXECUTE AÇIK (doğrudan=' || f.anon_direct || ', PUBLIC=' || f.public_direct || ') — '
                   || 'ürün kuralına göre GEREKSİZ; gövde auth.uid() gate''i taşıyor mu: '
                   || case when f.prosrc ilike '%auth.uid()%' then 'EVET (exploit değil)'
                           else '**HAYIR — İNCELE**' end
                   || '  → bu turda REVOKE EDİLMEZ, yalnız rapor'
              else 'anon EXECUTE kapalı ✓ (auth=' || f.auth_eff || ')' end
    from fnx f where f.proname in (select name from registered_only)
  union all
  select 32, '2 FLAG_DUEL RPC', 'INFO', 'M1 KAPSAMI',
         'M1 dokunacak: ' || (select string_agg(name, ', ') from m1_touch)
         || '  ·  flag_duel_next_flag diziyi PARAMETRE olarak alıyor (kolon okumuyor)'
         || '  ·  flag_duel_set_next_round / flag_duel_finalize_game DOKUNULMUYOR'

  -- ── §3 canlı odalar ───────────────────────────────────────────────────
  union all
  select 40, '3 LIVE ROOMS', 'INFO', 'ÖZET',
         'toplam duel_rooms=' || (select all_rooms from seq_rows)
         || ' · flag_sequence dolu=' || (select with_seq from seq_rows)
         || ' · playing+dizi dolu=' || (select playing_with_seq from seq_rows)
         || '  → M1 kopyalama adımı ' || (select with_seq from seq_rows) || ' satır taşıyacak'
  union all
  select 41, '3 LIVE ROOMS',
         case when seq_null and room_kind in ('flag', 'flag_duel') then 'WARN' else 'OK' end,
         'room ' || code || ' [' || coalesce(room_kind, 'null') || ']',
         'id=' || id
         || ' round=' || coalesce(current_round::text, '-') || '/' || coalesce(total_rounds::text, '-')
         || ' flag=' || coalesce(current_flag, '-')
         || ' seq=' || case when seq_null then 'NULL' else seq_len || ' bayrak' end
         || ' started=' || coalesce(started_at::text, '-')
         || case
              when not seq_null then '  → KOPYALANIR, maç kesintisiz sürer'
              when room_kind in ('flag', 'flag_duel') then '  → dizisi zaten YOK: bu oda bugün de legacy yolda (set_next_round); M1 durumu DEĞİŞTİRMEZ'
              else '  → Bayrak Düello odası DEĞİL (room_kind=' || coalesce(room_kind, 'null') || '), flag_sequence ile ilgisi yok'
            end
    from live_rooms
  union all
  select 42, '3 LIVE ROOMS', 'INFO', 'playing oda yok',
         'şu an status=playing hiçbir oda yok → M1 için en güvenli pencere'
   where not exists (select 1 from live_rooms)

  -- ── §4 M2 ön koşulları ────────────────────────────────────────────────
  union all
  select 50, '4 M2 PRECOND',
         case when anon_eff then 'READY' else 'NOOP' end,
         'tevatur_create_room',
         'anon effective=' || anon_eff || ' · anon DOĞRUDAN grant=' || anon_direct
         || ' · PUBLIC grant=' || public_direct
         || case when anon_eff and anon_direct then '  → "revoke execute from anon" ETKİLİ olur'
                 when anon_eff and not anon_direct then '  → DİKKAT: yetki PUBLIC''ten geliyor, PUBLIC de revoke edilmeli'
                 else '  → zaten kapalı, M2 satırı no-op' end
    from fnx where proname = 'tevatur_create_room'
  union all
  select 51, '4 M2 PRECOND',
         case when auth_sel and not (anon_ins or anon_upd or anon_del) then 'READY' else 'BLOCK' end,
         'wheel_duel_queue',
         'anon SELECT=' || anon_sel || ' (doğrudan=' || anon_sel_d || ')'
         || ' · authenticated SELECT=' || auth_sel
         || ' · anon I/U/D=' || anon_ins || '/' || anon_upd || '/' || anon_del
         || '  → M2 yalnız anon SELECT''i alır; authenticated SELECT KORUNUR'
    from tbx where relname = 'wheel_duel_queue'
  union all
  select 52, '4 M2 PRECOND',
         case when anon_ins then 'READY' else 'NOOP' end,
         'claim: ' || relname,
         'anon INSERT=' || anon_ins || ' (doğrudan=' || anon_ins_d || ', PUBLIC=' || pub_ins_d || ')'
         || ' · authenticated INSERT=' || auth_ins
         || case when relname = 'wheel_duel_player_claims'
                 then '  → authenticated INSERT KORUNMALI (eski+yeni istemci QM''de yazıyor)'
                 else '  → istemci hiç yazmıyor' end
    from tbx where relname in (select name from claim_tbl)
  union all
  select 53, '4 M2 PRECOND',
         case when exists (select 1 from tbx where relname = 'wheel_duel_player_claims' and auth_ins)
              then 'OK' else 'BLOCK' end,
         'wheel_duel_player_claims auth INSERT',
         'eski App Store istemcisi QM sonrası buraya yazıyor (WheelDuelGame.tsx:1386); '
         || 'başarısız olursa kullanıcıya hata gösteriyor → M2 buna DOKUNMAMALI'
  union all
  select 54, '4 M2 PRECOND',
         case when exists (select 1 from fnx f where f.proname = g.name and f.anon_eff)
              then 'OK' else 'BLOCK' end,
         'misafir RPC: ' || g.name,
         case when exists (select 1 from fnx f where f.proname = g.name and f.anon_eff)
              then 'anon EXECUTE AÇIK → misafir katılımı korunuyor'
              else 'anon EXECUTE KAPALI → misafir katılımı ZATEN BOZUK' end
    from guest_rpc g
  union all
  select 55, '4 M2 PRECOND',
         case when exists (select 1 from fnx f where f.proname = l.name and f.anon_eff)
              then 'OK' else 'BLOCK' end,
         'legacy shim: ' || l.name,
         case when exists (select 1 from fnx f where f.proname = l.name and f.anon_eff)
              then 'anon EXECUTE AÇIK → yayınlanmış bundle çalışmaya devam eder'
              else 'anon EXECUTE KAPALI → eski istemci KIRIK' end
    from legacy_shim l
  union all
  select 56, '4 M2 PRECOND',
         case when exists (select 1 from fnx f where f.proname = a.name and f.prosrc ilike '%guest_id%')
              then 'OK' else 'BLOCK' end,
         'P0 invariant: ' || a.name,
         case when exists (select 1 from fnx f where f.proname = a.name and f.prosrc ilike '%guest_id%')
              then 'guest_id invariant''ı gövdede (20260814180000 CANLIDA)'
              else 'guest_id invariant''ı YOK → P0 REGRESYON' end
    from authz a
  union all
  select 57, '4 M2 PRECOND',
         case when exists (select 1 from fnx f
                            where f.proname = 'wheel_duel_authorize_player'
                              and f.prosrc ilike '%wheel_duel_queue%')
              then 'OK' else 'BLOCK' end,
         'P0 köprü: wheel_duel_authorize_player',
         'gövdede wheel_duel_queue köprüsü '
         || case when exists (select 1 from fnx f where f.proname = 'wheel_duel_authorize_player'
                                and f.prosrc ilike '%wheel_duel_queue%') then 'VAR' else 'YOK' end

  -- ── §5 drift ──────────────────────────────────────────────────────────
  union all
  -- TOKEN SINIRLI eşleşme. ILIKE '%duel_rooms%' YANLIŞ POZİTİF verir çünkü
  -- 'wheel_duel_rooms' metni 'duel_rooms' alt dizesini İÇERİR. Sınır sınıfı
  -- [^a-z0-9_] 'wheel_duel_rooms'u eler, 'public.duel_rooms'u yakalar.
  select 60, '5 DRIFT',
         case when prosrc ~* '(^|[^a-z0-9_])duel_rooms([^a-z0-9_]|$)'
                or prosrc ~* '(^|[^a-z0-9_])flag_sequence([^a-z0-9_]|$)'
              then 'CHECK' else 'OK' end,
         proname || '(' || args || ')',
         'CANLIDA VAR, repoda gövdesi YOK (Studio dönemi) · anon=' || anon_eff
         || ' auth=' || auth_eff
         || ' · auth.uid() gate: ' || case when prosrc ilike '%auth.uid()%' then 'VAR' else '**YOK — İNCELE**' end
         || ' · gövdede TOKEN olarak duel_rooms/flag_sequence: '
         || case when prosrc ~* '(^|[^a-z0-9_])duel_rooms([^a-z0-9_]|$)'
                   or prosrc ~* '(^|[^a-z0-9_])flag_sequence([^a-z0-9_]|$)' then 'VAR' else 'YOK' end
         || ' (alt dize olarak: '
         || case when prosrc ilike '%duel_rooms%' then 'VAR — wheel_duel_rooms yanlış pozitifi' else 'yok' end
         || ')  → M1 bu fonksiyona DOKUNMUYOR, M2 hedef listesinde DEĞİL'
    from fnx where proname in ('wheel_duel_quick_match','wheel_duel_cancel_quick_match')
  union all
  select 61, '5 DRIFT', 'INFO', 'M1/M2 hedef listesi kanıtı',
         'M1 = {flag_duel_set_flag_sequence, flag_duel_advance_if_due, flag_duel_next_flag} '
         || '+ yeni tablo + duel_rooms.flag_sequence drop  ·  '
         || 'M2 = {tevatur_create_room, wheel_duel_queue.SELECT, 6 claim tablosu.INSERT}  ·  '
         || 'wheel_duel_quick_match / wheel_duel_cancel_quick_match İKİ LİSTEDE DE YOK'
  union all
  select 62, '5 DRIFT',
         case when exists (select 1 from pg_publication_tables
                            where pubname='supabase_realtime' and schemaname='public'
                              and tablename='duel_rooms') then 'CONFIRMED' else 'INFO' end,
         'duel_rooms @ supabase_realtime',
         case when exists (select 1 from pg_publication_tables
                            where pubname='supabase_realtime' and schemaname='public'
                              and tablename='duel_rooms')
              then 'PUBLICATION İÇİNDE → flag_sequence bugün her UPDATE payload''ında rakibe gidiyor; '
                   || 'kolon düşünce bu kanal da kapanır (repo hiçbir migration''da ADD TABLE etmiyor → Studio drift)'
              else 'publication DIŞINDA' end
  union all
  select 63, '5 DRIFT', 'INFO', 'supabase_realtime üyeleri',
         (select string_agg(tablename, ' ' order by tablename)
            from pg_publication_tables where pubname='supabase_realtime' and schemaname='public')
  union all
  select 64, '5 DRIFT',
         case when exists (select 1 from pg_publication_tables
                            where pubname='supabase_realtime' and schemaname='public'
                              and tablename in ('flag_group_room_sequences','wheel_duel_room_sequences',
                                                'wheel_group_room_sequences'))
              then 'BLOCK' else 'OK' end,
         'sequence tabloları realtime''da mı',
         'gizli sıra tabloları publication''a ASLA girmemeli → '
         || case when exists (select 1 from pg_publication_tables
                               where pubname='supabase_realtime' and schemaname='public'
                                 and tablename like '%\_room\_sequences')
                 then 'İÇERİDE (BLOKER)' else 'temiz' end

  -- ── §9 ortam ──────────────────────────────────────────────────────────
  union all
  select 90, '9 ENV', 'INFO', 'server', version()
  union all
  select 91, '9 ENV', 'INFO', 'roller',
         'anon=' || coalesce(to_regrole('anon')::text, 'YOK')
         || ' authenticated=' || coalesce(to_regrole('authenticated')::text, 'YOK')
         || ' current_user=' || current_user
)
select section, status, object, detail
  from report
 order by ord, object, detail;
