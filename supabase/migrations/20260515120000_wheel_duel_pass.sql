-- ============================================================================
-- Wheel Duel — Pas Geç (Skip) için iki ek kolon
-- ============================================================================
-- Bu migration mevcut tablolara/policy'lere DOKUNMAZ:
--   • duel_rooms, duel_players, duel_claims, duel_messages
--   • duel_group_*
--   • wheel_duel_rooms tablosunun mevcut kolonları, indeksleri, trigger'ı,
--     RLS policy'leri, publication üyeliği
--
-- Yalnızca wheel_duel_rooms tablosuna iki yeni kolon ekler:
--   • pass_requested_by  uuid[]  not null default '{}'
--       Şu anki current_target_topoid için pas oyu vermiş oyuncuların
--       UUID listesi. Her oyuncu en fazla bir kez içeride bulunur.
--   • pass_target_topoid text  null
--       pass_requested_by listesinin hangi hedef için toplandığını işaretler.
--       current_target_topoid değişince bayatlık koruması için kullanılır.
--
-- Idempotency: "add column if not exists" — migration tekrar çalıştırılırsa
-- hata vermez. Mevcut satırlar default değerlerle dolar:
--   pass_requested_by  → '{}'  (boş array)
--   pass_target_topoid → null
--
-- Realtime: wheel_duel_rooms zaten supabase_realtime publication'da ve
-- replica identity full ayarlı; yeni kolonlar otomatik olarak dahil olur,
-- ekstra alter publication gerekmez.
-- ============================================================================

alter table public.wheel_duel_rooms
  add column if not exists pass_requested_by uuid[] not null default '{}';

alter table public.wheel_duel_rooms
  add column if not exists pass_target_topoid text null;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama (manuel):
--
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'wheel_duel_rooms'
--      and column_name in ('pass_requested_by', 'pass_target_topoid');
--
-- ============================================================================
