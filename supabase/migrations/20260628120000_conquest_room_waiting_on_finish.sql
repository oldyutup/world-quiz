-- ============================================================================
-- Kuşatma (Conquest) — Match finished → room.status='waiting' (public listing)
-- ============================================================================
-- AMAÇ
-- ----
-- Maç bittiğinde (gameplay_state.phase = 'finished') oda status'u 'playing'te
-- kalıyor, dolayısıyla "Odalara Göz At" listesinin
--   visibility='public' AND status='waiting'
-- filtresinden düşüyor. Aynı maç bitince oda lobby'ye dönmesine rağmen public
-- listede görünmüyordu.
--
-- DEĞİŞEN DAVRANIŞ
-- ----------------
-- conquest_apply_gameplay_state RPC'si gameplay_state'i yazarken yeni state'in
-- phase'i 'finished' ise aynı UPDATE içinde status='waiting' + started_at=null
-- olarak da güncelliyor. Böylece:
--   • Public/açık odalar maç bittikten sonra anında "Odalara Göz At"
--     listesinde tekrar görünür.
--   • Bir sonraki maç başlangıcı (initializeConquestGameplayState) status'u
--     yine 'playing'e çevirir; başka değişiklik gerekmez.
--   • RPC ön-koşulu hala status='playing' — yani finish yazımı tek seferlik
--     transition; ek yazım denemeleri (beklenmiyor) güvenle reddedilir.
--
-- ÖNEMLİ
-- ------
-- Status flip *sadece* gameplay_state yazımıyla birlikte yapılıyor; ayrı bir
-- realtime UPDATE yok. Bu, "playing → waiting transition herkesi zorla
-- lobiye çekiyor" eski bugının geri gelmesini engeller — ConquestMode'da
-- status değişimi için ayrı bir branch yok, sadece finished gameplay_state
-- realtime'da yayılırsa istemciler kendi yerel finish akışını çalıştırır.
--
-- IDEMPOTENT
-- ----------
-- create or replace ile aynı imza üzerinde güncellenir.
-- ============================================================================

create or replace function public.conquest_apply_gameplay_state(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_state       jsonb
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_is_finished boolean;
begin
  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.conquest_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.conquest_rooms
     where id = p_room_id and status = 'playing'
  ) then
    raise exception 'room_not_playing' using errcode = '42501';
  end if;

  if p_state is null then
    raise exception 'state_required' using errcode = '22023';
  end if;

  v_is_finished := (p_state ->> 'phase') = 'finished';

  if v_is_finished then
    update public.conquest_rooms
       set gameplay_state = p_state,
           status         = 'waiting',
           started_at     = null
     where id = p_room_id;
  else
    update public.conquest_rooms
       set gameplay_state = p_state
     where id = p_room_id;
  end if;
end;
$$;

revoke all on function public.conquest_apply_gameplay_state(uuid, uuid, uuid, jsonb) from public;
grant execute on function public.conquest_apply_gameplay_state(uuid, uuid, uuid, jsonb) to anon, authenticated;
