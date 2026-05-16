-- ============================================================================
-- Flag Duel Queue — GRANT Lockdown (defense-in-depth)
-- ============================================================================
-- Önceki migration (20260516130000_flag_duel_quick_match.sql) flag_duel_queue
-- tablosunu oluşturdu ve RLS politikasını set etti:
--   • RLS aktif
--   • SELECT policy: yalnız kendi satırı (profile_id = auth.uid())
--   • INSERT/UPDATE/DELETE policy YOK (RLS arkasında reddedilir)
--
-- Ancak Supabase yeni tablolarda anon ve authenticated rolüne otomatik olarak
-- tüm DML GRANT'lerini (DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE,
-- UPDATE) verir. RLS sayesinde bu pratikte zarar vermez (policy yokken her
-- şey reddedilir), ama defense-in-depth ilkesiyle:
--   • RLS bug'ı veya yanlış policy ekleme riski
--   • Audit / pentest okumalarında temiz görünüm
--   • İleride RLS yanlışlıkla kapatılırsa direkt erişim engellenmiş kalır
-- nedenleriyle bu GRANT'leri temizliyoruz.
--
-- Bu migration:
--   • anon rolünden TÜM hakları çeker
--   • authenticated rolünden TÜM hakları çeker, sonra YALNIZ SELECT verir
--   • PUBLIC pseudo-rolünden TÜM hakları çeker
--
-- DOKUNMAZ:
--   • service_role / postgres / supabase_admin (RPC owner) — SECURITY DEFINER
--     RPC'ler bu role olarak çalışır, queue tablosuna yazmaya devam etmeli.
--   • RLS politikası (SELECT own row hâlâ aktif)
--   • Replication / supabase_realtime — replication role ayrı, GRANT'lerden
--     etkilenmez
--   • Diğer hiçbir tablo
--
-- Idempotent: REVOKE hiçbir hata fırlatmaz, GRANT SELECT tekrar uygulanabilir.
-- ============================================================================

-- ── anon: hiçbir doğrudan tablo erişimi yok ──────────────────────────────────
revoke all on table public.flag_duel_queue from anon;

-- ── authenticated: önce her şeyi temizle, sonra yalnız SELECT ver ────────────
-- SELECT realtime listener ve "kendi queue satırını oku" için gerekli;
-- RLS SELECT policy (profile_id = auth.uid()) hangi satırların görüneceğini
-- ayrıca filtreliyor.
revoke all on table public.flag_duel_queue from authenticated;
grant  select on table public.flag_duel_queue to   authenticated;

-- ── PUBLIC: defansif temizlik ────────────────────────────────────────────────
revoke all on table public.flag_duel_queue from public;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama:
--
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name   = 'flag_duel_queue'
--      and grantee in ('anon', 'authenticated', 'PUBLIC')
--    order by grantee, privilege_type;
--
-- Beklenen tek satır:
--   grantee='authenticated', privilege_type='SELECT'
--
-- anon ve PUBLIC için hiçbir satır görünmemeli.
-- ============================================================================
