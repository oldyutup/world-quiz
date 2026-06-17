-- ============================================================================
-- Profil kartı v2: kozmetik altyapı genişletme + public profil istatistikleri
-- ============================================================================
-- Amaç:
--   Yenilenen oyuncu profil kartının (PlayerProfileCard v2) ihtiyaç duyduğu
--   ek alanları SUNUCU TARAFINDA, salt-okunur ve güvenli biçimde sağlamak.
--
--   1) KOZMETİK ALTYAPI (satış/premium YOK — yalnız veri alanları):
--        profile_cosmetics tablosuna iki yeni kolon eklenir:
--          * active_profile_title_id   (unvan — default null)
--          * active_profile_effect_id  (kart efekti — default null)
--        Frame / theme / name_color / card_style kolonları zaten vardı
--        (bkz. 20260715121000_social_core.sql). RLS aynen korunur: sahibi yazar,
--        herkes okur (profil kartında görünebilmesi için).
--
--   2) PUBLIC İSTATİSTİKLER (gerçek veri, gold ASLA dönmez):
--        get_public_profile genişletilir ve şu GERÇEK metrikleri döndürür:
--          * xp                 → toplam XP (sum xp_events.xp_earned)
--          * matches_count      → XP kazandıran maç sayısı (count xp_events)
--          * wins_count         → galibiyet sayısı (count where result='win')
--          * current_streak     → mevcut online galibiyet serisi
--                                 (profile_achievements.stats->>'onlineWinStreak')
--          * achievements_count → açılan başarım (tier) sayısı — sticky,
--                                 _social_achievement_count ile (client mantığıyla
--                                 birebir: eşik karşılanmış VEYA daha önce açılmış
--                                 VEYA ödülü claim edilmiş tier'lar sayılır)
--        Ek olarak yeni kozmetik id'leri (card_style / title / effect) de döner.
--
-- GÜVENLİK / KAPSAM:
--   * get_public_profile hâlâ GOLD DÖNDÜRMEZ. Yalnız public-güvenli alanlar.
--   * Tüm okuma SECURITY DEFINER + stable; mevcut grant'lar (anon, authenticated)
--     korunur. Yazma yolu eklenmez.
--   * Mevcut XP / Gold / achievement / arkadaşlık / engelleme akışlarına DOKUNMAZ.
--   * Idempotent (create or replace + add column if not exists). Elle uygulanır.
--
-- Bağımlılıklar:
--   * profile_cosmetics, get_public_profile, _social_level (20260715121000_social_core.sql)
--   * relationship_status 'blocked'/'blocked_by' (20260716160000_social_block_and_remove_friend.sql)
--   * profile_achievements.stats/unlocks (20260714121000 + live_repair 20260716140000)
--   * xp_events (profile_id, mode_key, room_id, xp_earned, result)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Kozmetik kolonları (unvan + efekt) — additive, default null
-- ----------------------------------------------------------------------------
alter table public.profile_cosmetics
  add column if not exists active_profile_title_id  text null;
alter table public.profile_cosmetics
  add column if not exists active_profile_effect_id text null;

-- ----------------------------------------------------------------------------
-- 2) Yardımcı: açılan başarım (tier) sayısı — STICKY
--    achievementStats.ts isAchievementTierUnlocked + claim_achievement_rewards
--    tier listesi ile BİREBİR senkron. Bir tier açık sayılır eğer:
--      (a) stat şu an eşiği karşılıyor, VEYA
--      (b) avatarı daha önce açılmış (unlocks.unlockedAchievementAvatarIds), VEYA
--      (c) ödülü claim edilmiş (unlocks.claimedAchievementRewardIds).
--    Böylece win streak sıfırlansa bile kazanılmış başarım sayımdan düşmez.
-- ----------------------------------------------------------------------------
create or replace function public._social_achievement_count(p_profile_id uuid)
returns int
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_stats           jsonb;
  v_unlocks         jsonb;
  v_unlocked_avatars jsonb;
  v_claimed         jsonb;
  v_count           int := 0;
  v_tier            record;
  v_value           int;
  v_tiers           jsonb := '[
    {"id":"world_traveler_10",   "stat":"uniqueCorrectCountryIds","target":10},
    {"id":"world_traveler_50",   "stat":"uniqueCorrectCountryIds","target":50},
    {"id":"world_traveler_100",  "stat":"uniqueCorrectCountryIds","target":100},
    {"id":"flag_master_25",      "stat":"correctFlagsCount",       "target":25},
    {"id":"flag_master_100",     "stat":"correctFlagsCount",       "target":100},
    {"id":"flag_master_250",     "stat":"correctFlagsCount",       "target":250},
    {"id":"streak_player_3",     "stat":"dailyPlayStreak",         "target":3},
    {"id":"streak_player_5",     "stat":"dailyPlayStreak",         "target":5},
    {"id":"streak_player_7",     "stat":"dailyPlayStreak",         "target":7},
    {"id":"versatile_player_3",  "stat":"completedModeIds",        "target":3},
    {"id":"versatile_player_5",  "stat":"completedModeIds",        "target":5},
    {"id":"versatile_player_7",  "stat":"completedModeIds",        "target":7},
    {"id":"win_streak_2",        "stat":"onlineWinStreak",         "target":2},
    {"id":"win_streak_3",        "stat":"onlineWinStreak",         "target":3},
    {"id":"win_streak_5",        "stat":"onlineWinStreak",         "target":5}
  ]'::jsonb;
begin
  select stats, unlocks into v_stats, v_unlocks
    from public.profile_achievements
   where profile_id = p_profile_id;

  v_stats           := coalesce(v_stats, '{}'::jsonb);
  v_unlocks         := coalesce(v_unlocks, '{}'::jsonb);
  v_unlocked_avatars := coalesce(v_unlocks->'unlockedAchievementAvatarIds', '[]'::jsonb);
  v_claimed         := coalesce(v_unlocks->'claimedAchievementRewardIds', '[]'::jsonb);

  for v_tier in
    select
      (elem->>'id')          as id,
      (elem->>'stat')        as stat,
      (elem->>'target')::int as target
    from jsonb_array_elements(v_tiers) as elem
  loop
    -- Set-tipli stat'lar (ülke/mod aileleri) için uzunluk; sayısal stat'lar için değer.
    if v_tier.stat in ('uniqueCorrectCountryIds', 'completedModeIds') then
      v_value := coalesce(jsonb_array_length(coalesce(v_stats->v_tier.stat, '[]'::jsonb)), 0);
    else
      v_value := coalesce((v_stats->>v_tier.stat)::int, 0);
    end if;

    if v_value >= v_tier.target
       or v_unlocked_avatars ? ('avatar_ach_' || v_tier.id)
       or v_claimed ? v_tier.id
    then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end
$fn$;

revoke all     on function public._social_achievement_count(uuid) from public;
grant  execute on function public._social_achievement_count(uuid) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3) get_public_profile — XP barı, mini istatistikler ve yeni kozmetik
--    alanlarını döndürecek şekilde genişletildi.
--    NOT: return type değiştiği için önce DROP gerekir (create or replace
--    dönüş imzasını değiştiremez). Gövde 20260716160000 sürümünden türetildi;
--    relationship_status CASE'i aynen korunur.
-- ----------------------------------------------------------------------------
drop function if exists public.get_public_profile(uuid);

create function public.get_public_profile(p_profile_id uuid)
returns table (
  profile_id                   uuid,
  username                     text,
  avatar_id                    text,
  level                        int,
  xp                           int,
  matches_count                int,
  wins_count                   int,
  current_streak               int,
  achievements_count           int,
  showcased_badge_ids          text[],
  active_avatar_frame_id       text,
  active_profile_theme_id      text,
  active_name_color_id         text,
  active_profile_card_style_id text,
  active_profile_title_id      text,
  active_profile_effect_id     text,
  relationship_status          text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  return query
  select
    p.id,
    p.username,
    p.avatar_id,
    public._social_level(p.id),
    coalesce((select sum(e.xp_earned) from public.xp_events e where e.profile_id = p.id), 0)::int,
    (select count(*) from public.xp_events e where e.profile_id = p.id)::int,
    (select count(*) from public.xp_events e where e.profile_id = p.id and e.result = 'win')::int,
    coalesce(
      (select (pa.stats->>'onlineWinStreak')::int
         from public.profile_achievements pa
        where pa.profile_id = p.id),
      0
    ),
    public._social_achievement_count(p.id),
    coalesce(c.showcased_badge_ids, '{}'::text[]),
    c.active_avatar_frame_id,
    c.active_profile_theme_id,
    c.active_name_color_id,
    c.active_profile_card_style_id,
    c.active_profile_title_id,
    c.active_profile_effect_id,
    case
      when v_me is null then 'none'
      when p.id = v_me then 'self'
      when exists (
        select 1 from public.blocked_profiles b
         where b.blocker_profile_id = v_me and b.blocked_profile_id = p.id
      ) then 'blocked'
      when exists (
        select 1 from public.blocked_profiles b
         where b.blocker_profile_id = p.id and b.blocked_profile_id = v_me
      ) then 'blocked_by'
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
  where p.id = p_profile_id;
end
$fn$;

revoke all     on function public.get_public_profile(uuid) from public;
grant  execute on function public.get_public_profile(uuid) to anon, authenticated;

-- ============================================================================
-- Doğrulama (authenticated):
--   select * from public.get_public_profile('<profile_id>');
--     → xp / matches_count / wins_count / current_streak / achievements_count
--       dolu; gold YOK; relationship_status doğru.
--   update public.profile_cosmetics set active_profile_title_id = 'title_demo'
--     where profile_id = auth.uid();   -- RLS: yalnız sahibi
-- ============================================================================
