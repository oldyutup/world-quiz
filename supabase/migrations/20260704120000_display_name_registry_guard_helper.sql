-- ============================================================================
-- Display Name Registry Guard — Helper (V1, helper-only)
-- ============================================================================
-- Bu migration mevcut HİÇBİR RPC'ye / tabloya / policy'e DOKUNMAZ. Yalnızca
-- ortak bir validate-and-normalize helper'ı ekler:
--
--   public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id)
--
-- Amaç (üst seviye):
--   * Misafir oyuncu kayıtlı bir profile.username'i ile odaya girememeli.
--   * Authenticated kullanıcı kendi profile.username'i dışında bir kayıtlı
--     username taklit edememeli.
--   * Boş / çok kısa / çok uzun adlar reddedilmeli.
--
-- Bu PR (helper-only):
--   * Yalnız fonksiyon + grant.
--   * Hiçbir create/join/quick-match RPC bu helper'a HENÜZ BAĞLANMADI;
--     gerçek koruma sonraki migration'larda RPC body'leri tek tek helper'ı
--     çağırmaya geçtikçe yürürlüğe girer.
--   * Mevcut RPC imzaları değişmez. Frontend dosyalarına dokunulmaz.
--
-- Canonical kaynak:
--   public.profiles.username_normalized — 20260623120000_profile_username_change.sql
--   migration'ında tüm satırlar için lower(btrim(username)) ile backfill
--   edildi ve partial unique index'le case-insensitive global tekil yapıldı.
--   Karşılaştırma için ek backfill gerekmiyor.
--
-- Davranış tablosu:
--   v_norm := lower(btrim(p_name))
--   1) p_name NULL  veya  length(btrim) < 2  veya  length(btrim) > 16
--                                                      → name_invalid               (22023)
--   2) v_norm hiçbir profiles.username_normalized'da yok
--                                                      → btrim(p_name) DÖN
--   3) v_norm sahibi = p_profile_id
--      (authenticated kullanıcı kendi nick'ini kullanıyor)
--                                                      → btrim(p_name) DÖN
--   4) Aksi (misafir taklit veya auth-başka-nick taklit)
--                                                      → registered_username_taken  (P0001)
--
-- SECURITY DEFINER neden:
--   profiles tablosunun SELECT RLS politikası anon için kapalı olabilir.
--   Helper definer ile çağırıp YALNIZ (id, username_normalized) okur,
--   hiçbir tabloya yazmaz. search_path = public sabitlenir → arama yolu
--   enjeksiyonuna kapalı.
--
-- p_guest_id parametresi:
--   İmzada zorunlu kılınıyor (mevcut RPC çağrı şablonlarına 1:1 uyması ve
--   gelecek telemetri için), ama karar mantığı şu an bu değeri kullanmıyor.
--   Misafir kararı tamamen p_profile_id NULL koşuluyla veriliyor.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Helper function
-- ----------------------------------------------------------------------------

create or replace function public.assert_display_name_allowed(
  p_name        text,
  p_profile_id  uuid,
  p_guest_id    text
) returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trim   text;
  v_norm   text;
  v_owner  uuid;
begin
  -- 1) Boş / çok kısa / çok uzun kontrolü.
  --
  --    Mevcut RPC'lerdeki "length(btrim(p_name)) < 2" guard'ını buraya
  --    taşıyoruz ve üst sınırı (16) ekliyoruz. profiles.username_normalized
  --    formatı zaten 3..16 aralığında; bu nedenle 17+ karakterlik bir
  --    misafir adı hiçbir kayıtlı nick ile eşleşemez — yine de keyfi büyük
  --    inputları erkenden reddetmek RPC entegrasyonu sırasında daha tutarlı
  --    hata sinyali verir.
  if p_name is null then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  v_trim := btrim(p_name);

  if length(v_trim) < 2 or length(v_trim) > 16 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  v_norm := lower(v_trim);

  -- 2) Canonical kaynak üzerinden sahip ara. username_normalized partial
  --    unique olduğundan en fazla bir satır döner.
  select id
    into v_owner
    from public.profiles
   where username_normalized = v_norm
   limit 1;

  -- 3) Hiçbir kayıtlı kullanıcıya ait değil → serbest, temizlenmiş adı dön.
  if v_owner is null then
    return v_trim;
  end if;

  -- 4) Authenticated caller kendi nick'ini kullanıyor → izinli.
  if p_profile_id is not null and v_owner = p_profile_id then
    return v_trim;
  end if;

  -- 5) Misafir taklit (p_profile_id null) ya da auth-başka-nick taklit
  --    (p_profile_id is not null and v_owner <> p_profile_id) → aynı kod.
  raise exception 'registered_username_taken' using errcode = 'P0001';
end
$$;


-- ----------------------------------------------------------------------------
-- 2) Grants
-- ----------------------------------------------------------------------------
-- Helper hem anon (misafir create/join akışları) hem authenticated tarafından
-- çağrılacağı için her ikisine de execute verilir. Public revoke ile default
-- ayrıcalıklar temizlenir.

revoke all     on function public.assert_display_name_allowed(text, uuid, text) from public;
grant  execute on function public.assert_display_name_allowed(text, uuid, text) to anon, authenticated;


-- ============================================================================
-- Doğrulama (Studio SQL editor)
-- ============================================================================
--   -- Helper imzası
--   select proname, pg_get_function_arguments(oid), pg_get_function_result(oid)
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'assert_display_name_allowed';
--   -- Beklenen 1 satır:
--   --   args = "p_name text, p_profile_id uuid, p_guest_id text"
--   --   result = "text"
--
--   -- Boş / kısa / uzun → name_invalid
--   select public.assert_display_name_allowed(null,          null,                                    'g1');
--   select public.assert_display_name_allowed('',            null,                                    'g1');
--   select public.assert_display_name_allowed('a',           null,                                    'g1');
--   select public.assert_display_name_allowed(repeat('x',17), null,                                   'g1');
--
--   -- Hiçbir kullanıcıya ait olmayan ad → temizlenmiş ad döner
--   select public.assert_display_name_allowed('   misafir99   ', null, 'g1');   -- → 'misafir99'
--
--   -- Misafir kayıtlı bir nick deniyor → registered_username_taken
--   select public.assert_display_name_allowed('<KAYITLI_NICK>',  null, 'g1');
--
--   -- Auth kullanıcı kendi nick'i → temizlenmiş ad döner
--   select public.assert_display_name_allowed('<KENDI_NICK>',   '<own_uuid>'::uuid, null);
--
--   -- Auth kullanıcı başkasının nick'i → registered_username_taken
--   select public.assert_display_name_allowed('<KAYITLI_NICK>', '<my_uuid>'::uuid, null);
-- ============================================================================
