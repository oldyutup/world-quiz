-- ============================================================================
-- 20260814120000_link_guest_player_room_lock.sql
--
-- M2 — EŞZAMANLILIK YARIŞI: bir hesap aynı odada İKİ slota sahip olabiliyordu.
--
-- SORUN
-- -----
-- `torble_link_guest_player` "aynı hesabın bu odada başka satırı var mı?"
-- kontrolünü yapıyor (`already_in_room`), ama transaction'ı YALNIZ DEVREDİLEN
-- OYUNCU SATIRI üzerinde kilitliyordu (`select ... where id = $1 for update`).
-- Aynı hesap, aynı odadaki İKİ FARKLI misafir slotunu eşzamanlı devretmeye
-- çalışırsa (iki sekme / iki cihaz, iki ayrı claim_token):
--
--   T1: playerA satırını kilitler → "odada başka satırım var mı?" → HAYIR
--   T2: playerB satırını kilitler → "odada başka satırım var mı?" → HAYIR
--   T1: commit  (playerA.profile_id := uid)
--   T2: commit  (playerB.profile_id := uid)      ← invariant KIRILDI
--
-- İki transaction farklı satırları kilitlediği için birbirini görmez; kontrol
-- READ COMMITTED altında henüz commit edilmemiş diğer güncellemeyi okuyamaz.
-- Sonuç: ürün kuralı 6 ve güvenlik sorusu 5 ihlali (bir profil, tek odada iki
-- oyuncu slotu).
--
-- ÇÖZÜM (minimal + additive)
-- --------------------------
-- Devir işlemi ODA BAZINDA serileştirilir: `pg_advisory_xact_lock`. Aynı odaya
-- ait iki devir artık sıraya girer; ikincisi birincinin commit'ini GÖRÜR ve
-- `already_in_room` ile reddedilir.
--
-- Kilit SIRASI bilinçli — advisory lock EN DIŞTA alınır:
--   1. room_id KİLİTSİZ okunur (yalnız kilit anahtarını türetmek için)
--   2. pg_advisory_xact_lock(room)          ← serileştirme noktası
--   3. satır `for update` ile kilitlenir ve KANONİK değerler yeniden okunur
-- Satır kilidini önce alıp advisory'yi sonra almak da çalışırdı, ama bu sıra
-- kilit hiyerarşisini tek yönlü tutar (oda → satır) ve ileride bu fonksiyona
-- ikinci bir satır dokunuşu eklenirse deadlock ihtimalini yapısal olarak eler.
-- Kilit `xact` kapsamlıdır: commit/rollback'te OTOMATİK bırakılır, elle
-- serbest bırakma yolu YOKTUR (sızdırmaz).
--
-- 2. adım ile 3. adım arasında satır silinebilir → 3. adımda room_id yine null
-- gelir ve `player_not_found` fırlatılır (kontrol KORUNDU, atlanmadı).
--
-- DEĞİŞMEYEN HER ŞEY (bilinçli olarak birebir korunur)
-- ----------------------------------------------------
--   • Yetki zinciri ve SIRASI: auth_required → mode_invalid → player_not_found
--     → (idempotent true) → not_a_guest_row → not_a_guest_row(tombstone)
--     → claim_mismatch → already_in_room
--   • auth.uid() zorunluluğu, claim_token doğrulaması, tombstone reddi
--   • SECURITY DEFINER + `set search_path = public, auth`
--   • Sabit CASE tablo eşlemesi (tablo adı kullanıcı girdisinden TÜREMEZ)
--   • İdempotentlik: satır zaten caller'ın ise `true`
--   • Görünen ad davranışı (username boşsa geç, değilse misafir adını koru)
--   • Grant'lar: anon EXECUTE KAPALI, yalnız authenticated
--   • İmza: (text, uuid, uuid) → boolean   [istemci değişikliği GEREKMEZ]
--
-- Bağımlılık: 20260809120000 (B6, fonksiyonun son hâli).
-- Önceki sürüm: 20260808120000 (D) → 20260809120000 (B6) → BU.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 0) ÖN KOŞUL — değiştirilecek fonksiyon canlıda beklenen imzayla var mı?
--    Yoksa migration BAŞTA durur; yarım uygulanmış bir durum oluşmaz.
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.torble_link_guest_player(text,uuid,uuid)') is null then
    raise exception
      'ÖN KOŞUL EKSİK: public.torble_link_guest_player(text,uuid,uuid) bulunamadı [20260808120000 D / 20260809120000 B6]';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Fonksiyon — oda bazında serileştirme eklenmiş hâli
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

  -- ── M2: ODA BAZINDA SERİLEŞTİRME ────────────────────────────────────────
  -- Önce yalnız kilit anahtarını türetmek için room_id KİLİTSİZ okunur.
  execute format(
    'select room_id from public.%I where id = $1',
    v_players_table
  ) into v_room_id using p_player_id;

  if v_room_id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  -- Aynı odaya ait TÜM devirler bu noktada sıraya girer. Anahtara tablo adı da
  -- katılır: farklı modların room_id'leri kuramsal olarak çakışmasın diye
  -- (uuid'ler zaten çakışmaz; bu, niyeti okunur kılan ucuz bir güvence).
  perform pg_advisory_xact_lock(
    hashtextextended(v_players_table || ':' || v_room_id::text, 0)
  );

  -- ── Kilit ALTINDA kanonik okuma ─────────────────────────────────────────
  -- Sıradaki ikinci transaction artık birincinin commit'ini GÖRÜR.
  execute format(
    'select room_id, profile_id, guest_id from public.%I where id = $1 for update',
    v_players_table
  ) into v_room_id, v_profile_id, v_guest_id using p_player_id;

  -- Kilit beklenirken satır silinmiş olabilir → kontrol atlanmaz, tekrarlanır.
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
  -- de NULL'dur. Böyle bir satır hiçbir hesaba DEVREDİLEMEZ.
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

  -- Bu kontrol ARTIK GÜVENİLİR: advisory lock sayesinde aynı odadaki rakip
  -- devir ya henüz başlamamıştır ya da commit edip görünür olmuştur.
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


-- ────────────────────────────────────────────────────────────────────────────
-- 2) GRANT'LAR — yeniden ONAYLANIR
--    `create or replace` mevcut grant'ları KORUR (sıfırlamaz), yani bu blok
--    teknik olarak no-op'tur. Yine de açıkça yazılır: ileride biri fonksiyonu
--    DROP+CREATE ederse anon EXECUTE'u public şemasında GERİ GELİR ve bu satır
--    olmadan sessizce açık kalırdı. `revoke from public` tek başına YETMEZ —
--    anon'a DOĞRUDAN verilmiş grant'ı kaldırmaz.
-- ────────────────────────────────────────────────────────────────────────────
revoke all     on function public.torble_link_guest_player(text, uuid, uuid) from public;
revoke execute on function public.torble_link_guest_player(text, uuid, uuid) from anon;
grant  execute on function public.torble_link_guest_player(text, uuid, uuid) to   authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) UYGULAMA SONRASI OTOMATİK DOĞRULAMA
--    Beklenen durum sağlanmazsa migration HATA verir (sessiz kısmi uygulama yok).
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(to_regprocedure('public.torble_link_guest_player(text,uuid,uuid)'))
    into v_def;

  if v_def !~ 'pg_advisory_xact_lock' then
    raise exception 'DOĞRULAMA: oda bazında serileştirme (pg_advisory_xact_lock) uygulanmamış';
  end if;
  if v_def !~ 'security definer' and v_def !~ 'SECURITY DEFINER' then
    raise exception 'DOĞRULAMA: SECURITY DEFINER kaybolmuş';
  end if;
  if v_def !~ 'search_path' then
    raise exception 'DOĞRULAMA: search_path sabitlemesi kaybolmuş';
  end if;
  if v_def !~ 'already_in_room' or v_def !~ 'claim_mismatch'
     or v_def !~ 'not_a_guest_row' or v_def !~ 'auth_required' then
    raise exception 'DOĞRULAMA: yetki zincirindeki hata dallarından biri kaybolmuş';
  end if;

  if has_function_privilege('anon', 'public.torble_link_guest_player(text,uuid,uuid)', 'execute') then
    raise exception 'DOĞRULAMA: anon EXECUTE hâlâ AÇIK';
  end if;
  if not has_function_privilege('authenticated', 'public.torble_link_guest_player(text,uuid,uuid)', 'execute') then
    raise exception 'DOĞRULAMA: authenticated EXECUTE kapanmış';
  end if;

  raise notice 'OK: torble_link_guest_player oda bazında serileştirildi; grant''lar korunuyor.';
end$$;


-- ============================================================================
-- ELLE DOĞRULAMA (Supabase Studio → SQL Editor)
-- ============================================================================
--
-- A) Grant durumu (beklenen: anon=f, authenticated=t)
--
--    select
--      has_function_privilege('anon',         'public.torble_link_guest_player(text,uuid,uuid)', 'execute') as anon,
--      has_function_privilege('authenticated','public.torble_link_guest_player(text,uuid,uuid)', 'execute') as authed;
--
-- B) Serileştirme gerçekten gövdede mi?
--
--    select pg_get_functiondef(to_regprocedure('public.torble_link_guest_player(text,uuid,uuid)'))
--           ~ 'pg_advisory_xact_lock' as serialized;
--
-- C) MEVCUT VERİDE invariant tutuyor mu? (read-only, uygulamadan ÖNCE de
--    çalıştırılabilir.) Beklenen: 0 satır. Satır dönerse yarış GEÇMİŞTE
--    gerçekleşmiş demektir; migration bunu geriye dönük TEMİZLEMEZ.
--
--    select 'tevatur_players' as tbl, room_id, profile_id, count(*)
--      from public.tevatur_players     where profile_id is not null group by 1,2,3 having count(*) > 1
--    union all select 'conquest_players',    room_id, profile_id, count(*)
--      from public.conquest_players    where profile_id is not null group by 1,2,3 having count(*) > 1
--    union all select 'duel_players',        room_id, profile_id, count(*)
--      from public.duel_players        where profile_id is not null group by 1,2,3 having count(*) > 1
--    union all select 'duel_group_players',  room_id, profile_id, count(*)
--      from public.duel_group_players  where profile_id is not null group by 1,2,3 having count(*) > 1
--    union all select 'wheel_duel_players',  room_id, profile_id, count(*)
--      from public.wheel_duel_players  where profile_id is not null group by 1,2,3 having count(*) > 1
--    union all select 'wheel_group_players', room_id, profile_id, count(*)
--      from public.wheel_group_players where profile_id is not null group by 1,2,3 having count(*) > 1
--    union all select 'flag_group_players',  room_id, profile_id, count(*)
--      from public.flag_group_players  where profile_id is not null group by 1,2,3 having count(*) > 1
--    union all select 'route_duel_players',  room_id, profile_id, count(*)
--      from public.route_duel_players  where profile_id is not null group by 1,2,3 having count(*) > 1;
--
-- D) EŞZAMANLILIK TESTİ → supabase/tests/check_link_guest_player_race.sql
-- ============================================================================
