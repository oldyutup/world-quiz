-- ============================================================================
-- get_server_time_ms — sunucu duvar-saatini istemcilere acan stable RPC
-- ============================================================================
-- Amac:
--   Kusatma cok oyunculu modunda host ve guest farkli PC saatleri tasidiginda
--   `challenge.startedAt` / `endsAt` gibi mutlak timestamp'ler farkli yorum-
--   laniyor; bir client soru paneline gecerken digeri "Hazir ol" overlay'inde
--   kaliyor. Kalici cozum istemcilerin tek bir referans (server clock) uzerin-
--   den hesap yapmasi.
--
--   Bu RPC, postgres'in `clock_timestamp()` degerini epoch milisaniyeye cevirip
--   bigint olarak donderir. Client tarafi cagri once/sonra `Date.now()` alir,
--   ortalamayi server time'a esleyip lokal offset'i hesaplar.
--
-- Imza:
--   public.get_server_time_ms() returns bigint
--
-- Yan etkiler:
--   Hicbiri. Tablo/RLS dokunulmadi. Sadece read-only stable fonksiyon.
--
-- Yetkiler:
--   anon + authenticated rolleri execute alir; misafir kullanicilarin da
--   Kusatma maclarinda offset cekmesi gerekiyor.
--
-- Idempotency:
--   `create or replace function` ile yeniden tanimlanabilir.
-- ============================================================================

create or replace function public.get_server_time_ms()
returns bigint
language sql
stable
as $$
  select floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

grant execute on function public.get_server_time_ms() to anon, authenticated;
