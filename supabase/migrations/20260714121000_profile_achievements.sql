-- ============================================================================
-- Profile Achievements: kalıcı progress/unlock deposu + DB-otoriteli RPC'ler
-- ============================================================================
-- Amac:
--   Avatar başarım sistemini (achievementStats.ts) localStorage'tan Supabase'e
--   taşımak VE tüm yazımları DB seviyesinde güvenli kılmak.
--
--   GÜVENLİK MODELİ (deploy öncesi hardening):
--     - Client public.profile_achievements üzerinde SADECE SELECT yapabilir.
--       INSERT/UPDATE/DELETE grant'ları authenticated/anon'dan revoke edildi;
--       RLS'te yalnızca SELECT self policy var. Yani client ne `stats` ne
--       `unlocks` kolonunu DOĞRUDAN yazamaz.
--     - Tüm stat mutasyonları kontrollü SECURITY DEFINER RPC'lerinden geçer
--       (record_correct_flag / record_online_correct_countries /
--        record_completed_mode / record_daily_game_completion /
--        record_game_complete / record_online_match_result). Bunlar:
--         * source whitelist'i uygular (online country yalnız country_duel/
--           country_group; offline country ASLA world traveler'a yazılmaz),
--         * tek çağrıda artışı cap'ler (correctFlags clamp, country dizi cap),
--         * Set/increment mantığıyla çalışır (keyfi 9999 set edilemez).
--     - Gold ödülü yalnız claim_achievement_rewards() ile, server-side hesapla
--       verilir; claimedAchievementRewardIds yalnız bu RPC tarafından yazılır,
--       client tarafından SİLİNEMEZ (tabloya yazma yetkisi yok).
--
-- DOKUNULMAZ:
--   * profiles diğer kolonları, gold_transactions, award/spend RPC aileleri,
--     xp_events, leaderboard RPC'leri, gameplay mantığı.
--
-- NOT:
--   - Migration idempotent (create if not exists / create or replace / drop-create).
--   - Her fonksiyon SET search_path = public ile sabitlenir (search_path injection
--     koruması). Tier eşikleri/ödülleri achievementStats.ts ACHIEVEMENT_TIERS ile
--     birebir aynı tutulmalı (10/50/100, 25/100/250, 3/5/7, 3/5/7, 2/3/5;
--     ödüller 25/50/75).
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

-- Eski (gevşek) write policy'leri varsa kaldır.
drop policy if exists profile_achievements_select_self on public.profile_achievements;
drop policy if exists profile_achievements_insert_self on public.profile_achievements;
drop policy if exists profile_achievements_update_self on public.profile_achievements;

create policy profile_achievements_select_self
  on public.profile_achievements
  for select
  to authenticated
  using (profile_id = auth.uid());

-- INSERT/UPDATE/DELETE policy YOK → RLS varsayilan denial. Ayrica grant
-- seviyesinde de yaziyi kapatiyoruz (iki kat koruma). SECURITY DEFINER RPC'leri
-- owner (postgres) olarak calistigindan bu kisitlamadan etkilenmez.
revoke all                       on public.profile_achievements from anon, authenticated;
revoke insert, update, delete    on public.profile_achievements from authenticated;
grant  select                    on public.profile_achievements to authenticated;


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
-- 5) record_correct_flag(p_source, p_amount) — Bayrak Ustası
-- ----------------------------------------------------------------------------
-- Yalnız flag kaynakları geçerli. Artış [0..200] aralığına CLAMP edilir
-- (tek çağrıda aşırı şişirme engeli). Set değil, increment.
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

  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_correct_flag(text, int) from public, anon;
grant  execute on function public.record_correct_flag(text, int) to authenticated;


-- ----------------------------------------------------------------------------
-- 6) record_online_correct_countries(p_country_ids[], p_source) — Dünya Gezgini
-- ----------------------------------------------------------------------------
-- YALNIZ online country kaynakları (country_duel / country_group). Offline
-- country buraya ASLA yazılamaz (whitelist). Set mantığı: mevcut + gelen id'ler
-- distinct birleştirilir; aynı ülke tekrar sayılmaz. Girdi dizisi ve id boyu
-- cap'lidir.
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

  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_online_correct_countries(text[], text) from public, anon;
grant  execute on function public.record_online_correct_countries(text[], text) to authenticated;


-- ----------------------------------------------------------------------------
-- 7) record_completed_mode(p_mode_id, p_source) — Çok Yönlü Oyuncu
-- ----------------------------------------------------------------------------
-- Stable mod ailesi whitelist'i; unique set'e ekler.
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

  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_completed_mode(text, text) from public, anon;
grant  execute on function public.record_completed_mode(text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 8) record_daily_game_completion(p_local_date, p_source) — Seri Oyuncu
-- ----------------------------------------------------------------------------
-- Yerel günü client verir (YYYY-MM-DD). Sunucu, UTC bugün ±1 gün dışındaki
-- tarihleri reddederek "ileri tarih ile streak şişirme" exploit'ini engeller.
-- Aynı gün → değişmez; ardışık gün → +1; gün atlanırsa → 1.
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

  -- Saat dilimi farkı en fazla ~±1 gün; bunun dışındakini reddet.
  if v_today < v_utc - 1 or v_today > v_utc + 1 then
    return jsonb_build_object('ok', false, 'code', 'date_out_of_range');
  end if;

  perform public._ach_ensure_row(v_uid);
  select stats into v_stats from public.profile_achievements where profile_id = v_uid for update;
  v_stats  := coalesce(v_stats, '{}'::jsonb);
  v_last   := v_stats->>'lastCompletedGameDate';
  v_streak := coalesce((v_stats->>'dailyPlayStreak')::int, 0);

  if v_last = p_local_date then
    -- Aynı gün ikinci oyun → streak değişmez.
    null;
  elsif v_last is not null and (v_today - v_last::date) = 1 then
    v_streak := v_streak + 1;
  else
    v_streak := 1;
  end if;

  v_stats := jsonb_set(v_stats, '{dailyPlayStreak}', to_jsonb(v_streak), true);
  v_stats := jsonb_set(v_stats, '{lastCompletedGameDate}', to_jsonb(p_local_date), true);
  update public.profile_achievements set stats = v_stats where profile_id = v_uid;

  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_daily_game_completion(text, text) from public, anon;
grant  execute on function public.record_daily_game_completion(text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 9) record_game_complete(p_mode_id, p_local_date, p_source) — birleşik
-- ----------------------------------------------------------------------------
-- Bir oyun tamamlandığında çağrılan birleşik RPC: completedModeIds (unique) +
-- daily streak'i TEK transaction'da günceller (round-trip & race azaltır).
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

  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_game_complete(text, text, text) from public, anon;
grant  execute on function public.record_game_complete(text, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 10) record_online_match_result(p_result) — Seri Galibiyet
-- ----------------------------------------------------------------------------
-- win → onlineWinStreak +1; loss/draw → 0. Yalnız online maç sonucu.
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

  return jsonb_build_object('ok', true, 'stats', v_stats);
end
$fn$;

revoke all     on function public.record_online_match_result(text) from public, anon;
grant  execute on function public.record_online_match_result(text) to authenticated;


-- ----------------------------------------------------------------------------
-- 11) claim_achievement_rewards() — güvenli, idempotent Gold claim
-- ----------------------------------------------------------------------------
-- Mantik:
--   - auth.uid() satırını FOR UPDATE ile kilitler (yoksa boş başlatır).
--   - stats'tan her tier'ın stat değerini hesaplar (server-side eşikler).
--   - Tamamlanmış (value >= target) AMA claimedAchievementRewardIds içinde
--     OLMAYAN tier'ları bulur.
--   - Toplam Gold'u _apply_gold_delta ile profiles.gold'a ekler
--     (reason='achievement_reward', gold_transactions'a tek kayıt).
--   - claimedAchievementRewardIds'e claim edilen tier id'lerini ekler.
--   - Hepsi tek transaction; aynı ödül ikinci kez verilemez.
-- Donus: { ok, claimedTierIds[], goldAwarded, gold }
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
  -- (tier_id, stat_key, target, reward) — achievementStats.ts ile senkron.
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

  -- Satırı kilitle (yoksa boş bir satır oluştur ve kilitle).
  perform public._ach_ensure_row(v_uid);
  select stats, unlocks into v_stats, v_unlocks
    from public.profile_achievements
   where profile_id = v_uid
   for update;

  v_stats   := coalesce(v_stats, '{}'::jsonb);
  v_unlocks := coalesce(v_unlocks, '{}'::jsonb);
  v_claimed := coalesce(v_unlocks->'claimedAchievementRewardIds', '[]'::jsonb);

  -- Tamamlanmış ama claim edilmemiş tier'ları topla.
  for v_tier in
    select
      (elem->>'id')          as id,
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

    if v_value >= v_tier.target
       and not (v_claimed ? v_tier.id) then
      v_new_ids := array_append(v_new_ids, v_tier.id);
      v_total   := v_total + v_tier.reward;
    end if;
  end loop;

  if array_length(v_new_ids, 1) is null then
    -- Claim edilecek ödül yok.
    select coalesce(gold, 0) into v_gold from public.profiles where id = v_uid;
    return jsonb_build_object(
      'ok', true,
      'claimedTierIds', '[]'::jsonb,
      'goldAwarded', 0,
      'gold', coalesce(v_gold, 0)
    );
  end if;

  -- Gold'u tek kalemde ekle (audit log: gold_transactions).
  v_gold := public._apply_gold_delta(
    v_uid,
    v_total,
    'achievement_reward',
    'gameplay',
    jsonb_build_object('tier_ids', to_jsonb(v_new_ids))
  );

  -- claimedAchievementRewardIds'i güncelle (idempotent: yalnızca yeni id'ler).
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
