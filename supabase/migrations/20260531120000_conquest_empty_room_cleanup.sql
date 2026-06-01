-- ============================================================================
-- Kuşatma (Conquest) — Phase 9.1: empty-room cleanup on leave
-- ============================================================================
-- AMAÇ
-- ----
-- conquest_leave_room RPC'si oyuncuyu sildikten sonra odada kimse kalmadıysa
-- odayı status='closed' işaretler. Böylece public oda listesi (status='waiting'
-- süzgeci kullanır) boş odaları anında düşürür.
--
-- KORUNAN DAVRANIŞ
-- ----------------
--   • Host (logged-in) ayrıldığında oda yine 'closed' olur (Phase 5'ten
--     beri böyle; host-transfer akışı eklenmedi).
--   • Host olmayan oyuncu ayrıldığında ve odada başka oyuncular kaldıysa
--     oda 'waiting' kalır → lobide kalanlar etkilenmez.
--   • RLS/Yetki: idempotent leave, yetkisiz/yanlış oda no-op.
--
-- DEĞİŞEN TEK ŞEY
-- ---------------
--   • DELETE'den sonra v_remaining_count hesaplanır. 0 ise status='closed'.
--     v_is_host TRUE ise yine 'closed' (eski davranış).
--
-- IDEMPOTENT
-- ----------
--   create or replace function ile aynı imza üzerinde güncellenir.
-- ============================================================================

create or replace function public.conquest_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_is_host         boolean;
  v_remaining_count int;
begin
  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select is_host into v_is_host
    from public.conquest_players
   where id = p_player_id and room_id = p_room_id;

  if v_is_host is null then
    return; -- zaten yok / yanlış oda → no-op
  end if;

  delete from public.conquest_players where id = p_player_id;

  -- Kalan oyuncu sayısı: 0 ise oda public listten anında düşmeli.
  select count(*) into v_remaining_count
    from public.conquest_players
   where room_id = p_room_id;

  if v_remaining_count = 0 or v_is_host then
    update public.conquest_rooms
       set status      = 'closed',
           finished_at = now()
     where id = p_room_id;
  end if;
end;
$$;

revoke all on function public.conquest_leave_room(uuid, uuid, uuid) from public;
grant execute on function public.conquest_leave_room(uuid, uuid, uuid) to anon, authenticated;
