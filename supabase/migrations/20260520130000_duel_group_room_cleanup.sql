-- ============================================================================
-- duel_group_* : empty-room cleanup + DELETE realtime fidelity
-- ============================================================================
-- Country Group (Ülke Yazmaca Çok Oyunculu) modunda oda son oyuncu çıkınca
-- kapanmıyordu: client tarafındaki guest-leave kısayolu sadece kendi player
-- satırını siliyor, kalan oyuncu sayısını kontrol etmiyordu. Bu da boş ama
-- "waiting" durumda kalan stale odaların aynı kodla tekrar girilebilmesine
-- yol açıyordu.
--
-- Bu migration server-side bir güvenlik ağı ekler: duel_group_players üzerinden
-- yapılan her DELETE sonrası, ilgili room_id için kalan oyuncu sayısı 0 ise
-- duel_group_rooms satırı silinir. Trigger AFTER DELETE çalıştığı için kendi
-- içinde recursive olmaz (rooms tablosuna delete CASCADE üzerinden değil,
-- doğrudan SQL ile düşüyor; rooms.delete tetiklenmiyor, sadece players.delete).
--
-- Ayrıca duel_group_players için REPLICA IDENTITY FULL açılır. Realtime
-- postgres_changes DELETE filtreleri non-PK kolonlarda OLD payload üzerinden
-- eşleşir; default replica identity'de OLD yalnızca PK içerdiği için
-- `filter: room_id=eq.<id>` server-side eşleşmiyor ve guest-leave DELETE
-- event'leri hostlara ulaşmıyordu. duel_players için aynı düzeltme zaten
-- 20260520120000 migration'ında yapılmıştı; aynı garanti grup modu için de
-- gerekli.
--
-- Idempotent: replica identity ve trigger CREATE OR REPLACE / DROP IF EXISTS
-- ile tekrar uygulanabilir, mevcut veriyi etkilemez. Diğer modlara
-- (DuelGame, FlagDuelGame, WheelGroup, WheelDuel) dokunmaz.
-- ============================================================================

create or replace function public.duel_group_rooms_cleanup_after_player_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
begin
  select count(*) into remaining
    from public.duel_group_players
    where room_id = old.room_id;

  if remaining = 0 then
    delete from public.duel_group_rooms
      where id = old.room_id;
  end if;

  return old;
end;
$$;

drop trigger if exists duel_group_players_cleanup_after_delete
  on public.duel_group_players;

create trigger duel_group_players_cleanup_after_delete
  after delete on public.duel_group_players
  for each row
  execute function public.duel_group_rooms_cleanup_after_player_delete();

alter table public.duel_group_players replica identity full;
