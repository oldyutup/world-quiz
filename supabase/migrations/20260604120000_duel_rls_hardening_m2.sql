-- ============================================================================
-- Duel (Online 1v1 Ülke Yaz) — RLS hardening · M2 (RPC altyapısı, saf additive)
-- ============================================================================
-- AMAÇ
-- ----
-- M1'de eklenen claim-token + duel_authorize_player / duel_authorize_host
-- helper'larının üstüne 12 aksiyon RPC'sini ekler. Bu migration HİÇBİR mevcut
-- davranışı değiştirmez:
--   • duel_rooms / duel_players / duel_claims / duel_messages MEVCUT geniş RLS
--     politikaları (Studio'da kurulmuş `anon FOR ALL USING(true) WITH CHECK(true)`)
--     yerinde kalır → DuelGame.tsx'in mevcut direkt-yazma yolları çalışmaya
--     devam eder, canlı oyun bozulmaz.
--   • Frontend bu RPC'leri henüz çağırmıyor → FE switch ayrı adımda yapılacak.
--   • RPC'ler SECURITY DEFINER ile RLS'i bypass eder ve manuel authz yapar;
--     bu sayede M3 (RLS lockdown) atıldığında frontend bu RPC'lere geçmiş olur.
--
-- M1 → M2 → FE switch → M3 sıralaması wheel_duel ve wheel_group hardening'inde
-- üç kez doğrulanmıştır (20260528–20260530, 20260531–20260602). Bu dosya aynı
-- pattern'in Duel 1v1 karşılığıdır.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_rooms / duel_players / duel_claims / duel_messages MEVCUT RLS
--     politikaları + REPLICA IDENTITY + publication üyelikleri
--   • duel_group_* (kendi M1/M2/M3 setini ayrıca alacak)
--   • wheel_duel_*, wheel_group_*, conquest_*
--   • flag_duel_queue + flag_duel_quick_match / flag_duel_cancel_quick_match
--     RPC'leri + flag_duel_mode_level helper'ı
--   • cleanup_expired_duel_lobbies RPC (DuelGame.tsx hâlâ çağırıyor)
--   • duel_player_claims tablosu + RLS (M1'de geldi)
--   • duel_authorize_player / duel_authorize_host (M1'de geldi)
--   • profiles, xp_events
--   • Mevcut duel_* tablolarının SATIRLARI (backfill yok)
--
-- YENİ RPC'LER (frontend write call-site karşılığı parantezde)
-- -----------------------------------------------------------
--    1) duel_create_room        (DuelGame.tsx:1049 createRoom)
--    2) duel_join_room          (DuelGame.tsx:1160 joinRoom)
--    3) duel_start_game         (DuelGame.tsx:1282 startGame — host)
--    4) duel_submit_claim       (DuelGame.tsx:1358 duel_claims.insert)
--    5) duel_finish_game        (DuelGame.tsx:775   timeout finish)
--    6) duel_forfeit_game       (DuelGame.tsx:1641 forfeit useCallback)
--    7) duel_handle_disconnect  (DuelGame.tsx:582   grace timeout writer)
--    8) duel_heartbeat          (DuelGame.tsx:962  + 1324 last_seen_at update)
--    9) duel_accept_rematch     (DuelGame.tsx:1761 acceptRematch)
--   10) duel_join_rematch_room  (DuelGame.tsx:1710 joinRematchRoom)
--   11) duel_leave_room         (DuelGame.tsx:1682 backToLobby + 1617 cancel)
--   12) duel_send_message       (LobbyChat.tsx:228 send — yalnız Duel modu için
--                                 server-side player_name resolve eder)
--
-- KAPSAM DIŞI (BİLİNÇLİ)
-- ----------------------
--   • DuelGame.tsx country quick match akışı (1407 quickMatch) — flag_duel_*
--     RPC'lerinden farklı, client-side matchmaking. Bu RPC seti içinde QM için
--     ayrı bir RPC yazılmıyor; M3 öncesi FE switch'inde ya yeni bir RPC
--     (örn. duel_join_quickmatch_room) eklenecek ya QM akışı duel_create_room
--     + duel_join_room ikilisine indirgenecek. Şu anda QM mevcut direkt-yazma
--     yoluyla çalışmaya devam edecek (M2 değişikliği yok).
--   • duel_messages'in conquest / wheel_group / wheel_duel paylaşımlı kullanımı
--     (room_code prefix'leri ile aynı tabloda yaşıyor). duel_send_message
--     yalnız 'Duel 1v1' moduna ait satırlar için server-side player_name
--     resolution yapar; diğer modların direkt INSERT yolu M3 sırasında ayrıca
--     ele alınacak (bu migration onlara dokunmaz).
--
-- GÜVENLİK İLKELERİ
-- -----------------
--   • Hepsi SECURITY DEFINER, set search_path = public, auth.
--   • duel_authorize_player / duel_authorize_host helper'ları üzerinden
--     manuel authz; aksi halde RLS bypass kazancı kaybolur.
--   • revoke all from public + grant execute to anon, authenticated.
--   • duel_submit_claim claim insert'i server-side yapar; başkasının player_id'si
--     adına insert engellenir (player_room_mismatch).
--   • duel_finish_game winner_player_id SERVER-SIDE hesaplanır: duel_claims
--     COUNT(*) en yüksek olan kazanır. Eşitse null (beraberlik). Client değer
--     GÖNDERMEZ; reason her zaman 'timeout' olarak set edilir.
--   • duel_forfeit_game forfeit eden kimliğini claim_token ile doğrular; winner
--     room'daki diğer player'a atanır.
--   • duel_handle_disconnect grace süresini SERVER-SIDE hesaplar
--     (duration<=60 → 20s, duration<=120 → 30s, aksi 45s — DuelGame.tsx 543).
--     Caller GRACE parametre veremez; opp.last_seen_at gerçekten geç değilse
--     no-op (sessiz). Reporter'ı kazanan olarak yazar.
--   • duel_heartbeat yalnız kendi satırını günceller (authorize_player guard).
--   • duel_send_message player_name'i CLIENT'TAN ALMAZ; duel_players.name'i
--     server-side fetch eder. Cross-room spoof'a karşı player.room_id ile
--     duel_rooms.code eşleşmesi zorlanır.
--
-- ERROR CODE KONVANSİYONU
-- -----------------------
--   • 42501 (insufficient_privilege)  → unauthorized / profile_mismatch /
--                                       player_room_mismatch
--   • 22023 (invalid_parameter_value) → input validation
--   • P0001 (raise_exception)         → business rule (code_taken, room_full,
--                                       name_taken, room_not_*, ...)
--   • 02000 (no_data)                 → room_not_found / player_not_found
--
-- IDEMPOTENT
-- ----------
--   • Tüm fonksiyonlar "create or replace" → migration tekrar koşulursa
--     temiz şekilde üzerine yazılır. İmza değişmediği sürece sorun yok.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_create_room
-- ----------------------------------------------------------------------------
-- Oda + host player + claim_token tek transaction'da. Manuel akış için.
-- room_source='manual' olarak yazılır (mevcut default ile uyumlu, ama açıkça
-- belirtiyoruz ki Quick Match satırlarından ayrılsın).
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
  v_room public.duel_rooms;
  v_uid  uuid := auth.uid();
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
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;
  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;
  if p_duration is null or p_duration <= 0 then
    raise exception 'duration_invalid' using errcode = '22023';
  end if;
  if p_region is null or length(btrim(p_region)) = 0 then
    raise exception 'region_required' using errcode = '22023';
  end if;

  -- 1) Oda satırı
  begin
    insert into public.duel_rooms (
      code, status, duration_seconds, region, room_source, host_player_id
    ) values (
      p_code, 'waiting', p_duration, p_region, 'manual', p_player_id
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Host player satırı
  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, btrim(p_name), 0, p_profile_id, p_guest_id, now()
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
-- 2) duel_join_room
-- ----------------------------------------------------------------------------
-- Manuel akışta kod ile katılma. Yalnız status='waiting' kabul edilir
-- (rematch_room_id pointer akışı için duel_join_rematch_room ayrı RPC).
-- Capacity = 2, isim çakışması case-insensitive.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_join_room(
  p_code        text,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_claim_token uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.duel_rooms;
  v_uid   uuid := auth.uid();
  v_count int;
begin
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
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;
  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;

  -- Oda lookup + lock (race: kapasite kontrol ile insert arasında)
  select * into v_room
    from public.duel_rooms
   where code = p_code
   for update;

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room.status = 'finished' then
    raise exception 'room_finished' using errcode = 'P0001';
  end if;
  if v_room.status = 'playing' then
    raise exception 'room_in_progress' using errcode = 'P0001';
  end if;
  if v_room.status <> 'waiting' then
    -- 'waiting_rematch' veya bilinmeyen status'lar burada düşer
    raise exception 'room_unavailable' using errcode = 'P0001';
  end if;

  -- İsim çakışması (TR locale farkı server'da yok; lower(btrim) yeterli)
  if exists (
    select 1 from public.duel_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(btrim(p_name))
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  -- Kapasite
  select count(*) into v_count
    from public.duel_players
   where room_id = v_room.id;
  if v_count >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Player + claim
  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, btrim(p_name), 0, p_profile_id, p_guest_id, now()
  );

  insert into public.duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  -- Güncel satır
  select * into v_room from public.duel_rooms where id = v_room.id;
  return v_room;
end;
$$;

revoke all     on function public.duel_join_room(text, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.duel_join_room(text, uuid, uuid, text, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) duel_start_game
-- ----------------------------------------------------------------------------
-- Host-only. started_at server-side now() (clock skew kapanır). Kapasite=2
-- zorunluluğu burada. Tüm 'finished' alanları reset edilir (rematch sonrası
-- yeniden başlatma için savunma; M2 akışında rematch ayrı oda yaratır ama
-- ileride aynı odayı reset etmek istenirse hazır).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.duel_rooms;
  v_count int;
begin
  if not public.duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from public.duel_players where room_id = p_room_id;
  if v_count < 2 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;

  update public.duel_rooms
     set status                 = 'playing',
         started_at             = now(),
         finished_at            = null,
         finished_reason        = null,
         winner_player_id       = null,
         forfeited_player_id    = null,
         disconnected_player_id = null,
         disconnect_at          = null
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  -- Heartbeat clock'unu hizala — opp monitor "stale" baseline'ı dürüst başlasın
  update public.duel_players
     set last_seen_at = now()
   where room_id = p_room_id;

  return v_room;
end;
$$;

revoke all     on function public.duel_start_game(uuid, uuid, uuid) from public;
grant  execute on function public.duel_start_game(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) duel_submit_claim
-- ----------------------------------------------------------------------------
-- Player-only. Claim INSERT server-side; başkası adına yazma engellenir.
-- duel_players.score kolonuna DOKUNULMAZ — DuelGame.tsx skoru duel_claims
-- COUNT'undan türetiyor (myScore/oppScore claims array'inden). M2'de bu
-- davranışı korumak için sadece duel_claims insert ediyoruz.
--
-- UNIQUE(room_id, country_code) constraint'ı (Studio'da mevcut) dup'ları
-- 23505 ile yakalıyor; biz onu yine claim_dup business hatasıyla expose
-- ediyoruz, frontend ise '23505' beklediği için yine de aynı kodu görür.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_submit_claim(
  p_room_id      uuid,
  p_player_id    uuid,
  p_claim_token  uuid,
  p_country_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room_status text;
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_country_code is null or length(btrim(p_country_code)) = 0 then
    raise exception 'country_code_required' using errcode = '22023';
  end if;

  -- Oyuncu bu odada mı?
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Oda hâlâ playing'de mi? (yarış: aynı anda finish_game/forfeit/disconnect
  -- atılırsa claim no-op kalsın; UNIQUE violation'a düşmeden net hata dön)
  select status into v_room_status
    from public.duel_rooms
   where id = p_room_id;

  if v_room_status is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room_status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Atomik claim insert
  begin
    insert into public.duel_claims (room_id, player_id, country_code)
    values (p_room_id, p_player_id, p_country_code);
  exception
    when unique_violation then
      -- Frontend dup feedback'i için sessiz dönüş (raise yerine flag)
      return jsonb_build_object('claimed', false, 'reason', 'dup');
  end;

  return jsonb_build_object('claimed', true);
end;
$$;

revoke all     on function public.duel_submit_claim(uuid, uuid, uuid, text) from public;
grant  execute on function public.duel_submit_claim(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) duel_finish_game
-- ----------------------------------------------------------------------------
-- Player-in-room. Timeout senaryosu — herhangi bir oyuncu tetikleyebilir
-- (DuelGame.tsx finishGameByTimeout: ANY client). reason='timeout' SERVER set,
-- winner = duel_claims COUNT en yüksek olan player. Eşitse winner=null.
--
-- Conditional update (status='playing') → double-call no-op olur (ikinci
-- caller satırı 'finished'a düşmüş bulur, raise atmayız → daha defansif).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_finish_game(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.duel_rooms;
  v_winner_id  uuid;
  v_player_count int;
  v_top_count  int;
  v_top_id     uuid;
  v_second_cnt int;
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Status guard — zaten finished'sa güncel satırı dön (no-op).
  select * into v_room from public.duel_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Winner hesabı: claims COUNT en yüksek
  select count(distinct player_id) into v_player_count
    from public.duel_claims where room_id = p_room_id;

  if v_player_count = 0 then
    -- Hiç claim yok → winner null (beraberlik / 0-0)
    v_winner_id := null;
  else
    -- En yüksek claim sayılı player
    select player_id, cnt
      into v_top_id, v_top_count
      from (
        select player_id, count(*) as cnt
          from public.duel_claims
         where room_id = p_room_id
         group by player_id
         order by count(*) desc
         limit 1
      ) t;

    -- İkinci en yüksek (eşitlik kontrolü)
    select count(*) into v_second_cnt
      from public.duel_claims
     where room_id = p_room_id
       and player_id <> v_top_id
     group by player_id
     order by count(*) desc
     limit 1;

    if v_second_cnt is not null and v_second_cnt = v_top_count then
      v_winner_id := null;  -- beraberlik
    else
      v_winner_id := v_top_id;
    end if;
  end if;

  update public.duel_rooms
     set status           = 'finished',
         finished_at      = now(),
         finished_reason  = 'timeout',
         winner_player_id = v_winner_id
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    -- Yarışı kaybettik (başka caller status'u zaten çevirdi) → güncel satırı dön
    select * into v_room from public.duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.duel_finish_game(uuid, uuid, uuid) from public;
grant  execute on function public.duel_finish_game(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) duel_forfeit_game
-- ----------------------------------------------------------------------------
-- Player-only. Forfeit eden = LOSER, rakip = WINNER (skora bakmaz).
-- claim_token ile forfeit eden kimliği doğrulanır → başkası adına forfeit
-- engellenir. Conditional update (status='playing') ile double-call no-op.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_forfeit_game(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room      public.duel_rooms;
  v_winner_id uuid;
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Rakibi bul (room'daki diğer player). Yoksa winner=null bırak.
  select id into v_winner_id
    from public.duel_players
   where room_id = p_room_id and id <> p_player_id
   limit 1;

  update public.duel_rooms
     set status              = 'finished',
         finished_at         = now(),
         finished_reason     = 'forfeit',
         forfeited_player_id = p_player_id,
         winner_player_id    = v_winner_id
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.duel_forfeit_game(uuid, uuid, uuid) from public;
grant  execute on function public.duel_forfeit_game(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) duel_handle_disconnect
-- ----------------------------------------------------------------------------
-- Player-only. Reporter (caller) "rakip grace süresini aştı" diyor; server
-- bunu BAĞIMSIZ olarak doğrular.
--
-- Frontend iki kademeli disconnect tespiti yapıyor (DuelGame.tsx 1014–1025):
--   1) opp monitor "stale" baseline'ı = 45 sn (last_seen_at güncel değilse)
--   2) handleOppDisconnect içinde GRACE timer (duration_seconds<=60 → 20 sn,
--      <=120 → 30 sn, aksi → 45 sn — DuelGame.tsx:543)
-- Toplam: rakibin last_seen_at'inin en az (45 + GRACE) saniye eski olması.
-- Server da aynı toplam threshold'ı uygular:
--   THRESHOLD = 45 + GRACE
-- Bu ölçü tutarsa stale gerçek, finish yazılır. Aksi halde sessiz no-op
-- (raise YOK → reporter poll/realtime ile tekrar deneyebilir; client
-- saatinden bir kaç sn ileri olduğu için yanlış pozitif değil).
-- Started_at'ten bu yana hiç heartbeat atmamış (last_seen_at NULL) durum:
-- started_at + THRESHOLD threshold'una düşülür.
--
-- Stale gerçekten ise: status='finished', winner=reporter, reason='disconnect',
-- disconnected_player_id=opponent.id.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_handle_disconnect(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.duel_rooms;
  v_opp_id     uuid;
  v_opp_seen   timestamptz;
  v_grace_sec  int;
  v_baseline   timestamptz;
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Rakibi bul
  select id, last_seen_at into v_opp_id, v_opp_seen
    from public.duel_players
   where room_id = p_room_id and id <> p_player_id
   limit 1;

  if v_opp_id is null then
    -- Rakip yoksa zaten yalnız kaldık; bu RPC değil, forfeit/leave akışı.
    return v_room;
  end if;

  -- GRACE tablosu (DuelGame.tsx:543 ile birebir)
  v_grace_sec := case
    when coalesce(v_room.duration_seconds, 60) <= 60  then 20
    when coalesce(v_room.duration_seconds, 60) <= 120 then 30
    else 45
  end;
  -- Toplam threshold: 45 sn stale baseline + GRACE (frontend iki kademeli)
  v_grace_sec := 45 + v_grace_sec;

  -- Baseline: last_seen_at varsa onu kullan, yoksa started_at (ki o da yoksa
  -- şimdiyi alıp false döndür — yeni başlamış oda için disconnect anlamsız).
  v_baseline := coalesce(v_opp_seen, v_room.started_at, now());

  if v_baseline > (now() - make_interval(secs => v_grace_sec)) then
    -- Henüz threshold dolmadı → sessiz no-op
    return v_room;
  end if;

  update public.duel_rooms
     set status                 = 'finished',
         finished_at            = now(),
         finished_reason        = 'disconnect',
         winner_player_id       = p_player_id,
         disconnected_player_id = v_opp_id,
         disconnect_at          = v_opp_seen
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.duel_handle_disconnect(uuid, uuid, uuid) from public;
grant  execute on function public.duel_handle_disconnect(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) duel_heartbeat
-- ----------------------------------------------------------------------------
-- Player-only. Yalnız kendi satırının last_seen_at'ini günceller. claim_token
-- şart → başkası adına heartbeat (rakibin "yaşıyor" görünmesi spoof'u)
-- engellenir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_heartbeat(
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  update public.duel_players
     set last_seen_at = now()
   where id = p_player_id;
end;
$$;

revoke all     on function public.duel_heartbeat(uuid, uuid) from public;
grant  execute on function public.duel_heartbeat(uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) duel_accept_rematch
-- ----------------------------------------------------------------------------
-- Accepter (eski room'da player, claim_token ile doğrulanır) YENİ oda yaratır:
--   • status='waiting_rematch' (Quick Match'in pick etmemesi için)
--   • host_player_id = p_new_player_id (accepter yeni odanın host'u)
--   • duration_seconds + region eski odanın değerleri (DB'den okunur, client
--     paramından alınmaz → spoof engeli)
-- Sonra: yeni player satırı + yeni claim_token. Son adımda eski odanın
-- rematch_room_id'sini yeni oda id'sine günceller — requester realtime ile
-- yakalayıp duel_join_rematch_room'a düşer.
--
-- p_new_player_id ve p_new_claim_token client-üretimli (UUID); profile_id /
-- guest_id eski player satırından kopyalanır (kullanıcı kimliği aynı).
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

  -- 1) Yeni oda
  begin
    insert into public.duel_rooms (
      code, status, duration_seconds, region, room_source, host_player_id
    ) values (
      p_new_room_code,
      'waiting_rematch',
      v_old_room.duration_seconds,
      v_old_room.region,
      'manual',
      p_new_player_id
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
-- 10) duel_join_rematch_room
-- ----------------------------------------------------------------------------
-- Requester (eski round'daki rematch isteğini ilk yapan taraf) accepter'ın
-- yarattığı yeni odaya katılır. Yeni player_id + claim_token yine fresh.
-- Profile_id / guest_id kullanıcı kimliğinden gelir (client doldurur; auth.uid()
-- ile çapraz doğrulama yapılır).
--
-- Atomik akış:
--   1) status='waiting_rematch' olan satırı çek (lock).
--   2) Player insert (capacity guard = 2).
--   3) Claim insert.
--   4) Aynı transaction'da status='playing' + started_at=now() set.
-- Çıktı: güncel oda satırı (status='playing', started_at dolu).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_join_rematch_room(
  p_new_room_id uuid,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_claim_token uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room   public.duel_rooms;
  v_uid    uuid := auth.uid();
  v_count  int;
begin
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
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  select * into v_room from public.duel_rooms where id = p_new_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    raise exception 'room_finished' using errcode = 'P0001';
  end if;
  if v_room.status not in ('waiting_rematch', 'waiting') then
    raise exception 'room_not_waiting_rematch' using errcode = 'P0001';
  end if;

  -- Capacity guard
  select count(*) into v_count
    from public.duel_players where room_id = p_new_room_id;
  if v_count >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Player + claim
  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, btrim(p_name), 0, p_profile_id, p_guest_id, now()
  );

  insert into public.duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  -- Started_at hizalanmış heartbeat clock'u — opp monitor baseline'ı dürüst
  update public.duel_players
     set last_seen_at = now()
   where room_id = p_new_room_id;

  -- Atomik start
  update public.duel_rooms
     set status                 = 'playing',
         started_at             = now(),
         finished_at            = null,
         finished_reason        = null,
         winner_player_id       = null,
         forfeited_player_id    = null,
         disconnected_player_id = null,
         disconnect_at          = null
   where id = p_new_room_id
     and status in ('waiting_rematch', 'waiting')
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.duel_rooms where id = p_new_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.duel_join_rematch_room(uuid, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.duel_join_rematch_room(uuid, uuid, uuid, text, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 11) duel_leave_room
-- ----------------------------------------------------------------------------
-- Host ise oda DELETE (cascade ile players + claims). Değilse kendi satırını
-- DELETE; eğer odadaki son player çıktıysa odayı da DELETE et (cleanup).
--
-- Idempotent: oda/oyuncu yoksa sessiz no-op.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_host_id   uuid;
  v_room_id   uuid;
  v_remaining int;
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Önce odanın var olup olmadığını kesin ayır (v_host_id NULL hem "oda yok"
  -- hem "host_player_id kolonu NULL" anlamına gelebilir — M1 öncesi eski
  -- odalarda host_player_id NULL bırakıldı).
  select id, host_player_id into v_room_id, v_host_id
    from public.duel_rooms
   where id = p_room_id;

  if v_room_id is null then
    return;  -- oda yok → no-op
  end if;

  if v_host_id is not null and v_host_id = p_player_id then
    -- Host çıkışı: tüm oda silinsin (FK cascade ile players + player_claims)
    delete from public.duel_rooms where id = p_room_id;
    return;
  end if;

  -- Misafir çıkışı (veya host_player_id NULL olan eski oda): kendi satırı
  delete from public.duel_players
   where id = p_player_id and room_id = p_room_id;

  -- Oda boşaldıysa onu da temizle (DuelGame.tsx:1622 davranışıyla uyumlu)
  select count(*) into v_remaining
    from public.duel_players where room_id = p_room_id;
  if v_remaining = 0 then
    delete from public.duel_rooms where id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.duel_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.duel_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 12) duel_send_message
-- ----------------------------------------------------------------------------
-- LobbyChat'in (DuelGame.tsx tarafından kullanılan) duel_messages.insert
-- karşılığı — yalnız Duel 1v1 modu için.
--
-- Güvenlik:
--   • claim_token ile player_id authorize edilir.
--   • player_name CLIENT'TAN ALINMAZ; duel_players.name server-side fetch
--     edilir (rakip adıyla mesaj atma spoof'u engellenir).
--   • p_room_code, p_player_id'nin gerçek oda kodu mu? (cross-room spoof
--     engeli) — duel_rooms.code üzerinden doğrulanır.
--   • Mesaj uzunluğu 200 karakter ile sınırlı (LobbyChat MAX_LEN).
--
-- Geri dönüş: insert edilen duel_messages satırı (frontend optimistic'i bu
-- gerçek satırla replace eder).
--
-- NOT: Bu RPC yalnız 'Duel 1v1' (countries) odalarındaki mesajlar için
-- güvenlidir; conquest / wheel_group / wheel_duel modlarının kendi player
-- şeması farklı olduğu için onlar duel_send_message'i ÇAĞIRMAMALI. M3
-- aşamasında her mod kendi *_send_message RPC'sini alacak (veya ortak bir
-- mode-aware RPC tasarımı netleşene kadar duel_messages için partial
-- lockdown yapılacak).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_send_message(
  p_room_code   text,
  p_player_id   uuid,
  p_claim_token uuid,
  p_message     text
) returns public.duel_messages
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_player public.duel_players;
  v_room_code text;
  v_msg    public.duel_messages;
  v_trim   text;
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_room_code is null or length(btrim(p_room_code)) = 0 then
    raise exception 'room_code_required' using errcode = '22023';
  end if;
  if p_message is null then
    raise exception 'message_required' using errcode = '22023';
  end if;

  v_trim := btrim(p_message);
  if length(v_trim) = 0 then
    raise exception 'message_empty' using errcode = '22023';
  end if;
  if length(v_trim) > 200 then
    raise exception 'message_too_long' using errcode = '22023';
  end if;

  -- Player satırı + onun odasının code'unu çek
  select * into v_player from public.duel_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select code into v_room_code
    from public.duel_rooms
   where id = v_player.room_id;

  if v_room_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Cross-room spoof guard: caller'ın iddia ettiği room_code, player'ın
  -- gerçek odasının code'uyla aynı olmalı.
  if v_room_code <> p_room_code then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel, Studio SQL editor'de):
--
--   -- Tüm yeni RPC'ler mevcut + security definer?
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname like 'duel\_%' escape '\'
--      and proname not like 'duel_group_%'
--    order by proname;
--   -- Beklenen (M1+M2 birleşik):
--   --   duel_accept_rematch, duel_authorize_host, duel_authorize_player,
--   --   duel_create_room, duel_finish_game, duel_forfeit_game,
--   --   duel_handle_disconnect, duel_heartbeat, duel_join_rematch_room,
--   --   duel_join_room, duel_leave_room, duel_send_message,
--   --   duel_start_game, duel_submit_claim
--   -- Hepsinde prosecdef=true.
--
--   -- Grant kontrolü (anon + authenticated execute)
--   select p.proname, r.rolname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     join aclexplode(p.proacl) ae on true
--     join pg_roles r on r.oid = ae.grantee
--    where n.nspname = 'public'
--      and p.proname like 'duel\_%' escape '\'
--      and p.proname not like 'duel_group_%'
--      and ae.privilege_type = 'EXECUTE'
--    order by p.proname, r.rolname;
--
--   -- Mevcut duel_* RLS politikaları HÂLÂ YERİNDE olmalı (M2 dokunmaz):
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('duel_rooms', 'duel_players', 'duel_claims', 'duel_messages')
--    order by tablename, cmd;
--
-- Smoke test (2 oturum):
--   -- Oturum A (host):
--   select * from duel_create_room(
--     gen_random_uuid(),           -- p_player_id
--     null, 'guestA',              -- p_profile_id / p_guest_id
--     'Alice',                     -- p_name
--     'DUEL01',                    -- p_code
--     60, 'world',                 -- p_duration / p_region
--     gen_random_uuid()            -- p_claim_token
--   );
--
--   -- Oturum B (joiner):
--   select * from duel_join_room('DUEL01', gen_random_uuid(), null, 'guestB',
--                                'Bob', gen_random_uuid());
--
--   -- A startGame:
--   select * from duel_start_game('<room_id>', '<A player_id>', '<A token>');
--
--   -- B claim ülke:
--   select duel_submit_claim('<room_id>', '<B player_id>', '<B token>', 'TUR');
--
--   -- A finish (timeout):
--   select * from duel_finish_game('<room_id>', '<A player_id>', '<A token>');
--   -- winner_player_id = B'nin id'si olmalı (B'nin 1, A'nın 0 claim'i var)
-- ============================================================================
