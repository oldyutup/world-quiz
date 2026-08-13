-- ============================================================================
-- Bayrak Düello — sunucu-otoriter tur ilerletme (host SPOF kaldırılıyor)
-- ============================================================================
-- SORUN
-- ─────
-- Bugün bir Bayrak Düello maçını ilerleten TEK şey host tarayıcısıdır:
--
--   1. SIRADAKİ BAYRAK host'un RAM'indedir. `flagPoolRef` her istemcide
--      `buildProgressionQueue(..., Math.random)` ile AYRI AYRI kurulur; iki
--      istemcinin sırası farklıdır. Host `pool.find(ilk kullanılmamış)` ile
--      seçip `flag_duel_set_next_round(p_next_flag)`e YAZAR. Rakip aynı
--      diziyi bilmediği için host'un yerine geçemez.
--   2. `advanceRoundAsHost` `if (!isHostRef.current) return;` ile başlar.
--   3. Süre dolunca TIMEOUT claim'ini de YALNIZ host atar
--      (FlagDuelGame.tsx zamanlayıcısı, `if (isHostRef.current && …)`).
--   4. `flag_duel_set_next_round` / `flag_duel_finalize_game` host-only'dir ve
--      ikisi de ZAMANA HİÇ BAKMAZ: sunucu için "süre doldu" diye bir kavram
--      yoktur; host'un çağırması tanım gereği "şimdi geç" demektir.
--
-- Host uygulamayı arka plana atarsa / telefonu kilitlerse / bağlantısı
-- koparsa o tarayıcıdaki timer'lar donar ve maç HER İKİ OYUNCU İÇİN DE
-- donar: bayrak ekranda kalır, süre 0'dadır, TIMEOUT claim'i hiç yazılmaz,
-- tur asla ilerlemez. Rakibin yapabileceği hiçbir şey yoktur.
--
-- ÇÖZÜM — İKİ PARÇA
-- ─────────────────
--   A) BAYRAK SIRASI SUNUCUYA TAŞINIR (`duel_rooms.flag_sequence`)
--      Host maç başlarken kendi ürettiği sıralı diziyi bir kez yazar. İçerik
--      üretim kuralları DEĞİŞMEZ — dizi hâlâ mevcut istemci kodunun
--      (`buildProgressionQueue`) çıktısıdır; sadece artık kalıcıdır. Sunucu
--      "sıradaki bayrak"ı bu diziden deterministik seçebilir:
--      kullanılmamış İLK eleman — istemcideki `pool.find(...)` ile aynı kural.
--
--   B) DEADLINE'I SUNUCU DOĞRULAR (`flag_duel_advance_if_due`)
--      Odanın doğrulanmış HER üyesi çağırabilir, ama sunucu KİLİTLİ oda
--      satırından okuduğu `current_flag_at` ve `duel_claims.created_at`
--      değerlerini KENDİ `now()`'ı ile karşılaştırır. Anlamı "bu turun süresi
--      GERÇEKTEN dolduysa ilerlet"tir; "istediğim anda geç" DEĞİLDİR.
--
-- Rakip burada host OLMAZ. Yaptırabildiği tek durum geçişi, sunucunun o an
-- zaten yapacağı geçiştir. Süre dolmadıysa hiçbir şey olmaz. Bayrak seçemez,
-- tur atlayamaz, maçı erken bitiremez, host_player_id'ye dokunamaz — bu
-- fonksiyon o kolonu okumaz bile.
--
-- EMSAL: aynı desen Kör Nokta'da (`tevatur_kn_advance_if_due`, 20260813120000)
-- ve Rota Düello'da (`route_duel_advance_round`, 20260802120000 §14) canlıda
-- çalışıyor: odadaki herhangi bir oyuncu çağırır, sunucu deadline'ı doğrular,
-- erken atlama imkânsız.
--
-- İSTEMCİDEN ALINMAYANLAR (kasıtlı): deadline, client timestamp, "sıradaki
-- bayrak", kazanan, skor. Deadline sunucunun KİLİTLİ satırından okunur;
-- sıradaki bayrak persist edilmiş diziden gelir; kazanan gerçek claim
-- sayımından hesaplanır. İstemci yalnız "hangi durumu ilerlettiğini
-- sandığını" (round + flag) söyler — bu bir CAS girdisidir, yetki değil.
--
-- DOKUNULMAYANLAR
-- ───────────────
--   • flag_duel_set_next_round / flag_duel_finalize_game / flag_duel_start_game
--     / flag_duel_accept_rematch / flag_duel_submit_claim / flag_duel_leave_room
--     / flag_duel_create_room / flag_duel_update_settings — ne gövde ne ACL.
--   • flag_duel_quick_match / cancel / reset / mode_level.
--   • duel_rooms / duel_players / duel_claims RLS politikaları, publication
--     üyelikleri, replica identity.
--   • Kuşatma, Kör Nokta, Çark, Rota, Bayrak Bilmece (flag_group) — hiçbiri.
--   • duel_rooms.finished_at YAZILMAZ: o kolon legacy şemada YOKTUR
--     (bkz. 20260613120000_flag_duel_patch_finished_at.sql).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_rooms.flag_sequence — maçın bayrak sırası
-- ----------------------------------------------------------------------------
-- Nullable, default YOK → mevcut tüm satırlar (Bayrak ve Ülke 1v1 odaları)
-- NULL kalır, hiçbir davranış değişmez. Ülke 1v1 (DuelGame) bu kolonu ne
-- okur ne yazar.
--
-- Neden yeni tablo değil: sıra maçın kendi durumudur, oda satırıyla aynı
-- ömre ve aynı FOR UPDATE kilidine sahiptir. Ayrı tablo, ilerletme yolunda
-- ikinci bir kilit/JOIN demek olurdu.
--
-- Neden "kullanılan bayrak indeksi" değil de tam dizi: istemcideki seçim
-- kuralı `pool.find(kullanılmamış ilk)`tir ve "kullanılmış" kümesi
-- duel_claims'ten türetilir (PASS/TIMEOUT dahil). Diziyi olduğu gibi tutup
-- aynı kuralı uygulamak, bir sayaç tutup senkron kalmaya çalışmaktan hem
-- daha sadık hem yarışa dayanıklıdır (sayaç kaçarsa bayrak tekrarlanırdı).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.duel_rooms
  add column if not exists flag_sequence text[];


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Zaman sabitleri — istemci ile TEK KAYNAK eşleşmesi
-- ----------------------------------------------------------------------------
-- FlagDuelGame.tsx'teki karşılıkları:
--   FLAG_TIMEOUT_SEC = 10 · REVEAL_DELAY_MS = 2000 · PASS_REVEAL_MS = 700
-- Bu üçlü iki tarafta da sabittir; drift'i scripts/check-flag-duel-advance-
-- if-due.ts hem SQL'de hem TSX'te okuyup karşılaştırarak kilitler.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_flag_timeout_seconds()
returns int language sql immutable set search_path = public as $$ select 10; $$;

create or replace function public.flag_duel_reveal_delay_ms()
returns int language sql immutable set search_path = public as $$ select 2000; $$;

create or replace function public.flag_duel_pass_reveal_ms()
returns int language sql immutable set search_path = public as $$ select 700; $$;

-- Ortak pas kotası — FlagDuelGame.tsx `passQuota()` ile birebir.
create or replace function public.flag_duel_pass_quota(p_total_rounds int)
returns int language sql immutable set search_path = public as $$
  select case
           when p_total_rounds <= 5  then 3
           when p_total_rounds <= 10 then 5
           when p_total_rounds <= 15 then 7
           else 10
         end;
$$;

revoke all on function public.flag_duel_flag_timeout_seconds()  from public;
revoke all on function public.flag_duel_reveal_delay_ms()       from public;
revoke all on function public.flag_duel_pass_reveal_ms()        from public;
revoke all on function public.flag_duel_pass_quota(int)         from public;
-- Bunlar saf sabitlerdir; istemci ÇAĞIRMAZ. anon/authenticated'a EXECUTE
-- verilmez — SECURITY DEFINER gövdelerin içinden (definer hakkıyla) çağrılır.
-- Supabase'de public şemadaki yeni fonksiyonlar anon'a DOĞRUDAN EXECUTE ile
-- doğduğu için o grant'i AÇIKÇA geri alıyoruz (`from public` tek başına
-- yetmez — bkz. 20260809130000 hotfix'i).
revoke execute on function public.flag_duel_flag_timeout_seconds()  from anon, authenticated;
revoke execute on function public.flag_duel_reveal_delay_ms()       from anon, authenticated;
revoke execute on function public.flag_duel_pass_reveal_ms()        from anon, authenticated;
revoke execute on function public.flag_duel_pass_quota(int)         from anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) flag_duel_used_flag_codes — "bu odada hangi bayraklar oynandı?"
-- ----------------------------------------------------------------------------
-- FlagDuelGame.tsx `advanceRoundAsHost` içindeki `usedFlagCodes` ile birebir:
--   PASS:R{n}:{flag}:{playerId} → parts[2] = flag   (split_part ':' 3)
--   TIMEOUT:R{n}:{flag}         → parts[2] = flag   (split_part ':' 3)
--   diğer (gerçek cevap)        → country_code'un kendisi
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_used_flag_codes(p_room_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct
         case
           when c.country_code like 'PASS:%' or c.country_code like 'TIMEOUT:%'
             then split_part(c.country_code, ':', 3)
           else c.country_code
         end
    from public.duel_claims c
   where c.room_id = p_room_id;
$$;

revoke all on function public.flag_duel_used_flag_codes(uuid) from public;
revoke execute on function public.flag_duel_used_flag_codes(uuid) from anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) flag_duel_next_flag — persist edilmiş diziden sıradaki bayrak
-- ----------------------------------------------------------------------------
-- İstemcideki `pool.find(f => !usedFlagCodes.has(f.code))` ile birebir:
-- dizinin SIRASI korunarak ilk kullanılmamış eleman. Dizi yoksa/bittiyse NULL
-- döner ve çağıran no-op'a düşer (maç dondurulmaz, mevcut tur devam eder).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_next_flag(
  p_room_id  uuid,
  p_sequence text[]
) returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.code
    from unnest(p_sequence) with ordinality as s(code, ord)
   where s.code is not null
     and length(btrim(s.code)) > 0
     and s.code not in (select public.flag_duel_used_flag_codes(p_room_id))
   order by s.ord
   limit 1;
$$;

revoke all on function public.flag_duel_next_flag(uuid, text[]) from public;
revoke execute on function public.flag_duel_next_flag(uuid, text[]) from anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) flag_duel_score_winner — otoriter kazanan (finalize_game ile AYNI kural)
-- ----------------------------------------------------------------------------
-- 20260612120000 §6 `flag_duel_finalize_game` gövdesindeki hesabın birebir
-- aynısı: PASS:/TIMEOUT: hariç gerçek claim COUNT'u; en yüksek sayılı oyuncu
-- kazanan; top-1 ile top-2 EŞİTSE kazanan NULL (beraberlik). Aynı kuralı iki
-- yerde tutmamak için helper'a alındı; finalize_game'in GÖVDESİ bilinçli
-- olarak DEĞİŞTİRİLMEDİ, eşdeğerlik testle kilitlendi.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_score_winner(p_room_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_top_id     uuid;
  v_top_cnt    int;
  v_second_cnt int;
begin
  select player_id, cnt
    into v_top_id, v_top_cnt
    from (
      select player_id, count(*) as cnt
        from public.duel_claims
       where room_id = p_room_id
         and country_code not like 'PASS:%'
         and country_code not like 'TIMEOUT:%'
       group by player_id
       order by count(*) desc
       limit 1
    ) t;

  if v_top_id is null then
    return null;                       -- hiç gerçek claim yok → beraberlik
  end if;

  select cnt into v_second_cnt
    from (
      select count(*) as cnt
        from public.duel_claims
       where room_id = p_room_id
         and country_code not like 'PASS:%'
         and country_code not like 'TIMEOUT:%'
         and player_id <> v_top_id
       group by player_id
       order by count(*) desc
       limit 1
    ) s;

  if v_second_cnt is not null and v_second_cnt = v_top_cnt then
    return null;                       -- eşitlik
  end if;

  return v_top_id;
end;
$$;

revoke all on function public.flag_duel_score_winner(uuid) from public;
revoke execute on function public.flag_duel_score_winner(uuid) from anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) flag_duel_set_flag_sequence — maçın bayrak sırasını persist et
-- ----------------------------------------------------------------------------
-- HOST-ONLY, BİLİNÇLİ. Güven modeli BUGÜNKÜNÜN AYNISI kalsın diye: bugün de
-- bayrak sırasını fiilen host seçiyor (`flag_duel_set_next_round(p_next_flag)`
-- keyfî bir bayrak kabul eder). Diziyi rakibe de açsaydık, misafire bugün
-- olmayan bir yetki (sırayı önceden bilme) vermiş olurduk. Yetki genişlemesi
-- YOK: host zaten yapabildiği şeyi, artık bir kez ve peşinen yapıyor.
--
-- LIVENESS: host bunu maç BAŞLARKEN çağırır (start_game'den ÖNCE, rematch'ta
-- accept_rematch'ten ÖNCE, hızlı eşleşmede odaya girer girmez) — yani host'un
-- kesin ayakta olduğu anda. Sonrasında host kaybolsa bile sunucu maçın geri
-- kalanını tek başına yürütebilir.
--
-- Yeniden yazılabilir (write-once DEĞİL): kırılacak bir değişmez yok, çünkü
-- "sıradaki bayrak" her zaman KULLANILMAMIŞ ilk elemandır — daha önce
-- oynanmış bayraklar yeni dizide baştayken bile atlanır. Bu, dizinin
-- yazılamadığı bir maçın host tarafından sonradan onarılabilmesini sağlar.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_set_flag_sequence(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_flag_sequence  text[]
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.duel_rooms;
  v_count int;
  v_uniq  int;
begin
  if not public.flag_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_flag_sequence is null or cardinality(p_flag_sequence) = 0 then
    raise exception 'flag_sequence_required' using errcode = '22023';
  end if;
  if cardinality(p_flag_sequence) > 512 then
    raise exception 'flag_sequence_too_long' using errcode = '22023';
  end if;

  -- Eleman disiplini: NULL yok, boş yok, 8 karakterden uzun yok (ülke kodu),
  -- tekrar yok. Serbest metin depolanmasını (ve dizinin bir kaçak veri
  -- kanalına dönüşmesini) engeller.
  --
  -- SIRA ÖNEMLİ: NULL kontrolü tekrar kontrolünden ÖNCE gelir. `count(distinct)`
  -- NULL'ları saymaz; önce elenmezlerse ['TR', null] yanlışlıkla "duplicate"
  -- olarak raporlanırdı.
  if exists (select 1 from unnest(p_flag_sequence) as x where x is null) then
    raise exception 'flag_sequence_invalid' using errcode = '22023';
  end if;

  select count(*), count(distinct x)
    into v_count, v_uniq
    from unnest(p_flag_sequence) as x;

  if v_uniq <> v_count then
    raise exception 'flag_sequence_duplicate' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_flag_sequence) as x
     where length(btrim(x)) = 0 or length(x) > 8
  ) then
    raise exception 'flag_sequence_invalid' using errcode = '22023';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status not in ('waiting', 'playing') then
    raise exception 'room_not_open' using errcode = 'P0001';
  end if;

  update public.duel_rooms
     set flag_sequence = p_flag_sequence
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

-- ACL — AÇIK ve KASITLI. Gövde host-only'dir; grant kararı gövdeye bırakılır
-- (mevcut flag_duel_* host RPC'lerinin tamamı anon+authenticated grant'lidir,
-- reddi `flag_duel_authorize_host` yapar). Varsayılan ACL'ye GÜVENİLMEZ.
revoke all     on function public.flag_duel_set_flag_sequence(uuid, uuid, uuid, text[]) from public;
grant  execute on function public.flag_duel_set_flag_sequence(uuid, uuid, uuid, text[]) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) flag_duel_advance_if_due — süre dolduysa ilerlet, dolmadıysa hiçbir şey yapma
-- ----------------------------------------------------------------------------
-- Kontrol sırası (3'ten itibaren hepsi FOR UPDATE satır kilidi ALTINDA):
--   1. Kimlik   — flag_duel_authorize_player (kayıtlı: JWT; misafir: claim_token;
--                 QM-flag: flag_duel_queue köprüsü)
--   2. Üyelik   — o oyuncu satırı BU odada mı? (başka odadan alınmış geçerli bir
--                 token bu odayı ilerletemez)
--   3. Kilit    — select … for update
--   4. Durum    — oda 'playing' mi?
--   5. CAS      — current_round + current_flag çağıranın beklediğiyle aynı mı?
--   6. DEADLINE — current_flag_at ve duel_claims.created_at KİLİTLİ/sunucu
--                 verisinden okunur, now() ile karşılaştırılır
--
-- İKİ AŞAMALI OTOMAT (istemcideki akışın birebir karşılığı):
--   AŞAMA 1 — tur ÇÖZÜLMEMİŞ ve now() >= current_flag_at + 10sn
--             → TIMEOUT claim'i YAZILIR (idempotent), oda satırı DEĞİŞMEZ.
--               Her iki istemci bu claim'i realtime ile görür ve cevabı açar.
--               (Bugün bunu yalnız host yazıyordu → host yoksa hiç yazılmıyordu.)
--   AŞAMA 2 — tur ÇÖZÜLMÜŞ ve now() >= çözülme anı + reveal gecikmesi
--             (cevap/timeout 2000 ms · çift pas 700 ms)
--             → sıradaki bayrak / altın tur / maç sonu.
--
-- Çözülme ANI istemciden GELMEZ: ilgili duel_claims satırının server-side
-- created_at'idir. İstemci "şimdi 2 saniye geçti" diye bir iddia sunamaz.
--
-- 4–6 arasındaki her ret "zararsız no-op"tur: exception DEĞİL, DEĞİŞMEMİŞ oda
-- satırı döner. Faydası: (a) yarışı kaybeden çağıran hata toast'u görmez,
-- (b) bayat istemci aynı gidiş-dönüşte TAZE odayı alır, kendi kendini onarır.
--
-- ÇİFT İLERLEME NEDEN İMKÂNSIZ: iki istemci aynı anda çağırsa `for update`
-- onları seri hâle getirir; READ COMMITTED altında ikinci çağıran birincinin
-- commit'inden sonra GÜNCELLENMİŞ satırı okur, 5. adımdaki CAS artık tutmaz
-- ve no-op döner. Böylece tur artışı, bayrak değişimi ve finalize tam bir kez
-- olur. AŞAMA 1 ayrıca duel_claims UNIQUE(room_id, country_code) ile korunur.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_advance_if_due(
  p_room_id        uuid,
  p_player_id      uuid,
  p_claim_token    uuid,
  p_expected_round int,
  p_expected_flag  text
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room         public.duel_rooms;
  v_now          timestamptz := now();
  v_flag         text;
  v_next_flag    text;
  v_next_round   int;
  v_in_golden    boolean;
  v_timeout_code text;
  v_pass_prefix  text;
  v_answer_at    timestamptz;
  v_timeout_at   timestamptz;
  v_pass_at      timestamptz;
  v_pass_count   int;
  v_reason       text;
  v_resolved_at  timestamptz;
  v_delay_ms     int;
  v_completed    int;
  v_winner       uuid;
begin
  -- 1) Kimlik. Kayıtlıda auth.uid(), misafirde claim_token tek kanıttır.
  if not public.flag_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- 2) Üyelik. Bu şart olmadan BAŞKA bir odadaki geçerli bir claim_token bu
  --    odanın turunu ilerletebilirdi.
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  -- 3) Satır kilidi — bundan sonraki her okuma kanonik ve yarışsızdır.
  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- 4) Maç aktif değilse sessizce çık (lobi / bitmiş maç).
  if v_room.status <> 'playing' then
    return v_room;
  end if;

  v_flag := v_room.current_flag;

  -- 4b) ONARIM: 'playing' ama bayrak yok. İstemcide bu, host'a ait bir
  --     `advanceRoundAsHost("both_passed")` çağrısıydı; artık sunucu yapar.
  --     Süre kavramı yok (gösterilecek bayrak da yok) → anında düzeltilir.
  if v_flag is null then
    v_next_flag := public.flag_duel_next_flag(p_room_id, v_room.flag_sequence);
    if v_next_flag is null then
      return v_room;                       -- dizi yok/bitti → dokunma
    end if;
    update public.duel_rooms
       set current_flag    = v_next_flag,
           current_flag_at = v_now,
           current_round   = greatest(coalesce(v_room.current_round, 1), 1)
     where id = p_room_id
       and status = 'playing'
       and current_flag is null            -- CAS: yarışı kaybeden yazmaz
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.duel_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- 5) CAS: çağıranın ilerlettiğini sandığı tur hâlâ aktif mi?
  if v_room.current_round is distinct from p_expected_round
     or v_flag is distinct from p_expected_flag then
    return v_room;
  end if;

  if v_room.current_flag_at is null then
    return v_room;                         -- ölçülebilir başlangıç yok → no-op
  end if;

  -- ── Turun çözüm durumu: hepsi SUNUCU verisinden ────────────────────────
  v_timeout_code := 'TIMEOUT:R' || v_room.current_round || ':' || v_flag;
  v_pass_prefix  := 'PASS:R'    || v_room.current_round || ':' || v_flag || ':';

  -- Doğru cevap: country_code TAM olarak bayrak kodudur (PASS:/TIMEOUT:
  -- önekleri bu eşitliğe giremez). UNIQUE(room_id, country_code) sayesinde
  -- en fazla bir satır olabilir.
  select c.created_at into v_answer_at
    from public.duel_claims c
   where c.room_id = p_room_id and c.country_code = v_flag
   limit 1;

  select c.created_at into v_timeout_at
    from public.duel_claims c
   where c.room_id = p_room_id and c.country_code = v_timeout_code
   limit 1;

  select count(distinct c.player_id), max(c.created_at)
    into v_pass_count, v_pass_at
    from public.duel_claims c
   where c.room_id = p_room_id
     and c.country_code like v_pass_prefix || '%';

  if v_answer_at is not null then
    v_reason := 'answered';   v_resolved_at := v_answer_at;
    v_delay_ms := public.flag_duel_reveal_delay_ms();
  elsif v_timeout_at is not null then
    v_reason := 'timeout';    v_resolved_at := v_timeout_at;
    v_delay_ms := public.flag_duel_reveal_delay_ms();
  elsif coalesce(v_pass_count, 0) >= 2 then
    v_reason := 'both_passed'; v_resolved_at := v_pass_at;
    v_delay_ms := public.flag_duel_pass_reveal_ms();
  else
    -- ── AŞAMA 1: tur çözülmemiş. Süre doldu mu? ──────────────────────────
    -- DEADLINE OTORİTESİ: current_flag_at KİLİTLİ satırdan okunur; istemci
    -- parametre olarak süre/zaman GÖNDEREMEZ ve istemcinin Date.now()'ı
    -- karara girmez.
    if v_now < v_room.current_flag_at
              + make_interval(secs => public.flag_duel_flag_timeout_seconds()) then
      return v_room;                       -- not_due
    end if;

    -- TIMEOUT claim'ini SUNUCU yazar. Çağıranın player_id'si kullanılır;
    -- TIMEOUT: önekli claim'ler skora SAYILMAZ (finalize kuralı), yani
    -- yazan tarafa hiçbir avantaj sağlamaz. UNIQUE(room_id, country_code)
    -- + on conflict → iki istemci aynı anda çağırsa da tek satır.
    insert into public.duel_claims (room_id, player_id, country_code)
    values (p_room_id, p_player_id, v_timeout_code)
    on conflict do nothing;

    return v_room;                         -- oda satırı DEĞİŞMEDİ
  end if;

  -- ── AŞAMA 2: tur çözüldü. Reveal penceresi doldu mu? ───────────────────
  if v_resolved_at is null
     or v_now < v_resolved_at + make_interval(secs => v_delay_ms / 1000.0) then
    return v_room;                         -- not_due
  end if;

  v_in_golden := coalesce(v_room.is_golden_round, false)
                 and v_room.current_round > v_room.total_rounds;
  v_next_flag := public.flag_duel_next_flag(p_room_id, v_room.flag_sequence);

  -- ── ÇİFT PAS: tur sayacı ARTMAZ, yalnız bayrak ve saat yenilenir ───────
  if v_reason = 'both_passed' then
    if not v_in_golden then
      -- Pas kotası (istemcideki fresh-claims kontrolünün birebir karşılığı):
      -- iki oyuncunun da pas geçtiği, turu total_rounds'u aşmayan bayrak
      -- sayısı kotayı geçtiyse ilerletme.
      select count(*) into v_completed
        from (
          select split_part(c.country_code, ':', 3) as flag_code
            from public.duel_claims c
           where c.room_id = p_room_id
             and c.country_code ~ '^PASS:R[0-9]+:[^:]+:'
             and (substring(split_part(c.country_code, ':', 2) from 2))::int
                 <= v_room.total_rounds
           group by split_part(c.country_code, ':', 3)
          having count(distinct c.player_id) >= 2
        ) q;

      if v_completed > public.flag_duel_pass_quota(v_room.total_rounds) then
        return v_room;                     -- kota aşıldı → istemcideki gibi atla
      end if;
    end if;

    if v_next_flag is null then
      return v_room;                       -- havuz tükendi → dokunma
    end if;

    update public.duel_rooms
       set current_flag     = v_next_flag,
           current_flag_at  = v_now,
           winner_player_id = null,
           finished_reason  = null
     where id = p_room_id
       and status = 'playing'
       and current_round = p_expected_round
       and current_flag  = p_expected_flag  -- CAS kilidi UPDATE'te de var
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.duel_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- ── CEVAP / TIMEOUT: tur ilerler ───────────────────────────────────────
  v_next_round := v_room.current_round + 1;

  -- (a) Normal turlar bitti → skor eşitse altın tur, değilse maç sonu.
  if not v_in_golden and v_next_round > v_room.total_rounds then
    v_winner := public.flag_duel_score_winner(p_room_id);

    if v_winner is null then
      -- Beraberlik → altın tur (round+1, is_golden=true)
      if v_next_flag is null then
        return v_room;
      end if;
      update public.duel_rooms
         set current_round    = v_next_round,
             current_flag     = v_next_flag,
             current_flag_at  = v_now,
             is_golden_round  = true,
             winner_player_id = null,
             finished_reason  = null
       where id = p_room_id
         and status = 'playing'
         and current_round = p_expected_round
         and current_flag  = p_expected_flag
       returning * into v_room;
      if v_room.id is null then
        select * into v_room from public.duel_rooms where id = p_room_id;
      end if;
      return v_room;
    end if;

    -- Maç sonu. finished_at YAZILMAZ (kolon legacy şemada yok).
    update public.duel_rooms
       set status           = 'finished',
           finished_reason  = 'score',
           winner_player_id = v_winner
     where id = p_room_id
       and status = 'playing'
       and current_round = p_expected_round
       and current_flag  = p_expected_flag
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.duel_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- (b) Altın tur DOĞRU CEVAPLA bitti → maç sonu.
  if v_in_golden and v_reason = 'answered' then
    v_winner := public.flag_duel_score_winner(p_room_id);
    update public.duel_rooms
       set status           = 'finished',
           finished_reason  = 'score',
           winner_player_id = v_winner
     where id = p_room_id
       and status = 'playing'
       and current_round = p_expected_round
       and current_flag  = p_expected_flag
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.duel_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- (c) Sıradaki tur (altın turda TIMEOUT da buradan geçer → yeni altın tur).
  if v_next_flag is null then
    return v_room;
  end if;

  update public.duel_rooms
     set current_round    = v_next_round,
         current_flag     = v_next_flag,
         current_flag_at  = v_now,
         is_golden_round  = v_in_golden,
         winner_player_id = null,
         finished_reason  = null
   where id = p_room_id
     and status = 'playing'
     and current_round = p_expected_round
     and current_flag  = p_expected_flag
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.duel_rooms where id = p_room_id;
  end if;
  return v_room;
end;
$$;

-- ACL — AÇIK ve KASITLI.
-- `revoke all … from public` tek başına YETMEZ: Supabase'de public şemasında
-- doğan bir fonksiyon anon'a DOĞRUDAN EXECUTE ile gelir, PUBLIC üzerinden
-- değil. Burada anon'un çağırabilmesi ZATEN İSTENEN durumdur (Bayrak Düello'ya
-- misafir katılabilir ve host arka plandayken maçı kurtaran taraf odur), o
-- yüzden grant açıkça yazılır — varsayılan davranışa güvenilmez.
--
-- Misafirin bu fonksiyona erişebilmesi ona host yetkisi VERMEZ: gövdedeki
-- deadline + CAS kontrolleri yapabileceği tek şeyi "sunucunun zaten yapacağı
-- geçişi tetiklemek" ile sınırlar. Bayrağı seçemez (dizi persist edilmiştir),
-- kazananı söyleyemez (sunucu sayar), zamanı söyleyemez (sunucu okur).
revoke all     on function public.flag_duel_advance_if_due(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.flag_duel_advance_if_due(uuid, uuid, uuid, int, text) to anon, authenticated;

-- NOT: flag_duel_set_next_round / flag_duel_finalize_game ACL'leri ve
-- gövdeleri BİLİNÇLİ OLARAK DEĞİŞMEDİ. İstemci otomatik yolda artık onları
-- ÇAĞIRMAZ; canlıda bırakılmalarının sebebi, migration ile istemci dağıtımı
-- arasındaki pencerede eski sekmelerin hata almaması. İkisi de host-only
-- kaldığı için yeni bir yüzey açmazlar.


-- ============================================================================
-- DOĞRULAMA (Supabase Studio → SQL Editor) — SALT OKUNUR
-- ============================================================================
--
-- A) Kolon ve fonksiyonlar var, ACL doğru:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='duel_rooms'
--      and column_name='flag_sequence';
--
--   select p.proname, p.prosecdef, pg_catalog.array_to_string(p.proacl, E'\n')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.proname like 'flag_duel_%'
--    order by 1;
--   -- Beklenen: advance_if_due + set_flag_sequence → anon=X, authenticated=X;
--   --           next_flag / used_flag_codes / score_winner / *_ms / *_seconds
--   --           / pass_quota → anon ve authenticated YOK.
--
-- B) Süre DOLMADAN çağır → durum DEĞİŞMEMELİ:
--   select current_round, current_flag, current_flag_at from duel_rooms where id='<ODA>';
--   select public.flag_duel_advance_if_due('<ODA>','<OYUNCU>','<TOKEN>',
--            (select current_round from duel_rooms where id='<ODA>'),
--            (select current_flag  from duel_rooms where id='<ODA>'));
--   -- Beklenen: current_round / current_flag / current_flag_at AYNI kalır.
--
-- C) Başka odanın geçerli token'ı → reddedilmeli:
--   select public.flag_duel_advance_if_due('<BU_ODA>','<BASKA_ODA_OYUNCUSU>','<ONUN_TOKENI>',1,'TR');
--   -- Beklenen: ERROR 42501 not_a_member
--
-- D) Misafir bayrak sırasını YAZAMAZ (host değilse):
--   select public.flag_duel_set_flag_sequence('<ODA>','<MISAFIR>','<TOKEN>', array['TR','FR']);
--   -- Beklenen: ERROR 42501 unauthorized
-- ============================================================================
