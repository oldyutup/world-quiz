-- ============================================================================
-- Hesap Silme — profiles BEFORE DELETE trigger (App Store hesap silme)
-- ============================================================================
-- MİMARİ
--   delete-account Edge Function'ı auth.admin.deleteUser(user_id, false)
--   çağırır → auth.users satırı silinir → public.profiles ON DELETE CASCADE
--   ile silinirken bu BEFORE DELETE trigger'ı AYNI PostgreSQL transaction'ı
--   içinde çalışır ve FK'sız oyun verilerini temizler/anonimleştirir.
--
--   ATOMİKLİK: Cascade silmeleri tetikleyen DELETE ile aynı transaction'da
--   koşar; trigger'daki HERHANGİ bir hata auth.users silmesi dahil TÜM
--   işlemi geri alır → "hesap aktif ama geçmiş yarım anonimleşmiş" durumu
--   OLUŞAMAZ. (profiles'ın kendi CASCADE zinciri — sosyal/DM/bildirim/gold/
--   XP/günlük görev/presence/kozmetik/başarım — burada tekrarlanmaz; onu
--   FK'lar hâlleder. Bu trigger yalnız FK'SIZ kalanları kapsar.)
--
--   GÜVENLİK: Fonksiyon SECURITY DEFINER (owner: postgres). Cascade DELETE
--   auth.users tarafında supabase_auth_admin rolüyle başlar; o rolün public
--   oyun tablolarında grant'ı olmadığı için definer şart. search_path = ''
--   (boş) — tüm tablolar public., built-in'ler pg_catalog. ile açıkça
--   nitelenir. Recursion yok: trigger auth.users/profiles'a DOKUNMAZ.
--
-- KAPSAM (OLD.id = silinen kullanıcının profiles.id / auth.users.id)
--   1) Matchmaking kuyrukları  — satır sil (conquest/country/flag/route +
--      wheel_duel_queue defansif: canlıda FK CASCADE'liyse no-op).
--   2) Claim token'ları        — 8 *_player_claims tablosundan, kullanıcının
--      player satırları üzerinden sil (bu tablolar profiles'tan CASCADE
--      ALMAZ; player satırları bilinçli korunduğu için açık silme şart).
--      NOT: duel_claims / flag_group_claims / route_duel_claims oyun-içi
--      cevap kayıtlarıdır, daily_quest_claims ödül defteridir (profiles FK
--      CASCADE) — bunlar erişim token'ı DEĞİLDİR, DOKUNULMAZ.
--   3) duel_messages           — SİLME YOK, yalnız görünen ad anonimleşir:
--      (a) sender_profile_id = OLD.id kesin eşleşmesi (20260804120000
--          sonrası mesajlar; odası silinmiş yetimleri de kapsar),
--      (b) eski mesajlar: kullanıcının player satırı + odanın gerçek chat
--          anahtarı + o satırın MEVCUT adı üzerinden oda-kapsamlı eşleşme.
--      Player satırı kalmamış eski yetim mesajlarda yalnız-username global
--      süpürme YAPILMAZ (yanlış misafire dokunma riski) — oldukları gibi
--      bırakılır.
--   4) Player satırları        — maç/skor kayıtları SİLİNMEZ; profile_id →
--      NULL, name → deterministik anonim ad ('Silinmiş#' + md5(satır id)
--      ilk 7 hex; tam 16 karakter → display-name uzunluk sözleşmesiyle uyumlu,
--      oda içinde diğer silinmiş oyunculardan ayırt edilir, eski kullanıcı
--      adı taşınmaz).
--   5) conquest_rooms host     — host_name (PII) anonim ad, host_profile_id
--      → NULL. Oda satırı/skorlar silinmez. Host yetkisi RPC'lerde
--      host_player_id + claim üzerinden yürür (conquest_authorize_host),
--      host_profile_id yalnız silinen kullanıcının kendi RLS yetkisinde
--      kullanılır → aktif odada NULL'lamak diğer oyuncuların akışını bozmaz.
--
-- SIRA ÖNEMLİ: mesaj anonimleştirmesi (3b) player satırlarının MEVCUT adına
-- ihtiyaç duyar → (3) her zaman (4)'ten önce koşar.
--
-- tevatur_players.profile_id NOT NULL → NULLABLE (aşağıda). Gerekçe:
--   • SQL tarafında hiçbir 'profile_id is [not] null' dallanması yok; tüm
--     kullanımlar eşitlik karşılaştırması (auth.uid() / v_uid) → NULL
--     fail-closed davranır (20260711/20260712/20260713/20260714 RPC+RLS
--     taraması).
--   • TS tarafı zaten null-toleranslı (KorNoktaGame/Mode 'p.profile_id ??
--     null' / '?? ""').
--   • Login-only invariant'ı INSERT eden RPC'ler korumaya devam eder
--     (tevatur_create_room/join_room her zaman auth.uid() yazar).
--   • Sabit/tombstone profile OLUŞTURULMAZ.
--
-- IDEMPOTENT: create or replace + drop trigger if exists. Trigger gövdesi
-- de idempotent (ikinci koşuşta eşleşen satır kalmaz).
-- ============================================================================

alter table public.tevatur_players
  alter column profile_id drop not null;

comment on column public.tevatur_players.profile_id is
  'auth.users.id — login-only mod: INSERT eden RPC''ler her zaman auth.uid() '
  'yazar (misafir yolu yok). NULL yalnız hesap silme anonimleştirmesinden '
  'sonra görülür (trg_account_deletion_cleanup).';


create or replace function public.account_deletion_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := old.id;
begin
  -- ── 1) Matchmaking kuyrukları ─────────────────────────────────────────
  -- route_duel_queue satırı claim_token da taşır → silinmesi token'ı da
  -- geçersizleştirir. wheel_duel_queue defansif: canlıda auth.users FK
  -- CASCADE'liyse bu delete no-op kalır, değilse açığı kapatır.
  delete from public.conquest_quick_match_queue where profile_id = v_uid;
  delete from public.country_duel_queue         where profile_id = v_uid;
  delete from public.flag_duel_queue            where profile_id = v_uid;
  delete from public.route_duel_queue           where profile_id = v_uid;
  delete from public.wheel_duel_queue           where profile_id = v_uid;

  -- ── 2) Claim / erişim token'ları (8 tablo) ────────────────────────────
  delete from public.duel_player_claims c
   using public.duel_players p
   where c.player_id = p.id and p.profile_id = v_uid;

  delete from public.duel_group_player_claims c
   using public.duel_group_players p
   where c.player_id = p.id and p.profile_id = v_uid;

  delete from public.wheel_duel_player_claims c
   using public.wheel_duel_players p
   where c.player_id = p.id and p.profile_id = v_uid;

  delete from public.wheel_group_player_claims c
   using public.wheel_group_players p
   where c.player_id = p.id and p.profile_id = v_uid;

  delete from public.conquest_player_claims c
   using public.conquest_players p
   where c.player_id = p.id and p.profile_id = v_uid;

  delete from public.tevatur_player_claims c
   using public.tevatur_players p
   where c.player_id = p.id and p.profile_id = v_uid;

  delete from public.flag_group_player_claims c
   using public.flag_group_players p
   where c.player_id = p.id and p.profile_id = v_uid;

  delete from public.route_duel_player_claims c
   using public.route_duel_players p
   where c.player_id = p.id and p.profile_id = v_uid;

  -- ── 3) duel_messages anonimleştirme (İSİMLERDEN ÖNCE) ─────────────────
  -- 3a) Kesin eşleşme: sender_profile_id (20260804120000 sonrası mesajlar).
  --     Yetim mesajları da kapsar; anonim ad odaya göre deterministik,
  --     kullanıcı adı taşımaz, odalar arası bağlantı kurdurmaz.
  update public.duel_messages
     set player_name       = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(v_uid::text || room_code), 1, 7),
         sender_profile_id = null
   where sender_profile_id = v_uid;

  -- 3b) Eski mesajlar: oda-kapsamlı (chat anahtarı + player satırının mevcut
  --     adı) eşleşme. Chat anahtarları gerçek send-message RPC'lerinden:
  --       duel / flag_duel            → duel_rooms.code            (çıplak)
  --       wheel_duel                  → wheel_duel_rooms.code      (çıplak)
  --       wheel_group                 → wheel_group_rooms.code     (çıplak)
  --       duel_group                  → duel_group_rooms.code      (çıplak)
  --       conquest                    → conquest_rooms.room_code   (çıplak)
  --       tevatur (Kör Nokta)         → tevatur_rooms.code VE
  --                                     code || '#<takım>' kanalları
  --       flag_group                  → 'flag_group:' || code
  --       route_duel                  → 'route_duel:' || code
  --     Oda içi isim tekilliği RPC guard'larıyla zorlandığından (name_taken
  --     + registered_username_taken) eşleşme başka kullanıcıya dokunmaz.
  --     Anonim ad player satırınınkiyle AYNI türetilir (md5(p.id)) → oda UI
  --     tutarlı kalır.
  update public.duel_messages m
     set player_name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(p.id::text), 1, 7)
    from public.duel_players p
    join public.duel_rooms r on r.id = p.room_id
   where p.profile_id = v_uid
     and m.room_code   = r.code
     and m.player_name = p.name;

  update public.duel_messages m
     set player_name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(p.id::text), 1, 7)
    from public.wheel_duel_players p
    join public.wheel_duel_rooms r on r.id = p.room_id
   where p.profile_id = v_uid
     and m.room_code   = r.code
     and m.player_name = p.name;

  update public.duel_messages m
     set player_name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(p.id::text), 1, 7)
    from public.wheel_group_players p
    join public.wheel_group_rooms r on r.id = p.room_id
   where p.profile_id = v_uid
     and m.room_code   = r.code
     and m.player_name = p.name;

  update public.duel_messages m
     set player_name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(p.id::text), 1, 7)
    from public.duel_group_players p
    join public.duel_group_rooms r on r.id = p.room_id
   where p.profile_id = v_uid
     and m.room_code   = r.code
     and m.player_name = p.name;

  update public.duel_messages m
     set player_name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(p.id::text), 1, 7)
    from public.conquest_players p
    join public.conquest_rooms r on r.id = p.room_id
   where p.profile_id = v_uid
     and m.room_code   = r.room_code
     and m.player_name = p.name;

  -- Tevatür: baz kanal + '#takım' kanalları (oda kodları [A-Z2-9] — LIKE
  -- joker karakteri içermez).
  update public.duel_messages m
     set player_name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(p.id::text), 1, 7)
    from public.tevatur_players p
    join public.tevatur_rooms r on r.id = p.room_id
   where p.profile_id = v_uid
     and (m.room_code = r.code or m.room_code like r.code || '#%')
     and m.player_name = p.name;

  update public.duel_messages m
     set player_name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(p.id::text), 1, 7)
    from public.flag_group_players p
    join public.flag_group_rooms r on r.id = p.room_id
   where p.profile_id = v_uid
     and m.room_code   = 'flag_group:' || r.code
     and m.player_name = p.name;

  update public.duel_messages m
     set player_name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(p.id::text), 1, 7)
    from public.route_duel_players p
    join public.route_duel_rooms r on r.id = p.room_id
   where p.profile_id = v_uid
     and m.room_code   = 'route_duel:' || r.code
     and m.player_name = p.name;

  -- ── 4) Player satırları: anonimleştir (maç/skor geçmişi KALIR) ────────
  update public.duel_players
     set name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7), profile_id = null
   where profile_id = v_uid;

  update public.duel_group_players
     set name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7), profile_id = null
   where profile_id = v_uid;

  update public.wheel_duel_players
     set name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7), profile_id = null
   where profile_id = v_uid;

  update public.wheel_group_players
     set name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7), profile_id = null
   where profile_id = v_uid;

  update public.conquest_players
     set name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7), profile_id = null
   where profile_id = v_uid;

  update public.tevatur_players
     set name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7), profile_id = null
   where profile_id = v_uid;

  update public.flag_group_players
     set name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7), profile_id = null
   where profile_id = v_uid;

  update public.route_duel_players
     set name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7), profile_id = null
   where profile_id = v_uid;

  -- ── 5) conquest_rooms host bilgisi ────────────────────────────────────
  -- host_player_id varsa hash onun üzerinden → (4)'te anonimleşen player
  -- satırıyla aynı ada denk gelir (oda UI tutarlılığı).
  update public.conquest_rooms
     set host_name       = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(coalesce(host_player_id, id)::text), 1, 7),
         host_profile_id = null
   where host_profile_id = v_uid;

  return old;
end;
$$;

revoke all on function public.account_deletion_cleanup() from public, anon, authenticated;

drop trigger if exists trg_account_deletion_cleanup on public.profiles;
create trigger trg_account_deletion_cleanup
  before delete on public.profiles
  for each row
  execute function public.account_deletion_cleanup();


-- ============================================================================
-- DOĞRULAMA (manuel — Studio SQL editor)
-- ----------------------------------------------------------------------------
--   -- Trigger kurulu mu?
--   select tgname, tgenabled from pg_trigger
--    where tgrelid = 'public.profiles'::regclass
--      and tgname = 'trg_account_deletion_cleanup';   -- 1 satır
--
--   -- Fonksiyon SECURITY DEFINER mı?
--   select proname, prosecdef from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'account_deletion_cleanup';      -- prosecdef = true
--
--   -- tevatur_players.profile_id nullable oldu mu?
--   select is_nullable from information_schema.columns
--    where table_schema='public' and table_name='tevatur_players'
--      and column_name='profile_id';                  -- YES
--
-- Kapsamlı davranış testi: supabase/tests/account_deletion_test.sql
-- (fixture + atomiklik/rollback kanıtı; canlıda DEĞİL, lokal/staging'de koş).
-- ============================================================================
