-- ============================================================================
-- Kuşatma (Conquest) — Host transfer on leave
-- ============================================================================
-- AMAÇ
-- ----
-- conquest_leave_room RPC'si host ayrıldığında odayı 'closed' yapıyor ve
-- diğer oyuncuları odadan atıyordu. Bu, yeni sonuç-ekranı → lobi akışıyla
-- çelişiyor: maç bitiminde host "Lobiye Dön" derse bile (artık 'Lobiye Dön'
-- odadan ayrılmıyor, ama host kasıtlı olarak odadan çıkmak isterse) oda
-- kapanmamalı, kalan aktif oyunculardan birine host devredilmeli.
--
-- DEĞİŞEN DAVRANIŞ
-- ----------------
--   • Host olmayan oyuncu ayrılırsa: önceki gibi sadece DELETE; oda hala
--     waiting/playing.
--   • Host ayrılır AND başka oyuncu varsa: en eski joined_at sahibi oyuncu
--     yeni host olur. conquest_rooms.host_player_id + host_name güncellenir,
--     ilgili conquest_players satırının is_host=true olur, eski host silinir.
--   • Host ayrılır AND başka oyuncu yoksa: önceki gibi oda 'closed' olur.
--   • Boş kalan oda (host olmayan ayrılır ve son oyuncuysa): 'closed'.
--
-- IDEMPOTENT
-- ----------
--   create or replace ile aynı imza üzerinde güncellenir.
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
  v_new_host        record;
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

  select count(*) into v_remaining_count
    from public.conquest_players
   where room_id = p_room_id;

  if v_remaining_count = 0 then
    -- Son oyuncu da çıktı → oda kapanır.
    update public.conquest_rooms
       set status      = 'closed',
           finished_at = now()
     where id = p_room_id;
    return;
  end if;

  if v_is_host then
    -- Host devri: en eski joined_at sahibi oyuncu yeni host olur.
    select id, name
      into v_new_host
      from public.conquest_players
     where room_id = p_room_id
     order by joined_at asc
     limit 1;

    if v_new_host.id is not null then
      update public.conquest_players
         set is_host = true
       where id = v_new_host.id;

      update public.conquest_rooms
         set host_player_id = v_new_host.id,
             host_name      = v_new_host.name
       where id = p_room_id;
    else
      -- Defensive: count > 0 demek satır vardı ama select bulamadı; odayı kapat.
      update public.conquest_rooms
         set status      = 'closed',
             finished_at = now()
       where id = p_room_id;
    end if;
  end if;
end;
$$;

revoke all on function public.conquest_leave_room(uuid, uuid, uuid) from public;
grant execute on function public.conquest_leave_room(uuid, uuid, uuid) to anon, authenticated;
