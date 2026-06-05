-- ============================================================================
-- WHEEL DUEL · leave_room → playing fazında forfeit/win'e dönüştür
-- ----------------------------------------------------------------------------
-- Sorun:
--   Mevcut wheel_duel_leave_room aktif maçta (status='playing') şu yolu
--   izliyordu:
--     • Host çıkarsa → oda DELETE (cascade) → kalan oyuncuda "ODA KAPATILDI"
--       modal'ı görünüyor, XP/gold/leaderboard akışı çalışmıyor.
--     • Guest çıkarsa → sadece guest'in player satırı DELETE → host yalnız
--       oynamaya devam ediyor, oyun hiç bitmiyor.
--
-- Çözüm (bu migration):
--   Playing fazında leave artık forfeit'tir:
--     • Oda + iki player satırı KORUNUR.
--     • status='finished', finished_at=now(), finished_reason='opponent_left'.
--     • winner_player_id = caller'ın DIŞINDAKİ ilk player (kalan oyuncu).
--     • current_target_topoid temizlenir (tur sonlanır).
--   Bu sayede kalan oyuncu mevcut sonuç paneli + XP/gold/leaderboard
--   akışından normal bir kazanma gibi geçer (wheel_duel_finish_game ile
--   tamamen aynı kolonları yazıyoruz, XP useEffect zaten winner_player_id +
--   current_match_id okuyor).
--
--   Playing dışı (waiting / finished / vs.) fazlarda eski davranış korunur:
--     • Host → oda DELETE (cascade).
--     • Guest → kendi player satırı DELETE.
--   Sonuç ekranından "Ana Menü"ye basan kalan oyuncunun cleanup'ı bu yolla
--   geliyor (status zaten 'finished' olduğu için fallback'e düşer).
--
-- Korunan davranışlar:
--   • Authorization: wheel_duel_authorize_player(p_player_id, p_claim_token)
--     aynı.
--   • Idempotent: oda yoksa sessiz no-op.
--   • İmza değişmedi: (uuid, uuid, uuid) → void.
--   • RLS politikaları, tablo şeması, yeni kolon yok.
--
-- Edge case:
--   Playing fazında ama kalan başka oyuncu YOK (anormal durum) → forfeit
--   bloğu atlanır, fallback DELETE'e düşülür → cleanup.
-- ============================================================================

create or replace function public.wheel_duel_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_is_host  boolean;
  v_status   text;
  v_other_id uuid;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select (host_player_id = p_player_id), status
    into v_is_host, v_status
    from public.wheel_duel_rooms
   where id = p_room_id;

  if v_is_host is null then
    return;  -- oda yok → idempotent no-op
  end if;

  -- ───── PLAYING fazında çıkış = forfeit, kalan oyuncu kazanır ─────
  if v_status = 'playing' then
    select id into v_other_id
      from public.wheel_duel_players
     where room_id = p_room_id
       and id <> p_player_id
     order by joined_at asc
     limit 1;

    if v_other_id is not null then
      -- Oda + player satırları KORUNUR. Kalan oyuncu sonuç ekranını ve
      -- XP/gold/leaderboard akışını normal kazanma gibi alır.
      -- wheel_duel_finish_game ile aynı kolonları yazıyoruz; uyumlu.
      update public.wheel_duel_rooms
         set status                = 'finished',
             finished_at           = now(),
             finished_reason       = 'opponent_left',
             winner_player_id      = v_other_id,
             current_target_topoid = null
       where id = p_room_id
         and status = 'playing';
      return;
    end if;
    -- Kalan oyuncu yoksa (anormal) → fallback cleanup'a düş
  end if;

  -- ───── Diğer durumlar (waiting/finished/anormal): eski davranış ─────
  if v_is_host then
    -- Cascade: wheel_duel_players + wheel_duel_player_claims temizlenir
    delete from public.wheel_duel_rooms where id = p_room_id;
  else
    delete from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.wheel_duel_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_leave_room(uuid, uuid, uuid) to anon, authenticated;

-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama (manuel):
--   1) Playing fazında host leave → oda finished, winner_player_id = guest.
--      select status, winner_player_id, finished_reason
--        from wheel_duel_rooms where id = '<room>';
--   2) Playing fazında guest leave → oda finished, winner_player_id = host.
--   3) Waiting fazında host leave → oda DELETE (eski davranış).
--   4) Finished fazında "Ana Menü" → host DELETE / guest player DELETE.
-- ============================================================================
