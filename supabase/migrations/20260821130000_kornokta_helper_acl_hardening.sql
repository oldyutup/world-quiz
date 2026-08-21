-- ============================================================================
-- Kör Nokta — yardımcı fonksiyon ACL sıkılaştırma (follow-up)
-- ============================================================================
-- BAĞLAM
-- ──────
-- 20260821120000 iki nesne getirdi:
--   • public.tevatur_kn_leave_match(uuid,uuid,uuid)   — istemcinin çağırdığı
--     durum-duyarlı çıkış RPC'si. SECURITY DEFINER, anon + authenticated
--     EXECUTE alır. BU DOĞRUDUR ve bu migration ona DOKUNMAZ.
--   • public.tevatur_kn_min_viable_team_size()        — "minimum yaşayabilir
--     takım kaç kişi?" eşiğini tek yerde tutan İÇ yardımcı.
--
-- SORUN
-- ─────
-- Yardımcıya da anon + authenticated EXECUTE verilmişti. Gerek YOK: yalnızca
-- `tevatur_kn_leave_match`in gövdesinden çağrılır, hiçbir istemci kodu onu
-- çağırmaz (repo genelinde tek referansı o gövdedir). En küçük yetki ilkesi
-- gereği istemciye açık yüzeyde durmamalı — sızdırdığı şey küçük olsa da
-- (bir sabit) açıkta duran her EXECUTE gelecekteki bir gövde değişikliğinde
-- düşünülmesi gereken fazladan bir giriş noktasıdır.
--
-- DÜZELTME
-- ────────
-- EXECUTE'u PUBLIC + anon + authenticated rollerinden geri al. ÜÇÜ DE
-- gereklidir: Supabase'de public şemadaki fonksiyonlar `anon`/`authenticated`
-- rollerine DOĞRUDAN grant ile doğabilir ve `revoke ... from public` o doğrudan
-- grant'i KALDIRMAZ (bkz. 20260809130000 hotfix'inin dersi). 20260821120000
-- zaten doğrudan grant vermişti, yani buradaki asıl iş rol-bazlı revoke'lardır.
--
-- NEDEN HÂLÂ ÇALIŞIR
-- ──────────────────
-- `tevatur_kn_leave_match` SECURITY DEFINER'dır: gövdesi SAHİBİNİN yetkisiyle
-- koşar, çağıranın (anon/authenticated) yetkisiyle değil. Fonksiyon sahibi
-- oluşturulurken kendi ACL'inde EXECUTE'u zaten taşır ve aşağıdaki revoke'lar
-- sahibin hakkına DOKUNMAZ (revoke yalnız adı geçen rollerden alır). Dolayısıyla
-- misafir de kayıtlı kullanıcı da çıkış RPC'sini eskisi gibi çağırır; yardımcı
-- o gövdenin İÇİNDEN sorunsuz çözülür. Bu, clean-room'da hem doğrudan çağrının
-- reddedildiği hem de çıkış akışının tamamının çalıştığı koşularak doğrulandı
-- (scripts/check-kornokta-helper-acl.ts).
--
-- BİLEREK YAPILMAYANLAR
-- ────────────────────
--   • Yardımcı SECURITY DEFINER YAPILMADI. Definer olması gereksiz yetki
--     yükseltmesidir; fonksiyon hiçbir nesneye erişmiyor.
--   • `set search_path` EKLENMEDİ. Gövde `select 2`dir: tablo, tip, operatör
--     ya da başka bir şema nesnesi çözmez. Arama yolu enjeksiyonu için bir
--     yüzey yoktur; eklemek işlevsiz bir fark olurdu.
--   • Gövde, imza, dönüş tipi, volatility DEĞİŞMEDİ — bu migration hiçbir
--     fonksiyonu CREATE/REPLACE ETMEZ, yalnız ACL değiştirir.
--   • Başka hiçbir fonksiyona, role, tabloya, policy'ye dokunulmadı.
--
-- ŞEMA DEĞİŞMEZ: tablo, kolon, RLS, policy, trigger, index YOK.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- Ön koşul: hedef fonksiyon GERÇEKTEN bu imzayla var mı?
-- ----------------------------------------------------------------------------
-- Yanlış imzaya revoke atmak sessizce hata verir; ACL değişikliğinin hedefi
-- ıskalaması ise fark edilmez. Önce kimliği doğrula, sonra revoke et.
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.tevatur_kn_min_viable_team_size()') is null then
    raise exception
      'public.tevatur_kn_min_viable_team_size() bulunamadi — once 20260821120000 uygulanmali';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- EXECUTE'u istemci rollerinden geri al
-- ----------------------------------------------------------------------------
-- Üç ifade de idempotenttir: hak zaten yoksa revoke sessizce başarılıdır.
-- ────────────────────────────────────────────────────────────────────────────
revoke execute on function public.tevatur_kn_min_viable_team_size() from anon;
revoke execute on function public.tevatur_kn_min_viable_team_size() from authenticated;
revoke all     on function public.tevatur_kn_min_viable_team_size() from public;


-- ============================================================================
-- DOĞRULAMA (Supabase Studio → SQL Editor)
-- ============================================================================
--
-- A) Yardımcıda istemci rolü KALMAMALI, çıkış RPC'sinde ise DURMALI:
--   select p.proname,
--          has_function_privilege('anon',          p.oid, 'execute') as anon,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('tevatur_kn_min_viable_team_size','tevatur_kn_leave_match');
--   -- Beklenen: min_viable_team_size → f / f
--   --           leave_match          → t / t
--
-- B) Yardımcının kimliği DEĞİŞMEMİŞ olmalı (definer değil, proconfig boş):
--   select prosecdef, proconfig, provolatile, pronargs
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'tevatur_kn_min_viable_team_size';
--   -- Beklenen: f / null / i (immutable) / 0
--
-- C) Çıkış akışı canlıda hâlâ çalışıyor mu → scripts/postcheck-kornokta-leave-live.ts
-- ============================================================================
