-- ============================================================================
-- Profile Achievements — CANLI ONARIM (live repair)
-- ============================================================================
-- TEŞHİS (REST probe ile kanıtlandı, anon key):
--   * public.profile_achievements   → PGRST205 "table not found"
--   * public._ach_ensure_row(uuid)   → PGRST202 "function not found"
--   * public.claim_achievement_rewards() → PGRST202 "function not found"
--   buna karşılık _ach_notify_unlocks, record_* (notify sürümleri),
--   notifications, gold_transactions CANLIDA MEVCUT.
--
--   Yani `2026071412..._profile_achievements.sql` migration'ı canlı DB'ye HİÇ
--   uygulanmamış. Sebep: dosya `kornokta_teams_schema.sql` ile AYNI sürüm
--   numarasını (20260714120000) paylaşıyordu; manuel uygulamada atlanmış.
--   (Dosya artık 20260714121000'e yeniden adlandırıldı.)
--
--   SONUÇ:
--     - "Ödülleri Topla" → claim_achievement_rewards RPC yok → 404 → client
--       "network" → "Ödüller toplanamadı, tekrar dene."
--     - record_* RPC'leri _ach_ensure_row + profile_achievements'a erişemediği
--       için RUNTIME'da patlıyor → stats sunucuda kalıcı OLMUYOR (avatar kilidi
--       yalnız localStorage ile çalışıyor) → _ach_notify_unlocks'a hiç ulaşılmıyor
--       → reward_ready bildirimi düşmüyor.
--
-- BU MIGRATION canlıdaki TEK EKSİK halkayı kapatır: profile_achievements tablosu,
-- _ach_ensure_row ve claim_achievement_rewards. record_* fonksiyonlarına KASITLI
-- OLARAK DOKUNMAZ — canlıdaki bildirimli (20260716130000) sürümleri korunur, yani
-- bu dosyayı çalıştırmak bildirim özelliğini geri almaz.
--
-- IDEMPOTENT: create table if not exists / create or replace. Tablo zaten varsa
-- (örn. temiz bir DB'de 20260714121000 zaten uygulanmışsa) hepsi no-op olur.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) profile_achievements tablosu
-- ----------------------------------------------------------------------------
create table if not exists public.profile_achievements (
  profile_id uuid        primary key references public.profiles(id) on delete cascade,
  stats      jsonb       not null default '{}'::jsonb,
  unlocks    jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);


-- ----------------------------------------------------------------------------
-- 2) updated_at trigger
-- ----------------------------------------------------------------------------
create or replace function public._touch_profile_achievements_updated_at()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  new.updated_at := now();
  return new;
end
$fn$;

drop trigger if exists trg_profile_achievements_updated_at on public.profile_achievements;

create trigger trg_profile_achievements_updated_at
  before update on public.profile_achievements
  for each row
  execute function public._touch_profile_achievements_updated_at();


-- ----------------------------------------------------------------------------
-- 3) RLS + grants — client SADECE kendi satırını OKUR, yazamaz
-- ----------------------------------------------------------------------------
alter table public.profile_achievements enable row level security;

drop policy if exists profile_achievements_select_self on public.profile_achievements;
drop policy if exists profile_achievements_insert_self on public.profile_achievements;
drop policy if exists profile_achievements_update_self on public.profile_achievements;

create policy profile_achievements_select_self
  on public.profile_achievements
  for select
  to authenticated
  using (profile_id = auth.uid());

revoke all                    on public.profile_achievements from anon, authenticated;
revoke insert, update, delete on public.profile_achievements from authenticated;
grant  select                 on public.profile_achievements to authenticated;


-- ----------------------------------------------------------------------------
-- 4) Internal helper: satırın varlığını garanti eder (yoksa boş oluşturur)
-- ----------------------------------------------------------------------------
create or replace function public._ach_ensure_row(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profile_achievements (profile_id, stats, unlocks)
  values (p_uid, '{}'::jsonb, '{}'::jsonb)
  on conflict (profile_id) do nothing;
end
$fn$;

revoke all on function public._ach_ensure_row(uuid) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5) claim_achievement_rewards() — güvenli, idempotent Gold claim
-- ----------------------------------------------------------------------------
-- _apply_gold_delta (20260624) zaten canlıda. Tier eşikleri/ödülleri
-- achievementStats.ts ACHIEVEMENT_TIERS + claim/notify ile birebir senkron.
create or replace function public.claim_achievement_rewards()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_stats     jsonb;
  v_unlocks   jsonb;
  v_claimed   jsonb;            -- claimedAchievementRewardIds (array)
  v_new_ids   text[] := array[]::text[];
  v_total     int := 0;
  v_gold      int;
  v_tier      record;
  v_value     int;
  v_tiers     jsonb := '[
    {"id":"world_traveler_10",   "stat":"uniqueCorrectCountryIds","target":10, "reward":25},
    {"id":"world_traveler_50",   "stat":"uniqueCorrectCountryIds","target":50, "reward":50},
    {"id":"world_traveler_100",  "stat":"uniqueCorrectCountryIds","target":100,"reward":75},
    {"id":"flag_master_25",      "stat":"correctFlagsCount",       "target":25, "reward":25},
    {"id":"flag_master_100",     "stat":"correctFlagsCount",       "target":100,"reward":50},
    {"id":"flag_master_250",     "stat":"correctFlagsCount",       "target":250,"reward":75},
    {"id":"streak_player_3",     "stat":"dailyPlayStreak",         "target":3,  "reward":25},
    {"id":"streak_player_5",     "stat":"dailyPlayStreak",         "target":5,  "reward":50},
    {"id":"streak_player_7",     "stat":"dailyPlayStreak",         "target":7,  "reward":75},
    {"id":"versatile_player_3",  "stat":"completedModeIds",        "target":3,  "reward":25},
    {"id":"versatile_player_5",  "stat":"completedModeIds",        "target":5,  "reward":50},
    {"id":"versatile_player_7",  "stat":"completedModeIds",        "target":7,  "reward":75},
    {"id":"win_streak_2",        "stat":"onlineWinStreak",         "target":2,  "reward":25},
    {"id":"win_streak_3",        "stat":"onlineWinStreak",         "target":3,  "reward":50},
    {"id":"win_streak_5",        "stat":"onlineWinStreak",         "target":5,  "reward":75}
  ]'::jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;

  perform public._ach_ensure_row(v_uid);
  select stats, unlocks into v_stats, v_unlocks
    from public.profile_achievements
   where profile_id = v_uid
   for update;

  v_stats   := coalesce(v_stats, '{}'::jsonb);
  v_unlocks := coalesce(v_unlocks, '{}'::jsonb);
  v_claimed := coalesce(v_unlocks->'claimedAchievementRewardIds', '[]'::jsonb);

  for v_tier in
    select
      (elem->>'id')          as id,
      (elem->>'stat')        as stat,
      (elem->>'target')::int as target,
      (elem->>'reward')::int as reward
    from jsonb_array_elements(v_tiers) as elem
  loop
    if v_tier.stat in ('uniqueCorrectCountryIds', 'completedModeIds') then
      v_value := coalesce(jsonb_array_length(coalesce(v_stats->v_tier.stat, '[]'::jsonb)), 0);
    else
      v_value := coalesce((v_stats->>v_tier.stat)::int, 0);
    end if;

    if v_value >= v_tier.target
       and not (v_claimed ? v_tier.id) then
      v_new_ids := array_append(v_new_ids, v_tier.id);
      v_total   := v_total + v_tier.reward;
    end if;
  end loop;

  if array_length(v_new_ids, 1) is null then
    select coalesce(gold, 0) into v_gold from public.profiles where id = v_uid;
    return jsonb_build_object(
      'ok', true,
      'claimedTierIds', '[]'::jsonb,
      'goldAwarded', 0,
      'gold', coalesce(v_gold, 0)
    );
  end if;

  v_gold := public._apply_gold_delta(
    v_uid,
    v_total,
    'achievement_reward',
    'gameplay',
    jsonb_build_object('tier_ids', to_jsonb(v_new_ids))
  );

  update public.profile_achievements
     set unlocks = jsonb_set(
           v_unlocks,
           '{claimedAchievementRewardIds}',
           v_claimed || to_jsonb(v_new_ids),
           true
         )
   where profile_id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'claimedTierIds', to_jsonb(v_new_ids),
    'goldAwarded', v_total,
    'gold', v_gold
  );
end
$fn$;

revoke all     on function public.claim_achievement_rewards() from public, anon;
grant  execute on function public.claim_achievement_rewards() to authenticated;


-- ============================================================================
-- Doğrulama (anon key, REST):
--   POST /rest/v1/rpc/claim_achievement_rewards  → artık {ok:false, unauthenticated}
--     döner (404 PGRST202 DEĞİL). Authenticated test kullanıcısıyla:
--     select public.record_correct_flag('flag_offline', 25);   -- stats sunucuda
--     select public.claim_achievement_rewards();                -- 25 Gold + claimed
--     select type, payload->>'tierId' from public.notifications -- reward_ready satırı
--       where type = 'reward_ready';
-- ============================================================================
