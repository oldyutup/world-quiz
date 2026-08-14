-- ════════════════════════════════════════════════════════════════════════════
-- 20260814180000_registered_player_claim_auth_hardening.sql
--
-- P0 — CLAIM-TOKEN SQUATTING / KAYITLI OYUNCU KİMLİĞİNE BÜRÜNME
--
-- ════════════════════════════════════════════════════════════════════════════
-- SORUN
-- ─────
-- Yedi modun `*_authorize_player` helper'ında claim dalı, hedef oyuncunun
-- MİSAFİR olmasını şart koşmuyordu:
--
--     (p.profile_id is not null and p.profile_id = auth.uid())      -- kayıtlı
--  or (p_claim_token is not null and c.claim_token = p_claim_token) -- claim
--
-- İkinci dal `p.profile_id`ye HİÇ bakmaz. `*_player_claims.player_id` PRIMARY
-- KEY'dir, INSERT policy'si anon'a açıktır ve Hızlı Eşleş RPC'leri claim satırı
-- YAZMAZ → BOŞ yuva saldırgan tarafından işgal edilip kurban adına gameplay
-- RPC'si çağrılabiliyordu (ör. `duel_forfeit_game` ile kurbanın maçını düşürmek).
--
-- ════════════════════════════════════════════════════════════════════════════
-- KANONİK MİSAFİR INVARIANT'I
-- ───────────────────────────
--     profile_id IS NULL  AND  guest_id IS NOT NULL
--
-- "profile_id NULL olan herkes misafirdir" YANLIŞTIR. Repo bunu zaten yazmış
-- (20260602120000, wheel_group m3 tehdit modeli):
--     "profile_id null + guest_id null olduğu için reddedilmeli"
-- ve `torble_link_guest_player` aynı kuralı uygular ('not_a_guest_row').
--
-- KİMLİKSİZ (profile_id NULL + guest_id NULL) SATIRLAR — üç kaynak:
--   1) Bayrak Düello Hızlı Eşleş: `flag_duel_quick_match` player satırını
--      KİMLİK KOLONU YAZMADAN kurar; sahiplik `flag_duel_queue`dadır ve
--      `flag_duel_authorize_player` QM dalı auth.uid() ile bağlar.
--   2) Çark Düello Hızlı Eşleş: aynı şekil (canlı veriyle doğrulandı) —
--      ama `wheel_duel_authorize_player`ın köprüsü YOKTU; istemci QM sonrası
--      claim yazıyordu → claim TEK kimlikti → planted-claim/race açıktı.
--   3) M1 öncesi (Studio dönemi) tarihsel satırlar — canlıdaki tüm örnekleri
--      15–92 günlük terk edilmiş odalarda (maç süresi 60 sn).
--
-- ════════════════════════════════════════════════════════════════════════════
-- ÇÖZÜM
-- ─────
--   A) 7 helper: claim dalı YAPISAL olarak yalnız GERÇEK misafire açılır.
--   B) `wheel_duel_authorize_player`: Çark QM sahibinin meşru kimlik yolu
--      `wheel_duel_queue` köprüsüyle kurulur (flag_duel deseninin AYNISI).
--   C) Köprünün ÖN KOŞULU: kuyruğa istemci YAZAMAMALI. Aksi hâlde saldırgan
--      kendi profile_id'si + kurbanın player_id'si ile satır yazıp kurban
--      adına yetkilenir (lokal runtime'da H1 hipotezinde KANITLANDI).
--      Bu yüzden `wheel_duel_queue` üzerinde YALNIZ yazma yetkileri geri
--      alınır. SELECT'e DOKUNULMAZ (istemci kendi satırını okuyor + realtime
--      aboneliği var), RLS'e DOKUNULMAZ, başka hiçbir tabloya DOKUNULMAZ.
--
-- ════════════════════════════════════════════════════════════════════════════
-- GERİYE UYUMLULUK
-- ────────────────
--   • Kayıtlı dal AYNEN korunur → normal kayıtlı oyun akışı değişmez.
--   • Gerçek misafir (profile_id NULL + guest_id dolu) AYNEN çalışır →
--     davet/özel oda akışı ve eski App Store istemcileri bozulmaz.
--   • Çark QM: köprü SUNUCU tarafındadır → eski/mevcut istemci DEĞİŞMEDEN
--     çalışır. İstemcinin QM sonrası yazdığı claim artık gereksizdir ama
--     zararsızdır. `wheel_duel_quick_match` SECURITY DEFINER olduğu için
--     kuyruk yazma yetkisi geri alınsa da QM kurulumu etkilenmez.
--   • İmza / dönüş tipi / SECURITY DEFINER / search_path / fonksiyon EXECUTE
--     grant'ları DEĞİŞMEZ (`create or replace` grant'ları KORUR).
--
-- BU MIGRATION'IN YAPMADIKLARI
-- ────────────────────────────
--   • DROP yok. Şema değişikliği yok. RLS enable/disable yok, policy yok.
--   • Toplu (bulk) REVOKE yok: tek tablo + yalnız INSERT/UPDATE/DELETE.
--   • `flag_duel_authorize_player` DOKUNULMAZ (delege eder + kendi QM köprüsü
--     var); `tevatur_authorize_player` DOKUNULMAZ (invaryantı zaten taşıyor).
--   • P1 (`duel_rooms.flag_sequence`) ve P2 (ACL temizliği) KAPSAM DIŞI.
-- ════════════════════════════════════════════════════════════════════════════

-- ── ÖN KOŞUL ─────────────────────────────────────────────────────────────
do $$
declare
  v_missing text := '';
  v_sig     text;
begin
  foreach v_sig in array array[
    'public.duel_authorize_player(uuid,uuid)',
    'public.duel_group_authorize_player(uuid,uuid)',
    'public.conquest_authorize_player(uuid,uuid)',
    'public.wheel_duel_authorize_player(uuid,uuid)',
    'public.wheel_group_authorize_player(uuid,uuid)',
    'public.flag_group_authorize_player(uuid,uuid)',
    'public.route_duel_authorize_player(uuid,uuid)'
  ] loop
    if to_regprocedure(v_sig) is null then
      v_missing := v_missing || ' ' || v_sig;
    end if;
  end loop;
  if v_missing <> '' then
    raise exception 'ÖN KOŞUL EKSİK: helper(lar) bulunamadı:%', v_missing;
  end if;

  -- guest_id kolonu 7 oyuncu tablosunda da bulunmalı (invariant buna dayanır)
  foreach v_sig in array array[
    'duel_players','duel_group_players','conquest_players','wheel_duel_players',
    'wheel_group_players','flag_group_players','route_duel_players'
  ] loop
    if not exists (
      select 1 from pg_attribute
       where attrelid = to_regclass('public.'||v_sig)
         and attname = 'guest_id' and attnum > 0 and not attisdropped
    ) then
      raise exception 'ÖN KOŞUL EKSİK: public.%.guest_id kolonu yok', v_sig;
    end if;
  end loop;

  -- Çark köprüsünün dayandığı kuyruk tablosu + kolonları
  if to_regclass('public.wheel_duel_queue') is null then
    raise exception 'ÖN KOŞUL EKSİK: public.wheel_duel_queue bulunamadı (Çark QM köprüsü buna dayanır)';
  end if;
  foreach v_sig in array array['profile_id','player_id'] loop
    if not exists (
      select 1 from pg_attribute
       where attrelid = to_regclass('public.wheel_duel_queue')
         and attname = v_sig and attnum > 0 and not attisdropped
    ) then
      raise exception 'ÖN KOŞUL EKSİK: wheel_duel_queue.% kolonu yok', v_sig;
    end if;
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- 1) Ülke Yaz Düello — duel_authorize_player
--    (Bayrak Düello MANUEL odaları da buraya delege eder. Bayrak QM satırları
--     kimliksizdir → burada REDDEDİLİR; onları flag_duel_authorize_player'ın
--     kendi `flag_duel_queue` köprüsü yetkilendirir.)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.duel_authorize_player(
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
      from public.duel_players p
      left join public.duel_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
            -- Logged-in: JWT subject == profile.
            (p.profile_id is not null and p.profile_id = auth.uid())
         or -- MİSAFİR: claim_token tek kanıt. `guest_id is not null` AKTİF
            -- misafir şartıdır: kayıtlı oyuncu EKİLMİŞ claim ile ele
            -- geçirilemesin, kimliksiz (QM/tombstone) satır da bu daldan
            -- geçemesin.
            (p.profile_id is null
             and p.guest_id  is not null
             and p_claim_token is not null
             and c.claim_token = p_claim_token)
       )
  );
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 2) Ülke Yaz Grup — duel_group_authorize_player
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.duel_group_authorize_player(
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
      from public.duel_group_players p
      left join public.duel_group_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
         or (p.profile_id is null
             and p.guest_id  is not null
             and p_claim_token is not null
             and c.claim_token = p_claim_token)
       )
  );
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) Kuşatma — conquest_authorize_player
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.conquest_authorize_player(
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
      from public.conquest_players p
      left join public.conquest_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
         or (p.profile_id is null
             and p.guest_id  is not null
             and p_claim_token is not null
             and c.claim_token = p_claim_token)
       )
  );
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 4) Çark Düello — wheel_duel_authorize_player
--    (a) claim dalı: yalnız GERÇEK misafir
--    (b) YENİ: Hızlı Eşleş sahiplik köprüsü. Çark QM satırı kimlik kolonu
--        taşımaz; meşru sahip `wheel_duel_queue.profile_id = auth.uid()`
--        üzerinden bağlanır. flag_duel_authorize_player'daki desenin AYNISI.
--        Köprü ancak kuyruğa istemci YAZAMAZSA güvenlidir → aşağıdaki (6).
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.wheel_duel_authorize_player(
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
      from public.wheel_duel_players p
      left join public.wheel_duel_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
         or (p.profile_id is null
             and p.guest_id  is not null
             and p_claim_token is not null
             and c.claim_token = p_claim_token)
       )
  )
  or exists (
    -- Hızlı Eşleş sahipliği: kuyruk satırı SECURITY DEFINER RPC tarafından
    -- yazılır ve player_id ile birebir eşleşir.
    select 1
      from public.wheel_duel_queue q
     where q.player_id  = p_player_id
       and q.profile_id is not null
       and q.profile_id = auth.uid()
  );
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 5) Çark Grup — wheel_group_authorize_player
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.wheel_group_authorize_player(
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
      from public.wheel_group_players p
      left join public.wheel_group_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
         or (p.profile_id is null
             and p.guest_id  is not null
             and p_claim_token is not null
             and c.claim_token = p_claim_token)
       )
  );
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 6) Bayrak Bilmece Grup — flag_group_authorize_player
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.flag_group_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1
      from public.flag_group_players p
      left join public.flag_group_player_claims c on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
         or (p.profile_id is null
             and p.guest_id  is not null
             and p_claim_token is not null
             and c.claim_token = p_claim_token)
       )
  );
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 7) Rota Düello — route_duel_authorize_player
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.route_duel_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1
      from public.route_duel_players p
      left join public.route_duel_player_claims c on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
         or (p.profile_id is null
             and p.guest_id  is not null
             and p_claim_token is not null
             and c.claim_token = p_claim_token)
       )
  );
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 8) ÇARK KUYRUĞU — KÖPRÜNÜN ÖN KOŞULU (MİNİMUM yazma kilidi)
--
-- KAPSAM: tek tablo (`wheel_duel_queue`), yalnız INSERT/UPDATE/DELETE.
--   • SELECT'e DOKUNULMAZ  → istemcinin kendi satırını okuması ve
--     `wheel_duel_queue` realtime aboneliği (WheelDuelGame.tsx:1473 / 1645)
--     aynen çalışır.
--   • RLS enable/disable veya policy YOK.
--   • Başka hiçbir tablo/mod/rol ACL'i değişmez. Bulk revoke YOK.
--
-- NEDEN GEREKLİ: köprü `q.profile_id = auth.uid()` eşitliğine güvenir.
-- İstemci kuyruğa satır yazabilirse saldırgan KENDİ profile_id'si + KURBANIN
-- player_id'si ile satır ekleyip kurban adına yetkilenir (lokal runtime,
-- H1 hipotezi: "INSERT BAŞARILI -> authorize=true").
--
-- NEDEN GÜVENLİ: `wheel_duel_quick_match` / `wheel_duel_cancel_quick_match`
-- SECURITY DEFINER'dır → kuyruğa sahip (owner) haklarıyla yazarlar, bu
-- revoke'tan ETKİLENMEZLER. İstemci kodunda kuyruğa DOĞRUDAN yazan tek bir
-- çağrı yoktur (yalnız .select(...) ve realtime aboneliği).
--
-- NOT (20260808 dersi): `revoke ... from public` tek başına YETMEZ — anon /
-- authenticated rollerine DOĞRUDAN verilmiş grant'ı kaldırmaz. Üçü de
-- açıkça yazılır.
-- ════════════════════════════════════════════════════════════════════════════
revoke insert, update, delete on table public.wheel_duel_queue from anon;
revoke insert, update, delete on table public.wheel_duel_queue from authenticated;
revoke insert, update, delete on table public.wheel_duel_queue from public;


-- ── DOĞRULAMA ────────────────────────────────────────────────────────────
do $$
declare
  r           record;
  v_fail      text := '';
  v_overloads int;
  v_priv      text;
begin
  for r in
    select unnest(array[
      'duel_authorize_player','duel_group_authorize_player',
      'conquest_authorize_player','wheel_duel_authorize_player',
      'wheel_group_authorize_player','flag_group_authorize_player',
      'route_duel_authorize_player'
    ]) as fname
  loop
    select count(*) into v_overloads
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fname;
    if v_overloads <> 1 then
      v_fail := v_fail || format(' [%s: overload=%s]', r.fname, v_overloads);
      continue;
    end if;

    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname = r.fname and p.prosecdef
    ) then
      v_fail := v_fail || format(' [%s: SECURITY DEFINER kayıp]', r.fname);
    end if;

    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname = r.fname
         and 'search_path=public, auth' = any(coalesce(p.proconfig, array[]::text[]))
    ) then
      v_fail := v_fail || format(' [%s: search_path beklenmedik]', r.fname);
    end if;

    -- Kanonik invariant gerçekten gövdede mi?
    if position('p.guest_id  is not null' in
                pg_get_functiondef(to_regprocedure('public.'||r.fname||'(uuid,uuid)'))) = 0 then
      v_fail := v_fail || format(' [%s: guest_id invariant YOK]', r.fname);
    end if;
  end loop;

  -- Çark köprüsü gövdede mi?
  if position('wheel_duel_queue' in
              pg_get_functiondef(to_regprocedure('public.wheel_duel_authorize_player(uuid,uuid)'))) = 0 then
    v_fail := v_fail || ' [wheel_duel_authorize_player: QM köprüsü YOK]';
  end if;

  -- Kuyruk yazma yetkileri gerçekten kapandı mı?
  foreach v_priv in array array['INSERT','UPDATE','DELETE'] loop
    if has_table_privilege('anon', 'public.wheel_duel_queue', v_priv)
    or has_table_privilege('authenticated', 'public.wheel_duel_queue', v_priv) then
      v_fail := v_fail || format(' [wheel_duel_queue: %s hâlâ açık]', v_priv);
    end if;
  end loop;

  -- SELECT'e dokunulmadığının teyidi (istemci + realtime buna bağlı)
  if not has_table_privilege('authenticated', 'public.wheel_duel_queue', 'SELECT') then
    v_fail := v_fail || ' [wheel_duel_queue: authenticated SELECT kaybolmuş — istemci bozulur]';
  end if;

  if v_fail <> '' then
    raise exception 'DOĞRULAMA BAŞARISIZ:%', v_fail;
  end if;

  raise notice 'OK: 7 helper kanonik misafir invariant''ına geçti; Çark QM köprüsü kuruldu; wheel_duel_queue yazma yetkileri kapandı (SELECT/RLS korunuyor).';
end $$;
