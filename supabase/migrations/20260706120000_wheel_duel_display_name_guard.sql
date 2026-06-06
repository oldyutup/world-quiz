-- ============================================================================
-- Wheel Duel — Display Name Registry Guard (RPC integration, sadece Çark 1v1)
-- ============================================================================
-- Bu migration yalnızca iki RPC'yi CREATE OR REPLACE ile yeniden tanımlar:
--
--   1) public.wheel_duel_create_room
--   2) public.wheel_duel_join_room
--
-- Tek davranış değişikliği:
--   p_name doğrudan btrim(p_name) ile wheel_duel_players.name'e yazılmıyor;
--   önce
--     public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id)
--   helper'ından geçiyor. Helper:
--     • Boş / çok kısa / çok uzun (<2 veya >16) → 'name_invalid'                (22023)
--     • Yasaklı / rezerv / küfürlü kelime listesinde → 'display_name_forbidden' (P0001)
--     • Kayıtlı bir profile.username taklit ediyorsa
--       → 'registered_username_taken'                                          (P0001)
--     • Aksi halde temizlenmiş adı döner; players satırına bu yazılır.
--
-- DOKUNULMAYAN davranışlar (mevcut sözleşme aynen korunur):
--   • profile_mismatch (auth.uid() ≠ p_profile_id)                             → 42501
--   • guest_id_required, claim_token_required, player_id_required,
--     code_required, duration_invalid, region_required                        → 22023
--   • code_taken (race), room_not_found, room_finished, room_in_progress,
--     room_unavailable, room_full, name_taken                                 → P0001 / 02000
--   • Oda içi case-insensitive name_taken kontrolü                            → korundu
--   • RPC imzaları, GRANT/REVOKE, SECURITY DEFINER, search_path               → değişmedi
--
-- KAPSAM:
--   • Yalnızca Wheel Duel / Çark 1v1 manuel oda kurma + katılma.
--   • DOKUNULMAYAN modlar: WheelGroup (zaten helper'ı çağırıyor), Duel 1v1,
--     DuelGroup, FlagDuel, Conquest, ve tüm quick-match RPC'leri
--     (wheel_duel_quick_match, wheel_duel_cancel_quick_match dahil).
--
-- BAĞIMLILIK:
--   • 20260704120000_display_name_registry_guard_helper.sql
--   • 20260705130000_display_name_forbidden_words.sql
--     (public.assert_display_name_allowed kayıtlı ve forbidden-words listesi
--     etkin olmalı.)
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) wheel_duel_create_room  — helper entegrasyonu
-- ----------------------------------------------------------------------------
-- Body'de tek anlamlı değişiklik:
--   • Eski "name_invalid (<2)" inline check'i çıkarıldı; helper içeride
--     hem boş/kısa hem uzun (>16) hem display_name_forbidden hem
--     registered_username_taken senaryolarını tek seferde işliyor.
--   • players.name'e yazılan değer artık helper'ın döndürdüğü v_display_name.
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
  v_room         public.wheel_duel_rooms;
  v_uid          uuid := auth.uid();
  v_display_name text;
begin
  -- Kimlik tutarlılığı (mevcut sözleşme)
  if p_profile_id is not null then
    if v_uid is null or p_profile_id <> v_uid then
      raise exception 'profile_mismatch' using errcode = '42501';
    end if;
  else
    if p_guest_id is null or length(btrim(p_guest_id)) = 0 then
      raise exception 'guest_id_required' using errcode = '22023';
    end if;
  end if;

  -- Input validation (mevcut sıra; name_invalid'in pozisyonu helper'a devrediyor)
  if p_claim_token is null then
    raise exception 'claim_token_required' using errcode = '22023';
  end if;
  if p_player_id is null then
    raise exception 'player_id_required' using errcode = '22023';
  end if;

  -- ── Display name: helper ile validate + registry guard. ──
  -- Helper hata fırlatırsa ('name_invalid' / 'display_name_forbidden' /
  -- 'registered_username_taken') aynen yukarıya yayılır; client
  -- describeWheelDuelRpcError ile yakalar.
  v_display_name := public.assert_display_name_allowed(
    p_name, p_profile_id, p_guest_id
  );

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

  -- 2) Host player satırı.
  --    Eski: btrim(p_name).  Yeni: v_display_name (helper temizledi).
  insert into public.wheel_duel_players (
    id, room_id, name, score, profile_id, guest_id
  ) values (
    p_player_id, v_room.id, v_display_name, 0, p_profile_id, p_guest_id
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
-- 2) wheel_duel_join_room  — helper entegrasyonu
-- ----------------------------------------------------------------------------
-- Body'de tek anlamlı değişiklik:
--   • Eski "name_invalid (<2)" inline check'i çıkarıldı; helper aynı işi yapıyor.
--   • Oda içi case-insensitive name_taken kontrolü v_display_name üzerinden
--     yapılıyor. (lower(btrim(v_display_name)) ≡ lower(btrim(p_name))
--     olduğu için davranış aynı; intent daha net.)
--   • players.name'e yazılan değer v_display_name.
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
  v_room         public.wheel_duel_rooms;
  v_uid          uuid := auth.uid();
  v_count        int;
  v_display_name text;
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

  -- ── Display name: helper ile validate + registry guard. ──
  v_display_name := public.assert_display_name_allowed(
    p_name, p_profile_id, p_guest_id
  );

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

  -- İsim çakışması (case-insensitive). v_display_name zaten btrim'lendi;
  -- lower(...) iki taraf için de eşdeğer.
  if exists (
    select 1 from public.wheel_duel_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(v_display_name)
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
    p_player_id, v_room.id, v_display_name, 0, p_profile_id, p_guest_id
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


-- ============================================================================
-- Doğrulama (Studio SQL editor)
-- ============================================================================
--   -- İmzalar aynı mı?
--   select proname, pg_get_function_arguments(oid)
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('wheel_duel_create_room', 'wheel_duel_join_room');
--
--   -- Helper referansı body içinde geçiyor mu?
--   select proname
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('wheel_duel_create_room', 'wheel_duel_join_room')
--      and pg_get_functiondef(oid) ilike '%assert_display_name_allowed%';
--   -- Beklenen: iki satır.
--
-- Smoke:
--   1) Misafir + kayıtlı bir nick ile wheel_duel_create_room
--      → SQLSTATE P0001, message LIKE '%registered_username_taken%'
--   2) Misafir + 'admin' / 'torble' / 'official' / 'guest' / küfür
--      → SQLSTATE P0001, message LIKE '%display_name_forbidden%'
--   3) Misafir + serbest nick                                   → başarı
--   4) Authenticated + kendi nick'i                             → başarı
--   5) Authenticated + başkasının kayıtlı nick'i                → registered_username_taken
--   6) wheel_duel_join_room ile aynı 5 senaryo
--   7) İki misafir aynı serbest nick → 2. çağrıda 'name_taken'  (oda içi check)
-- ============================================================================
