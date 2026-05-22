-- ============================================================================
-- duel_group_claims : grant authenticated role the same access as anon
-- ============================================================================
-- Ülke Yaz Çok Oyunculu (DuelGroupGame) rövanş senaryosunda, aynı odada
-- ikinci maç başladığında önceki maçta yazılmış ülkeler logged-in oyuncular
-- için "zaten alındı" diye reddediliyordu. Kök neden: duel_group_claims
-- tablosundaki RLS politikası yalnızca anon rolüne FOR ALL izni veriyordu.
-- Supabase Auth ile oturum açmış kullanıcıların istekleri authenticated
-- rolüyle çalıştığı için host'un startGame'deki DELETE çağrısı RLS
-- süzgeci tarafından sessizce 0 satır etkiliyor (hata dönmüyor). Eski maç
-- satırları DB'de kalıyor, UNIQUE (room_id, country_code) constraint'i
-- ikinci maçta tetikleniyor.
--
-- Bu migration anon politikasına dokunmadan authenticated rolüne aynı
-- "guest-friendly" erişimi tanır. Pattern, wheel_group_init.sql'deki
-- per-operation `to anon, authenticated` yaklaşımıyla aynı yöne hizalanır;
-- ancak mevcut anon politikası bilinmediği için yalnızca additive olarak
-- ek bir authenticated FOR ALL politikası ekliyoruz (idempotent).
--
-- Etki: misafir akışı (anon) etkilenmez; logged-in host'un startGame
-- DELETE'i ve client tarafındaki stale-row temizleme çağrıları artık
-- gerçekten satır siliyor → rövanşta önceki maç ülkeleri tekrar yazılabilir.
--
-- Diğer duel_group_* tabloları (rooms/players) bu bug ile bağlantılı
-- olmadığı için bu migration onlara dokunmaz; gerekirse ayrı bir
-- migration eklenebilir.
-- ============================================================================

do $$
begin
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'duel_group_claims'
       and policyname = 'duel_group_claims_all_authenticated'
  ) then
    execute $policy$
      create policy "duel_group_claims_all_authenticated"
        on public.duel_group_claims
        for all
        to authenticated
        using (true)
        with check (true)
    $policy$;
  end if;
end$$;

-- ============================================================================
-- Doğrulama:
--   select policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename  = 'duel_group_claims';
-- Beklenen: hem mevcut anon politikası hem yeni
-- "duel_group_claims_all_authenticated" listelensin (cmd = ALL).
-- ============================================================================
