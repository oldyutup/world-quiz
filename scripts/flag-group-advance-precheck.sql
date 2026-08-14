-- ============================================================================
-- BAYRAK GRUP host-SPOF + geriye uyumluluk + griefing fix
--   PRODUCTION PRECHECK (SALT OKUNUR)
-- ============================================================================
-- Bu dosya bir migration DEĞİLDİR ve KASTEN supabase/migrations/ DIŞINDADIR
-- (CLI yanlışlıkla uygulamasın). 20260814170000_flag_group_advance_if_due.sql
-- CANLIYA UYGULANMADAN ÖNCE Supabase SQL Editor'de çalıştırılır. Hiçbir satır
-- YAZMAZ / DEĞİŞTİRMEZ / SİLMEZ — yalnız `select` yapar.
--
-- AMAÇ: repo ile canlı şema arasında DRIFT olup olmadığını kanıtlamak. Çark'ta
-- öğrenilen ders: canlıdaki gövde repodakinden farklı olabilir. Beklenen
-- değerler tutmuyorsa MIGRATION UYGULANMAZ, önce fark incelenir.
--
-- BU MIGRATION HİÇBİR ŞEYİ DROP/REVOKE ETMEZ. Eski istemci (App Store'da
-- güncellenmemiş sürüm) migration'dan SONRA da Bayrak Grup oynayabilir:
--   • flag_group_advance_flag   → yaşıyor (shim), imza/dönüş/host-only/round_active AYNI
--   • flag_group_start_game     → yaşıyor, imza AYNI
--   • flag_group_finalize_game  → yaşıyor, imza/dönüş AYNI (erken çağrı artık no-op)
-- ============================================================================

-- ── 1) Ön koşul: dokunacağımız fonksiyonlar canlıda var mı, imzaları ne? ─────
-- BEKLENEN: 4 satır, hepsi prosecdef=true, config='search_path=public, auth'
--   flag_group_advance_flag    (p_room_id uuid, p_host_player_id uuid, p_claim_token uuid, p_flag_seq integer, p_next_flag text)
--   flag_group_finalize_game   (p_room_id uuid, p_player_id uuid, p_claim_token uuid)
--   flag_group_set_next_round  (p_room_id uuid, p_host_player_id uuid, p_claim_token uuid, p_next_round integer, p_next_flag text)
--   flag_group_start_game      (p_room_id uuid, p_host_player_id uuid, p_claim_token uuid, p_first_flag text)
-- İMZA FARKLIYSA `create or replace` YENİ bir aşırı yükleme (overload) yaratır →
-- İKİ sürüm birden yaşar ve PostgREST hangisini çağıracağını bilemez. DUR.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef                               as security_definer,
       array_to_string(p.proconfig, ',')          as config
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('flag_group_advance_flag',
                     'flag_group_start_game',
                     'flag_group_finalize_game',
                     'flag_group_set_next_round')
 order by p.proname;


-- ── 2) Canlı gövdeler repodakiyle AYNI mı? (drift kanıtı) ───────────────────
-- BEKLENEN (repodaki 20260731120000 uygulanmış clean-room'dan ÖLÇÜLDÜ,
-- uydurma DEĞİL — 2026-08-14):
--   flag_group_advance_flag   → b8653a35c19311463a71b635fa2a43bb  (len 4384)
--   flag_group_start_game     → 9f732aff029cfc2c2d19023591f297ae  (len 1829)
--   flag_group_finalize_game  → e99587dd214035905de3fe6ee9b56ab4  (len 1321)
-- md5 TUTMUYORSA canlıda repodan FARKLI bir gövde var → migration onu SESSİZCE
-- EZER. DUR ve önce farkı oku:  select prosrc from pg_proc where …
select p.proname,
       md5(p.prosrc)      as body_md5,
       length(p.prosrc)   as body_len
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('flag_group_advance_flag',
                     'flag_group_start_game',
                     'flag_group_finalize_game')
 order by p.proname;


-- ── 3) Çakışma kontrolü: eklenecek adlar canlıda ZATEN var mı? ──────────────
-- BEKLENEN: 0 satır. Satır dönerse ad çakışması var → migration mevcut bir
-- nesneyi ezecek demektir. DUR.
select 'table' as kind, c.relname as name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('flag_group_flag_catalog', 'flag_group_room_sequences')
union all
select 'function', p.proname
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('flag_group_advance_core',
                     'flag_group_advance_if_due',
                     'flag_group_generate_sequence',
                     'flag_group_ensure_sequence',
                     'flag_group_next_flag',
                     'flag_group_progression_tier_weights',
                     'flag_group_flag_timeout_seconds',
                     'flag_group_reveal_delay_ms');


-- ── 4) Bağımlılıklar canlıda var mı? ────────────────────────────────────────
-- BEKLENEN: flag_seq kolonu 3 tabloda da VAR (rooms/claims/pass_votes) →
-- 20260731120000 CANLIDA UYGULANMIŞ. Eksikse ÖNCE o migration uygulanmalı.
select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and column_name = 'flag_seq'
   and table_name like 'flag_group_%'
 order by table_name;

-- BEKLENEN: 2 satır (authorize_player + authorize_host).
select proname
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('flag_group_authorize_player', 'flag_group_authorize_host')
 order by proname;


-- ── 5) MEVCUT yetki durumu (migration ÖNCESİ fotoğraf) ─────────────────────
-- BEKLENEN (migration ÖNCESİ):
--   advance_flag    → anon=true,  auth=true
--   finalize_game   → anon=true,  auth=true
--   start_game      → anon=true,  auth=true
--   set_next_round  → anon=false, auth=false   (20260731120000 zaten revoke etti)
-- ÖNEMLİ: migration SONRASI ilk üçü TRUE KALMALI (eski istemci bozulmasın).
select 'advance_flag' as fn,
       has_function_privilege('anon',
         'public.flag_group_advance_flag(uuid,uuid,uuid,int,text)', 'execute') as anon_can,
       has_function_privilege('authenticated',
         'public.flag_group_advance_flag(uuid,uuid,uuid,int,text)', 'execute') as auth_can
union all
select 'finalize_game',
       has_function_privilege('anon',
         'public.flag_group_finalize_game(uuid,uuid,uuid)', 'execute'),
       has_function_privilege('authenticated',
         'public.flag_group_finalize_game(uuid,uuid,uuid)', 'execute')
union all
select 'start_game',
       has_function_privilege('anon',
         'public.flag_group_start_game(uuid,uuid,uuid,text)', 'execute'),
       has_function_privilege('authenticated',
         'public.flag_group_start_game(uuid,uuid,uuid,text)', 'execute')
union all
select 'set_next_round',
       has_function_privilege('anon',
         'public.flag_group_set_next_round(uuid,uuid,uuid,int,text)', 'execute'),
       has_function_privilege('authenticated',
         'public.flag_group_set_next_round(uuid,uuid,uuid,int,text)', 'execute');


-- ── 6) UYGULAMA ANI RİSKİ: o an OYNANAN oda var mı? ────────────────────────
-- BEKLENEN: ideal olarak 0 satır. Satır varsa o maçlar geçiş anında etkilenir.
-- RİSK DÜŞÜKTÜR (hiçbir RPC kaldırılmadığı için eski istemci çalışmaya devam
-- eder) ama devam eden maçta sıra satırı YOKTUR: `ensure_sequence` `used`
-- dizisini mevcut claim'lerden tohumlar → görülmüş bayrak tekrar GELMEZ.
-- Yine de TRAFİĞİN DÜŞÜK OLDUĞU bir anda uygulamak en güvenlisidir.
select id, code, status, current_round, total_rounds, flag_seq, game_seq,
       current_flag, current_flag_at, started_at
  from public.flag_group_rooms
 where status = 'playing'
 order by started_at desc;

select count(*) as playing_players
  from public.flag_group_players
 where status = 'playing';


-- ── 7) DOKUNULMAYANLAR gerçekten dokunulmamış mı? (kapsam kanıtı) ──────────
-- Migration yalnız advance_flag / start_game / finalize_game'i REPLACE eder;
-- başka hiçbir flag_group_* RPC'sine DOKUNMAZ ve başka mod adı (wheel_/duel_/
-- conquest_/kornokta_) migration'da hiç GEÇMEZ.
-- ── MUTLAK SAYIM KULLANMA (bir kez yanılttı) ───────────────────────────────
-- Eskiden burada `count(*) … like 'flag_group_%'` vardı ve "clean-room 17 =
-- canlı 17" beklenirdi. Canlı 18 döndü ve bu DRIFT sanıldı. DRIFT DEĞİLDİ:
-- fark yalnızca `flag_group_send_message` (canonical repo'da 20260729120000
-- oluşturur, 20260804120000 gövdesini günceller). Clean-room zinciri onu
-- KASTEN uygulamaz — 20260729120000 `duel_messages`e, 20260804120000 DOKUZ
-- modun tablosuna bağlı; flag_group-kapsamlı clean-room'a tüm çok-oyunculu
-- şemayı sürüklemek gerekirdi. Yani doğru beklenen değerler ŞÖYLE:
--   canonical repo (= canlı):  önce 18 → sonra 26
--   clean-room zinciri:        önce 17 → sonra 25   (fark: send_message)
-- Bu eşitlik `scripts/check-flag-group-advance-if-due.ts` C4 bölümünde
-- repo migration'larından TÜRETİLEREK kilitlenmiştir.
--
-- Mutlak sayım kırılgandır: flag_group'a ilgisiz bir fonksiyon eklenmesi
-- (mesaj, moderasyon, cleanup…) bu migration'la HİÇ ilgisi olmadığı hâlde
-- prechecki düşürür. Onun yerine AŞAĞIDAKİ KESİN kontroller kullanılır.

-- 7a) REPLACE edilecek 3 RPC — imza + gövde md5 (§1 ve §2 ile aynı kanıt,
--     burada tek satırda özetlenir). BEKLENEN: 3 satır, md5'ler §2'deki gibi.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       md5(p.prosrc)                             as body_md5
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('flag_group_advance_flag',
                     'flag_group_start_game',
                     'flag_group_finalize_game')
 order by p.proname;

-- 7b) MEVCUT OLMASI GEREKEN 18 fonksiyonun HEPSİ duruyor mu?
--     BEKLENEN: 0 satır (hiçbiri eksik değil). Satır dönerse migration
--     öncesi canlı şema zaten eksik demektir → DUR.
select expected.name as missing_function
  from (values ('flag_group_advance_flag'),
               ('flag_group_authorize_host'),
               ('flag_group_authorize_player'),
               ('flag_group_create_room'),
               ('flag_group_finalize_game'),
               ('flag_group_heartbeat'),
               ('flag_group_join_room'),
               ('flag_group_kick_player'),
               ('flag_group_leave_room'),
               ('flag_group_return_to_lobby'),
               ('flag_group_rooms_cleanup_after_player_delete'),
               ('flag_group_send_message'),
               ('flag_group_set_next_round'),
               ('flag_group_set_updated_at'),
               ('flag_group_start_game'),
               ('flag_group_submit_claim'),
               ('flag_group_toggle_pass_vote'),
               ('flag_group_update_settings')) as expected(name)
 where not exists (select 1 from pg_proc p
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname = expected.name);

-- 7c) BEKLENMEYEN bir flag_group fonksiyonu var mı? (gerçek drift sinyali —
--     sayıya değil, ADA bakar). BEKLENEN: 0 satır.
--     NOT: migration SONRASI bu sorgu 8 YENİ adı döndürür; o beklenendir
--     (advance_core, advance_if_due, ensure_sequence, flag_timeout_seconds,
--      generate_sequence, next_flag, progression_tier_weights, reveal_delay_ms).
select p.proname as unexpected_function,
       pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname like 'flag_group_%'
   and p.proname not in ('flag_group_advance_flag',
                         'flag_group_authorize_host',
                         'flag_group_authorize_player',
                         'flag_group_create_room',
                         'flag_group_finalize_game',
                         'flag_group_heartbeat',
                         'flag_group_join_room',
                         'flag_group_kick_player',
                         'flag_group_leave_room',
                         'flag_group_return_to_lobby',
                         'flag_group_rooms_cleanup_after_player_delete',
                         'flag_group_send_message',
                         'flag_group_set_next_round',
                         'flag_group_set_updated_at',
                         'flag_group_start_game',
                         'flag_group_submit_claim',
                         'flag_group_toggle_pass_vote',
                         'flag_group_update_settings')
 order by p.proname;

-- 7d) set_next_round imzası — 20260731120000'in revoke ettiği TAM imza mı?
--     BEKLENEN: 1 satır, args = 'p_room_id uuid, p_host_player_id uuid,
--     p_claim_token uuid, p_next_round integer, p_next_flag text'
select pg_get_function_identity_arguments(p.oid) as set_next_round_args
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname = 'flag_group_set_next_round';

-- Aşırı yükleme oluşmadı mı? BEKLENEN: üçü de 1.
select proname, count(*) as overloads
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('flag_group_advance_flag', 'flag_group_start_game', 'flag_group_finalize_game')
 group by proname order by proname;

-- 7e) Dokunulmayan 9 RPC'nin gövde parmak izi.
-- Bu 9'luk küme KASTEN clean-room'da da bulunan RPC'lerdir; beklenen sabit
-- (f3c8…) orada ÖLÇÜLEBİLDİĞİ için buraya yazılabiliyor. `send_message` ve
-- trigger/authorize yardımcıları bu kümede DEĞİL — onlar 7f'de ÖNCE/SONRA
-- karşılaştırmasıyla korunur (sabit beklenen değer olmadan).
select md5(string_agg(md5(prosrc), ',' order by proname || pg_get_function_identity_arguments(oid)))
         as untouched_rpc_fingerprint
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('flag_group_submit_claim',
                   'flag_group_toggle_pass_vote',
                   'flag_group_return_to_lobby',
                   'flag_group_leave_room',
                   'flag_group_kick_player',
                   'flag_group_join_room',
                   'flag_group_create_room',
                   'flag_group_update_settings',
                   'flag_group_heartbeat');
-- Bu parmak izini NOT AL; migration'dan SONRA aynı sorguyu koş → AYNI çıkmalı.
-- Clean-room'da bu eşitlik DOĞRULANDI: önce ve sonra
--   f3c8912adaf7c5004a037025c43ea393
-- (canlıdaki değer farklı olabilir — önemli olan ÖNCE == SONRA olması).

-- 7f) 9'luk kümenin DIŞINDA kalan, yine de dokunulMAMASI gereken nesneler:
--     send_message + set_next_round + trigger/authorize yardımcıları.
--     Bu parmak izinin beklenen sabiti YOKTUR (clean-room'da send_message
--     bulunmadığı için orada ölçülemez) — kural basit: NOT AL, migration'dan
--     SONRA tekrar koş, ÖNCE == SONRA olmalı.
select md5(string_agg(md5(prosrc), ',' order by proname || pg_get_function_identity_arguments(oid)))
         as untouched_extras_fingerprint
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('flag_group_send_message',
                   'flag_group_set_next_round',
                   'flag_group_authorize_host',
                   'flag_group_authorize_player',
                   'flag_group_set_updated_at',
                   'flag_group_rooms_cleanup_after_player_delete');


-- ============================================================================
-- MIGRATION SONRASI DOĞRULAMA (uygulandıktan SONRA koşulacak — yine salt okunur)
-- ============================================================================
-- ── GERİYE UYUMLULUK (EN KRİTİK — eski istemci hâlâ oynayabilmeli) ──
-- select has_function_privilege('anon','public.flag_group_advance_flag(uuid,uuid,uuid,int,text)','execute');
--   → TRUE  (revoke EDİLMEMELİ)
-- select has_function_privilege('anon','public.flag_group_start_game(uuid,uuid,uuid,text)','execute');
--   → TRUE
-- select has_function_privilege('anon','public.flag_group_finalize_game(uuid,uuid,uuid)','execute');
--   → TRUE
--
-- ── YENİ YOL + GİZLİLİK ──
-- select has_function_privilege('anon','public.flag_group_advance_if_due(uuid,uuid,uuid,int)','execute');
--   → TRUE  (misafir oynayabilmeli)
-- select has_function_privilege('anon','public.flag_group_advance_core(uuid,int,boolean)','execute');
--   → FALSE (paylaşılan otomat PRIVATE)
-- select has_table_privilege('anon','public.flag_group_room_sequences','select'),
--        has_table_privilege('anon','public.flag_group_flag_catalog','select');
--   → her ikisi de FALSE (gelecek bayraklar sızmaz)
-- select count(*) from pg_publication_tables where pubname='supabase_realtime'
--    and tablename in ('flag_group_room_sequences','flag_group_flag_catalog');
--   → 0
-- select region, count(*) from public.flag_group_flag_catalog group by 1 order by 1;
--   → africa=54 asia=47 europe=46 north_america=23 oceania=14 south_america=12 world=196
--
-- ── CANLI SMOKE (tek oda; host'u KASTEN sustur) ──
--   select * from flag_group_start_game('<room>','<HOST>','<tok>', 'zz');
--     -- 'zz' YOK SAYILIR; current_flag sunucu dizisinden gelir.
--   select * from flag_group_advance_flag('<room>','<HOST>','<tok>', <fs>, 'tr');
--     -- 'tr' YOK SAYILIR; canonical sıradaki bayrak gelir (eski istemci başarılı yanıt alır).
--   select * from flag_group_finalize_game('<room>','<ÜYE>','<tok>');
--     -- maçın ortasında → oda DEĞİŞMEDEN döner (status hâlâ 'playing').
-- ============================================================================
