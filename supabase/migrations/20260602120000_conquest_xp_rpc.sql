-- ============================================================================
-- Conquest (Kuşatma) — Adanmış XP RPC (award_conquest_xp_event)
-- ============================================================================
-- Amaç:
--   Mevcut public.award_xp_event RPC'sinin mode_key whitelist'i 'conquest'i
--   kabul etmiyor. Bu migration mevcut RPC'ye DOKUNMAZ; sadece conquest için
--   adanmış yeni bir RPC ekler. Client (progression.ts) modeKey === 'conquest'
--   olduğunda bu RPC'yi çağırır, diğer modlar eski RPC'yi kullanmaya devam eder.
--   Pattern: 20260518130000_wheel_group_xp_rpc.sql ile birebir aynıdır.
--
-- DOKUNMAZ:
--   * public.award_xp_event (mevcut RPC)
--   * public.award_wheel_group_xp_event (wheel_group adanmış RPC)
--   * public.xp_events tablosu (kolonlar, UNIQUE index)
--   * public.profiles
--   * conquest_rooms / conquest_players / conquest_*
--
-- Idempotency:
--   * Outer DO bloku tagged delimiter (outer / sql).
--   * create or replace function -> tekrar çalıştırılabilir.
--   * CHECK constraint patch'i 'conquest'i zaten içeriyorsa erken döner.
--
-- xp_events kolon varsayımı (önceki migration'larla aynı):
--   profile_id uuid, mode_key text, room_id uuid, xp_earned integer,
--   result text, details jsonb, created_at timestamptz default now()
--   UNIQUE (profile_id, mode_key, room_id)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) (Defansif) xp_events.mode_key CHECK constraint'ini conquest için genişlet
-- ----------------------------------------------------------------------------
do $outer$
declare
  v_conname text;
  v_def     text;
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'xp_events'
  ) then
    raise notice 'xp_events tablosu yok; CHECK constraint patch atlandi.';
    return;
  end if;

  select c.conname, pg_get_constraintdef(c.oid)
    into v_conname, v_def
    from pg_constraint c
    join pg_attribute  a on a.attrelid = c.conrelid
                        and a.attnum   = any(c.conkey)
   where c.conrelid = 'public.xp_events'::regclass
     and c.contype  = 'c'
     and a.attname  = 'mode_key'
   limit 1;

  if v_conname is null then
    raise notice 'xp_events.mode_key uzerinde CHECK constraint yok; patch gerekmez.';
    return;
  end if;

  if v_def ilike '%conquest%' then
    raise notice 'CHECK constraint zaten conquest iceriyor; atlandi.';
    return;
  end if;

  begin
    execute format('alter table public.xp_events drop constraint %I', v_conname);
    execute $sql$
      alter table public.xp_events
        add constraint xp_events_mode_key_check
        check (mode_key in (
          'country_duel',
          'flag_duel',
          'wheel_duel',
          'wheel_group',
          'conquest'
        ))
    $sql$;
    raise notice 'CHECK constraint conquest dahil yeniden olusturuldu.';
  exception when others then
    raise notice 'CHECK constraint yeniden olusturulamadi: %', sqlerrm;
  end;
end
$outer$;


-- ----------------------------------------------------------------------------
-- 2) award_conquest_xp_event RPC
-- ----------------------------------------------------------------------------
-- Sözleşme (mevcut award_xp_event / award_wheel_group_xp_event ile aynı):
--   params:
--     p_profile_id uuid     -- auth.uid() ile eşleşmeli
--     p_room_id    uuid     -- bu maç için stabil, eşsiz match UUID
--     p_xp_earned  int      -- [0, 500] aralığına clamp edilir
--     p_result     text     -- 'win' | 'draw' | 'loss'
--     p_details    jsonb    -- default {}
--
--   returns jsonb:
--     awarded   boolean
--     reason    'already_claimed' | null
--     xp_earned integer (gerçekten yazılan)
--     total_xp  integer (kullanıcının tüm modlardaki toplam XP'si)
--     mode_xp   integer (kullanıcının conquest XP'si)
--
-- SECURITY DEFINER: auth.uid() check içeride yapılır → başkası adına yazılamaz.
-- ----------------------------------------------------------------------------

create or replace function public.award_conquest_xp_event(
  p_profile_id uuid,
  p_room_id    uuid,
  p_xp_earned  int,
  p_result     text,
  p_details    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_clamped   int;
  v_inserted  boolean := false;
  v_total_xp  int;
  v_mode_xp   int;
begin
  if v_uid is null then
    raise exception 'auth_required'
      using hint = 'award_conquest_xp_event requires authenticated user';
  end if;

  if v_uid <> p_profile_id then
    raise exception 'profile_id_mismatch (uid=% profile_id=%)', v_uid, p_profile_id
      using hint = 'p_profile_id must equal auth.uid()';
  end if;

  if p_result not in ('win', 'draw', 'loss') then
    raise exception 'invalid_result: %', p_result
      using hint = 'p_result must be one of: win, draw, loss';
  end if;

  v_clamped := greatest(0, least(500, coalesce(p_xp_earned, 0)));

  if v_clamped > 0 then
    insert into public.xp_events (
      profile_id, mode_key, room_id, xp_earned, result, details
    )
    values (
      p_profile_id, 'conquest', p_room_id, v_clamped, p_result,
      coalesce(p_details, '{}'::jsonb)
    )
    on conflict (profile_id, mode_key, room_id) do nothing;

    if found then
      v_inserted := true;
    end if;
  end if;

  select coalesce(sum(xp_earned), 0)::int
    into v_total_xp
    from public.xp_events
   where profile_id = p_profile_id;

  select coalesce(sum(xp_earned), 0)::int
    into v_mode_xp
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = 'conquest';

  if v_inserted then
    return jsonb_build_object(
      'awarded',   true,
      'reason',    null,
      'xp_earned', v_clamped,
      'total_xp',  v_total_xp,
      'mode_xp',   v_mode_xp
    );
  end if;

  return jsonb_build_object(
    'awarded',   false,
    'reason',    'already_claimed',
    'xp_earned', 0,
    'total_xp',  v_total_xp,
    'mode_xp',   v_mode_xp
  );
end
$fn$;


-- ----------------------------------------------------------------------------
-- 3) Grants — sadece authenticated kullanıcılar çağırabilir
-- ----------------------------------------------------------------------------
revoke all on function public.award_conquest_xp_event(uuid, uuid, int, text, jsonb) from public;
revoke all on function public.award_conquest_xp_event(uuid, uuid, int, text, jsonb) from anon;
grant execute on function public.award_conquest_xp_event(uuid, uuid, int, text, jsonb) to authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama (Studio SQL editor):
--
--   select proname, pg_get_function_arguments(oid)
--     from pg_proc
--    where proname = 'award_conquest_xp_event'
--      and pronamespace = 'public'::regnamespace;
--
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.xp_events'::regclass
--      and contype  = 'c';
-- ============================================================================
