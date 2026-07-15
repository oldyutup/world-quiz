-- ============================================================================
-- resolve_torble_room_code(p_code) — MERKEZİ oda-kodu → mod çözümleyicisi
-- + duel_rooms.room_kind sunucu-otoriter mod discriminator'ı.
-- ============================================================================
-- AMAÇ
-- ----
-- Ana sayfanın üst barındaki tek "Oda Kodu" alanı, kullanıcının hangi çok
-- oyunculu moda ait olduğunu BİLMEDEN girdiği kodu sunucuda çözer. Bu RPC
-- kodun hangi AKTİF Torble oda-kodlu moduna ait olduğunu bulur ve mod anahtarı
-- + kullanıcıya gösterilecek adı döndürür. Client bu sonuçtan mevcut davet/
-- katılma akışını (ONLINE_INVITE_LINKS / useInviteJoin / conquest & korNokta
-- invite path) tetikler.
--
-- BU RPC BİR GÜVENLİK OTORİTESİ DEĞİLDİR.
--   * Yalnız "bu kod hangi moda ait?" sorusunu yanıtlar.
--   * Gerçek katılma yetkisi (kapasite, üyelik, isim çakışması, host, oyun
--     durumu, kick, RLS) HER MODUN KENDİ join RPC'sinde kalır
--     (duel_join_room / wheel_duel_join_room / duel_group_join_room /
--      wheel_group_join_room / flag_group_join_room / tevatur_join_room /
--      conquest join). Burada İKİNCİ bir join güvenlik sistemi YOK.
--
-- KAPSAM — çözümlenen AKTİF oda-kodlu modlar ve tabloları:
--   duel        Ülke Yaz 1v1   → public.duel_rooms        (code)   *paylaşımlı*
--   flagDuel    Bayrak 1v1     → public.duel_rooms        (code)   *paylaşımlı*
--   wheelDuel   Çark 1v1       → public.wheel_duel_rooms  (code)
--   duelGroup   Ülke Yaz Grup  → public.duel_group_rooms  (code)
--   wheelGroup  Çark Grup      → public.wheel_group_rooms (code)
--   flagGroup   Bayrak Bilmece → public.flag_group_rooms  (code)
--   korNokta    Kör Nokta      → public.tevatur_rooms     (code)
--   conquest    Kuşatma        → public.conquest_rooms    (room_code)
--
--   NOT: Eshle bu sisteme DAHİL DEĞİLDİR (ayrı ürün/domain).
--
-- ÜLKE YAZ 1v1 ⟷ BAYRAK 1v1 AYRIMI (paylaşımlı duel_rooms) — room_kind
-- --------------------------------------------------------------------
--   Her iki mod da AYNI duel_rooms / duel_players / duel_join_room altyapısını
--   paylaşır (bkz. 20260612120000_flag_duel_rpc_hardening.sql).
--
--   ⚠️ ESKİ TASLAK "total_rounds IS NULL ⟹ duel" varsayımına dayanıyordu.
--   CANLI ŞEMADA ÇÜRÜDÜ: duel_rooms.total_rounds kolonunun canlıdaki
--   column_default'u 10 (nullable YES). Ülke Yaz create RPC'leri total_rounds
--   yazmasa bile satır 10 alır → Ülke Yaz odası Bayrak 1v1 sanılırdı.
--
--   YENİ ÇÖZÜM: açık, sunucu-otoriter discriminator kolonu.
--     duel_rooms.room_kind text  check ('country' | 'flag'), NULL = legacy.
--   Kolonu YALNIZ create RPC'leri sunucu tarafında yazar (client'tan gelen
--   bir "mode" değerine güvenilmez):
--     'country' → duel_create_room, country_duel_quick_match,
--                 duel_accept_rematch (yeni rematch odası)
--     'flag'    → flag_duel_create_room, flag_duel_quick_match
--   Bunlar duel_rooms'a INSERT atan TÜM yollardır: M3 lockdown
--   (20260605120000) tüm direkt-yazma policy'lerini düşürdü; yazma yolu
--   yalnız SECURITY DEFINER duel/flag_duel RPC'leri. Diğer RPC'ler (join,
--   start, finish, settings, flag_duel_accept_rematch, leave, disconnect)
--   mevcut satırı UPDATE eder → room_kind create'te ne yazıldıysa o kalır.
--   total_rounds'un canlıdaki default'u DEĞİŞTİRİLMEDİ (10 kalır) — hiçbir
--   akış artık bu kolonu mod ayrımı için OKUMAZ.
--
--   LEGACY SATIRLAR (migration-öncesi, room_kind IS NULL):
--     * Kanıtlanabilir alt küme backfill edilir: total_rounds IN (5, 15, 20)
--       ⟹ 'flag'. Kanıt: canlı default 10; M3 sonrası tek yazma yolu RPC'ler;
--       total_rounds'u yazan tek RPC ailesi flag_duel_* (5/10/15/20 validate).
--       Ülke Yaz hiçbir akışta total_rounds yazmaz → 5/15/20 yalnız Bayrak.
--     * total_rounds = 10 satırlar backfill EDİLMEZ (default'tan mı açık
--       seçimden mi ayırt edilemez — tahmin backfill'i YASAK). current_round /
--       current_flag / is_golden_round kolonlarının CANLI default'ları repo'dan
--       kanıtlanamadığı için onlara da dayanılmaz.
--     * Resolver room_kind IS NULL satır için İKİ eşleşme üretir
--       (duel + flagDuel) → sonuç 'ambiguous', client seçim modalı gösterir.
--       SESSİZ yanlış yönlendirme yok; davet edilen kullanıcı hangi oyuna
--       çağrıldığını bilir ve seçer. 1v1 odaları dakikalar mertebesinde
--       yaşadığından bu belirsizlik yalnız deploy anındaki aktif odalarla
--       sınırlıdır ve kendiliğinden tükenir.
--
-- AKTİF ODA KRİTERİ
-- -----------------
--   Silinmiş oda    → satır yok → eşleşmez (not_found).
--   status='finished' (ve conquest'te 'closed') → KAPANMIŞ, "found" gösterilmez.
--   status IN ('waiting','waiting_rematch','playing') → aday aktif oda.
--   Nihai kapasite/oyun-başladı kararını yine mod-özel join RPC verir; bu yüzden
--   'playing' odalar da eşleştirilir (join RPC gerekirse "Oyun başlamış" der).
--
-- AYNI KOD BİRDEN FAZLA TABLODA
-- ----------------------------
--   Oda kodları yalnız KENDİ tablolarında UNIQUE'tir; modlar arası global
--   unique DEĞİLDİR. Aynı kod iki farklı modda aktifse otomatik seçim YAPILMAZ:
--     0 eşleşme → not_found
--     1 eşleşme → found
--     2+ eşleşme → ambiguous (client küçük bir seçim arayüzü gösterir)
--
-- DÖNÜŞ (jsonb)
-- ------------
--   { "result": "invalid" }
--   { "result": "not_found",  "code": "<NORM>" }
--   { "result": "found",      "code": "<NORM>", "mode": "<key>", "label": "<ad>" }
--   { "result": "ambiguous",  "code": "<NORM>", "matches": [ {mode,label}, ... ] }
--   Yalnız GEREKLİ alanlar döner: host, oyuncu listesi, profil, token, room_id
--   veya iç metadata DÖNMEZ (enumeration yüzeyi minimum).
--
-- GÜVENLİK
-- --------
--   * SECURITY DEFINER + set search_path = public; dinamik SQL yok; tablo
--     isimleri sabit.
--   * Girdi sunucuda normalize + validate edilir (client validasyonu yalnız UX).
--   * Client'ın gönderdiği bir "mode" değerine GÜVENİLMEZ; mod sunucuda bulunur.
--   * Online modlara katılım authenticated gerektirdiği için EXECUTE yalnız
--     authenticated role'e verilir (anon'a değil) → giriş yapmamış kullanıcı
--     önce login olur (client: kod session'da saklanır, login sonrası çözülür).
--
-- Idempotent (add column if not exists + guard'lı constraint + create or
-- replace + yalnız NULL satırlara backfill). Migration DEPLOY EDİLMEDİ.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_rooms.room_kind — açık mod discriminator kolonu
-- ----------------------------------------------------------------------------
-- NULL'a izin verilir (legacy satırlar); CHECK yalnız yazılan değerleri
-- 'country' / 'flag' ile sınırlar. İndeks GEREKMEZ: resolver satırı önce
-- code (UNIQUE) üzerinden bulur, room_kind yalnız bulunan satırdan okunur.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.duel_rooms
  add column if not exists room_kind text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname  = 'duel_rooms_room_kind_check'
       and conrelid = 'public.duel_rooms'::regclass
  ) then
    alter table public.duel_rooms
      add constraint duel_rooms_room_kind_check
      check (room_kind in ('country', 'flag'));
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) duel_create_room — room_kind='country' yazacak şekilde yeniden tanım.
-- ----------------------------------------------------------------------------
-- Gövde 20260708120000_duel_display_name_guard.sql ile BİREBİR; tek değişiklik:
-- duel_rooms INSERT'ine room_kind kolonu + 'country' değeri eklendi.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_create_room(
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_code        text,
  p_duration    int,
  p_region      text,
  p_claim_token uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room         public.duel_rooms;
  v_uid          uuid := auth.uid();
  v_display_name text;
begin
  -- Kimlik tutarlılığı (XOR: ya profile_id ya guest_id dolu)
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
  if p_player_id is null then
    raise exception 'player_id_required' using errcode = '22023';
  end if;

  -- ── Display name: helper ile validate + registry guard. ──
  -- Helper hata fırlatırsa ('name_invalid' / 'display_name_forbidden' /
  -- 'registered_username_taken') aynen yukarıya yayılır; client
  -- describeDuelRpcError ile yakalar.
  v_display_name := public.assert_display_name_allowed(
    p_name, p_profile_id, p_guest_id
  );

  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;
  if p_duration is null or p_duration <= 0 then
    raise exception 'duration_invalid' using errcode = '22023';
  end if;
  if p_region is null or length(btrim(p_region)) = 0 then
    raise exception 'region_required' using errcode = '22023';
  end if;

  -- 1) Oda satırı (room_kind sunucu-otoriter: bu RPC yalnız Ülke Yaz 1v1)
  begin
    insert into public.duel_rooms (
      code, status, duration_seconds, region, room_source, host_player_id,
      room_kind
    ) values (
      p_code, 'waiting', p_duration, p_region, 'manual', p_player_id,
      'country'
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Host player satırı.
  --    Eski: btrim(p_name).  Yeni: v_display_name (helper temizledi).
  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, v_display_name, 0, p_profile_id, p_guest_id, now()
  );

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.duel_create_room(uuid, uuid, text, text, text, int, text, uuid) from public;
grant  execute on function public.duel_create_room(uuid, uuid, text, text, text, int, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) country_duel_quick_match — room_kind='country' yazacak şekilde yeniden tanım.
-- ----------------------------------------------------------------------------
-- Gövde 20260716160000_social_block_and_remove_friend.sql (§14, block dışlamalı
-- güncel sürüm) ile BİREBİR; tek değişiklik: duel_rooms INSERT'ine room_kind
-- kolonu + 'country' değeri eklendi.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.country_duel_quick_match(
  p_profile_id      uuid,
  p_player_id       uuid,
  p_player_name     text,
  p_duration        int,
  p_region          text,
  p_max_level_diff  int,
  p_room_code       text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_level     int;
  v_candidate    record;
  v_room_id      uuid;
  v_now          timestamptz := now();
  v_started_at   timestamptz := v_now + interval '3 seconds';
  v_expires_at   timestamptz := v_now + interval '45 seconds';
  v_existing     record;
begin
  -- ── Auth check ─────────────────────────────────────────────────────────
  if auth.uid() is null then
    raise exception 'country_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'country_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  -- ── Parametre kontrolleri ──────────────────────────────────────────────
  if p_duration is null then
    raise exception 'country_duel_quick_match: duration_required';
  end if;
  if p_duration not in (30, 60, 120, 180, 300) then
    raise exception 'country_duel_quick_match: invalid duration %', p_duration;
  end if;
  if p_max_level_diff is null then
    raise exception 'country_duel_quick_match: max_level_diff_required';
  end if;
  if p_max_level_diff < 0 then
    raise exception 'country_duel_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if coalesce(p_room_code, '') = '' then
    raise exception 'country_duel_quick_match: empty room_code';
  end if;
  if coalesce(btrim(p_player_name), '') = '' then
    raise exception 'country_duel_quick_match: empty player_name';
  end if;
  if p_player_id is null then
    raise exception 'country_duel_quick_match: player_id_required';
  end if;
  if coalesce(btrim(p_region), '') = '' then
    raise exception 'country_duel_quick_match: empty region';
  end if;

  -- ── Caller'ın level'ı ──────────────────────────────────────────────────
  v_my_level := public.country_duel_mode_level(p_profile_id);

  -- ── Stale-row self-heal ────────────────────────────────────────────────
  update public.country_duel_queue q
     set matched_room_id = null,
         updated_at      = v_now
   where q.profile_id      = p_profile_id
     and q.matched_room_id is not null
     and not exists (
       select 1
         from public.duel_rooms r
        where r.id = q.matched_room_id
          and r.status = 'playing'
          and r.created_at > v_now - interval '60 seconds'
     );

  -- ── Mevcut queue satırı: paralel RPC bizi zaten eşleştirmiş mi? ────────
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.country_duel_queue
   where profile_id = p_profile_id;

  if found and v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  -- ── Uygun aday ara (FOR UPDATE SKIP LOCKED ile race-safe) ──────────────
  select q.profile_id, q.player_id, q.player_name, q.mode_level,
         q.max_level_diff, q.created_at
    into v_candidate
    from public.country_duel_queue q
   where q.profile_id      <> p_profile_id
     and q.region            = p_region
     and q.duration_seconds  = p_duration
     and q.matched_room_id  is null
     and q.expires_at        > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
     and not public.is_blocked_between(p_profile_id, q.profile_id)
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı atomik kur ──────────────────────────────────────
    -- (room_kind sunucu-otoriter: bu RPC yalnız Ülke Yaz 1v1 odası kurar)
    insert into public.duel_rooms (
      code,
      status,
      duration_seconds,
      region,
      started_at,
      room_source,
      host_player_id,
      room_kind
    ) values (
      p_room_code,
      'playing',
      p_duration,
      p_region,
      v_started_at,
      'quick_match',
      v_candidate.player_id,
      'country'
    )
    returning id into v_room_id;

    insert into public.duel_players (id, room_id, name, score, profile_id, last_seen_at)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, 0,
              v_candidate.profile_id, v_now);

    insert into public.duel_players (id, room_id, name, score, profile_id, last_seen_at)
      values (p_player_id, v_room_id, btrim(p_player_name), 0,
              p_profile_id, v_now);

    update public.country_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    insert into public.country_duel_queue as q (
      profile_id, player_id, player_name,
      duration_seconds, region, mode_level, max_level_diff,
      matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, btrim(p_player_name),
      p_duration, p_region, v_my_level, p_max_level_diff,
      v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id        = excluded.player_id,
          player_name      = excluded.player_name,
          duration_seconds = excluded.duration_seconds,
          region           = excluded.region,
          mode_level       = excluded.mode_level,
          max_level_diff   = excluded.max_level_diff,
          matched_room_id  = excluded.matched_room_id,
          expires_at       = excluded.expires_at,
          updated_at       = excluded.updated_at;

    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_room_id,
      'my_player_id',       p_player_id,
      'opponent_name',      v_candidate.player_name,
      'search_age_seconds', 0
    );
  end if;

  -- ── EŞLEŞME YOK — caller'ın queue satırını UPSERT ──────────────────────
  insert into public.country_duel_queue as q (
    profile_id, player_id, player_name,
    duration_seconds, region, mode_level, max_level_diff,
    matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, btrim(p_player_name),
    p_duration, p_region, v_my_level, p_max_level_diff,
    null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id        = excluded.player_id,
        player_name      = excluded.player_name,
        duration_seconds = excluded.duration_seconds,
        region           = excluded.region,
        mode_level       = excluded.mode_level,
        max_level_diff   = excluded.max_level_diff,
        expires_at       = excluded.expires_at,
        updated_at       = excluded.updated_at
    where q.matched_room_id is null;

  -- UPSERT sonrası tekrar oku → arada matched olduysa direkt dön
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.country_duel_queue
   where profile_id = p_profile_id;

  if v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  return jsonb_build_object(
    'matched',            false,
    'search_age_seconds', greatest(0, extract(epoch from (v_now - coalesce(v_existing.created_at, v_now)))::int)
  );
end;
$$;

revoke all on function public.country_duel_quick_match(uuid, uuid, text, int, text, int, text)    from public;
grant  execute on function public.country_duel_quick_match(uuid, uuid, text, int, text, int, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) duel_accept_rematch — room_kind='country' yazacak şekilde yeniden tanım.
-- ----------------------------------------------------------------------------
-- Gövde 20260604120000_duel_rls_hardening_m2.sql (§9, güncel tek sürüm) ile
-- BİREBİR; tek değişiklik: yeni oda INSERT'ine room_kind kolonu + 'country'
-- değeri eklendi. Bu RPC yalnız Ülke Yaz rematch akışında kullanılır
-- (DuelGame.tsx; Bayrak'ın rematch'i flag_duel_accept_rematch olup AYNI odayı
-- UPDATE eder, yeni satır açmaz) → yeni oda her zaman 'country'.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_accept_rematch(
  p_old_room_id        uuid,
  p_old_player_id      uuid,
  p_old_claim_token    uuid,
  p_new_room_code      text,
  p_new_player_id      uuid,
  p_new_claim_token    uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_old_room   public.duel_rooms;
  v_new_room   public.duel_rooms;
  v_old_player public.duel_players;
begin
  if not public.duel_authorize_player(p_old_player_id, p_old_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_new_room_code is null or length(btrim(p_new_room_code)) = 0 then
    raise exception 'new_code_required' using errcode = '22023';
  end if;
  if p_new_player_id is null or p_new_claim_token is null then
    raise exception 'new_identity_required' using errcode = '22023';
  end if;

  -- Eski oda & player'ı çek (config kopyala)
  select * into v_old_room from public.duel_rooms where id = p_old_room_id;
  if v_old_room.id is null then
    raise exception 'old_room_not_found' using errcode = '02000';
  end if;
  if v_old_room.status <> 'finished' then
    raise exception 'old_room_not_finished' using errcode = 'P0001';
  end if;

  select * into v_old_player
    from public.duel_players
   where id = p_old_player_id and room_id = p_old_room_id;
  if v_old_player.id is null then
    raise exception 'old_player_not_found' using errcode = '02000';
  end if;

  -- 1) Yeni oda (room_kind sunucu-otoriter: Ülke Yaz rematch odası)
  begin
    insert into public.duel_rooms (
      code, status, duration_seconds, region, room_source, host_player_id,
      room_kind
    ) values (
      p_new_room_code,
      'waiting_rematch',
      v_old_room.duration_seconds,
      v_old_room.region,
      'manual',
      p_new_player_id,
      'country'
    )
    returning * into v_new_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Yeni player (eski isim + profile_id / guest_id korunur)
  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_new_player_id,
    v_new_room.id,
    v_old_player.name,
    0,
    v_old_player.profile_id,
    v_old_player.guest_id,
    now()
  );

  -- 3) Yeni claim
  insert into public.duel_player_claims (player_id, claim_token)
  values (p_new_player_id, p_new_claim_token);

  -- 4) Eski odanın pointer'ını yaz (requester realtime ile yakalar)
  update public.duel_rooms
     set rematch_room_id = v_new_room.id
   where id = p_old_room_id;

  return v_new_room;
end;
$$;

revoke all     on function public.duel_accept_rematch(uuid, uuid, uuid, text, uuid, uuid) from public;
grant  execute on function public.duel_accept_rematch(uuid, uuid, uuid, text, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) flag_duel_create_room — room_kind='flag' yazacak şekilde yeniden tanım.
-- ----------------------------------------------------------------------------
-- Gövde 20260709120000_flag_duel_display_name_guard.sql ile BİREBİR; tek
-- değişiklik: duel_rooms INSERT'ine room_kind kolonu + 'flag' değeri eklendi.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_create_room(
  p_player_id    uuid,
  p_profile_id   uuid,
  p_guest_id     text,
  p_name         text,
  p_code         text,
  p_region       text,
  p_total_rounds int,
  p_claim_token  uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room         public.duel_rooms;
  v_uid          uuid := auth.uid();
  v_display_name text;
begin
  -- Kimlik tutarlılığı (XOR: ya profile_id ya guest_id dolu)
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
  if p_player_id is null then
    raise exception 'player_id_required' using errcode = '22023';
  end if;

  -- ── Display name: helper ile validate + registry guard. ──
  -- Helper hata fırlatırsa ('name_invalid' / 'display_name_forbidden' /
  -- 'registered_username_taken') aynen yukarıya yayılır; client
  -- describeFlagDuelRpcError ile yakalar.
  v_display_name := public.assert_display_name_allowed(
    p_name, p_profile_id, p_guest_id
  );

  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;
  if p_region is null or length(btrim(p_region)) = 0 then
    raise exception 'region_required' using errcode = '22023';
  end if;
  if p_total_rounds is null or p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'total_rounds_invalid' using errcode = '22023';
  end if;

  -- 1) Oda satırı (room_kind sunucu-otoriter: bu RPC yalnız Bayrak 1v1)
  begin
    insert into public.duel_rooms (
      code, status, duration_seconds, region, room_source, host_player_id,
      total_rounds, current_round, is_golden_round, current_flag,
      room_kind
    ) values (
      p_code, 'waiting', 60, p_region, 'manual', p_player_id,
      p_total_rounds, 0, false, null,
      'flag'
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Host player satırı.
  --    Eski: btrim(p_name).  Yeni: v_display_name (helper temizledi).
  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, v_display_name, 0, p_profile_id, p_guest_id, now()
  );

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_create_room(uuid, uuid, text, text, text, text, int, uuid) from public;
grant  execute on function public.flag_duel_create_room(uuid, uuid, text, text, text, text, int, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) flag_duel_quick_match — room_kind='flag' yazacak şekilde yeniden tanım.
-- ----------------------------------------------------------------------------
-- Gövde 20260716160000_social_block_and_remove_friend.sql (§13, block dışlamalı
-- güncel sürüm) ile BİREBİR; tek değişiklik: duel_rooms INSERT'ine room_kind
-- kolonu + 'flag' değeri eklendi.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_quick_match(
  p_profile_id      uuid,
  p_player_id       uuid,
  p_player_name     text,
  p_total_rounds    int,
  p_region          text,
  p_max_level_diff  int,
  p_room_code       text,
  p_first_flag      text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_level     int;
  v_candidate    record;
  v_room_id      uuid;
  v_now          timestamptz := now();
  v_started_at   timestamptz := v_now + interval '3 seconds';
  v_expires_at   timestamptz := v_now + interval '45 seconds';
  v_existing     record;
begin
  if auth.uid() is null then
    raise exception 'flag_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'flag_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  if p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'flag_duel_quick_match: invalid total_rounds %', p_total_rounds;
  end if;
  if p_max_level_diff < 0 then
    raise exception 'flag_duel_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if coalesce(p_room_code, '') = '' or coalesce(p_first_flag, '') = '' then
    raise exception 'flag_duel_quick_match: empty room_code or first_flag';
  end if;

  v_my_level := public.flag_duel_mode_level(p_profile_id);

  -- Stale-row self-heal (preserved from 20260521130000)
  update public.flag_duel_queue q
     set matched_room_id = null,
         updated_at      = v_now
   where q.profile_id      = p_profile_id
     and q.matched_room_id is not null
     and not exists (
       select 1
         from public.duel_rooms r
        where r.id = q.matched_room_id
          and r.status = 'playing'
          and r.created_at > v_now - interval '60 seconds'
     );

  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.flag_duel_queue
   where profile_id = p_profile_id;

  if found and v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  select q.profile_id, q.player_id, q.player_name, q.mode_level,
         q.max_level_diff, q.created_at
    into v_candidate
    from public.flag_duel_queue q
   where q.profile_id      <> p_profile_id
     and q.region            = p_region
     and q.total_rounds      = p_total_rounds
     and q.matched_room_id  is null
     and q.expires_at        > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
     and not public.is_blocked_between(p_profile_id, q.profile_id)
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı atomik kur ──────────────────────────────────────
    -- host_player_id = candidate (waiter). Hem flag_duel_authorize_host
    -- manuel branch'i hem client-side isHost kontrolü bu kolon üzerinden
    -- DETERMINISTIK çalışır; joined_at tie-break belirsizliği biter.
    -- (room_kind sunucu-otoriter: bu RPC yalnız Bayrak 1v1 odası kurar)
    insert into public.duel_rooms (
      code,
      status,
      duration_seconds,
      region,
      started_at,
      total_rounds,
      current_round,
      is_golden_round,
      current_flag,
      current_flag_at,
      room_source,
      host_player_id,
      room_kind
    ) values (
      p_room_code,
      'playing',
      60,
      p_region,
      v_started_at,
      p_total_rounds,
      1,
      false,
      p_first_flag,
      v_started_at,
      'quick_match',
      v_candidate.player_id,
      'flag'
    )
    returning id into v_room_id;

    insert into public.duel_players (id, room_id, name, score)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, 0);

    insert into public.duel_players (id, room_id, name, score)
      values (p_player_id, v_room_id, p_player_name, 0);

    update public.flag_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    insert into public.flag_duel_queue as q (
      profile_id, player_id, player_name,
      total_rounds, region, mode_level, max_level_diff,
      matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, p_player_name,
      p_total_rounds, p_region, v_my_level, p_max_level_diff,
      v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id       = excluded.player_id,
          player_name     = excluded.player_name,
          total_rounds    = excluded.total_rounds,
          region          = excluded.region,
          mode_level      = excluded.mode_level,
          max_level_diff  = excluded.max_level_diff,
          matched_room_id = excluded.matched_room_id,
          expires_at      = excluded.expires_at,
          updated_at      = excluded.updated_at;

    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_room_id,
      'my_player_id',       p_player_id,
      'opponent_name',      v_candidate.player_name,
      'search_age_seconds', 0
    );
  end if;

  insert into public.flag_duel_queue as q (
    profile_id, player_id, player_name,
    total_rounds, region, mode_level, max_level_diff,
    matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, p_player_name,
    p_total_rounds, p_region, v_my_level, p_max_level_diff,
    null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id      = excluded.player_id,
        player_name    = excluded.player_name,
        total_rounds   = excluded.total_rounds,
        region         = excluded.region,
        mode_level     = excluded.mode_level,
        max_level_diff = excluded.max_level_diff,
        expires_at     = excluded.expires_at,
        updated_at     = excluded.updated_at
    where q.matched_room_id is null;

  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.flag_duel_queue
   where profile_id = p_profile_id;

  if v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  return jsonb_build_object(
    'matched',            false,
    'search_age_seconds', greatest(0, extract(epoch from (v_now - coalesce(v_existing.created_at, v_now)))::int)
  );
end;
$$;

revoke all on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) from public;
grant  execute on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) KANITLI legacy backfill — yalnız ispatlanabilir alt küme.
-- ----------------------------------------------------------------------------
-- total_rounds IN (5, 15, 20) ⟹ Bayrak 1v1. Kanıt zinciri:
--   (a) Canlı şemada total_rounds column_default = 10 (SQL ile teyitli) →
--       kolona dokunmayan Ülke Yaz satırları 10 alır, asla 5/15/20 olamaz.
--   (b) M3 lockdown (20260605120000) sonrası duel_rooms'a tüm yazma yolu
--       SECURITY DEFINER RPC'leri; total_rounds'u yazan tek aile flag_duel_*
--       (create/quick_match/update_settings — hepsi 5/10/15/20 validate eder).
--   (c) Ülke Yaz RPC'leri (create/quick_match/accept_rematch/start/finish/...)
--       total_rounds'a hiçbir yerde değer YAZMAZ (repo taraması).
-- total_rounds = 10 satırlar: default'tan mı (Ülke Yaz) açık seçimden mi
-- (Bayrak) ayırt EDİLEMEZ → backfill YOK, room_kind NULL kalır → resolver
-- 'ambiguous' döndürür (aşağıda). current_round / current_flag /
-- is_golden_round kolonlarının canlı default'ları repo'dan kanıtlanamadığı
-- için onlar discriminator olarak KULLANILMAZ.
-- Idempotent: yalnız room_kind IS NULL satırlara dokunur.
-- ────────────────────────────────────────────────────────────────────────────

update public.duel_rooms
   set room_kind = 'flag'
 where room_kind is null
   and total_rounds in (5, 15, 20);


-- ────────────────────────────────────────────────────────────────────────────
-- 8) resolve_torble_room_code — merkezî çözümleyici (room_kind tabanlı ayrım).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.resolve_torble_room_code(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_norm    text;
  v_matches jsonb;
  v_count   int;
begin
  -- ── Normalizasyon (sunucu-otoriter) ──────────────────────────────────────
  -- trim → yalnız A-Z/0-9 karakterleri → upper. Tüm Torble oda kodları 6
  -- karakterli A-Z0-9'dur; farklı uzunluk = geçersiz. (Conquest 'K'+5 dahil
  -- hepsi bu kümeye girer.)
  if p_code is null then
    return jsonb_build_object('result', 'invalid');
  end if;

  v_norm := upper(regexp_replace(btrim(p_code), '[^A-Za-z0-9]', '', 'g'));

  if length(v_norm) <> 6 then
    return jsonb_build_object('result', 'invalid');
  end if;

  -- ── Aday aktif odaları tüm mod tablolarından topla ───────────────────────
  -- Her <mode>_rooms.code kendi tablosunda UNIQUE → tablo başına en fazla 1
  -- satır. Modlar arası çakışma jsonb dizisinde birden fazla eleman üretir.
  select
    coalesce(jsonb_agg(jsonb_build_object('mode', mode, 'label', label) order by ord), '[]'::jsonb),
    count(*)
  into v_matches, v_count
  from (
    -- duel_rooms: Ülke Yaz 1v1 + Bayrak 1v1 paylaşımlı tablo. Ayrım SUNUCU-
    -- OTORİTER room_kind kolonu ('country'/'flag'; yalnız create RPC'leri
    -- yazar). room_kind IS NULL = migration-öncesi legacy satır → iki branch
    -- de eşleşir ⟹ sonuç 'ambiguous', kullanıcı seçim modalında karar verir
    -- (sessiz yanlış yönlendirme YOK; legacy odalar bitince kendiliğinden
    -- kaybolur). total_rounds ayrım için KULLANILMAZ (canlı default=10,
    -- Ülke Yaz odaları da 10 taşır — 20260801 kök nedeni).
    select 'duel' as mode, 'Ülke Yaz 1v1' as label, 1 as ord
      from public.duel_rooms dr
     where dr.code = v_norm
       and dr.status <> 'finished'
       and (dr.room_kind = 'country' or dr.room_kind is null)

    union all
    select 'flagDuel', 'Bayrak 1v1', 2
      from public.duel_rooms dr
     where dr.code = v_norm
       and dr.status <> 'finished'
       and (dr.room_kind = 'flag' or dr.room_kind is null)

    union all
    select 'wheelDuel', 'Çark 1v1', 3
      from public.wheel_duel_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'duelGroup', 'Ülke Yaz Grup', 4
      from public.duel_group_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'wheelGroup', 'Çark Grup', 5
      from public.wheel_group_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'flagGroup', 'Bayrak Bilmece', 6
      from public.flag_group_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'korNokta', 'Kör Nokta', 7
      from public.tevatur_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'conquest', 'Kuşatma', 8
      from public.conquest_rooms
     where room_code = v_norm and status not in ('finished', 'closed')
  ) t;

  if v_count = 0 then
    return jsonb_build_object('result', 'not_found', 'code', v_norm);
  elsif v_count = 1 then
    return jsonb_build_object(
      'result', 'found',
      'code',   v_norm,
      'mode',   v_matches->0->>'mode',
      'label',  v_matches->0->>'label'
    );
  else
    return jsonb_build_object(
      'result',  'ambiguous',
      'code',    v_norm,
      'matches', v_matches
    );
  end if;
end
$fn$;

revoke all     on function public.resolve_torble_room_code(text) from public;
grant  execute on function public.resolve_torble_room_code(text) to authenticated;

-- ============================================================================
-- Doğrulama (Studio SQL editor):
--   -- Kolon + constraint:
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'duel_rooms'
--      and column_name = 'room_kind';
--   select conname from pg_constraint
--    where conrelid = 'public.duel_rooms'::regclass
--      and conname = 'duel_rooms_room_kind_check';
--
--   -- 5 create yolunun room_kind yazdığı (body içi):
--   select proname from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('duel_create_room', 'country_duel_quick_match',
--                      'duel_accept_rematch', 'flag_duel_create_room',
--                      'flag_duel_quick_match')
--      and pg_get_functiondef(oid) like '%room_kind%';
--   -- Beklenen: 5 satır.
--
--   -- Resolver (oturum açık kullanıcı olarak):
--   select public.resolve_torble_room_code('  ab12cd ');   -- normalize → AB12CD
--   select public.resolve_torble_room_code('abc');          -- {"result":"invalid"}
--   select public.resolve_torble_room_code('ZZZZZZ');       -- {"result":"not_found"}
--   -- Yeni Ülke Yaz odası (room_kind='country') → {"result":"found","mode":"duel"}
--   -- Yeni Bayrak odası (room_kind='flag')      → {"result":"found","mode":"flagDuel"}
--   -- Legacy satır (room_kind NULL, elle test)  → {"result":"ambiguous",
--   --   matches:[{duel},{flagDuel}]}
--   -- Aynı kodu iki tabloya elle ekleyip        → {"result":"ambiguous", ...}
-- ============================================================================
