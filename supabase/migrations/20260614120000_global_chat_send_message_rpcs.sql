-- ============================================================================
-- M-Chat-A: Global Chat — Mode-specific send_message RPC'leri (Dilim 1, soft)
-- ============================================================================
-- AMAÇ
--   duel_send_message (M2 / 20260604120000_duel_rls_hardening_m2.sql:1061)
--   deseninin birebir karşılığını kalan 5 mod için kurmak. duel_messages
--   tablosu paylaşımlı (room_code üzerinden ayrılıyor) — her mod kendi player
--   tablosu + authorize helper'ı üzerinden yetkili olduğu odaya mesaj atabilir.
--
-- DİLİM AYRIMI
--   • Bu migration (Dilim 1, yumuşak geçiş): yalnız yeni RPC'ler eklenir.
--     duel_messages'in RLS / policy / grant durumuna DOKUNULMAZ. Frontend
--     LobbyChat ve call-site'lar RPC'ye geçtikten sonra eski direct insert
--     yolu pratikte ölü kalır; ama tablo hâlâ açık olduğu için cache'li
--     client'lar mesaj atmaya devam edebilir → bozulma yok.
--   • Dilim 2 (ayrı migration, ≥24 sa smoke sonrası):
--       - duel_messages INSERT/UPDATE/DELETE grant revoke
--       - mevcut INSERT/UPDATE/DELETE policy'leri DROP
--       - SELECT açık kalır (history + realtime için)
--
-- EKLENENLER (5 RPC)
--   • flag_duel_send_message
--   • wheel_duel_send_message
--   • wheel_group_send_message
--   • duel_group_send_message
--   • conquest_send_message
--
-- PATTERN (her RPC için identical)
--   • SECURITY DEFINER + set search_path = public, auth
--   • <mode>_authorize_player(p_player_id, p_claim_token) → false ise
--       'unauthorized' (42501)
--   • p_room_code null/boş → 'room_code_required' (22023)
--   • p_message null → 'message_required' (22023)
--   • btrim(p_message) length=0 → 'message_empty' (22023)
--   • btrim(p_message) length>200 → 'message_too_long' (22023)
--   • <mode>_players.id = p_player_id yoksa → 'player_not_found' (02000)
--   • Player'ın gerçek odasının code'unu fetch et;
--     <mode>_rooms.code (Conquest'te room_code) p_room_code ile eşleşmiyorsa
--     → 'room_code_mismatch' (42501) — cross-room spoof guard.
--   • player_name CLIENT'TAN ALINMAZ → <mode>_players.name'i server-side
--     resolve eder. Rakibin adıyla mesaj atma spoof'u DB'de bloklanır.
--   • insert into duel_messages(room_code, player_name, message)
--   • returning * → duel_messages satırı (frontend optimistic'i bu gerçek
--     satırla replace eder, broadcast bu satırı yayar).
--   • revoke all from public; grant execute to anon, authenticated.
--
-- NOTLAR
--   • Flag Duel ve Duel 1v1 aynı duel_rooms + duel_players tablolarını
--     paylaşıyor. flag_duel_send_message yine de ayrı bir RPC: çünkü flag
--     duel QM odalarında duel_players.profile_id NULL ve duel_player_claims
--     satırı yok → duel_authorize_player FAIL eder. Flag Duel kendi
--     authorize helper'ında flag_duel_queue.profile_id = auth.uid()
--     fallback'i tutuyor (20260612120000_flag_duel_rpc_hardening.sql).
--   • Conquest tablosu: conquest_rooms.room_code (text not null unique).
--     Diğer modlar: <mode>_rooms.code.
--   • Rate-limit BU migration'da YOK. Smoke metriği temizse Dilim 2 ile
--     veya ayrı bir patch ile eklenir (yeni 5 RPC + duel_send_message).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) flag_duel_send_message
-- ----------------------------------------------------------------------------
-- duel_send_message ile yapısı IDENTIC; tek fark authorize helper'ı
-- (flag_duel_authorize_player: duel_authorize_player + queue auth.uid()
-- fallback). Manuel flag duel + QM flag duel ikisi de aynı yoldan geçer.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_send_message(
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
  v_player    public.duel_players;
  v_room_code text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.flag_duel_authorize_player(p_player_id, p_claim_token) then
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

  select * into v_player from public.duel_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select code into v_room_code
    from public.duel_rooms
   where id = v_player.room_id;

  if v_room_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room_code <> p_room_code then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.flag_duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.flag_duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) wheel_duel_send_message
-- ----------------------------------------------------------------------------
-- Wheel Duel 1v1 player tablosu (wheel_duel_players) + wheel_duel_rooms.code.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_send_message(
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
  v_player    public.wheel_duel_players;
  v_room_code text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
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

  select * into v_player from public.wheel_duel_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select code into v_room_code
    from public.wheel_duel_rooms
   where id = v_player.room_id;

  if v_room_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room_code <> p_room_code then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.wheel_duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) wheel_group_send_message
-- ----------------------------------------------------------------------------
-- Wheel Group (Multi-Wheel) — wheel_group_players + wheel_group_rooms.code.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_send_message(
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
  v_player    public.wheel_group_players;
  v_room_code text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.wheel_group_authorize_player(p_player_id, p_claim_token) then
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

  select * into v_player from public.wheel_group_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select code into v_room_code
    from public.wheel_group_rooms
   where id = v_player.room_id;

  if v_room_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room_code <> p_room_code then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.wheel_group_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) duel_group_send_message
-- ----------------------------------------------------------------------------
-- Duel Group — duel_group_players + duel_group_rooms.code.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_send_message(
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
  v_player    public.duel_group_players;
  v_room_code text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.duel_group_authorize_player(p_player_id, p_claim_token) then
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

  select * into v_player from public.duel_group_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select code into v_room_code
    from public.duel_group_rooms
   where id = v_player.room_id;

  if v_room_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room_code <> p_room_code then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.duel_group_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.duel_group_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) conquest_send_message
-- ----------------------------------------------------------------------------
-- Conquest — conquest_players + conquest_rooms.room_code (DİKKAT: room_code
-- kolonu; diğer modlar code).
--
-- NOT: Conquest UI'da guest chat zaten KAPALI (ConquestLobby.tsx:380 isLoggedIn
-- dalı). conquest_authorize_player misafir branch'i için claim_token bekliyor;
-- Conquest claim mekanizması conquestClaim.ts üzerinden localStorage'a yazıyor
-- (claim row her create/join'da DB'de var). Bu RPC misafir senaryosunda dahi
-- çağrılırsa authorize ile düzgün cevap verir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_send_message(
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
  v_player    public.conquest_players;
  v_room_code text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
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

  select * into v_player from public.conquest_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select room_code into v_room_code
    from public.conquest_rooms
   where id = v_player.room_id;

  if v_room_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room_code <> p_room_code then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.conquest_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.conquest_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel, Studio SQL editor'de):
--
--   -- Yeni 5 RPC + mevcut duel_send_message hepsi SECURITY DEFINER?
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in (
--        'duel_send_message',
--        'flag_duel_send_message',
--        'wheel_duel_send_message',
--        'wheel_group_send_message',
--        'duel_group_send_message',
--        'conquest_send_message'
--      )
--    order by proname;
--   -- Beklenen: 6 satır, hepsi prosecdef = true.
--
--   -- Grant: anon + authenticated execute
--   select p.proname, r.rolname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     join lateral (
--       select grantee::text as rolname
--         from information_schema.routine_privileges
--        where specific_schema = 'public'
--          and routine_name    = p.proname
--          and privilege_type  = 'EXECUTE'
--     ) r on true
--    where n.nspname = 'public'
--      and p.proname in (
--        'flag_duel_send_message',
--        'wheel_duel_send_message',
--        'wheel_group_send_message',
--        'duel_group_send_message',
--        'conquest_send_message'
--      )
--    order by p.proname, r.rolname;
--   -- Beklenen: her RPC için anon + authenticated.
--
--   -- duel_messages tablosu DOKUNULMADI mı? Policy'ler ve grant'lar değişmemiş
--   -- olmalı (Dilim 2'de değişecek):
--   select policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'duel_messages'
--    order by policyname;
--
-- Smoke (manuel):
--   • Her modda oda kur → 2. tarayıcıdan katıl → mesaj at → her iki tarafta
--     görsün → DB'de player_name sunucu tarafında çözülen ad olarak yazılı.
--   • DevTools: supabase.rpc('<mode>_send_message', { p_room_code: 'BAŞKA',
--     p_player_id, p_claim_token, p_message: 'spoof' }) → 'room_code_mismatch'.
--   • DevTools: yanlış claim_token → 'unauthorized'.
--   • 201 char → 'message_too_long'.
--   • Whitespace-only → 'message_empty'.
-- ============================================================================
