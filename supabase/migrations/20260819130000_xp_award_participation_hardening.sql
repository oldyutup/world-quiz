-- ════════════════════════════════════════════════════════════════════════════
-- 20260819130000_xp_award_participation_hardening.sql
--
-- T-04 — award_*_xp_event: ODA KATILIM DOĞRULAMASI
--        (+ T-05'in tek canlı kalan yüzeyi: award_harita_duel_xp_event)
--
-- ════════════════════════════════════════════════════════════════════════════
-- SORUN
-- ─────
-- Tüm XP RPC'leri şunları ZATEN doğru yapıyordu:
--   • auth.uid() zorunlu            → misafir/anon XP alamaz
--   • v_uid = p_profile_id zorunlu  → başkasına XP yazılamaz
--   • clamp [0,500]
--   • on conflict (profile_id, mode_key, room_id) do nothing  → replay koruması
-- EKSİK olan: `p_room_id`'nin GERÇEK bir maç olduğu ve çağıranın O MAÇTA
-- oyuncu olduğu hiç doğrulanmıyordu. Her yeni rastgele UUID idempotency'yi
-- sıfırladığı için çağrı başına 500 XP sınırsız basılabiliyordu:
--     award_conquest_xp_event(auth.uid(), gen_random_uuid(), 500, 'win')
-- XP `get_*_leaderboard`'u beslediği için sıralama bütünlüğü de etkileniyordu.
--
-- ÇÖZÜM: her RPC'ye TEK kapı eklenir — çağıran, p_room_id'de KAYITLI oyuncu
-- olarak bulunmalı. Bu, rastgele UUID ile XP basmayı KESİN olarak kapatır.
--
-- ════════════════════════════════════════════════════════════════════════════
-- mode_key → AUTHORITATIVE ÜYELİK TABLOSU MATRİSİ
-- ───────────────────────────────────────────────
-- (canlı `award_xp_event` whitelist'i precheck'ten; üyelik tabloları
--  20260814180000'deki CANLI authorize fonksiyonlarından doğrulandı —
--  yedi tablonun da `profile_id` kolonu orada kullanılıyor)
--
--  mode_key       tablo                    istemci gönderiyor mu?   karar
--  ────────────── ──────────────────────── ──────────────────────── ─────────
--  country_duel   duel_players             EVET (DuelGame:586)      DOĞRULA
--  flag_duel      duel_players             EVET (FlagDuelGame:796)  DOĞRULA
--                 └ Bayrak Düello, Ülke Yaz ile AYNI duel_rooms/duel_players
--                   tablosunu paylaşır (room_kind ayırıcı) — ayrı tablo YOK.
--  wheel_duel     wheel_duel_players       EVET (WheelDuelGame:1065) DOĞRULA
--  group_country  duel_group_players       HAYIR (eski anahtar)     DOĞRULA
--  route_duel     route_duel_players       HAYIR (eski anahtar)     DOĞRULA
--  photo_duel     — (tablo YOK)            HAYIR (ölü)              REDDET
--  city_duel      — (tablo YOK)            HAYIR (ölü)              REDDET
--
-- Adanmış RPC'ler:
--  conquest       conquest_players         EVET (ConquestGame:1777) DOĞRULA
--  wheel_group    wheel_group_players      EVET (WheelGroupGame)    DOĞRULA
--  kornokta       tevatur_players          EVET (KorNoktaGame:474)  DOĞRULA
--  harita_duel    — (DB TABLOSU YOK)       HAYIR (erişilemez)       KAPAT
--
-- `group_country` ve `route_duel`: yayınlanmış istemci bu anahtarları XP için
-- KULLANMIYOR (ModeKey union'ında yoklar — progression.ts:29-36), ama gerçek
-- üyelik tabloları VAR. Körlemesine reddetmek yerine DOĞRULANIYORLAR: ileride
-- bu modlara XP eklenirse kapı hazır, bugün ise sahte UUID geçemiyor.
--
-- `photo_duel` / `city_duel`: repoda ne mod ne tablo var → doğrulanacak
-- otorite YOK. Körlemesine allow edilemezler; `unsupported_mode` ile reddedilir.
-- Yayınlanmış istemci bunları göndermediği için hiçbir yaşayan akış kırılmaz.
--
-- ════════════════════════════════════════════════════════════════════════════
-- award_harita_duel_xp_event — T-05'in CANLI KALAN YARISI
-- ───────────────────────────────────────────────────────
-- Çağ Dedektifi GAMEPLAY'i erişilemez (ana menü kartı yok, ROOM_SCREEN_MODE'da
-- yok, ONLINE_GATED_SCREENS'te yok → sessionStorage restore yolu hedefi siler;
-- yayınlanmış iOS bundle'ında da `id:"harita-duel-game"` 0 eşleşme) → gameplay
-- FIX_DEFERRED_UNREACHABLE olarak bırakılıyor.
-- ANCAK RPC'si `authenticated`'a grant'lıydı ve doğrudan çağrılabiliyordu; mod
-- broadcast-otoriter olduğu ve DB tablosu OLMADIĞI için doğrulanacak üyelik
-- kaydı da yok. Bu yüzden yüzey İKİ KATMANLI kapatılır:
--   (1) gövde her zaman awarded:false döner (sözleşme korunur, throw yok)
--   (2) EXECUTE anon + authenticated'dan geri alınır
-- Erişilebilir hiçbir istemci akışı bu RPC'yi çağırmadığı için regresyon yok.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ESKİ APP STORE İSTEMCİSİ İLE UYUM — SERVER_ONLY_BACKWARD_COMPATIBLE
-- ──────────────────────────────────────────────────────────────────
-- • Beş RPC'nin de İMZASI değişmedi.
-- • Dönüş sözleşmesi { awarded, reason, xp_earned, total_xp, mode_xp } aynı.
-- • Yeni red durumu mevcut `awarded:false` yolunu kullanır — istemci bunu
--   zaten `already_claimed` için işliyor (progression.ts:721-726) ve tanımadığı
--   `reason` değerlerini null'a indirger → ÇÖKME YOK, hata dalı bile tetiklenmez.
-- • Mevcut idempotency (on conflict) AYNEN korundu.
-- • Misafir zaten auth.uid() kapısında duruyordu; değişiklik yok.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- 0) GÜVENLİK KAPISI — canlı award_xp_event beklediğimiz fonksiyon mu?
-- ────────────────────────────────────────────────────────────────────
-- Bu fonksiyonun gövdesi REPO'DA YOK (dashboard'da oluşturulmuş, xp_events
-- tablosu gibi). Precheck'in bildirdiği sözleşmeye göre yeniden yazıyoruz.
-- Canlı gövde precheck'ten FARKLIYSA sessizce ezmek yerine migration DURUR.
-- Ayrıca orijinal tanım, geri dönüş için fonksiyon COMMENT'ine yedeklenir.
-- ════════════════════════════════════════════════════════════════════════════
do $guard$
declare
  v_src     text;
  v_olddef  text;
  v_comment text;
  v_missing text := '';
  k         text;
begin
  select p.prosrc, pg_get_functiondef(p.oid), obj_description(p.oid, 'pg_proc')
    into v_src, v_olddef, v_comment
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'award_xp_event'
     and pg_get_function_identity_arguments(p.oid) = 'p_profile_id uuid, p_mode_key text, p_room_id uuid, p_xp_earned integer, p_result text, p_details jsonb';

  if v_src is null then
    raise exception 'T-04 DURDU: award_xp_event(uuid,text,uuid,int,text,jsonb) bulunamadı — precheck imzası ile canlı imza uyuşmuyor.';
  end if;

  -- Precheck'in bildirdiği mode_key whitelist'i gerçekten gövdede mi?
  foreach k in array array[
    'country_duel','flag_duel','group_country','route_duel',
    'photo_duel','city_duel','wheel_duel'
  ] loop
    if position(k in v_src) = 0 then
      v_missing := v_missing || ' ' || k;
    end if;
  end loop;
  if v_missing <> '' then
    raise exception 'T-04 DURDU: canlı award_xp_event gövdesinde beklenen mode_key(ler) YOK:% — precheck çıktısı ile canlı gövde uyuşmuyor, körlemesine değiştirilmeyecek.', v_missing;
  end if;

  -- Idempotency koruması gerçekten mevcut mu? (korumamız gereken davranış)
  if position('on conflict' in lower(v_src)) = 0 then
    raise exception 'T-04 DURDU: canlı award_xp_event içinde `on conflict` idempotency''si görülmedi — davranış kaybı riski.';
  end if;

  -- Orijinal tanımı GERİ DÖNÜŞ için sakla (yalnız ilk çalıştırmada).
  if v_comment is null or position('T-04 BACKUP' in v_comment) = 0 then
    execute format(
      'comment on function public.award_xp_event(uuid,text,uuid,int,text,jsonb) is %L',
      E'T-04 BACKUP (20260819130000) — katılım doğrulaması eklenmeden ÖNCEKİ tanım:\n\n' || v_olddef
    );
    raise notice 'T-04: orijinal award_xp_event tanımı COMMENT içine yedeklendi (rollback için).';
  else
    raise notice 'T-04: yedek zaten mevcut, korunuyor (idempotent tekrar çalıştırma).';
  end if;
end
$guard$;


-- ════════════════════════════════════════════════════════════════════════════
-- 1) ÜYELİK YARDIMCISI — tek bakım noktası, dinamik SQL YOK
-- ────────────────────────────────────────────────────────
-- Her mode_key için STATİK bir exists sorgusu. `security definer` çünkü
-- players tablolarını RLS'ten bağımsız okuması gerekir; istemci rollerine
-- EXECUTE verilmez (yalnız XP RPC'leri çağırır).
--
-- ⚠ MİSAFİR: kasten `profile_id = p_uid` aranır. Misafir satırlarında
--   profile_id NULL'dur → misafir hiçbir zaman eşleşmez. XP zaten
--   auth.uid() gerektiriyordu; bu ikinci katman.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public._xp_is_room_participant(
  p_mode_key text,
  p_room_id  uuid,
  p_uid      uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if p_room_id is null or p_uid is null then
    return false;
  end if;

  -- Ülke Yaz 1v1 ve Bayrak Düello AYNI tabloyu paylaşır (room_kind ayırıcı).
  if p_mode_key in ('country_duel', 'flag_duel') then
    return exists (
      select 1 from public.duel_players
       where room_id = p_room_id and profile_id = p_uid
    );

  elsif p_mode_key = 'wheel_duel' then
    return exists (
      select 1 from public.wheel_duel_players
       where room_id = p_room_id and profile_id = p_uid
    );

  elsif p_mode_key = 'group_country' then
    return exists (
      select 1 from public.duel_group_players
       where room_id = p_room_id and profile_id = p_uid
    );

  elsif p_mode_key = 'route_duel' then
    return exists (
      select 1 from public.route_duel_players
       where room_id = p_room_id and profile_id = p_uid
    );

  elsif p_mode_key = 'wheel_group' then
    return exists (
      select 1 from public.wheel_group_players
       where room_id = p_room_id and profile_id = p_uid
    );

  elsif p_mode_key = 'conquest' then
    return exists (
      select 1 from public.conquest_players
       where room_id = p_room_id and profile_id = p_uid
    );

  elsif p_mode_key = 'kornokta' then
    return exists (
      select 1 from public.tevatur_players
       where room_id = p_room_id and profile_id = p_uid
    );
  end if;

  -- photo_duel / city_duel / harita_duel ve bilinmeyen her anahtar:
  -- doğrulanacak otorite YOK → asla katılımcı sayılmaz.
  return false;
end
$fn$;

revoke all     on function public._xp_is_room_participant(text, uuid, uuid) from public;
revoke all     on function public._xp_is_room_participant(text, uuid, uuid) from anon;
revoke all     on function public._xp_is_room_participant(text, uuid, uuid) from authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 2) GENERIC — award_xp_event
--    country_duel / flag_duel / wheel_duel (canlı) + group_country /
--    route_duel (eski anahtar) doğrulanır; photo_duel / city_duel reddedilir.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.award_xp_event(
  p_profile_id uuid,
  p_mode_key   text,
  p_room_id    uuid,
  p_xp_earned  int,
  p_result     text,
  p_details    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_allowed  text[] := array[
    'country_duel','flag_duel','group_country','route_duel',
    'photo_duel','city_duel','wheel_duel'
  ];
  -- Doğrulanacak otoritesi OLAN anahtarlar (matris yukarıda).
  v_verifiable text[] := array[
    'country_duel','flag_duel','wheel_duel','group_country','route_duel'
  ];
  v_clamped  int;
  v_inserted boolean := false;
  v_total_xp int;
  v_mode_xp  int;
begin
  if v_uid is null then
    raise exception 'auth_required'
      using hint = 'award_xp_event requires authenticated user';
  end if;

  if v_uid <> p_profile_id then
    raise exception 'profile_id_mismatch (uid=% profile_id=%)', v_uid, p_profile_id
      using hint = 'p_profile_id must equal auth.uid()';
  end if;

  if not (p_mode_key = any(v_allowed)) then
    raise exception 'invalid_mode_key: %', p_mode_key
      using hint = 'p_mode_key is not in the allowed list';
  end if;

  if p_result not in ('win', 'draw', 'loss') then
    raise exception 'invalid_result: %', p_result
      using hint = 'p_result must be one of: win, draw, loss';
  end if;

  -- ── T-04 KAPISI ─────────────────────────────────────────────────────────
  -- Doğrulanacak otoritesi olmayan ölü anahtarlar körlemesine geçemez.
  if not (p_mode_key = any(v_verifiable)) then
    select coalesce(sum(xp_earned), 0)::int into v_total_xp
      from public.xp_events where profile_id = p_profile_id;
    select coalesce(sum(xp_earned), 0)::int into v_mode_xp
      from public.xp_events
     where profile_id = p_profile_id and mode_key = p_mode_key;
    return jsonb_build_object(
      'awarded', false, 'reason', 'unsupported_mode',
      'xp_earned', 0, 'total_xp', v_total_xp, 'mode_xp', v_mode_xp
    );
  end if;

  -- Rastgele UUID ile XP basma yolu burada KAPANIR.
  if not public._xp_is_room_participant(p_mode_key, p_room_id, v_uid) then
    select coalesce(sum(xp_earned), 0)::int into v_total_xp
      from public.xp_events where profile_id = p_profile_id;
    select coalesce(sum(xp_earned), 0)::int into v_mode_xp
      from public.xp_events
     where profile_id = p_profile_id and mode_key = p_mode_key;
    return jsonb_build_object(
      'awarded', false, 'reason', 'not_a_participant',
      'xp_earned', 0, 'total_xp', v_total_xp, 'mode_xp', v_mode_xp
    );
  end if;
  -- ────────────────────────────────────────────────────────────────────────

  v_clamped := greatest(0, least(500, coalesce(p_xp_earned, 0)));

  if v_clamped > 0 then
    insert into public.xp_events (
      profile_id, mode_key, room_id, xp_earned, result, details
    )
    values (
      p_profile_id, p_mode_key, p_room_id, v_clamped, p_result,
      coalesce(p_details, '{}'::jsonb)
    )
    on conflict (profile_id, mode_key, room_id) do nothing;

    if found then
      v_inserted := true;
    end if;
  end if;

  select coalesce(sum(xp_earned), 0)::int
    into v_total_xp
    from public.xp_events
   where profile_id = p_profile_id;

  select coalesce(sum(xp_earned), 0)::int
    into v_mode_xp
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = p_mode_key;

  if v_inserted then
    return jsonb_build_object(
      'awarded',   true,
      'reason',    null,
      'xp_earned', v_clamped,
      'total_xp',  v_total_xp,
      'mode_xp',   v_mode_xp
    );
  end if;

  return jsonb_build_object(
    'awarded',   false,
    'reason',    'already_claimed',
    'xp_earned', 0,
    'total_xp',  v_total_xp,
    'mode_xp',   v_mode_xp
  );
end
$fn$;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) ADANMIŞ RPC'LER — conquest / wheel_group / kornokta
--    Gövdeler repo'daki CANLI hâlleriyle birebir; TEK fark katılım kapısı.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.award_conquest_xp_event(
  p_profile_id uuid,
  p_room_id    uuid,
  p_xp_earned  int,
  p_result     text,
  p_details    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_clamped   int;
  v_inserted  boolean := false;
  v_total_xp  int;
  v_mode_xp   int;
begin
  if v_uid is null then
    raise exception 'auth_required'
      using hint = 'award_conquest_xp_event requires authenticated user';
  end if;

  if v_uid <> p_profile_id then
    raise exception 'profile_id_mismatch (uid=% profile_id=%)', v_uid, p_profile_id
      using hint = 'p_profile_id must equal auth.uid()';
  end if;

  if p_result not in ('win', 'draw', 'loss') then
    raise exception 'invalid_result: %', p_result
      using hint = 'p_result must be one of: win, draw, loss';
  end if;

  -- ── T-04 KAPISI ──
  if not public._xp_is_room_participant('conquest', p_room_id, v_uid) then
    select coalesce(sum(xp_earned), 0)::int into v_total_xp
      from public.xp_events where profile_id = p_profile_id;
    select coalesce(sum(xp_earned), 0)::int into v_mode_xp
      from public.xp_events
     where profile_id = p_profile_id and mode_key = 'conquest';
    return jsonb_build_object(
      'awarded', false, 'reason', 'not_a_participant',
      'xp_earned', 0, 'total_xp', v_total_xp, 'mode_xp', v_mode_xp
    );
  end if;

  v_clamped := greatest(0, least(500, coalesce(p_xp_earned, 0)));

  if v_clamped > 0 then
    insert into public.xp_events (
      profile_id, mode_key, room_id, xp_earned, result, details
    )
    values (
      p_profile_id, 'conquest', p_room_id, v_clamped, p_result,
      coalesce(p_details, '{}'::jsonb)
    )
    on conflict (profile_id, mode_key, room_id) do nothing;

    if found then
      v_inserted := true;
    end if;
  end if;

  select coalesce(sum(xp_earned), 0)::int
    into v_total_xp
    from public.xp_events
   where profile_id = p_profile_id;

  select coalesce(sum(xp_earned), 0)::int
    into v_mode_xp
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = 'conquest';

  if v_inserted then
    return jsonb_build_object(
      'awarded',   true,
      'reason',    null,
      'xp_earned', v_clamped,
      'total_xp',  v_total_xp,
      'mode_xp',   v_mode_xp
    );
  end if;

  return jsonb_build_object(
    'awarded',   false,
    'reason',    'already_claimed',
    'xp_earned', 0,
    'total_xp',  v_total_xp,
    'mode_xp',   v_mode_xp
  );
end
$fn$;


create or replace function public.award_wheel_group_xp_event(
  p_profile_id uuid,
  p_room_id    uuid,
  p_xp_earned  int,
  p_result     text,
  p_details    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_clamped   int;
  v_inserted  boolean := false;
  v_total_xp  int;
  v_mode_xp   int;
begin
  if v_uid is null then
    raise exception 'auth_required'
      using hint = 'award_wheel_group_xp_event requires authenticated user';
  end if;

  if v_uid <> p_profile_id then
    raise exception 'profile_id_mismatch (uid=% profile_id=%)', v_uid, p_profile_id
      using hint = 'p_profile_id must equal auth.uid()';
  end if;

  if p_result not in ('win', 'draw', 'loss') then
    raise exception 'invalid_result: %', p_result
      using hint = 'p_result must be one of: win, draw, loss';
  end if;

  -- ── T-04 KAPISI ──
  if not public._xp_is_room_participant('wheel_group', p_room_id, v_uid) then
    select coalesce(sum(xp_earned), 0)::int into v_total_xp
      from public.xp_events where profile_id = p_profile_id;
    select coalesce(sum(xp_earned), 0)::int into v_mode_xp
      from public.xp_events
     where profile_id = p_profile_id and mode_key = 'wheel_group';
    return jsonb_build_object(
      'awarded', false, 'reason', 'not_a_participant',
      'xp_earned', 0, 'total_xp', v_total_xp, 'mode_xp', v_mode_xp
    );
  end if;

  v_clamped := greatest(0, least(500, coalesce(p_xp_earned, 0)));

  if v_clamped > 0 then
    insert into public.xp_events (
      profile_id, mode_key, room_id, xp_earned, result, details
    )
    values (
      p_profile_id, 'wheel_group', p_room_id, v_clamped, p_result,
      coalesce(p_details, '{}'::jsonb)
    )
    on conflict (profile_id, mode_key, room_id) do nothing;

    if found then
      v_inserted := true;
    end if;
  end if;

  select coalesce(sum(xp_earned), 0)::int
    into v_total_xp
    from public.xp_events
   where profile_id = p_profile_id;

  select coalesce(sum(xp_earned), 0)::int
    into v_mode_xp
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = 'wheel_group';

  if v_inserted then
    return jsonb_build_object(
      'awarded',   true,
      'reason',    null,
      'xp_earned', v_clamped,
      'total_xp',  v_total_xp,
      'mode_xp',   v_mode_xp
    );
  end if;

  return jsonb_build_object(
    'awarded',   false,
    'reason',    'already_claimed',
    'xp_earned', 0,
    'total_xp',  v_total_xp,
    'mode_xp',   v_mode_xp
  );
end
$fn$;


create or replace function public.award_kornokta_xp_event(
  p_profile_id uuid,
  p_room_id    uuid,
  p_xp_earned  int,
  p_result     text,
  p_details    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_clamped   int;
  v_inserted  boolean := false;
  v_total_xp  int;
  v_mode_xp   int;
begin
  if v_uid is null then
    raise exception 'auth_required'
      using hint = 'award_kornokta_xp_event requires authenticated user';
  end if;

  if v_uid <> p_profile_id then
    raise exception 'profile_id_mismatch (uid=% profile_id=%)', v_uid, p_profile_id
      using hint = 'p_profile_id must equal auth.uid()';
  end if;

  if p_result not in ('win', 'draw', 'loss') then
    raise exception 'invalid_result: %', p_result
      using hint = 'p_result must be one of: win, draw, loss';
  end if;

  -- ── T-04 KAPISI ──
  if not public._xp_is_room_participant('kornokta', p_room_id, v_uid) then
    select coalesce(sum(xp_earned), 0)::int into v_total_xp
      from public.xp_events where profile_id = p_profile_id;
    select coalesce(sum(xp_earned), 0)::int into v_mode_xp
      from public.xp_events
     where profile_id = p_profile_id and mode_key = 'kornokta';
    return jsonb_build_object(
      'awarded', false, 'reason', 'not_a_participant',
      'xp_earned', 0, 'total_xp', v_total_xp, 'mode_xp', v_mode_xp
    );
  end if;

  v_clamped := greatest(0, least(500, coalesce(p_xp_earned, 0)));

  if v_clamped > 0 then
    insert into public.xp_events (
      profile_id, mode_key, room_id, xp_earned, result, details
    )
    values (
      p_profile_id, 'kornokta', p_room_id, v_clamped, p_result,
      coalesce(p_details, '{}'::jsonb)
    )
    on conflict (profile_id, mode_key, room_id) do nothing;

    if found then
      v_inserted := true;
    end if;
  end if;

  select coalesce(sum(xp_earned), 0)::int
    into v_total_xp
    from public.xp_events
   where profile_id = p_profile_id;

  select coalesce(sum(xp_earned), 0)::int
    into v_mode_xp
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = 'kornokta';

  if v_inserted then
    return jsonb_build_object(
      'awarded',   true,
      'reason',    null,
      'xp_earned', v_clamped,
      'total_xp',  v_total_xp,
      'mode_xp',   v_mode_xp
    );
  end if;

  return jsonb_build_object(
    'awarded',   false,
    'reason',    'already_claimed',
    'xp_earned', 0,
    'total_xp',  v_total_xp,
    'mode_xp',   v_mode_xp
  );
end
$fn$;


-- ════════════════════════════════════════════════════════════════════════════
-- 4) award_harita_duel_xp_event — XP MINT YÜZEYİNİ KAPAT (iki katman)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.award_harita_duel_xp_event(
  p_profile_id uuid,
  p_room_id    uuid,
  p_xp_earned  int,
  p_result     text,
  p_details    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_total_xp int;
  v_mode_xp  int;
begin
  -- Çağ Dedektifi UI'da erişilemez ve broadcast-otoriter olduğu için
  -- doğrulanacak DB üyelik kaydı YOK → hiçbir koşulda XP yazılmaz.
  -- Sözleşme korunur (throw yok): istemci bunu `awarded:false` olarak okur.
  if v_uid is null or v_uid <> p_profile_id then
    return jsonb_build_object(
      'awarded', false, 'reason', 'unsupported_mode',
      'xp_earned', 0, 'total_xp', 0, 'mode_xp', 0
    );
  end if;

  select coalesce(sum(xp_earned), 0)::int into v_total_xp
    from public.xp_events where profile_id = p_profile_id;
  select coalesce(sum(xp_earned), 0)::int into v_mode_xp
    from public.xp_events
   where profile_id = p_profile_id and mode_key = 'harita_duel';

  return jsonb_build_object(
    'awarded', false, 'reason', 'unsupported_mode',
    'xp_earned', 0, 'total_xp', v_total_xp, 'mode_xp', v_mode_xp
  );
end
$fn$;


-- ════════════════════════════════════════════════════════════════════════════
-- 5) GRANTS — anon least-privilege, authenticated KORUNUR
--    (harita_duel her iki rolden de kapatılır)
-- ════════════════════════════════════════════════════════════════════════════
revoke execute on function public.award_xp_event(uuid, text, uuid, int, text, jsonb) from anon;
revoke execute on function public.award_xp_event(uuid, text, uuid, int, text, jsonb) from public;
grant  execute on function public.award_xp_event(uuid, text, uuid, int, text, jsonb) to authenticated;

revoke execute on function public.award_conquest_xp_event(uuid, uuid, int, text, jsonb) from anon;
revoke execute on function public.award_conquest_xp_event(uuid, uuid, int, text, jsonb) from public;
grant  execute on function public.award_conquest_xp_event(uuid, uuid, int, text, jsonb) to authenticated;

revoke execute on function public.award_wheel_group_xp_event(uuid, uuid, int, text, jsonb) from anon;
revoke execute on function public.award_wheel_group_xp_event(uuid, uuid, int, text, jsonb) from public;
grant  execute on function public.award_wheel_group_xp_event(uuid, uuid, int, text, jsonb) to authenticated;

revoke execute on function public.award_kornokta_xp_event(uuid, uuid, int, text, jsonb) from anon;
revoke execute on function public.award_kornokta_xp_event(uuid, uuid, int, text, jsonb) from public;
grant  execute on function public.award_kornokta_xp_event(uuid, uuid, int, text, jsonb) to authenticated;

-- T-05'in canlı yüzeyi: hiçbir istemci rolüne bırakılmaz.
revoke execute on function public.award_harita_duel_xp_event(uuid, uuid, int, text, jsonb) from anon;
revoke execute on function public.award_harita_duel_xp_event(uuid, uuid, int, text, jsonb) from public;
revoke execute on function public.award_harita_duel_xp_event(uuid, uuid, int, text, jsonb) from authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_fail text := '';
  v_sig  text;
begin
  -- (1) beş RPC de imzasını korudu + SECURITY DEFINER + search_path
  foreach v_sig in array array[
    'public.award_xp_event(uuid,text,uuid,int,text,jsonb)',
    'public.award_conquest_xp_event(uuid,uuid,int,text,jsonb)',
    'public.award_wheel_group_xp_event(uuid,uuid,int,text,jsonb)',
    'public.award_kornokta_xp_event(uuid,uuid,int,text,jsonb)',
    'public.award_harita_duel_xp_event(uuid,uuid,int,text,jsonb)'
  ] loop
    if to_regprocedure(v_sig) is null then
      v_fail := v_fail || format(' [İMZA KAYBOLDU: %s]', v_sig);
    end if;
  end loop;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('award_xp_event','award_conquest_xp_event',
                         'award_wheel_group_xp_event','award_kornokta_xp_event',
                         'award_harita_duel_xp_event','_xp_is_room_participant')
       and (not p.prosecdef
            or p.proconfig is null
            or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
  ) then
    v_fail := v_fail || ' [SECURITY DEFINER / search_path eksik fonksiyon var]';
  end if;

  -- (2) YAŞAYAN akışlar korunmalı: authenticated EXECUTE duruyor mu
  foreach v_sig in array array[
    'public.award_xp_event(uuid,text,uuid,int,text,jsonb)',
    'public.award_conquest_xp_event(uuid,uuid,int,text,jsonb)',
    'public.award_wheel_group_xp_event(uuid,uuid,int,text,jsonb)',
    'public.award_kornokta_xp_event(uuid,uuid,int,text,jsonb)'
  ] loop
    if not has_function_privilege('authenticated', v_sig, 'EXECUTE') then
      v_fail := v_fail || format(' [authenticated EXECUTE KAYBOLDU: %s — meşru XP kırılır]', v_sig);
    end if;
  end loop;

  -- (3) anon her dördünde de kapandı
  foreach v_sig in array array[
    'public.award_xp_event(uuid,text,uuid,int,text,jsonb)',
    'public.award_conquest_xp_event(uuid,uuid,int,text,jsonb)',
    'public.award_wheel_group_xp_event(uuid,uuid,int,text,jsonb)',
    'public.award_kornokta_xp_event(uuid,uuid,int,text,jsonb)'
  ] loop
    if has_function_privilege('anon', v_sig, 'EXECUTE') then
      v_fail := v_fail || format(' [anon EXECUTE HÂLÂ AÇIK: %s]', v_sig);
    end if;
  end loop;

  -- (4) harita_duel HİÇBİR istemci rolünde kalmadı
  if has_function_privilege('authenticated',
        'public.award_harita_duel_xp_event(uuid,uuid,int,text,jsonb)', 'EXECUTE')
     or has_function_privilege('anon',
        'public.award_harita_duel_xp_event(uuid,uuid,int,text,jsonb)', 'EXECUTE') then
    v_fail := v_fail || ' [award_harita_duel_xp_event HÂLÂ istemciye AÇIK]';
  end if;

  -- (5) üyelik yardımcısı istemciye kapalı
  if has_function_privilege('authenticated',
        'public._xp_is_room_participant(text,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('anon',
        'public._xp_is_room_participant(text,uuid,uuid)', 'EXECUTE') then
    v_fail := v_fail || ' [_xp_is_room_participant istemciye AÇILMIŞ — olmamalı]';
  end if;

  -- (6) matristeki yedi üyelik tablosu + profile_id kolonu gerçekten var
  if (select count(*) from information_schema.columns
       where table_schema = 'public'
         and column_name  = 'profile_id'
         and table_name in ('duel_players','duel_group_players','wheel_duel_players',
                            'wheel_group_players','conquest_players','tevatur_players',
                            'route_duel_players')) <> 7 then
    v_fail := v_fail || ' [üyelik tablolarından biri veya profile_id kolonu YOK — matris geçersiz]';
  end if;

  -- (7) idempotency dayanağı: xp_events benzersizliği duruyor mu
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'xp_events'
       and indexdef ilike '%unique%'
       and indexdef ilike '%profile_id%'
       and indexdef ilike '%mode_key%'
       and indexdef ilike '%room_id%'
  ) then
    v_fail := v_fail || ' [xp_events (profile_id,mode_key,room_id) UNIQUE index bulunamadı — on conflict çalışmaz]';
  end if;

  if v_fail <> '' then
    raise exception 'T-04 DOĞRULAMA BAŞARISIZ:%', v_fail;
  end if;

  raise notice 'OK (T-04): beş XP RPC''sinde katılım kapısı aktif; imzalar, dönüş sözleşmesi ve idempotency korundu; harita_duel mint yüzeyi kapatıldı; anon EXECUTE geri alındı.';
end $$;
