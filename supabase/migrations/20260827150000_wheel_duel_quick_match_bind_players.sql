-- ════════════════════════════════════════════════════════════════════════════
-- 20260827150000_wheel_duel_quick_match_bind_players.sql
--
-- ÇARK HIZLI EŞLEŞ — EŞLEŞEN İKİ OYUNCUYA DA KALICI SAHİPLİK (ATOMİK)
-- Bağlama noktası: HIZLI EŞLEŞ RPC'sinin KENDİSİ (genel oyuncu trigger'ı YOK)
-- ════════════════════════════════════════════════════════════════════════════
-- SORUN (canlı postcheck ile KANITLANDI)
-- ─────────────────────────────────────
--   20260827140000 kuyruğu yetki kanıtı olmaktan çıkardı ve yetkiyi
--   `wheel_duel_quick_match_owners` kaydına bağladı. Sahiplik kaydını üreten
--   tek yol `wheel_duel_queue` üzerindeki trigger'dır. Ama canlı
--   `wheel_duel_quick_match` EŞLEŞME BULUNDUĞUNDA:
--
--     1) odayı kurar
--     2) BEKLEYEN oyuncunun wheel_duel_players satırını ekler
--     3) ÇAĞIRANIN  wheel_duel_players satırını ekler
--     4) YALNIZ bekleyenin kuyruk satırını UPDATE eder (matched_room_id)
--     5) ÇAĞIRANIN eski kuyruk satırını DELETE eder
--     6) matched=true + room_id + my_player_id (= p_player_id) döner
--
--   Çağıran taraf için hiçbir kuyruk YAZIMI olmaz → trigger tetiklenmez →
--   sahiplik doğmaz → `wheel_duel_authorize_player` = false →
--   `wheel_duel_claim_target` 42501 unauthorized.
--
--   CANLI ÖLÇÜM (postcheck-build10-live, iki adanmış test hesabı):
--     bekleyen taraf : kuyruk satırı VAR   → authorize = true
--     çağıran  taraf : kuyruk satırı YOK   → authorize = false
--   Gerçek cihazdaki "doğru ülkeye basamıyorum" semptomunun tam karşılığı:
--   ETKİLENEN OYUNCU = Hızlı Eşleş'e İKİNCİ basan (eşleşmeyi tetikleyen) kişi.
--
--   NOT: bu 140000'in yarattığı bir regresyon DEĞİLDİR. 20260814180000 claim
--   dalını gerçek misafirle sınırlayınca istemcinin yazdığı claim token ölmüş,
--   yerine konan kuyruk köprüsü de yalnız BEKLEYEN tarafı kapsıyordu. Çağıran
--   taraf 14 Ağustos'tan beri yetkisiz.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ÇÖZÜM ŞEKLİ: RENAME + SARMALAYICI (çekirdek gövde BİREBİR korunur)
-- ──────────────────────────────────────────────────────────────────
--   Sahiplik, EN DAR yetkili noktada — Hızlı Eşleş RPC'sinin kendi
--   transaction'ında — bağlanmalıdır. Bunun için canlı fonksiyonun gövdesini
--   YENİDEN YAZMAK gerekmez; yeniden yazmak canlı eşleştirme mantığını
--   (seviye bracket'i, bayat kuyruk self-heal'i, `expires_at`,
--   `for update skip locked`, dönüş JSON'u) elle kopyalamak demektir ve
--   sessiz davranış kayması riski taşır.
--
--   Bunun yerine:
--     A) canlı fonksiyon AYNI pg_proc satırı olarak KALIR, yalnız adı
--        `_wheel_duel_quick_match_core` olur   → gövde bit-bit AYNI,
--        prosecdef/proconfig AYNI (rename yalnız proname'i değiştirir),
--     B) aynı imzayla YENİ `public.wheel_duel_quick_match` kurulur:
--          • çekirdeği çağırır,
--          • sonucu DEĞİŞTİRMEDEN döndürür,
--          • matched=true ise İKİ tarafın da kalıcı sahipliğini bağlar.
--
--   Böylece "semantik fark" ispatlanabilir biçimde YALNIZCA sahiplik
--   bağlamadır: eşleştirme gövdesi hiç dokunulmadığı için sürüklenme
--   MATEMATİKSEL OLARAK imkânsızdır.
--
--   Atomiklik: sarmalayıcı ile çekirdek TEK transaction'dadır. Bağlama
--   RAISE ederse oda/oyuncu/kuyruk yazımları dahil HER ŞEY geri alınır.
--
--   ⚠ BAKIM NOTU: ileride biri `wheel_duel_quick_match`i eski gövdesiyle
--   yeniden CREATE OR REPLACE ederse sarmalayıcı sessizce kaybolur ve bu hata
--   geri gelir. Postcheck bunu kontrol eder (gövde `_wheel_duel_quick_match_core`
--   içermeli).
--
-- ════════════════════════════════════════════════════════════════════════════
-- GÜVENLİK GEREKÇESİ (çağıranın verdiği p_player_id'ye GÜVENİLMEZ)
-- ────────────────────────────────────────────────────────────────
--   Sahiplik yalnız ŞU kanıtlarla yazılır:
--     • auth.uid() = p_profile_id  (çekirdek zaten doğrular; sarmalayıcı
--       bağlamadan önce TEKRAR doğrular),
--     • bağlanacak oyuncu satırı, çekirdeğin BU transaction'da kurduğu odanın
--       ÜYESİDİR (p.room_id = döndürülen room_id),
--     • oyuncu satırının KENDİ kimliği çelişmez (misafir değil; kayıtlıysa
--       aynı profil) — oyuncu kimliği her zaman ÜSTÜNDÜR,
--     • BEKLEYEN taraf için profil, çekirdeğin kilitleyip yazdığı kuyruk
--       satırından SUNUCUDAN okunur (istemciden değil).
--
--   Kurbanın MEVCUT player_id'siyle eşleşme denemesi:
--     `wheel_duel_players.id` PRIMARY KEY → çekirdeğin INSERT'ü çakışır →
--     TÜM transaction geri alınır → oda yok, oyuncu yok, sahiplik yok.
--   Kurbanın QM player_id'si kuyrukta duruyorsa: `wheel_duel_queue.player_id`
--   UNIQUE → ikinci satır zaten yazılamaz.
--
--   ARIZADA-KAPANIR: sahiplik kaydı VARSA ve profil FARKLIYSA → RAISE (42501)
--   ve tüm Hızlı Eşleş geri alınır. Sahiplik ASLA devredilmez/üzerine yazılmaz.
--   `on conflict do nothing` TEK BAŞINA kullanılmaz; ardından ZORUNLU doğrulama
--   okuması yapılır (yarışta bile nihai sahip beklenenle aynı olmalıdır).
--
-- ════════════════════════════════════════════════════════════════════════════
-- DEĞİŞMEYENLER
-- ─────────────
--   • Eşleştirme gövdesi, dönüş JSON'u, doğrulamalar, kuyruk semantiği,
--     oda alanları, başlangıç zamanı: DOKUNULMADI (aynı pg_proc gövdesi).
--   • İstemciye açık ACL: `wheel_duel_quick_match` EXECUTE = anon,
--     authenticated, service_role (canlıyla BİREBİR yeniden kurulur).
--     Çekirdek istemciye KAPATILIR (yalnız definer sahibi çağırır).
--
--     ⚠ CANLI proacl:
--       {=X/postgres,postgres=X/postgres,anon=X/postgres,
--        authenticated=X/postgres,service_role=X/postgres}
--       Baştaki BOŞ grantee (`=X/postgres`) PUBLIC'in EXECUTE'udur. Yani
--       çekirdeği yalnız anon/authenticated/service_role'den revoke etmek
--       YETMEZ: üç rol de PUBLIC üzerinden EXECUTE'u MİRAS ALIR ve
--       sarmalayıcıyı atlayıp çekirdeği doğrudan çağırabilirdi. Bu yüzden
--       çekirdekten ÖNCE `from public` revoke edilir; sarmalayıcıda da PUBLIC
--       varsayılanı kaldırılıp üç rol AÇIKÇA grant edilir (canlı istemci yolu
--       birebir korunur; PUBLIC kapanır). Doğrulama bloğu bunu hem
--       `has_function_privilege` (PUBLIC mirasını da sayar) hem
--       `aclexplode(...) grantee = 0` ile ölçer.
--   • 20260827140000: owners tablosu, kuyruk trigger'ı, sertleştirilmiş
--     `wheel_duel_authorize_player`, kuyruk ACL'i → HİÇBİRİ değişmez.
--   • `wheel_duel_cancel_quick_match` / `wheel_duel_reset_quick_match`,
--     diğer modlar, istemci kaynağı: DOKUNULMADI.
--   • PUBLIC'e hiçbir şey açılmaz; owners tablosuna istemci yazımı YOK.
--   • `wheel_duel_players` üzerinde GENEL sahiplik trigger'ı YOKTUR
--     (önceki taslaktaki `wheel_duel_players_bind_owner` bu dosyada
--      açıkça KALDIRILIR ve yokluğu doğrulanır).
--
-- IDEMPOTENT: rename yalnız çekirdek yoksa yapılır; gerisi create or replace.
-- ÖN KOŞUL: 20260827140000 uygulanmış olmalı (CANLI).
-- DEPLOY: PRODUCTION'A UYGULANMADI.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 0) ÖN KOŞUL ─────────────────────────────────────────────────────────────
do $$
declare v_col text;
begin
  if to_regclass('public.wheel_duel_quick_match_owners') is null then
    raise exception 'ÖN KOŞUL EKSİK: 20260827140000 uygulanmamış (owners tablosu yok)';
  end if;
  if to_regprocedure('public.wheel_duel_authorize_player(uuid,uuid)') is null then
    raise exception 'ÖN KOŞUL EKSİK: wheel_duel_authorize_player yok';
  end if;

  -- Kullanılan kolonlar (canlı şemadan doğrulanmış):
  foreach v_col in array array['id','room_id','profile_id','guest_id'] loop
    if not exists (select 1 from pg_attribute
                    where attrelid = to_regclass('public.wheel_duel_players')
                      and attname = v_col and attnum > 0 and not attisdropped) then
      raise exception 'ÖN KOŞUL EKSİK: wheel_duel_players.% kolonu yok', v_col;
    end if;
  end loop;
  foreach v_col in array array['profile_id','player_id','matched_room_id'] loop
    if not exists (select 1 from pg_attribute
                    where attrelid = to_regclass('public.wheel_duel_queue')
                      and attname = v_col and attnum > 0 and not attisdropped) then
      raise exception 'ÖN KOŞUL EKSİK: wheel_duel_queue.% kolonu yok', v_col;
    end if;
  end loop;

  -- players.id PRIMARY KEY: "kurbanın mevcut kimliğiyle eşleşilemez" kanıtı.
  if not exists (
    select 1
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid = to_regclass('public.wheel_duel_players')
       and c.contype = 'p'
       and a.attname = 'id'
  ) then
    raise exception 'ÖN KOŞUL EKSİK: wheel_duel_players.id PRIMARY KEY değil';
  end if;

  -- owners.player_id tekil olmalı: "ilk sahip kalıcı" kuralının dayanağı.
  if not exists (
    select 1
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid = to_regclass('public.wheel_duel_quick_match_owners')
       and c.contype in ('p','u')
       and array_length(c.conkey, 1) = 1
       and a.attname = 'player_id'
  ) then
    raise exception 'ÖN KOŞUL EKSİK: owners.player_id üzerinde PK/UNIQUE yok';
  end if;

  -- Hedef fonksiyon canlıda TAM olarak bu imzayla var olmalı.
  if to_regprocedure(
       'public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)'
     ) is null
     and to_regprocedure(
       'public._wheel_duel_quick_match_core(uuid,uuid,text,integer,text,integer,text,text)'
     ) is null
  then
    raise exception
      'ÖN KOŞUL EKSİK: wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text) bulunamadı';
  end if;
end $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) ÖNCEKİ TASLAĞIN GENEL OYUNCU TRIGGER'I — VARSA KALDIR
-- ----------------------------------------------------------------------------
-- Bu dosyanın ilk taslağı `wheel_duel_players` üzerinde AFTER INSERT trigger
-- kuruyordu. Karar değişti: bağlama, yürütme yüzeyi en dar olan noktada
-- (Hızlı Eşleş RPC'si) yapılır. Trigger üretime UYGULANMADI; yine de yerel/
-- staging kopyalarda kalmış olabileceği için burada açıkça temizlenir.
-- ────────────────────────────────────────────────────────────────────────────
drop trigger  if exists wheel_duel_players_bind_owner on public.wheel_duel_players;
drop function if exists public._wheel_duel_bind_player_owner();


-- ────────────────────────────────────────────────────────────────────────────
-- 2) ARIZADA-KAPANIR SAHİPLİK BAĞLAYICI (sunucu-özel yardımcı)
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER bilinçlidir: tek çağıran, sahibi `postgres` olan SECURITY
-- DEFINER sarmalayıcıdır; orada etkin rol zaten tablo sahibidir. Böylece
-- EXECUTE yetkisi bir gün sızsa bile doğrudan çağrı owners tablosunda yetki
-- bulamaz (savunma derinliği). Ayrıca üç istemci rolünden EXECUTE alınır.
--
-- KURAL:
--   • oyuncu satırı yoksa            → yazma (bağlanacak kimlik yok)
--   • oyuncu odanın üyesi değilse    → yazma (tutarsız kanıt → REDDET)
--   • gerçek misafir (guest_id dolu) → yazma (claim token ile yetkilenir)
--   • kayıtlı ve profil AYNI         → yazma (kendi kimliğiyle yetkilenir)
--   • kayıtlı ve profil FARKLI       → RAISE (kimlik çelişkisi)
--   • sahip yok                      → yaz
--   • sahip VAR ve AYNI              → idempotent kabul
--   • sahip VAR ve FARKLI            → RAISE (devir/üzerine yazma YASAK)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public._wheel_duel_bind_qm_owner(
  p_player_id  uuid,
  p_profile_id uuid,
  p_room_id    uuid
) returns void
language plpgsql
set search_path = public
as $$
declare
  v_p        record;
  v_existing uuid;
begin
  if p_player_id is null or p_profile_id is null or p_room_id is null then
    return;
  end if;

  select p.room_id, p.profile_id, p.guest_id
    into v_p
    from public.wheel_duel_players p
   where p.id = p_player_id;

  if not found then
    return;                                   -- bağlanacak kimlik yok
  end if;

  if v_p.room_id is distinct from p_room_id then
    return;                                   -- tutarsız kanıt → REDDET
  end if;

  if v_p.guest_id is not null then
    return;                                   -- gerçek misafir: claim token
  end if;

  if v_p.profile_id is not null then
    if v_p.profile_id <> p_profile_id then
      raise exception
        'wheel_duel: player % başka bir profile ait (kimlik çelişkisi)', p_player_id
        using errcode = '42501';
    end if;
    return;                                   -- kendi kimliğiyle yetkilenir
  end if;

  -- Kimliksiz (Hızlı Eşleş) satır: kalıcı sahiplik yazılır.
  select o.profile_id into v_existing
    from public.wheel_duel_quick_match_owners o
   where o.player_id = p_player_id;

  if v_existing is not null then
    if v_existing <> p_profile_id then
      raise exception
        'wheel_duel: player % için çelişkili sahiplik kaydı', p_player_id
        using errcode = '42501';
    end if;
    return;                                   -- idempotent
  end if;

  insert into public.wheel_duel_quick_match_owners (player_id, profile_id)
  values (p_player_id, p_profile_id)
  on conflict (player_id) do nothing;         -- İLK sahip kalıcı (devir yok)

  -- ZORUNLU DOĞRULAMA: `do nothing` sessiz kalmaz. Eşzamanlı bir transaction
  -- araya girip BAŞKA bir sahip yazdıysa burada yakalanır ve geri alınır.
  select o.profile_id into v_existing
    from public.wheel_duel_quick_match_owners o
   where o.player_id = p_player_id;

  if v_existing is distinct from p_profile_id then
    raise exception
      'wheel_duel: player % sahipliği beklenenden farklı (% ≠ %)',
      p_player_id, coalesce(v_existing::text, 'yok'), p_profile_id
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public._wheel_duel_bind_qm_owner(uuid,uuid,uuid) from public;
revoke all on function public._wheel_duel_bind_qm_owner(uuid,uuid,uuid) from anon;
revoke all on function public._wheel_duel_bind_qm_owner(uuid,uuid,uuid) from authenticated;
revoke all on function public._wheel_duel_bind_qm_owner(uuid,uuid,uuid) from service_role;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) CANLI FONKSİYONU ÇEKİRDEK OLARAK YENİDEN ADLANDIR
-- ----------------------------------------------------------------------------
-- `alter function ... rename to` YALNIZ proname'i değiştirir: gövde,
-- prosecdef, proconfig (search_path), sahiplik ve ACL aynı satırda kalır.
-- Eşleştirme mantığı bu yüzden bit-bit korunur.
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_def  text;
  v_live oid;
  v_deps text;
begin
  if to_regprocedure(
       'public._wheel_duel_quick_match_core(uuid,uuid,text,integer,text,integer,text,text)'
     ) is not null then
    return;                                   -- zaten taşınmış (tekrar çalışma)
  end if;

  v_live := to_regprocedure(
    'public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)');

  -- ══ OID BAĞIMLILIK DENETİMİ (rename tasarımının tek gerçek riski) ══════
  -- Rename OID'i KORUR. Ada göre çözülen her çağrı (PostgREST /rpc, plpgsql
  -- gövdeleri) yeniden çözülüp SARMALAYICIYA gider — istenen budur. Ama
  -- OID'e BAĞLI bir nesne (view/rule, default/check ifadesi, index ifadesi,
  -- trigger, başka bir fonksiyonun bağımlılık kaydı) rename'den sonra da
  -- ÇEKİRDEĞİ gösterir ve bağlamayı atlardı. Böyle bir nesne varsa
  -- migration BAŞLAMADAN durur (fail-closed).
  select string_agg(format('%s#%s', d.classid::regclass, d.objid), ', ')
    into v_deps
    from pg_depend d
   where d.refclassid = 'pg_proc'::regclass
     and d.refobjid   = v_live
     and d.deptype   <> 'i';                  -- 'i' = fonksiyonun kendi iç kaydı
  if v_deps is not null then
    raise exception
      'DURDURULDU: wheel_duel_quick_match OID''ine bağlı nesne(ler) var, rename '
      'bunları çekirdeğe kilitlerdi: %', v_deps;
  end if;

  if exists (select 1 from pg_trigger where tgfoid = v_live) then
    raise exception 'DURDURULDU: wheel_duel_quick_match bir trigger fonksiyonu olarak bağlı';
  end if;

  v_def := pg_get_functiondef(v_live);

  -- GÜVENLİK DURDURMASI: sarmalayıcıyı çekirdek sanıp yeniden adlandırmak
  -- sonsuz özyineleme üretirdi.
  if position('_wheel_duel_quick_match_core' in v_def) > 0 then
    raise exception
      'DURDURULDU: wheel_duel_quick_match zaten sarmalayıcı ama çekirdek yok';
  end if;

  execute 'alter function public.wheel_duel_quick_match'
       || '(uuid,uuid,text,integer,text,integer,text,text)'
       || ' rename to _wheel_duel_quick_match_core';
end $$;

-- Çekirdek istemciye KAPALI: yalnız sarmalayıcı (definer sahibi) çağırır.
-- Aksi hâlde istemci çekirdeği doğrudan çağırıp bağlamayı atlayabilirdi.
revoke all on function
  public._wheel_duel_quick_match_core(uuid,uuid,text,integer,text,integer,text,text)
  from public;
revoke all on function
  public._wheel_duel_quick_match_core(uuid,uuid,text,integer,text,integer,text,text)
  from anon;
revoke all on function
  public._wheel_duel_quick_match_core(uuid,uuid,text,integer,text,integer,text,text)
  from authenticated;
revoke all on function
  public._wheel_duel_quick_match_core(uuid,uuid,text,integer,text,integer,text,text)
  from service_role;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) YENİ `wheel_duel_quick_match` — AYNI İMZA, AYNI DÖNÜŞ, + SAHİPLİK
-- ----------------------------------------------------------------------------
-- Tek işlevsel ekleme: matched=true olduğunda İKİ tarafın da kalıcı sahipliği.
-- Sonuç JSON'u hiç dokunulmadan döndürülür (istemci sözleşmesi aynı).
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.wheel_duel_quick_match(
  p_profile_id     uuid,
  p_player_id      uuid,
  p_player_name    text,
  p_duration       integer,
  p_region         text,
  p_max_level_diff integer,
  p_room_code      text,
  p_first_target   text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_result  jsonb;
  v_room_id uuid;
  v_my_id   uuid;
  v_uid     uuid;
  v_waiting record;
begin
  -- 1) DEĞİŞMEMİŞ çekirdek eşleştirme (canlı gövde, birebir aynı pg_proc).
  v_result := public._wheel_duel_quick_match_core(
                p_profile_id, p_player_id, p_player_name, p_duration,
                p_region, p_max_level_diff, p_room_code, p_first_target);

  -- 2) Eşleşme yoksa (kuyruğa yazıldı) hiçbir sahiplik gerekmez: 140000'in
  --    kuyruk trigger'ı bekleyen tarafı zaten bağlar.
  if not coalesce((v_result->>'matched')::boolean, false) then
    return v_result;
  end if;

  v_my_id   := nullif(v_result->>'my_player_id', '')::uuid;
  v_room_id := nullif(v_result->>'room_id', '')::uuid;

  -- Oda id'si dönüşte yoksa sunucu durumundan türetilir (istemciden ASLA).
  if v_room_id is null and v_my_id is not null then
    select p.room_id into v_room_id
      from public.wheel_duel_players p
     where p.id = v_my_id;
  end if;

  if v_room_id is null then
    return v_result;
  end if;

  -- 3) ÇAĞIRAN taraf — kanıt: auth.uid() = p_profile_id (çekirdek de doğrular).
  --    p_player_id'ye DEĞİL, çekirdeğin döndürdüğü my_player_id'ye bağlanır.
  v_uid := auth.uid();
  if v_uid is not null and v_uid = p_profile_id and v_my_id is not null then
    perform public._wheel_duel_bind_qm_owner(v_my_id, p_profile_id, v_room_id);
  end if;

  -- 4) BEKLEYEN taraf — kanıt: çekirdeğin KENDİ kurduğu odayı gösteren kuyruk
  --    satırı. `matched_room_id`yi yalnız SECURITY DEFINER RPC yazar; istemci
  --    kuyruğa yazamaz (20260814180000 kilidi), dolayısıyla ekilemez.
  for v_waiting in
    select q.player_id, q.profile_id
      from public.wheel_duel_queue q
     where q.matched_room_id = v_room_id
       and q.player_id  is not null
       and q.profile_id is not null
       and q.profile_id is distinct from p_profile_id
  loop
    perform public._wheel_duel_bind_qm_owner(
              v_waiting.player_id, v_waiting.profile_id, v_room_id);
  end loop;

  -- 5) Çekirdeğin sonucu DEĞİŞMEDEN döner.
  return v_result;
end;
$$;

-- Canlı ACL'in BİREBİR yeniden kurulması (proacl: anon, authenticated,
-- service_role EXECUTE + sahibi postgres). PUBLIC'e açılmaz.
revoke all on function
  public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)
  from public;
grant execute on function
  public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)
  to anon;
grant execute on function
  public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)
  to authenticated;
grant execute on function
  public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)
  to service_role;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) BACKFILL — BİLEREK YOK
-- ----------------------------------------------------------------------------
-- Deploy anında OYNANAN maçların çağıran tarafı sahipsizdir (hata buydu).
-- Onları geriye dönük bağlamak için tek "kanıt" istemcinin verdiği player_id
-- olurdu; ona güvenmek kimliğe bürünmenin ta kendisidir. Sunucuda çağıranın
-- profilini gösteren hiçbir kayıt YOKTUR (kuyruk satırı silinmiştir).
--
-- Karar: TAHMİN YAPILMAZ. Deploy anında aktif olan Çark QM maçlarının çağıran
-- tarafı o maçı tamamlayamaz; bir sonraki Hızlı Eşleş'te sorun kalmaz.
-- Etki penceresi = maç süresi (60-300 sn). Sakin bir saatte uygulanmalı.
-- ────────────────────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────────────────────
-- 6) DOĞRULAMA — yarım kurulum COMMIT EDİLEMEZ
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_wrap oid;
  v_core oid;
  v_def  text;
  v_cfg  text[];
begin
  v_wrap := to_regprocedure(
    'public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)');
  v_core := to_regprocedure(
    'public._wheel_duel_quick_match_core(uuid,uuid,text,integer,text,integer,text,text)');

  if v_wrap is null then raise exception 'sarmalayıcı kurulmadı'; end if;
  if v_core is null then raise exception 'çekirdek bulunamadı';   end if;

  -- 6a) Sarmalayıcı gerçekten çekirdeği ve bağlayıcıyı çağırmalı.
  v_def := regexp_replace(pg_get_functiondef(v_wrap), '--[^\n]*', '', 'g');
  if position('_wheel_duel_quick_match_core' in v_def) = 0 then
    raise exception 'sarmalayıcı çekirdeği ÇAĞIRMIYOR';
  end if;
  if position('_wheel_duel_bind_qm_owner' in v_def) = 0 then
    raise exception 'sarmalayıcı sahiplik bağlamıyor';
  end if;

  -- 6b) SECURITY DEFINER + search_path korunmalı (ikisi de).
  if not (select prosecdef from pg_proc where oid = v_wrap) then
    raise exception 'sarmalayıcı SECURITY DEFINER değil';
  end if;
  if not (select prosecdef from pg_proc where oid = v_core) then
    raise exception 'çekirdek SECURITY DEFINER olma özelliğini kaybetti';
  end if;
  select proconfig into v_cfg from pg_proc where oid = v_wrap;
  if v_cfg is null or not (v_cfg @> array['search_path=public']) then
    raise exception 'sarmalayıcı search_path=public değil: %', v_cfg;
  end if;

  -- 6c) İstemci ACL'i: sarmalayıcı AÇIK, çekirdek KAPALI, PUBLIC yok.
  if not has_function_privilege('anon',          v_wrap, 'EXECUTE')
  or not has_function_privilege('authenticated', v_wrap, 'EXECUTE')
  or not has_function_privilege('service_role',  v_wrap, 'EXECUTE')
  then
    raise exception 'wheel_duel_quick_match ACL''i canlıdan DAR kaldı';
  end if;
  if has_function_privilege('anon',          v_core, 'EXECUTE')
  or has_function_privilege('authenticated', v_core, 'EXECUTE')
  or has_function_privilege('service_role',  v_core, 'EXECUTE')
  then
    raise exception 'çekirdek istemciye AÇIK kaldı (bağlama atlanabilir)';
  end if;
  -- PUBLIC (grantee = 0) hiçbir fonksiyonda olmamalı. proacl NULL ise ACL hiç
  -- maddileşmemiş demektir; o durumda PUBLIC varsayılan EXECUTE'a sahiptir.
  if exists (select 1 from pg_proc p
              where p.oid in (v_wrap, v_core) and p.proacl is null) then
    raise exception 'ACL maddileşmedi: PUBLIC varsayılan EXECUTE açık kalır';
  end if;
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid in (v_wrap, v_core) and a.grantee = 0) then
    raise exception 'PUBLIC EXECUTE sızdı (wheel_duel_quick_match / çekirdek)';
  end if;

  -- 6d) GENEL oyuncu trigger'ı OLMAMALI (tasarım kararı).
  if exists (
    select 1 from pg_trigger
     where tgrelid = 'public.wheel_duel_players'::regclass
       and tgname  = 'wheel_duel_players_bind_owner'
       and not tgisinternal
  ) then
    raise exception 'wheel_duel_players üzerinde genel bağlama trigger''ı KALDI';
  end if;

  -- 6e) 140000'in korumaları YERİNDE (bu dosya onları zayıflatmaz).
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.wheel_duel_queue'::regclass
       and tgname  = 'wheel_duel_queue_record_owner'
       and not tgisinternal
  ) then
    raise exception '140000 kuyruk trigger''ı kayboldu';
  end if;

  v_def := regexp_replace(pg_get_functiondef(
             to_regprocedure('public.wheel_duel_authorize_player(uuid,uuid)')),
             '--[^\n]*', '', 'g');
  if position('wheel_duel_quick_match_owners' in v_def) = 0 then
    raise exception 'authorize kalıcı sahiplik dalını kaybetti';
  end if;
  if position('wheel_duel_queue' in v_def) > 0 then
    raise exception 'authorize yeniden kuyruğa bağlandı';
  end if;

  if has_table_privilege('anon',          'public.wheel_duel_quick_match_owners', 'SELECT')
  or has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners', 'SELECT')
  or has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners', 'INSERT')
  or has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners', 'UPDATE')
  or has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners', 'DELETE')
  then
    raise exception 'owners tablosu istemciye açıldı';
  end if;

  if has_table_privilege('anon',          'public.wheel_duel_queue', 'INSERT')
  or has_table_privilege('authenticated', 'public.wheel_duel_queue', 'INSERT')
  or has_table_privilege('authenticated', 'public.wheel_duel_queue', 'UPDATE')
  or has_table_privilege('authenticated', 'public.wheel_duel_queue', 'DELETE')
  then
    raise exception 'wheel_duel_queue yazma kilidi gevşedi';
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA (Studio SQL editor — uygulandıktan SONRA)
-- ════════════════════════════════════════════════════════════════════════════
--   -- Sarmalayıcı yerinde mi? (beklenen: true)
--   select pg_get_functiondef(to_regprocedure(
--     'public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)'
--   )) like '%_wheel_duel_quick_match_core%';
--
--   -- ACL aynı mı? (beklenen: t,t,t ve çekirdek için f,f,f)
--   select has_function_privilege('anon',
--            'public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)','EXECUTE'),
--          has_function_privilege('authenticated',
--            'public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)','EXECUTE'),
--          has_function_privilege('service_role',
--            'public.wheel_duel_quick_match(uuid,uuid,text,integer,text,integer,text,text)','EXECUTE');
--
--   -- wheel_duel_players üzerinde genel trigger OLMAMALI (beklenen: 0 satır)
--   select tgname from pg_trigger
--    where tgrelid = 'public.wheel_duel_players'::regclass and not tgisinternal;
--
--   -- Bir Hızlı Eşleş sonrası İKİ oyuncunun da sahibi olmalı:
--   select p.id, (o.profile_id is not null) as has_owner
--     from public.wheel_duel_players p
--     left join public.wheel_duel_quick_match_owners o on o.player_id = p.id
--    where p.room_id = '<yeni QM oda id>';
--   -- beklenen: iki satır da has_owner = true
-- ════════════════════════════════════════════════════════════════════════════
