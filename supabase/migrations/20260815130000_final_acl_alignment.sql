-- ════════════════════════════════════════════════════════════════════════════
-- 20260815130000_final_acl_alignment.sql
--
-- P2 — HEDEFLİ ACL HİZALAMA (sıfır davranış değişikliği)
--
-- ════════════════════════════════════════════════════════════════════════════
-- KAPSAM — 3 HEDEF, her biri anon VE PUBLIC için yazılır. BULK REVOKE YOK.
--   1) tevatur_create_room            → EXECUTE geri alınır
--   2) wheel_duel_queue               → SELECT geri alınır
--   3) 6 claim tablosu                → INSERT geri alınır
--
-- HİÇBİRİNDE authenticated'a DOKUNULMAZ. Hiçbir fonksiyon DROP edilmez,
-- hiçbir gövde değişmez, RLS enable/disable yok, politika yok, publication
-- değişikliği yok, şema değişikliği yok.
--
-- ⚠ NEDEN HER HEDEFTE HEM `anon` HEM `public` YAZILIYOR
-- ─────────────────────────────────────────────────────
-- `revoke ... from anon` TEK BAŞINA SESSİZ NO-OP olabilir: yetki PUBLIC
-- rolünden geliyorsa anon onu PUBLIC üzerinden almaya devam eder ve
-- has_*_privilege('anon', ...) hâlâ true döner. (Bu kusur bu migration'ın
-- kendi DOĞRULAMA bloğu tarafından temiz oda testinde yakalandı.)
-- 20260808 dersinin simetrik hâli: orada `from public` yetmiyordu, burada
-- `from anon` yetmiyor — İKİSİ DE yazılır.
--
-- authenticated ETKİLENMEZ çünkü her hedefte KENDİ DOĞRUDAN grant'ı vardır
-- (Supabase ALTER DEFAULT PRIVILEGES + 20260714120000'in açık grant'ı).
-- Yine de aşağıdaki doğrulama bloğu bunu tek tek assert eder: authenticated
-- tarafında bir şey düşerse migration DURUR ve geri alınır.
--
-- ════════════════════════════════════════════════════════════════════════════
-- 1) tevatur_create_room — 8 modun İÇİNDE TEK İSTİSNA
-- ────────────────────────────────────────────────────
-- Torble ürün invariant'ı: MİSAFİR ODA KURAMAZ. 20260808120000 bunu yedi
-- modda uyguladı (`revoke execute ... from anon`). korNokta misafir listesine
-- BİR GÜN SONRA (20260809120000) katıldı ve create_room revoke'u hiç
-- yazılmadı; kendi migration'ları yalnız `revoke all ... from public` yazıyor
-- — bu, Supabase'in ALTER DEFAULT PRIVILEGES ile doğan DOĞRUDAN anon
-- grant'ını KALDIRMAZ (20260808 dersi).
--
-- CANLI DURUM: anon EXECUTE AÇIK (doğrulandı). Diğer 7 create_room KAPALI.
-- EXPLOIT DEĞİL: gövde `auth.uid() is null → auth_required` fırlatır.
--   → Bu bir savunma-katmanı hizalaması, açık kapatma değil.
-- ESKİ İSTEMCİ: korNokta oda kurma akışı zaten kayıtlı kullanıcı gerektirir
--   (tevatur_create_room gövdesi ayrıca username zorunlu kılar).
-- ════════════════════════════════════════════════════════════════════════════
revoke execute on function public.tevatur_create_room(uuid, text, int, int, uuid) from anon;
revoke execute on function public.tevatur_create_room(uuid, text, int, int, uuid) from public;


-- ════════════════════════════════════════════════════════════════════════════
-- 2) wheel_duel_queue — anon SELECT
-- ─────────────────────────────────
-- NEDEN GEREKSİZ (üç bağımsız kanıt):
--   a) Canlı anon sorgusu SIFIR satır döndürüyor — RLS zaten
--      `profile_id = auth.uid()` ile sınırlıyor, anon'un profili yok.
--   b) Tek istemci kullanımı `.eq("profile_id", myProfileId)`
--      (WheelDuelGame.tsx:1473) ve Çark Düello ekranı login-gate'li
--      (App.tsx ONLINE_GATED_SCREENS "wheel-duel-game": "duel-gate")
--      → anon için bu kod yolu ERİŞİLEMEZ.
--   c) `flag_duel_queue` ZATEN tam bu durumda (anon 42501 / authenticated
--      READ) ve Bayrak Düello Hızlı Eşleş sorunsuz çalışıyor.
--
-- authenticated SELECT'e DOKUNULMAZ: istemcinin kendi satırını okuması ve
-- realtime aboneliği (WheelDuelGame.tsx:1645) buna bağlıdır. Realtime kanalı
-- kullanıcının kendi JWT'siyle kurulur → authenticated rolüyle çalışır.
--
-- YAZMA yetkileri 20260814180000'de zaten geri alındı; burada TEKRARLANMAZ.
-- ════════════════════════════════════════════════════════════════════════════
revoke select on table public.wheel_duel_queue from anon;
revoke select on table public.wheel_duel_queue from public;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) *_player_claims — anon INSERT
-- ────────────────────────────────
-- 20260814180000 sonrası `*_authorize_player`ın claim dalı YAPISAL olarak
-- yalnız gerçek misafire açık (`profile_id is null and guest_id is not null`)
-- → ekilmiş claim ile KAYITLI oyuncu ele geçirilemez. Bu revoke ikinci
-- katmandır: saldırganın claim satırı YAZABİLME yeteneğini de alır.
--
-- İSTEMCİ HİÇBİRİNE anon olarak YAZMAZ. Misafirin claim'i `*_join_room`
-- SECURITY DEFINER RPC'si tarafından atomik yazılır (o RPC bu revoke'tan
-- ETKİLENMEZ — sahip haklarıyla çalışır).
--
-- ⚠ authenticated INSERT'e DOKUNULMAZ. Tüm repoda ve yayınlanmış iOS
--   bundle'ında claim tablosuna yazan TEK istemci çağrısı vardır:
--   `wheel_duel_player_claims.insert` (WheelDuelGame.tsx:1386), Hızlı Eşleş
--   sonrası ve login-gate arkasında → authenticated. Hata verirse kullanıcıya
--   mesaj gösterilir. Bu yüzden authenticated katmanı KORUNUR.
--
-- KANIT: `route_duel_player_claims` ve `tevatur_player_claims` bugün hem anon
-- hem authenticated INSERT'e KAPALI ve o iki mod sorunsuz çalışıyor → hedef
-- durumun doğruluğu canlıda zaten kanıtlı.
-- ════════════════════════════════════════════════════════════════════════════
revoke insert on table public.duel_player_claims        from anon;
revoke insert on table public.duel_group_player_claims  from anon;
revoke insert on table public.wheel_duel_player_claims  from anon;
revoke insert on table public.wheel_group_player_claims from anon;
revoke insert on table public.flag_group_player_claims  from anon;
revoke insert on table public.conquest_player_claims    from anon;

revoke insert on table public.duel_player_claims        from public;
revoke insert on table public.duel_group_player_claims  from public;
revoke insert on table public.wheel_duel_player_claims  from public;
revoke insert on table public.wheel_group_player_claims from public;
revoke insert on table public.flag_group_player_claims  from public;
revoke insert on table public.conquest_player_claims    from public;


-- ════════════════════════════════════════════════════════════════════════════
-- BU MIGRATION'IN BİLİNÇLİ OLARAK YAPMADIKLARI
-- ────────────────────────────────────────────
-- Denetimde ürün kuralına göre GEREKSİZ olduğu tespit edilen 14 anon EXECUTE
-- grant'ı daha var (Hızlı Eşleş ailesi: *_quick_match / *_cancel_quick_match /
-- *_reset_quick_match — beş modda). HEPSİ gövdelerinde
-- `auth.uid() is null → not authenticated` VE `auth.uid() <> p_profile_id`
-- kapılarını taşıyor → exploit DEĞİL, yalnız fazlalık.
-- App Store submit'i öncesi kapsamı genişletmemek için BU TURDA DOKUNULMUYOR;
-- raporlandı, ayrı bir turda ele alınacak.
--
-- Aynı şekilde kapsam dışı: profiles moderasyon kolonlarının anon görünürlüğü,
-- duel_messages'ın tüm odalar için anon-okunur olması, 46 orphan anon-EXECUTE
-- fonksiyon, 17 trigger fonksiyonu, 19 PUBLIC EXECUTE artığı, 11 tablodaki
-- gereksiz anon yazma grant'ı, 2 ölü overload.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA — hedefler kapandı mı VE korunması gerekenler duruyor mu
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_fail text := '';
  v_name text;
begin
  -- (1) hedefler gerçekten kapandı mı
  if has_function_privilege('anon', 'public.tevatur_create_room(uuid,text,int,int,uuid)', 'EXECUTE') then
    v_fail := v_fail || ' [tevatur_create_room anon HÂLÂ AÇIK — yetki PUBLIC''ten geliyor olabilir]';
  end if;

  if has_table_privilege('anon', 'public.wheel_duel_queue', 'SELECT') then
    v_fail := v_fail || ' [wheel_duel_queue anon SELECT HÂLÂ AÇIK]';
  end if;

  foreach v_name in array array[
    'duel_player_claims','duel_group_player_claims','wheel_duel_player_claims',
    'wheel_group_player_claims','flag_group_player_claims','conquest_player_claims'
  ] loop
    if has_table_privilege('anon', 'public.' || v_name, 'INSERT') then
      v_fail := v_fail || format(' [%s anon INSERT HÂLÂ AÇIK]', v_name);
    end if;
  end loop;

  -- (2) KORUNMASI GEREKENLER — biri düştüyse migration DURUR
  if not has_table_privilege('authenticated', 'public.wheel_duel_queue', 'SELECT') then
    v_fail := v_fail || ' [wheel_duel_queue authenticated SELECT KAYBOLDU — Çark QM kırılır]';
  end if;
  if not has_table_privilege('authenticated', 'public.wheel_duel_player_claims', 'INSERT') then
    v_fail := v_fail || ' [wheel_duel_player_claims authenticated INSERT KAYBOLDU — eski istemci kırılır]';
  end if;

  -- ── misafir katılım yolu (anon EXECUTE ŞART) ──────────────────────────
  -- SEKİZ giriş noktası vardır. `flag_duel_join_room` YOKTUR ve OLMAMALIDIR:
  -- Bayrak Düello, Ülke Yaz ile AYNI `duel_join_room` RPC'sini kullanır
  -- (duel_rooms paylaşımlı tablo, room_kind ayırıcı).
  --   • FlagDuelGame.tsx:1955  → supabase.rpc("duel_join_room", ...)
  --   • yayınlanmış iOS bundle → rpc("duel_join_room") (flag_duel_join_room 0 kez)
  --   • 20260709120000 yorumu  → "Ayrı bir flag_duel_join_room RPC'si tanımlı değil."
  -- Bu liste ÜRETİM ENVANTERİNDEN doğrulanmıştır; var olmayan bir isim
  -- eklenirse migration KENDİNİ bloklar (ilk denemede tam bu oldu).
  foreach v_name in array array[
    'duel_join_room',            -- Ülke Yaz 1v1 + BAYRAK DÜELLO (ortak)
    'duel_group_join_room',      -- Ülke Yaz Grup
    'wheel_duel_join_room',      -- Çark Düello
    'wheel_group_join_room',     -- Çark Grup
    'flag_group_join_room',      -- Bayrak Bilmece Grup
    'route_duel_join_room',      -- Rota Düello
    'tevatur_join_room',         -- Kör Nokta
    'conquest_register_player'   -- Kuşatma (join yerine register)
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
    ) then
      v_fail := v_fail || format(' [MİSAFİR KATILIM RPC BULUNAMADI: %s]', v_name);
    elsif not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
         and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      v_fail := v_fail || format(' [MİSAFİR KATILIM RPC anon KAPALI: %s]', v_name);
    end if;
  end loop;

  -- Kör Nokta'nın AKTİF overload'ı: istemci 5 argümanla çağırır
  -- (p_code, p_player_id, p_claim_token, p_guest_id, p_name). Yalnız isme
  -- bakan kontrol, eski 3-arg overload açıkken yeni imza kapalıysa bunu
  -- KAÇIRIRDI → imza açıkça kontrol edilir.
  if to_regprocedure('public.tevatur_join_room(text,uuid,uuid,text,text)') is null then
    v_fail := v_fail || ' [tevatur_join_room 5-arg overload BULUNAMADI]';
  elsif not has_function_privilege('anon',
          'public.tevatur_join_room(text,uuid,uuid,text,text)', 'EXECUTE') then
    v_fail := v_fail || ' [tevatur_join_room 5-arg overload anon KAPALI — misafir korNokta odasına giremez]';
  end if;

  -- yalnız yayınlanmış bundle'ın çağırdığı legacy shim'ler (anon EXECUTE ŞART)
  -- Altısı da üretim envanterinde doğrulandı.
  foreach v_name in array array[
    'flag_duel_finalize_game','flag_duel_set_next_round',
    'flag_group_advance_flag','flag_group_finalize_game',
    'wheel_duel_pick_target','wheel_group_pick_target'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
    ) then
      v_fail := v_fail || format(' [LEGACY SHIM BULUNAMADI: %s]', v_name);
    elsif not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
         and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      v_fail := v_fail || format(' [LEGACY SHIM anon KAPALI: %s]', v_name);
    end if;
  end loop;

  -- KAYITLI oda kurma yolu (authenticated EXECUTE ŞART) — 8'i de envanterde
  -- doğrulandı. NOT: Bayrak Düello'nun KENDİ create_room'u VARDIR
  -- (join'i yoktur); ikisini karıştırmamak kritik.
  foreach v_name in array array[
    'duel_create_room','duel_group_create_room','wheel_duel_create_room',
    'wheel_group_create_room','flag_group_create_room','route_duel_create_room',
    'flag_duel_create_room','tevatur_create_room'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
    ) then
      v_fail := v_fail || format(' [KAYITLI ODA KURMA RPC BULUNAMADI: %s]', v_name);
    elsif not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      v_fail := v_fail || format(' [KAYITLI ODA KURMA authenticated KAPALI: %s]', v_name);
    end if;
  end loop;

  -- KAYITLI Hızlı Eşleş yolu (authenticated EXECUTE ŞART) — 5'i de envanterde
  -- doğrulandı. (Bu turda anon grant'larına DOKUNULMUYOR; bkz. yukarıdaki not.)
  foreach v_name in array array[
    'country_duel_quick_match','flag_duel_quick_match','wheel_duel_quick_match',
    'conquest_quick_match','route_duel_quick_match'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
    ) then
      v_fail := v_fail || format(' [KAYITLI HIZLI EŞLEŞ RPC BULUNAMADI: %s]', v_name);
    elsif not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      v_fail := v_fail || format(' [KAYITLI HIZLI EŞLEŞ authenticated KAPALI: %s]', v_name);
    end if;
  end loop;

  if v_fail <> '' then
    raise exception 'M2 DOĞRULAMA BAŞARISIZ:%', v_fail;
  end if;

  raise notice 'OK: 8 hedefli revoke uygulandı; misafir katılımı, legacy shim''ler, kayıtlı oda kurma/Hızlı Eşleş ve Çark QM köprüsü DEĞİŞMEDEN duruyor.';
end $$;
