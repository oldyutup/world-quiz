-- ============================================================================
-- Flag Duel — RPC patch · "finished_at" kolonu hatasının düzeltilmesi
-- ============================================================================
-- SORUN
-- -----
-- 20260612120000_flag_duel_rpc_hardening.sql yazılırken `duel_rooms.finished_at`
-- kolonuna yazımlar bırakıldı. Legacy `duel_rooms` şemasında bu kolon
-- BULUNMUYOR — Duel 1v1 M2 RPC'lerinde aynı hata 20260606120000_duel_m2_patch_
-- finished_at.sql ile düzeltilmişti; Flag Duel migration'ı o pattern'i
-- (özellikle Duel 1v1 M2'nin pre-patch versiyonunu) base alarak yazıldığı için
-- aynı yanlış kolon yazımı buraya taşındı.
--
-- BELİRTİ
-- -------
-- flag_duel_start_game çağrısında PostgreSQL hatası:
--   column "finished_at" of relation "duel_rooms" does not exist
-- Aynı hata flag_duel_finalize_game, flag_duel_accept_rematch ve
-- flag_duel_leave_room (playing→forfeit yolu) ilk tetiklendiğinde de düşerdi.
--
-- ETKİLENEN RPC'LER (4 adet)
-- --------------------------
--   • flag_duel_start_game       (set finished_at = null)
--   • flag_duel_finalize_game    (set finished_at = now())
--   • flag_duel_accept_rematch   (set finished_at = null)
--   • flag_duel_leave_room       (set finished_at = now()  — playing→forfeit branch)
--
-- DOKUNULMAYAN RPC'LER
-- --------------------
--   • flag_duel_authorize_player / flag_duel_authorize_host  (helper'lar)
--   • flag_duel_create_room        (finished_at yazmıyordu)
--   • flag_duel_update_settings    (yalnız total_rounds + region)
--   • flag_duel_submit_claim       (duel_claims insert only)
--   • flag_duel_set_next_round     (current_round/flag/golden update; finished_at YOK)
--   • flag_duel_quick_match / cancel / reset / mode_level (mevcut QM RPC'leri)
--
-- ŞEMA KONTROLÜ
-- -------------
-- duel_rooms'da Flag Duel RPC'leri tarafından yazılan diğer kolonlar:
--   status, started_at, current_round, current_flag, current_flag_at,
--   is_golden_round, finished_reason, winner_player_id, forfeited_player_id,
--   disconnected_player_id, disconnect_at, duration_seconds, region,
--   total_rounds, room_source, host_player_id, code
-- Hepsi mevcut (Duel 1v1 M2 patch sonrası canlıda doğrulandı; FlagDuel
-- şeması kolonlarını da 20260516130000_flag_duel_quick_match.sql ekledi).
-- finished_at TEK eksik referans.
--
-- DÜZELTME
-- --------
-- Bu patch yukarıdaki 4 RPC'yi `create or replace` ile yeniden tanımlar ve
-- her birinden `finished_at` satırını çıkarır. Diğer kolonlar, parametreler,
-- güvenlik kontrolleri (authorize_host / authorize_player), winner cross-
-- check mantığı, idempotency davranışı AYNEN korunur.
--
-- FRONTEND ETKİSİ
-- ---------------
-- Sıfır. FlagDuelGame.tsx hiç finished_at okumuyor (grep doğrulandı; DuelRoom
-- TypeScript arayüzünde de yok — src/lib/supabase.ts). Bitiş zamanı için
-- finished_reason + winner_player_id + (forfeit ise forfeited_player_id)
-- alanları yeterli.
--
-- RLS LOCKDOWN ETKİSİ
-- -------------------
-- Sıfır. M3 policy'lerine dokunmuyor; 4 RPC SECURITY DEFINER ile bypass
-- ediyor. İmzalar değişmedi → mevcut grant'lar geçerli.
--
-- IDEMPOTENT
-- ----------
-- Tüm RPC'ler `create or replace` (imza değişmedi). Re-run güvenli.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) flag_duel_start_game (patch: finished_at satırı çıkarıldı)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_first_flag     text
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room  public.duel_rooms;
  v_count int;
begin
  if not public.flag_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_first_flag is null or length(btrim(p_first_flag)) = 0 then
    raise exception 'first_flag_required' using errcode = '22023';
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
         current_round          = 1,
         current_flag           = p_first_flag,
         current_flag_at        = now(),
         is_golden_round        = false,
         finished_reason        = null,
         winner_player_id       = null,
         forfeited_player_id    = null,
         disconnected_player_id = null,
         disconnect_at          = null
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  -- Heartbeat clock'unu hizala (opp monitor stale baseline'ı için)
  update public.duel_players
     set last_seen_at = now()
   where room_id = p_room_id;

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_start_game(uuid, uuid, uuid, text) from public;
grant  execute on function public.flag_duel_start_game(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) flag_duel_finalize_game (patch: finished_at satırı çıkarıldı)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_finalize_game(
  p_room_id          uuid,
  p_host_player_id   uuid,
  p_claim_token      uuid,
  p_winner_player_id uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.duel_rooms;
  v_top_id     uuid;
  v_top_cnt    int;
  v_second_cnt int;
  v_auth_winner uuid;
begin
  if not public.flag_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Otoriter winner: PASS:/TIMEOUT: hariç gerçek claim COUNT'u
  select player_id, cnt
    into v_top_id, v_top_cnt
    from (
      select player_id, count(*) as cnt
        from public.duel_claims
       where room_id = p_room_id
         and country_code not like 'PASS:%'
         and country_code not like 'TIMEOUT:%'
       group by player_id
       order by count(*) desc
       limit 1
    ) t;

  if v_top_id is null then
    -- Hiç gerçek claim yok → tie (winner null)
    v_auth_winner := null;
  else
    -- İkinci sıra
    select cnt into v_second_cnt
      from (
        select count(*) as cnt
          from public.duel_claims
         where room_id = p_room_id
           and country_code not like 'PASS:%'
           and country_code not like 'TIMEOUT:%'
           and player_id <> v_top_id
         group by player_id
         order by count(*) desc
         limit 1
      ) s;

    if v_second_cnt is not null and v_second_cnt = v_top_cnt then
      v_auth_winner := null;  -- eşitlik
    else
      v_auth_winner := v_top_id;
    end if;
  end if;

  -- Cross-check: FE'nin gönderdiği winner otoriter sonuçla aynı mı?
  if v_auth_winner is distinct from p_winner_player_id then
    raise exception 'winner_mismatch' using errcode = 'P0001';
  end if;

  update public.duel_rooms
     set status           = 'finished',
         finished_reason  = 'score',
         winner_player_id = v_auth_winner
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_finalize_game(uuid, uuid, uuid, uuid) from public;
grant  execute on function public.flag_duel_finalize_game(uuid, uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) flag_duel_accept_rematch (patch: finished_at satırı çıkarıldı)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_accept_rematch(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_first_flag     text
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.duel_rooms;
begin
  if not public.flag_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_first_flag is null or length(btrim(p_first_flag)) = 0 then
    raise exception 'first_flag_required' using errcode = '22023';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status not in ('finished', 'playing') then
    raise exception 'room_not_rematchable' using errcode = 'P0001';
  end if;

  delete from public.duel_claims where room_id = p_room_id;

  update public.duel_players
     set score        = 0,
         last_seen_at = now()
   where room_id = p_room_id;

  update public.duel_rooms
     set status                 = 'playing',
         started_at             = now(),
         current_round          = 1,
         current_flag           = p_first_flag,
         current_flag_at        = now(),
         is_golden_round        = false,
         finished_reason        = null,
         winner_player_id       = null,
         forfeited_player_id    = null,
         disconnected_player_id = null,
         disconnect_at          = null
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_accept_rematch(uuid, uuid, uuid, text) from public;
grant  execute on function public.flag_duel_accept_rematch(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) flag_duel_leave_room (patch: playing→forfeit branch'inde finished_at çıkarıldı)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room      public.duel_rooms;
  v_is_host   boolean;
  v_opp_id    uuid;
  v_remaining int;
begin
  if not public.flag_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    return;  -- oda yok → no-op
  end if;
  if v_room.status = 'finished' then
    return;  -- zaten kapanmış → no-op
  end if;

  -- Player odaya gerçekten ait mi?
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Playing → forfeit yolu
  if v_room.status = 'playing' then
    select id into v_opp_id
      from public.duel_players
     where room_id = p_room_id and id <> p_player_id
     limit 1;

    update public.duel_rooms
       set status              = 'finished',
           finished_reason     = 'forfeit',
           forfeited_player_id = p_player_id,
           winner_player_id    = v_opp_id
     where id = p_room_id
       and status = 'playing';
    return;
  end if;

  -- Waiting yolu: host mu?
  v_is_host := public.flag_duel_authorize_host(p_room_id, p_player_id, p_claim_token);

  if v_is_host then
    -- Host ayrılıyor → oda komple silinsin (FK cascade)
    delete from public.duel_rooms where id = p_room_id;
    return;
  end if;

  -- Non-host waiting → kendi player satırı
  delete from public.duel_players
   where id = p_player_id and room_id = p_room_id;

  -- Oda boşaldıysa cleanup (duel_leave_room ile birebir davranış)
  select count(*) into v_remaining
    from public.duel_players where room_id = p_room_id;
  if v_remaining = 0 then
    delete from public.duel_rooms where id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.flag_duel_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.flag_duel_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama (Studio SQL editor):
--
--   -- duel_rooms şemasında finished_at GERÇEKTEN YOK mu?
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'duel_rooms'
--    order by ordinal_position;
--   -- finished_at LİSTEDE OLMAMALI.
--
--   -- 4 flag_duel_* RPC'nin gövdesinde artık finished_at YAZIMI YOK mu?
--   select proname
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in (
--        'flag_duel_start_game', 'flag_duel_finalize_game',
--        'flag_duel_accept_rematch', 'flag_duel_leave_room'
--      )
--      and pg_get_functiondef(oid) ilike '%finished_at%';
--   -- Beklenen: 0 satır.
--
-- Smoke test:
--   1) flag_duel_create_room (host A)
--   2) duel_join_room        (joiner B)
--   3) flag_duel_start_game  (host A)             → hata YOK; status='playing'
--   4) flag_duel_submit_claim x N (her oyuncu, claim/PASS/TIMEOUT)
--   5) flag_duel_set_next_round x N (host A)
--   6) flag_duel_finalize_game (host A)           → hata YOK; winner doğrulanır
--   7) flag_duel_accept_rematch (host A)          → hata YOK; oda reset
--   8) flag_duel_leave_room (player, playing'de)  → hata YOK; forfeit
-- ============================================================================
