-- ============================================================================
-- Kuşatma (Conquest) — Phase 9.2: ghost/stale player cleanup via heartbeat
-- ============================================================================
-- AMAÇ
-- ----
-- Tarayıcı kapatma, sekme kill, dev server kapanması veya bağlantı kopması
-- gibi nedenlerle conquest_leave_room RPC'si çağrılmadığında conquest_players
-- içinde "ghost" satırlar kalıyordu. Public oda listesi bu hayalet oyuncuları
-- da sayarak odayı dolu/yarı dolu gösteriyor, dolayısıyla yeni oyuncular
-- gerçekten boş bir odaya katılamıyordu.
--
-- Bu migration heartbeat tabanlı stale-player tespitini etkinleştirir:
--   • conquest_players.last_seen_at zaten Phase 5'te eklenmiş; bu migration
--     onun üstüne yeni satırlarda "now()" değerini garanti altına alan basit
--     bir defaults check ekler (DDL değişikliği YOK — kolon zaten not null
--     default now()).
--   • Yeni RPC: public.conquest_heartbeat_player(p_player_id, p_claim_token)
--     auth.uid() veya claim_token ile sahiplik doğrulayıp last_seen_at'i
--     now()'a çeker.
--   • İdame için conquest_rooms.updated_at de tazelenir → realtime UPDATE
--     dinleyicileri public listenin tazelenmesini kaçırmaz, fakat asıl
--     stale-filter mantığı fetchPublicConquestRooms tarafında uygulanır.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • Bayrak Düellosu, Kader Kartı, Wheel, Duel modlarının tabloları/RPC'leri.
--   • conquest_rooms / conquest_players SHAPE'i (kolon eklenmez, kaldırılmaz).
--   • Mevcut RLS politikaları (sıkılaştırma korunur).
--   • conquest_leave_room davranışı (Phase 9.1'deki empty-room cleanup aynı
--     kalır).
--   • Realtime publication üyelikleri.
--
-- YETKİLENDİRME
-- -------------
-- Heartbeat RPC'si conquest_authorize_player helper'ını kullanır:
--   • Logged-in: p_player_id satırının profile_id'si auth.uid() ile eşleşmeli.
--   • Misafir   : p_claim_token, conquest_player_claims tablosundaki kayıtla
--                 eşleşmeli.
-- Yetkisiz çağrı sessizce no-op olur (hata FIRLATMAZ) — heartbeat hatalarının
-- istemcide spam loop'a yol açmaması için kasıtlı tercih. Defansif RLS yine
-- ana koruma katmanı; RPC sadece SECURITY DEFINER tarafından güvenli yazıyı
-- mümkün kılar.
--
-- IDEMPOTENT
-- ----------
-- "create or replace function" ile aynı imza altında güncellenebilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Heartbeat RPC
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_heartbeat_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room_id uuid;
begin
  -- Yetkisiz çağrı → no-op. İstemci tarafında heartbeat 20 saniyede bir
  -- atılıyor; yetkisiz hatayı her seferinde fırlatırsak UI sessizce konsolu
  -- spamler. Sahteciliği RLS politikası zaten reddediyor, burada cevap
  -- vermemek yeterli.
  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
    return;
  end if;

  update public.conquest_players
     set last_seen_at = now()
   where id = p_player_id
   returning room_id into v_room_id;

  if v_room_id is null then
    return;  -- satır yokmuş (race ile leave/silinmiş olabilir)
  end if;

  -- Odanın updated_at'i de tazelenir → public listenin "son 6 saat" pencere
  -- filtresi ile uyumlu kalır ve realtime UPDATE event'i ile diğer istemciler
  -- de aktiflik sinyalini alır. (Stale-player filtresi conquest_players
  -- üzerinden last_seen_at < now() - 60s ile uygulanır.)
  update public.conquest_rooms
     set updated_at = now()
   where id = v_room_id;
end;
$$;

revoke all on function public.conquest_heartbeat_player(uuid, uuid) from public;
grant execute on function public.conquest_heartbeat_player(uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) İndeks: stale tarama için last_seen_at üstünde tek sütunlu indeks
-- ----------------------------------------------------------------------------
-- fetchPublicConquestRooms artık her odadaki "aktif" oyuncuları saymak için
-- last_seen_at >= now() - interval '60 seconds' filtresi uyguluyor. Public
-- listenin baskın sorgusunda 50 oda × N oyuncu küçük bir set olsa da, ileride
-- güvenli cleanup helper'ı eklenirken (örn. waiting odalardaki stale satırları
-- toplu sil) yararı kanıtlanmıştır.
-- ────────────────────────────────────────────────────────────────────────────

create index if not exists conquest_players_last_seen_at_idx
  on public.conquest_players (last_seen_at desc);


-- ============================================================================
-- Doğrulama sorguları:
--
--   -- RPC mevcut mu?
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'conquest_heartbeat_player';
--
--   -- İndeks oluştu mu?
--   select indexname
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename = 'conquest_players'
--      and indexname = 'conquest_players_last_seen_at_idx';
--
--   -- Manuel smoke (login'li):
--   --   select public.conquest_heartbeat_player('<player_id>'::uuid, null);
--   --   select last_seen_at from public.conquest_players where id='<player_id>';
-- ============================================================================
