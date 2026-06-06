-- ============================================================================
-- Display Name Registry Guard — Yasakli / rezerv / kufurlu nick filtresi
-- ============================================================================
-- Bu migration YALNIZCA helper'i guncelliyor:
--
--   public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id)
--
-- Hicbir mod RPC'sine (WheelDuel, DuelGame, DuelGroup, FlagDuel, Conquest,
-- WheelGroup, quick-match) dokunulmuyor. WheelGroup RPC'leri zaten bu helper'i
-- cagiriyor, dolayisiyla guvenlik artisi otomatik olarak yururluge giriyor.
--
-- Yeni davranis (mevcut akisin ustune eklendi):
--   v_norm := lower(btrim(p_name))
--   v_check := v_norm ile, sadece bastaki '@' (varsa) cikarilarak hesaplanir
--            (ornek: @admin → admin).
--
--   1) p_name NULL / length(btrim) < 2 / length(btrim) > 16
--      → name_invalid                                        (22023)   [MEVCUT]
--
--   2) v_check, rezerv/otorite/marka veya kufur kelime listesinden birine
--      tam esleserek (exact) ya da substring olarak (strpos > 0) uyuyorsa
--      → display_name_forbidden                              (P0001)   [YENI]
--
--      • Forbidden check, profiles lookup'undan ONCE calisir; boylece kayitli
--        bir kullanici (legacy data nedeniyle) yasakli bir username'e sahip
--        olsa bile yine engellenir.
--      • Forbidden check tum cagirilar icin uniform: misafir, kayitli kullanici,
--        kendi nick'iyle gelen kayitli kullanici — hepsi ayni listeye tabi.
--
--   3) v_norm hicbir profiles.username_normalized'da yok
--      → btrim(p_name) DON                                             [MEVCUT]
--
--   4) v_norm sahibi = p_profile_id
--      → btrim(p_name) DON                                             [MEVCUT]
--
--   5) Aksi (misafir taklit / auth-baska-nick taklit)
--      → registered_username_taken                           (P0001)   [MEVCUT]
--
-- Liste tasarim ilkesi:
--   • Exact-match: kisa veya masum nicklerle carpisma riski yuksek olanlar.
--     ("mod" → "mod" tam esitlikte yakalanir ama "mode", "modern" gecer.)
--   • Substring-match: kritik otorite ve marka taklitleri ile en bariz kufur
--     /hakaret/nefret kelimeleri. "admin" → "admin", "admin123", "superadmin"
--     hepsi yakalanir; "torble" → "torbleofficial" yakalanir.
--   • Liste ileride genisletilebilir; struktur sade tutuldu (iki text[] dizisi).
--   • Bilincli olarak agresif degil — masum nicklerin yanlislikla bloklanmamasi
--     icin yalniz acik impersonation/profanity kelimeleri secildi.
--
-- SQLSTATE / etiket:
--   raise exception 'display_name_forbidden' using errcode = 'P0001'
--   (registered_username_taken ile ayni SQLSTATE, farkli mesaj etiketi.)
--
-- BACKWARD COMPATIBILITY:
--   • RPC imzasi degismedi: assert_display_name_allowed(text, uuid, text).
--   • Mevcut hata etiketleri (name_invalid, registered_username_taken) ve
--     "free nick allowed", "own profile username allowed" akislari korunuyor.
--   • SECURITY DEFINER, search_path, STABLE, GRANT/REVOKE — hepsi ayni.
--
-- BAGIMLILIK:
--   • 20260704120000_display_name_registry_guard_helper.sql
-- ============================================================================


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
  v_check  text;
  v_owner  uuid;
  v_word   text;

  -- ── Tam-eslesme listesi ────────────────────────────────────────────────
  -- Kisa veya masum kullanimlari olan kelimeler. Yalniz v_check = word
  -- esitliginde engellenirler ("mode", "modern", "ghost", "hostess" gecer).
  v_exact_list constant text[] := array[
    -- Otorite / sistem rolleri
    'mod',
    'staff',
    'owner',
    'host',
    'system',
    'support',
    -- Bos / placeholder / literal
    'null',
    'undefined',
    'none',
    'noone',
    'nobody',
    'anon',
    'anonymous',
    'guest',
    -- Turkce kufur kisaltmalari (substring olarak masum kelimelere carpar)
    'amk',
    'aq'
  ];

  -- ── Substring (icerir) listesi ─────────────────────────────────────────
  -- Acik impersonation / marka taklidi / bariz kufur. v_check icinde
  -- gectikleri her yerde engellenir ("admin123", "torbleofficial" dahil).
  v_substr_list constant text[] := array[
    -- Otorite / marka taklitleri
    'admin',           -- admin, admin123, superadmin, ...
    'administrator',
    'moderator',       -- moderator99, ...
    'official',        -- torbleofficial, ...
    'torble',          -- marka
    -- Ingilizce kufur / hakaret / nefret soylemi
    'fuck',
    'shit',
    'bitch',
    'cunt',
    'whore',
    'nigger',
    'nigga',
    'faggot',
    'rapist',
    'nazi',
    'hitler',
    -- Turkce kufur / hakaret (en bariz olanlar)
    'orospu',
    'siktir',
    'amcik',           -- "amcik"in aksansiz formu
    'yarrak',
    'pezevenk',
    'gotveren',
    'ibne'
  ];
begin
  -- 1) Bos / cok kisa / cok uzun kontrolu (MEVCUT).
  if p_name is null then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  v_trim := btrim(p_name);

  if length(v_trim) < 2 or length(v_trim) > 16 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  v_norm := lower(v_trim);

  -- 1.5) Yasakli kelime kontrolu (YENI).
  --
  --      Normalize uzerinden calisir; bastaki tek bir '@' isareti varsa
  --      yok sayilir, boylece "@admin" → "admin" olarak yakalanir.
  --      Frontend'de zaten @ ekleyen bir akis yok ama caller'a ek bir
  --      koruma katmani kazandirir.
  v_check := v_norm;
  if left(v_check, 1) = '@' then
    v_check := substring(v_check from 2);
  end if;

  -- Tam-eslesme tarama
  foreach v_word in array v_exact_list loop
    if v_check = v_word then
      raise exception 'display_name_forbidden' using errcode = 'P0001';
    end if;
  end loop;

  -- Substring tarama (strpos kullanildi; LIKE wildcard yan etkisi yok).
  foreach v_word in array v_substr_list loop
    if strpos(v_check, v_word) > 0 then
      raise exception 'display_name_forbidden' using errcode = 'P0001';
    end if;
  end loop;

  -- 2) Canonical kaynak uzerinden sahip ara (MEVCUT).
  select id
    into v_owner
    from public.profiles
   where username_normalized = v_norm
   limit 1;

  -- 3) Hicbir kayitli kullaniciya ait degil → serbest (MEVCUT).
  if v_owner is null then
    return v_trim;
  end if;

  -- 4) Authenticated caller kendi nick'ini kullaniyor → izinli (MEVCUT).
  if p_profile_id is not null and v_owner = p_profile_id then
    return v_trim;
  end if;

  -- 5) Misafir taklit / auth-baska-nick taklit → registered_username_taken
  --    (MEVCUT).
  raise exception 'registered_username_taken' using errcode = 'P0001';
end
$$;


-- ----------------------------------------------------------------------------
-- Grants (mevcut pattern korunur)
-- ----------------------------------------------------------------------------
revoke all     on function public.assert_display_name_allowed(text, uuid, text) from public;
grant  execute on function public.assert_display_name_allowed(text, uuid, text) to anon, authenticated;


-- ============================================================================
-- Dogrulama (Studio SQL editor)
-- ============================================================================
--   -- Helper imzasi degismedi
--   select proname, pg_get_function_arguments(oid), pg_get_function_result(oid)
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'assert_display_name_allowed';
--
--   -- Yasakli (exact)
--   select public.assert_display_name_allowed('mod',       null, 'g1'); -- display_name_forbidden
--   select public.assert_display_name_allowed('Guest',     null, 'g1'); -- display_name_forbidden
--   select public.assert_display_name_allowed('NULL',      null, 'g1'); -- display_name_forbidden
--
--   -- Yasakli (substring)
--   select public.assert_display_name_allowed('admin',          null, 'g1'); -- display_name_forbidden
--   select public.assert_display_name_allowed('admin123',       null, 'g1'); -- display_name_forbidden
--   select public.assert_display_name_allowed('@admin',         null, 'g1'); -- display_name_forbidden
--   select public.assert_display_name_allowed('torbleOfficial', null, 'g1'); -- display_name_forbidden
--   select public.assert_display_name_allowed('FUCKER',         null, 'g1'); -- display_name_forbidden
--   select public.assert_display_name_allowed('orospucocugu',   null, 'g1'); -- length>16, name_invalid
--   select public.assert_display_name_allowed('orospu1',        null, 'g1'); -- display_name_forbidden
--
--   -- Masum nick'ler hala gecmeli
--   select public.assert_display_name_allowed('mode',     null, 'g1'); -- ok
--   select public.assert_display_name_allowed('modern',   null, 'g1'); -- ok
--   select public.assert_display_name_allowed('ghost',    null, 'g1'); -- ok
--   select public.assert_display_name_allowed('Selim',    null, 'g1'); -- ok
--
--   -- Length kontrolu mevcut davranisi koruyor
--   select public.assert_display_name_allowed('a',            null, 'g1'); -- name_invalid
--   select public.assert_display_name_allowed(repeat('x',17), null, 'g1'); -- name_invalid
--
--   -- registered_username_taken hala calisiyor
--   select public.assert_display_name_allowed('<KAYITLI_NICK>', null, 'g1');
--     -- SQLSTATE P0001, message 'registered_username_taken'
--
--   -- Kendi kayitli nick'i hala gecer (eger yasakli liste ile carpismiyorsa)
--   select public.assert_display_name_allowed('<KENDI_NICK>', '<own_uuid>'::uuid, null);
-- ============================================================================
