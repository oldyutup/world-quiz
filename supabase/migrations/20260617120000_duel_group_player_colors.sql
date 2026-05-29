-- ============================================================================
-- 20260617120000_duel_group_player_colors.sql
--
-- Duel Group (Ülke Yaz Çok Oyunculu) modu için oyuncu rengi.
--
-- Amaç:
--   • Her oyuncuya odada benzersiz bir renk ata. Lobby'deki renk seçici
--     (Kuşatma'daki gibi) kullanıcıya 15 seçenekten birini seçtirir;
--     haritada o oyuncunun ülkeleri kendi rengiyle boyanır.
--
-- Bu migration:
--   1) duel_group_players tablosuna `color_key text` kolonu ekler.
--   2) duel_group_pick_free_color(p_room_id) yardımcı fonksiyonu ekler:
--      paletten ilk boş rengi döndürür.
--   3) duel_group_set_player_color RPC'sini ekler: kendi satırı + aynı oda
--      içinde çakışma yoksa uygular ("color_taken" hatası).
--   4) duel_group_create_room ve duel_group_join_room fonksiyonlarını
--      yeniden yazar — oyuncu satırı INSERT edilirken otomatik olarak
--      paletten ilk boş renk atanır (aynı oda lock'u altında race-free).
--
-- IDEMPOTENT
-- ----------
-- `create or replace` ve `if not exists` ile tekrar koşulabilir.
-- ============================================================================


-- 1) Kolon -------------------------------------------------------------------
alter table public.duel_group_players
  add column if not exists color_key text;


-- 2) Yardımcı: ilk boş renk --------------------------------------------------
--    Palet sırasını burada hard-code ediyoruz; src/lib/duelGroupColors.ts ile
--    senkron tutulmalı. Sıralama 'red' ile başlar ve "düşmeye" göre seçilir.
create or replace function public.duel_group_pick_free_color(
  p_room_id uuid
) returns text
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_palette text[] := array[
    'red','blue','green','yellow',
    'purple','orange','pink','cyan',
    'lime','amber','rose','violet',
    'teal','slate','white'
  ];
  v_color   text;
begin
  foreach v_color in array v_palette loop
    if not exists (
      select 1 from public.duel_group_players
       where room_id = p_room_id
         and color_key = v_color
    ) then
      return v_color;
    end if;
  end loop;
  -- Tüm renkler doluysa fallback olarak ilkini ver (max 10 oyuncu olduğu için
  -- 15 renkli palet pratik olarak hiçbir zaman buraya düşmez).
  return v_palette[1];
end;
$$;

revoke all     on function public.duel_group_pick_free_color(uuid) from public;
grant  execute on function public.duel_group_pick_free_color(uuid) to anon, authenticated;


-- 3) Renk seçimi RPC'si ------------------------------------------------------
--    Kendi satırı için (claim_token doğrulamasıyla) bir rengi talep eder.
--    Aynı odada başka bir oyuncuda aynı renk varsa 'color_taken' raise eder.
--    İşlem oda satırını FOR UPDATE ile kilitleyerek race condition'ı engeller:
--    iki oyuncu aynı anda aynı rengi seçemez.
create or replace function public.duel_group_set_player_color(
  p_player_id   uuid,
  p_claim_token uuid,
  p_color       text
) returns public.duel_group_players
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_player  public.duel_group_players;
  v_room_id uuid;
  v_palette text[] := array[
    'red','blue','green','yellow',
    'purple','orange','pink','cyan',
    'lime','amber','rose','violet',
    'teal','slate','white'
  ];
begin
  if not public.duel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_color is null or not (p_color = any(v_palette)) then
    raise exception 'color_invalid' using errcode = '22023';
  end if;

  select room_id into v_room_id
    from public.duel_group_players
   where id = p_player_id;

  if v_room_id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  -- Oda satırını kilitle: aynı anda iki kişi aynı rengi seçemesin.
  perform 1 from public.duel_group_rooms where id = v_room_id for update;

  if exists (
    select 1 from public.duel_group_players
     where room_id = v_room_id
       and id <> p_player_id
       and color_key = p_color
  ) then
    raise exception 'color_taken' using errcode = 'P0001';
  end if;

  update public.duel_group_players
     set color_key = p_color
   where id = p_player_id
  returning * into v_player;

  return v_player;
end;
$$;

revoke all     on function public.duel_group_set_player_color(uuid, uuid, text) from public;
grant  execute on function public.duel_group_set_player_color(uuid, uuid, text) to anon, authenticated;


-- 4) create_room — host'a otomatik renk ata ----------------------------------
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
  v_room  public.duel_group_rooms;
  v_uid   uuid := auth.uid();
  v_color text;
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
  if p_duration is null or p_duration <= 0 then
    raise exception 'duration_invalid' using errcode = '22023';
  end if;
  if p_region is null or length(btrim(p_region)) = 0 then
    raise exception 'region_required' using errcode = '22023';
  end if;
  if p_max_players is null or p_max_players < 3 or p_max_players > 10 then
    raise exception 'max_players_invalid' using errcode = '22023';
  end if;

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

  -- Host her zaman paletin ilk rengini alır (yeni odada başka oyuncu yok).
  v_color := public.duel_group_pick_free_color(v_room.id);

  insert into public.duel_group_players (
    id, room_id, name, is_host, status, profile_id, guest_id, last_seen_at, color_key
  ) values (
    p_player_id, v_room.id, btrim(p_name), true, 'waiting',
    p_profile_id, p_guest_id, now(), v_color
  );

  insert into public.duel_group_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.duel_group_create_room(uuid, uuid, text, text, text, int, text, int, uuid) from public;
grant  execute on function public.duel_group_create_room(uuid, uuid, text, text, text, int, text, int, uuid) to anon, authenticated;


-- 5) join_room — katılana ilk boş rengi otomatik ata -------------------------
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
  v_color text;
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

  if exists (
    select 1 from public.duel_group_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(btrim(p_name))
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from public.duel_group_players
   where room_id = v_room.id;
  if v_count >= coalesce(v_room.max_players, 10) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- İlk boş rengi seç (lock altındayız → race-free).
  v_color := public.duel_group_pick_free_color(v_room.id);

  insert into public.duel_group_players (
    id, room_id, name, is_host, status, profile_id, guest_id, last_seen_at, color_key
  ) values (
    p_player_id, v_room.id, btrim(p_name), false, 'waiting',
    p_profile_id, p_guest_id, now(), v_color
  );

  insert into public.duel_group_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  update public.duel_group_rooms
     set updated_at = now()
   where id = v_room.id;

  select * into v_room from public.duel_group_rooms where id = v_room.id;
  return v_room;
end;
$$;

revoke all     on function public.duel_group_join_room(text, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.duel_group_join_room(text, uuid, uuid, text, text, uuid) to anon, authenticated;
