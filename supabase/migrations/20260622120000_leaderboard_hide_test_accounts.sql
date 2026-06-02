-- ============================================================================
-- Leaderboard: hide test accounts
-- ============================================================================
-- Amac:
--   Leaderboard modalindaki XP ve Gold sıralamalarindan test/deneme amacli
--   hesaplari gizlemek. Bu hesaplar XP/Gold testleri sirasinda sismis oldugu
--   icin gercek kullanicilarin onune geciyorlardi.
--
-- Strateji:
--   * profiles tablosuna `is_test_account boolean not null default false` ekle.
--   * Bilinen test hesaplarini (username) bu bayrak ile isaretle. Patern
--     bazli ('test%') filtre KULLANILMIYOR — gercek bir kullanicinin adi
--     yanlislikla test'e dusmesin diye sadece NET liste isaretleniyor.
--   * get_xp_leaderboard / get_gold_leaderboard RPC'lerine
--       coalesce(p.is_test_account, false) = false
--     filtresi ekle. Yazim (xp_events, gold update) sistemine dokunmuyoruz —
--     sadece leaderboard gorunurlugunu degistiriyoruz.
--
-- DOKUNMAZ:
--   * xp_events (yazim/insert/RPC davranisi)
--   * profiles.gold yazimi
--   * award_xp_event / award_wheel_group_xp_event / award_conquest_xp_event
--   * Kader Karti, Kusatma, Bayrak, Cark gameplay
--   * Seed / Baslangic rakibi sistemi (is_test_account default false oldugu
--     icin etkilenmez)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) profiles.is_test_account
-- ----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists is_test_account boolean not null default false;


-- ----------------------------------------------------------------------------
-- 2) Bilinen test hesaplarini isaretle
-- ----------------------------------------------------------------------------
-- Net liste — sadece bu username'ler. @erkam, @holosko vb. gercek
-- kullanicilar etkilenmez. lower() ile case-insensitive match.

update public.profiles
   set is_test_account = true
 where lower(username) in ('testet', 'testet41', 'testt1');


-- ----------------------------------------------------------------------------
-- 3) get_xp_leaderboard — test hesaplari filtresi eklenmis hali
-- ----------------------------------------------------------------------------
-- Bir onceki migration (20260621120000_leaderboard_rpcs.sql) ile birebir
-- ayni imza/davranis; tek fark `where ... and coalesce(p.is_test_account,
-- false) = false` filtresi.

create or replace function public.get_xp_leaderboard(
  p_scope text default 'general',
  p_limit int  default 10
)
returns table (
  profile_id uuid,
  username   text,
  xp         int,
  total_xp   int,
  level      int
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_limit int;
  v_modes text[];
begin
  v_limit := greatest(1, least(50, coalesce(p_limit, 10)));

  v_modes := case lower(coalesce(p_scope, 'general'))
    when 'general'  then null
    when 'country'  then array['country_duel']
    when 'flag'     then array['flag_duel']
    when 'wheel'    then array['wheel_duel', 'wheel_group']
    when 'conquest' then array['conquest']
    else null
  end;

  return query
  with scoped as (
    select
      e.profile_id           as pid,
      sum(e.xp_earned)::int  as xp_sum
    from public.xp_events e
    where v_modes is null or e.mode_key = any(v_modes)
    group by e.profile_id
    having sum(e.xp_earned) > 0
  ),
  totals as (
    select
      e.profile_id           as pid,
      sum(e.xp_earned)::int  as tot
    from public.xp_events e
    group by e.profile_id
  )
  select
    p.id                                            as profile_id,
    p.username                                      as username,
    coalesce(s.xp_sum, 0)                           as xp,
    coalesce(t.tot, 0)                              as total_xp,
    (floor(sqrt(coalesce(t.tot, 0) / 100.0))::int + 1) as level
  from scoped s
  join public.profiles p on p.id = s.pid
  left join totals t     on t.pid = s.pid
  where p.username is not null
    and length(btrim(p.username)) > 0
    and coalesce(p.is_test_account, false) = false
  order by s.xp_sum desc nulls last, p.username asc
  limit v_limit;
end
$fn$;


-- ----------------------------------------------------------------------------
-- 4) get_gold_leaderboard — test hesaplari filtresi eklenmis hali
-- ----------------------------------------------------------------------------

create or replace function public.get_gold_leaderboard(
  p_limit int default 10
)
returns table (
  profile_id uuid,
  username   text,
  gold       int,
  total_xp   int,
  level      int
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_limit int;
begin
  v_limit := greatest(1, least(50, coalesce(p_limit, 10)));

  return query
  with totals as (
    select
      e.profile_id           as pid,
      sum(e.xp_earned)::int  as tot
    from public.xp_events e
    group by e.profile_id
  )
  select
    p.id                                            as profile_id,
    p.username                                      as username,
    greatest(0, coalesce(p.gold, 0))::int           as gold,
    coalesce(t.tot, 0)                              as total_xp,
    (floor(sqrt(coalesce(t.tot, 0) / 100.0))::int + 1) as level
  from public.profiles p
  left join totals t on t.pid = p.id
  where p.username is not null
    and length(btrim(p.username)) > 0
    and coalesce(p.gold, 0) > 0
    and coalesce(p.is_test_account, false) = false
  order by p.gold desc nulls last, p.username asc
  limit v_limit;
end
$fn$;


-- ----------------------------------------------------------------------------
-- 5) Grants — imza degismedigi icin onceki grant'lar gecerli, defansif olarak
-- tekrar yaziyoruz.
-- ----------------------------------------------------------------------------

revoke all on function public.get_xp_leaderboard(text, int) from public;
grant  execute on function public.get_xp_leaderboard(text, int) to anon, authenticated;

revoke all on function public.get_gold_leaderboard(int)     from public;
grant  execute on function public.get_gold_leaderboard(int)     to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Dogrulama:
--   -- testet / testet41 / testt1 listede gozukmemeli, @erkam / @holosko kalmali:
--   select * from public.get_xp_leaderboard('general', 50);
--   select * from public.get_xp_leaderboard('country',  50);
--   select * from public.get_xp_leaderboard('flag',     50);
--   select * from public.get_xp_leaderboard('wheel',    50);
--   select * from public.get_xp_leaderboard('conquest', 50);
--   select * from public.get_gold_leaderboard(50);
--
--   -- isaretlenen hesaplar:
--   select id, username, is_test_account
--     from public.profiles
--    where is_test_account = true;
-- ============================================================================
