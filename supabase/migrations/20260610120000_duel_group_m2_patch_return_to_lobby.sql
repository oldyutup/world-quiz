-- ============================================================================
-- Duel Group — M2 patch · duel_group_return_to_lobby tüm player status reset
-- ============================================================================
-- SORUN
-- -----
-- M3 lockdown sonrası testte: oyun bitip host "Lobiye dön" dedikten sonra
-- diğer oyuncuların ekranında lobi açılıyor ama sol oyuncu listesinde
-- görünmüyorlar; yalnız host görünüyor.
--
-- KÖK NEDEN
-- ---------
-- Frontend lobi UI'ı `waitingPlayers = players.filter(p => p.status==="waiting")`
-- filtresine dayanıyor (slot grid, FAB badge, kapasite sayacı, Start butonu).
-- Oyun bitince her client `duel_group_mark_finished` RPC'siyle KENDI player
-- satırının status'unu 'finished' yapıyor. Sonra host "Lobiye dön" tıkladığında
-- `duel_group_return_to_lobby` RPC'si:
--   • room.status='finished' → 'waiting' (✓ doğru)
--   • YALNIZ host caller'ın kendi player satırının status'unu 'waiting' yapıyor
-- → Misafirlerin status'u 'finished' KALIYOR → waitingPlayers filtresi onları
-- listeden eler.
--
-- M3 öncesi (FE switch tamamlanmış ama RLS açık) misafir client de kendi
-- "Lobiye dön" tıkladığında frontend isHost guard'ı olmadan direct UPDATE
-- atıyordu; RLS izin veriyordu; misafir kendi satırını waiting yapıyordu. M3
-- direct UPDATE'i kapattığı için bu kompansasyon yolu kalmadı.
--
-- DOĞRU DAVRANIŞ
-- --------------
-- "Lobiye dön" semantiği "tüm oda yeni maça hazırlansın". room.status='waiting'
-- olduğunda TÜM duel_group_players.status DA 'waiting' OLMALI. Misafir
-- client'ın ayrı bir RPC tetiklemesine gerek yok — tek atomik server-side
-- reset host yetkisiyle yeterli.
--
-- DÜZELTME
-- --------
-- `duel_group_return_to_lobby` RPC'sini `create or replace` ile yeniden tanımla.
-- Imza değişmiyor. Davranış değişikliği: room update'inden hemen sonra TÜM
-- aynı room_id'deki player satırlarının status'u 'waiting' yapılır (caller
-- host olduğu için yetki tek-shot, atomik). last_seen_at de hizalanır →
-- opponent monitor / idle detection baseline'ı sıfırdan başlar.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • Authz: HOST-ONLY (duel_group_authorize_host) korunur.
--   • Imza: (uuid, uuid, uuid) → public.duel_group_rooms — değişmez.
--   • Return value: güncellenmiş room satırı.
--   • Diğer 10 RPC: dokunulmaz.
--   • M3 lockdown policy'leri: dokunulmaz. RPC SECURITY DEFINER ile RLS bypass
--     eder; players UPDATE policy YOK olsa da RPC içinden çalışır.
--   • DuelGroupGame.tsx: dokunmaya gerek yok. Realtime player UPDATE event'leri
--     (event:"*" listener) zaten state'i yeniden çekiyor; waiting fazı poll
--     (2 sn) ek güvence sağlıyor.
--   • duel_messages, Duel 1v1, wheel/conquest modları: dokunulmaz.
--
-- IDEMPOTENT
-- ----------
-- `create or replace` — migration tekrar koşulursa hata vermez.
-- ============================================================================


create or replace function public.duel_group_return_to_lobby(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns public.duel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.duel_group_rooms;
begin
  if not public.duel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- 1) Oda satırını 'finished' → 'waiting' (conditional → mid-flight'a izin yok)
  update public.duel_group_rooms
     set status     = 'waiting',
         started_at = null,
         updated_at = now()
   where id = p_room_id
     and status = 'finished'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_finished' using errcode = 'P0001';
  end if;

  -- 2) TÜM aynı odadaki player satırlarını 'waiting' yap. Eskiden yalnız
  --    host caller'ın kendi satırı güncelleniyordu; misafirlerin mark_finished
  --    ile bıraktığı 'finished' satırları lobi listesini boş gösteriyordu.
  --    Host yetkisiyle tek-shot toplu reset → tüm oda yeni maça hazır.
  --    last_seen_at hizalanır → opponent monitor baseline sıfırdan başlar.
  update public.duel_group_players
     set status       = 'waiting',
         last_seen_at = now()
   where room_id = p_room_id;

  return v_room;
end;
$$;

revoke all     on function public.duel_group_return_to_lobby(uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_return_to_lobby(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama (Studio SQL editor):
--
--   -- Fonksiyon hâlâ tek imzayla mevcut ve security definer
--   select proname, prosecdef, pg_get_function_arguments(oid) as args
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'duel_group_return_to_lobby';
--   -- Beklenen: 1 satır, prosecdef=true, args='p_room_id uuid, p_host_player_id uuid, p_claim_token uuid'
--
--   -- Gövdede tüm players UPDATE'i mevcut mu?
--   select pg_get_functiondef(oid) ilike '%update public.duel_group_players%set status%waiting%where room_id%' as has_bulk_reset
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'duel_group_return_to_lobby';
--   -- Beklenen: has_bulk_reset = true
--
-- Smoke test:
--   1) 3 oyuncu ile duel_group_create_room + duel_group_join_room x2
--   2) duel_group_start_game (host)
--   3) duel_group_finish_game (any player)
--   4) duel_group_mark_finished her oyuncu için (frontend useEffect simülasyonu)
--   5) duel_group_return_to_lobby (host)
--   6) select status from public.duel_group_players where room_id='<R>';
--      → Beklenen: 3 satır, hepsi status='waiting' (misafirler de dahil)
--   7) select status from public.duel_group_rooms where id='<R>';
--      → Beklenen: 'waiting'
-- ============================================================================
