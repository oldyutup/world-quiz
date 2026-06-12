-- ============================================================================
-- Tevatür — çok oyunculu oda/lobi iskeleti (3–10 kişi, login-only)
-- ============================================================================
-- Bu migration mevcut tablolara DOKUNMAZ:
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_* / wheel_duel_* / wheel_group_* / conquest_*
--   • flag_duel_queue / wheel_duel_queue
--   • xp_events, profiles
--
-- Yalnızca aşağıdaki YENİ nesneleri oluşturur:
--   • public.tevatur_rooms          (oda kayıtları)
--   • public.tevatur_players        (her odanın oyuncuları)
--   • public.tevatur_player_claims  (claim-token deposu, realtime DIŞI)
--   • public.tevatur_set_updated_at()       (trigger fonksiyonu)
--   • tevatur_rooms_set_updated_at          (BEFORE UPDATE trigger)
--   • public.tevatur_authorize_player / tevatur_authorize_host (helper)
--   • RPC'ler: create_room, join_room, update_settings, kick_player,
--              leave_room, send_message
--   • RLS politikaları + supabase_realtime publication üyelikleri
--
-- Tüm CREATE'ler "IF NOT EXISTS" / "OR REPLACE" / idempotent guard ile
-- yazılmıştır → migration tekrar çalıştırılırsa hata vermez.
--
-- WHEEL GROUP'TAN FARKLAR (bilinçli):
--   • LOGIN-ONLY: misafir oyuncu YOK. Tüm RPC grant'leri yalnız
--     'authenticated' rolüne verilir; anon execute edemez. RPC gövdeleri
--     auth.uid() NULL ise 'auth_required' fırlatır.
--   • Oyuncu adı CLIENT'TAN GÖNDERİLMEZ — server-side profiles.username
--     resolve edilir. Display-name guard'a gerek kalmaz.
--   • Tablolarda gün-1'den itibaren RLS lockdown (M3 final hâli):
--     SELECT public, yazma yolları yalnız SECURITY DEFINER RPC'ler.
--   • Oyun içeriği (start/finish/round RPC'leri) bu migration'da YOK —
--     yalnız oda/lobi iskeleti. Oyun RPC'leri ileride ayrı migration'la gelir.
--
-- Çakışma stratejisi:
--   • room code "T" ile başlatılır (Tevatür). duel_messages.room_code
--     üzerinden chat reuse edildiği için diğer modların kodlarıyla
--     (K=Conquest, M=WheelGroup, W=WheelDuel) karışmaması adına.
--     T-prefix kuralı app-side; DB'de tevatur_rooms.code UNIQUE.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Tablolar
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.tevatur_rooms (
  id              uuid        primary key default gen_random_uuid(),
  code            text        not null unique,
  status          text        not null default 'waiting'
                              check (status in ('waiting','playing','finished')),
  round_count     int         not null default 10
                              check (round_count in (5,10,15,20)),
  photo_seconds   int         not null default 10
                              check (photo_seconds in (5,10,15)),
  max_players     int         not null default 10
                              check (max_players between 3 and 10),
  host_player_id  uuid        null,
  started_at      timestamptz null,
  finished_at     timestamptz null,
  finished_reason text        null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists tevatur_rooms_status_idx
  on public.tevatur_rooms (status);

create index if not exists tevatur_rooms_created_at_idx
  on public.tevatur_rooms (created_at desc);

-- Realtime UPDATE event'leri tam satırı taşısın.
alter table public.tevatur_rooms replica identity full;


create table if not exists public.tevatur_players (
  id            uuid        primary key default gen_random_uuid(),
  room_id       uuid        not null
                              references public.tevatur_rooms(id) on delete cascade,
  -- LOGIN-ONLY mod: profile_id zorunlu (auth.users.id). Misafir kolonu yok.
  profile_id    uuid        not null,
  name          text        not null,
  score         int         not null default 0 check (score >= 0),
  joined_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists tevatur_players_room_id_idx
  on public.tevatur_players (room_id);

create index if not exists tevatur_players_joined_at_idx
  on public.tevatur_players (room_id, joined_at);

alter table public.tevatur_players replica identity full;


-- Claim-token deposu: tevatur_players ile aynı tabloda DURMAZ; REPLICA
-- IDENTITY FULL nedeniyle realtime WAL akışında her aboneye sızardı.
-- Ayrı tablo → publication'a eklenmez, SELECT policy hiç verilmez.
create table if not exists public.tevatur_player_claims (
  player_id   uuid        primary key
                          references public.tevatur_players(id) on delete cascade,
  claim_token uuid        not null,
  created_at  timestamptz not null default now()
);

alter table public.tevatur_player_claims enable row level security;

-- Hiç policy YOK → default-deny. Claim insert'leri yalnız SECURITY DEFINER
-- RPC'lerin içinden yapılır (create_room / join_room). Defense-in-depth:
-- tablo grant'lerini de geri al.
revoke all on public.tevatur_player_claims from anon, authenticated;

-- NOT: alter publication supabase_realtime ADD TABLE tevatur_player_claims
-- ÇAĞRILMIYOR. Bu kasıtlı. Token asla broadcast edilmemeli.


-- ────────────────────────────────────────────────────────────────────────────
-- 2) updated_at trigger (yalnız tevatur_rooms)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tevatur_rooms_set_updated_at
  on public.tevatur_rooms;

create trigger tevatur_rooms_set_updated_at
  before update on public.tevatur_rooms
  for each row
  execute function public.tevatur_set_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Row Level Security — gün-1 lockdown (wheel_group M3 final hâli)
-- ----------------------------------------------------------------------------
-- SELECT: herkes (realtime abonelikleri + lobi listeleri bu policy'ye dayanır).
-- INSERT / UPDATE / DELETE policy YOK → default-deny; yazma yolu yalnız
-- aşağıdaki SECURITY DEFINER RPC'ler. Anon kullanıcı RPC'leri de çağıramaz
-- (grant yalnız authenticated).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.tevatur_rooms   enable row level security;
alter table public.tevatur_players enable row level security;

drop policy if exists "tevatur_rooms_select_public" on public.tevatur_rooms;

create policy "tevatur_rooms_select_public"
  on public.tevatur_rooms
  for select
  to anon, authenticated
  using (true);

drop policy if exists "tevatur_players_select_public" on public.tevatur_players;

create policy "tevatur_players_select_public"
  on public.tevatur_players
  for select
  to anon, authenticated
  using (true);


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Realtime publication (idempotent guard)
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'tevatur_rooms'
  ) then
    execute 'alter publication supabase_realtime add table public.tevatur_rooms';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'tevatur_players'
  ) then
    execute 'alter publication supabase_realtime add table public.tevatur_players';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) Yetki yardımcıları (read-only, SECURITY DEFINER)
-- ----------------------------------------------------------------------------
-- Login-only modda asıl kanıt profile_id = auth.uid(); claim_token ikinci
-- faktör olarak da doğrulanır (LobbyChat ve RPC çağrıları tek-tip claim
-- yolu kullanır, wheel_group pattern'iyle uyumlu kalır).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.tevatur_players p
      left join public.tevatur_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and p.profile_id = auth.uid()
       and (
            p_claim_token is null
         or c.claim_token = p_claim_token
       )
  );
$$;

revoke all     on function public.tevatur_authorize_player(uuid, uuid) from public;
grant  execute on function public.tevatur_authorize_player(uuid, uuid) to authenticated;


create or replace function public.tevatur_authorize_host(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.tevatur_rooms r
     where r.id = p_room_id
       and r.host_player_id = p_player_id
       and public.tevatur_authorize_player(p_player_id, p_claim_token)
  );
$$;

revoke all     on function public.tevatur_authorize_host(uuid, uuid, uuid) from public;
grant  execute on function public.tevatur_authorize_host(uuid, uuid, uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) tevatur_create_room
-- ----------------------------------------------------------------------------
-- Oda + host player + claim_token tek transaction'da. Oyuncu adı server-side
-- profiles.username'den resolve edilir; client ad GÖNDERMEZ.
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
  if p_round_count is null or p_round_count not in (5, 10, 15, 20) then
    raise exception 'round_count_invalid' using errcode = '22023';
  end if;
  if p_photo_seconds is null or p_photo_seconds not in (5, 10, 15) then
    raise exception 'photo_seconds_invalid' using errcode = '22023';
  end if;

  -- 1) Oda satırı (UNIQUE(code) çakışırsa kullanıcı dostu hata)
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

  -- 2) Host player satırı
  insert into public.tevatur_players (id, room_id, profile_id, name, score)
  values (p_player_id, v_room.id, v_uid, btrim(v_username), 0);

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.tevatur_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.tevatur_create_room(uuid, text, int, int, uuid) from public;
grant  execute on function public.tevatur_create_room(uuid, text, int, int, uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) tevatur_join_room
-- ----------------------------------------------------------------------------
-- Kod ile odaya katılma + player + claim tek transaction'da. Oda satırı
-- FOR UPDATE ile kilitlenir → kapasite check ile insert arası race kapanır
-- (ayrı capacity trigger'a gerek yok). Aynı hesap aynı odaya ikinci kez
-- katılamaz ('already_in_room').
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

  insert into public.tevatur_players (id, room_id, profile_id, name, score)
  values (p_player_id, v_room.id, v_uid, btrim(v_username), 0);

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
-- 8) tevatur_update_settings
-- ----------------------------------------------------------------------------
-- Host-only, sadece lobby fazında (status='waiting'). NULL geçilen alana
-- dokunulmaz (partial update).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_update_settings(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_round_count    int,
  p_photo_seconds  int
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

  if p_round_count is not null and p_round_count not in (5, 10, 15, 20) then
    raise exception 'round_count_invalid' using errcode = '22023';
  end if;
  if p_photo_seconds is not null and p_photo_seconds not in (5, 10, 15) then
    raise exception 'photo_seconds_invalid' using errcode = '22023';
  end if;

  update public.tevatur_rooms
     set round_count   = coalesce(p_round_count,   round_count),
         photo_seconds = coalesce(p_photo_seconds, photo_seconds)
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  return v_room;
end;
$$;

revoke all     on function public.tevatur_update_settings(uuid, uuid, uuid, int, int) from public;
grant  execute on function public.tevatur_update_settings(uuid, uuid, uuid, int, int) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) tevatur_kick_player
-- ----------------------------------------------------------------------------
-- Host-only, lobby-only (status='waiting'). Self-kick reddedilir. Hedef
-- bulunamazsa sessiz no-op (idempotent).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_kick_player(
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
  v_room public.tevatur_rooms;
begin
  if not public.tevatur_authorize_host(p_room_id, p_host_player_id, p_host_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target_player_id is null then
    raise exception 'target_player_required' using errcode = '22023';
  end if;
  if p_target_player_id = p_host_player_id then
    raise exception 'cannot_kick_self' using errcode = 'P0001';
  end if;

  select * into v_room from public.tevatur_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  delete from public.tevatur_players
   where id = p_target_player_id
     and room_id = p_room_id;
end;
$$;

revoke all     on function public.tevatur_kick_player(uuid, uuid, uuid, uuid) from public;
grant  execute on function public.tevatur_kick_player(uuid, uuid, uuid, uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 10) tevatur_leave_room
-- ----------------------------------------------------------------------------
-- Caller-only. Üç dal tek transaction (wheel_group_leave_room pattern'i):
--   • Host & başkası varsa: host_player_id'yi en eski joined_at'e sahip BAŞKA
--     oyuncuya devret, sonra kendi satırını sil.
--   • Host & yalnız: tüm odayı sil (cascade players + claims).
--   • Non-host: kendi satırını sil.
-- Oda satırı FOR UPDATE ile kilitlenir; oda yoksa idempotent no-op.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room        public.tevatur_rooms;
  v_is_host     boolean;
  v_new_host_id uuid;
begin
  if not public.tevatur_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.tevatur_rooms where id = p_room_id for update;

  if v_room.id is null then
    return;  -- oda yok → idempotent no-op (zaten silinmiş)
  end if;

  if not exists (
    select 1 from public.tevatur_players
     where id = p_player_id and room_id = p_room_id
  ) then
    return;  -- bu odada değil → idempotent no-op
  end if;

  v_is_host := (v_room.host_player_id = p_player_id);

  if v_is_host then
    select id into v_new_host_id
      from public.tevatur_players
     where room_id = p_room_id
       and id <> p_player_id
     order by joined_at asc
     limit 1;

    if v_new_host_id is not null then
      update public.tevatur_rooms
         set host_player_id = v_new_host_id
       where id = p_room_id;

      delete from public.tevatur_players
       where id = p_player_id
         and room_id = p_room_id;
    else
      delete from public.tevatur_rooms where id = p_room_id;
    end if;
  else
    delete from public.tevatur_players
     where id = p_player_id
       and room_id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.tevatur_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.tevatur_leave_room(uuid, uuid, uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 11) tevatur_send_message — chat (duel_messages reuse)
-- ----------------------------------------------------------------------------
-- M-Chat-A pattern'i: player_name CLIENT'TAN GÖNDERİLMEZ, server-side
-- tevatur_players.name kullanılır. Mevcut anti-spam helper'ı
-- (_duel_messages_antispam_check, 20260616120000) aynen devreye girer.
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

  if v_room_code <> p_room_code then
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
-- Doğrulama sorguları (manuel çalıştırıp kontrol edilebilir):
--
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name like 'tevatur_%';
--
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename like 'tevatur_%';
--   -- Beklenen: yalnız *_select_public (SELECT) policy'leri.
--
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename like 'tevatur_%';
--   -- Beklenen: tevatur_rooms, tevatur_players (claims YOK).
--
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname like 'tevatur_%'
--    order by proname;
-- ============================================================================
