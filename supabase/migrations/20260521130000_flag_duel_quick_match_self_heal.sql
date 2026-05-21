-- ============================================================================
-- Flag Duel — flag_duel_quick_match self-healing for stale matched_room_id
-- ============================================================================
-- Background:
--   The original `flag_duel_quick_match` RPC has an early-return block:
--
--     select matched_room_id into v_existing where profile_id = p_profile_id;
--     if found and v_existing.matched_room_id is not null then
--       return jsonb_build_object('matched', true, 'room_id', ...);
--     end if;
--
--   This was meant to handle a race where a parallel RPC matched us between
--   ticks. But it ALSO surfaces any leftover matched_room_id from a previous
--   game — including one where the duel_rooms row is now status='finished'
--   or many minutes old. `flag_duel_cancel_quick_match` only deletes
--   matched_room_id IS NULL rows by design (so it doesn't race with the
--   candidate's realtime UPDATE listener), so a stale matched_room_id can
--   stick to a profile_id indefinitely.
--
--   The previous client-side fix made joinQuickMatchRoom silently skip stale
--   rooms instead of erroring to lobby. That stops the user from joining a
--   dead match — but it ALSO means the queue row's matched_room_id is never
--   cleared and expires_at is never refreshed, because the tick returns
--   right after the silent skip without calling this RPC. The result:
--
--     • Caller's matched_room_id stays set → caller's RPC keeps short-
--       circuiting to the same stale match, never searches for candidates.
--     • Caller's row is filtered out of every other player's candidate
--       search (`matched_room_id IS NULL` filter).
--
--   Two players in this state both spin in "Rakip aranıyor…" forever
--   without ever finding each other.
--
-- Fix:
--   Add an opportunistic self-heal at the top of every RPC call: clear the
--   caller's matched_room_id if it points to a room that is no longer a
--   joinable fresh quick-match room (status <> 'playing' OR created more
--   than 60 seconds ago). The rest of the function body is unchanged.
--
-- Why 60 seconds:
--   `flag_duel_quick_match` creates rooms with `started_at = now() + 3s` and
--   `created_at = now()`, and the candidate's realtime listener joins within
--   a few seconds at most. A real, fresh quick-match room therefore has
--   `created_at` within the last ~10s; anything older is a leftover from a
--   game that already started (and either finished or is being played, in
--   which case the active client wouldn't be running this RPC anyway —
--   `flag_duel_quick_match` is only called from phase === 'searching').
--   60s is a conservative grace window.
--
-- Scope:
--   • Replaces ONE function (CREATE OR REPLACE). No table/column/index/
--     policy/RLS/publication changes.
--   • Does not touch wheel_duel_*, duel_group_*, country DuelGame, or any
--     other RPC.
--   • Does not change the function signature, return shape, or any of the
--     match-creation / queue-upsert logic below the self-heal block — only
--     adds a UPDATE statement after the param checks and before the
--     v_existing read.
-- ============================================================================

create or replace function public.flag_duel_quick_match(
  p_profile_id      uuid,
  p_player_id       uuid,
  p_player_name     text,
  p_total_rounds    int,
  p_region          text,
  p_max_level_diff  int,
  p_room_code       text,
  p_first_flag      text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_level     int;
  v_candidate    record;
  v_room_id      uuid;
  v_now          timestamptz := now();
  v_started_at   timestamptz := v_now + interval '3 seconds';
  v_expires_at   timestamptz := v_now + interval '45 seconds';
  v_existing     record;
begin
  -- ── Auth check ─────────────────────────────────────────────────────────
  if auth.uid() is null then
    raise exception 'flag_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'flag_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  -- ── Parametre kontrolleri ──────────────────────────────────────────────
  if p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'flag_duel_quick_match: invalid total_rounds %', p_total_rounds;
  end if;
  if p_max_level_diff < 0 then
    raise exception 'flag_duel_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if coalesce(p_room_code, '') = '' or coalesce(p_first_flag, '') = '' then
    raise exception 'flag_duel_quick_match: empty room_code or first_flag';
  end if;

  -- ── Caller'ın level'ı ──────────────────────────────────────────────────
  v_my_level := public.flag_duel_mode_level(p_profile_id);

  -- ── Opportunistic stale-row self-heal ─────────────────────────────────
  -- Clear caller's matched_room_id if it points at a duel_rooms row that
  -- is no longer a fresh joinable quick-match room. Without this, a stale
  -- matched_room_id from a previously-broken match makes the early-return
  -- below fire forever, blocking real matchmaking — and also keeps the
  -- caller invisible to other players' candidate searches (which filter
  -- matched_room_id IS NULL).
  update public.flag_duel_queue q
     set matched_room_id = null,
         updated_at      = v_now
   where q.profile_id      = p_profile_id
     and q.matched_room_id is not null
     and not exists (
       select 1
         from public.duel_rooms r
        where r.id = q.matched_room_id
          and r.status = 'playing'
          and r.created_at > v_now - interval '60 seconds'
     );

  -- ── Caller'ın mevcut queue satırı (varsa) ──────────────────────────────
  -- Eğer paralel bir RPC bizi zaten eşleştirdiyse direkt o satırı dön.
  -- (SELECT-first fallback'in DB tarafı eşleniği — defensive layer.)
  -- After the self-heal above, this only fires for genuinely fresh matches.
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.flag_duel_queue
   where profile_id = p_profile_id;

  if found and v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  -- ── Uygun aday ara (FOR UPDATE SKIP LOCKED ile race-safe) ──────────────
  select q.profile_id, q.player_id, q.player_name, q.mode_level,
         q.max_level_diff, q.created_at
    into v_candidate
    from public.flag_duel_queue q
   where q.profile_id      <> p_profile_id
     and q.region            = p_region
     and q.total_rounds      = p_total_rounds
     and q.matched_room_id  is null
     and q.expires_at        > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı atomik kur ──────────────────────────────────────
    insert into public.duel_rooms (
      code,
      status,
      duration_seconds,
      region,
      started_at,
      total_rounds,
      current_round,
      is_golden_round,
      current_flag,
      current_flag_at,
      room_source
    ) values (
      p_room_code,
      'playing',
      60,
      p_region,
      v_started_at,
      p_total_rounds,
      1,
      false,
      p_first_flag,
      v_started_at,
      'quick_match'
    )
    returning id into v_room_id;

    insert into public.duel_players (id, room_id, name, score)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, 0);

    insert into public.duel_players (id, room_id, name, score)
      values (p_player_id, v_room_id, p_player_name, 0);

    update public.flag_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    insert into public.flag_duel_queue as q (
      profile_id, player_id, player_name,
      total_rounds, region, mode_level, max_level_diff,
      matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, p_player_name,
      p_total_rounds, p_region, v_my_level, p_max_level_diff,
      v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id       = excluded.player_id,
          player_name     = excluded.player_name,
          total_rounds    = excluded.total_rounds,
          region          = excluded.region,
          mode_level      = excluded.mode_level,
          max_level_diff  = excluded.max_level_diff,
          matched_room_id = excluded.matched_room_id,
          expires_at      = excluded.expires_at,
          updated_at      = excluded.updated_at;

    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_room_id,
      'my_player_id',       p_player_id,
      'opponent_name',      v_candidate.player_name,
      'search_age_seconds', 0
    );
  end if;

  -- ── EŞLEŞME YOK — caller'ın queue satırını UPSERT ──────────────────────
  -- DİKKAT: matched_room_id'yi yalnız NULL ise güncelliyoruz. Paralel bir
  -- RPC bizi az önce eşleştirip matched_room_id'yi set ettiyse,
  -- aşağıdaki UPDATE onu NULL'a sıfırlamamalı (yarış koruması).
  insert into public.flag_duel_queue as q (
    profile_id, player_id, player_name,
    total_rounds, region, mode_level, max_level_diff,
    matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, p_player_name,
    p_total_rounds, p_region, v_my_level, p_max_level_diff,
    null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id      = excluded.player_id,
        player_name    = excluded.player_name,
        total_rounds   = excluded.total_rounds,
        region         = excluded.region,
        mode_level     = excluded.mode_level,
        max_level_diff = excluded.max_level_diff,
        expires_at     = excluded.expires_at,
        updated_at     = excluded.updated_at
    where q.matched_room_id is null;

  -- UPSERT sonrası tekrar oku → arada matched olduysa direkt dön
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.flag_duel_queue
   where profile_id = p_profile_id;

  if v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  return jsonb_build_object(
    'matched',            false,
    'search_age_seconds', greatest(0, extract(epoch from (v_now - coalesce(v_existing.created_at, v_now)))::int)
  );
end;
$$;


-- GRANTs preserved from the original migration (idempotent).
revoke all on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) from public;
grant  execute on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) to authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Verification (Studio SQL editor):
--
--   -- Confirm the function still exists with the same signature:
--   select proname, pg_get_function_arguments(oid)
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'flag_duel_quick_match';
--
--   -- Manual stale-row self-heal smoke test (replace UUIDs accordingly):
--   --
--   --   1. Insert a fake stale matched_room_id:
--   --      update flag_duel_queue
--   --         set matched_room_id = '00000000-0000-0000-0000-000000000000'::uuid
--   --       where profile_id = '<my profile uuid>'::uuid;
--   --
--   --   2. Call flag_duel_quick_match as that user.
--   --   3. Confirm: matched_room_id is now NULL because the referenced room
--   --      does not exist / is not status='playing' / is older than 60s.
--   --      select matched_room_id from flag_duel_queue where profile_id = ...;
--   --
--   -- Two-user matchmaking smoke test:
--   --   - As user A: select flag_duel_quick_match('<A>', gen_random_uuid(), 'A',
--   --                                              10, 'world', 9999, 'FQTST1', 'tr');
--   --     Expected: { "matched": false, ... }
--   --   - As user B (same total_rounds + region):
--   --     select flag_duel_quick_match('<B>', gen_random_uuid(), 'B',
--   --                                  10, 'world', 9999, 'FQTST2', 'tr');
--   --     Expected: { "matched": true, "room_id": <uuid>, ... }
--   --   - As user A again on next tick:
--   --     select flag_duel_quick_match(... same args ...);
--   --     Expected: { "matched": true, "room_id": <same uuid> }
-- ============================================================================
