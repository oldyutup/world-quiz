-- ============================================================================
-- Profile: built-in avatar foundation (Avatar Phase 1A)
-- ============================================================================
-- Amac:
--   Profillere kupur (curated) built-in avatar secimi icin tek bir nullable
--   kolon eklemek. v1'de avatar'lar emoji + gradient olarak client'ta tanimli
--   (src/data/avatars.ts); DB yalnizca format dogrulamasi yapar, katalog
--   uyeligini client zorlar. Boylece ileride yeni avatar eklemek migration
--   gerektirmez.
--
-- Kurallar:
--   * avatar_id nullable'dir; null = varsayilan (avatar yok).
--   * Format-only CHECK: avatar_id null VEYA '^avatar_[a-z0-9_]{1,32}$'.
--   * Mevcut profiller backfill EDILMEZ (hepsi null kalir).
--
-- DOKUNMAZ:
--   * RLS politikalari
--   * Mevcut RPC'ler (leaderboard, change_username, xp ...)
--   * Hicbir enum / yeni tablo eklenmez.
--
-- Idempotency:
--   `add column if not exists` + constraint varlik kontrolu (pg_constraint).
--   Migration otomatik calistirilMAZ; elle uygulanacaktir.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) avatar_id kolonu
-- ----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists avatar_id text;

-- ----------------------------------------------------------------------------
-- 2) format-only CHECK constraint (idempotent)
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'profiles_avatar_id_format_chk'
       and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_avatar_id_format_chk
      check (avatar_id is null or avatar_id ~ '^avatar_[a-z0-9_]{1,32}$');
  end if;
end$$;
