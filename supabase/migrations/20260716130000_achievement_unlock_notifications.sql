-- ============================================================================
-- Achievement Unlock Notifications: başarım ilk kez tamamlanınca Bildirimler
-- paneline "reward_ready" bildirimi düşür
-- ============================================================================
-- Amac:
--   Audit sonucu: UI (NotificationCenter / NotificationList), notification type
--   union (achievement_unlocked / reward_ready), badge sayacı ve realtime INSERT
--   aboneliği HAZIR — fakat hiçbir yer notifications tablosuna achievement satırı
--   INSERT etmiyordu. Bu migration o tek eksik halkayı server tarafında kapatır.
--
--   Bir başarım tier'ı (örn. world_traveler_10) ilk kez eşiği karşıladığında,
--   o tier'ı besleyen record_* RPC'si stats'ı güncelledikten SONRA ortak
--   _ach_notify_unlocks() helper'ını çağırır. Helper, ŞU AN eşiği karşılayan her
--   tier için type='reward_ready' bir bildirim INSERT etmeyi dener; partial unique
--   index + ON CONFLICT DO NOTHING sayesinde aynı (kullanıcı, tier) için yalnızca
--   BİR KEZ satır oluşur (idempotent, spam yok).
--
--   type SEÇİMİ: reward_ready. Çünkü her açılan tier'ın claim edilebilir Gold
--   ödülü var ve NotificationList'te "Ödülleri Topla" aksiyonu zaten çalışıyor
--   (onOpenRewards → avatar/başarım modalı). Böylece kullanıcı bildirimle birlikte
--   ödülünü toplamaya yönlendirilir.
--
-- GÜVENLİK:
--   * Bildirim INSERT'i YALNIZ SECURITY DEFINER record_* RPC'leri içinden, server
--     tarafından hesaplanan stats'a göre yapılır. Client notifications/profile_
--     achievements tablosuna doğrudan yazamaz → sahteleme yok.
--   * actor_profile_id = NULL (sistem bildirimi; başka kullanıcı değil).
--
-- DOKUNULMAZ:
--   * friend_request / friend_request_accepted / room_invite bildirimleri ve
--     social_core RPC'leri (ayrı type, ayrı dosya — bu migration onlara dokunmaz).
--   * stats hesaplama mantığı, tier eşikleri/ödülleri, claim_achievement_rewards,
--     Gold/XP sistemleri. record_* gövdeleri birebir korunur; YALNIZ sona
--     _ach_notify_unlocks() çağrısı eklenir.
--
-- NOT:
--   * Idempotent: create index if not exists / create or replace function.
--   * GERİYE DÖNÜK DOLDURMA YOK. Bu migrationdan ÖNCE eşiği geçmiş tier'lar için
--     bildirim üretilmez (mevcut kullanıcıları toplu bildirimle boğmamak için);
--     yalnız bundan sonraki ilk-açılışlar bildirim yaratır.
--   * Tier listesi achievementStats.ts ACHIEVEMENT_TIERS + claim_achievement_rewards
--     ile birebir senkron tutulmalı (10/50/100, 25/100/250, 3/5/7, 3/5/7, 2/3/5).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Spam/duplicate koruması: (recipient, tierId) için partial unique index
-- ----------------------------------------------------------------------------
-- Yalnız achievement/reward bildirimlerini kapsar; friend_request / room_invite
-- gibi tierId taşımayan satırlar index DIŞINDA kalır (etkilenmez). Aynı kullanıcı
-- + aynı tierId ikinci kez INSERT edilemez.
create unique index if not exists notifications_achievement_tier_uniq
  on public.notifications (recipient_profile_id, (payload->>'tierId'))
  where type in ('achievement_unlocked', 'reward_ready');


-- ----------------------------------------------------------------------------
-- 2) Internal helper: eşiği karşılanan tier'lar için reward_ready bildirimi
-- ----------------------------------------------------------------------------
-- p_stats: güncellenmiş stats jsonb (çağıran record_* RPC'sinden geçer).
-- Her tier için ŞU AN eşik karşılanıyorsa bir bildirim INSERT dener; partial
-- unique index + ON CONFLICT DO NOTHING ile yalnız ilk açılışta gerçek satır
-- oluşur. record_* ile AYNI transaction'da, satır zaten FOR UPDATE kilitliyken
-- çağrılır (yalnız notifications'a yazar; profile_achievements'a dokunmaz).
create or replace function public._ach_notify_unlocks(p_uid uuid, p_stats jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_tier  record;
  v_value int;
  v_stats jsonb := coalesce(p_stats, '{}'::jsonb);
  -- (id, group, name, stat, target, reward) — achievementStats.ts ile senkron.
  v_tiers jsonb := '[
    {"id":"world_traveler_10",  "group":"world_traveler",  "name":"Dünya Gezgini",     "stat":"uniqueCorrectCountryIds","target":10, "reward":25},
    {"id":"world_traveler_50",  "group":"world_traveler",  "name":"Dünya Gezgini",     "stat":"uniqueCorrectCountryIds","target":50, "reward":50},
    {"id":"world_traveler_100", "group":"world_traveler",  "name":"Dünya Gezgini",     "stat":"uniqueCorrectCountryIds","target":100,"reward":75},
    {"id":"flag_master_25",     "group":"flag_master",     "name":"Bayrak Ustası",     "stat":"correctFlagsCount",      "target":25, "reward":25},
    {"id":"flag_master_100",    "group":"flag_master",     "name":"Bayrak Ustası",     "stat":"correctFlagsCount",      "target":100,"reward":50},
    {"id":"flag_master_250",    "group":"flag_master",     "name":"Bayrak Ustası",     "stat":"correctFlagsCount",      "target":250,"reward":75},
    {"id":"streak_player_3",    "group":"streak_player",   "name":"Seri Oyuncu",       "stat":"dailyPlayStreak",        "target":3,  "reward":25},
    {"id":"streak_player_5",    "group":"streak_player",   "name":"Seri Oyuncu",       "stat":"dailyPlayStreak",        "target":5,  "reward":50},
    {"id":"streak_player_7",    "group":"streak_player",   "name":"Seri Oyuncu",       "stat":"dailyPlayStreak",        "target":7,  "reward":75},
    {"id":"versatile_player_3", "group":"versatile_player","name":"Çok Yönlü Oyuncu",  "stat":"completedModeIds",       "target":3,  "reward":25},
    {"id":"versatile_player_5", "group":"versatile_player","name":"Çok Yönlü Oyuncu",  "stat":"completedModeIds",       "target":5,  "reward":50},
    {"id":"versatile_player_7", "group":"versatile_player","name":"Çok Yönlü Oyuncu",  "stat":"completedModeIds",       "target":7,  "reward":75},
    {"id":"win_streak_2",       "group":"win_streak",      "name":"Seri Galibiyet",    "stat":"onlineWinStreak",        "target":2,  "reward":25},
    {"id":"win_streak_3",       "group":"win_streak",      "name":"Seri Galibiyet",    "stat":"onlineWinStreak",        "target":3,  "reward":50},
    {"id":"win_streak_5",       "group":"win_streak",      "name":"Seri Galibiyet",    "stat":"onlineWinStreak",        "target":5,  "reward":75}
  ]'::jsonb;
begin
  if p_uid is null then
    return;
  end if;

  for v_tier in
    select
      (elem->>'id')          as id,
      (elem->>'group')       as grp,
      (elem->>'name')        as name,
      (elem->>'stat')        as stat,
      (elem->>'target')::int as target,
      (elem->>'reward')::int as reward
    from jsonb_array_elements(v_tiers) as elem
  loop
    -- Stat değeri: dizi statlar için uzunluk, sayısal statlar için değer.
    if v_tier.stat in ('uniqueCorrectCountryIds', 'completedModeIds') then
      v_value := coalesce(jsonb_array_length(coalesce(v_stats->v_tier.stat, '[]'::jsonb)), 0);
    else
      v_value := coalesce((v_stats->>v_tier.stat)::int, 0);
    end if;

    if v_value >= v_tier.target then
      -- İlk açılışta INSERT; tekrar denenirse partial unique index → no-op.
      insert into public.notifications
        (recipient_profile_id, actor_profile_id, type, title, body, payload)
      values (
        p_uid,
        null,
        'reward_ready',
        'Yeni başarım tamamlandı',
        v_tier.name || ' başarımını tamamladın. Ödülünü toplamak için göz at.',
        jsonb_build_object(
          'achievementId', v_tier.grp,
          'tierId',        v_tier.id,
          'reward',        v_tier.reward,
          'source',        'achievement_unlock'
        )
      )
      on conflict do nothing;
    end if;
  end loop;
end
$fn$;

revoke all on function public._ach_notify_unlocks(uuid, jsonb) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3) record_* RPC'leri: gövde korunur, başarı dönüşünden önce notify çağrısı
-- ----------------------------------------------------------------------------
-- create or replace grant'ları korur. Her fonksiyon, güncellenmiş v_stats ile
-- _ach_notify_unlocks çağırır (eşik karşılanmayan tier için no-op).

-- 3.1) record_correct_flag — Bayrak Ustası
create or replace function public.record_correct_flag(
  p_source text,
  p_amount int default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_stats jsonb;
  v_cur   int;
  v_inc   int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_source is null or p_source not in ('flag_offline', 'flag_duel', 'flag_group_future') then
    return jsonb_build_object('ok', false, 'code', 'invalid_source');
  end if;

  v_inc := least(greatest(coalesce(p_amount, 0), 0), 200); -- clamp 0..200

  perform public._ach_ensure_row(v_uid);
  select stats into v_stats from public.profile_achievements where profile_id = v_uid for update;
  v_stats := coalesce(v_stats, '{}'::jsonb);

  if v_inc > 0 then
    v_cur := coalesce((v_stats->>'correctFlagsCount')::int, 0);
    v_stats := jsonb_set(v_stats, '{correctFlagsCount}', to_jsonb(v_cur + v_inc), true);
    update public.profile_achievements set stats = v_stats where profile_id = v_uid;
  end if;

  perform public._ach_notify_unlocks(v_uid, v_stats);
  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_correct_flag(text, int) from public, anon;
grant  execute on function public.record_correct_flag(text, int) to authenticated;


-- 3.2) record_online_correct_countries — Dünya Gezgini
create or replace function public.record_online_correct_countries(
  p_country_ids text[],
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_stats jsonb;
  v_arr   jsonb;
  v_new   jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_source is null or p_source not in ('country_duel', 'country_group') then
    return jsonb_build_object('ok', false, 'code', 'invalid_source');
  end if;
  if p_country_ids is not null and array_length(p_country_ids, 1) > 300 then
    return jsonb_build_object('ok', false, 'code', 'too_many_ids');
  end if;

  perform public._ach_ensure_row(v_uid);
  select stats into v_stats from public.profile_achievements where profile_id = v_uid for update;
  v_stats := coalesce(v_stats, '{}'::jsonb);
  v_arr   := coalesce(v_stats->'uniqueCorrectCountryIds', '[]'::jsonb);

  -- Mevcut + gelen (geçerli, kısa) id'leri distinct birleştir.
  select to_jsonb(coalesce(array_agg(distinct e), array[]::text[]))
    into v_new
    from (
      select jsonb_array_elements_text(v_arr) as e
      union
      select unnest(coalesce(p_country_ids, array[]::text[])) as e
    ) u
   where e is not null and length(e) between 1 and 24;

  if v_new is distinct from v_arr then
    v_stats := jsonb_set(v_stats, '{uniqueCorrectCountryIds}', v_new, true);
    update public.profile_achievements set stats = v_stats where profile_id = v_uid;
  end if;

  perform public._ach_notify_unlocks(v_uid, v_stats);
  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_online_correct_countries(text[], text) from public, anon;
grant  execute on function public.record_online_correct_countries(text[], text) to authenticated;


-- 3.3) record_completed_mode — Çok Yönlü Oyuncu
create or replace function public.record_completed_mode(
  p_mode_id text,
  p_source text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_stats jsonb;
  v_arr   jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_mode_id is null or p_mode_id not in
     ('country', 'flag', 'silhouette', 'route', 'wheel', 'conquest', 'blindspot') then
    return jsonb_build_object('ok', false, 'code', 'invalid_mode');
  end if;

  perform public._ach_ensure_row(v_uid);
  select stats into v_stats from public.profile_achievements where profile_id = v_uid for update;
  v_stats := coalesce(v_stats, '{}'::jsonb);
  v_arr   := coalesce(v_stats->'completedModeIds', '[]'::jsonb);

  if not (v_arr ? p_mode_id) then
    v_stats := jsonb_set(v_stats, '{completedModeIds}', v_arr || to_jsonb(p_mode_id), true);
    update public.profile_achievements set stats = v_stats where profile_id = v_uid;
  end if;

  perform public._ach_notify_unlocks(v_uid, v_stats);
  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_completed_mode(text, text) from public, anon;
grant  execute on function public.record_completed_mode(text, text) to authenticated;


-- 3.4) record_daily_game_completion — Seri Oyuncu
create or replace function public.record_daily_game_completion(
  p_local_date text,
  p_source text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_stats  jsonb;
  v_last   text;
  v_streak int;
  v_today  date;
  v_utc    date := (timezone('UTC', now()))::date;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_local_date is null or p_local_date !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_date');
  end if;

  begin
    v_today := p_local_date::date;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_date');
  end;

  if v_today < v_utc - 1 or v_today > v_utc + 1 then
    return jsonb_build_object('ok', false, 'code', 'date_out_of_range');
  end if;

  perform public._ach_ensure_row(v_uid);
  select stats into v_stats from public.profile_achievements where profile_id = v_uid for update;
  v_stats  := coalesce(v_stats, '{}'::jsonb);
  v_last   := v_stats->>'lastCompletedGameDate';
  v_streak := coalesce((v_stats->>'dailyPlayStreak')::int, 0);

  if v_last = p_local_date then
    null;
  elsif v_last is not null and (v_today - v_last::date) = 1 then
    v_streak := v_streak + 1;
  else
    v_streak := 1;
  end if;

  v_stats := jsonb_set(v_stats, '{dailyPlayStreak}', to_jsonb(v_streak), true);
  v_stats := jsonb_set(v_stats, '{lastCompletedGameDate}', to_jsonb(p_local_date), true);
  update public.profile_achievements set stats = v_stats where profile_id = v_uid;

  perform public._ach_notify_unlocks(v_uid, v_stats);
  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_daily_game_completion(text, text) from public, anon;
grant  execute on function public.record_daily_game_completion(text, text) to authenticated;


-- 3.5) record_game_complete — birleşik (completedModeIds + daily streak)
create or replace function public.record_game_complete(
  p_mode_id text,
  p_local_date text,
  p_source text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_stats  jsonb;
  v_arr    jsonb;
  v_last   text;
  v_streak int;
  v_today  date;
  v_utc    date := (timezone('UTC', now()))::date;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_mode_id is null or p_mode_id not in
     ('country', 'flag', 'silhouette', 'route', 'wheel', 'conquest', 'blindspot') then
    return jsonb_build_object('ok', false, 'code', 'invalid_mode');
  end if;
  if p_local_date is null or p_local_date !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_date');
  end if;

  begin
    v_today := p_local_date::date;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_date');
  end;
  if v_today < v_utc - 1 or v_today > v_utc + 1 then
    return jsonb_build_object('ok', false, 'code', 'date_out_of_range');
  end if;

  perform public._ach_ensure_row(v_uid);
  select stats into v_stats from public.profile_achievements where profile_id = v_uid for update;
  v_stats := coalesce(v_stats, '{}'::jsonb);

  -- completedModeIds (unique)
  v_arr := coalesce(v_stats->'completedModeIds', '[]'::jsonb);
  if not (v_arr ? p_mode_id) then
    v_stats := jsonb_set(v_stats, '{completedModeIds}', v_arr || to_jsonb(p_mode_id), true);
  end if;

  -- daily streak
  v_last   := v_stats->>'lastCompletedGameDate';
  v_streak := coalesce((v_stats->>'dailyPlayStreak')::int, 0);
  if v_last = p_local_date then
    null;
  elsif v_last is not null and (v_today - v_last::date) = 1 then
    v_streak := v_streak + 1;
  else
    v_streak := 1;
  end if;
  v_stats := jsonb_set(v_stats, '{dailyPlayStreak}', to_jsonb(v_streak), true);
  v_stats := jsonb_set(v_stats, '{lastCompletedGameDate}', to_jsonb(p_local_date), true);

  update public.profile_achievements set stats = v_stats where profile_id = v_uid;

  perform public._ach_notify_unlocks(v_uid, v_stats);
  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_game_complete(text, text, text) from public, anon;
grant  execute on function public.record_game_complete(text, text, text) to authenticated;


-- 3.6) record_online_match_result — Seri Galibiyet
create or replace function public.record_online_match_result(
  p_result text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_stats jsonb;
  v_cur   int;
  v_next  int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_result is null or p_result not in ('win', 'loss', 'draw') then
    return jsonb_build_object('ok', false, 'code', 'invalid_result');
  end if;

  perform public._ach_ensure_row(v_uid);
  select stats into v_stats from public.profile_achievements where profile_id = v_uid for update;
  v_stats := coalesce(v_stats, '{}'::jsonb);
  v_cur   := coalesce((v_stats->>'onlineWinStreak')::int, 0);
  v_next  := case when p_result = 'win' then v_cur + 1 else 0 end;

  v_stats := jsonb_set(v_stats, '{onlineWinStreak}', to_jsonb(v_next), true);
  update public.profile_achievements set stats = v_stats where profile_id = v_uid;

  perform public._ach_notify_unlocks(v_uid, v_stats);
  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_online_match_result(text) from public, anon;
grant  execute on function public.record_online_match_result(text) to authenticated;


-- ============================================================================
-- Doğrulama (Studio SQL editor, test kullanıcısı oturumuyla):
--   -- Bayrak Ustası 25 eşiğini ilk kez geç:
--   select public.record_correct_flag('flag_offline', 25);
--   select type, title, payload->>'tierId'
--     from public.notifications where type = 'reward_ready';   -- 1 satır: flag_master_25
--   -- Tekrar tetikle → yeni satır OLUŞMAMALI:
--   select public.record_correct_flag('flag_offline', 1);
--   select count(*) from public.notifications
--    where type = 'reward_ready' and payload->>'tierId' = 'flag_master_25';  -- hâlâ 1
--   -- Farklı tier (100) → yeni bildirim:
--   select public.record_correct_flag('flag_offline', 100);
--   select count(*) from public.notifications where type = 'reward_ready';   -- 2
--   -- Arkadaşlık/oda bildirimleri etkilenmez (farklı type, index dışı).
-- ============================================================================
