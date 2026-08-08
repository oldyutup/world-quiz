-- ============================================================================
-- Misafir kuralının tamamlanması — Kuşatma "Odalara Göz At" yetkisi
--                                  + Kör Nokta misafir katılımı
-- ============================================================================
-- ÜRÜN KURALI (20260808120000'in devamı; o dosyanın sözleşmesini GENİŞLETİR)
-- -------------------------------------------------------------------------
--   KAYITLI oyuncu : oda kurar, AÇIK ODA LİSTESİNİ GÖRÜR, Hızlı Eşleş
--                    kullanır, XP/altın/görev kazanır.
--   MİSAFİR oyuncu : YALNIZ kayıtlı birinin verdiği oda kodu / davet
--                    bağlantısıyla BELİRLİ bir odaya katılır. Oda kuramaz,
--                    açık oda listesini GÖREMEZ, Hızlı Eşleş'e giremez,
--                    kalıcı ilerleme yazamaz.
--
-- Bu migration iki boşluğu kapatır:
--
--   A) Kuşatma "Odalara Göz At" hiçbir SUNUCU kontrolüne sahip değildi.
--      Liste, istemciden doğrudan `conquest_rooms` tablosuna atılan bir
--      PostgREST sorgusuyla geliyordu; tek engel React tarafındaki
--      `isLoggedIn` bayrağıydı. Artık liste yalnız `authenticated`a açık bir
--      SECURITY DEFINER RPC'den gelir ve misafir çağırırsa `auth_required`
--      hatası alır (sessiz boş liste DEĞİL).
--
--   B) Kör Nokta misafire tamamen kapalıydı. Kapalılığın sebebi bir güvenlik
--      kararı değil, ŞEMA idi: `tevatur_players.profile_id` NOT NULL ve
--      `tevatur_authorize_player` yalnız `profile_id = auth.uid()` kabul
--      ediyordu. Bu migration modu diğer yedi modun ZATEN kullandığı
--      (profile_id XOR guest_id + claim_token) desenine hizalar.
--
--
-- BAĞIMLILIK — SIRA ÖNEMLİ
-- ------------------------
--   20260711120000_tevatur_init.sql            (tevatur_* tabloları)
--   20260714120000_kornokta_teams_schema.sql   (tevatur_join_room son hâli)
--   20260716120000_username_key_system.sql     (username_key)
--   20260806120000_ugc_safety_reports_moderation.sql (assert_display_name_allowed)
--   20260808120000_guest_room_join.sql         (assert_display_name_allowed
--                                               son hâli + link_guest_player)
--
-- Bu dosya 20260808120000'DEN SONRA çalıştırılmalıdır.
--
-- IDEMPOTENT: create or replace / if not exists / drop policy if exists /
-- revoke + grant → tekrar çalıştırılabilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0) ÖN KOŞUL DENETİMİ — yanlış sırada çalıştırmaya karşı koruma
-- ----------------------------------------------------------------------------
-- 20260808120000'deki desenin aynısı: eksik bağımlılıkta CREATE komutları
-- sessizce başarılı olur ama fonksiyon ÇAĞRILDIĞINDA patlar (PL/pgSQL geç
-- bağlama). Bu blok o sessiz felaketi baştan durdurur.
-- ────────────────────────────────────────────────────────────────────────────

do $pre$
declare
  v_missing text[] := '{}';
begin
  if to_regprocedure('public.assert_display_name_allowed(text,uuid,text)') is null then
    v_missing := v_missing || 'public.assert_display_name_allowed(text,uuid,text)  [20260806120000 + 20260808120000]';
  end if;
  if to_regprocedure('public.username_key(text)') is null then
    v_missing := v_missing || 'public.username_key(text)  [20260716120000]';
  end if;
  if to_regprocedure('public.torble_link_guest_player(text,uuid,uuid)') is null then
    v_missing := v_missing || 'public.torble_link_guest_player(text,uuid,uuid)  [20260808120000]';
  end if;
  if to_regclass('public.tevatur_players') is null then
    v_missing := v_missing || 'public.tevatur_players  [20260711120000]';
  end if;
  if to_regclass('public.conquest_rooms') is null then
    v_missing := v_missing || 'public.conquest_rooms  [20260523120000]';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception
      'ÖN KOŞUL EKSİK — bu migration çalıştırılamaz. Eksik nesneler: %. Önce ilgili migration(lar)ı uygula.',
      array_to_string(v_missing, ' | ');
  end if;
end
$pre$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ BÖLÜM A — KUŞATMA: açık oda listesi yalnız kayıtlı kullanıcıya            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ────────────────────────────────────────────────────────────────────────────
-- A1) conquest_list_public_rooms — YETKİLİ liste uç noktası
-- ----------------------------------------------------------------------------
-- ÖNCESİ: istemci `conquest_rooms` tablosunu doğrudan sorguluyordu
--   (.eq('visibility','public').eq('status','waiting')...), ardından
--   `conquest_players` üzerinden oyuncu sayılarını çekiyordu. Sunucu tarafında
--   "kimin listeleyebileceği" sorusunu SORAN hiçbir kontrol yoktu.
--
-- SONRASI: liste tek bir SECURITY DEFINER RPC'den gelir ve fonksiyon ilk
-- satırında auth.uid()'yi kontrol eder. Misafir çağırırsa:
--   • BOŞ LİSTE DÖNMEZ (yetkiyi sessizce gizlemek kullanıcıyı da geliştiriciyi
--     de yanıltır),
--   • `auth_required` (42501) hatası fırlatır — istemci bunu net bir
--     "giriş yap" ekranına çevirir.
--
-- Ayrıca `anon` EXECUTE grant'i hiç verilmez → PostgREST çağrıyı zaten
-- fonksiyon gövdesine ulaşmadan reddeder. İki katman kasıtlıdır: grant
-- yanlışlıkla geri verilse bile gövdedeki kontrol ayakta kalır.
--
-- Liste mantığı istemcideki ile BİREBİR aynı tutulur (davranış değişmesin):
--   • visibility = 'public' ve status = 'waiting'
--   • son 6 saat içinde güncellenmiş
--   • yalnız SON 60 SANİYEDE heartbeat atmış (aktif) oyuncular sayılır
--   • aktif oyuncusu kalmamış VEYA dolmuş odalar listelenmez
--   • en fazla 50 oda, updated_at azalan
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_list_public_rooms()
returns table (
  id               uuid,
  room_code        text,
  host_profile_id  uuid,
  host_player_id   uuid,
  host_name        text,
  status           text,
  map_id           text,
  max_players      int,
  round_count      int,
  visibility       text,
  team_mode        text,
  created_at       timestamptz,
  updated_at       timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  player_count     int
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  -- ÜRÜN KURALI: açık oda listesi yalnız kayıtlı kullanıcıya.
  if auth.uid() is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  return query
  with active_counts as (
    select p.room_id, count(*)::int as cnt
      from public.conquest_players p
     where p.last_seen_at >= now() - interval '60 seconds'
     group by p.room_id
  )
  select
    r.id,
    r.room_code,
    r.host_profile_id,
    r.host_player_id,
    r.host_name,
    r.status,
    r.map_id,
    r.max_players,
    r.round_count,
    r.visibility,
    r.team_mode,
    r.created_at,
    r.updated_at,
    r.started_at,
    r.finished_at,
    c.cnt
  from public.conquest_rooms r
  join active_counts c on c.room_id = r.id
  where r.visibility = 'public'
    and r.status     = 'waiting'
    and r.updated_at >= now() - interval '6 hours'
    and c.cnt > 0
    and c.cnt < r.max_players
  order by r.updated_at desc
  limit 50;
end
$$;

revoke all     on function public.conquest_list_public_rooms() from public;
-- anon KASTEN YOK.
grant  execute on function public.conquest_list_public_rooms() to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- A2) conquest_find_room_by_code — TEK oda çözümleme (misafire açık)
-- ----------------------------------------------------------------------------
-- "Oda Koduyla Katıl" misafire AÇIK kalmalıdır; ancak bunu yaparken tüm
-- odaları listeleyen bir yol açılmamalıdır. Bu fonksiyon adı üstünde tek bir
-- kodu çözer:
--   • Kod tam 6 karakter olmalı, aksi hâlde satır DÖNMEZ.
--   • En fazla BİR satır döner (room_code unique).
--   • Filtresiz çağrılamaz — p_code zorunludur.
--
-- Yani misafir "bildiği kodu" doğrulayabilir ama kod HAVUZUNU tarayamaz.
-- Yeni bilgi açmaz: aynı bilgiyi katılma akışı zaten döndürüyordu.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_find_room_by_code(p_code text)
returns public.conquest_rooms
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_norm text;
  v_room public.conquest_rooms;
begin
  if p_code is null then
    return null;
  end if;

  v_norm := upper(regexp_replace(btrim(p_code), '[^A-Za-z0-9]', '', 'g'));

  if length(v_norm) <> 6 then
    return null;
  end if;

  select * into v_room
    from public.conquest_rooms
   where room_code = v_norm
   limit 1;

  -- DİKKAT: `return v_room` burada YETMEZ. PL/pgSQL'de SELECT INTO hiçbir satır
  -- bulamazsa v_room "hepsi NULL alanlardan oluşan bir kayıt" olur; bunu
  -- döndürmek PostgREST'e SQL NULL değil {"id":null,...} nesnesi gönderir.
  -- İstemcideki `if (!roomData)` kontrolü o nesneyi DOLU sanar ve "oda
  -- bulunamadı" yerine anlaşılmaz bir hatayla katılmayı dener. FOUND ile açıkça
  -- NULL döndürüyoruz.
  if not found then
    return null;
  end if;

  return v_room;
end
$$;

revoke all     on function public.conquest_find_room_by_code(text) from public;
grant  execute on function public.conquest_find_room_by_code(text) to anon, authenticated;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ BÖLÜM B — KÖR NOKTA: misafir katılımı                                     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- KÖR NOKTA NEDEN MİSAFİRE KAPALIYDI? (gerçek sebep)
-- ---------------------------------------------------
-- Bir güvenlik kararı değil, en eski mod olmasının ŞEMA mirasıydı:
--
--   1. `tevatur_players.profile_id uuid NOT NULL` — misafir satırı fiziksel
--      olarak yazılamıyordu; `guest_id` kolonu hiç yoktu.
--   2. `tevatur_authorize_player` YALNIZ `p.profile_id = auth.uid()` kabul
--      ediyordu; claim_token ikincil bir faktördü. Misafirin auth.uid()'si
--      olmadığı için TÜM oyun RPC'leri (tahmin, cevap, faz ilerletme, mesaj…)
--      onu reddederdi.
--   3. `tevatur_join_room` oyuncu adını `profiles.username`den okuyordu —
--      istemci ad GÖNDERMİYORDU. Profili olmayan bir oyuncunun adı yoktu.
--   4. Tüm tevatur_* RPC'lerinin grant'i yalnız `authenticated` idi.
--
-- Bu dört maddenin hiçbiri "misafir katılırsa şu kötü şey olur" demiyor;
-- hepsi "misafir kavramı bu modda hiç modellenmemiş" diyor. Diğer yedi mod
-- (duel / flag / wheel / route / conquest) profile_id XOR guest_id +
-- claim_token desenini zaten kullanıyor. Bu bölüm Kör Nokta'yı o desene
-- hizalar — YENİ bir katılma sistemi kurmaz.
--
-- DEĞİŞMEYEN (kasıtlı):
--   • `tevatur_create_room` → yalnız `authenticated`. Misafir oda KURAMAZ.
--   • `award_kornokta_xp_event` → yalnız `authenticated` + auth.uid() =
--     p_profile_id. Misafire XP/altın YAZILAMAZ.


-- ────────────────────────────────────────────────────────────────────────────
-- B1) tevatur_players — misafir kimliği için şema
-- ----------------------------------------------------------------------------
-- profile_id NULL'lanabilir olur, guest_id eklenir ve kimlik kısıtı satırın
-- ÜÇ meşru durumdan tam birinde olmasını GARANTİ eder.
--
-- ÜÇ DURUM — ve neden üçüncüsü var:
--
--   A) KAYITLI  : profile_id dolu,  guest_id boş
--   B) MİSAFİR  : profile_id boş,   guest_id dolu
--   C) TOMBSTONE: profile_id boş,   guest_id boş
--                 → hesabı SİLİNMİŞ tarihsel oyuncu.
--
-- (C) bir gevşetme değil, ZORUNLULUK. 20260805120000'deki
-- `account_deletion_cleanup()` (profiles BEFORE DELETE trigger'ı) hesap
-- silinirken şunu yapar:
--
--     update public.tevatur_players
--        set name = 'Silinmiş#' || substr(md5(id::text), 1, 7), profile_id = null
--      where profile_id = v_uid;
--
-- guest_id'ye DOKUNMAZ (kayıtlı satırda zaten NULL'dur). Yani sonuç satır
-- (profile_id NULL, guest_id NULL) olur. Sade A-or-B XOR'u ile bu UPDATE
-- kısıt ihlaline düşer ve TÜM HESAP SİLME İŞLEMİ (trigger BEFORE DELETE
-- olduğu için `delete from profiles` cümlesinin tamamı) hata verir. Bu,
-- App Store 5.1.1(v) hesap silme akışını kırardı.
--
-- NOT VALID bu sorunu ÇÖZMEZ: NOT VALID yalnız kısıt eklenirken yapılan
-- geriye dönük tam tablo taramasını atlar; sonraki her INSERT/UPDATE'te
-- kısıt normal şekilde uygulanır. Yani gelecekteki ilk hesap silme yine
-- patlardı. Bu yüzden (C) kısıtın İÇİNDE, kontrollü biçimde tanımlanır.
--
-- (C) NASIL KONTROL ALTINDA TUTULUYOR — ad, satırın kendi PK'sinden türetilir:
--
--     name = 'Silinmiş#' || substr(md5(id::text), 1, 7)
--
-- Bu ifade cleanup fonksiyonunun ürettiğinin BİREBİR aynısıdır ve YALNIZ aynı
-- satırın kolonlarına bakar (immutable: md5/substr/||/text eşitliği) → CHECK
-- içinde kullanılabilir. Rastgele bir "profile_id NULL + guest_id NULL"
-- satırı (örn. normal isimli bir satır) REDDEDİLİR; kural kandırılamaz, çünkü
-- ad satırın id'sinden deterministik olarak türemek ZORUNDADIR.
--
-- Ayrıca (C) yalnız bir VERİ BÜTÜNLÜĞÜ durumudur, bir YETKİ durumu DEĞİLDİR.
-- Tombstone'un aktif oyuncu gibi davranamaması aşağıdaki üç yerde ayrıca ve
-- YAPISAL olarak garanti edilir (claim satırının silinmiş olmasına GÜVENİLMEZ):
--   • B2  tevatur_authorize_player → misafir dalı `guest_id is not null` ister
--   • B6  torble_link_guest_player → `guest_id is null` ise devralma reddedilir
--   • 20260810120000 tevatur_leave_room → host adayı `profile_id is not null`
-- Buna ek olarak B5 ham INSERT/UPDATE yolunu anon/authenticated'a kapatır →
-- istemci tombstone satırı ÜRETEMEZ; (C)'yi yalnız SECURITY DEFINER cleanup
-- fonksiyonu oluşturabilir.
--
-- MEVCUT VERİ: canlıda profile_id NULL olan tarihsel satırlar VARDIR (hesap
-- silme kalıntıları). Bunlar (C)'ye uyar → kısıt geriye dönük geçerlidir ve
-- veri taşıma/NOT VALID gerekmez. Uymayan bir satır kalmışsa aşağıdaki ön
-- kontrol kısıt hatasından ÖNCE anlaşılır bir mesajla durur.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.tevatur_players
  alter column profile_id drop not null;

alter table public.tevatur_players
  add column if not exists guest_id text null;

-- Ön kontrol: kısıt eklenmeden önce, uymayan satır varsa NE olduğunu söyle.
-- (Çıplak CHECK hatası yalnız "is violated by some row" der; bu blok kaç satır
--  ve hangi id'ler olduğunu söyler → canlıda teşhis için.)
do $$
declare
  v_bad_count int;
  v_bad_ids   text;
begin
  select count(*),
         coalesce(string_agg(id::text, ', ' order by id), '')
    into v_bad_count, v_bad_ids
    from public.tevatur_players
   where not (
     (profile_id is not null and guest_id is null)
     or (profile_id is null and guest_id is not null)
     or (profile_id is null and guest_id is null
         and name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7))
   );

  if v_bad_count > 0 then
    raise exception
      'tevatur_players: kimlik kuralına uymayan % satır var (id: %). Bunlar ne kayıtlı, ne misafir, ne de doğrulanabilir hesap-silme tombstone''u. Kısıt eklenmedi.',
      v_bad_count, v_bad_ids
      using errcode = 'P0001';
  end if;
end$$;

-- Kimlik kısıtı: A) kayıtlı  B) misafir  C) doğrulanabilir tombstone.
alter table public.tevatur_players
  drop constraint if exists tevatur_players_identity_xor;

alter table public.tevatur_players
  add constraint tevatur_players_identity_xor
  check (
    -- A) KAYITLI
    (profile_id is not null and guest_id is null)
    or
    -- B) MİSAFİR
    (profile_id is null and guest_id is not null)
    or
    -- C) TOMBSTONE — hesabı silinmiş tarihsel oyuncu. Ad, satırın kendi
    --    id'sinden türetilmek ZORUNDA (account_deletion_cleanup ile birebir).
    (profile_id is null and guest_id is null
     and name = 'Silinmiş#' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 7))
  );

comment on constraint tevatur_players_identity_xor on public.tevatur_players is
  'Kimlik: kayıtlı (profile_id) XOR misafir (guest_id) XOR hesap-silme '
  'tombstone''u (ikisi de NULL + ad = Silinmis# || md5(id)[1..7], bkz. '
  'account_deletion_cleanup / 20260805120000). Tombstone yetki taşımaz.';

-- Aynı hesap bir odada iki kez görünemez (join RPC'si zaten kontrol ediyor;
-- bu kısıt yarış durumunda son savunma hattı). Misafir satırları profile_id
-- NULL olduğu için bu indekse girmez — partial index kasıtlı.
create unique index if not exists tevatur_players_room_profile_uniq
  on public.tevatur_players (room_id, profile_id)
  where profile_id is not null;

-- Aynı misafir oturumu bir odada iki satır açamaz.
create unique index if not exists tevatur_players_room_guest_uniq
  on public.tevatur_players (room_id, guest_id)
  where guest_id is not null;


-- ────────────────────────────────────────────────────────────────────────────
-- B2) tevatur_authorize_player — misafir oturumunu tanı
-- ----------------------------------------------------------------------------
-- Kör Nokta'nın TÜM oyun RPC'leri (submit_guess / submit_answer /
-- advance_phase / set_team / set_mole / return_to_lobby / leave_room /
-- send_message / kick / update_settings) yetkiyi bu tek helper'dan alır.
-- Bu yüzden misafir desteği için o RPC'lerin gövdelerine DOKUNMAK GEREKMEZ —
-- yalnız bu fonksiyon ve grant'ler değişir. En küçük güvenli değişiklik budur.
--
-- İKİ KİMLİK YOLU (birbirini dışlar):
--   • KAYITLI : profile_id = auth.uid()  (+ varsa claim_token eşleşmesi)
--               → mevcut davranış BİREBİR korunur.
--   • MİSAFİR : profile_id IS NULL, guest_id IS NOT NULL ve claim_token satırın
--               claim kaydıyla eşleşmeli. claim_token ZORUNLUDUR (null
--               geçilemez) — misafir için tek kanıt odur.
--
-- ÜÇÜNCÜ DURUM — TOMBSTONE (yetkisiz): hesabı silinmiş tarihsel satır
-- (profile_id NULL, guest_id NULL — bkz. B1/C). İki dalın da DIŞINDA kalır:
-- kayıtlı dalı profile_id ister, misafir dalı guest_id ister. Dolayısıyla
-- authorize_player onun için HER ZAMAN false döner → Kör Nokta'nın tüm oyun
-- RPC'leri (tahmin/cevap/faz/mesaj/kick/ayar) onu reddeder. Bu, claim satırının
-- silinmiş olmasından BAĞIMSIZ bir garantidir.
--
-- Neden misafirde claim_token zorunlu: kayıtlı kullanıcıda JWT birincil
-- kanıttır ve claim_token ikincil faktördür (bu yüzden null geçilebilir).
-- Misafirde JWT yoktur; token null geçilebilseydi player_id bilen HERKES o
-- oyuncu adına oynayabilirdi. `tevatur_player_claims` tablosu SELECT grant'i
-- olmayan, realtime publication DIŞI bir tablodur → token yayılmaz.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.tevatur_players p
      left join public.tevatur_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
         -- KAYITLI: JWT birincil kanıt, claim_token ikincil.
         (
           p.profile_id is not null
           and p.profile_id = auth.uid()
           and (p_claim_token is null or c.claim_token = p_claim_token)
         )
         or
         -- MİSAFİR: claim_token TEK kanıt → zorunlu.
         -- `guest_id is not null` AKTİF misafir şartıdır: hesabı silinmiş
         -- tombstone satırı da profile_id NULL taşır (B1/C durumu) ve bu şart
         -- olmadan misafir dalının şekline uyardı. Onu YAPISAL olarak eler —
         -- claim satırının cleanup tarafından silinmiş olmasına GÜVENMEZ.
         (
           p.profile_id is null
           and p.guest_id is not null
           and p_claim_token is not null
           and c.claim_token = p_claim_token
         )
       )
  );
$$;

revoke all     on function public.tevatur_authorize_player(uuid, uuid) from public;
grant  execute on function public.tevatur_authorize_player(uuid, uuid) to anon, authenticated;

-- Host yetkisi authorize_player üzerine kurulu; misafir de host olabilir mi?
-- HAYIR — host YALNIZ oda kuran kişidir ve oda kurmak `authenticated`a
-- kapalıdır. Yani misafir host_player_id olamaz. Grant genişletilir ki
-- misafirin çağırdığı RPC'ler içinden (SECURITY DEFINER değilse) çağrılabilsin;
-- yetki kararı değişmez.
--
-- TOMBSTONE ve host — iki ayrı soru:
--   1. Tombstone host gibi DAVRANABİLİR Mİ? Hayır. authorize_host gövdesi
--      authorize_player'ı çağırır; o da tombstone için false döner (yukarı bkz.)
--      → host-only RPC'lerin hepsi reddeder. Canlıda host_player_id'si
--      tombstone'a işaret eden tarihsel odalar VARDIR; bunlar yalnızca
--      ilerletilemez (ölü oda) — ele geçirilemez.
--   2. Tombstone host SEÇİLEBİLİR Mİ? Hayır: 20260810120000'de yeniden
--      tanımlanan `tevatur_leave_room`, host devrinde adayı
--      `profile_id is not null` ile sınırlar → tombstone aday olamaz.
--      (Bu dosyadaki 20260711120000 sürümünde o filtre YOKTUR; sıralı
--      uygulamada 09 → 10 → 11 gider ve 10 bunu kapatır.)
revoke all     on function public.tevatur_authorize_host(uuid, uuid, uuid) from public;
grant  execute on function public.tevatur_authorize_host(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- B3) tevatur_join_room — misafir varyantı (5 argüman)
-- ----------------------------------------------------------------------------
-- 3 argümanlı MEVCUT sürüm OLDUĞU GİBİ KALIR (kayıtlı kullanıcı yolu; adı
-- profiles.username'den çözer, imzası değişmez → mevcut istemci kırılmaz).
-- Bunun yanına misafir kimliği + ad taşıyan 5 argümanlı bir AŞIRI YÜKLEME
-- eklenir. PostgREST çağrıyı gönderilen parametre adlarına göre eşler.
--
-- MİSAFİR AD DOĞRULAMASI — ortak sistem, kopya YOK:
--   1. `assert_display_name_allowed(name, null, guest_id)`
--      → 2-16 karakter, UGC filtresi (küfür/otorite/rezerve) ve KAYITLI
--        KULLANICI ADI TAKLİDİ kontrolü. Kayıtlı adlar `username_key()` ile
--        karşılaştırılır (Türkçe katlama: "Çağrı" = "çağrı" = "CAGRI"), sahibi
--        odada OLMASA BİLE korunur.
--   2. Oda-içi çakışma: `lower(btrim(name))` — odadaki başka bir oyuncunun
--      (kayıtlı ya da misafir) adı tekrar alınamaz.
--
-- Her iki kontrol de oda satırı `for update` ile KİLİTLİYKEN yapılır → iki
-- kişi aynı anda aynı nickle katılamaz; yalnız biri kabul edilir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_join_room(
  p_code        text,
  p_player_id   uuid,
  p_claim_token uuid,
  p_guest_id    text,
  p_name        text
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.tevatur_rooms;
  v_uid      uuid := auth.uid();
  v_name     text;
  v_count    int;
  v_blue     int;
  v_red      int;
  v_team     text;
begin
  if p_claim_token is null then
    raise exception 'claim_token_required' using errcode = '22023';
  end if;
  if p_player_id is null then
    raise exception 'player_id_required' using errcode = '22023';
  end if;
  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;

  -- ── Kimlik dalı ────────────────────────────────────────────────────────
  if v_uid is not null then
    -- KAYITLI: ad her zaman hesabın username'idir; p_name YOK SAYILIR.
    -- (İstemcinin gönderdiği ad kayıtlı kimliği asla değiştiremez.)
    select username into v_name from public.profiles where id = v_uid;
    if v_name is null or length(btrim(v_name)) < 2 then
      raise exception 'username_required' using errcode = '42501';
    end if;
    v_name := btrim(v_name);
  else
    -- MİSAFİR: guest_id + ad zorunlu.
    if p_guest_id is null or length(btrim(p_guest_id)) = 0 then
      raise exception 'guest_id_required' using errcode = '22023';
    end if;
    -- Ortak ad kapısı: biçim + UGC filtresi + kayıtlı-ad taklidi.
    v_name := public.assert_display_name_allowed(p_name, null, btrim(p_guest_id));
  end if;

  -- Oda lookup (kilitle: kapasite/ad kontrolü ile insert arası race)
  select * into v_room
    from public.tevatur_rooms
   where code = btrim(p_code)
   for update;

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room.status = 'finished' then
    raise exception 'room_finished' using errcode = 'P0001';
  end if;
  if v_room.status = 'playing' then
    raise exception 'room_in_progress' using errcode = 'P0001';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_unavailable' using errcode = 'P0001';
  end if;

  -- Aynı hesap / aynı misafir oturumu zaten bu odada mı?
  if v_uid is not null then
    if exists (
      select 1 from public.tevatur_players
       where room_id = v_room.id and profile_id = v_uid
    ) then
      raise exception 'already_in_room' using errcode = 'P0001';
    end if;
  else
    if exists (
      select 1 from public.tevatur_players
       where room_id = v_room.id and guest_id = btrim(p_guest_id)
    ) then
      raise exception 'already_in_room' using errcode = 'P0001';
    end if;
  end if;

  -- Oda-içi ad çakışması (kayıtlı + misafir hepsi aynı ad alanını paylaşır).
  if exists (
    select 1 from public.tevatur_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(v_name)
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  -- Kapasite (FOR UPDATE kilidi altında — race-safe)
  select count(*) into v_count
    from public.tevatur_players
   where room_id = v_room.id;
  if v_count >= coalesce(v_room.max_players, 10) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Auto-balance: az kişili takıma düş (eşitse Mavi).
  select count(*) filter (where team = 'blue'),
         count(*) filter (where team = 'red')
    into v_blue, v_red
    from public.tevatur_players
   where room_id = v_room.id;
  v_team := case when coalesce(v_red, 0) < coalesce(v_blue, 0) then 'red' else 'blue' end;

  insert into public.tevatur_players (id, room_id, profile_id, guest_id, name, score, team)
  values (
    p_player_id,
    v_room.id,
    v_uid,
    case when v_uid is null then btrim(p_guest_id) else null end,
    v_name,
    0,
    v_team
  );

  insert into public.tevatur_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  -- updated_at trigger room satırını taze gösterir → realtime sinyali
  update public.tevatur_rooms set updated_at = now() where id = v_room.id;

  select * into v_room from public.tevatur_rooms where id = v_room.id;
  return v_room;
end
$$;

revoke all     on function public.tevatur_join_room(text, uuid, uuid, text, text) from public;
grant  execute on function public.tevatur_join_room(text, uuid, uuid, text, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- B4) Oyun RPC'leri — misafire EXECUTE
-- ----------------------------------------------------------------------------
-- Bu RPC'lerin GÖVDELERİ DEĞİŞMEZ. Hepsi yetkiyi B2'deki
-- `tevatur_authorize_player` / `tevatur_authorize_host` üzerinden alır; o
-- helper artık misafir claim_token'ını tanıdığı için misafir de aynı
-- kontrollerden geçerek oynayabilir.
--
-- LİSTE KASITLI OLARAK DAR: yalnız bir OYUNCUNUN oynamak için çağırmak
-- zorunda olduğu fonksiyonlar. Oda kurma (`tevatur_create_room`) ve XP
-- (`award_kornokta_xp_event`) LİSTEDE YOKTUR → misafire kapalı kalır.
--
-- Host-only olanlar (start_game / update_settings / kick_player) da listede:
-- misafir bunları çağırabilir ama `tevatur_authorize_host` reddeder (misafir
-- host olamaz, çünkü oda kuramaz). Grant vermek yetki vermek değildir; grant
-- vermemek ise misafir bir oyuncunun host olduğu imkânsız bir durumu
-- varsaymak yerine kararı tek yerde (authorize_host) tutmayı bozar.
-- ────────────────────────────────────────────────────────────────────────────

grant execute on function public.tevatur_leave_room(uuid, uuid, uuid)                              to anon;
grant execute on function public.tevatur_send_message(text, uuid, uuid, text)                      to anon;
grant execute on function public.tevatur_update_settings(uuid, uuid, uuid, int, int)               to anon;
grant execute on function public.tevatur_kick_player(uuid, uuid, uuid, uuid)                       to anon;
grant execute on function public.tevatur_kn_return_to_lobby(uuid, uuid, uuid)                      to anon;
grant execute on function public.tevatur_kn_set_team(uuid, uuid, uuid, uuid, text)                 to anon;
grant execute on function public.tevatur_kn_set_mole(uuid, uuid, uuid, boolean)                    to anon;
grant execute on function public.tevatur_kn_advance_phase(uuid, uuid, uuid, int, text)             to anon;
grant execute on function public.tevatur_kn_select_questions(uuid, uuid, uuid, jsonb)              to anon;
grant execute on function public.tevatur_kn_submit_answer(uuid, uuid, uuid, text, text)            to anon;
grant execute on function public.tevatur_kn_submit_judgement(uuid, uuid, uuid, text, text)         to anon;
grant execute on function public.tevatur_kn_submit_report(uuid, uuid, uuid, text)                  to anon;

-- start_game iki imzayla yaşıyor (4 ve 5 argümanlı). İstemci 5 argümanlıyı
-- çağırır; ikisi de host kontrolünden geçtiği için ikisine de grant verilir.
do $$
begin
  if to_regprocedure('public.tevatur_kn_start_game(uuid,uuid,uuid,jsonb,jsonb)') is not null then
    execute 'grant execute on function public.tevatur_kn_start_game(uuid,uuid,uuid,jsonb,jsonb) to anon';
  end if;
  if to_regprocedure('public.tevatur_kn_start_game(uuid,uuid,uuid,jsonb)') is not null then
    execute 'grant execute on function public.tevatur_kn_start_game(uuid,uuid,uuid,jsonb) to anon';
  end if;
end$$;

-- submit_guess üç imzayla yaşıyor (şema evrimi). Hangisi varsa ona grant ver.
do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.tevatur_kn_submit_guess(uuid,uuid,uuid,double precision,double precision,bigint)',
    'public.tevatur_kn_submit_guess(uuid,uuid,uuid,double precision,double precision,text,text)',
    'public.tevatur_kn_submit_guess(uuid,uuid,uuid,double precision,double precision)'
  ]
  loop
    if to_regprocedure(sig) is not null then
      execute format('grant execute on function %s to anon', sig);
    end if;
  end loop;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- B5) tevatur_players — ham INSERT/UPDATE/DELETE yolunu kapat
-- ----------------------------------------------------------------------------
-- 20260808120000 Bölüm C'nin Kör Nokta karşılığı. Katılma yalnız
-- `tevatur_join_room` RPC'sinden geçebilmeli; aksi hâlde kapasite, oda durumu,
-- ad çakışması ve kayıtlı-ad taklidi kontrolleri PostgREST'ten doğrudan INSERT
-- ile atlanabilir.
--
-- SELECT policy'sine DOKUNULMAZ (lobi listesi + realtime ona bağlı).
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'tevatur_players'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy if exists %I on public.tevatur_players', pol.policyname);
  end loop;
end$$;

revoke insert, update, delete on table public.tevatur_players from anon, authenticated;
revoke insert, update, delete on table public.tevatur_rooms   from anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- B6) torble_link_guest_player — Kör Nokta modunu ekle
-- ----------------------------------------------------------------------------
-- 20260808120000 Bölüm D'deki fonksiyonun aynısı; CASE eşlemesine 'korNokta'
-- satırı eklenir. Yetki zinciri aynı sırayı korur (auth_required →
-- mode_invalid → not_a_guest_row → claim_mismatch → already_in_room);
-- XP/altın/görev YAZMAZ.
--
-- TEK DAVRANIŞ EKİ: `not_a_guest_row` artık iki durumu birden kapsar —
-- (a) satır BAŞKA bir hesaba ait (profile_id dolu, eskiden beri),
-- (b) satır hesabı silinmiş bir TOMBSTONE (profile_id NULL ve guest_id NULL).
-- (b) olmadan, profile_id NULL olduğu için tombstone "misafir satırı" sanılıp
-- devralınabilirdi. Bu ek 9 MODUN HEPSİNİ korur — tüm player tablolarında
-- account_deletion_cleanup aynı (NULL, NULL) anonimleştirmesini yapar.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.torble_link_guest_player(
  p_mode        text,
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_uid            uuid := auth.uid();
  v_players_table  text;
  v_claims_table   text;
  v_room_id        uuid;
  v_profile_id     uuid;
  v_guest_id       text;
  v_token_ok       boolean;
  v_username       text;
  v_name_free      boolean;
  v_dup            boolean;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  if p_player_id is null or p_claim_token is null then
    raise exception 'claim_token_required' using errcode = '22023';
  end if;

  case p_mode
    when 'duel'       then v_players_table := 'duel_players';        v_claims_table := 'duel_player_claims';
    when 'flagDuel'   then v_players_table := 'duel_players';        v_claims_table := 'duel_player_claims';
    when 'duelGroup'  then v_players_table := 'duel_group_players';  v_claims_table := 'duel_group_player_claims';
    when 'wheelDuel'  then v_players_table := 'wheel_duel_players';  v_claims_table := 'wheel_duel_player_claims';
    when 'wheelGroup' then v_players_table := 'wheel_group_players'; v_claims_table := 'wheel_group_player_claims';
    when 'flagGroup'  then v_players_table := 'flag_group_players';  v_claims_table := 'flag_group_player_claims';
    when 'routeDuel'  then v_players_table := 'route_duel_players';  v_claims_table := 'route_duel_player_claims';
    when 'conquest'   then v_players_table := 'conquest_players';    v_claims_table := 'conquest_player_claims';
    when 'korNokta'   then v_players_table := 'tevatur_players';     v_claims_table := 'tevatur_player_claims';
    else
      raise exception 'mode_invalid' using errcode = '22023';
  end case;

  execute format(
    'select room_id, profile_id, guest_id from public.%I where id = $1 for update',
    v_players_table
  ) into v_room_id, v_profile_id, v_guest_id using p_player_id;

  if v_room_id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  if v_profile_id = v_uid then
    return true;
  end if;

  if v_profile_id is not null then
    raise exception 'not_a_guest_row' using errcode = '42501';
  end if;

  -- profile_id NULL olması TEK BAŞINA "misafir" demek DEĞİLDİR: hesabı
  -- silinmiş tarihsel satır (tombstone) da profile_id NULL taşır ve guest_id'si
  -- de NULL'dur. Böyle bir satır hiçbir hesaba DEVREDİLEMEZ — aksi hâlde
  -- silinmiş bir oyuncunun oda slotu/skoru canlı bir hesaba geçerdi.
  -- Bu kontrol 9 modun HEPSİ için geçerlidir (tüm player tablolarında
  -- account_deletion_cleanup aynı anonimleştirmeyi yapar), yalnız Kör Nokta
  -- için değil. Aynı errcode → istemci hata işleme yolu değişmez.
  if v_guest_id is null then
    raise exception 'not_a_guest_row' using errcode = '42501';
  end if;

  execute format(
    'select exists (select 1 from public.%I where player_id = $1 and claim_token = $2)',
    v_claims_table
  ) into v_token_ok using p_player_id, p_claim_token;

  if not coalesce(v_token_ok, false) then
    raise exception 'claim_mismatch' using errcode = '42501';
  end if;

  execute format(
    'select exists (select 1 from public.%I where room_id = $1 and profile_id = $2 and id <> $3)',
    v_players_table
  ) into v_dup using v_room_id, v_uid, p_player_id;

  if coalesce(v_dup, false) then
    raise exception 'already_in_room' using errcode = 'P0001';
  end if;

  select username into v_username from public.profiles where id = v_uid;

  v_name_free := false;
  if v_username is not null and length(btrim(v_username)) > 0 then
    execute format(
      'select not exists (select 1 from public.%I where room_id = $1 and id <> $2 and lower(btrim(name)) = lower(btrim($3)))',
      v_players_table
    ) into v_name_free using v_room_id, p_player_id, v_username;
  end if;

  if coalesce(v_name_free, false) then
    execute format(
      'update public.%I set profile_id = $1, guest_id = null, name = btrim($2) where id = $3',
      v_players_table
    ) using v_uid, v_username, p_player_id;
  else
    execute format(
      'update public.%I set profile_id = $1, guest_id = null where id = $2',
      v_players_table
    ) using v_uid, p_player_id;
  end if;

  return true;
end
$$;

revoke all     on function public.torble_link_guest_player(text, uuid, uuid) from public;
grant  execute on function public.torble_link_guest_player(text, uuid, uuid) to authenticated;


-- ============================================================================
-- DOĞRULAMA (Supabase Studio → SQL Editor)
-- ============================================================================
--
-- A) Açık oda listesi misafire KAPALI:
--   select p.proname, r.grantee
--     from pg_proc p
--     join information_schema.role_routine_grants r
--       on r.specific_name = p.proname || '_' || p.oid
--    where p.proname = 'conquest_list_public_rooms';
--   -- Beklenen: YALNIZ authenticated. anon satırı OLMAMALI.
--
--   -- anon anahtarıyla (Studio değil, curl/istemci):
--   --   POST /rest/v1/rpc/conquest_list_public_rooms  →  42501 auth_required
--
-- B) Tek oda çözümleme misafire AÇIK:
--   select public.conquest_find_room_by_code('<AKTIF_KOD>');   -- satır döner
--   select public.conquest_find_room_by_code('YOK123');        -- null
--   select public.conquest_find_room_by_code('AB');            -- null (6 hane değil)
--
-- C) Kör Nokta şeması misafir kimliğini taşıyor:
--   select column_name, is_nullable
--     from information_schema.columns
--    where table_name = 'tevatur_players'
--      and column_name in ('profile_id','guest_id');
--   -- Beklenen: profile_id YES (nullable), guest_id YES.
--
--   -- Kimlik kısıtı çalışıyor mu (ikisi de dolu → hata bekleniyor):
--   insert into public.tevatur_players (room_id, profile_id, guest_id, name)
--   values (gen_random_uuid(), gen_random_uuid(), 'g1', 'Test');
--   -- Beklenen: tevatur_players_identity_xor ihlali.
--
--   -- İkisi de BOŞ + normal ad → yine hata (tombstone taklidi engellenir):
--   insert into public.tevatur_players (id, room_id, profile_id, guest_id, name)
--   values (gen_random_uuid(), gen_random_uuid(), null, null, 'SahteOyuncu');
--   -- Beklenen: tevatur_players_identity_xor ihlali.
--
--   -- Tombstone durumu (C) — ad satırın kendi id'sinden türetilmiş:
--   with x as (select gen_random_uuid() as pid, '<gerçek_oda_id>'::uuid as rid)
--   insert into public.tevatur_players (id, room_id, profile_id, guest_id, name)
--   select pid, rid, null, null,
--          'Silinmiş#' || substr(md5(pid::text), 1, 7) from x;
--   -- Beklenen: BAŞARILI (hesap silme bu satırı üretebilmeli).
--
--   -- Canlıdaki tarihsel tombstone'lar kurala uyuyor mu (kısıt eklenmeden ÖNCE
--   -- de çalıştırılabilir; 0 dönmeli):
--   select count(*) from public.tevatur_players
--    where profile_id is null and guest_id is null
--      and name <> 'Silinmiş#' || substr(md5(id::text), 1, 7);
--   -- Beklenen: 0. Değilse B1'deki ön kontrol migration'ı anlaşılır bir
--   -- mesajla durdurur (hangi id'ler olduğunu söyler).
--
--   -- Hesap silme kısıt yüzünden patlamıyor mu (test hesabıyla, dikkat):
--   --   delete from public.profiles where id = '<test_hesabı>';
--   -- Beklenen: BAŞARILI + tevatur_players satırı (null, null, 'Silinmiş#…').
--
-- D) Misafir Kör Nokta odasına katılabiliyor:
--   -- 1. Kayıtlı kullanıcı oda kursun (tevatur_create_room) → kodu al.
--   -- 2. anon oturumunda:
--   select * from public.tevatur_join_room(
--     '<KOD>', gen_random_uuid(), gen_random_uuid(), 'guest-abc', 'MisafirTest');
--   -- Beklenen: oda satırı döner; tevatur_players'ta profile_id NULL,
--   --           guest_id='guest-abc' olan satır oluşur.
--
--   -- 3. Kayıtlı bir kullanıcı adıyla dene → registered_username_taken:
--   select * from public.tevatur_join_room(
--     '<KOD>', gen_random_uuid(), gen_random_uuid(), 'guest-xyz', '<KAYITLI_USERNAME>');
--
--   -- 4. Odadaki bir adı tekrar al → name_taken:
--   select * from public.tevatur_join_room(
--     '<KOD>', gen_random_uuid(), gen_random_uuid(), 'guest-2', 'MisafirTest');
--
-- E) Misafir Kör Nokta odası KURAMAZ:
--   select p.proname, r.grantee
--     from pg_proc p
--     join information_schema.role_routine_grants r
--       on r.specific_name = p.proname || '_' || p.oid
--    where p.proname in ('tevatur_create_room','award_kornokta_xp_event')
--      and r.grantee = 'anon';
--   -- Beklenen: 0 satır.
--
-- F) tevatur_players'ta yazma policy'si KALMAMALI:
--   select policyname, cmd from pg_policies
--    where schemaname='public' and tablename='tevatur_players';
--   -- Beklenen: yalnız SELECT.
-- ============================================================================
