-- ============================================================================
-- Çark Düello — host-background SPOF'u kaldır: wheel_duel_advance_if_due
-- ============================================================================
-- SORUN
-- -----
-- Maçın ilerlemesini SADECE host'un tarayıcısı yürütüyor. WheelDuelGame.tsx'te
-- DÖRT ayrı host-only yol var; host arka plana düşünce (mobilde sekme değişimi,
-- ekran kilidi) timer'lar kısılır/durur ve maç HER İKİ oyuncu için de kilitlenir:
--
--   1. SIRADAKİ HEDEF      — L770-786 `if (!isHost) return;` + FEEDBACK_MS
--      timeout → `pickNextTarget()`. Doğru cevaptan sonra oda
--      `current_target_topoid = null` durumunda ASILI KALIR; kimse tıklayamaz.
--   2. MAÇ SONU            — L801-869 host-only interval, `started_at + duration`
--      dolunca `finishGame("timeout")`. Host yoksa maç HİÇ bitmez; süre
--      göstergesi 0'da kalır, sonuç ekranı açılmaz, XP yazılmaz.
--   3. PAS/SKIP            — L1173-1188 host-only effect → `wheel_duel_process_skip`.
--      İki oyuncu da pas oyu verse bile host yoksa hedef atlanmaz.
--   4. HAVUZ TÜKENMESİ     — `pickNextTarget` içinden `finishGame("pool")`.
--
-- Sunucu tarafında da simetrik durum: `wheel_duel_pick_target`,
-- `wheel_duel_process_skip` ve `wheel_duel_finish_game` HEPSİ
-- `wheel_duel_authorize_host` ile korunuyor → host olmayan üye bu geçişlerin
-- HİÇBİRİNİ tetikleyemiyor.
--
-- BAYRAK DÜELLO'DAN FARKI (neden birebir kopya değil)
-- ---------------------------------------------------
-- Bayrak'ta sıradaki bayrak host'un RAM'indeki `Math.random`'dan geliyordu ve
-- hiçbir istemci onu yeniden üretemiyordu. Çark'ta `used_target_topoids` ZATEN
-- sunucuda persist ediliyor ve havuz `region`dan türetilebiliyor — ama
-- `pickProgressionTopoId` yine rastgele seçim yapıyor, yani "sıradaki hedef"
-- deterministik DEĞİL. Ayrıca `wheel_duel_pick_target` p_target'ı HİÇBİR
-- havuza karşı DOĞRULAMIYOR (herhangi bir metni kabul ediyor).
-- Dolayısıyla "pick_target'ı herkese aç" YANLIŞ çözümdür: hile yüzeyini
-- host'tan tüm oyunculara genişletir (istenen hedefi seçme, kolay hedefleri
-- tekrarlama). Bunun yerine Bayrak'taki desen uygulanır: SIRA MAÇ BAŞINDA
-- PERSIST EDİLİR, sonraki hedefi SUNUCU o diziden çeker; istemci hedef öneremez.
--
-- ÇÖZÜM
-- -----
--   • `wheel_duel_rooms.target_sequence text[]` (nullable): host maç BAŞLARKEN
--     (kesin ayaktayken) sıranın tamamını bir kez yazar.
--   • `wheel_duel_advance_if_due(...)`: odanın HER ÜYESİ çağırabilir. Sunucu
--     kilitli satırdan okuduğu veriyle karar verir; istemci ne zaman ne hedef
--     iddia edebilir.
--
-- YETKİ GENİŞLEMESİ YOKTUR — çünkü sunucu:
--   • deadline'ı KİLİTLİ oda satırından okur (`started_at + duration_seconds`,
--     refill için `updated_at + feedback_delay`), istemcinin saati karara girmez;
--   • sıradaki hedefi persist edilmiş `target_sequence`ten seçer;
--   • kazananı `wheel_duel_score_winner` ile kendi hesaplar (finish_game ile
--     BİREBİR aynı kural);
--   • pas eşiğini `pass_requested_by` dizisinden kendi sayar.
-- Rakibin yaptırabildiği tek geçiş, sunucunun o an zaten yapacağı geçiştir.
--
-- REFILL SAATİNİN ÇIPASI: `updated_at`
--   `wheel_duel_claim_target` / `process_skip` hedefi null'a çekerken oda
--   satırını UPDATE ediyor → `wheel_duel_rooms_set_updated_at` BEFORE UPDATE
--   trigger'ı `updated_at = now()` yazıyor (20260514120000). Yani "hedef ne
--   zaman temizlendi" bilgisi ZATEN sunucu verisi. `updated_at >= temizlenme
--   anı` her zaman doğru olduğu için refill ASLA erken tetiklenemez; en kötü
--   ihtimalle birkaç yüz ms GEÇ olur (güvenli yön).
--
-- DEĞİŞMEYEN DAVRANIŞLAR
-- ----------------------
--   • Mevcut host-only RPC'lerin (pick_target / process_skip / finish_game)
--     gövdesi, imzası ve ACL'i DEĞİŞMEDİ. Eski sekmeler hata almaz; host
--     ayaktayken akış bugünküyle aynı hisseder.
--   • Zorluk eğrisi: yazılan dizi aynı `buildProgressionQueue` çıktısıdır
--     (tier dağılımı, bölge filtresi, rampa uzunluğu aynı).
--   • Skor, claim, pas oyu semantiği; XP; rematch akışı (ayrı RPC).
--   • wheel_group_* tarafına HİÇ dokunulmadı (ayrı migration).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) wheel_duel_rooms.target_sequence — maçın hedef sırası
-- ----------------------------------------------------------------------------
-- Nullable ve DEFAULT YOK: dizisi olmayan ESKİ odalar bugünkü gibi çalışmaya
-- devam eder (advance_if_due refill yapamaz, host yolu aynen durur).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.wheel_duel_rooms
  add column if not exists target_sequence text[];


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Zaman sabiti — istemci ile TEK KAYNAK eşleşmesi
-- ----------------------------------------------------------------------------
-- WheelDuelGame.tsx `FEEDBACK_MS = 1200`. Sunucu ile istemci aynı değeri
-- kullanmalı; drift testi scripts/check-wheel-advance-if-due.ts içinde kilitli.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_feedback_delay_ms()
returns int language sql immutable as $$ select 1200 $$;

revoke all on function public.wheel_duel_feedback_delay_ms() from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) wheel_duel_next_target — persist edilmiş diziden sıradaki hedef
-- ----------------------------------------------------------------------------
-- Dizideki İLK oynanmamış hedef. `used_target_topoids` hem doğru cevabı hem
-- pas geçileni içerdiği için (claim_target / process_skip ikisi de append
-- ediyor) bu tek kaynak yeterlidir. Dizi yoksa/bittiyse NULL → çağıran havuz
-- tükenmesi olarak yorumlar.
-- İç helper: anon/authenticated EXECUTE'u AÇIKÇA geri alınır (public şemadaki
-- yeni fonksiyonlar anon'a doğrudan EXECUTE ile doğar — bkz. 20260809130000).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_next_target(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select s.topoid
    from public.wheel_duel_rooms r
    cross join lateral unnest(coalesce(r.target_sequence, '{}'::text[]))
         with ordinality as s(topoid, ord)
   where r.id = p_room_id
     and s.topoid is not null
     and s.topoid <> ''
     and not (s.topoid = any (coalesce(r.used_target_topoids, '{}'::text[])))
     and s.topoid is distinct from r.current_target_topoid
   order by s.ord
   limit 1;
$$;

revoke all on function public.wheel_duel_next_target(uuid) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) wheel_duel_score_winner — otoriter kazanan (finish_game ile AYNI kural)
-- ----------------------------------------------------------------------------
-- 20260529120000'deki `wheel_duel_finish_game` gövdesinden BİREBİR çıkarıldı:
--   • 0 oyuncu            → null
--   • 1 oyuncu            → o oyuncu
--   • 2+ ve tepe skorlar EŞİT → null (beraberlik)
--   • aksi halde          → en yüksek skor (eşitlikte joined_at asc)
-- Ayrı helper olmasının sebebi: advance_if_due'nun ürettiği sonucun mevcut
-- finish_game ile AYNI olduğu tek bir yerden okunabilsin ve testte eşdeğerlik
-- olarak assert edilebilsin.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_score_winner(p_room_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_count     int;
  v_top_score int;
  v_second    int;
  v_winner_id uuid;
begin
  select count(*) into v_count
    from public.wheel_duel_players where room_id = p_room_id;

  if v_count = 0 then
    return null;
  elsif v_count = 1 then
    select id into v_winner_id
      from public.wheel_duel_players
     where room_id = p_room_id
     limit 1;
    return v_winner_id;
  end if;

  select score into v_top_score
    from public.wheel_duel_players
   where room_id = p_room_id
   order by score desc, joined_at asc
   limit 1;

  select score into v_second
    from public.wheel_duel_players
   where room_id = p_room_id
   order by score desc, joined_at asc
   offset 1 limit 1;

  if v_top_score is null or v_second is null or v_top_score = v_second then
    return null;                                   -- beraberlik
  end if;

  select id into v_winner_id
    from public.wheel_duel_players
   where room_id = p_room_id
   order by score desc, joined_at asc
   limit 1;
  return v_winner_id;
end;
$$;

revoke all on function public.wheel_duel_score_winner(uuid) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) wheel_duel_set_target_sequence — maçın hedef sırasını persist et
-- ----------------------------------------------------------------------------
-- HOST-ONLY: bugün de hedefi fiilen host seçiyor, yetki genişlemesi YOK.
-- Maç başlarken (host kesin ayaktayken) BİR KEZ çağrılır.
--
-- Kısıtlar (kaçak veri kanalı olmasın diye):
--   • 1..512 eleman            → 'sequence_invalid'  (22023)
--   • NULL/boş eleman YASAK    → 'sequence_invalid'  (22023)
--   • tekrar eden eleman YASAK → 'sequence_duplicate'(22023)
-- NOT: NULL kontrolü tekrar kontrolünden ÖNCE gelir — `count(distinct)` NULL
-- saymaz, yani ['TUR', null] yanlışlıkla "duplicate" raporlanırdı.
--
-- Idempotent: aynı maçta ikinci çağrı diziyi TAZELER (status='playing' iken de
-- izinli) — host yeniden bağlanıp tekrar yazarsa zarar vermez. `used` dizisi
-- filtrelendiği için oynanmış hedefler geri gelmez.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_set_target_sequence(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_targets        text[]
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_len      int;
  v_distinct int;
begin
  if not public.wheel_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  v_len := coalesce(array_length(p_targets, 1), 0);
  if v_len = 0 or v_len > 512 then
    raise exception 'sequence_invalid' using errcode = '22023';
  end if;

  -- Önce NULL/boş, SONRA tekrar (sıra kritik — yukarıdaki nota bak).
  if exists (
    select 1 from unnest(p_targets) as t(x)
     where t.x is null or length(btrim(t.x)) = 0
  ) then
    raise exception 'sequence_invalid' using errcode = '22023';
  end if;

  select count(distinct x) into v_distinct from unnest(p_targets) as t(x);
  if v_distinct <> v_len then
    raise exception 'sequence_duplicate' using errcode = '22023';
  end if;

  update public.wheel_duel_rooms
     set target_sequence = p_targets
   where id = p_room_id
     and status in ('waiting', 'playing');
end;
$$;

revoke all     on function public.wheel_duel_set_target_sequence(uuid, uuid, uuid, text[]) from public;
grant  execute on function public.wheel_duel_set_target_sequence(uuid, uuid, uuid, text[]) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) wheel_duel_advance_if_due — vadesi geldiyse ilerlet, gelmediyse hiçbir şey
-- ----------------------------------------------------------------------------
-- Kontrol sırası (3'ten itibaren hepsi FOR UPDATE satır kilidi ALTINDA):
--   1. Kimlik  — wheel_duel_authorize_player (kayıtlı: JWT; misafir: claim_token)
--   2. Üyelik  — o oyuncu satırı BU odada mı? (başka odanın geçerli token'ı bu
--                odayı ilerletemez)
--   3. Kilit   — select … for update
--   4. Durum   — oda 'playing' mi?
--   5. FAZLAR  — aşağıdaki otomat
--
-- OTOMAT (istemcideki dört host-only yolun birebir karşılığı):
--   FAZ 1 — MAÇ SONU: now() >= started_at + duration_seconds
--           → finished + winner (score_winner) + reason 'timeout'.
--           CAS'TAN ÖNCE gelir: deadline mutlaktır, çağıranın hangi hedefi
--           gördüğü önemsizdir. Bayat bir istemci de biten maçı kapatabilmeli.
--   FAZ 2 — CAS: çağıranın gördüğü hedef hâlâ aktif mi? Değilse no-op.
--   FAZ 3 — SKIP: pas eşiği (>=2 oy, oylar MEVCUT hedefe ait) dolduysa hedefi
--           used'e ekleyip temizle. (Bugün host-only process_skip yapıyor.)
--   FAZ 4 — REFILL: hedef null ve now() >= updated_at + feedback_delay
--           → diziden sıradaki hedef. Dizi bittiyse → finished + reason 'pool'.
--
-- 4-6 arasındaki her ret "zararsız no-op"tur: exception DEĞİL, DEĞİŞMEMİŞ oda
-- satırı döner. Faydası: (a) yarışı kaybeden çağıran hata toast'u görmez,
-- (b) bayat istemci aynı gidiş-dönüşte TAZE odayı alır, kendi kendini onarır.
--
-- ÇİFT İLERLEME NEDEN İMKÂNSIZ: iki istemci aynı anda çağırsa `for update`
-- onları seri hâle getirir; READ COMMITTED altında ikinci çağıran birincinin
-- commit'inden sonra GÜNCELLENMİŞ satırı okur, CAS/guard artık tutmaz ve no-op
-- döner. Ayrıca her UPDATE kendi guard'ını taşır (status='playing' +
-- current_target_topoid CAS'ı), yani kilit olmasa bile çift yazma engellenir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_advance_if_due(
  p_room_id         uuid,
  p_player_id       uuid,
  p_claim_token     uuid,
  p_expected_target text
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.wheel_duel_rooms;
  v_now        timestamptz := now();
  v_next       text;
  v_winner     uuid;
  v_pass_count int;
begin
  -- 1) Kimlik. Kayıtlıda auth.uid(), misafirde claim_token tek kanıttır.
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- 2) Üyelik. Bu şart olmadan BAŞKA bir odadaki geçerli bir claim_token bu
  --    odayı ilerletebilirdi.
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  -- 3) Satır kilidi — bundan sonraki her okuma kanonik ve yarışsızdır.
  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- 4) Maç aktif değilse sessizce çık (lobi / bitmiş maç).
  if v_room.status <> 'playing' then
    return v_room;
  end if;

  -- ── FAZ 1: MAÇ SONU ────────────────────────────────────────────────────
  -- DEADLINE OTORİTESİ: started_at + duration_seconds KİLİTLİ satırdan okunur;
  -- istemci süre/zaman parametresi GÖNDEREMEZ. Kasıtlı olarak CAS'tan ÖNCE:
  -- süresi dolmuş maç, çağıranın hangi hedefi gördüğünden bağımsız kapanmalı.
  if v_room.started_at is not null
     and v_now >= v_room.started_at + make_interval(secs => v_room.duration_seconds)
  then
    v_winner := public.wheel_duel_score_winner(p_room_id);
    update public.wheel_duel_rooms
       set status                = 'finished',
           finished_at           = v_now,
           finished_reason       = 'timeout',
           winner_player_id      = v_winner,
           current_target_topoid = null
     where id = p_room_id
       and status = 'playing'                    -- CAS: çift finalize yok
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.wheel_duel_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- ── FAZ 2: CAS ─────────────────────────────────────────────────────────
  -- Çağıranın ilerlettiğini sandığı hedef hâlâ aktif mi? (NULL da geçerli bir
  -- beklentidir: "hedef yok, refill sırası" demektir.)
  if v_room.current_target_topoid is distinct from p_expected_target then
    return v_room;
  end if;

  -- ── FAZ 3: SKIP (pas eşiği) ────────────────────────────────────────────
  -- Bugün host-only `wheel_duel_process_skip` yapıyor. Guard'lar birebir aynı.
  if v_room.current_target_topoid is not null
     and v_room.pass_target_topoid is not distinct from v_room.current_target_topoid
  then
    select coalesce(array_length(v_room.pass_requested_by, 1), 0) into v_pass_count;
    if v_pass_count >= 2 then
      update public.wheel_duel_rooms
         set used_target_topoids   = array_append(
                                       coalesce(used_target_topoids, '{}'::text[]),
                                       current_target_topoid),
             current_target_topoid = null,
             pass_requested_by     = '{}',
             pass_target_topoid    = null
       where id = p_room_id
         and status = 'playing'
         and current_target_topoid = v_room.current_target_topoid   -- CAS
       returning * into v_room;
      if v_room.id is null then
        select * into v_room from public.wheel_duel_rooms where id = p_room_id;
      end if;
      return v_room;
    end if;
  end if;

  -- Hedef hâlâ aktif ve pas eşiği dolmadı → yapacak bir şey yok.
  -- (Çark'ta hedef başına süre sınırı YOKTUR; tek saat maç saatidir.)
  if v_room.current_target_topoid is not null then
    return v_room;
  end if;

  -- ── FAZ 4: REFILL ──────────────────────────────────────────────────────
  -- Hedef null. Geri bildirim penceresi (FEEDBACK_MS) dolmuş mu?
  -- Çıpa `updated_at`: hedefi null'a çeken UPDATE'in server-side damgası.
  if v_room.updated_at is not null
     and v_now < v_room.updated_at
                 + make_interval(secs => public.wheel_duel_feedback_delay_ms() / 1000.0)
  then
    return v_room;                                -- not_due
  end if;

  v_next := public.wheel_duel_next_target(p_room_id);

  if v_next is null then
    -- Dizi yok (eski oda) VEYA havuz tükendi.
    -- Dizi HİÇ yazılmamışsa maçı bitirmek YANLIŞ olurdu (host yolu hâlâ
    -- çalışıyor olabilir) → yalnız dizi VARSA 'pool' ile bitir.
    if v_room.target_sequence is null then
      return v_room;
    end if;
    v_winner := public.wheel_duel_score_winner(p_room_id);
    update public.wheel_duel_rooms
       set status                = 'finished',
           finished_at           = v_now,
           finished_reason       = 'pool',
           winner_player_id      = v_winner,
           current_target_topoid = null
     where id = p_room_id
       and status = 'playing'
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.wheel_duel_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  update public.wheel_duel_rooms
     set current_target_topoid = v_next,
         pass_requested_by     = '{}',
         pass_target_topoid    = null
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid is null            -- CAS: yarışı kaybeden yazmaz
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.wheel_duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_advance_if_due(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_advance_if_due(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) wheel_duel_process_rematch_if_ready — rövanş SPOF'u
-- ----------------------------------------------------------------------------
-- `processRematch` (WheelDuelGame.tsx L1273-1285) da host-only: iki oyuncu da
-- rövanş oyu verse bile host sonuç ekranında sekmeyi kapattıysa yeni maç HİÇ
-- başlamaz. Bayrak Düello'da bu backlog'a bırakılmıştı çünkü `duel_rooms`ta
-- `rematch_requested_by` kolonu YOK; Çark Düello'da VAR (20260516120000), yani
-- burada eşik zaten sunucuda sayılabiliyor.
--
-- Bu RPC mevcut `wheel_duel_process_rematch`i DEĞİŞTİRMEZ; yanına konur ve
-- yalnız EŞİK DOLMUŞSA aynı reset'i uygular. Yetki genişlemesi yok: sunucu
-- oyların sayısını kendi sayar, çağıran "rövanş başlasın" diye zorlayamaz.
-- match_seq / current_match_id rotasyonu process_rematch ile AYNI (XP
-- idempotency anahtarı sunucuda üretilir).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_process_rematch_if_ready(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_duel_rooms;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Yalnız bitmiş maç + eşik dolmuş olmalı.
  if v_room.status <> 'finished'
     or coalesce(array_length(v_room.rematch_requested_by, 1), 0) < 2 then
    return v_room;
  end if;

  update public.wheel_duel_players
     set score = 0
   where room_id = p_room_id;

  update public.wheel_duel_rooms
     set status                = 'waiting',
         started_at            = null,
         finished_at           = null,
         finished_reason       = null,
         winner_player_id      = null,
         current_target_topoid = null,
         used_target_topoids   = '{}',
         target_sequence       = null,
         pass_requested_by     = '{}',
         pass_target_topoid    = null,
         rematch_requested_by  = '{}',
         -- XP IDEMPOTENCY: process_rematch ile BİREBİR aynı rotasyon. Bu iki
         -- satır olmadan yeni maç eski current_match_id ile oynanır ve
         -- xp_events UNIQUE(profile_id, mode_key, room_id) yüzünden rövanşın
         -- XP'si SESSİZCE düşer. Anahtar SUNUCUDA üretilir (istemci veremez).
         match_seq             = coalesce(match_seq, 1) + 1,
         current_match_id      = gen_random_uuid()
   where id = p_room_id
     and status = 'finished'                      -- CAS: çift reset yok
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.wheel_duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_process_rematch_if_ready(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_process_rematch_if_ready(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
