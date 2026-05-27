-- ============================================================================
-- Duel (Online 1v1) — M2 patch · "finished_at" kolonu hatasının düzeltilmesi
-- ============================================================================
-- SORUN
-- -----
-- 20260604120000_duel_rls_hardening_m2.sql migration'ı yazılırken wheel_duel
-- pattern'i kopyalanırken `duel_rooms.finished_at` kolonu yanlışlıkla taşındı.
-- Legacy `duel_rooms` şemasında bu kolon BULUNMUYOR (DuelRoom TypeScript
-- arayüzünde de yok — `src/lib/supabase.ts:21`). wheel_duel_rooms /
-- conquest_rooms / duel_group_rooms şemalarında finished_at vardı; benzer
-- isim aldatıcı oldu.
--
-- BELİRTİ
-- -------
-- duel_start_game RPC çağrısında PostgreSQL hatası:
--   column "finished_at" of relation "duel_rooms" does not exist
-- duel_finish_game, duel_forfeit_game, duel_handle_disconnect ve
-- duel_join_rematch_room da aynı kolona yazıyordu; her biri ilk tetiklendiğinde
-- aynı hatayı verirdi.
--
-- ETKİLENEN RPC'LER (5 adet)
-- --------------------------
--   • duel_start_game           (set finished_at = null)
--   • duel_finish_game          (set finished_at = now())
--   • duel_forfeit_game         (set finished_at = now())
--   • duel_handle_disconnect    (set finished_at = now())
--   • duel_join_rematch_room    (set finished_at = null)
--
-- DÜZELTME
-- --------
-- Bu patch yukarıdaki 5 RPC'yi `create or replace` ile yeniden tanımlar ve
-- `finished_at` satırını çıkarır. Diğer kolonlar (status, started_at,
-- finished_reason, winner_player_id, forfeited_player_id,
-- disconnected_player_id, disconnect_at) korunur — hepsi DuelRoom type'ında
-- mevcut ve canlı kullanımda. Bitiş zamanı semantiği için `disconnect_at` ya
-- da read-only `created_at` zaten yeterli; ek bir kolona ihtiyaç yok. Yeni
-- kolon eklemiyoruz (frontend hiç finished_at okumuyor; eklesek de kullanıcı
-- yok).
--
-- DOKUNULMAYAN ŞEYLER
-- -------------------
--   • duel_rooms şeması (ALTER yok — eksik kolon yaratmıyoruz, kaldırmıyoruz)
--   • duel_create_room / duel_join_room / duel_submit_claim / duel_heartbeat
--   • duel_accept_rematch / duel_leave_room / duel_send_message
--   • duel_authorize_player / duel_authorize_host helper'ları (M1)
--   • duel_player_claims tablosu + policy'leri (M1)
--   • M3 lockdown politikaları (20260605120000)
--   • DuelGame.tsx / LobbyChat.tsx (frontend hiç finished_at kullanmıyor)
--   • duel_group_*, wheel_duel_*, wheel_group_*, conquest_*
--
-- RLS LOCKDOWN ETKİSİ
-- -------------------
-- Sıfır. M3 (20260605120000) kaldırdığı policy'lere DOKUNMAZ; bu patch yalnız
-- 5 RPC'nin gövdesini değiştirir. RPC'ler SECURITY DEFINER ile RLS bypass
-- ettiği için lockdown mantığı aynen geçerli.
--
-- IDEMPOTENT
-- ----------
-- Hepsi `create or replace`; imza değişmedi → tekrar koşulursa hata vermez.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_start_game (patch: finished_at satırı çıkarıldı)
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
-- 2) duel_finish_game (patch: finished_at satırı çıkarıldı)
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
  v_room         public.duel_rooms;
  v_winner_id    uuid;
  v_player_count int;
  v_top_count    int;
  v_top_id       uuid;
  v_second_cnt   int;
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
    return v_room;
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Winner hesabı: claims COUNT en yüksek
  select count(distinct player_id) into v_player_count
    from public.duel_claims where room_id = p_room_id;

  if v_player_count = 0 then
    v_winner_id := null;
  else
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
         finished_reason  = 'timeout',
         winner_player_id = v_winner_id
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.duel_finish_game(uuid, uuid, uuid) from public;
grant  execute on function public.duel_finish_game(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) duel_forfeit_game (patch: finished_at satırı çıkarıldı)
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
    return v_room;
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  select id into v_winner_id
    from public.duel_players
   where room_id = p_room_id and id <> p_player_id
   limit 1;

  update public.duel_rooms
     set status              = 'finished',
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
-- 4) duel_handle_disconnect (patch: finished_at satırı çıkarıldı)
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
    return v_room;
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  select id, last_seen_at into v_opp_id, v_opp_seen
    from public.duel_players
   where room_id = p_room_id and id <> p_player_id
   limit 1;

  if v_opp_id is null then
    return v_room;
  end if;

  v_grace_sec := case
    when coalesce(v_room.duration_seconds, 60) <= 60  then 20
    when coalesce(v_room.duration_seconds, 60) <= 120 then 30
    else 45
  end;
  v_grace_sec := 45 + v_grace_sec;

  v_baseline := coalesce(v_opp_seen, v_room.started_at, now());

  if v_baseline > (now() - make_interval(secs => v_grace_sec)) then
    return v_room;
  end if;

  update public.duel_rooms
     set status                 = 'finished',
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
-- 5) duel_join_rematch_room (patch: finished_at satırı çıkarıldı)
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

  select count(*) into v_count
    from public.duel_players where room_id = p_new_room_id;
  if v_count >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, btrim(p_name), 0, p_profile_id, p_guest_id, now()
  );

  insert into public.duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  update public.duel_players
     set last_seen_at = now()
   where room_id = p_new_room_id;

  update public.duel_rooms
     set status                 = 'playing',
         started_at             = now(),
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


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama (Studio SQL editor):
--
--   -- duel_rooms şemasında finished_at GERÇEKTEN YOK mu?
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'duel_rooms'
--    order by ordinal_position;
--   -- finished_at LİSTEDE OLMAMALI (zaten olmadığı için bu patch yazıldı).
--
--   -- 5 RPC'nin gövdesinde artık finished_at YAZIMI YOK mu?
--   select proname
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in (
--        'duel_start_game', 'duel_finish_game', 'duel_forfeit_game',
--        'duel_handle_disconnect', 'duel_join_rematch_room'
--      )
--      and pg_get_functiondef(oid) ilike '%finished_at%';
--   -- Beklenen: 0 satır.
--
-- Smoke test:
--   1) duel_create_room (host A)
--   2) duel_join_room (joiner B)
--   3) duel_start_game (host A)         → hata YOK; status='playing'
--   4) duel_submit_claim x 2 (her oyuncu)
--   5) duel_finish_game (player A)       → hata YOK; winner server-side hesap
--   6) duel_accept_rematch (player B)    → yeni oda
--   7) duel_join_rematch_room (player A) → hata YOK; status='playing'
--   8) (opsiyonel) duel_forfeit_game / duel_handle_disconnect senaryoları
-- ============================================================================
