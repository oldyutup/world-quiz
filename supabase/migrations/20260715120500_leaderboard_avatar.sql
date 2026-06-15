-- ============================================================================
-- Leaderboard: avatar_id (Sosyal V1)
-- ============================================================================
-- Amac:
--   Sıralama listelerinde oyuncu adının yanında profil avatarını gösterebilmek
--   için iki leaderboard RPC'sinin dönüş tablosuna `avatar_id text` kolonu
--   eklenir. avatar_id zaten public bir alan (profiles.avatar_id, format-CHECK
--   ile sınırlı, gameplay/gizli veri değil); client'a düşmesinde sakınca yok.
--
--   Avatar profiles satırından aynı join içinde gelir → EK SORGU / N+1 YOK.
--   Liste 1000+ oyunculu büyüse de tek sorgu + limit ile döner.
--
-- DEĞİŞMEYEN davranış:
--   * Scope mantığı (general/country/flag/wheel/conquest), level formülü
--     (floor(sqrt(total_xp/100))+1), sıralama, test-hesabı filtreleri, limit
--     clamp [1,50], guest/boş-username filtreleri — hepsi 20260621120000 ile
--     birebir aynı. Yalnızca dönüşe avatar_id eklendi.
--   * GRANT/REVOKE, SECURITY DEFINER, search_path, imzalar aynı.
--
-- Idempotency:
--   `create or replace function` — tekrar çalıştırılabilir. Dönüş tablosu
--   imzası değiştiği için önce DROP gerekir (Postgres "cannot change return
--   type of existing function" hatası). Aşağıda guard'lı drop var.
--
-- NOT: Elle uygulanır. Bağımlılık: 20260621120000_leaderboard_rpcs.sql.
-- ============================================================================

-- Dönüş tablosu (OUT kolonları) değiştiği için create-or-replace yetmez; drop şart.
drop function if exists public.get_xp_leaderboard(text, int);
drop function if exists public.get_gold_leaderboard(int);

-- ----------------------------------------------------------------------------
-- 1) get_xp_leaderboard — +avatar_id
-- ----------------------------------------------------------------------------
create or replace function public.get_xp_leaderboard(
  p_scope text default 'general',
  p_limit int  default 10
)
returns table (
  profile_id uuid,
  username   text,
  avatar_id  text,
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
    p.avatar_id                                     as avatar_id,
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
-- 2) get_gold_leaderboard — +avatar_id
-- ----------------------------------------------------------------------------
create or replace function public.get_gold_leaderboard(
  p_limit int default 10
)
returns table (
  profile_id uuid,
  username   text,
  avatar_id  text,
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
    p.avatar_id                                     as avatar_id,
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
-- 3) Grants (20260621120000 ile aynı)
-- ----------------------------------------------------------------------------
revoke all on function public.get_xp_leaderboard(text, int)   from public;
grant  execute on function public.get_xp_leaderboard(text, int)   to anon, authenticated;

revoke all on function public.get_gold_leaderboard(int)       from public;
grant  execute on function public.get_gold_leaderboard(int)       to anon, authenticated;

-- ============================================================================
-- Dogrulama:
--   select * from public.get_xp_leaderboard('general', 10);  -- avatar_id kolonu var mı
--   select * from public.get_gold_leaderboard(10);
-- ============================================================================
