-- ============================================================================
-- Misafir Olarak Özel Odaya Katılma — sunucu tarafı yetkilendirme
-- ============================================================================
-- ÜRÜN KURALI (bu migration'ın uyguladığı sözleşme)
-- -------------------------------------------------
--   KAYITLI oyuncu  : oda kurar, Hızlı Eşleş kullanır, XP/altın/görev kazanır.
--   MİSAFİR oyuncu  : YALNIZ kayıtlı birinin kurduğu özel odaya oda kodu veya
--                     davet bağlantısıyla KATILIR. Oda kuramaz, Hızlı Eşleş'e
--                     giremez, kalıcı ilerleme yazamaz.
--
-- Bu kuralın büyük kısmı ZATEN sunucuda yürürlükteydi; bu migration kalan
-- boşlukları kapatır ve misafir akışının önündeki tek teknik engeli kaldırır.
--
--
-- MEVCUT DURUM (bu migration'dan ÖNCE — değiştirilmiyor, doğrulandı)
-- -------------------------------------------------------------------
--   ✔ Tüm *_quick_match RPC'leri  → yalnız `authenticated`  (misafir giremez)
--   ✔ award_xp_event + award_*_xp_event → yalnız `authenticated`, ayrıca
--     auth.uid() = p_profile_id kontrolü (misafir XP yazamaz)
--   ✔ tevatur_* (Kör Nokta) create/join → yalnız `authenticated` (login-only
--     mod; bu migration Kör Nokta'yı misafire AÇMAZ)
--   ✔ conquest_rooms INSERT policy → yalnız `authenticated` (misafir Kuşatma
--     odası kuramaz)
--   ✔ Her modun *_join_room RPC'si SECURITY DEFINER + `for update` oda kilidi
--     altında: kapasite, oda durumu (waiting/playing/finished), oda-içi nick
--     çakışması (lower(btrim(name))) ve assert_display_name_allowed
--     (kayıtlı username taklidi + yasaklı kelime) kontrollerini yapar.
--   ✔ *_player_claims tabloları: INSERT-only, SELECT grant YOK, realtime
--     publication DIŞI → misafir oturum kanıtı (claim_token) yalnız onu
--     oluşturan istemcide bilinir, yayınlanmaz.
--
--
-- BU MIGRATION'IN YAPTIĞI (4 bölüm)
-- ----------------------------------
--   A) resolve_torble_room_code → `anon`a da execute.
--      Misafir, oda kodunun HANGİ MODA ait olduğunu öğrenebilmeli; aksi hâlde
--      kod ekranından ileri gidemez. Yeni bilgi sızıntısı YOK: aynı kodla
--      *_join_room RPC'leri zaten anon'a açık ve room_not_found/room_full gibi
--      ayrımı hâlihazırda veriyor. Resolver yalnız (kod → mod etiketi) döner;
--      oyuncu listesi, host kimliği veya oda ayarı DÖNDÜRMEZ.
--
--   B) *_create_room RPC'lerinden `anon` execute yetkisi GERİ ALINIR.
--      Ürün kuralı: misafir yeni oda kuramaz. Bugüne kadar UI bunu gizliyordu
--      ama RPC anon'a açıktı (istemci-tarafı kontrol = gerçek kontrol değil).
--      Fonksiyon GÖVDELERİ DEĞİŞTİRİLMEZ — yalnız grant daraltılır; bu yüzden
--      mevcut kayıtlı-kullanıcı akışı byte-byte aynı kalır.
--
--   C) Oyuncu tablolarındaki HAM INSERT policy'leri kaldırılır.
--      duel_players / duel_group_players / wheel_duel_players /
--      wheel_group_players / flag_group_players / conquest_players üzerinde
--      "*_insert_self" adında bir anon INSERT policy'si duruyordu. Yalnız
--      kimlik XOR'unu (profile_id=auth.uid() XOR guest_id dolu) kontrol
--      ediyordu; KAPASİTE, ODA DURUMU, ODA-İÇİ NİCK ÇAKIŞMASI ve KAYITLI
--      USERNAME TAKLİDİ kontrollerinin HİÇBİRİNİ yapmıyordu. Yani anon anahtarı
--      olan biri PostgREST üzerinden doğrudan INSERT atarak dolu bir odaya
--      girebilir, oyun başladıktan sonra katılabilir veya kayıtlı bir oyuncunun
--      nick'iyle görünebilirdi.
--
--      Bu policy'ler HİÇBİR akış tarafından kullanılmıyor: tüm create/join
--      yolları SECURITY DEFINER RPC'lerdir ve RLS'i zaten bypass eder
--      (frontend'de tek bir doğrudan .insert() çağrısı yok — doğrulandı).
--      En yeni mod olan route_duel bu doğru deseni zaten kullanıyor
--      (20260802120000: "revoke insert, update, delete ... from anon,
--      authenticated", INSERT policy YOK). Bu bölüm eski tabloları aynı
--      hizaya getirir.
--
--   D) public.torble_link_guest_player(...) — misafir → hesap slot devri.
--      Misafir oyun sonunda hesap açtığında odadaki AYNI satır yeni hesaba
--      bağlanır; oda listesinde ikinci bir oyuncu OLUŞMAZ. Yalnız
--      `authenticated` çağırabilir ve yalnız claim_token'ı bilen (yani o
--      misafir oturumunun sahibi olan) taraf devralabilir.
--
--      Bu RPC XP/altın/görev/başarı YAZMAZ ve hiçbir ekonomi tablosuna
--      DOKUNMAZ. Geçmiş maçın ödülünü aktarmaz (bkz. aşağıdaki not).
--
--
-- GEÇMİŞ MAÇ ÖDÜLÜNÜN AKTARILMASI — BİLİNÇLİ OLARAK KAPSAM DIŞI
-- --------------------------------------------------------------
-- Mevcut XP mimarisinde maç sonucu SUNUCUDA yeniden hesaplanmıyor: istemci
-- xp_earned değerini kendisi hesaplayıp award_xp_event'e gönderiyor, sunucu
-- yalnız [0,500] aralığına clamp'liyor ve (profile_id, mode_key, room_id)
-- unique'i ile tekrar talebi engelliyor. Yani "misafirken kazandığın XP'yi
-- hesabına aktar" özelliği, doğrulanabilir bir sunucu-tarafı maç kaydı
-- olmadığı için pratikte "isteyene 500 XP veren uç nokta" hâline gelirdi.
-- Güvenli hâle getirmek 7 modun puanlamasını PL/pgSQL'de yeniden yazmayı
-- gerektirir (ekonomi çekirdeğinde yüksek riskli, geniş bir değişiklik).
--
-- Bu yüzden V1: aktarım YOK. Misafir hesap açtığında odadaki yerini korur ve
-- BİR SONRAKİ turdan itibaren normal şekilde XP kazanır. İstemci tarafında da
-- "misafirken oynanan maç" için XP yazımı ayrıca engellenir.
--
--
-- IDEMPOTENT
-- ----------
--   drop policy if exists / revoke / create or replace function → tekrar
--   çalıştırılabilir.
--
-- BAĞIMLILIK
-- ----------
--   20260801120000_room_code_resolver.sql   (resolve_torble_room_code)
--   20260806120000_ugc_safety_reports_moderation.sql (assert_display_name_allowed
--                                                     son hâli)
--   20260802120000_route_duel_init.sql      (route_duel_* tabloları)
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0) ÖN KOŞUL DENETİMİ — yanlış sırada çalıştırmaya karşı koruma
-- ----------------------------------------------------------------------------
-- Bu migration aşağıdaki nesnelere DAYANIR. Biri eksikken çalıştırılırsa
-- PL/pgSQL geç-bağlama nedeniyle CREATE komutları BAŞARILI olur ama fonksiyon
-- ÇAĞRILDIĞINDA patlar — yani odaya katılma canlıda kırılırdı. Bu blok o
-- sessiz felaketi baştan, hiçbir şey değiştirmeden durdurur.
--
--   public.username_key(text)                 → 20260716120000_username_key_system.sql
--   public.text_has_forbidden_content(text,text) → 20260806120000_ugc_safety_reports_moderation.sql
--   public.resolve_torble_room_code(text)     → 20260801120000 + 20260802120000
--   public.route_duel_players                 → 20260802120000_route_duel_init.sql
--
-- Hata alırsan: eksik migration'ı ÖNCE uygula, sonra bunu tekrar çalıştır.
-- ────────────────────────────────────────────────────────────────────────────

do $pre$
declare
  v_missing text[] := '{}';
begin
  if to_regprocedure('public.username_key(text)') is null then
    v_missing := v_missing || 'public.username_key(text)  [20260716120000]';
  end if;
  if to_regprocedure('public.text_has_forbidden_content(text,text)') is null then
    v_missing := v_missing || 'public.text_has_forbidden_content(text,text)  [20260806120000]';
  end if;
  if to_regprocedure('public.resolve_torble_room_code(text)') is null then
    v_missing := v_missing || 'public.resolve_torble_room_code(text)  [20260801120000 + 20260802120000]';
  end if;
  if to_regclass('public.route_duel_players') is null then
    v_missing := v_missing || 'public.route_duel_players  [20260802120000]';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception
      'ÖN KOŞUL EKSİK — bu migration çalıştırılamaz. Eksik nesneler: %. Önce ilgili migration(lar)ı uygula.',
      array_to_string(v_missing, ' | ');
  end if;
end
$pre$;


-- ────────────────────────────────────────────────────────────────────────────
-- A) Oda kodu çözümleyici — misafire aç
-- ----------------------------------------------------------------------------
-- Fonksiyon gövdesi DEĞİŞMEZ. Yalnız grant genişler.
--
-- NOT: 20260802120000 (route_duel) bu fonksiyonu yeniden tanımlayıp yalnız
-- `authenticated`a grant veriyor. Bu migration ONDAN SONRA çalıştığı için
-- anon grant'i kalıcıdır. Her iki rolü de açıkça yazıyoruz ki dosya tek başına
-- okunduğunda nihai durum belirsiz kalmasın ve tekrar çalıştırma güvenli olsun.
-- ────────────────────────────────────────────────────────────────────────────

grant execute on function public.resolve_torble_room_code(text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- A2) GÜVENLİK DÜZELTMESİ — kayıtlı kullanıcı adı taklidi (normalizasyon açığı)
-- ----------------------------------------------------------------------------
-- BULUNAN AÇIK
-- ------------
-- `assert_display_name_allowed`, girilen adı `lower(btrim(p_name))` ile
-- normalize edip `profiles.username_normalized` ile karşılaştırıyordu.
-- ANCAK `profiles.username_normalized`, 20260716120000'den beri
-- `public.username_key()` ile üretiliyor ve o fonksiyon Türkçe/aksanlı
-- harfleri ASCII'ye KATLIYOR (ç→c, ğ→g, ı→i, İ/I→i, ö→o, ş→s, ü→u ...).
--
-- İki taraf farklı normalize ettiği için karşılaştırma Türkçe adlarda
-- KAÇIRIYORDU:
--
--   Kayıtlı kullanıcı : "Çağrı"  →  username_normalized = 'cagri'
--   Misafir yazar     : "Çağrı"  →  lower(btrim(...))   = 'çağrı'
--   'çağrı' <> 'cagri' →  eşleşme YOK  →  MİSAFİR KABUL EDİLİYORDU.
--
-- Yani Türkçe karakter içeren HER kayıtlı kullanıcı adı, misafirler
-- tarafından birebir taklit edilebiliyordu. (İlginç biçimde ASCII'ye
-- düzleştirilmiş hâli — "cagri" — doğru şekilde engelleniyordu; koruma
-- tam tersine çalışıyordu.)
--
-- DÜZELTME
-- --------
-- Karşılaştırma da `public.username_key()` kullanır → iki taraf AYNI
-- anahtarı üretir. Böylece:
--   • "Çağrı", "çağrı", "  ÇAĞRI  ", "Cagri", "cagri" → hepsi aynı anahtar,
--     hepsi engellenir.
--   • "Çağrı41" farklı bir anahtardır → engellenmez (yalnız TAM eşleşme).
--
-- DAVRANIŞ ETKİSİ (daraltıcı, kırıcı değil)
-- -----------------------------------------
--   • Misafir → kayıtlı ad: artık gerçekten engellenir (amaçlanan davranış).
--   • Kayıtlı kullanıcı kendi adıyla girer: her iki taraf da username_key
--     ürettiği için kendi satırıyla EŞLEŞİR → izin verilir (eskiden Türkçe
--     adlarda "sahip bulunamadı" diye yanlış sebepten geçiyordu; sonuç aynı).
--   • Kayıtlı kullanıcı BAŞKASININ adıyla girer: artık engellenir.
--
-- İmza, hata etiketleri (name_invalid / display_name_forbidden /
-- registered_username_taken), SECURITY DEFINER ve grant'lar KORUNUR — yalnız
-- karşılaştırma anahtarı düzeltilir. Bu fonksiyonu çağıran tüm mod
-- RPC'leri değişmeden bu düzeltmeden yararlanır.
-- ────────────────────────────────────────────────────────────────────────────

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
  v_key    text;
  v_owner  uuid;
begin
  if p_name is null then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  v_trim := btrim(p_name);

  if length(v_trim) < 2 or length(v_trim) > 16 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  -- Ortak UGC filtresi (rezerv/otorite/marka/küfür) — profiles lookup'ından ÖNCE.
  if public.text_has_forbidden_content(v_trim, 'display_name') then
    raise exception 'display_name_forbidden' using errcode = 'P0001';
  end if;

  -- DÜZELTİLDİ: profiles.username_normalized ile AYNI anahtar üreticisi.
  v_key := public.username_key(v_trim);

  select id into v_owner
    from public.profiles
   where username_normalized = v_key
   limit 1;

  -- Hiçbir kayıtlı hesaba ait değil → serbest.
  if v_owner is null then
    return v_trim;
  end if;

  -- Kayıtlı kullanıcı kendi adını kullanıyor → izinli.
  if p_profile_id is not null and v_owner = p_profile_id then
    return v_trim;
  end if;

  -- Misafir taklidi veya auth-başka-nick taklidi.
  raise exception 'registered_username_taken' using errcode = 'P0001';
end
$$;

revoke all     on function public.assert_display_name_allowed(text, uuid, text) from public;
grant  execute on function public.assert_display_name_allowed(text, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- A3) check_guest_display_name — misafir nick ekranı için ÖN KONTROL
-- ----------------------------------------------------------------------------
-- NEDEN: Misafir nick ekranı adı yalnız biçimsel olarak doğrulayabilir; bir
-- adın kayıtlı bir hesaba ait olup olmadığını bilemez. Bu ön kontrol olmadan
-- kullanıcı adı yazar, ekranı geçer ve KATILMA anında anlaşılmaz bir hata
-- alırdı. Bu RPC aynı kararı ekranın kendisinde verdirir.
--
-- Yeni yetki AÇMAZ: tam olarak aynı bilgiyi `*_join_room` RPC'leri zaten
-- anon'a döndürüyor (registered_username_taken). Burada sadece daha erken ve
-- daha okunur biçimde döndürülüyor. Hangi hesabın sahibi olduğu, kaç hesap
-- olduğu veya herhangi bir profil alanı DÖNMEZ — yalnız durum kodu.
--
-- Dönüş: 'ok' | 'invalid' | 'forbidden' | 'registered'
-- Otorite HÂLÂ katılma anındaki assert_display_name_allowed'dır (yarış
-- durumu: ön kontrol ile katılma arasında ad kayıt edilebilir).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.check_guest_display_name(p_name text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_display_name_allowed(p_name, null, 'preflight');
  return 'ok';
exception
  when sqlstate '22023' then
    return 'invalid';
  when others then
    -- P0001: display_name_forbidden | registered_username_taken
    if sqlerrm like '%registered_username_taken%' then
      return 'registered';
    elsif sqlerrm like '%display_name_forbidden%' then
      return 'forbidden';
    end if;
    return 'invalid';
end
$$;

revoke all     on function public.check_guest_display_name(text) from public;
grant  execute on function public.check_guest_display_name(text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- B) Oda KURMA — misafire kapat
-- ----------------------------------------------------------------------------
-- Yalnız `anon` yetkisi geri alınır; `authenticated` dokunulmaz → kayıtlı
-- kullanıcının oda kurma akışı aynen çalışır.
--
-- duel_accept_rematch / duel_join_rematch_room KASTEN dışarıda: bunlar ZATEN
-- katıldığı odada rövanş akışıdır, "yeni oda kurma" değildir; misafir rövanş
-- oynayabilmelidir.
-- ────────────────────────────────────────────────────────────────────────────

revoke execute on function public.duel_create_room(uuid, uuid, text, text, text, int, text, uuid)                        from anon;
revoke execute on function public.duel_group_create_room(uuid, uuid, text, text, text, int, text, int, uuid)             from anon;
revoke execute on function public.flag_duel_create_room(uuid, uuid, text, text, text, text, int, uuid)                   from anon;
revoke execute on function public.flag_group_create_room(uuid, uuid, text, text, text, text, int, int, uuid)             from anon;
revoke execute on function public.route_duel_create_room(uuid, uuid, text, text, text, int, text, uuid)                  from anon;
revoke execute on function public.wheel_duel_create_room(uuid, uuid, text, text, text, int, text, uuid)                  from anon;
revoke execute on function public.wheel_group_create_room(uuid, uuid, text, text, text, int, text, boolean, int, uuid)   from anon;


-- ────────────────────────────────────────────────────────────────────────────
-- C) Oyuncu tabloları — ham INSERT yolunu kapat (RPC-only)
-- ----------------------------------------------------------------------------
-- Katılma yalnız *_join_room / *_register_player RPC'lerinden geçebilmeli;
-- yoksa kapasite / oda durumu / nick çakışması / kayıtlı-ad taklidi
-- kontrollerinin tamamı atlanabilir.
--
-- SELECT policy'lerine DOKUNULMAZ (lobi listesi + realtime bunlara bağlı).
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "duel_players_insert_self"        on public.duel_players;
drop policy if exists "duel_group_players_insert_self"  on public.duel_group_players;
drop policy if exists "wheel_duel_players_insert_self"  on public.wheel_duel_players;
drop policy if exists "wheel_group_players_insert_self" on public.wheel_group_players;
drop policy if exists "flag_group_players_insert_self"  on public.flag_group_players;
drop policy if exists "conquest_players_insert_self"    on public.conquest_players;

-- Eski (lockdown öncesi) geniş policy adları — canlıda kalmış olabilir.
drop policy if exists "duel_players_insert_anon"        on public.duel_players;
drop policy if exists "duel_group_players_insert_anon"  on public.duel_group_players;
drop policy if exists "wheel_duel_players_insert_anon"  on public.wheel_duel_players;
drop policy if exists "wheel_group_players_insert_anon" on public.wheel_group_players;
drop policy if exists "flag_group_players_insert_anon"  on public.flag_group_players;
drop policy if exists "conquest_players_insert_anon"    on public.conquest_players;

-- Süpürücü: bu tablolarda SELECT dışında policy KALMASIN (Studio'da elle
-- eklenmiş, adı bilinmeyen kalıntılara karşı).
do $$
declare
  pol record;
begin
  for pol in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('duel_players', 'duel_group_players', 'wheel_duel_players',
                         'wheel_group_players', 'flag_group_players', 'conquest_players')
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end$$;

-- Defense-in-depth: policy'ler gitse bile tablo GRANT'i de daraltılır
-- (route_duel_players'ın 20260802120000'de kullandığı desen).
revoke insert, update, delete on table public.duel_players        from anon, authenticated;
revoke insert, update, delete on table public.duel_group_players  from anon, authenticated;
revoke insert, update, delete on table public.wheel_duel_players  from anon, authenticated;
revoke insert, update, delete on table public.wheel_group_players from anon, authenticated;
revoke insert, update, delete on table public.flag_group_players  from anon, authenticated;
revoke insert, update, delete on table public.conquest_players    from anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- D) torble_link_guest_player — misafir slotunu yeni hesaba devret
-- ----------------------------------------------------------------------------
-- Misafir oyun sonu ekranından hesap açtığında çağrılır. Odadaki mevcut
-- oyuncu satırının sahipliğini caller'ın hesabına geçirir:
--     profile_id := auth.uid()
--     guest_id   := null
--     name       := hesabın username'i (odada boşsa; değilse misafir adı kalır)
--
-- YETKİ ZİNCİRİ (hepsi zorunlu):
--   1. auth.uid() dolu olmalı                        → auth_required
--   2. p_mode whitelist'te olmalı                    → mode_invalid
--      (tablo adı KULLANICI GİRDİSİNDEN türetilmez; sabit CASE eşlemesi)
--   3. Satır misafir satırı olmalı (profile_id null)  → not_a_guest_row
--   4. claim_token satırın claim kaydıyla eşleşmeli   → claim_mismatch
--      → BAŞKA bir misafirin slotu devralınamaz.
--   5. Caller'ın o odada BAŞKA satırı olmamalı        → already_in_room
--      → aynı kişi odada iki kez görünemez.
--
-- Oda satırı `for update` ile KİLİTLENİR → eşzamanlı iki devir/katılım
-- arasında yarış durumu oluşmaz.
--
-- Bu fonksiyon XP/altın/görev/başarı/istatistik YAZMAZ.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.torble_link_guest_player(
  p_mode        text,
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_uid            uuid := auth.uid();
  v_players_table  text;
  v_claims_table   text;
  v_room_id        uuid;
  v_profile_id     uuid;
  v_token_ok       boolean;
  v_username       text;
  v_name_free      boolean;
  v_dup            boolean;
begin
  -- 1) Yalnız giriş yapmış kullanıcı devralabilir.
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  if p_player_id is null or p_claim_token is null then
    raise exception 'claim_token_required' using errcode = '22023';
  end if;

  -- 2) Mod → tablo eşlemesi. Tablo adları SABİT; kullanıcı girdisi asla
  --    doğrudan identifier'a dönüşmez (SQL injection yüzeyi yok).
  case p_mode
    when 'duel'       then v_players_table := 'duel_players';        v_claims_table := 'duel_player_claims';
    when 'flagDuel'   then v_players_table := 'duel_players';        v_claims_table := 'duel_player_claims';
    when 'duelGroup'  then v_players_table := 'duel_group_players';  v_claims_table := 'duel_group_player_claims';
    when 'wheelDuel'  then v_players_table := 'wheel_duel_players';  v_claims_table := 'wheel_duel_player_claims';
    when 'wheelGroup' then v_players_table := 'wheel_group_players'; v_claims_table := 'wheel_group_player_claims';
    when 'flagGroup'  then v_players_table := 'flag_group_players';  v_claims_table := 'flag_group_player_claims';
    when 'routeDuel'  then v_players_table := 'route_duel_players';  v_claims_table := 'route_duel_player_claims';
    when 'conquest'   then v_players_table := 'conquest_players';    v_claims_table := 'conquest_player_claims';
    else
      raise exception 'mode_invalid' using errcode = '22023';
  end case;

  -- 3) Satırı oku + oda kilidi al.
  execute format(
    'select room_id, profile_id from public.%I where id = $1 for update',
    v_players_table
  ) into v_room_id, v_profile_id using p_player_id;

  if v_room_id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  -- Zaten bu hesaba bağlıysa: idempotent başarı (çift tık / retry güvenli).
  if v_profile_id = v_uid then
    return true;
  end if;

  -- Başka bir hesabın satırı → asla devralınamaz.
  if v_profile_id is not null then
    raise exception 'not_a_guest_row' using errcode = '42501';
  end if;

  -- 4) Misafir oturum kanıtı: claim_token eşleşmeli.
  execute format(
    'select exists (select 1 from public.%I where player_id = $1 and claim_token = $2)',
    v_claims_table
  ) into v_token_ok using p_player_id, p_claim_token;

  if not coalesce(v_token_ok, false) then
    raise exception 'claim_mismatch' using errcode = '42501';
  end if;

  -- 5) Aynı hesabın bu odada başka satırı olmamalı.
  execute format(
    'select exists (select 1 from public.%I where room_id = $1 and profile_id = $2 and id <> $3)',
    v_players_table
  ) into v_dup using v_room_id, v_uid, p_player_id;

  if coalesce(v_dup, false) then
    raise exception 'already_in_room' using errcode = 'P0001';
  end if;

  -- 6) Görünen ad: hesabın username'i odada boşsa ona geç, değilse misafir
  --    adını KORU (devir, nick çakışması yüzünden başarısız olmasın).
  select username into v_username from public.profiles where id = v_uid;

  v_name_free := false;
  if v_username is not null and length(btrim(v_username)) > 0 then
    execute format(
      'select not exists (select 1 from public.%I where room_id = $1 and id <> $2 and lower(btrim(name)) = lower(btrim($3)))',
      v_players_table
    ) into v_name_free using v_room_id, p_player_id, v_username;
  end if;

  if coalesce(v_name_free, false) then
    execute format(
      'update public.%I set profile_id = $1, guest_id = null, name = btrim($2) where id = $3',
      v_players_table
    ) using v_uid, v_username, p_player_id;
  else
    execute format(
      'update public.%I set profile_id = $1, guest_id = null where id = $2',
      v_players_table
    ) using v_uid, p_player_id;
  end if;

  return true;
end
$$;

revoke all     on function public.torble_link_guest_player(text, uuid, uuid) from public;
grant  execute on function public.torble_link_guest_player(text, uuid, uuid) to authenticated;


-- ============================================================================
-- DOĞRULAMA (Supabase Studio → SQL Editor)
-- ============================================================================
--
-- A) Resolver artık anon'a açık:
--   select grantee, privilege_type
--     from information_schema.role_routine_grants
--    where routine_name = 'resolve_torble_room_code';
--   -- Beklenen: anon + authenticated satırları (EXECUTE).
--
-- B) Hiçbir *_create_room anon'a açık OLMAMALI:
--   select p.proname, r.grantee
--     from pg_proc p
--     join information_schema.role_routine_grants r
--       on r.specific_name = p.proname || '_' || p.oid
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname like '%\_create\_room'
--      and r.grantee = 'anon';
--   -- Beklenen: 0 satır.
--
-- C) Oyuncu tablolarında INSERT/UPDATE/DELETE policy KALMAMALI:
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('duel_players','duel_group_players','wheel_duel_players',
--                        'wheel_group_players','flag_group_players',
--                        'route_duel_players','conquest_players')
--      and cmd <> 'SELECT'
--    order by tablename;
--   -- Beklenen: 0 satır.
--
--   select grantee, table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('duel_players','flag_group_players','conquest_players')
--      and grantee in ('anon','authenticated')
--    order by table_name, grantee;
--   -- Beklenen: yalnız SELECT.
--
--   -- Katılmanın HÂLÂ çalıştığını doğrula (RPC yolu RLS'i bypass eder):
--   select * from public.flag_group_join_room(
--     '<AKTIF_KOD>', gen_random_uuid(), null, 'guest-test-1', 'MisafirTest',
--     gen_random_uuid());
--   -- Beklenen: oda satırı döner (INSERT policy olmadan da çalışır).
--
-- D) Slot devri:
--   -- 1. Misafirken katıl (yukarıdaki çağrı) → player_id + claim_token'ı sakla.
--   -- 2. Giriş yapmış oturumda:
--   select public.torble_link_guest_player('flagGroup', '<player_id>', '<claim_token>');
--   -- Beklenen: true; satırda profile_id dolar, guest_id null olur.
--   -- 3. Yanlış token ile → claim_mismatch (42501).
--   -- 4. Tekrar çağır → true (idempotent, ikinci kez yazmaz).
-- ============================================================================
