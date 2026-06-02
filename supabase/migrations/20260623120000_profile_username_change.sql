-- ============================================================================
-- Profile: kullanıcı adı değiştirme V1
-- ============================================================================
-- Amac:
--   Profil panelinden kullanıcı adı değiştirme akışı için server-side RPC ve
--   profiles tablosuna gerekli alanları eklemek.
--
-- Kurallar (V1):
--   * İlk kullanıcı adı seçimi (username_change_count = 0) ücretsizdir.
--   * Sonraki her değişiklik 500 Gold harcatır.
--   * Her değişiklik sonrası 14 gün cooldown başlar.
--   * Username case-insensitive olarak unique olmalıdır
--     (username_normalized kolonu üzerinden).
--   * Regex: ^[a-z0-9_]{3,16}$ — Türkçe karakter, boşluk, emoji, nokta, tire
--     V1'de yasak. (Eski kayıtlar olduğu gibi kalır; sadece yeni değişiklik
--     bu regex'e tabi.)
--   * Yasaklı isimler reddedilir (admin, mod, torble, ...).
--
-- DOKUNMAZ:
--   * xp_events / award_xp_event ailesi
--   * profiles.gold daily_bonus yazımı (client-side mevcut akışı bozulmaz)
--   * Leaderboard RPC'leri (username alanını oldugu gibi okur)
--   * Kader Karti, Kusatma, Bayrak, Çark gameplay
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) profiles şema değişiklikleri
-- ----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists username_normalized   text,
  add column if not exists username_changed_at   timestamptz,
  add column if not exists username_change_count int not null default 0;

-- Mevcut kayıtlar için backfill (normalize = lower(btrim(username))).
update public.profiles
   set username_normalized = lower(btrim(username))
 where username is not null
   and length(btrim(username)) > 0
   and username_normalized is null;

-- Case-insensitive unique: null değerlerini dışarıda bırakan partial index.
create unique index if not exists profiles_username_normalized_uniq
  on public.profiles (username_normalized)
  where username_normalized is not null;


-- ----------------------------------------------------------------------------
-- 2) change_username RPC
-- ----------------------------------------------------------------------------
-- Imza:   change_username(p_new_username text) -> jsonb
-- Cevap:  her durumda jsonb. Başarılıysa { ok: true, username, gold, was_first,
--         cost }. Hata durumunda { ok: false, code, message, ... }.
--
-- Server tarafı kontrolleri:
--   * auth.uid() null mı?
--   * format & uzunluk
--   * yasaklı kelime
--   * mevcut adla aynı mı
--   * cooldown (14 gün, sadece >=2. değişiklik için)
--   * Gold yeterli mi (sadece >=2. değişiklik için, 500 Gold)
--   * Username başkasında mı (case-insensitive)
--
-- Profil güncellemesi ve Gold düşmesi aynı transaction içinde,
-- profil satırı `for update` ile kilitlenerek yapılır.

create or replace function public.change_username(p_new_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid             uuid := auth.uid();
  v_raw             text;
  v_clean           text;
  v_norm            text;
  v_cur_username    text;
  v_cur_norm        text;
  v_change_count    int;
  v_last_change     timestamptz;
  v_gold            int;
  v_is_first        boolean;
  v_cost            int := 500;
  v_cooldown        interval := interval '14 days';
  v_seconds_left    bigint;
  v_days_left       int;
  v_banned          text[] := array[
    'admin','administrator','moderator','mod','system','sistem',
    'torble','bot','npc','test','support','destek','official',
    'owner','root','staff','null','undefined','geoquiz','geo_quiz',
    'developer','dev','yetkili','kurucu','yonetici','help','helper'
  ];
begin
  if v_uid is null then
    return jsonb_build_object(
      'ok', false, 'code', 'unauthenticated',
      'message', 'Giriş yapmalısın.'
    );
  end if;

  if p_new_username is null then
    return jsonb_build_object(
      'ok', false, 'code', 'invalid_format',
      'message', 'Kullanıcı adı boş olamaz.'
    );
  end if;

  -- Temizleme: trim + baştaki '@' karakterini at + lowercase.
  v_raw := btrim(p_new_username);
  if left(v_raw, 1) = '@' then
    v_raw := substr(v_raw, 2);
  end if;
  v_clean := lower(v_raw);

  if length(v_clean) < 3 then
    return jsonb_build_object(
      'ok', false, 'code', 'too_short',
      'message', 'Kullanıcı adı en az 3 karakter olmalı.'
    );
  end if;
  if length(v_clean) > 16 then
    return jsonb_build_object(
      'ok', false, 'code', 'too_long',
      'message', 'Kullanıcı adı en fazla 16 karakter olabilir.'
    );
  end if;

  if v_clean !~ '^[a-z0-9_]+$' then
    return jsonb_build_object(
      'ok', false, 'code', 'invalid_format',
      'message', 'Sadece küçük harf (a-z), rakam ve alt çizgi kullanılabilir.'
    );
  end if;

  if v_clean = any(v_banned) then
    return jsonb_build_object(
      'ok', false, 'code', 'banned',
      'message', 'Bu kullanıcı adı kullanılamaz.'
    );
  end if;

  v_norm := v_clean;

  -- Mevcut profil satırını kilitle.
  select p.username, p.username_normalized, p.username_change_count,
         p.username_changed_at, p.gold
    into v_cur_username, v_cur_norm, v_change_count, v_last_change, v_gold
    from public.profiles p
   where p.id = v_uid
   for update;

  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'no_profile',
      'message', 'Profil bulunamadı.'
    );
  end if;

  -- Aynı isim tekrar girilirse işlem yapma.
  if coalesce(v_cur_norm, lower(coalesce(v_cur_username, '')), '') = v_norm then
    return jsonb_build_object(
      'ok', false, 'code', 'same_as_current',
      'message', 'Bu zaten mevcut kullanıcı adın.'
    );
  end if;

  v_is_first := coalesce(v_change_count, 0) = 0;

  -- Cooldown sadece >=2. değişiklik için geçerli.
  if not v_is_first and v_last_change is not null
     and now() < v_last_change + v_cooldown then
    v_seconds_left := extract(epoch from (v_last_change + v_cooldown - now()))::bigint;
    v_days_left    := greatest(1, ceil(v_seconds_left / 86400.0)::int);
    return jsonb_build_object(
      'ok',         false,
      'code',       'cooldown',
      'days_left',  v_days_left,
      'message',    format(
        'Kullanıcı adını tekrar değiştirmek için %s gün beklemelisin.',
        v_days_left
      )
    );
  end if;

  -- Gold yeterli mi? (sadece ücretli değişiklikte)
  if not v_is_first then
    if coalesce(v_gold, 0) < v_cost then
      return jsonb_build_object(
        'ok',      false,
        'code',    'insufficient_gold',
        'cost',    v_cost,
        'gold',    coalesce(v_gold, 0),
        'message', format(
          'Bu işlem %s Gold gerektiriyor. Yeterli Gold''un yok.',
          v_cost
        )
      );
    end if;
  end if;

  -- Username başkasında mı? (case-insensitive, partial index üzerinden)
  if exists (
    select 1 from public.profiles
     where username_normalized = v_norm
       and id <> v_uid
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'taken',
      'message', 'Bu kullanıcı adı başka biri tarafından alınmış.'
    );
  end if;

  -- Tüm kontroller geçti — atomik update.
  update public.profiles
     set username              = v_clean,
         username_normalized   = v_norm,
         username_changed_at   = now(),
         username_change_count = coalesce(username_change_count, 0) + 1,
         gold                  = case
                                   when v_is_first then coalesce(gold, 0)
                                   else greatest(0, coalesce(gold, 0) - v_cost)
                                 end,
         updated_at            = now()
   where id = v_uid;

  return jsonb_build_object(
    'ok',        true,
    'username',  v_clean,
    'gold',      case
                   when v_is_first then coalesce(v_gold, 0)
                   else greatest(0, coalesce(v_gold, 0) - v_cost)
                 end,
    'was_first', v_is_first,
    'cost',      case when v_is_first then 0 else v_cost end
  );

exception when unique_violation then
  -- Race condition: aynı anda iki kullanıcı aynı adı almaya kalkıştıysa.
  return jsonb_build_object(
    'ok', false, 'code', 'taken',
    'message', 'Bu kullanıcı adı başka biri tarafından alınmış.'
  );
end
$fn$;


-- ----------------------------------------------------------------------------
-- 3) Grants
-- ----------------------------------------------------------------------------

revoke all on function public.change_username(text) from public;
grant  execute on function public.change_username(text) to authenticated;


-- ============================================================================
-- Doğrulama
-- ============================================================================
--   -- alanların eklendiğini doğrula:
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'profiles'
--      and column_name in (
--        'username_normalized','username_changed_at','username_change_count'
--      );
--
--   -- partial unique index:
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public' and tablename = 'profiles'
--      and indexname = 'profiles_username_normalized_uniq';
--
--   -- RPC çağrı:
--   select public.change_username('yeniAd');
-- ============================================================================
