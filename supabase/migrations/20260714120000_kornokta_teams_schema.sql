-- ============================================================================
-- Kör Nokta — Takım tabanlı mod: şema + lobi RPC'leri
-- ============================================================================
-- Mevcut tevatur_* iskeletinin üzerine kurulur; tablo/RPC YENİDEN ADLANDIRILMAZ.
-- Kör Nokta artık iki takımlı (Mavi/Kırmızı) oynanır; bu migration lobi/şema
-- tarafını hazırlar (gameplay v2 ayrı migration'da: _kornokta_teams_gameplay).
--
-- Ne ekler / değiştirir:
--   • tevatur_players.team  text null check (team in ('blue','red'))
--   • tevatur_rooms.mole_enabled boolean not null default true
--   • tevatur_create_room  — yeni odalar max_players = 10; host team = 'blue'
--   • tevatur_join_room    — katılan oyuncu az kişili takıma (auto-balance)
--   • tevatur_kn_set_team  — host bir oyuncuyu diğer takıma alır (waiting)
--   • tevatur_kn_set_mole  — host köstebek ayarını açar/kapatır (waiting)
--
-- Desteklenen oyuncu sayıları (gameplay migration'da zorlanır): 4/6/8/10,
-- takımlar eşit (2v2 / 3v3 / 4v4 / 5v5). max_players tablo check'i 3–10 kalır.
--
-- İdempotent: add column if not exists + drop+add constraint + create or replace.
-- Client + bu migration birlikte deploy edilmeli.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Kolonlar
-- ────────────────────────────────────────────────────────────────────────────

alter table public.tevatur_players
  add column if not exists team text null;

alter table public.tevatur_players
  drop constraint if exists tevatur_players_team_check;
alter table public.tevatur_players
  add constraint tevatur_players_team_check
  check (team is null or team in ('blue', 'red'));

alter table public.tevatur_rooms
  add column if not exists mole_enabled boolean not null default true;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_create_room — max_players 10 + host team='blue'
--    (gövde 20260712120000 ile aynı; yalnız max_players ve host insert değişti)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_create_room(
  p_player_id     uuid,
  p_code          text,
  p_round_count   int,
  p_photo_seconds int,
  p_claim_token   uuid
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.tevatur_rooms;
  v_uid      uuid := auth.uid();
  v_username text;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select username into v_username from public.profiles where id = v_uid;
  if v_username is null or length(btrim(v_username)) < 2 then
    raise exception 'username_required' using errcode = '42501';
  end if;

  if p_claim_token is null then
    raise exception 'claim_token_required' using errcode = '22023';
  end if;
  if p_player_id is null then
    raise exception 'player_id_required' using errcode = '22023';
  end if;
  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;
  if p_round_count is null or p_round_count not in (5, 7, 10, 15, 20) then
    raise exception 'round_count_invalid' using errcode = '22023';
  end if;
  if p_photo_seconds is null or p_photo_seconds not in (5, 10, 15) then
    raise exception 'photo_seconds_invalid' using errcode = '22023';
  end if;

  -- 1) Oda satırı (UNIQUE(code) çakışırsa kullanıcı dostu hata).
  --    Kör Nokta takım modu: max_players = 10.
  begin
    insert into public.tevatur_rooms (
      code, status, round_count, photo_seconds, max_players, host_player_id
    ) values (
      btrim(p_code), 'waiting', p_round_count, p_photo_seconds, 10, p_player_id
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Host player satırı (host varsayılan Mavi takım)
  insert into public.tevatur_players (id, room_id, profile_id, name, score, team)
  values (p_player_id, v_room.id, v_uid, btrim(v_username), 0, 'blue');

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.tevatur_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.tevatur_create_room(uuid, text, int, int, uuid) from public;
grant  execute on function public.tevatur_create_room(uuid, text, int, int, uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) tevatur_join_room — katılan oyuncu az kişili takıma (auto-balance)
--    (gövde 20260711120000 ile aynı; yalnız team atama eklendi)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_join_room(
  p_code        text,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.tevatur_rooms;
  v_uid      uuid := auth.uid();
  v_username text;
  v_count    int;
  v_blue     int;
  v_red      int;
  v_team     text;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select username into v_username from public.profiles where id = v_uid;
  if v_username is null or length(btrim(v_username)) < 2 then
    raise exception 'username_required' using errcode = '42501';
  end if;

  if p_claim_token is null then
    raise exception 'claim_token_required' using errcode = '22023';
  end if;
  if p_player_id is null then
    raise exception 'player_id_required' using errcode = '22023';
  end if;
  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;

  -- Oda lookup (kilitle: kapasite check ile insert arası race)
  select * into v_room
    from public.tevatur_rooms
   where code = btrim(p_code)
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

  -- Aynı hesap zaten bu odada mı? (iki sekme / çift katılım engeli)
  if exists (
    select 1 from public.tevatur_players
     where room_id = v_room.id and profile_id = v_uid
  ) then
    raise exception 'already_in_room' using errcode = 'P0001';
  end if;

  -- Kapasite (FOR UPDATE kilidi altında — race-safe)
  select count(*) into v_count
    from public.tevatur_players
   where room_id = v_room.id;
  if v_count >= coalesce(v_room.max_players, 10) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Auto-balance: az kişili takıma düş (eşitse Mavi).
  select count(*) filter (where team = 'blue'),
         count(*) filter (where team = 'red')
    into v_blue, v_red
    from public.tevatur_players
   where room_id = v_room.id;
  v_team := case when coalesce(v_red, 0) < coalesce(v_blue, 0) then 'red' else 'blue' end;

  insert into public.tevatur_players (id, room_id, profile_id, name, score, team)
  values (p_player_id, v_room.id, v_uid, btrim(v_username), 0, v_team);

  insert into public.tevatur_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  -- updated_at trigger room satırını taze gösterir → realtime sinyali
  update public.tevatur_rooms set updated_at = now() where id = v_room.id;

  select * into v_room from public.tevatur_rooms where id = v_room.id;
  return v_room;
end;
$$;

revoke all     on function public.tevatur_join_room(text, uuid, uuid) from public;
grant  execute on function public.tevatur_join_room(text, uuid, uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) tevatur_kn_set_team — host bir oyuncuyu diğer takıma alır (yalnız waiting)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_set_team(
  p_room_id          uuid,
  p_host_player_id   uuid,
  p_claim_token      uuid,
  p_target_player_id uuid,
  p_team             text
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.tevatur_rooms;
begin
  if not public.tevatur_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_team is null or p_team not in ('blue', 'red') then
    raise exception 'team_invalid' using errcode = '22023';
  end if;

  select * into v_room from public.tevatur_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  update public.tevatur_players
     set team = p_team
   where room_id = p_room_id
     and id      = p_target_player_id;

  update public.tevatur_rooms set updated_at = now() where id = p_room_id;

  select * into v_room from public.tevatur_rooms where id = p_room_id;
  return v_room;
end;
$$;

revoke all     on function public.tevatur_kn_set_team(uuid, uuid, uuid, uuid, text) from public;
grant  execute on function public.tevatur_kn_set_team(uuid, uuid, uuid, uuid, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) tevatur_kn_set_mole — host köstebek ayarını açar/kapatır (yalnız waiting)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kn_set_mole(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_enabled        boolean
) returns public.tevatur_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.tevatur_rooms;
begin
  if not public.tevatur_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  update public.tevatur_rooms
     set mole_enabled = coalesce(p_enabled, true),
         updated_at   = now()
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  return v_room;
end;
$$;

revoke all     on function public.tevatur_kn_set_mole(uuid, uuid, uuid, boolean) from public;
grant  execute on function public.tevatur_kn_set_mole(uuid, uuid, uuid, boolean) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) tevatur_send_message — takım içi chat için "<code>#blue"/"#red" kabul et
-- ----------------------------------------------------------------------------
-- Takım modunda oyun-içi chat takım bazlı ayrılır: client roomCode'u
-- "<code>#blue" / "<code>#red" olarak verir. Oda kodu karşılaştırması '#'
-- öncesini baz alır; mesaj tam (suffix'li) room_code ile saklanır → LobbyScreen
-- okuması (room_code eşitliği) takımları otomatik ayırır. Lobi chat'i suffix'siz
-- "<code>" kullanmaya devam eder (hepsi görür). Gövde init ile aynı; yalnız
-- room-code karşılaştırması split_part ile baz koda indirgenir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_send_message(
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
  v_player    public.tevatur_players;
  v_room_code text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.tevatur_authorize_player(p_player_id, p_claim_token) then
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

  select * into v_player from public.tevatur_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select code into v_room_code
    from public.tevatur_rooms
   where id = v_player.room_id;

  if v_room_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- "<code>#blue" / "#red" takım kanalı → baz koda göre yetki kontrolü.
  if v_room_code <> split_part(p_room_code, '#', 1) then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  perform public._duel_messages_antispam_check(p_room_code, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.tevatur_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.tevatur_send_message(text, uuid, uuid, text) to authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama:
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='tevatur_players'
--      and column_name='team';
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='tevatur_rooms'
--      and column_name='mole_enabled';
--   select proname from pg_proc
--    where pronamespace='public'::regnamespace
--      and proname in ('tevatur_kn_set_team','tevatur_kn_set_mole');
-- ============================================================================
