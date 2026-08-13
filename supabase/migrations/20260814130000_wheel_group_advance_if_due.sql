-- ============================================================================
-- Çark Grup — host-background SPOF'u kaldır: wheel_group_advance_if_due
-- ============================================================================
-- SORUN
-- -----
-- Çark Düello ile AYNI kök neden, ama Çark Grup'ta etki daha büyük: odada 3-10
-- oyuncu var ve TEK bir kişinin (host) sekmesi arka plana düşünce HERKES
-- kilitleniyor. WheelGroupGame.tsx'te İKİ host-only yol var:
--
--   1. SIRADAKİ HEDEF — L951-962 `if (!isHost) return;` + FEEDBACK_MS timeout
--      → `pickNextTarget()`. Doğru cevaptan (veya pas eşiğinden) sonra oda
--      `current_target_topoid = null` durumunda ASILI KALIR.
--   2. MAÇ SONU       — L967-998 host-only interval, `started_at + duration`
--      dolunca `finishGame("timeout")`. Host yoksa maç HİÇ bitmez; sonuç
--      tablosu açılmaz, XP yazılmaz.
--   (+ havuz tükenmesi `pickNextTarget` içinden `finishGame("pool")`.)
--
-- ÇARK DÜELLO'DAN FARKI — PAS ZATEN SUNUCUDA
-- ------------------------------------------
-- `wheel_group_vote_pass` (20260703120000) eşiği KENDİ sayıyor ve dolunca
-- `current_target_topoid`i AYNI RPC içinde null'a çekiyor. Yani Çark Grup'ta
-- pas yolu host'a bağlı DEĞİL — bu migration pas mantığına DOKUNMAZ.
-- Geriye kalan tek SPOF "hedefi kim yeniler" ve "maçı kim bitirir".
--
-- Ayrıca `wheel_group_rooms`ta `winner_player_id` KOLONU YOKTUR (grup modunda
-- kazanan yerine skor tablosu var) → advance_if_due kazanan HESAPLAMAZ;
-- `wheel_group_finish_game` ne yazıyorsa birebir aynısını yazar.
--
-- ÇÖZÜM (Çark Düello migration'ı 20260814120000 ile simetrik)
-- ----------------------------------------------------------
--   • `wheel_group_rooms.target_sequence text[]`: host maç BAŞLARKEN sıranın
--     tamamını bir kez yazar.
--   • `wheel_group_advance_if_due(...)`: odanın HER ÜYESİ çağırabilir.
--
-- YETKİ GENİŞLEMESİ YOKTUR — sunucu deadline'ı kilitli satırdan okur, sıradaki
-- hedefi persist edilmiş diziden çeker (istemci hedef öneremez), her UPDATE
-- kendi CAS guard'ını taşır.
--
-- REFILL SAATİNİN ÇIPASI: `updated_at`
--   `wheel_group_claim_target` ve `wheel_group_vote_pass` hedefi null'a
--   çekerken oda satırını UPDATE ediyor → `wheel_group_rooms_set_updated_at`
--   trigger'ı `updated_at = now()` yazıyor (20260518120000). `updated_at >=
--   temizlenme anı` her zaman doğru olduğu için refill ASLA erken tetiklenemez.
--
-- DEĞİŞMEYEN DAVRANIŞLAR
-- ----------------------
--   • pick_target / finish_game / vote_pass / claim_target / return_to_lobby
--     gövdesi, imzası ve ACL'i DEĞİŞMEDİ.
--   • Zorluk eğrisi: dizi aynı `buildProgressionQueue` çıktısıdır.
--   • match_seq / current_match_id rotasyonu yalnız start_game'de (dokunulmadı).
--   • wheel_duel_* tarafına HİÇ dokunulmadı (ayrı migration).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) wheel_group_rooms.target_sequence — maçın hedef sırası
-- ----------------------------------------------------------------------------
-- Nullable, DEFAULT YOK: dizisi olmayan ESKİ odalar bugünkü gibi çalışır.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.wheel_group_rooms
  add column if not exists target_sequence text[];


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Zaman sabiti — istemci ile TEK KAYNAK eşleşmesi
-- ----------------------------------------------------------------------------
-- WheelGroupGame.tsx `FEEDBACK_MS = 1000` (Çark Düello'da 1200 — KASITLI FARK,
-- iki modun kendi değeri korunur). Drift testi check-wheel-advance-if-due.ts'te.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_feedback_delay_ms()
returns int language sql immutable as $$ select 1000 $$;

revoke all on function public.wheel_group_feedback_delay_ms() from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) wheel_group_next_target — persist edilmiş diziden sıradaki hedef
-- ----------------------------------------------------------------------------
-- Dizideki İLK oynanmamış hedef. `used_target_topoids` hem doğru cevabı hem
-- pas geçileni içerir (claim_target + vote_pass ikisi de append eder).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_next_target(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select s.topoid
    from public.wheel_group_rooms r
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

revoke all on function public.wheel_group_next_target(uuid) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) wheel_group_set_target_sequence — maçın hedef sırasını persist et
-- ----------------------------------------------------------------------------
-- HOST-ONLY: bugün de hedefi fiilen host seçiyor, yetki genişlemesi YOK.
-- Kısıtlar Çark Düello ile aynı (1..512, NULL/boş yasak, tekrar yasak).
-- NULL kontrolü tekrar kontrolünden ÖNCE — count(distinct) NULL saymaz.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_set_target_sequence(
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
  if not public.wheel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  v_len := coalesce(array_length(p_targets, 1), 0);
  if v_len = 0 or v_len > 512 then
    raise exception 'sequence_invalid' using errcode = '22023';
  end if;

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

  update public.wheel_group_rooms
     set target_sequence = p_targets
   where id = p_room_id
     and status in ('waiting', 'playing');
end;
$$;

revoke all     on function public.wheel_group_set_target_sequence(uuid, uuid, uuid, text[]) from public;
grant  execute on function public.wheel_group_set_target_sequence(uuid, uuid, uuid, text[]) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) wheel_group_advance_if_due — vadesi geldiyse ilerlet
-- ----------------------------------------------------------------------------
-- Kontrol sırası (3'ten itibaren hepsi FOR UPDATE satır kilidi ALTINDA):
--   1. Kimlik  — wheel_group_authorize_player
--   2. Üyelik  — o oyuncu satırı BU odada mı?
--   3. Kilit   — select … for update
--   4. Durum   — oda 'playing' mi?
--
-- OTOMAT:
--   FAZ 1 — MAÇ SONU: now() >= started_at + duration_seconds → finished
--           + reason 'timeout'. CAS'TAN ÖNCE (deadline mutlaktır).
--   FAZ 2 — CAS: çağıranın gördüğü hedef hâlâ aktif mi? Değilse no-op.
--   FAZ 3 — REFILL: hedef null ve now() >= updated_at + feedback_delay
--           → diziden sıradaki hedef; dizi bittiyse finished + reason 'pool'.
--
-- PAS FAZI YOKTUR: eşik `wheel_group_vote_pass` içinde sunucu tarafında
-- işleniyor (20260703120000) → orası zaten host'a bağlı değil.
--
-- Her ret "zararsız no-op": exception DEĞİL, DEĞİŞMEMİŞ oda satırı döner.
-- ÇİFT İLERLEME İMKÂNSIZ: `for update` + her UPDATE'in kendi CAS guard'ı.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_advance_if_due(
  p_room_id         uuid,
  p_player_id       uuid,
  p_claim_token     uuid,
  p_expected_target text
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_group_rooms;
  v_now  timestamptz := now();
  v_next text;
begin
  -- 1) Kimlik.
  if not public.wheel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- 2) Üyelik — başka odanın geçerli token'ı bu odayı ilerletemesin.
  if not exists (
    select 1 from public.wheel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  -- 3) Satır kilidi.
  select * into v_room from public.wheel_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- 4) Maç aktif değilse sessizce çık.
  if v_room.status <> 'playing' then
    return v_room;
  end if;

  -- ── FAZ 1: MAÇ SONU ────────────────────────────────────────────────────
  -- wheel_group_finish_game ile BİREBİR aynı kolonlar (winner YOK).
  if v_room.started_at is not null
     and v_now >= v_room.started_at + make_interval(secs => v_room.duration_seconds)
  then
    update public.wheel_group_rooms
       set status                = 'finished',
           finished_at           = v_now,
           finished_reason       = 'timeout',
           current_target_topoid = null
     where id = p_room_id
       and status = 'playing'                    -- CAS: çift finalize yok
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.wheel_group_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  -- ── FAZ 2: CAS ─────────────────────────────────────────────────────────
  if v_room.current_target_topoid is distinct from p_expected_target then
    return v_room;
  end if;

  -- Hedef hâlâ aktif → yapacak bir şey yok (hedef başına süre sınırı YOK).
  if v_room.current_target_topoid is not null then
    return v_room;
  end if;

  -- ── FAZ 3: REFILL ──────────────────────────────────────────────────────
  if v_room.updated_at is not null
     and v_now < v_room.updated_at
                 + make_interval(secs => public.wheel_group_feedback_delay_ms() / 1000.0)
  then
    return v_room;                                -- not_due
  end if;

  v_next := public.wheel_group_next_target(p_room_id);

  if v_next is null then
    -- Dizi HİÇ yazılmamışsa maçı bitirmek YANLIŞ olur (host yolu hâlâ
    -- çalışıyor olabilir) → yalnız dizi VARSA 'pool' ile bitir.
    if v_room.target_sequence is null then
      return v_room;
    end if;
    update public.wheel_group_rooms
       set status                = 'finished',
           finished_at           = v_now,
           finished_reason       = 'pool',
           current_target_topoid = null
     where id = p_room_id
       and status = 'playing'
     returning * into v_room;
    if v_room.id is null then
      select * into v_room from public.wheel_group_rooms where id = p_room_id;
    end if;
    return v_room;
  end if;

  update public.wheel_group_rooms
     set current_target_topoid = v_next
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid is null            -- CAS: yarışı kaybeden yazmaz
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.wheel_group_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_group_advance_if_due(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_advance_if_due(uuid, uuid, uuid, text) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
