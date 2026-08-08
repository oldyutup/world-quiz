-- ============================================================================
-- KUŞATMA — görünen ad koruyucusunu sunucuya bağla (GÜVENLİK DÜZELTMESİ)
-- ============================================================================
-- BULUNAN AÇIK (manuel test + canlı salt-okuma teşhisiyle doğrulandı)
-- ----------------------------------------------------------------------------
-- `public.conquest_register_player` — Kuşatma'da oyuncu satırı yazan TEK
-- sunucu yolu — görünen adı yalnız UZUNLUK yönünden kontrol ediyordu
-- (`length(btrim(p_name)) < 2`). `public.assert_display_name_allowed` HİÇ
-- çağrılmıyordu.
--
-- Sonuç: bir misafir, KAYITLI bir Torble kullanıcısının adını birebir
-- kullanarak Kuşatma odasına girebiliyordu. Ne oda kodu ekranı ne de sunucu
-- bunu engelliyordu; anon anahtarla doğrudan RPC çağrısı da aynı şekilde
-- açıktı. Aynı boşluk yüzünden ortak UGC (rezerve/marka/küfür) filtresi de
-- Kuşatma'da hiç uygulanmıyordu.
--
-- Canlı teşhis (2026-08-08, salt-okuma):
--   • conquest_register_player → assert_display_name_allowed : false  ← açık
--   • koruyucuyu çağıran diğer mod RPC'leri                   : 8/8 tam
--   • assert_display_name_allowed → username_key              : true  (sağlam)
--   • check_guest_display_name → koruyucu                     : true  (sağlam)
--   • 29 kayıtlı ad, hepsi 'registered' döndü, 'ok' dönen 0    (ön kontrol sağlam)
--   • 16 karakterden uzun kayıtlı ad                          : 0     (kırılma yok)
--
-- Yani hata TEK bir yerdeydi: Kuşatma, koruyucu serisinin (20260704–20260709 +
-- 20260728 + 20260802 + 20260809) dışında kalmış tek çok oyunculu moddu.
--
-- DÜZELTME
-- --------
-- Gövdedeki uzunluk kontrolü, diğer sekiz modun BİREBİR kullandığı merkezî
-- çağrıyla değiştirilir:
--
--     p_name := public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id);
--
-- Koruyucu (20260808120000'deki son hâli) şunları yapar:
--   • 2–16 karakter kuralı            → 'name_invalid'            (22023)
--   • UGC/rezerve kelime filtresi     → 'display_name_forbidden'  (P0001)
--   • kayıtlı username rezervasyonu   → 'registered_username_taken'(P0001)
--     (karşılaştırma `public.username_key()` ile → büyük/küçük harf, baş/son
--      boşluk ve Türkçe karakter katlaması bypass EDİLEMEZ)
--   • kayıtlı kullanıcının KENDİ adı  → izinli (v_owner = p_profile_id)
-- ve adın btrim'lenmiş hâlini döndürür; INSERT artık o değeri yazar.
--
-- İSTEMCİ DEĞİŞİKLİĞİ GEREKMEZ: `src/modes/conquest/conquestService.ts:335-348`
-- bu üç hata etiketini ZATEN kullanıcı dostu Türkçe mesajlara çeviriyordu —
-- sunucu hiç fırlatmadığı için ölü dallardı, artık canlanıyorlar.
--
-- KAPSAM DIŞI (bilinçli — ayrı problem, ayrı karar)
-- -------------------------------------------------
--   • "aynı odada iki oyuncu aynı adı kullanabiliyor" (`name_taken`): Kuşatma'da
--     hâlâ AÇIK. Mevcut satırlarda çift ad olup olmadığı denetlenmeden unique
--     index eklenemez. Bu migration'a KARIŞTIRILMADI.
--   • `conquest_quick_match` (20260719120000:350-353) oyuncu satırlarını
--     doğrudan INSERT ediyor ve adı istemciden alıyor. Yalnız `authenticated`
--     rolüne grant'li ve `auth.uid() = p_profile_id` şartı var → MİSAFİR
--     vektörü DEĞİL. Ayrı bulgu olarak raporlandı.
--   • `conquest_rooms.host_name` doğrudan insert yüzeyi (host kendi satırı).
--
-- GÜVENLİK / GERİ ALINABİLİRLİK
-- -----------------------------
--   • CREATE OR REPLACE — imza AYNI, dolayısıyla mevcut ACL KORUNUR.
--     (Bu projede DROP+CREATE, Supabase default privileges yüzünden anon
--      EXECUTE'u geri getirir — bkz. 20260809130000 hotfix'i. O yüzden burada
--      DROP YOK, yeni overload YOK, GRANT/REVOKE satırı YOK.)
--   • Veri değişikliği / backfill YOK. Mevcut oda ve oyuncu satırlarına
--     dokunulmaz — kural yalnız BUNDAN SONRAKİ katılmalara uygulanır.
--   • Idempotent: tekrar çalıştırılabilir.
--   • Geri alma: 20260810120000'deki gövdeyi aynı CREATE OR REPLACE ile
--     yeniden uygulamak yeterlidir.
--
-- BAĞIMLILIK
-- ----------
--   20260808120000_guest_room_join.sql   (assert_display_name_allowed son hâli)
--   20260810120000_conquest_guest_read_lockdown_and_host_rules.sql
--                                        (değiştirilen gövdenin kaynağı)
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0) ÖN KOŞUL DENETİMİ — yanlış sırada / eksik bağımlılıkla çalıştırmaya karşı
-- ----------------------------------------------------------------------------
-- PL/pgSQL geç-bağlama nedeniyle eksik bir bağımlılık CREATE anında DEĞİL,
-- fonksiyon ÇAĞRILDIĞINDA patlar — yani odaya katılma canlıda kırılırdı.
-- Bu blok hiçbir şey değiştirmeden o sessiz felaketi baştan durdurur.
-- ────────────────────────────────────────────────────────────────────────────

do $pre$
declare
  v_missing text[] := '{}';
begin
  if to_regprocedure('public.assert_display_name_allowed(text,uuid,text)') is null then
    v_missing := array_append(
      v_missing,
      'public.assert_display_name_allowed(text,uuid,text)  [20260808120000]'
    );
  end if;

  if to_regprocedure(
       'public.conquest_register_player(uuid,uuid,uuid,text,text,text,boolean,uuid)'
     ) is null then
    v_missing := array_append(
      v_missing,
      'public.conquest_register_player(uuid,uuid,uuid,text,text,text,boolean,uuid)  [20260810120000]'
    );
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception
      'ÖN KOŞUL EKSİK — bu migration çalıştırılamaz. Eksik nesneler: %. Önce ilgili migration(lar)ı uygula.',
      array_to_string(v_missing, ' | ');
  end if;
end
$pre$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) conquest_register_player — görünen ad koruyucusu bağlanır
-- ----------------------------------------------------------------------------
-- Gövde 20260810120000:457-598 ile BİREBİR AYNIDIR; TEK fark, "Ad zorunlu"
-- uzunluk kontrolünün yerine merkezî koruyucu çağrısının geçmesidir.
-- Kimlik tutarlılığı, claim_token, yeniden katılma dalları, oda kilidi,
-- kapasite, renk paleti, INSERT'ler ve tazelik sinyali DEĞİŞMEDİ.
--
-- SIRALAMA KASITLI: koruyucu, kimlik ve claim_token kontrollerinden SONRA,
-- oda kilidinden (`for update`) ÖNCE çalışır.
--   • Hata önceliği korunur (profile_mismatch / guest_id_required /
--     claim_token_required önce gelir — mevcut istemci davranışı değişmez).
--   • `profiles` okuması oda kilidi DIŞINDA kalır → kilit süresi uzamaz.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_register_player(
  p_room_id     uuid,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_color       text,
  p_is_host     boolean,
  p_claim_token uuid
) returns public.conquest_players
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_player  public.conquest_players;
  v_uid     uuid := auth.uid();
  v_id      uuid := coalesce(p_player_id, gen_random_uuid());
  v_room    public.conquest_rooms;
  v_count   int;
  v_color   text;
  v_palette text[] := array['red','blue','green','yellow','purple','orange','pink','cyan'];
begin
  -- Kimlik tutarlılığı
  if p_profile_id is not null then
    if v_uid is null or p_profile_id <> v_uid then
      raise exception 'profile_mismatch' using errcode = '42501';
    end if;
  else
    if p_guest_id is null or length(btrim(p_guest_id)) = 0 then
      raise exception 'guest_id_required' using errcode = '22023';
    end if;
  end if;

  if p_claim_token is null then
    raise exception 'claim_token_required' using errcode = '22023';
  end if;

  -- ── Görünen ad: merkezî registry guard (diğer 8 modun birebir deseni) ──
  -- ESKİDEN: yalnız `length(btrim(p_name)) < 2` bakılıyordu → kayıtlı
  -- kullanıcı adları misafirlere AÇIKTI ve UGC filtresi uygulanmıyordu.
  -- Helper hata fırlatırsa ('name_invalid' / 'display_name_forbidden' /
  -- 'registered_username_taken') aynen yukarıya yayılır; istemci
  -- conquestService.ts içinde üçünü de zaten karşılıyor.
  -- Dönen değer btrim'lenmiş addır ve aşağıdaki INSERT'te kullanılır.
  p_name := public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id);

  -- Oda kilidi: kapasite sayımı ile INSERT arasındaki yarışı serileştirir.
  select * into v_room
    from public.conquest_rooms
   where id = p_room_id
   for update;

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Yeniden katılma (aynı hesap, başka sekme, kopan bağlantı): YENİ satır
  -- açmayız, mevcut satırı döndürürüz. Kapasite kontrolünden ÖNCE gelir —
  -- 4/4 dolu bir odada ZATEN oyuncu olan biri "oda dolu" hatası almamalıdır.
  if p_profile_id is not null then
    select * into v_player
      from public.conquest_players
     where room_id = p_room_id
       and profile_id = p_profile_id;

    if found then
      -- Bu dala YALNIZ satırın sahibi girebilir (yukarıda p_profile_id =
      -- auth.uid() zorunlu kılındı), bu yüzden claim_token'ı tazelemek
      -- güvenlidir: istemcinin bu çağrı için ürettiği yeni token çalışır.
      insert into public.conquest_player_claims (player_id, claim_token)
      values (v_player.id, p_claim_token)
      on conflict (player_id) do update set claim_token = excluded.claim_token;
      return v_player;
    end if;
  else
    -- MİSAFİR: kimlik kanıtı YALNIZ claim_token'dır; guest_id GİZLİ DEĞİLDİR
    -- (kayıtlı kullanıcılar oyuncu satırlarını okuyabilir). Bu yüzden bu dalda
    -- token TAZELENMEZ — tazelenseydi başkasının guest_id'sini yazan biri o
    -- misafirin satırını ele geçirebilirdi. İstemci her katılmada yeni bir
    -- guest_id ürettiği için bu dal normal akışta zaten tetiklenmez.
    if exists (
      select 1 from public.conquest_players
       where room_id = p_room_id
         and guest_id = btrim(p_guest_id)
    ) then
      raise exception 'already_in_room' using errcode = 'P0001';
    end if;
  end if;

  -- Host kendi odasını kurarken satır 'waiting' olarak yeni yazılmıştır; bu
  -- dal onu da doğal olarak kapsar.
  if v_room.status = 'playing' then
    raise exception 'room_in_progress' using errcode = 'P0001';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_unavailable' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from public.conquest_players
   where room_id = p_room_id;

  if v_count >= coalesce(v_room.max_players, 4) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Renk: istenen renk boş/alınmışsa paletten ilk boş renk.
  v_color := p_color;
  if v_color is null
     or v_color <> all(v_palette)
     or exists (
          select 1 from public.conquest_players
           where room_id = p_room_id and color = v_color
        )
  then
    -- `with ordinality` + `order by` KASITLI: filtresiz bir unnest'in satır
    -- sırası SQL'de garanti DEĞİLDİR. Paletteki sıra istemcideki
    -- CONQUEST_COLOR_PALETTE ile aynı olmalı ki iki taraf aynı rengi beklesin.
    select p.c into v_color
      from unnest(v_palette) with ordinality as p(c, ord)
     where not exists (
             select 1 from public.conquest_players
              where room_id = p_room_id and color = p.c
           )
     order by p.ord
     limit 1;
    v_color := coalesce(v_color, v_palette[1]);
  end if;

  insert into public.conquest_players (
    id, room_id, profile_id, guest_id, name, is_host, color
  ) values (
    v_id, p_room_id, p_profile_id, p_guest_id, p_name, p_is_host, v_color
  )
  returning * into v_player;

  insert into public.conquest_player_claims (player_id, claim_token)
  values (v_player.id, p_claim_token);

  -- Public liste için tazelik sinyali. Trigger updated_at'i now()'a çekecek.
  update public.conquest_rooms set updated_at = now() where id = p_room_id;

  return v_player;
end;
$$;

-- GRANT/REVOKE KASTEN YOK.
-- CREATE OR REPLACE imzayı değiştirmediği için mevcut ACL (anon + authenticated
-- EXECUTE, 20260810120000:600-601'de verilmişti) olduğu gibi korunur. Burada
-- yeniden grant vermek gereksiz; DROP+CREATE ise Supabase'in
-- `alter default privileges ... to anon` kurulumu yüzünden ACL'i yeniden
-- doğurur ve bu dosyayı sessizce bir yetki değişikliğine dönüştürürdü.


-- ────────────────────────────────────────────────────────────────────────────
-- 2) SON KOŞUL DENETİMİ — düzeltme gerçekten tuttu mu, yan etki var mı
-- ----------------------------------------------------------------------------
-- Salt-okuma. Bir şey ters giderse migration burada patlar ve transaction
-- geri alınır → yarım uygulanmış bir durum kalmaz.
-- ────────────────────────────────────────────────────────────────────────────

do $post$
declare
  v_oid      oid;
  v_overload int;
  v_def      text;
begin
  -- a) İmza değişmedi mi? (aynı 8 argüman, aynı sırada)
  v_oid := to_regprocedure(
    'public.conquest_register_player(uuid,uuid,uuid,text,text,text,boolean,uuid)'
  );
  if v_oid is null then
    raise exception 'SON KOŞUL: conquest_register_player beklenen imzayla bulunamadı.';
  end if;

  -- b) Yanlışlıkla ikinci bir overload doğmadı mı?
  select count(*) into v_overload
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'conquest_register_player';
  if v_overload <> 1 then
    raise exception
      'SON KOŞUL: conquest_register_player için % adet aşırı yükleme var (1 bekleniyordu).',
      v_overload;
  end if;

  -- c) Koruyucu gerçekten bağlandı mı?
  v_def := pg_get_functiondef(v_oid);
  if v_def not ilike '%assert_display_name_allowed%' then
    raise exception 'SON KOŞUL: koruyucu çağrısı gövdeye girmemiş.';
  end if;

  -- d) SECURITY DEFINER korundu mu?
  if not exists (select 1 from pg_proc where oid = v_oid and prosecdef) then
    raise exception 'SON KOŞUL: SECURITY DEFINER kaybolmuş.';
  end if;

  -- e) ACL korundu mu? Misafir katılımı anon EXECUTE'a BAĞLIDIR — bu düşerse
  --    özellik sessizce kırılır. (CREATE OR REPLACE korumalıdır; doğruluyoruz.)
  if not has_function_privilege('anon', v_oid, 'EXECUTE') then
    raise exception 'SON KOŞUL: anon EXECUTE kaybolmuş — misafir katılımı kırılırdı.';
  end if;
  if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'SON KOŞUL: authenticated EXECUTE kaybolmuş.';
  end if;

  raise notice 'conquest_register_player: ad koruyucusu bağlandı, imza ve ACL korundu.';
end
$post$;


-- ============================================================================
-- UYGULAMA SONRASI ELLE DOĞRULAMA (salt-okuma — istersen çalıştır)
-- ----------------------------------------------------------------------------
--   -- Koruyucu bağlı mı? (true bekleniyor)
--   select pg_get_functiondef(p.oid) ilike '%assert_display_name_allowed%'
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'conquest_register_player';
--
--   -- ACL değişmedi mi? (anon=true, authenticated=true bekleniyor)
--   select has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'conquest_register_player';
--
--   -- Diğer iki hotfix ACL'sine dokunulmadı mı? (ikisi de false bekleniyor)
--   select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('conquest_list_public_rooms','torble_link_guest_player');
-- ============================================================================
