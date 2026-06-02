-- ============================================================================
-- Gold Economy: transaction log + server-side RPCs + write lockdown
-- ============================================================================
-- Amac:
--   Gold ekonomisini guvenli/server-otoriteli hale getirmek.
--   - Client artik profiles.gold kolonunu dogrudan UPDATE edemez.
--   - Gold kazanma / harcama islemleri SECURITY DEFINER RPC'leri uzerinden
--     yapilir; her hareket public.gold_transactions tablosuna yazilir.
--   - Daily bonus duplicate alinmayi engelleyecek sekilde server tarafinda
--     dogrulanir.
--   - change_username 500 Gold harcamasini transaction log'a yazar.
--
-- DOKUNULMAZ:
--   * xp_events, award_xp_event* ailesi
--   * profiles diger kolonlari (username, level, vs.)
--   * Leaderboard RPC'leri (get_xp_leaderboard / get_gold_leaderboard)
--   * Kuşatma, Bayrak, Çark, Kader Karti gameplay logic
--
-- NOT:
--   - Migration idempotent yazildi (drop if exists / create or replace).
--   - search_path her fonksiyonda 'public' olarak sabit.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) gold_transactions tablosu
-- ----------------------------------------------------------------------------
-- amount: signed int. Pozitif=kazanc, negatif=harcama.
-- balance_after: islem sonrasi yeni gold bakiyesi (audit icin).
-- reason: 'daily_bonus' | 'username_change' | 'username_initial_set' |
--         'map_match_reward' | 'silhouette_match_reward' |
--         'flag_match_reward' | 'route_match_reward' |
--         'conquest_liman_income' | 'hint_*' | 'admin_adjustment'
-- source: 'daily' | 'gameplay' | 'profile' | 'admin' (kanal etiketi)
-- metadata: serbest jsonb (ornegin ipucu turu, mac id, vs.)

create table if not exists public.gold_transactions (
  id            uuid        primary key default gen_random_uuid(),
  profile_id    uuid        not null references public.profiles(id) on delete cascade,
  amount        int         not null,
  balance_after int         not null check (balance_after >= 0),
  reason        text        not null,
  source        text,
  metadata      jsonb       not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists gold_transactions_profile_created_idx
  on public.gold_transactions (profile_id, created_at desc);

create index if not exists gold_transactions_reason_idx
  on public.gold_transactions (profile_id, reason, created_at desc);


-- ----------------------------------------------------------------------------
-- 2) gold_transactions RLS
-- ----------------------------------------------------------------------------
-- Kullanici sadece kendi gecmisini okuyabilir. Insert/Update/Delete
-- client'a kapali — yalnizca SECURITY DEFINER RPC'leri uzerinden yazilir.

alter table public.gold_transactions enable row level security;

drop policy if exists gold_tx_select_self on public.gold_transactions;

create policy gold_tx_select_self
  on public.gold_transactions
  for select
  to authenticated
  using (profile_id = auth.uid());

-- INSERT/UPDATE/DELETE icin policy tanimlanmadi — RLS varsayilan denial ile
-- bu islemleri tum client rollerine kapatir. SECURITY DEFINER fonksiyonlari
-- table owner olarak calistigi icin RLS'i bypass eder.

revoke all on public.gold_transactions from anon, authenticated;
grant  select on public.gold_transactions to authenticated;


-- ----------------------------------------------------------------------------
-- 3) profiles.gold kolonunu client UPDATE'inden korumak
-- ----------------------------------------------------------------------------
-- Column-level privilege ile hem anon hem authenticated rollerinin
-- profiles.gold uzerinde UPDATE yapmasini engelliyoruz. SECURITY DEFINER
-- fonksiyonlari fonksiyon sahibinin (postgres) yetkileriyle calistigi icin
-- bu kisitlamadan etkilenmez. Diger kolonlar (username, updated_at vb.)
-- mevcut RLS politikalari uzerinden yazilmaya devam eder.

revoke update (gold) on public.profiles from anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4) Internal helper: _apply_gold_delta
-- ----------------------------------------------------------------------------
-- Tum Gold mutasyonlarinin tek noktadan gecmesi icin private helper.
-- - profile satirini FOR UPDATE ile kilitler (race condition'a karsi).
-- - Negatif bakiyeye dusulmesini engeller.
-- - gold_transactions kaydini insert eder.
-- - Yeni bakiyeyi doner.

create or replace function public._apply_gold_delta(
  p_uid      uuid,
  p_delta    int,
  p_reason   text,
  p_source   text,
  p_metadata jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cur int;
  v_new int;
begin
  if p_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select coalesce(gold, 0) into v_cur
    from public.profiles
   where id = p_uid
   for update;

  if not found then
    raise exception 'no_profile' using errcode = '02000';
  end if;

  if p_delta < 0 and v_cur + p_delta < 0 then
    raise exception 'insufficient_gold' using errcode = '23514';
  end if;

  v_new := greatest(0, v_cur + p_delta);

  update public.profiles
     set gold       = v_new,
         updated_at = now()
   where id = p_uid;

  insert into public.gold_transactions
    (profile_id, amount, balance_after, reason, source, metadata)
  values
    (p_uid, p_delta, v_new, p_reason, p_source, coalesce(p_metadata, '{}'::jsonb));

  return v_new;
end
$fn$;

revoke all on function public._apply_gold_delta(uuid, int, text, text, jsonb)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5) claim_daily_gold_bonus()
-- ----------------------------------------------------------------------------
-- - auth.uid() dogrular.
-- - Profil satirini FOR UPDATE ile kilitler.
-- - Bugun (UTC) ayni profil icin reason='daily_bonus' kaydi varsa reddeder.
-- - Aksi halde +50 Gold ekler ve gold_transactions kaydi atar.
-- Donus: { ok, gold, amount, code? }

create or replace function public.claim_daily_gold_bonus()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_bonus  int  := 50;
  v_cur    int;
  v_new    int;
  v_today_start timestamptz;
  v_today_end   timestamptz;
  v_count  int;
begin
  if v_uid is null then
    return jsonb_build_object(
      'ok', false, 'code', 'unauthenticated',
      'message', 'Giriş yapmalısın.'
    );
  end if;

  -- Profil satirini kilitle — concurrent claim'ler serilize olsun.
  select coalesce(gold, 0) into v_cur
    from public.profiles
   where id = v_uid
   for update;

  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'no_profile',
      'message', 'Profil bulunamadı.'
    );
  end if;

  v_today_start := date_trunc('day', timezone('UTC', now()));
  v_today_end   := v_today_start + interval '1 day';

  select count(*) into v_count
    from public.gold_transactions
   where profile_id = v_uid
     and reason     = 'daily_bonus'
     and created_at >= v_today_start
     and created_at <  v_today_end;

  if v_count > 0 then
    return jsonb_build_object(
      'ok', false, 'code', 'already_claimed',
      'gold', v_cur,
      'message', 'Bugünkü bonusu zaten aldın.'
    );
  end if;

  v_new := v_cur + v_bonus;

  update public.profiles
     set gold       = v_new,
         updated_at = now()
   where id = v_uid;

  insert into public.gold_transactions
    (profile_id, amount, balance_after, reason, source, metadata)
  values
    (v_uid, v_bonus, v_new, 'daily_bonus', 'daily', '{}'::jsonb);

  return jsonb_build_object(
    'ok', true,
    'gold', v_new,
    'amount', v_bonus,
    'reason', 'daily_bonus'
  );
end
$fn$;


-- ----------------------------------------------------------------------------
-- 6) award_gameplay_gold(p_amount, p_reason, p_metadata)
-- ----------------------------------------------------------------------------
-- Gameplay sonu odullerini server uzerinden vermek icin RPC.
-- Defansif onlemler:
--   - allowed_reasons whitelist'i (arbitrary reason yazimina kapali).
--   - amount cap (1..500) tek cagri basina.
--   - Negatif/0 reddedilir.
-- Client gameplay kodu addGold() araciligi ile bu RPC'yi cagirir.
--
-- Donus: { ok, gold, amount, code? }

create or replace function public.award_gameplay_gold(
  p_amount   int,
  p_reason   text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_allowed text[] := array[
    'map_match_reward',
    'silhouette_match_reward',
    'flag_match_reward',
    'route_match_reward',
    'conquest_liman_income',
    'gameplay_award'  -- generic fallback (gameplay files lacking a specific reason)
  ];
  v_max     int  := 500;
  v_new     int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_amount');
  end if;
  if p_amount > v_max then
    return jsonb_build_object('ok', false, 'code', 'amount_exceeds_cap', 'cap', v_max);
  end if;
  if not (p_reason = any(v_allowed)) then
    return jsonb_build_object('ok', false, 'code', 'invalid_reason');
  end if;

  v_new := public._apply_gold_delta(
    v_uid, p_amount, p_reason, 'gameplay', coalesce(p_metadata, '{}'::jsonb)
  );

  return jsonb_build_object('ok', true, 'gold', v_new, 'amount', p_amount);
end
$fn$;


-- ----------------------------------------------------------------------------
-- 7) spend_gameplay_gold(p_amount, p_reason, p_metadata)
-- ----------------------------------------------------------------------------
-- Gameplay sirasinda ipucu vb. harcamalari icin RPC. Allowed reason whitelist'i
-- ve amount cap'i ile sinirli. Yetersiz bakiyede 'insufficient_gold' doner.
--
-- Donus: { ok, gold, amount, code? }

create or replace function public.spend_gameplay_gold(
  p_amount   int,
  p_reason   text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_allowed text[] := array[
    'hint_first_letter',
    'hint_letter_count',
    'hint_continent',
    'hint_region',
    'hint_coast',
    'hint_neighbors',
    'hint_silhouette',
    'hint_generic',
    'gameplay_spend'  -- generic fallback for gameplay-side spends
  ];
  v_max     int  := 500;
  v_new     int;
  v_cur     int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'unauthenticated');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_amount');
  end if;
  if p_amount > v_max then
    return jsonb_build_object('ok', false, 'code', 'amount_exceeds_cap', 'cap', v_max);
  end if;
  if not (p_reason = any(v_allowed)) then
    return jsonb_build_object('ok', false, 'code', 'invalid_reason');
  end if;

  -- Yetersiz bakiyeyi structured kod ile dondurmek icin _apply_gold_delta'i
  -- exception bloguna sariyoruz.
  begin
    v_new := public._apply_gold_delta(
      v_uid, -p_amount, p_reason, 'gameplay', coalesce(p_metadata, '{}'::jsonb)
    );
  exception when sqlstate '23514' then
    select coalesce(gold, 0) into v_cur from public.profiles where id = v_uid;
    return jsonb_build_object(
      'ok', false, 'code', 'insufficient_gold', 'gold', coalesce(v_cur, 0)
    );
  end;

  return jsonb_build_object('ok', true, 'gold', v_new, 'amount', p_amount);
end
$fn$;


-- ----------------------------------------------------------------------------
-- 8) change_username — gold_transactions entegrasyonu
-- ----------------------------------------------------------------------------
-- Mevcut change_username RPC fonksiyonunu, Gold harcamasini transaction
-- log'a yazacak sekilde tekrar tanimliyoruz. Mantik birebir ayni; sadece
-- update sonrasi insert into gold_transactions eklendi.
--
-- Ilk (ucretsiz) degisiklik icin amount=0, reason='username_initial_set'
-- olarak izleme amaciyla kayit atilir.

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
  v_new_gold        int;
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

  if coalesce(v_cur_norm, lower(coalesce(v_cur_username, '')), '') = v_norm then
    return jsonb_build_object(
      'ok', false, 'code', 'same_as_current',
      'message', 'Bu zaten mevcut kullanıcı adın.'
    );
  end if;

  v_is_first := coalesce(v_change_count, 0) = 0;

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

  v_new_gold := case
                  when v_is_first then coalesce(v_gold, 0)
                  else greatest(0, coalesce(v_gold, 0) - v_cost)
                end;

  update public.profiles
     set username              = v_clean,
         username_normalized   = v_norm,
         username_changed_at   = now(),
         username_change_count = coalesce(username_change_count, 0) + 1,
         gold                  = v_new_gold,
         updated_at            = now()
   where id = v_uid;

  -- Gold transaction log:
  --   - Ilk degisiklik   → amount=0,    reason='username_initial_set'
  --   - Sonraki degisik. → amount=-500, reason='username_change'
  if v_is_first then
    insert into public.gold_transactions
      (profile_id, amount, balance_after, reason, source, metadata)
    values
      (v_uid, 0, v_new_gold, 'username_initial_set', 'profile',
       jsonb_build_object('new_username', v_clean));
  else
    insert into public.gold_transactions
      (profile_id, amount, balance_after, reason, source, metadata)
    values
      (v_uid, -v_cost, v_new_gold, 'username_change', 'profile',
       jsonb_build_object('new_username', v_clean,
                          'previous_username', v_cur_username));
  end if;

  return jsonb_build_object(
    'ok',        true,
    'username',  v_clean,
    'gold',      v_new_gold,
    'was_first', v_is_first,
    'cost',      case when v_is_first then 0 else v_cost end
  );

exception when unique_violation then
  return jsonb_build_object(
    'ok', false, 'code', 'taken',
    'message', 'Bu kullanıcı adı başka biri tarafından alınmış.'
  );
end
$fn$;


-- ----------------------------------------------------------------------------
-- 9) Grants
-- ----------------------------------------------------------------------------

revoke all on function public.claim_daily_gold_bonus()                       from public;
revoke all on function public.award_gameplay_gold(int, text, jsonb)          from public;
revoke all on function public.spend_gameplay_gold(int, text, jsonb)          from public;
revoke all on function public.change_username(text)                          from public;

grant  execute on function public.claim_daily_gold_bonus()                   to authenticated;
grant  execute on function public.award_gameplay_gold(int, text, jsonb)      to authenticated;
grant  execute on function public.spend_gameplay_gold(int, text, jsonb)      to authenticated;
grant  execute on function public.change_username(text)                      to authenticated;


-- ============================================================================
-- Dogrulama
-- ============================================================================
--   -- tablo & RLS
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public' and tablename = 'gold_transactions';
--   select policyname, cmd, roles from pg_policies
--    where schemaname = 'public' and tablename = 'gold_transactions';
--
--   -- gold update yetkisi kaldirildi mi?
--   select grantee, privilege_type, column_name
--     from information_schema.column_privileges
--    where table_schema = 'public' and table_name = 'profiles'
--      and column_name  = 'gold';
--
--   -- RPC'ler:
--   select public.claim_daily_gold_bonus();
--   select public.award_gameplay_gold(50, 'map_match_reward', '{}'::jsonb);
--   select public.spend_gameplay_gold(20, 'hint_neighbors',   '{}'::jsonb);
-- ============================================================================
