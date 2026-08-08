-- ============================================================================
-- 20260809130000 — HOTFIX: authenticated-only iki RPC'den `anon` EXECUTE'unu al
-- ============================================================================
--
-- NİYE AYRI BİR MIGRATION?
-- ------------------------
-- 20260809120000 CANLIYA UYGULANDI. Uygulanmış bir migration dosyasını geriye
-- dönük düzenlemek migration history drift'i yaratır (dosya içeriği ile canlı
-- şemanın doğduğu içerik ayrışır). Bu yüzden düzeltme 09'un İÇİNE değil,
-- 09'dan SONRA gelen bu küçük dosyaya yazılır. Sıra:
--
--     20260809120000  (uygulandı)
--  →  20260809130000  (bu dosya)
--     20260810120000  (bekliyor)
--     20260811120000  (bekliyor)
--
-- Düzeltme 10'un içine de konabilirdi; konmadı. 10'un konusu "Kuşatma ham
-- okuma kilidi + host kuralları"dır ve bu bir 09 yetki hatasıdır. Ayrı dosya
-- hatanın kendi denetim kaydını taşır.
--
--
-- SORUN — `REVOKE ... FROM PUBLIC` neden yetmedi
-- ----------------------------------------------
-- 20260809120000 (satır 180-182) şunu yaptı:
--
--     revoke all     on function public.conquest_list_public_rooms() from public;
--     -- anon KASTEN YOK.
--     grant  execute on function public.conquest_list_public_rooms() to authenticated;
--
-- Beklenti: "anon'a grant vermezsem anon çağıramaz." Bu, Supabase'de YANLIŞ.
-- Supabase'in kurulum şeması her projede şunu tanımlar:
--
--     alter default privileges in schema public
--       grant all on functions to postgres, anon, authenticated, service_role;
--
-- Dolayısıyla `public` şemasında OLUŞTURULAN her yeni fonksiyon, PUBLIC
-- üzerinden değil, `anon` rolüne DOĞRUDAN bir grant ile doğar:
--
--   CREATE sonrası : {=X/postgres, postgres=X/…, anon=X/…, authenticated=X/…, service_role=X/…}
--                     ^^^^^^^^^^^ PUBLIC        ^^^^^^^^^ DOĞRUDAN anon grant
--   09 deseni sonrası: {postgres=X/…, anon=X/…, authenticated=X/…, service_role=X/…}
--                                     ^^^^^^^^^ HAYATTA KALDI
--
-- `REVOKE ... FROM PUBLIC` yalnız baştaki PUBLIC girdisini siler; doğrudan
-- anon grant'ine DOKUNMAZ. Canlı teşhis bunu iki fonksiyon için de doğruladı:
--   public_execute = false, anon_dogrudan_grant = true, anon_etkin_yetki = true
--
--
-- VERİ SIZDI MI? — HAYIR.
-- -----------------------
-- Her iki fonksiyonun da gövdesi ilk satırda auth.uid()'yi kontrol eder ve
-- `auth_required` (42501) fırlatır. anon JWT'sinde `sub` claim'i olmadığı için
-- auth.uid() NULL'dur. 09'un "iki katman kasıtlıdır" gerekçesi tam da bu
-- yüzden işe yaradı: grant katmanı delikti, GÖVDE katmanı tuttu. Bu hotfix
-- eksik olan BİRİNCİ katmanı kapatır; gövdelere DOKUNMAZ.
--
--
-- BU DOSYA NE YAPMAZ
-- ------------------
--   • Fonksiyon gövdelerini değiştirmez (CREATE/CREATE OR REPLACE YOK).
--   • Hiçbir tablo satırına dokunmaz (DML YOK). DROP YOK.
--   • `conquest_find_room_by_code(text)` gibi MİSAFİRE AÇIK KALMASI GEREKEN
--     fonksiyonlara dokunmaz → oda kodu / davet linki ile misafir katılımı
--     aynen çalışmaya devam eder.
--   • service_role ve postgres grant'lerine dokunmaz (Supabase standardı).
--   • Kalan ~79 authenticated-only fonksiyonu TOPLU revoke ETMEZ. Aynı kök
--     sebep onları da etkiliyor olabilir, ama kapsam canlı ACL taramasıyla
--     belirlenmelidir (bkz. dosya sonundaki SÜPÜRME SORGUSU). Repo'dan grep
--     ile liste çıkarmak güvenilir DEĞİLDİR: 20260809120000'in 694-706.
--     satırları bazı fonksiyonlara anon grant'ini `do $$ … execute format()`
--     içinden verir ve grep bunu göremez.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0) ÖN KOŞUL — hedefler ve roller var mı?
-- ----------------------------------------------------------------------------
-- REVOKE/GRANT olmayan bir nesne için hata verir ve migration yarıda kalır.
-- Bu blok, hangi parçanın eksik olduğunu tek ve anlaşılır bir mesajla söyler.
-- ────────────────────────────────────────────────────────────────────────────

-- NOT — `array_append` KASITLI, `||` DEĞİL:
-- `text[] || 'düz metin'` ifadesinde PostgreSQL sağdaki `unknown` literal'i
-- `text[]`e çözer ve onu ARRAY LİTERALİ olarak ayrıştırmayı dener. Metin
-- virgül/köşeli parantez içerdiğinde bu "malformed array literal" hatası
-- verir — yani ön koşul bloğu, ASIL anlatmak istediği eksik-bağımlılık
-- mesajı yerine anlamsız bir ayrıştırma hatası fırlatır. `array_append`
-- ikinci argümanı her zaman ELEMAN olarak alır → belirsizlik yok.
do $pre$
declare
  v_missing text[] := '{}';
begin
  if to_regprocedure('public.conquest_list_public_rooms()') is null then
    v_missing := array_append(v_missing,
      'public.conquest_list_public_rooms()  [20260809120000, Bölüm A1]');
  end if;
  if to_regprocedure('public.torble_link_guest_player(text,uuid,uuid)') is null then
    v_missing := array_append(v_missing,
      'public.torble_link_guest_player(text,uuid,uuid)  [20260808120000, Bölüm D]');
  end if;
  if to_regrole('anon') is null then
    v_missing := array_append(v_missing, 'role anon  [Supabase standart rolü]');
  end if;
  if to_regrole('authenticated') is null then
    v_missing := array_append(v_missing, 'role authenticated  [Supabase standart rolü]');
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception
      E'20260809130000 ön koşulu karşılanmadı. Eksik:\n  - %\nÖnce ilgili migration''ları uygula.',
      array_to_string(v_missing, E'\n  - ')
      using errcode = 'P0001';
  end if;
end
$pre$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) conquest_list_public_rooms() — açık oda listesi
-- ----------------------------------------------------------------------------
-- ÜRÜN KURALI: yalnız kayıtlı kullanıcı listeleyebilir; anon/misafir ASLA.
--
-- Üç ifade de idempotenttir: REVOKE olmayan bir yetkiyi kaldırmak ve GRANT
-- var olan bir yetkiyi yeniden vermek hata değildir → dosya tekrar
-- çalıştırılabilir.
-- ────────────────────────────────────────────────────────────────────────────

revoke execute on function public.conquest_list_public_rooms() from public;
revoke execute on function public.conquest_list_public_rooms() from anon;
grant  execute on function public.conquest_list_public_rooms() to   authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) torble_link_guest_player(text,uuid,uuid) — misafir slotunu hesaba bağla
-- ----------------------------------------------------------------------------
-- ÜRÜN KURALI: yalnız GİRİŞ YAPMIŞ kullanıcı, elindeki claim_token ile bir
-- misafir satırını KENDİ hesabına devralabilir. anon çağıramaz — zaten
-- devralacak bir hesabı yoktur.
--
-- MİSAFİR KATILIMI ETKİLENMEZ: misafir odaya `*_join_room` RPC'leriyle girer
-- (Kör Nokta'da `tevatur_join_room(text,uuid,uuid,text,text)`, anon'a
-- grant'li). Bu fonksiyon yalnız "misafirken oynadım, sonra hesap açtım"
-- devir adımıdır ve o adımda kullanıcı tanım gereği authenticated'dır.
-- ────────────────────────────────────────────────────────────────────────────

revoke execute on function public.torble_link_guest_player(text, uuid, uuid) from public;
revoke execute on function public.torble_link_guest_player(text, uuid, uuid) from anon;
grant  execute on function public.torble_link_guest_player(text, uuid, uuid) to   authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) SON DURUM DOĞRULAMASI — sessiz başarısızlığa izin verme
-- ----------------------------------------------------------------------------
-- REVOKE'lar sessizce etkisiz kalırsa (örn. ileride anon'a başka bir yoldan
-- yetki verilmişse: rol üyeliği, yeni bir default privilege kuralı…) bu blok
-- migration'ı DURDURUR. Tek transaction olduğu için her şey geri alınır ve
-- "uygulandı ama düzelmedi" durumu OLUŞMAZ.
-- ────────────────────────────────────────────────────────────────────────────

do $post$
declare
  v_bad text[] := '{}';
  v_fn  text;
begin
  foreach v_fn in array array[
    'public.conquest_list_public_rooms()',
    'public.torble_link_guest_player(text,uuid,uuid)'
  ]
  loop
    -- anon HÂLÂ çağırabiliyorsa → hata
    if has_function_privilege('anon', to_regprocedure(v_fn)::oid, 'EXECUTE') then
      v_bad := array_append(v_bad, v_fn || ' → anon EXECUTE HÂLÂ AÇIK');
    end if;
    -- authenticated ÇAĞIRAMIYORSA → hata (özelliği kırmış oluruz)
    if not has_function_privilege('authenticated', to_regprocedure(v_fn)::oid, 'EXECUTE') then
      v_bad := array_append(v_bad, v_fn || ' → authenticated EXECUTE KAYIP');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception E'20260809130000 doğrulaması BAŞARISIZ:\n  - %',
      array_to_string(v_bad, E'\n  - ')
      using errcode = 'P0001';
  end if;

  raise notice '20260809130000 OK: iki RPC de anon''a kapalı, authenticated''a açık.';
end
$post$;


-- ============================================================================
-- GELECEK RİSKİ — bu iki fonksiyon yeniden tanımlanırsa ne olur?
-- ============================================================================
--
-- Test edilmiş davranış (postgres:17, Supabase default privileges kurulu):
--
--   CREATE OR REPLACE FUNCTION …  → ACL KORUNUR.   anon grant'i GERİ GELMEZ. ✔
--   DROP FUNCTION + CREATE …      → ACL SIFIRLANIR. anon grant'i GERİ GELİR.  ✘
--
-- Yani risk `create or replace`ta DEĞİL, imza değişikliği gibi DROP gerektiren
-- durumlardadır (ve yeni bir imza EKLEMEK de yeni bir fonksiyon yaratır →
-- o da anon grant'i ile doğar).
--
-- KURAL: `public` şemasında authenticated-only bir fonksiyon oluşturan ya da
-- imzasını değiştiren HER migration, sonunda şunu yazmak ZORUNDADIR:
--
--     revoke execute on function public.<fn>(<args>) from public;
--     revoke execute on function public.<fn>(<args>) from anon;   -- ← unutulan satır
--     grant  execute on function public.<fn>(<args>) to   authenticated;
--
-- Yalnız `revoke ... from public` YETMEZ. 20260809120000'de eksik olan tam da
-- ortadaki satırdı.
--
--
-- SÜPÜRME SORGUSU (salt okuma) — aynı kök sebepten etkilenen DİĞER fonksiyonlar
-- ----------------------------------------------------------------------------
-- "Gövdesi giriş şart koşuyor AMA grant'i anon'a açık" çelişkisini listeler:
--
--   select p.oid::regprocedure::text as fonksiyon, p.proacl::text as acl
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.prosecdef
--      and has_function_privilege('anon', p.oid, 'EXECUTE')
--      and pg_get_functiondef(p.oid) ~ 'auth_required'
--    order by 1;
--
-- Çıkan liste TOPLU revoke edilmemeli: bazı fonksiyonlar misafire BİLEREK
-- açıktır ve gövdelerinde başka bir yol için `auth_required` fırlatıyor
-- olabilir (örn. kayıtlı-kullanıcı dalı). Her satır tek tek değerlendirilmeli.
--
--
-- DOĞRULAMA (Supabase Studio → SQL Editor, uygulamadan sonra)
-- ----------------------------------------------------------------------------
--   select p.oid::regprocedure::text as fonksiyon,
--          p.proacl::text                                   as acl,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('conquest_list_public_rooms',
--                        'torble_link_guest_player',
--                        'conquest_find_room_by_code',
--                        'tevatur_join_room')
--    order by 1;
--
--   Beklenen:
--     conquest_list_public_rooms()                  anon=f  authed=t
--     torble_link_guest_player(text,uuid,uuid)      anon=f  authed=t
--     conquest_find_room_by_code(text)              anon=t  authed=t   ← DOKUNULMADI
--     tevatur_join_room(text,uuid,uuid,text,text)   anon=t  authed=t   ← DOKUNULMADI
--
-- İSTEMCİ ETKİSİ: YOK. anon çağrısı artık gövdeye ulaşmadan reddedilir; hata
-- mesajı 'auth_required' yerine 'permission denied for function …' olur ama
-- SQLSTATE yine 42501'dir ve src/modes/conquest/conquestService.ts içindeki
-- kontrol (`error.code === "42501"`) bunu zaten ConquestAuthRequiredError'a
-- çevirir → giriş kapısı aynı şekilde açılır. Frontend değişikliği GEREKMEZ.
-- ============================================================================
