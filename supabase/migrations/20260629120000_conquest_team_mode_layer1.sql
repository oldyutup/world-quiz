-- ============================================================================
-- Kuşatma (Conquest) — Team Mode Layer 1
-- ============================================================================
-- AMAÇ
-- ----
-- 2v2 Takımlı modu lobby seviyesinde aktif etmek. Bu migration sadece:
--   • Oda satırına team_mode kolonu ekler.
--   • Oyuncu satırına team_id kolonu ekler.
--   • Host'un team_mode değiştirmesi, oyuncunun kendi takımını seçmesi ve
--     host'un takımları karıştırması için RPC'ler ekler.
--
-- GAMEPLAY KURALLARINA DOKUNMUYORUZ:
--   • Aynı takım saldırı yasağı yok.
--   • Takım skoru yok.
--   • XP/Gold/eleme mantığı değişmiyor.
-- Layer 1 yalnızca lobby/DB/seçim altyapısıdır.
--
-- IDEMPOTENT
-- ----------
--   • ALTER TABLE … ADD COLUMN IF NOT EXISTS ile.
--   • CHECK constraint'ler DO bloklarıyla sadece eksikse eklenir.
--   • RPC'ler create or replace function.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Sütunlar + check constraint'ler
-- ────────────────────────────────────────────────────────────────────────────

alter table public.conquest_rooms
  add column if not exists team_mode text not null default 'individual';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'conquest_rooms_team_mode_check'
       and conrelid = 'public.conquest_rooms'::regclass
  ) then
    alter table public.conquest_rooms
      add constraint conquest_rooms_team_mode_check
      check (team_mode in ('individual', 'teams_2v2'));
  end if;
end$$;

alter table public.conquest_players
  add column if not exists team_id smallint null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'conquest_players_team_id_check'
       and conrelid = 'public.conquest_players'::regclass
  ) then
    alter table public.conquest_players
      add constraint conquest_players_team_id_check
      check (team_id is null or team_id in (1, 2));
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) RPC: set_conquest_team_mode  (host only)
-- ----------------------------------------------------------------------------
--   • Sadece oda host'u çağırabilir.
--   • teams_2v2 seçilebilmesi için room.max_players = 4 olmalı.
--   • individual'a dönülürse tüm conquest_players.team_id null yapılır.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.set_conquest_team_mode(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_team_mode   text
) returns public.conquest_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.conquest_rooms;
begin
  if p_team_mode is null or p_team_mode not in ('individual', 'teams_2v2') then
    raise exception 'invalid_team_mode' using errcode = '22023';
  end if;

  if not public.conquest_authorize_host(p_room_id, p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room
    from public.conquest_rooms
   where id = p_room_id
   for update;

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = '42501';
  end if;

  if p_team_mode = 'teams_2v2' and v_room.max_players <> 4 then
    raise exception 'team_mode_requires_capacity_4' using errcode = '22023';
  end if;

  update public.conquest_rooms
     set team_mode = p_team_mode
   where id = p_room_id
   returning * into v_room;

  -- Bireysele dönerken takım seçimlerini temizle.
  if p_team_mode = 'individual' then
    update public.conquest_players
       set team_id = null
     where room_id = p_room_id
       and team_id is not null;
  end if;

  return v_room;
end;
$$;

revoke all on function public.set_conquest_team_mode(uuid, uuid, uuid, text) from public;
grant execute on function public.set_conquest_team_mode(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) RPC: select_conquest_team  (player self-select)
-- ----------------------------------------------------------------------------
--   • Oyuncu yalnız kendi team_id'sini değiştirebilir (claim_token / auth.uid()).
--   • team_id 1 veya 2 olmalı.
--   • Room team_mode = 'teams_2v2' değilse reddet.
--   • Oyun başlamışsa reddet.
--   • Hedef takımda 2 oyuncu varsa team_full hatası ver.
--   • Race-safe: hedef takım sayımı for update lock ile atomik yapılır.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.select_conquest_team(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_team_id     smallint
) returns public.conquest_players
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_player        public.conquest_players;
  v_room          public.conquest_rooms;
  v_existing_team smallint;
  v_count         int;
begin
  if p_team_id is null or p_team_id not in (1, 2) then
    raise exception 'invalid_team_id' using errcode = '22023';
  end if;

  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- Oda kilidi: hedef takım sayımı + güncellemenin tek transaction'da
  -- atomik koşması için.
  select * into v_room
    from public.conquest_rooms
   where id = p_room_id
   for update;

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room.team_mode <> 'teams_2v2' then
    raise exception 'team_mode_not_teams' using errcode = '42501';
  end if;

  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = '42501';
  end if;

  -- Oyuncunun bu odadaki satırı + mevcut takımı.
  select team_id into v_existing_team
    from public.conquest_players
   where id = p_player_id and room_id = p_room_id;

  if v_existing_team is null and not found then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  if v_existing_team is distinct from p_team_id then
    -- Hedef takımdaki mevcut oyuncu sayısını oku ve 2 ile sınırla.
    select count(*) into v_count
      from public.conquest_players
     where room_id = p_room_id
       and team_id = p_team_id;

    if v_count >= 2 then
      raise exception 'team_full' using errcode = 'P0001';
    end if;
  end if;

  update public.conquest_players
     set team_id = p_team_id
   where id = p_player_id and room_id = p_room_id
   returning * into v_player;

  return v_player;
end;
$$;

revoke all on function public.select_conquest_team(uuid, uuid, uuid, smallint) from public;
grant execute on function public.select_conquest_team(uuid, uuid, uuid, smallint) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) RPC: shuffle_conquest_teams  (host only)
-- ----------------------------------------------------------------------------
--   • Sadece host çalıştırabilir.
--   • Room team_mode = 'teams_2v2' olmalı.
--   • Oyun başlamamış olmalı.
--   • Odada 4 oyuncu olmalı (active heartbeat şartı yok — sadece satır sayısı).
--   • Random shuffle ile 2 oyuncu team_id=1, 2 oyuncu team_id=2.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.shuffle_conquest_teams(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns setof public.conquest_players
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.conquest_rooms;
  v_count      int;
  v_player_ids uuid[];
begin
  if not public.conquest_authorize_host(p_room_id, p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room
    from public.conquest_rooms
   where id = p_room_id
   for update;

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room.team_mode <> 'teams_2v2' then
    raise exception 'team_mode_not_teams' using errcode = '42501';
  end if;

  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = '42501';
  end if;

  select count(*) into v_count
    from public.conquest_players
   where room_id = p_room_id;

  if v_count <> 4 then
    raise exception 'team_shuffle_requires_4_players' using errcode = '22023';
  end if;

  -- Rastgele sırada 4 oyuncuyu topla.
  select array_agg(id order by random())
    into v_player_ids
    from public.conquest_players
   where room_id = p_room_id;

  -- İlk ikisini Mavi (1), kalan ikisini Kırmızı (2) yap.
  update public.conquest_players
     set team_id = 1
   where id = any (v_player_ids[1:2]);

  update public.conquest_players
     set team_id = 2
   where id = any (v_player_ids[3:4]);

  -- Public list "tazelik" sinyali.
  update public.conquest_rooms set updated_at = now() where id = p_room_id;

  return query
    select * from public.conquest_players
     where room_id = p_room_id
     order by joined_at asc;
end;
$$;

revoke all on function public.shuffle_conquest_teams(uuid, uuid, uuid) from public;
grant execute on function public.shuffle_conquest_teams(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- Doğrulama sorguları (manuel):
--
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('conquest_rooms','conquest_players')
--      and column_name in ('team_mode','team_id');
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname in ('conquest_rooms_team_mode_check','conquest_players_team_id_check');
--
--   select proname from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('set_conquest_team_mode','select_conquest_team','shuffle_conquest_teams');
-- ============================================================================
