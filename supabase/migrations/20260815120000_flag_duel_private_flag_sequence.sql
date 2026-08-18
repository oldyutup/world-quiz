-- ════════════════════════════════════════════════════════════════════════════
-- 20260815120000_flag_duel_private_flag_sequence.sql
--
-- P1 — BAYRAK DÜELLO SIRADAKİ BAYRAK SIZINTISI (İKİ KANAL)
--
-- ════════════════════════════════════════════════════════════════════════════
-- SORUN
-- ─────
-- 20260813130000 host-SPOF düzeltmesi maçın bayrak sırasını `duel_rooms`a
-- yazdı. `duel_rooms` DÜNYA-OKUNUR bir tablodur; bu yüzden sıra İKİ ayrı
-- kanaldan sızıyor:
--
--   A) REST     : anon `select=flag_sequence` gerçek diziyi döndürür.
--                 (canlı doğrulandı: ["az","it","ao","na","mv",...])
--   B) REALTIME : FlagDuelGame.tsx:1572 `duel_rooms` UPDATE'lerine abonedir.
--                 Payload TÜM satırı taşır → rakip hiç SELECT yapmadan diziyi
--                 alır.
--
-- NEDEN KOLON-BAZLI REVOKE ÇÖZÜM DEĞİL
-- ────────────────────────────────────
--   • Hem yayınlanmış App Store bundle'ı hem güncel istemci
--     `duel_rooms.select("*")` yapar (DuelGame.tsx:707/1394/1586,
--     FlagDuelGame.tsx:1197/1942). PostgREST `*`'ı TÜM kolonlara açar →
--     tek bir kolonda SELECT reddi HER İSTEMCİYİ 42501 ile kırar.
--   • Kolon ACL'i realtime payload'unu HİÇ etkilemez → (B) kanalı açık kalır.
--
-- Tek doğru çözüm: kolonu dünya-okunur tablodan ÇIKARMAK.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ÇÖZÜM — üç modda zaten canlıda olan PRIVATE-TABLO deseni
-- ────────────────────────────────────────────────────────
-- `flag_group_room_sequences` / `wheel_duel_room_sequences` /
-- `wheel_group_room_sequences` ile birebir aynı: hiçbir role grant YOK,
-- RLS açık, politika YOK, realtime publication DIŞI. (Canlı doğrulama:
-- üçü de anon VE authenticated için 42501 veriyor.)
--
-- ════════════════════════════════════════════════════════════════════════════
-- GERİYE UYUMLULUK
-- ────────────────
--   • `flag_duel_set_flag_sequence` — İMZA ve DÖNÜŞ TİPİ AYNI
--     (uuid, uuid, uuid, text[]) → public.duel_rooms. `create or replace`
--     grant'ları KORUR. İstemci yalnız `error`a bakar (FlagDuelGame.tsx:981).
--   • `flag_duel_advance_if_due` — İMZA ve DÖNÜŞ TİPİ AYNI. Gövdede TEK
--     değişiklik: `v_room.flag_sequence` yerine
--     `public.flag_duel_room_sequence(p_room_id)` (2 yerde).
--   • ESKİ İSTEMCİ HİÇ ETKİLENMEZ: yayınlanmış bundle `flag_sequence`
--     kolonunu ne yazar ne okur, `flag_duel_set_flag_sequence`i hiç çağırmaz;
--     legacy yolu (`flag_duel_set_next_round` / `flag_duel_finalize_game`)
--     bu migration'da DOKUNULMADAN kalır. `select("*")` bir kolon eksildiği
--     için kırılmaz.
--   • DROP edilen fonksiyon YOK, revoke edilen EXECUTE grant'ı YOK.
--
-- ════════════════════════════════════════════════════════════════════════════
-- CANLI VERİ RİSKİ
-- ────────────────
-- Denetim anında 357 `duel_rooms` satırından yalnız 4'ünde dizi doluydu ve
-- DÖRDÜ DE `status='finished'`. `status='playing'` olan 20 odanın HEPSİNDE
-- dizi NULL'dı (hepsi terk edilmiş; maç süresi 60 sn). Yine de kopyalama
-- adımı KOŞULSUZ çalışır ve birebir eşitlik assert edilir → dizisi olan bir
-- maç varsa kesintisiz devam eder.
-- ════════════════════════════════════════════════════════════════════════════


-- ── ÖN KOŞUL ─────────────────────────────────────────────────────────────
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.flag_duel_advance_if_due(uuid,uuid,uuid,integer,text)',
    'public.flag_duel_set_flag_sequence(uuid,uuid,uuid,text[])',
    'public.flag_duel_next_flag(uuid,text[])',
    'public.flag_duel_used_flag_codes(uuid)',
    'public.flag_duel_authorize_host(uuid,uuid,uuid)',
    'public.flag_duel_authorize_player(uuid,uuid)',
    'public.flag_duel_score_winner(uuid)',
    'public.flag_duel_pass_quota(integer)'
  ] loop
    if to_regprocedure(v_sig) is null then
      raise exception 'ÖN KOŞUL EKSİK: % bulunamadı', v_sig;
    end if;
  end loop;

  if to_regclass('public.duel_rooms') is null then
    raise exception 'ÖN KOŞUL EKSİK: public.duel_rooms yok';
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- 1) PRIVATE SIRA TABLOSU
--
-- 20260808 DERSİ: schema public'te doğan her tablo Supabase'in ALTER DEFAULT
-- PRIVILEGES'ı yüzünden anon/authenticated'a DOĞRUDAN grant'la doğar.
-- "revoke from public" bunu KALDIRMAZ — üç rol de açıkça yazılır.
-- Politika YOK + RLS açık = grant bir şekilde geri gelse bile satır görünmez.
-- Publication'a EKLENMEZ.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.flag_duel_room_sequences (
  room_id       uuid primary key
                references public.duel_rooms(id) on delete cascade,
  flag_sequence text[]      not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.flag_duel_room_sequences enable row level security;

revoke all on table public.flag_duel_room_sequences from anon;
revoke all on table public.flag_duel_room_sequences from authenticated;
revoke all on table public.flag_duel_room_sequences from public;


-- ════════════════════════════════════════════════════════════════════════════
-- 2) SUNUCU-İÇİ OKUYUCU
--    anon/authenticated'a KAPALI; yalnız SECURITY DEFINER çağrılardan erişilir.
--    (flag_duel_next_flag / flag_duel_used_flag_codes ile aynı desen.)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.flag_duel_room_sequence(p_room_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select s.flag_sequence
    from public.flag_duel_room_sequences s
   where s.room_id = p_room_id;
$$;

revoke all     on function public.flag_duel_room_sequence(uuid) from public;
revoke execute on function public.flag_duel_room_sequence(uuid) from anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) KOPYALAMA — uçuştaki maçlar kesintisiz kalsın
--    Kolon henüz duruyorsa çalışır (idempotent yeniden koşuma dayanıklı).
--    Birebir eşitlik assert edilir; tek satır bile eşleşmezse migration DURUR.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_has_col boolean;
  v_src     int := 0;
  v_bad     int := 0;
begin
  select exists (
    select 1 from pg_attribute
     where attrelid = 'public.duel_rooms'::regclass
       and attname = 'flag_sequence' and attnum > 0 and not attisdropped
  ) into v_has_col;

  if not v_has_col then
    raise notice 'duel_rooms.flag_sequence zaten yok — kopyalama atlandı (idempotent).';
    return;
  end if;

  execute $q$
    insert into public.flag_duel_room_sequences (room_id, flag_sequence)
    select r.id, r.flag_sequence
      from public.duel_rooms r
     where r.flag_sequence is not null
       and cardinality(r.flag_sequence) > 0
    on conflict (room_id) do nothing
  $q$;

  execute $q$
    select count(*) from public.duel_rooms r
     where r.flag_sequence is not null and cardinality(r.flag_sequence) > 0
  $q$ into v_src;

  execute $q$
    select count(*) from public.duel_rooms r
     where r.flag_sequence is not null and cardinality(r.flag_sequence) > 0
       and not exists (
         select 1 from public.flag_duel_room_sequences s
          where s.room_id = r.id and s.flag_sequence = r.flag_sequence)
  $q$ into v_bad;

  if v_bad > 0 then
    raise exception 'KOPYALAMA HATALI: % satır birebir eşleşmedi', v_bad;
  end if;

  perform set_config('torble.m1_copied', v_src::text, false);
  raise notice 'Kopyalandı ve birebir doğrulandı: % satır', v_src;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- 4) flag_duel_set_flag_sequence — GÖVDE 20260813130000'DEN BYTE-SADIK,
--    TEK DEĞİŞİKLİK: duel_rooms UPDATE'i yerine private tabloya UPSERT.
--    İmza / dönüş tipi / SECURITY DEFINER / search_path / doğrulama zinciri
--    ve FOR UPDATE oda kilidi AYNEN korunur.
-- ════════════════════════════════════════════════════════════════════════════
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

  -- Dizi ARTIK duel_rooms'ta DEĞİL: dünya-okunur oda satırından çıkarıldı ve
  -- yalnız sunucunun görebildiği flag_duel_room_sequences'a yazılır.
  -- Yukarıdaki FOR UPDATE oda kilidi KORUNUR → advance_if_due ile yarış yok.
  insert into public.flag_duel_room_sequences (room_id, flag_sequence)
  values (p_room_id, p_flag_sequence)
      on conflict (room_id) do update
         set flag_sequence = excluded.flag_sequence,
             updated_at    = now();

  return v_room;
end;
$$;

-- ACL — 20260813130000'deki ile BİREBİR AYNI (create or replace zaten korur;
-- determinizm için açıkça yazılır).
revoke all     on function public.flag_duel_set_flag_sequence(uuid, uuid, uuid, text[]) from public;
grant  execute on function public.flag_duel_set_flag_sequence(uuid, uuid, uuid, text[]) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 5) flag_duel_advance_if_due — GÖVDE 20260813130000'DEN BYTE-SADIK,
--    TEK DEĞİŞİKLİK: `v_room.flag_sequence` → `public.flag_duel_room_sequence(p_room_id)`
--    (2 yerde: 4b ONARIM dalı ve AŞAMA 2 ilerletme dalı).
--
--    NEDEN GEREKLİ: PL/pgSQL kayıt alanlarını ÇALIŞMA ZAMANINDA çözer.
--    Kolon düşürülürse eski gövde `record "v_room" has no field
--    "flag_sequence"` ile patlardı.
-- ════════════════════════════════════════════════════════════════════════════
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
    v_next_flag := public.flag_duel_next_flag(p_room_id, public.flag_duel_room_sequence(p_room_id));
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
  v_next_flag := public.flag_duel_next_flag(p_room_id, public.flag_duel_room_sequence(p_room_id));

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

-- ACL — 20260813130000'deki ile BİREBİR AYNI.
revoke all     on function public.flag_duel_advance_if_due(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.flag_duel_advance_if_due(uuid, uuid, uuid, int, text) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 6) KOLONU DÜŞÜR — iki sızıntı kanalını birden kapatır
--    • REST  : kolon yoksa select("*") onu döndüremez
--    • REALTIME: kolon yoksa UPDATE payload'unda yer almaz
--    select("*") yapan istemciler bir kolon eksildiği için KIRILMAZ.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.duel_rooms drop column if exists flag_sequence;


-- ════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_fail   text := '';
  v_copied int  := coalesce(nullif(current_setting('torble.m1_copied', true), ''), '0')::int;
  v_now    int;
  v_priv   text;
begin
  -- (a) kolon gerçekten gitti mi
  if exists (
    select 1 from pg_attribute
     where attrelid = 'public.duel_rooms'::regclass
       and attname = 'flag_sequence' and attnum > 0 and not attisdropped
  ) then
    v_fail := v_fail || ' [duel_rooms.flag_sequence HÂLÂ VAR]';
  end if;

  -- (b) veri korundu mu
  select count(*) into v_now from public.flag_duel_room_sequences;
  if v_now < v_copied then
    v_fail := v_fail || format(' [veri kaybı: kopyalanan=%s, şimdi=%s]', v_copied, v_now);
  end if;

  -- (c) yeni tablo hiçbir istemci rolüne açık olmamalı
  foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
    if has_table_privilege('anon', 'public.flag_duel_room_sequences', v_priv) then
      v_fail := v_fail || format(' [yeni tablo anon %s AÇIK]', v_priv);
    end if;
    if has_table_privilege('authenticated', 'public.flag_duel_room_sequences', v_priv) then
      v_fail := v_fail || format(' [yeni tablo authenticated %s AÇIK]', v_priv);
    end if;
  end loop;

  -- (d) RLS açık, politika yok
  if not (select relrowsecurity from pg_class where oid = 'public.flag_duel_room_sequences'::regclass) then
    v_fail := v_fail || ' [yeni tabloda RLS KAPALI]';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.flag_duel_room_sequences'::regclass) then
    v_fail := v_fail || ' [yeni tabloda politika VAR — olmamalı]';
  end if;

  -- (e) realtime publication DIŞINDA
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'flag_duel_room_sequences'
  ) then
    v_fail := v_fail || ' [yeni tablo REALTIME PUBLICATION İÇİNDE]';
  end if;

  -- (f) okuyucu helper istemciye kapalı
  if has_function_privilege('anon', 'public.flag_duel_room_sequence(uuid)', 'EXECUTE')
  or has_function_privilege('authenticated', 'public.flag_duel_room_sequence(uuid)', 'EXECUTE') then
    v_fail := v_fail || ' [flag_duel_room_sequence istemciye AÇIK]';
  end if;

  -- (g) İSTEMCİ YÜZEYİ KORUNDU: iki RPC de anon+authenticated'a açık kalmalı
  foreach v_priv in array array[
    'public.flag_duel_set_flag_sequence(uuid,uuid,uuid,text[])',
    'public.flag_duel_advance_if_due(uuid,uuid,uuid,integer,text)'
  ] loop
    if not has_function_privilege('anon', v_priv, 'EXECUTE')
    or not has_function_privilege('authenticated', v_priv, 'EXECUTE') then
      v_fail := v_fail || format(' [%s grant KAYBOLDU]', v_priv);
    end if;
  end loop;

  -- (h) ESKİ İSTEMCİ YOLU DOKUNULMADAN DURUYOR
  foreach v_priv in array array[
    'public.flag_duel_set_next_round',
    'public.flag_duel_finalize_game',
    'public.flag_duel_start_game',
    'public.flag_duel_submit_claim',
    'public.flag_duel_leave_room'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = split_part(v_priv, '.', 2)
         and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      v_fail := v_fail || format(' [ESKİ İSTEMCİ RPC kayıp/anon kapalı: %s]', v_priv);
    end if;
  end loop;

  -- (i) gövdelerde artık kolona atıf kalmamalı
  if position('v_room.flag_sequence' in
              pg_get_functiondef(to_regprocedure('public.flag_duel_advance_if_due(uuid,uuid,uuid,integer,text)'))) > 0 then
    v_fail := v_fail || ' [advance_if_due HÂLÂ v_room.flag_sequence okuyor]';
  end if;
  if position('flag_duel_room_sequence(p_room_id)' in
              pg_get_functiondef(to_regprocedure('public.flag_duel_advance_if_due(uuid,uuid,uuid,integer,text)'))) = 0 then
    v_fail := v_fail || ' [advance_if_due private okuyucuyu KULLANMIYOR]';
  end if;
  if position('flag_duel_room_sequences' in
              pg_get_functiondef(to_regprocedure('public.flag_duel_set_flag_sequence(uuid,uuid,uuid,text[])'))) = 0 then
    v_fail := v_fail || ' [set_flag_sequence private tabloya YAZMIYOR]';
  end if;

  if v_fail <> '' then
    raise exception 'M1 DOĞRULAMA BAŞARISIZ:%', v_fail;
  end if;

  raise notice 'OK: flag_sequence private tabloya taşındı (% satır), duel_rooms''tan düşürüldü; REST + realtime sızıntı kanallarının İKİSİ de kapandı; istemci yüzeyi ve eski istemci yolu değişmedi.', v_copied;
end $$;
