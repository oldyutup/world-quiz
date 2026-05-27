-- ============================================================================
-- Wheel Duel — RLS hardening · M2 (RPC altyapısı, saf additive)
-- ============================================================================
-- AMAÇ
-- ----
-- M1'de eklenen claim-token + authorize helper'larının üstüne 12 aksiyon
-- RPC'sini ekler. Bu migration HİÇBİR mevcut davranışı değiştirmez:
--   • Mevcut "_anon" RLS politikaları yerinde kalır → eski direkt-yazma yolları
--     hâlâ çalışır.
--   • Frontend bu RPC'leri henüz çağırmıyor → canlı oyun bozulmaz.
--   • RPC'ler SECURITY DEFINER ile RLS'i bypass eder ve manuel authz yapar;
--     bu sayede M3'te RLS lockdown atıldığında frontend hazır olur.
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_*
--   • wheel_group_*
--   • flag_duel_queue / wheel_duel_queue (Wheel Duel quick match RPC'leri
--     dahil — onların imzasına dokunulmaz)
--   • conquest_*
--   • profiles, xp_events
--   • Mevcut wheel_duel_rooms / wheel_duel_players RLS politikaları
--   • supabase_realtime publication üyelikleri
--   • Mevcut wheel_duel_rooms / wheel_duel_players SATIRLARI (backfill yok)
--
-- YENİ RPC'LER (frontend write call-site karşılığı parantezde)
-- -----------------------------------------------------------
--   1) wheel_duel_create_room      (createRoom)
--   2) wheel_duel_join_room        (joinRoomByCode)
--   3) wheel_duel_start_game       (startGame)
--   4) wheel_duel_update_settings  (updateHostSetting)
--   5) wheel_duel_pick_target      (pickNextTarget)
--   6) wheel_duel_claim_target     (handleMapClick doğru dalı)
--   7) wheel_duel_request_pass     (requestPass)
--   8) wheel_duel_process_skip     (processSkip)
--   9) wheel_duel_finish_game      (finishGame)
--  10) wheel_duel_request_rematch  (requestRematch)
--  11) wheel_duel_process_rematch  (processRematch)
--  12) wheel_duel_leave_room       (leaveRoom)
--
-- GÜVENLİK İLKELERİ
-- -----------------
--   • Hepsi SECURITY DEFINER, set search_path = public, auth.
--   • wheel_duel_authorize_player / wheel_duel_authorize_host helper'ları
--     üzerinden manuel authz; aksi halde RLS bypass kazancı kaybolur.
--   • revoke all from public + grant execute to anon, authenticated.
--   • claim_target: skor artırımı server-side. Client değer GÖNDERMEZ.
--   • finish_game: winner_player_id wheel_duel_players.score'tan hesaplanır.
--   • process_rematch: current_match_id server-üretimli (gen_random_uuid()),
--     XP idempotency anahtarı manipülasyona karşı sertleşir.
--
-- ERROR CODE KONVANSİYONU
-- -----------------------
--   • 42501 (insufficient_privilege)  → unauthorized / profile_mismatch
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
-- 1) wheel_duel_create_room
-- ----------------------------------------------------------------------------
-- Oda + host player + claim_token tek transaction'da. Frontend createRoom'un
-- karşılığı. Orphan-room rollback gerekmez (function rollback ile garantili).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_create_room(
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_code        text,
  p_duration    int,
  p_region      text,
  p_claim_token uuid
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_duel_rooms;
  v_uid  uuid := auth.uid();
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

  -- 1) Oda satırı (UNIQUE(code) çakışırsa kullanıcı dostu hata)
  begin
    insert into public.wheel_duel_rooms (
      code, status, duration_seconds, region, host_player_id
    ) values (
      p_code, 'waiting', p_duration, p_region, p_player_id
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Host player satırı
  insert into public.wheel_duel_players (
    id, room_id, name, score, profile_id, guest_id
  ) values (
    p_player_id, v_room.id, btrim(p_name), 0, p_profile_id, p_guest_id
  );

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.wheel_duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_create_room(uuid, uuid, text, text, text, int, text, uuid) from public;
grant  execute on function public.wheel_duel_create_room(uuid, uuid, text, text, text, int, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) wheel_duel_join_room
-- ----------------------------------------------------------------------------
-- Kod ile odaya katılma + player + claim tek transaction'da. Kapasite & isim
-- çakışması server-side; client-side kontroller artık UX-only.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_join_room(
  p_code        text,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_claim_token uuid
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.wheel_duel_rooms;
  v_uid   uuid := auth.uid();
  v_count int;
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
  if p_player_id is null then
    raise exception 'player_id_required' using errcode = '22023';
  end if;
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;
  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;

  -- Oda lookup (kilitle: kapasite check ile insert arası race)
  select * into v_room
    from public.wheel_duel_rooms
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
    select 1 from public.wheel_duel_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(btrim(p_name))
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  -- Kapasite
  select count(*) into v_count
    from public.wheel_duel_players
   where room_id = v_room.id;
  if v_count >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Player + claim
  insert into public.wheel_duel_players (
    id, room_id, name, score, profile_id, guest_id
  ) values (
    p_player_id, v_room.id, btrim(p_name), 0, p_profile_id, p_guest_id
  );

  insert into public.wheel_duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  -- updated_at trigger room satırını taze gösterir → realtime sinyali
  update public.wheel_duel_rooms set updated_at = now() where id = v_room.id;

  -- Güncel satırı geri döndür
  select * into v_room from public.wheel_duel_rooms where id = v_room.id;
  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_join_room(text, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.wheel_duel_join_room(text, uuid, uuid, text, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) wheel_duel_start_game
-- ----------------------------------------------------------------------------
-- Host-only. started_at server tarafında now() ile yazılır (clock skew kapanır).
-- Players count = 2 zorunluluğu burada.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_first_target   text
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.wheel_duel_rooms;
  v_count int;
begin
  if not public.wheel_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_first_target is null or length(btrim(p_first_target)) = 0 then
    raise exception 'first_target_required' using errcode = '22023';
  end if;

  -- Status + kapasite guard
  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from public.wheel_duel_players where room_id = p_room_id;
  if v_count < 2 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;

  update public.wheel_duel_rooms
     set status                = 'playing',
         started_at            = now(),
         finished_at           = null,
         finished_reason       = null,
         winner_player_id      = null,
         current_target_topoid = p_first_target,
         used_target_topoids   = '{}',
         pass_requested_by     = '{}',
         pass_target_topoid    = null,
         rematch_requested_by  = '{}'
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_start_game(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_start_game(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) wheel_duel_update_settings
-- ----------------------------------------------------------------------------
-- Host-only, sadece lobby fazında. duration veya region NULL geçilirse o alana
-- dokunulmaz (partial update).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_update_settings(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_duration       int,
  p_region         text
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_duel_rooms;
begin
  if not public.wheel_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_duration is not null and p_duration <= 0 then
    raise exception 'duration_invalid' using errcode = '22023';
  end if;
  if p_region is not null and length(btrim(p_region)) = 0 then
    raise exception 'region_invalid' using errcode = '22023';
  end if;

  update public.wheel_duel_rooms
     set duration_seconds = coalesce(p_duration, duration_seconds),
         region           = coalesce(p_region,   region)
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_update_settings(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.wheel_duel_update_settings(uuid, uuid, uuid, int, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) wheel_duel_pick_target
-- ----------------------------------------------------------------------------
-- Host-only. Sadece current_target_topoid IS NULL iken yeni hedef yazar
-- (atomik guard double-pick'i engeller).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_pick_target(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_target         text
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.wheel_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target is null or length(btrim(p_target)) = 0 then
    raise exception 'target_required' using errcode = '22023';
  end if;

  -- Atomik: status=playing + current=null guard. Çakışırsa sessiz no-op.
  update public.wheel_duel_rooms
     set current_target_topoid = p_target,
         pass_requested_by     = '{}',
         pass_target_topoid    = null
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid is null;
end;
$$;

revoke all     on function public.wheel_duel_pick_target(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_pick_target(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) wheel_duel_claim_target
-- ----------------------------------------------------------------------------
-- Atomik claim + skor artırımı. SKOR SERVER-SIDE; client değer GÖNDERMEZ.
-- Yarış kaybedilirse claimed=false, skor değişmez.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_claim_target(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_target      text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_claimed_id uuid;
  v_new_score  int;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target is null or length(btrim(p_target)) = 0 then
    raise exception 'target_required' using errcode = '22023';
  end if;

  -- Oyuncu gerçekten bu odada mı? (cross-room sömürüyü kapatır)
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Atomik claim: yalnız beklenen hedef hâlâ aktifse yaz.
  update public.wheel_duel_rooms
     set current_target_topoid = null,
         used_target_topoids   = array_append(coalesce(used_target_topoids, '{}'), p_target),
         pass_requested_by     = '{}',
         pass_target_topoid    = null
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid = p_target
   returning id into v_claimed_id;

  if v_claimed_id is null then
    -- Yarışı kaybettin, bayat hedef veya status değişmiş → sessiz no-op
    return jsonb_build_object('claimed', false, 'new_score', null);
  end if;

  -- Aynı transaction: skor +1
  update public.wheel_duel_players
     set score = score + 1
   where id = p_player_id
   returning score into v_new_score;

  return jsonb_build_object('claimed', true, 'new_score', v_new_score);
end;
$$;

revoke all     on function public.wheel_duel_claim_target(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_claim_target(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) wheel_duel_request_pass
-- ----------------------------------------------------------------------------
-- Player-only. Idempotent: aynı oyuncudan ikinci çağrı no-op. Hedef bayatladıysa
-- (target != current) sessiz no-op (guard koşul update'i tutmaz).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_request_pass(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_target      text
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target is null or length(btrim(p_target)) = 0 then
    raise exception 'target_required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Atomik: aynı target için idempotent append.
  -- pass_target_topoid bayatsa (eski hedeften kalan oylar) listeyi resetleyip
  -- mevcut caller'ı tek oy olarak yaz.
  update public.wheel_duel_rooms
     set pass_target_topoid = current_target_topoid,
         pass_requested_by  = case
           when pass_target_topoid is distinct from current_target_topoid
             then array[p_player_id]::uuid[]
           when p_player_id = any(coalesce(pass_requested_by, '{}'::uuid[]))
             then pass_requested_by
           else array_append(coalesce(pass_requested_by, '{}'::uuid[]), p_player_id)
         end
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid = p_target;
end;
$$;

revoke all     on function public.wheel_duel_request_pass(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_request_pass(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) wheel_duel_process_skip
-- ----------------------------------------------------------------------------
-- Host-only. İki oy toplandığında atomik skip. Çakışma / yetersiz oy → no-op.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_process_skip(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.wheel_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  update public.wheel_duel_rooms
     set used_target_topoids   = array_append(coalesce(used_target_topoids, '{}'), current_target_topoid),
         current_target_topoid = null,
         pass_requested_by     = '{}',
         pass_target_topoid    = null
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid is not null
     and pass_target_topoid = current_target_topoid
     and array_length(coalesce(pass_requested_by, '{}'::uuid[]), 1) >= 2;
end;
$$;

revoke all     on function public.wheel_duel_process_skip(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_process_skip(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) wheel_duel_finish_game
-- ----------------------------------------------------------------------------
-- Host-only. winner_player_id SERVER-SIDE hesaplanır:
--   • Tek oyuncu varsa → o.
--   • İki oyuncu, skorlar farklıysa → yüksek skorlu.
--   • Skorlar eşitse → null (beraberlik).
-- Client'tan winner parametre ALINMAZ.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_finish_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_reason         text
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room      public.wheel_duel_rooms;
  v_winner_id uuid;
  v_count     int;
  v_top_score int;
  v_second    int;
begin
  if not public.wheel_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  -- Status guard
  if not exists (
    select 1 from public.wheel_duel_rooms where id = p_room_id and status = 'playing'
  ) then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Skorları sırala, ilk iki satırı al
  select count(*) into v_count from public.wheel_duel_players where room_id = p_room_id;

  if v_count = 0 then
    v_winner_id := null;
  elsif v_count = 1 then
    select id into v_winner_id
      from public.wheel_duel_players
     where room_id = p_room_id
     limit 1;
  else
    -- En yüksek skor (varsa ikinci skoru da çek)
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
      v_winner_id := null;  -- beraberlik
    else
      select id into v_winner_id
        from public.wheel_duel_players
       where room_id = p_room_id
       order by score desc, joined_at asc
       limit 1;
    end if;
  end if;

  update public.wheel_duel_rooms
     set status                = 'finished',
         finished_at           = now(),
         finished_reason       = btrim(p_reason),
         winner_player_id      = v_winner_id,
         current_target_topoid = null
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_finish_game(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_finish_game(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 10) wheel_duel_request_rematch
-- ----------------------------------------------------------------------------
-- Player-only. Idempotent array_append. status='finished' guard.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_request_rematch(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  update public.wheel_duel_rooms
     set rematch_requested_by =
           case when p_player_id = any(coalesce(rematch_requested_by, '{}'::uuid[]))
                then rematch_requested_by
                else array_append(coalesce(rematch_requested_by, '{}'::uuid[]), p_player_id)
           end
   where id = p_room_id
     and status = 'finished';
end;
$$;

revoke all     on function public.wheel_duel_request_rematch(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_request_rematch(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 11) wheel_duel_process_rematch
-- ----------------------------------------------------------------------------
-- Host-only. ≥2 oy varsa atomik reset:
--   • Tüm wheel_duel_players.score = 0 (room_id eşit)
--   • wheel_duel_rooms tüm gameplay alanlarını sıfırlar
--   • match_seq + 1, current_match_id = gen_random_uuid() (SERVER-SIDE)
-- plpgsql function tek transaction → iki UPDATE atomik.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_process_rematch(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_duel_rooms;
begin
  if not public.wheel_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Status + oy sayısı guard
  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'finished' then
    raise exception 'room_not_finished' using errcode = 'P0001';
  end if;
  -- array_length(empty, 1) NULL döner → coalesce(..., 0) ile sarıp guardı
  -- gerçekten zorla (NULL < 2 = NULL = false olur, oy olmadığında raise atlanırdı).
  if coalesce(array_length(v_room.rematch_requested_by, 1), 0) < 2 then
    raise exception 'not_enough_votes' using errcode = 'P0001';
  end if;

  -- 1) Skorları sıfırla
  update public.wheel_duel_players
     set score = 0
   where room_id = p_room_id;

  -- 2) Room reset (atomik guard yine status='finished')
  update public.wheel_duel_rooms
     set status                = 'waiting',
         started_at            = null,
         finished_at           = null,
         finished_reason       = null,
         winner_player_id      = null,
         current_target_topoid = null,
         used_target_topoids   = '{}',
         pass_requested_by     = '{}',
         pass_target_topoid    = null,
         rematch_requested_by  = '{}',
         match_seq             = coalesce(match_seq, 1) + 1,
         current_match_id      = gen_random_uuid()
   where id = p_room_id
     and status = 'finished'
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_process_rematch(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_process_rematch(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 12) wheel_duel_leave_room
-- ----------------------------------------------------------------------------
-- Host ise oda DELETE (cascade ile players). Değilse kendi satırını DELETE.
-- Idempotent: oda/oyuncu yoksa sessiz no-op.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_is_host boolean;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select (host_player_id = p_player_id) into v_is_host
    from public.wheel_duel_rooms
   where id = p_room_id;

  if v_is_host is null then
    return;  -- oda yok → idempotent no-op
  end if;

  if v_is_host then
    -- Cascade: wheel_duel_players + wheel_duel_player_claims temizlenir
    delete from public.wheel_duel_rooms where id = p_room_id;
  else
    delete from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.wheel_duel_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel):
--
--   -- Tüm RPC'ler mevcut + security definer?
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname like 'wheel_duel_%'
--    order by proname;
--   -- Beklenen yeni satırlar (prosecdef=true):
--   --   wheel_duel_authorize_host, wheel_duel_authorize_player (M1),
--   --   wheel_duel_create_room, wheel_duel_join_room, wheel_duel_start_game,
--   --   wheel_duel_update_settings, wheel_duel_pick_target,
--   --   wheel_duel_claim_target, wheel_duel_request_pass,
--   --   wheel_duel_process_skip, wheel_duel_finish_game,
--   --   wheel_duel_request_rematch, wheel_duel_process_rematch,
--   --   wheel_duel_leave_room
--
--   -- Grant kontrolü (anon + authenticated execute)
--   select p.proname, r.rolname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     join aclexplode(p.proacl) ae on true
--     join pg_roles r on r.oid = ae.grantee
--    where n.nspname = 'public'
--      and p.proname like 'wheel_duel_%'
--      and ae.privilege_type = 'EXECUTE'
--    order by p.proname, r.rolname;
--
--   -- Mevcut RLS politikaları HÂLÂ YERİNDE (M2 dokunmaz):
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('wheel_duel_rooms', 'wheel_duel_players')
--    order by tablename, cmd;
-- ============================================================================
