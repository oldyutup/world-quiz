-- ============================================================================
-- Flag Duel — RPC altyapısı (M3 lockdown sonrası FE-switch ön koşulu)
-- ============================================================================
-- AMAÇ
-- ----
-- duel_rls_hardening_m3 (20260605120000), duel_rooms / duel_players /
-- duel_claims tablolarındaki tüm INSERT/UPDATE/DELETE policy'lerini düşürdü.
-- Yazma yolu artık yalnız duel_* M2 RPC'leri üzerinden (SECURITY DEFINER).
-- M3, Duel 1v1 (countries) FE switch'inin tamamlandığını varsayıyordu.
--
-- Ama FlagDuelGame.tsx aynı üç tabloyu (duel_rooms/players/claims) paylaşır
-- ve hâlâ direkt INSERT/UPDATE/DELETE atıyor → RLS deny → "Flag Duel oda
-- kurulamıyor" + (oda kurulsa bile) startGame / advanceRoundAsHost /
-- handleGuess / acceptRematch / handleLeave akışlarının tümü deny olur.
--
-- Bu migration: Flag Duel için **paralel RPC kümesi** ekler. M3 policy'leri
-- AYNEN KORUNUR; security gevşetilmez. FE patch (ayrı bir adım) bu RPC'lere
-- switch yapacak. flag_duel_quick_match / flag_duel_cancel_quick_match /
-- flag_duel_reset_quick_match RPC'lerine DOKUNULMAZ — aynen çalışmaya devam
-- ederler.
--
-- ŞEMA KARARLARI
-- --------------
--   • room_source: CHECK constraint ('manual', 'quick_match') ile sınırlı
--     (20260516130000_flag_duel_quick_match.sql L94-106). Manuel flag duel
--     odası 'manual' kullanır (DuelGame 1v1 ile aynı değer). 'flag_manual'
--     YENİ değer EKLENMEZ — constraint genişletmek için ayrı M1 adımı gerekir.
--   • host_player_id: M1 (20260603120000) tarafından eklendi.
--     - Manuel flag duel: flag_duel_create_room set eder → flag_duel_authorize_host
--       birebir eşleştirir.
--     - QM-flag: flag_duel_quick_match host_player_id'yi set ETMEZ (NULL kalır).
--       flag_duel_authorize_host bu durumda en eski joined_at'li player'ı host
--       sayar — FlagDuelGame.tsx'in isHost = players[0]?.id mantığıyla simetrik.
--   • duel_players.profile_id / duel_player_claims: QM-flag bu kayıtları ATMAZ.
--     - Manuel flag duel: flag_duel_create_room + duel_join_room set eder →
--       duel_authorize_player çalışır.
--     - QM-flag: profile_id NULL + claim_token kaydı yok → duel_authorize_player
--       fail eder. Bunu kapatmak için flag_duel_authorize_player helper'ı
--       flag_duel_queue.profile_id = auth.uid() fallback'i ekler. QM RPC'leri
--       değiştirilmeden çalışır.
--   • duration_seconds: Flag Duel için anlamsız (timer per-flag, current_flag_at
--     + FLAG_TIMEOUT_SEC ile FE tarafı). flag_duel_create_room 60 sabit yazar
--     (FlagDuelGame.tsx createRoom direct insert de 60 yazıyordu).
--
-- COVERAGE — FlagDuelGame.tsx hangi write yolu hangi RPC'ye karşılık geliyor:
--   createRoom (L1536-1561)             → flag_duel_create_room
--   joinRoom (L1616)                    → duel_join_room (mevcut M2 RPC reuse)
--   updateHostSetting (L1645)           → flag_duel_update_settings
--   startGame (L1662)                   → flag_duel_start_game
--   handleGuess (L1693)                 → flag_duel_submit_claim
--   handlePass (L1711)                  → flag_duel_submit_claim
--   host TIMEOUT claim (L1497)          → flag_duel_submit_claim
--   advanceRoundAsHost both_passed (L788)   → flag_duel_set_next_round (round değişmez, yalnız flag)
--   advanceRoundAsHost enter golden (L812)  → flag_duel_set_next_round (round+1, is_golden=true)
--   advanceRoundAsHost normal (L845)        → flag_duel_set_next_round (round+1)
--   advanceRoundAsHost final score (L824)   → flag_duel_finalize_game
--   advanceRoundAsHost golden answered (L837) → flag_duel_finalize_game
--   acceptRematch (L889-893)            → flag_duel_accept_rematch (claims+score+room transactional)
--   handleLeave playing (L1737)         → flag_duel_leave_room (status='playing' → forfeit branch)
--   handleLeave host waiting (L1744-45) → flag_duel_leave_room (host + waiting → cascade delete branch)
--   handleLeave non-host waiting (L1747) → flag_duel_leave_room (non-host + waiting → self-delete branch)
--
-- IDEMPOTENT
-- ----------
-- Tüm function tanımları "create or replace" — re-run güvenli. Tablo şeması,
-- RLS policy, constraint değiştirilmez. Yalnız yeni fonksiyon eklenir.
--
-- TEHDİT MODELİ
-- -------------
--   • Tüm RPC'ler SECURITY DEFINER + search_path = public, auth.
--   • Yazma için (handleGuess/handlePass): flag_duel_authorize_player +
--     player_room_mismatch + status='playing' guard.
--   • Host-only (start/advance/finalize/settings/rematch):
--     flag_duel_authorize_host + room status guard.
--   • leave_room: flag_duel_authorize_player; phase-aware branch'lerde
--     ek host kontrolü.
--   • finalize_game'de winner SERVER-SIDE real-claim COUNT'undan doğrulanır
--     (PASS:/TIMEOUT: prefix'li claim'ler skora SAYILMAZ). FE'nin gönderdiği
--     p_winner_player_id ile çakışırsa raise → spoof koruması.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- HELPER 1: flag_duel_authorize_player
-- ----------------------------------------------------------------------------
-- duel_authorize_player'ı sarmalar; QM-flag odalarda (profile_id NULL +
-- claim_token kaydı yok) flag_duel_queue üzerinden auth.uid() fallback'i
-- ekler. flag_duel_queue.profile_id SELECT RLS'i auth.uid()=profile_id ile
-- sınırlı (lockdown migration'ı 20260516140000), ama bu helper SECURITY
-- DEFINER olduğu için RLS bypass eder; biz auth.uid()'i kendi içimizde
-- kontrol ediyoruz — RLS'in yerine geçen kanıt aynı: caller'ın JWT subject'i
-- ile flag_duel_queue.profile_id eşleşmeli.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    -- Manuel flag duel odası: M1-style profile_id/guest_id + claim_token
    public.duel_authorize_player(p_player_id, p_claim_token)
  or
    -- QM-flag odası: flag_duel_queue.player_id ile auth.uid() köprüsü
    exists (
      select 1
        from public.flag_duel_queue q
       where q.player_id  = p_player_id
         and q.profile_id is not null
         and q.profile_id = auth.uid()
    );
$$;

revoke all     on function public.flag_duel_authorize_player(uuid, uuid) from public;
grant  execute on function public.flag_duel_authorize_player(uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- HELPER 2: flag_duel_authorize_host
-- ----------------------------------------------------------------------------
-- Manuel oda: host_player_id eşleşmeli + flag_duel_authorize_player geçmeli.
-- QM-flag oda: host_player_id NULL → host = en eski joined_at'li player
-- (FlagDuelGame.tsx isHost = players[0]?.id mantığıyla simetrik).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_authorize_host(
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
      from public.duel_rooms r
     where r.id = p_room_id
       and public.flag_duel_authorize_player(p_player_id, p_claim_token)
       and (
         -- Manuel oda yolu
         (r.host_player_id is not null and r.host_player_id = p_player_id)
         or
         -- QM-flag yolu (host_player_id set edilmemiş → en eski player)
         (
           r.host_player_id is null
           and p_player_id = (
             select id
               from public.duel_players
              where room_id = r.id
              order by joined_at asc
              limit 1
           )
         )
       )
  );
$$;

revoke all     on function public.flag_duel_authorize_host(uuid, uuid, uuid) from public;
grant  execute on function public.flag_duel_authorize_host(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) flag_duel_create_room
-- ----------------------------------------------------------------------------
-- Manuel "Oda Kur" akışı. duel_create_room (1v1) ile aynı pattern; ek
-- alanlar: total_rounds, current_round=0, current_flag=null,
-- is_golden_round=false. room_source='manual' (CHECK constraint ile sınırlı).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_create_room(
  p_player_id    uuid,
  p_profile_id   uuid,
  p_guest_id     text,
  p_name         text,
  p_code         text,
  p_region       text,
  p_total_rounds int,
  p_claim_token  uuid
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
  if p_region is null or length(btrim(p_region)) = 0 then
    raise exception 'region_required' using errcode = '22023';
  end if;
  if p_total_rounds is null or p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'total_rounds_invalid' using errcode = '22023';
  end if;

  -- 1) Oda satırı
  begin
    insert into public.duel_rooms (
      code, status, duration_seconds, region, room_source, host_player_id,
      total_rounds, current_round, is_golden_round, current_flag
    ) values (
      p_code, 'waiting', 60, p_region, 'manual', p_player_id,
      p_total_rounds, 0, false, null
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

  -- 3) Claim token
  insert into public.duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_create_room(uuid, uuid, text, text, text, text, int, uuid) from public;
grant  execute on function public.flag_duel_create_room(uuid, uuid, text, text, text, text, int, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) flag_duel_update_settings
-- ----------------------------------------------------------------------------
-- Lobby ayarları (total_rounds + region). Host-only, status='waiting' şart.
-- En az birinin null olmayan değeri olmalı (no-op çağrıyı yakala).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_update_settings(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_total_rounds   int,
  p_region         text
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

  if p_total_rounds is null and p_region is null then
    raise exception 'no_fields_to_update' using errcode = '22023';
  end if;
  if p_total_rounds is not null and p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'total_rounds_invalid' using errcode = '22023';
  end if;
  if p_region is not null and length(btrim(p_region)) = 0 then
    raise exception 'region_invalid' using errcode = '22023';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  update public.duel_rooms
     set total_rounds = coalesce(p_total_rounds, total_rounds),
         region       = coalesce(p_region,       region)
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_update_settings(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.flag_duel_update_settings(uuid, uuid, uuid, int, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) flag_duel_start_game
-- ----------------------------------------------------------------------------
-- Host-only. waiting → playing geçişi. current_flag/current_flag_at server-
-- side now(). is_golden_round=false. Tüm finished alanları resetlenir
-- (rematch sonrası temizlik için defansif). Kapasite=2 zorunlu.
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
         finished_at            = null,
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
-- 4) flag_duel_submit_claim
-- ----------------------------------------------------------------------------
-- Player-only. handleGuess / handlePass / host TIMEOUT — üçü de buradan
-- geçer. country_code free text (PASS:R{n}:{flag}:{playerId} ve
-- TIMEOUT:R{n}:{flag} prefix'lerini desteklemek için filter yok). Dup =
-- UNIQUE(room_id, country_code) violation → {claimed:false, reason:'dup'}.
-- status='playing' guard yarış kondisyonlarını kapatır (advance/finalize
-- aynı anda olursa claim no-op kalsın).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_submit_claim(
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
  if not public.flag_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_country_code is null or length(btrim(p_country_code)) = 0 then
    raise exception 'country_code_required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select status into v_room_status
    from public.duel_rooms
   where id = p_room_id;

  if v_room_status is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room_status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  begin
    insert into public.duel_claims (room_id, player_id, country_code)
    values (p_room_id, p_player_id, p_country_code);
  exception
    when unique_violation then
      return jsonb_build_object('claimed', false, 'reason', 'dup');
  end;

  return jsonb_build_object('claimed', true);
end;
$$;

revoke all     on function public.flag_duel_submit_claim(uuid, uuid, uuid, text) from public;
grant  execute on function public.flag_duel_submit_claim(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) flag_duel_set_next_round
-- ----------------------------------------------------------------------------
-- Host-only. status='playing' guard.
-- advanceRoundAsHost'un üç yolunu tek RPC ile karşılar:
--   (a) both_passed → round değişmez, yalnız flag yenilenir (caller
--       p_next_round=current_round geçer)
--   (b) normal advance → round+1, golden bayrağı durumu unchanged kalabilir
--   (c) enter golden → round+1, is_golden_round=true
-- current_flag_at her durumda server-side now().
-- winner / finished alanlarına dokunulmaz; finalize ayrı RPC.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_set_next_round(
  p_room_id         uuid,
  p_host_player_id  uuid,
  p_claim_token     uuid,
  p_next_round      int,
  p_next_flag       text,
  p_is_golden_round boolean
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
  if p_next_round is null or p_next_round < 1 then
    raise exception 'next_round_invalid' using errcode = '22023';
  end if;
  if p_next_flag is null or length(btrim(p_next_flag)) = 0 then
    raise exception 'next_flag_required' using errcode = '22023';
  end if;
  if p_is_golden_round is null then
    raise exception 'is_golden_round_required' using errcode = '22023';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  update public.duel_rooms
     set current_round    = p_next_round,
         current_flag     = p_next_flag,
         current_flag_at  = now(),
         is_golden_round  = p_is_golden_round,
         -- Golden-açma akışında winner/finished alanları "in case left dirty"
         -- temizlenmeli (FE direct-update L817-818 davranışıyla simetrik).
         winner_player_id = null,
         finished_reason  = null
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_set_next_round(uuid, uuid, uuid, int, text, boolean) from public;
grant  execute on function public.flag_duel_set_next_round(uuid, uuid, uuid, int, text, boolean) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) flag_duel_finalize_game
-- ----------------------------------------------------------------------------
-- Host-only. playing → finished geçişi. finished_reason='score' sabit
-- (forfeit/disconnect ayrı yollardan geçer: leave_room).
--
-- Defense-in-depth: p_winner_player_id FE'den geliyor ama server-side
-- "gerçek" claim count'larıyla cross-check edilir:
--   • PASS:/TIMEOUT: prefix'li claim'ler skora SAYILMAZ
--   • En yüksek gerçek-claim sayılı player = otoriter kazanan
--   • Top-1 ile top-2 EŞİTSE kazanan = NULL (tie semantiği)
--   • FE'nin gönderdiği p_winner_player_id otoriter sonuçla uyuşmazsa
--     'winner_mismatch' raise — spoof koruması.
--
-- Idempotent: status zaten 'finished' ise mevcut satırı döner.
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
         finished_at      = now(),
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
-- 7) flag_duel_accept_rematch
-- ----------------------------------------------------------------------------
-- Host-only. Mevcut oda finished/playing'den temiz başlangıca alınır:
--   • duel_claims: oda için tümünü sil
--   • duel_players: oda için score=0 + last_seen_at=now() reset
--   • duel_rooms: status='playing', current_round=1, current_flag=p_first_flag,
--     current_flag_at=now(), is_golden_round=false, finished* alanları temiz,
--     started_at=now() (yeni maç başlangıcı)
--
-- NOT: FE acceptRematch akışında HEM host HEM rakip çağırıyor (rematch_accepted
-- broadcast iki client'ı da tetikliyor). Host-only RPC ise non-host'un
-- çağrısı unauthorized döner. FE patch'inde acceptRematch yalnız host'ta
-- RPC çağrısı yapacak şekilde gate'lenmeli — diğer client realtime UPDATE
-- ile state'i güncel görür. (Test plan'da işaretlendi.)
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
         finished_at            = null,
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
-- 8) flag_duel_leave_room
-- ----------------------------------------------------------------------------
-- Phase-aware (server-side status'tan türetilir; FE'den phase parametresi
-- almıyoruz — yalan beyanı önler):
--
--   status='playing' → caller LOSER, rakip WINNER, finished+forfeit.
--                      Player satırı SİLİNMEZ (finished ekranında görünmeli).
--   status='waiting' + caller host        → tüm oda sil (FK cascade ile
--                                            players + player_claims).
--   status='waiting' + caller non-host    → kendi player satırını sil.
--                                            Oda boşaldıysa odayı da sil.
--   status='finished'                     → no-op (idempotent).
--
-- Host kontrolü: flag_duel_authorize_host (manuel + QM-flag uyumlu).
-- Caller en azından flag_duel_authorize_player geçmeli + odanın bir
-- üyesi olmalı.
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
           finished_at         = now(),
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
-- Doğrulama sorguları (Studio SQL editor'de manuel):
--
--   -- Yeni RPC'lerin tümü kayıtlı mı?
--   select proname
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in (
--        'flag_duel_authorize_player',
--        'flag_duel_authorize_host',
--        'flag_duel_create_room',
--        'flag_duel_update_settings',
--        'flag_duel_start_game',
--        'flag_duel_submit_claim',
--        'flag_duel_set_next_round',
--        'flag_duel_finalize_game',
--        'flag_duel_accept_rematch',
--        'flag_duel_leave_room'
--      )
--    order by proname;
--   -- Beklenen: 10 satır.
--
--   -- Tümü SECURITY DEFINER + grant anon, authenticated:
--   select p.proname, p.prosecdef,
--          array(select rolname from pg_roles where pg_has_function_privilege(rolname, p.oid, 'execute'))
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname like 'flag_duel_%'
--      and p.proname not in ('flag_duel_quick_match', 'flag_duel_cancel_quick_match',
--                            'flag_duel_reset_quick_match', 'flag_duel_mode_level');
--   -- Beklenen: prosecdef=true; anon + authenticated execute privilege.
--
--   -- Negatif test (anon JWT — manuel akışı taklit eden örnek):
--   --   select * from public.flag_duel_create_room(
--   --     gen_random_uuid(), null, 'guest-abc', 'TestUser',
--   --     'TST001', 'world', 10, gen_random_uuid()
--   --   );
--   --   → başarılı.
--   --   insert into duel_rooms (code, status, ...) values (...);
--   --   → "new row violates row-level security policy" — direct write hâlâ deny.
-- ============================================================================
