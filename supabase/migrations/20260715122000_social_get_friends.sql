-- ============================================================================
-- Sosyal: get_friends() RPC — arkadaş listesi (V1 UI için)
-- ============================================================================
-- Amac:
--   Arkadaşlar panelinin tek çağrıda (N+1 YOK) avatar + username + level +
--   çerçeve bilgisini çekmesi. friends self-satırlarından çıkar; profiles ve
--   profile_cosmetics join'lenir. Gold DÖNDÜRMEZ (public alanlar).
--
-- Güvenlik: SECURITY DEFINER, actor = auth.uid(). Yalnız çağıranın kendi
--   arkadaşlarını döndürür (friends.profile_id = auth.uid()).
--
-- Idempotent + elle uygulanır. Bağımlılık: 20260715121000_social_core.sql
--   (_social_level, friends, profile_cosmetics).
-- ============================================================================

create or replace function public.get_friends()
returns table (
  profile_id             uuid,
  username               text,
  avatar_id              text,
  level                  int,
  active_avatar_frame_id text,
  friends_since          timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return;
  end if;
  return query
  select
    p.id,
    p.username,
    p.avatar_id,
    public._social_level(p.id),
    c.active_avatar_frame_id,
    f.created_at
  from public.friends f
  join public.profiles p on p.id = f.friend_profile_id
  left join public.profile_cosmetics c on c.profile_id = p.id
  where f.profile_id = v_me
  order by lower(coalesce(p.username, '')) asc;
end
$fn$;

revoke all on function public.get_friends() from public;
grant  execute on function public.get_friends() to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor):
--   select * from public.get_friends();  -- yalnız kendi arkadaşların, gold yok
-- ============================================================================
