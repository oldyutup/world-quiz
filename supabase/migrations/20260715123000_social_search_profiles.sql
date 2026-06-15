-- ============================================================================
-- Sosyal: profile_code + search_public_profiles() RPC (oyuncu arama)
-- ============================================================================
-- Amac:
--   Arkadaşlar panelinden ve ileride paylaşılabilir profil kodu ile yeni oyuncu
--   bulup arkadaş ekleyebilmek. İki parça:
--
--   1) profiles.profile_code  — kısa, paylaşılabilir, benzersiz public kod.
--      Aynı username karışıklığını (örn. silinip yeniden alınan adlar) önler ve
--      "profilimi paylaş" için profesyonel bir kanca sağlar. Karışan karakterler
--      (0/O, 1/I/L) alfabeden çıkarıldı; 6 karakter. Yeni profillere trigger ile
--      otomatik atanır, mevcutlara migration içinde backfill edilir.
--
--   2) search_public_profiles(p_query) — username (prefix) VEYA profile_code
--      (tam) ile arama. SADECE public alanlar döner (gold/email/özel veri YOK).
--      relationship_status caller'a (auth.uid()) göre hesaplanır; kendini de
--      döndürür ('self'). N+1 yok (tek sorgu, profiles + cosmetics join).
--
-- GÜVENLİK:
--   * SECURITY DEFINER, search_path sabit. Yazma yok; yalnız okuma.
--   * Gold, email, username_normalized gibi alanlar DÖNMEZ.
--   * Arkadaş ekleme yine send_friend_request RPC'sinden geçer (bu RPC sadece
--     arama yapar, ilişki kurmaz).
--
-- Idempotent + elle uygulanır. Bağımlılık:
--   20260623120000_profile_username_change.sql (username_normalized),
--   20260715121000_social_core.sql (_social_level, friends, friend_requests,
--   profile_cosmetics).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) profiles.profile_code kolonu + benzersizlik
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists profile_code text;

-- Case-sensitive benzersiz (kod daima upper-case üretilir). Null'lar hariç.
create unique index if not exists profiles_profile_code_uniq
  on public.profiles (profile_code)
  where profile_code is not null;

-- ----------------------------------------------------------------------------
-- 2) Kod üreteci — karışan karakterler (0/O, 1/I/L) yok, 6 karakter.
-- ----------------------------------------------------------------------------
create or replace function public._gen_profile_code()
returns text
language plpgsql
volatile
as $fn$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- 31 char
  v_code text := '';
  i int;
begin
  for i in 1..6 loop
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_code;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 3) Yeni profillere otomatik kod atayan trigger (çakışmada yeniden dener)
-- ----------------------------------------------------------------------------
create or replace function public._assign_profile_code()
returns trigger
language plpgsql
as $fn$
declare
  v_code text;
  v_try  int := 0;
begin
  if new.profile_code is not null then
    return new;
  end if;
  loop
    v_code := public._gen_profile_code();
    exit when not exists (select 1 from public.profiles where profile_code = v_code);
    v_try := v_try + 1;
    if v_try > 20 then
      -- Aşırı çakışma (pratikte imkânsız): kodu uzatıp kesinlikle benzersiz yap.
      v_code := v_code || public._gen_profile_code();
      exit;
    end if;
  end loop;
  new.profile_code := v_code;
  return new;
end
$fn$;

drop trigger if exists trg_assign_profile_code on public.profiles;
create trigger trg_assign_profile_code
  before insert on public.profiles
  for each row
  execute function public._assign_profile_code();

-- ----------------------------------------------------------------------------
-- 4) Mevcut profillere backfill (tek seferlik; idempotent — null'lar kalmaz)
-- ----------------------------------------------------------------------------
do $$
declare
  r     record;
  v_code text;
  v_try int;
begin
  for r in select id from public.profiles where profile_code is null loop
    v_try := 0;
    loop
      v_code := public._gen_profile_code();
      exit when not exists (select 1 from public.profiles where profile_code = v_code);
      v_try := v_try + 1;
      if v_try > 30 then
        v_code := v_code || public._gen_profile_code();
        exit;
      end if;
    end loop;
    update public.profiles set profile_code = v_code where id = r.id;
  end loop;
end$$;

-- ----------------------------------------------------------------------------
-- 5) RPC: search_public_profiles
--    Username (prefix, case-insensitive) VEYA profile_code (tam) ile arama.
--    Sadece public alanlar. relationship_status caller'a göre.
-- ----------------------------------------------------------------------------
create or replace function public.search_public_profiles(p_query text)
returns table (
  profile_id             uuid,
  username               text,
  avatar_id              text,
  level                  int,
  profile_code           text,
  active_avatar_frame_id text,
  relationship_status    text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me   uuid := auth.uid();
  v_q    text;
  v_like text;
  v_code text;
begin
  -- "@username" girişini ve baştaki/sondaki boşlukları normalize et.
  v_q := lower(btrim(coalesce(p_query, '')));
  v_q := btrim(ltrim(v_q, '@'));

  -- Minimum 2 karakter (aşırı geniş arama + DoS engeli).
  if length(v_q) < 2 then
    return;
  end if;

  -- LIKE özel karakterlerini (\ _ %) escape et — username'lerde '_' geçerli.
  v_like := replace(v_q, '\', '\\');
  v_like := replace(v_like, '_', '\_');
  v_like := replace(v_like, '%', '\%');

  v_code := upper(v_q);

  return query
  select
    p.id,
    p.username,
    p.avatar_id,
    public._social_level(p.id),
    p.profile_code,
    c.active_avatar_frame_id,
    case
      when v_me is null then 'none'
      when p.id = v_me then 'self'
      when exists (
        select 1 from public.friends f
         where f.profile_id = v_me and f.friend_profile_id = p.id
      ) then 'friends'
      when exists (
        select 1 from public.friend_requests r
         where r.requester_profile_id = v_me and r.recipient_profile_id = p.id
           and r.status = 'pending'
      ) then 'request_sent'
      when exists (
        select 1 from public.friend_requests r
         where r.requester_profile_id = p.id and r.recipient_profile_id = v_me
           and r.status = 'pending'
      ) then 'request_received'
      else 'none'
    end as relationship_status
  from public.profiles p
  left join public.profile_cosmetics c on c.profile_id = p.id
  where p.username is not null
    and length(btrim(p.username)) > 0
    and (
      p.username_normalized like v_like || '%' escape '\'
      or p.profile_code = v_code
    )
  order by
    (p.profile_code = v_code) desc,         -- tam kod eşleşmesi en üstte
    (p.username_normalized = v_q) desc,      -- tam username eşleşmesi sonra
    lower(coalesce(p.username, '')) asc
  limit 20;
end
$fn$;

-- ----------------------------------------------------------------------------
-- 6) Grants
-- ----------------------------------------------------------------------------
revoke all on function public._gen_profile_code()      from public;
-- _gen_profile_code yalnız trigger/migration içinden kullanılır; doğrudan grant yok.

revoke all on function public.search_public_profiles(text) from public;
grant  execute on function public.search_public_profiles(text) to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor):
--   select profile_code from public.profiles limit 5;   -- 6 char, benzersiz
--   select * from public.search_public_profiles('en');  -- username prefix
--   select * from public.search_public_profiles('@en'); -- @ stripped
--   select * from public.search_public_profiles('ABC123'); -- profile_code tam
--   -- Gold/email kolonu DÖNMEMELİ; kendi profilin 'self' etiketli gelmeli.
-- ============================================================================
