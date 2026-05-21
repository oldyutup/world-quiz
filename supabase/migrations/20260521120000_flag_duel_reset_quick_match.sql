-- ============================================================================
-- Flag Duel — Hızlı Eşleş Reset RPC
-- ============================================================================
-- Background:
--   `flag_duel_cancel_quick_match` deletes ONLY rows whose matched_room_id is
--   null. This is intentional for the in-flight match flow (we must not race
--   with the candidate's realtime UPDATE listener). However it means a queue
--   row whose matched_room_id was set during an earlier match STAYS forever:
--
--     1. User A clicks "Hızlı Eşleş", matches user B, plays a game, game
--        finishes (duel_rooms.status='finished').
--     2. User A's flag_duel_queue row still has matched_room_id pointing at
--        the now-finished room.
--     3. User A returns to the FlagDuel screen and clicks "Hızlı Eşleş" again.
--     4. The client's SELECT-first guard reads the stale matched_room_id and
--        calls joinQuickMatchRoom — re-joining the OLD finished room.
--     5. The flag timer is anchored to room.current_flag_at which is minutes
--        old, so elapsed >> FLAG_TIMEOUT_SEC: the host immediately inserts a
--        TIMEOUT claim, the round resolves, advanceRoundAsHost runs, and the
--        client lands on the finished screen (often shown as a draw because
--        no real answers were recorded).
--
--   `flag_duel_quick_match` also has an early-return that surfaces the stale
--   matched_room_id, so even if the client ignored the SELECT-first guard the
--   RPC would still hand back the stale match.
--
-- Fix:
--   Add a small RPC that the client calls right before starting a fresh
--   search. It deletes the caller's queue row regardless of matched state.
--   Safe because:
--     - auth.uid() check restricts the delete to the caller's own row only.
--     - By the time a user returns to the FlagDuel screen, the candidate's
--       realtime UPDATE for matched_room_id has already been delivered (the
--       prior match either started or both clients have moved on).
--
-- Scope:
--   - Only adds a new function. No table/column/index/policy changes.
--   - Does not touch flag_duel_quick_match or flag_duel_cancel_quick_match.
--   - Does not touch anything in wheel_duel_*, duel_group_*, or other modes.
-- ============================================================================

create or replace function public.flag_duel_reset_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'flag_duel_reset_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'flag_duel_reset_quick_match: auth.uid() does not match p_profile_id';
  end if;

  delete from public.flag_duel_queue
   where profile_id = p_profile_id;
end;
$$;

revoke all on function public.flag_duel_reset_quick_match(uuid) from public;
grant execute on function public.flag_duel_reset_quick_match(uuid) to authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Verification (Studio SQL editor):
--
--   select proname, pg_get_function_arguments(oid)
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'flag_duel_reset_quick_match';
--
--   -- As an authenticated user (their JWT must match p_profile_id):
--   select flag_duel_reset_quick_match('<my profile uuid>'::uuid);
--   select * from flag_duel_queue where profile_id = '<my profile uuid>'::uuid;
--   -- Expected: no rows.
-- ============================================================================
