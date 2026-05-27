-- ============================================================================
-- Duel Group (Online Çok Oyunculu Ülke Yaz) — RLS hardening · M2 (RPC altyapısı)
-- ============================================================================
-- AMAÇ
-- ----
-- M1'de eklenen claim-token + duel_group_authorize_player / authorize_host
-- helper'larının üstüne 11 aksiyon RPC'sini ekler. Bu migration HİÇBİR mevcut
-- davranışı değiştirmez:
--   • duel_group_rooms / duel_group_players / duel_group_claims MEVCUT geniş
--     RLS politikaları (Studio'da kurulmuş `anon_all_group_*` + M0
--     `duel_group_claims_all_authenticated`) yerinde kalır → DuelGroupGame.tsx
--     mevcut direkt-yazma yolları çalışmaya devam eder.
--   • Frontend bu RPC'leri henüz çağırmıyor → FE switch ayrı adımda.
--   • RPC'ler SECURITY DEFINER ile RLS bypass eder ve manuel authz yapar;
--     M3 (RLS lockdown) atıldığında frontend bu RPC'lere geçmiş olur.
--
-- M1 → M2 → FE switch → M3 sıralaması wheel_duel + wheel_group + conquest +
-- duel 1v1 hardening'inde dört kez doğrulandı (20260527–20260606). Bu dosya
-- aynı pattern'in Duel Group karşılığıdır; Wheel Group M2 yapısına en yakın
-- (her ikisi de 3–10 kişi, is_host kolonu temelli ve return_to_lobby kavramı
-- olan modlar).
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_group_rooms / duel_group_players / duel_group_claims MEVCUT RLS
--     politikaları (anon_all_group_*, duel_group_claims_all_authenticated)
--   • duel_group_rooms_cleanup_after_player_delete trigger
--     (20260520130000) ve onun açtığı duel_group_players REPLICA IDENTITY FULL
--   • supabase_realtime publication üyelikleri (duel_group_rooms,
--     duel_group_players, duel_group_claims olduğu gibi kalır)
--   • duel_group_player_claims tablosu, policy'si ve grant'leri (M1)
--   • duel_group_authorize_player / duel_group_authorize_host helper'ları (M1)
--   • duel_messages tablosu (paylaşımlı chat — Duel Group LobbyChat default
--     "direct" yolunu kullanıyor; global chat hardening ayrı M4 adımı)
--   • duel_* (Duel 1v1) — M1+M2+M3+patch ile sertleşti
--   • wheel_duel_*, wheel_group_*, conquest_* — kendi setleri
--   • flag_duel_queue + flag_duel_quick_match / cancel RPC'leri
--   • Mevcut duel_group_rooms / duel_group_players SATIRLARI (backfill yok)
--
-- YENİ RPC'LER (frontend write call-site karşılığı parantezde)
-- -----------------------------------------------------------
--    1) duel_group_create_room      (DuelGroupGame.tsx:776 createRoom)
--    2) duel_group_join_room        (DuelGroupGame.tsx:852 joinRoom)
--    3) duel_group_update_settings  (DuelGroupGame.tsx:952 updateRoomSettings)
--    4) duel_group_start_game       (DuelGroupGame.tsx:982 startGame —
--                                    claims DELETE + players UPDATE +
--                                    rooms UPDATE atomik)
--    5) duel_group_submit_claim     (DuelGroupGame.tsx:1038 handleGuess —
--                                    stale-claim retry server-side)
--    6) duel_group_finish_game      (DuelGroupGame.tsx:711 finishGameByTimeout)
--    7) duel_group_return_to_lobby  (DuelGroupGame.tsx:1215 returnToRoom)
--    8) duel_group_kick_player      (DuelGroupGame.tsx:1150 kickPlayer)
--    9) duel_group_leave_room       (DuelGroupGame.tsx:1184 backToLobby +
--                                    1264 forfeit + 1115
--                                    reconcileRoomAfterLeave)
--   10) duel_group_heartbeat        (DuelGroupGame.tsx:661 touchHeartbeat)
--   11) duel_group_mark_finished    (DuelGroupGame.tsx:630 per-player finish
--                                    marking useEffect)
--
-- GÜVENLİK İLKELERİ
-- -----------------
--   • Hepsi SECURITY DEFINER, set search_path = public, auth.
--   • duel_group_authorize_player / duel_group_authorize_host helper'ları
--     üzerinden manuel authz; aksi halde RLS bypass kazancı kaybolur.
--   • revoke all from public + grant execute to anon, authenticated.
--   • submit_claim: claim insert server-side + stale-claim retry (önceki maçın
--     started_at'inden eski satır varsa sil + retry — DuelGroupGame.tsx:1048).
--   • start_game: claims DELETE + players reset + room update tek transaction
--     (frontend'de üç ayrı DML idi; race penceresi kapanır).
--   • finish_game: conditional update (status='playing' guard) → double-call
--     no-op (any client tetikleyebilir, atomik kazanır).
--   • return_to_lobby: HOST-ONLY. Caller host değilse 'unauthorized'.
--   • kick_player: HOST-ONLY, self-kick reddedilir, lobby-only.
--   • leave_room: caller-only. Host ise host transfer (en eski joined_at'e
--     sahip BAŞKA player → is_host=true) + self DELETE; yalnız host ise oda
--     DELETE (cascade). Atomik (FOR UPDATE lock).
--   • heartbeat: yalnız kendi last_seen_at; başkası adına spoof yok.
--   • mark_finished: yalnız kendi status='finished'.
--
-- ERROR CODE KONVANSİYONU
-- -----------------------
--   • 42501 (insufficient_privilege)  → unauthorized / profile_mismatch /
--                                       player_room_mismatch / cannot_kick_self
--   • 22023 (invalid_parameter_value) → input validation
--   • P0001 (raise_exception)         → business rule (code_taken, room_full,
--                                       name_taken, room_not_*, max_players_too_low,
--                                       not_enough_players, ...)
--   • 02000 (no_data)                 → room_not_found / player_not_found
--
-- IDEMPOTENT
-- ----------
--   • Tüm fonksiyonlar "create or replace" → migration tekrar koşulursa
--     temiz şekilde üzerine yazılır. İmza değişmediği sürece sorun yok.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_group_create_room
-- ----------------------------------------------------------------------------
-- Oda + host player + claim_token tek transaction'da. Frontend createRoom'un
-- karşılığı. Orphan-room rollback gerekmez (function rollback ile garantili).
--
-- max_players 3–10 aralığında olmalı (DuelGroupGame.tsx MIN_PLAYERS=3,
-- MAX_PLAYERS=10 — UI'da safeMax ile clamp ediliyor, sunucu da kontrol eder).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_create_room(
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_code        text,
  p_duration    int,
  p_region      text,
  p_max_players int,
  p_claim_token uuid
) returns public.duel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.duel_group_rooms;
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
  if p_max_players is null or p_max_players < 3 or p_max_players > 10 then
    raise exception 'max_players_invalid' using errcode = '22023';
  end if;

  -- 1) Oda satırı (UNIQUE(code) çakışırsa kullanıcı dostu hata)
  begin
    insert into public.duel_group_rooms (
      code, status, duration_seconds, region, max_players
    ) values (
      p_code, 'waiting', p_duration, p_region, p_max_players
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Host player (is_host=true)
  insert into public.duel_group_players (
    id, room_id, name, is_host, status, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, btrim(p_name), true, 'waiting',
    p_profile_id, p_guest_id, now()
  );

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.duel_group_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.duel_group_create_room(uuid, uuid, text, text, text, int, text, int, uuid) from public;
grant  execute on function public.duel_group_create_room(uuid, uuid, text, text, text, int, text, int, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) duel_group_join_room
-- ----------------------------------------------------------------------------
-- Kod ile odaya katılma + player + claim tek transaction'da. Kapasite ile
-- isim çakışması server-side; client-side kontroller artık UX-only.
--
-- Resume akışı (savedSession.roomCode == code) frontend RPC dışı yoldan
-- destekleniyor (mevcut player satırı varsa duplicate insert atmıyor); M2
-- bu RPC'yi yalnız fresh join için tasarlar — resume akışı M3 öncesi FE
-- switch'inde "session restore" branch'i ile çözülür (Duel 1v1'deki pattern).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_join_room(
  p_code        text,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_claim_token uuid
) returns public.duel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.duel_group_rooms;
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

  -- Oda lookup + lock (race: kapasite check ile insert arası)
  select * into v_room
    from public.duel_group_rooms
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
    raise exception 'room_unavailable' using errcode = 'P0001';
  end if;

  -- İsim çakışması (case-insensitive btrim)
  if exists (
    select 1 from public.duel_group_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(btrim(p_name))
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  -- Kapasite
  select count(*) into v_count
    from public.duel_group_players
   where room_id = v_room.id;
  if v_count >= coalesce(v_room.max_players, 10) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Player (is_host=false) + claim
  insert into public.duel_group_players (
    id, room_id, name, is_host, status, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, btrim(p_name), false, 'waiting',
    p_profile_id, p_guest_id, now()
  );

  insert into public.duel_group_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  -- updated_at trigger room satırını taze gösterir → realtime sinyali
  update public.duel_group_rooms
     set updated_at = now()
   where id = v_room.id;

  select * into v_room from public.duel_group_rooms where id = v_room.id;
  return v_room;
end;
$$;

revoke all     on function public.duel_group_join_room(text, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.duel_group_join_room(text, uuid, uuid, text, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) duel_group_update_settings
-- ----------------------------------------------------------------------------
-- Host-only, sadece lobby fazında. duration / region / max_players NULL
-- geçilirse o alana dokunulmaz (partial update). max_players mevcut
-- player sayısının ALTINA inemez (frontend de aynı guard'ı yapıyor; sunucu
-- da kontrol eder).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_update_settings(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_duration       int,
  p_region         text,
  p_max_players    int
) returns public.duel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.duel_group_rooms;
  v_count      int;
begin
  if not public.duel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_duration is not null and p_duration <= 0 then
    raise exception 'duration_invalid' using errcode = '22023';
  end if;
  if p_region is not null and length(btrim(p_region)) = 0 then
    raise exception 'region_invalid' using errcode = '22023';
  end if;
  if p_max_players is not null and (p_max_players < 3 or p_max_players > 10) then
    raise exception 'max_players_invalid' using errcode = '22023';
  end if;

  if p_max_players is not null then
    select count(*) into v_count
      from public.duel_group_players
     where room_id = p_room_id;
    if p_max_players < v_count then
      raise exception 'max_players_too_low' using errcode = 'P0001';
    end if;
  end if;

  update public.duel_group_rooms
     set duration_seconds = coalesce(p_duration,    duration_seconds),
         region           = coalesce(p_region,      region),
         max_players      = coalesce(p_max_players, max_players),
         updated_at       = now()
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  return v_room;
end;
$$;

revoke all     on function public.duel_group_update_settings(uuid, uuid, uuid, int, text, int) from public;
grant  execute on function public.duel_group_update_settings(uuid, uuid, uuid, int, text, int) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) duel_group_start_game
-- ----------------------------------------------------------------------------
-- Host-only. Üç işlem tek transaction'da:
--   (a) duel_group_claims DELETE — eski maçtan kalan satırları temizle.
--       Frontend 23505 stale-claim retry yapıyordu (DuelGroupGame.tsx:1048);
--       buradaki temizlik o güvenlik ağını gereksiz bırakır ama submit_claim
--       içinde stale retry mantığı yine de korunur (defense-in-depth).
--   (b) duel_group_players UPDATE status='playing', last_seen_at=now()
--   (c) duel_group_rooms UPDATE status='playing', started_at=now(),
--       updated_at=now()
--
-- Players count >= 3 (MIN_PLAYERS) zorunluluğu burada.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns public.duel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.duel_group_rooms;
  v_count int;
begin
  if not public.duel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Status guard + kilitle
  select * into v_room from public.duel_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  -- En az 3 oyuncu (MIN_PLAYERS)
  select count(*) into v_count
    from public.duel_group_players where room_id = p_room_id;
  if v_count < 3 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;

  -- (a) Eski maçın claim'lerini temizle (atomik clean slate)
  delete from public.duel_group_claims where room_id = p_room_id;

  -- (b) Players status reset (last_seen_at hizala → opp/idle monitor baseline)
  update public.duel_group_players
     set status       = 'playing',
         last_seen_at = now()
   where room_id = p_room_id;

  -- (c) Room status update
  update public.duel_group_rooms
     set status     = 'playing',
         started_at = now(),
         updated_at = now()
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.duel_group_start_game(uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_start_game(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) duel_group_submit_claim
-- ----------------------------------------------------------------------------
-- Player-only. Claim insert server-side; başkası adına yazma engellenir.
-- Stale-claim retry mantığı (DuelGroupGame.tsx:1048) server-side: önceki
-- maçtan kalmış (created_at < started_at) satır UNIQUE çakışmasına yol açarsa
-- silinip retry edilir. Defense-in-depth: start_game zaten claims'i siliyor
-- olsa da host hiç çalıştıramamış olabilir veya geç gelen INSERT yarışı
-- bozmuş olabilir.
--
-- Dönüş: jsonb { claimed: bool, reason?: 'dup' | 'stale_retry_failed' }
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_submit_claim(
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
  v_room        public.duel_group_rooms;
  v_existing_id bigint;
  v_existing_ts timestamptz;
begin
  if not public.duel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_country_code is null or length(btrim(p_country_code)) = 0 then
    raise exception 'country_code_required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.duel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.duel_group_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- 1. deneme: doğrudan insert
  begin
    insert into public.duel_group_claims (room_id, player_id, country_code)
    values (p_room_id, p_player_id, p_country_code);
    return jsonb_build_object('claimed', true);
  exception
    when unique_violation then
      -- Devam → stale-claim retry
      null;
  end;

  -- Stale-claim kontrolü: önceki maçtan kalma satır mı?
  if v_room.started_at is not null then
    select id, created_at
      into v_existing_id, v_existing_ts
      from public.duel_group_claims
     where room_id      = p_room_id
       and country_code = p_country_code
     limit 1;

    if v_existing_id is not null and v_existing_ts < v_room.started_at then
      -- Stale → sil ve retry
      delete from public.duel_group_claims where id = v_existing_id;

      begin
        insert into public.duel_group_claims (room_id, player_id, country_code)
        values (p_room_id, p_player_id, p_country_code);
        return jsonb_build_object('claimed', true);
      exception
        when unique_violation then
          -- Aynı anda başkası da retry kazandı → gerçekten dup
          return jsonb_build_object('claimed', false, 'reason', 'dup');
      end;
    end if;
  end if;

  -- Bu maçta yazılmış → genuine dup
  return jsonb_build_object('claimed', false, 'reason', 'dup');
end;
$$;

revoke all     on function public.duel_group_submit_claim(uuid, uuid, uuid, text) from public;
grant  execute on function public.duel_group_submit_claim(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) duel_group_finish_game
-- ----------------------------------------------------------------------------
-- Player-in-room. Timeout senaryosu — herhangi bir oyuncu tetikleyebilir
-- (DuelGroupGame.tsx:702 finishGameByTimeout: ANY client). Conditional update
-- (status='playing') → double-call no-op (idempotent).
--
-- Skor / leaderboard hesabı CLIENT'TA (freezeLeaderboard duel_group_claims
-- COUNT'undan); RPC sadece status'u 'finished'a çevirir. Leaderboard verisi
-- SELECT yollarıyla okunmaya devam eder.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_finish_game(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.duel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.duel_group_rooms;
begin
  if not public.duel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.duel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.duel_group_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  update public.duel_group_rooms
     set status     = 'finished',
         updated_at = now()
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.duel_group_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.duel_group_finish_game(uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_finish_game(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) duel_group_return_to_lobby
-- ----------------------------------------------------------------------------
-- HOST-ONLY. status='finished' → 'waiting'. Aynı zamanda caller'ın kendi
-- player satırının status'unu 'waiting' yapar (DuelGroupGame.tsx:1249 ile
-- uyumlu — host hem oda hem kendisi için reset atıyor).
--
-- NOT: Misafir oyuncuların kendi player satırlarını 'waiting'e çekmesi için
-- duel_group_mark_finished'a SİMETRİK ayrı bir mark_waiting RPC ekleyebilirdik,
-- fakat mevcut frontend akışında misafirler return_to_lobby tetiklemez —
-- realtime room UPDATE'i ile status='waiting' yakaladıklarında kendi
-- satırlarını başka bir mekanizmayla update etmiyor (DuelGroupGame.tsx:1249
-- yalnız caller'ın kendi satırını günceller). Bu RPC host caller için
-- room + caller'ın kendi satırı reset eder; diğer misafirlerin player.status
-- realtime UI tarafında waitingPlayers filtresi ile zaten "status='waiting'"
-- olarak değerlendirilmiyor — frontend doğrudan room.status='waiting' ile
-- waiting phase'e dönüyor.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_return_to_lobby(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns public.duel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.duel_group_rooms;
begin
  if not public.duel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  update public.duel_group_rooms
     set status     = 'waiting',
         started_at = null,
         updated_at = now()
   where id = p_room_id
     and status = 'finished'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_finished' using errcode = 'P0001';
  end if;

  -- Host'un kendi satırını da waiting'e çek (DuelGroupGame.tsx:1249)
  update public.duel_group_players
     set status       = 'waiting',
         last_seen_at = now()
   where id = p_host_player_id
     and room_id = p_room_id;

  return v_room;
end;
$$;

revoke all     on function public.duel_group_return_to_lobby(uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_return_to_lobby(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) duel_group_kick_player
-- ----------------------------------------------------------------------------
-- HOST-ONLY, lobby-only (status='waiting'). Self-kick reddedilir. Hedef
-- bulunamazsa sessiz no-op (idempotent — zaten ayrılmış).
--
-- Hedefi sildikten sonra HOST INVARIANT korunur — caller zaten host olduğu
-- için reconcile'a gerek yok (host kalır). Cascade ile target'ın
-- duel_group_player_claims satırı da temizlenir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_kick_player(
  p_room_id          uuid,
  p_host_player_id   uuid,
  p_host_claim_token uuid,
  p_target_player_id uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.duel_group_rooms;
begin
  if not public.duel_group_authorize_host(p_room_id, p_host_player_id, p_host_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target_player_id is null then
    raise exception 'target_player_required' using errcode = '22023';
  end if;
  if p_target_player_id = p_host_player_id then
    raise exception 'cannot_kick_self' using errcode = 'P0001';
  end if;

  -- Lobby-only guard (kick playing/finished fazında yapılmaz)
  select * into v_room from public.duel_group_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  -- Hedef yoksa idempotent no-op
  delete from public.duel_group_players
   where id = p_target_player_id
     and room_id = p_room_id;
end;
$$;

revoke all     on function public.duel_group_kick_player(uuid, uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_kick_player(uuid, uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) duel_group_leave_room
-- ----------------------------------------------------------------------------
-- Caller-only (authorize_player). Üç dal tek transaction:
--   • Host & başkası varsa: en eski joined_at'e sahip BAŞKA player'ı
--     is_host=true yap, sonra kendi satırını sil.
--   • Host & yalnız: tüm odayı sil (FK cascade ile players + claims +
--     player_claims). (Trigger 20260520130000_duel_group_room_cleanup
--     zaten bu işi yapıyor — bu RPC onu tetikler veya öncelikli olarak
--     kendisi yapar, idempotency korunur.)
--   • Non-host: kendi satırını sil; trigger oda boşalırsa cleanup yapar.
--
-- Oda satırı FOR UPDATE ile kilitlenir → host transfer + concurrent leave
-- yarış penceresi kapanır. Oda yoksa idempotent no-op.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room        public.duel_group_rooms;
  v_is_host     boolean;
  v_new_host_id uuid;
begin
  if not public.duel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Oda satırını kilitle
  select * into v_room from public.duel_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    return;  -- oda yok → idempotent no-op
  end if;

  -- Caller bu odada mı?
  select is_host into v_is_host
    from public.duel_group_players
   where id = p_player_id and room_id = p_room_id;

  if v_is_host is null then
    return;  -- bu odada değil → idempotent no-op
  end if;

  if v_is_host then
    -- En eski joined_at'e sahip BAŞKA oyuncuyu host yap; yoksa odayı sil
    select id into v_new_host_id
      from public.duel_group_players
     where room_id = p_room_id
       and id <> p_player_id
     order by joined_at asc
     limit 1;

    if v_new_host_id is not null then
      -- Host transfer + self DELETE (tek transaction)
      update public.duel_group_players
         set is_host      = true,
             last_seen_at = now()
       where id = v_new_host_id
         and room_id = p_room_id;

      delete from public.duel_group_players
       where id = p_player_id
         and room_id = p_room_id;
    else
      -- Yalnız host → odayı tamamen sil (FK cascade ile players + claims +
      -- player_claims hepsi temizlenir; trigger duplicate işi gereksiz yapar
      -- ama idempotent olduğu için sorun yok).
      delete from public.duel_group_rooms where id = p_room_id;
    end if;
  else
    -- Non-host: kendi satırını sil. Trigger oda boşalırsa cleanup yapar.
    delete from public.duel_group_players
     where id = p_player_id
       and room_id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.duel_group_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 10) duel_group_heartbeat
-- ----------------------------------------------------------------------------
-- Player-only. Yalnız kendi last_seen_at'ini günceller. claim_token şart →
-- başkası adına heartbeat (rakibin "yaşıyor" görünmesi spoof'u) engellenir.
--
-- Frontend touchHeartbeat (DuelGroupGame.tsx:656) 5 sn throttle ile çağırıyor;
-- RPC bu throttle'a güvenebilir (server-side ek throttle gerekmiyor).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_heartbeat(
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.duel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  update public.duel_group_players
     set last_seen_at = now()
   where id = p_player_id;
end;
$$;

revoke all     on function public.duel_group_heartbeat(uuid, uuid) from public;
grant  execute on function public.duel_group_heartbeat(uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 11) duel_group_mark_finished
-- ----------------------------------------------------------------------------
-- Player-only. Yalnız kendi status='finished' yapar (DuelGroupGame.tsx:627
-- per-player finish marking useEffect). Başkasının status'unu değiştirmeye
-- çalışmak unauthorized.
--
-- room_id paramı cross-room spoof guard'ı: caller hangi odada finish marker
-- olmak istediğini belirtir; player_id'nin bu odada olduğu doğrulanır.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_mark_finished(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.duel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.duel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  update public.duel_group_players
     set status       = 'finished',
         last_seen_at = now()
   where id = p_player_id
     and room_id = p_room_id;
end;
$$;

revoke all     on function public.duel_group_mark_finished(uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_mark_finished(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel, Studio SQL editor'de):
--
--   -- Tüm yeni RPC'ler mevcut + security definer?
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname like 'duel_group_%'
--    order by proname;
--   -- Beklenen (M1+M2 birleşik):
--   --   duel_group_authorize_host, duel_group_authorize_player (M1),
--   --   duel_group_create_room, duel_group_join_room,
--   --   duel_group_update_settings, duel_group_start_game,
--   --   duel_group_submit_claim, duel_group_finish_game,
--   --   duel_group_return_to_lobby, duel_group_kick_player,
--   --   duel_group_leave_room, duel_group_heartbeat,
--   --   duel_group_mark_finished
--   -- Hepsinde prosecdef=true.
--
--   -- Grant kontrolü (anon + authenticated execute)
--   select p.proname, r.rolname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     join aclexplode(p.proacl) ae on true
--     join pg_roles r on r.oid = ae.grantee
--    where n.nspname = 'public'
--      and p.proname like 'duel_group_%'
--      and ae.privilege_type = 'EXECUTE'
--    order by p.proname, r.rolname;
--
--   -- Mevcut duel_group_* RLS politikaları HÂLÂ YERİNDE (M2 dokunmaz):
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('duel_group_rooms', 'duel_group_players', 'duel_group_claims')
--    order by tablename, cmd;
--   -- Beklenen: anon_all_group_* + duel_group_claims_all_authenticated
--   -- olduğu gibi listelensin.
--
-- Smoke test (3 oturum, sırayla):
--   -- Oturum A (host):
--   select * from duel_group_create_room(
--     gen_random_uuid(), null, 'guestA', 'Alice', 'GRP001',
--     60, 'world', 5, gen_random_uuid()
--   );
--   -- Oturum B (joiner):
--   select * from duel_group_join_room('GRP001', gen_random_uuid(), null,
--                                       'guestB', 'Bob', gen_random_uuid());
--   -- Oturum C (joiner 2):
--   select * from duel_group_join_room('GRP001', gen_random_uuid(), null,
--                                       'guestC', 'Carol', gen_random_uuid());
--   -- A startGame:
--   select * from duel_group_start_game('<room>', '<A>', '<A token>');
--   -- B claim:
--   select duel_group_submit_claim('<room>', '<B>', '<B token>', 'TUR');
--   -- A finish:
--   select * from duel_group_finish_game('<room>', '<A>', '<A token>');
--   -- A return to lobby:
--   select * from duel_group_return_to_lobby('<room>', '<A>', '<A token>');
--   -- C leave:
--   select duel_group_leave_room('<room>', '<C>', '<C token>');
--   -- A kick B:
--   select duel_group_kick_player('<room>', '<A>', '<A token>', '<B>');
--   -- A heartbeat:
--   select duel_group_heartbeat('<A>', '<A token>');
--   -- A leave (yalnız → oda silinir):
--   select duel_group_leave_room('<room>', '<A>', '<A token>');
-- ============================================================================
