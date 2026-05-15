-- ============================================================================
-- Wheel Duel — Rövanş (Rematch) için tek ek kolon
-- ============================================================================
-- Bu migration mevcut tablolara/policy'lere DOKUNMAZ:
--   • duel_rooms, duel_players, duel_claims, duel_messages
--   • duel_group_*
--   • wheel_duel_rooms tablosunun mevcut kolonları, indeksleri, trigger'ı,
--     RLS policy'leri, publication üyeliği
--   • wheel_duel_players (skor sıfırlama host UPDATE'i ile runtime'da yapılır)
--
-- Yalnızca wheel_duel_rooms tablosuna bir yeni kolon ekler:
--   • rematch_requested_by  uuid[]  not null default '{}'
--       Maç bittiğinde (status = 'finished') rövanş oyu vermiş oyuncuların
--       UUID listesi. Her oyuncu en fazla bir kez içeride bulunur. İki oy
--       toplandığında host atomic UPDATE ile room'u 'waiting' status'a
--       döndürür ve bu listeyi sıfırlar.
--
-- Idempotency: "add column if not exists" — migration tekrar çalıştırılırsa
-- hata vermez. Mevcut satırlar default değerlerle dolar:
--   rematch_requested_by → '{}'  (boş array)
--
-- Status enum değişmiyor: rövanş yeni bir status değil, sadece finished →
-- waiting'e atomik geri dönüş. Mevcut check (status in ('waiting','playing',
-- 'finished')) constraint'i yeterli.
--
-- Realtime: wheel_duel_rooms zaten supabase_realtime publication'da ve
-- replica identity full ayarlı; yeni kolon otomatik olarak realtime
-- payload'ına dahil olur, ekstra alter publication gerekmez.
-- ============================================================================

alter table public.wheel_duel_rooms
  add column if not exists rematch_requested_by uuid[] not null default '{}';


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama (manuel):
--
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'wheel_duel_rooms'
--      and column_name  = 'rematch_requested_by';
--
-- ============================================================================
