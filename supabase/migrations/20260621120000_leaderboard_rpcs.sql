-- ============================================================================
-- Leaderboard RPCs (V1)
-- ============================================================================
-- Amac:
--   Ana ekrandaki "Sıralama" modalına public XP/Gold sıralamasi getirir.
--   Client direkt xp_events / profiles tablolarini sorgulamak yerine
--   SECURITY DEFINER iki RPC cagirir; sadece public alanlar doner (username,
--   xp, gold, level). Email / hassas alan dondurmez.
--
-- DOKUNMAZ:
--   * xp_events (yazim/insert/RPC davranisi)
--   * profiles (yazim)
--   * award_xp_event / award_wheel_group_xp_event / award_conquest_xp_event
--   * Gold yazim sistemi (profiles.gold update'i)
--   * Mevcut diger RPC / view / RLS politikalari
--
-- Level:
--   Client-side getLevelFromXp ile birebir uyumlu olmasi icin level DB
--   tarafinda da floor(sqrt(xp/100)) + 1 ile hesaplanir. Hem genel hem mod
--   scope'larinda dondurulen `level` o scope'taki XP'ye gore degil, GENEL
--   level'dir (UI'da oyuncunun "Lv X" pillindeki ile ayni gozuksun diye).
--
-- Scopes (XP):
--   general  → xp_events tum kayitlar
--   country  → xp_events.mode_key = 'country_duel'
--   flag     → xp_events.mode_key = 'flag_duel'
--   wheel    → xp_events.mode_key in ('wheel_duel', 'wheel_group')
--   conquest → xp_events.mode_key = 'conquest'
--
-- Guest oyuncular:
--   xp_events sadece auth'lu kullanicilarin profile_id'sine yazildigi icin
--   guest oyuncular zaten gozukmuyor. Gold leaderboard'da profile'in
--   username'i bos ise satir filtrelenir (defansif).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) get_xp_leaderboard
-- ----------------------------------------------------------------------------
-- params:
--   p_scope  text  — 'general'|'country'|'flag'|'wheel'|'conquest'
--   p_limit  int   — default 10, [1,50]'ye clamp
--
-- returns:
--   profile_id   uuid
--   username     text
--   xp           int        — secilen scope'taki toplam XP
--   total_xp     int        — kullanicinin TUM modlardaki XP'si (level icin)
--   level        int        — total_xp'den hesaplanir
-- ----------------------------------------------------------------------------

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
  order by s.xp_sum desc nulls last, p.username asc
  limit v_limit;
end
$fn$;


-- ----------------------------------------------------------------------------
-- 2) get_gold_leaderboard
-- ----------------------------------------------------------------------------
-- params:
--   p_limit int — default 10, [1,50]'ye clamp
--
-- returns:
--   profile_id uuid
--   username   text
--   gold       int
--   total_xp   int   — level icin (XP toplami xp_events'ten)
--   level      int   — total_xp'den hesaplanir
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
  order by p.gold desc nulls last, p.username asc
  limit v_limit;
end
$fn$;


-- ----------------------------------------------------------------------------
-- 3) Grants
-- ----------------------------------------------------------------------------
-- Sıralama public bir özellik; anon ve authenticated cagirabilsin.
-- Email / hassas alan dondurulmedigi icin guvenli.
-- ----------------------------------------------------------------------------

revoke all on function public.get_xp_leaderboard(text, int)   from public;
grant  execute on function public.get_xp_leaderboard(text, int)   to anon, authenticated;

revoke all on function public.get_gold_leaderboard(int)       from public;
grant  execute on function public.get_gold_leaderboard(int)       to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Dogrulama:
--   select * from public.get_xp_leaderboard('general', 10);
--   select * from public.get_xp_leaderboard('wheel',   10);
--   select * from public.get_gold_leaderboard(10);
-- ============================================================================
