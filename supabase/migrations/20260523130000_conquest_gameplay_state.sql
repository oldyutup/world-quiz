-- ============================================================================
-- Kuşatma (Conquest) — Phase 8: Synced gameplay state on conquest_rooms
-- ============================================================================
-- Bu migration mevcut tablo/satırlara DOKUNMAZ:
--   • conquest_rooms / conquest_players satırları
--   • RLS politikaları (önceki migration'da tanımlanan policy'ler korunur)
--   • supabase_realtime publication üyelikleri
--   • Diğer mod tablolarının hiçbirine dokunulmaz
--
-- Yapılan değişiklik (tek):
--   • public.conquest_rooms tablosuna gameplay_state JSONB NULL kolonu ekler.
--     Mevcut updated_at trigger'ı korunduğu için bu kolona yapılan UPDATE'ler
--     otomatik olarak updated_at'i tetikler → realtime UPDATE event yayılır
--     (Phase 8 client'ı bu event üzerinden state senkronize eder).
--
-- Idempotent:
--   • Kolon ekleme "if not exists" guard'lıdır → migration birden çok kez
--     çalıştırılırsa hata vermez.
--
-- Şema notu:
--   gameplay_state JSONB serileştirilmiş ConquestGameState taşır:
--     {
--       phase, mapId, players, round { ... }, regionStates, history,
--       startedAt, finishedAt
--     }
--   Detaylı şekil için frontend'deki SerializedConquestGameState'a bakın.
--   Null değer "henüz başlatılmadı" (lobby) anlamına gelir.
-- ============================================================================

alter table public.conquest_rooms
  add column if not exists gameplay_state jsonb null;

-- Doğrulama:
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'conquest_rooms'
--      and column_name = 'gameplay_state';
