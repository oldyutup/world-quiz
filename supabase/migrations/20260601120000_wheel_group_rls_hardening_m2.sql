-- ============================================================================
-- Wheel Group — RLS hardening · M2 (RPC altyapısı, saf additive)
-- ============================================================================
-- AMAÇ
-- ----
-- M1'de eklenen claim-token + authorize helper'larının üstüne 10 aksiyon
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
--   • wheel_duel_* (M1/M2/M3 ayrı, dokunulmuyor)
--   • flag_duel_queue / wheel_duel_queue
--   • conquest_*
--   • profiles, xp_events
--   • award_wheel_group_xp_event RPC (XP idempotency)
--   • wheel_group_check_capacity trigger (BEFORE INSERT)
--   • Mevcut wheel_group_rooms / wheel_group_players RLS politikaları
--   • supabase_realtime publication üyelikleri
--   • Mevcut wheel_group_rooms / wheel_group_players SATIRLARI (backfill yok)
--
-- YENİ RPC'LER (frontend write call-site karşılığı parantezde)
-- -----------------------------------------------------------
--    1) wheel_group_create_room       (createRoom)
--    2) wheel_group_join_room         (joinRoomByCode)
--    3) wheel_group_start_game        (startGame: score reset + room update)
--    4) wheel_group_update_settings   (updateHostSetting)
--    5) wheel_group_pick_target       (pickNextTarget)
--    6) wheel_group_claim_target      (handleMapClick doğru dalı)
--    7) wheel_group_finish_game       (finishGame)
--    8) wheel_group_return_to_lobby   (returnToLobby)
--    9) wheel_group_kick_player       (kickPlayer)
--   10) wheel_group_leave_room        (leaveRoom — host transfer / close / non-host)
--
-- GÜVENLİK İLKELERİ
-- -----------------
--   • Hepsi SECURITY DEFINER, set search_path = public, auth.
--   • wheel_group_authorize_player / wheel_group_authorize_host helper'ları
--     üzerinden manuel authz; aksi halde RLS bypass kazancı kaybolur.
--   • revoke all from public + grant execute to anon, authenticated.
--   • claim_target: skor artırımı SERVER-SIDE. Client değer GÖNDERMEZ.
--   • start_game: started_at server tarafında now() ile yazılır (clock skew kapanır).
--   • current_match_id rotation: SERVER-SIDE (gen_random_uuid()); XP
--     idempotency anahtarı manipülasyona karşı sertleşir. **Mevcut semantik
--     korunur**: rotation yalnızca status='finished' → start_game yolunda
--     yapılır; waiting → start_game yolunda match_id aynı kalır.
--   • leave_room: host transfer + self DELETE veya room DELETE — tek
--     transaction. Eski iki-step yarış penceresi kapanır.
--   • return_to_lobby: status='finished' guard (onaylanan tightening) —
--     mid-game lobiye dönüş RPC tarafında reddedilir.
--   • kick_player: lobby-only (status='waiting') — UI zaten bu kısıtı uygular.
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
-- 1) wheel_group_create_room
-- ----------------------------------------------------------------------------
-- Oda + host player + claim_token tek transaction'da. Frontend createRoom'un
-- karşılığı. Orphan-room rollback gerekmez (function rollback ile garantili).
-- penalty_enabled ve max_players Wheel Group'a özgü; default'ları init
-- migration'da tanımlı (penalty=false, max_players=10).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_create_room(
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_code        text,
  p_duration    int,
  p_region      text,
  p_penalty     boolean,
  p_max_players int,
  p_claim_token uuid
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_group_rooms;
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

  -- Input validation
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
    insert into public.wheel_group_rooms (
      code,
      status,
      duration_seconds,
      region,
      penalty_enabled,
      max_players,
      host_player_id
    ) values (
      p_code,
      'waiting',
      p_duration,
      p_region,
      coalesce(p_penalty, false),
      p_max_players,
      p_player_id
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Host player satırı (capacity trigger 0 → 1 geçişinde geçer)
  insert into public.wheel_group_players (
    id, room_id, name, score, profile_id, guest_id
  ) values (
    p_player_id, v_room.id, btrim(p_name), 0, p_profile_id, p_guest_id
  );

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.wheel_group_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.wheel_group_create_room(uuid, uuid, text, text, text, int, text, boolean, int, uuid) from public;
grant  execute on function public.wheel_group_create_room(uuid, uuid, text, text, text, int, text, boolean, int, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) wheel_group_join_room
-- ----------------------------------------------------------------------------
-- Kod ile odaya katılma + player + claim tek transaction'da. Kapasite & isim
-- çakışması server-side; client-side kontroller artık UX-only. Capacity
-- trigger'ı (20260519120000) bu RPC içinden INSERT sırasında da çalışır; özel
-- "wheel_group_room_full" exception mesajını kullanıcı dostu 'room_full'
-- olarak yeniden raise ediyoruz.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_join_room(
  p_code        text,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_claim_token uuid
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.wheel_group_rooms;
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

  -- Input validation
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
    from public.wheel_group_rooms
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

  -- İsim çakışması (case-insensitive btrim) — Wheel Duel pattern'i.
  -- Türkçe locale farkları (İ/i, I/ı) kabul edilen takas; lower() C locale.
  if exists (
    select 1 from public.wheel_group_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(btrim(p_name))
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  -- Kapasite (capacity trigger backup; race'i burada kilit altında yakala)
  select count(*) into v_count
    from public.wheel_group_players
   where room_id = v_room.id;
  if v_count >= coalesce(v_room.max_players, 10) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Player + claim (capacity trigger INSERT sırasında bir kez daha doğrular)
  begin
    insert into public.wheel_group_players (
      id, room_id, name, score, profile_id, guest_id
    ) values (
      p_player_id, v_room.id, btrim(p_name), 0, p_profile_id, p_guest_id
    );
  exception
    when raise_exception then
      -- Trigger 'wheel_group_room_full: N/M players' mesajıyla raise eder.
      if sqlerrm like 'wheel_group_room_full%' then
        raise exception 'room_full' using errcode = 'P0001';
      else
        raise;  -- diğer P0001 hatalarını olduğu gibi yeniden fırlat
      end if;
  end;

  insert into public.wheel_group_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  -- updated_at trigger room satırını taze gösterir → realtime sinyali
  update public.wheel_group_rooms set updated_at = now() where id = v_room.id;

  -- Güncel satırı geri döndür
  select * into v_room from public.wheel_group_rooms where id = v_room.id;
  return v_room;
end;
$$;

revoke all     on function public.wheel_group_join_room(text, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.wheel_group_join_room(text, uuid, uuid, text, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) wheel_group_start_game
-- ----------------------------------------------------------------------------
-- Host-only. started_at server tarafında now() ile yazılır (clock skew kapanır).
-- MIN_PLAYERS=3 zorunluluğu burada.
--
-- match_seq / current_match_id rotation (mevcut client semantiği KORUNUR):
--   • v_room.status = 'finished' → match_seq + 1, current_match_id = uuid()
--   • v_room.status = 'waiting'  → match_seq aynı, current_match_id aynı
--   • v_room.status = 'playing'  → reject (defensive; UI zaten izin vermiyor)
--
-- Score reset + room update tek transaction. SQL function implicit BEGIN/COMMIT.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_first_target   text
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room           public.wheel_group_rooms;
  v_count          int;
  v_new_match_seq  int;
  v_new_match_id   uuid;
begin
  if not public.wheel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_first_target is null or length(btrim(p_first_target)) = 0 then
    raise exception 'first_target_required' using errcode = '22023';
  end if;

  -- Status + kapasite guard
  select * into v_room from public.wheel_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status not in ('waiting', 'finished') then
    raise exception 'room_not_startable' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from public.wheel_group_players where room_id = p_room_id;
  if v_count < 3 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;

  -- Rotation (mevcut semantik): yalnız status='finished' geçişinde bump
  if v_room.status = 'finished' then
    v_new_match_seq := coalesce(v_room.match_seq, 1) + 1;
    v_new_match_id  := gen_random_uuid();
  else
    v_new_match_seq := coalesce(v_room.match_seq, 1);
    v_new_match_id  := v_room.current_match_id;
  end if;

  -- 1) Tüm oyuncuların skorlarını sıfırla
  update public.wheel_group_players
     set score = 0
   where room_id = p_room_id;

  -- 2) Oda satırını güncelle (atomik guard tekrar status'ü doğrular)
  update public.wheel_group_rooms
     set status                = 'playing',
         started_at            = now(),
         finished_at           = null,
         finished_reason       = null,
         current_target_topoid = p_first_target,
         used_target_topoids   = '{}',
         match_seq             = v_new_match_seq,
         current_match_id      = v_new_match_id
   where id = p_room_id
     and status in ('waiting', 'finished')
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.wheel_group_start_game(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_start_game(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) wheel_group_update_settings
-- ----------------------------------------------------------------------------
-- Host-only, sadece lobby fazında (status='waiting'). Her parametre NULL ise
-- o alana dokunulmaz (partial update). max_players küçültme MEVCUT DAVRANIŞI
-- KORUR: mevcut oyuncular kicklenmez, yalnız yeni katılım limiti değişir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_update_settings(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_duration       int,
  p_region         text,
  p_penalty        boolean,
  p_max_players    int
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_group_rooms;
begin
  if not public.wheel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
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

  update public.wheel_group_rooms
     set duration_seconds = coalesce(p_duration,    duration_seconds),
         region           = coalesce(p_region,      region),
         penalty_enabled  = coalesce(p_penalty,     penalty_enabled),
         max_players      = coalesce(p_max_players, max_players)
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_group_update_settings(uuid, uuid, uuid, int, text, boolean, int) from public;
grant  execute on function public.wheel_group_update_settings(uuid, uuid, uuid, int, text, boolean, int) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) wheel_group_pick_target
-- ----------------------------------------------------------------------------
-- Host-only. Sadece current_target_topoid IS NULL iken yeni hedef yazar
-- (atomik guard double-pick'i engeller). Hedef havuzu / region filtresi
-- client'ta hesaplanmaya devam eder (countries veri tabloları SQL'de yok);
-- server yalnız atomic guard + yetki sağlar.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_pick_target(
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
  if not public.wheel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target is null or length(btrim(p_target)) = 0 then
    raise exception 'target_required' using errcode = '22023';
  end if;

  -- Atomik: status=playing + current=null guard. Çakışırsa sessiz no-op.
  update public.wheel_group_rooms
     set current_target_topoid = p_target
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid is null;
end;
$$;

revoke all     on function public.wheel_group_pick_target(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_pick_target(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) wheel_group_claim_target
-- ----------------------------------------------------------------------------
-- Atomik claim + skor artırımı. SKOR SERVER-SIDE; client değer GÖNDERMEZ.
-- Yarış kaybedilirse claimed=false, skor değişmez. Oyuncu bu odanın oyuncusu
-- olmak zorunda (cross-room sömürüyü kapatır).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_claim_target(
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
  if not public.wheel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target is null or length(btrim(p_target)) = 0 then
    raise exception 'target_required' using errcode = '22023';
  end if;

  -- Oyuncu gerçekten bu odada mı? (cross-room sömürüyü kapatır)
  if not exists (
    select 1 from public.wheel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Atomik claim: yalnız beklenen hedef hâlâ aktifse yaz.
  update public.wheel_group_rooms
     set current_target_topoid = null,
         used_target_topoids   = array_append(
                                   coalesce(used_target_topoids, '{}'::text[]),
                                   p_target
                                 )
   where id = p_room_id
     and status = 'playing'
     and current_target_topoid = p_target
   returning id into v_claimed_id;

  if v_claimed_id is null then
    -- Yarışı kaybettin, bayat hedef veya status değişmiş → sessiz no-op
    return jsonb_build_object('claimed', false, 'new_score', null);
  end if;

  -- Aynı transaction: skor +1
  update public.wheel_group_players
     set score = score + 1
   where id = p_player_id
   returning score into v_new_score;

  return jsonb_build_object('claimed', true, 'new_score', v_new_score);
end;
$$;

revoke all     on function public.wheel_group_claim_target(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_claim_target(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) wheel_group_finish_game
-- ----------------------------------------------------------------------------
-- Host-only. status=playing → finished geçişi. winner_player_id KOLONU YOK
-- (Wheel Group init migration); kazanan client-side hesaplanır. Buradaki tek
-- iş status/finished_at/finished_reason yazımı + current_target_topoid temizliği.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_finish_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_reason         text
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_group_rooms;
begin
  if not public.wheel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  update public.wheel_group_rooms
     set status                = 'finished',
         finished_at           = now(),
         finished_reason       = btrim(p_reason),
         current_target_topoid = null
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_group_finish_game(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_finish_game(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) wheel_group_return_to_lobby
-- ----------------------------------------------------------------------------
-- Host-only. status='finished' → 'waiting'. ONAYLANAN TIGHTENING:
-- status='finished' guard'ı RPC tarafında zorunlu — mid-game lobiye dönüş
-- kapatılır. UI zaten yalnız finished fazında bu butonu gösteriyor.
--
-- match_seq / current_match_id BURADA dokunulmaz (mevcut semantik korunur);
-- rotation sadece start_game içinde, status='finished' kaynağıyla yapılır.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_return_to_lobby(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.wheel_group_rooms;
begin
  if not public.wheel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  update public.wheel_group_rooms
     set status                = 'waiting',
         started_at            = null,
         finished_at           = null,
         finished_reason       = null,
         current_target_topoid = null,
         used_target_topoids   = '{}'
   where id = p_room_id
     and status = 'finished'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_finished' using errcode = 'P0001';
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_group_return_to_lobby(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_group_return_to_lobby(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) wheel_group_kick_player
-- ----------------------------------------------------------------------------
-- Host-only, lobby-only (status='waiting'). Self-kick reddedilir. Hedef oyuncu
-- aynı odada olmalı. Hedef bulunamazsa sessiz no-op (idempotent).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_kick_player(
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
  v_room public.wheel_group_rooms;
begin
  if not public.wheel_group_authorize_host(p_room_id, p_host_player_id, p_host_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target_player_id is null then
    raise exception 'target_player_required' using errcode = '22023';
  end if;
  if p_target_player_id = p_host_player_id then
    raise exception 'cannot_kick_self' using errcode = 'P0001';
  end if;

  -- Lobby-only guard (kick playing/finished fazında yapılmaz)
  select * into v_room from public.wheel_group_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  -- Hedef yoksa idempotent no-op (zaten ayrılmış)
  delete from public.wheel_group_players
   where id = p_target_player_id
     and room_id = p_room_id;
end;
$$;

revoke all     on function public.wheel_group_kick_player(uuid, uuid, uuid, uuid) from public;
grant  execute on function public.wheel_group_kick_player(uuid, uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 10) wheel_group_leave_room
-- ----------------------------------------------------------------------------
-- Caller-only (authorize_player). Üç dal tek transaction:
--   • Host & başkası varsa: host_player_id'yi en eski joined_at'e sahip BAŞKA
--     aktif oyuncuya devret, sonra kendi satırını sil.
--   • Host & yalnız: tüm odayı sil (cascade players + claims).
--   • Non-host: kendi satırını sil.
--
-- Oda satırı FOR UPDATE ile kilitlenir → host transfer + concurrent leave
-- yarış penceresi kapanır. Oda yoksa idempotent no-op (return).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room        public.wheel_group_rooms;
  v_is_host     boolean;
  v_new_host_id uuid;
begin
  if not public.wheel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Oda satırını kilitle (concurrent leave / kick race'lerini serileştir)
  select * into v_room from public.wheel_group_rooms where id = p_room_id for update;

  if v_room.id is null then
    return;  -- oda yok → idempotent no-op (zaten silinmiş)
  end if;

  -- Caller bu odada mı?
  if not exists (
    select 1 from public.wheel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    return;  -- bu odada değil → idempotent no-op (zaten ayrılmış / kicklenmiş)
  end if;

  v_is_host := (v_room.host_player_id = p_player_id);

  if v_is_host then
    -- En eski joined_at'e sahip BAŞKA oyuncuyu bul
    select id into v_new_host_id
      from public.wheel_group_players
     where room_id = p_room_id
       and id <> p_player_id
     order by joined_at asc
     limit 1;

    if v_new_host_id is not null then
      -- Host transfer + self DELETE (tek transaction)
      update public.wheel_group_rooms
         set host_player_id = v_new_host_id
       where id = p_room_id;

      delete from public.wheel_group_players
       where id = p_player_id
         and room_id = p_room_id;
    else
      -- Yalnız host → odayı tamamen sil (cascade players + claims)
      delete from public.wheel_group_rooms where id = p_room_id;
    end if;
  else
    -- Non-host: kendi satırını sil
    delete from public.wheel_group_players
     where id = p_player_id
       and room_id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.wheel_group_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_group_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel):
--
--   -- Tüm RPC'ler mevcut + security definer?
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname like 'wheel_group_%'
--    order by proname;
--   -- Beklenen yeni satırlar (prosecdef=true):
--   --   wheel_group_authorize_host, wheel_group_authorize_player (M1),
--   --   wheel_group_create_room, wheel_group_join_room,
--   --   wheel_group_start_game, wheel_group_update_settings,
--   --   wheel_group_pick_target, wheel_group_claim_target,
--   --   wheel_group_finish_game, wheel_group_return_to_lobby,
--   --   wheel_group_kick_player, wheel_group_leave_room
--   -- + Mevcut: award_wheel_group_xp_event (M0), wheel_group_check_capacity (trigger fn),
--   --          wheel_group_set_updated_at (trigger fn)
--
--   -- Grant kontrolü (anon + authenticated execute)
--   select p.proname, r.rolname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     join aclexplode(p.proacl) ae on true
--     join pg_roles r on r.oid = ae.grantee
--    where n.nspname = 'public'
--      and p.proname like 'wheel_group_%'
--      and ae.privilege_type = 'EXECUTE'
--    order by p.proname, r.rolname;
--
--   -- Mevcut RLS politikaları HÂLÂ YERİNDE (M2 dokunmaz):
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('wheel_group_rooms', 'wheel_group_players')
--    order by tablename, cmd;
--
--   -- search_path doğru set edilmiş mi?
--   select proname, proconfig
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname like 'wheel_group_%'
--      and proconfig is not null
--    order by proname;
--   -- Beklenen: her satırda {search_path=public, auth}
-- ============================================================================
