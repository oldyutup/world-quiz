-- ============================================================================
-- Kör Nokta — "Lobiye Dön" sonuç-ekranı presence'ı (server-otoriter)
-- ============================================================================
-- SORUN: Sonuç ekranındaki "Lobiye Dön" YALNIZ client'ın yerel `returnedToLobby`
-- state'ini değiştiriyordu. Bir oyuncu hâlâ sonuç ekranındayken bile diğer
-- oyuncuların lobisinde normal (aktif) görünüyordu; kimin döndüğü / kimin hâlâ
-- sonuç ekranında olduğu paylaşılmıyordu.
--
-- ÇÖZÜM (Kuşatma readyPlayerIds akışının Kör Nokta karşılığı):
--   • Maç bittiğinde (status='finished', game_state.phase='final_results')
--     "Lobiye Dön" diyen oyuncuların id'leri game_state.returnedPlayerIds
--     dizisinde SERVER'da tutulur.
--   • Bu RPC id'yi diziye idempotent ekler; mevcut tevatur_rooms realtime
--     UPDATE aboneliği (postgres_changes) değişikliği tüm istemcilere yayar.
--     Yeni bir presence kanalı / tablo YOK — mevcut game_state sync akışı reuse.
--   • Lobi UI'sı: returnedPlayerIds'te OLMAYAN oyuncular gri/pasif kartta
--     "Sonuç ekranında" etiketiyle görünür (Kuşatma cq-player-chip--inactive
--     paritesi). Dönen oyuncu normal aktif karta geçer.
--
-- RESET: returnedPlayerIds YALNIZ maç sonu (finished) game_state'inde yaşar.
-- Yeni oyun tevatur_kn_start_game ile SIFIRDAN game_state kurar (returnedPlayerIds
-- taşınmaz); yeni oda game_state=null olur → eski state doğal olarak sıfırlanır.
--
-- DOKUNULMAYANLAR (bilinçli): oda/oyuncu tabloları, diğer tüm RPC'ler, faz
-- akışı, puanlama, start_game/advance/apply/submit — HİÇBİRİ değişmez. Bu
-- migration yalnız YENİ tevatur_kn_return_to_lobby fonksiyonunu ekler.
-- ============================================================================

create or replace function public.tevatur_kn_return_to_lobby(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.tevatur_rooms;
  v_state    jsonb;
  v_returned jsonb;
  v_pid      text := p_player_id::text;
begin
  -- Çağıran, bu odanın yetkili oyuncusu olmalı (profile_id = auth.uid()
  -- + claim_token eşleşmesi). tevatur_authorize_player tek-tip yol.
  if not public.tevatur_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Oda satırını kilitle (eşzamanlı iki "Lobiye Dön" arası race'i kapat).
  select * into v_room from public.tevatur_rooms where id = p_room_id for update;
  if v_room.id is null then
    return null;  -- oda yok → idempotent no-op (zaten silinmiş)
  end if;

  -- Oyuncu gerçekten bu odada mı? Değilse dokunma, güncel odayı döndür.
  if not exists (
    select 1 from public.tevatur_players
     where id = p_player_id and room_id = p_room_id
  ) then
    return v_room;
  end if;

  -- Yalnız maç bittiğinde anlamlı. Oyun devam ederken / lobide iken no-op
  -- (returnedPlayerIds yalnız final_results game_state'inde yaşamalı).
  if v_room.status <> 'finished' or v_room.game_state is null then
    return v_room;
  end if;

  v_state    := v_room.game_state;
  v_returned := coalesce(v_state->'returnedPlayerIds', '[]'::jsonb);
  if jsonb_typeof(v_returned) <> 'array' then
    v_returned := '[]'::jsonb;
  end if;

  -- Zaten listedeyse dokunma (idempotent) → gereksiz realtime event yok.
  if exists (
    select 1 from jsonb_array_elements_text(v_returned) e where e = v_pid
  ) then
    return v_room;
  end if;

  v_returned := v_returned || to_jsonb(v_pid);
  v_state    := jsonb_set(v_state, '{returnedPlayerIds}', v_returned, true);

  update public.tevatur_rooms
     set game_state = v_state
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.tevatur_kn_return_to_lobby(uuid, uuid, uuid) from public;
grant  execute on function public.tevatur_kn_return_to_lobby(uuid, uuid, uuid) to authenticated;

-- PostgREST/Supabase RPC schema cache'i yeni imzayı hemen görsün.
notify pgrst, 'reload schema';

-- ============================================================================
-- DONE — tevatur_kn_return_to_lobby: maç sonu oyuncu id'sini game_state.
-- returnedPlayerIds'e idempotent ekler (host/oyuncu ayrımı yok, herkes kendi
-- id'sini ekler). Realtime UPDATE tüm istemcilere yayar. Faz/puanlama/oda akışı
-- değişmedi.
-- ============================================================================
