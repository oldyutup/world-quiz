-- ============================================================================
-- M-Chat-C: Global Chat — send_message RPC'lerine soft anti-spam (patch)
-- ============================================================================
-- AMAÇ
--   M-Chat-A (20260614120000_global_chat_send_message_rpcs.sql) + duel M2
--   (20260604120000_duel_rls_hardening_m2.sql) ile gelen 6 send_message RPC'sine
--   insert öncesi soft rate-limit + duplicate guard ekler:
--
--     • duel_send_message
--     • flag_duel_send_message
--     • wheel_duel_send_message
--     • wheel_group_send_message
--     • duel_group_send_message
--     • conquest_send_message
--
--   Kurallar (aynı player_name + room_code için, mesaj trimlenmiş haliyle):
--     (1) son 3 saniyede   ≥3  mesaj → 'rate_limited'      (4. mesaj kesilir)
--     (2) son 10 saniyede  ≥8  mesaj → 'rate_limited'      (9. mesaj kesilir)
--     (3) son 5 saniyede aynı mesaj  → 'duplicate_message' (kopya basma engeli)
--
--   3 quick burst + 10sn'de 8 mesaj normal hızlı sohbet için yeterli marj;
--   spam ya da çift-tıklama auto-resend için yeterli baraj.
--
-- DİZAYN
--   • Tüm 6 RPC ortak bir helper'a çağrı atar:
--       public._duel_messages_antispam_check(p_room_code, p_player_name, p_trim)
--     Helper SECURITY DEFINER + search_path = public; revoke all from public —
--     yalnız diğer SECURITY DEFINER fonksiyonlardan (definer=postgres) çağrılır,
--     anon/authenticated direkt çağıramaz.
--   • RPC gövdeleri M-Chat-A pattern'i ile IDENTIC; tek fark: room_code mismatch
--     guard'ından SONRA, INSERT'ten ÖNCE bir satır helper call eklenmiş olması.
--     Tüm mevcut hata kodları (unauthorized / room_code_required /
--     message_required / message_empty / message_too_long / player_not_found /
--     room_not_found / room_code_mismatch) korunur.
--   • SECURITY DEFINER ve revoke-from-public + grant-to-anon+authenticated
--     pattern'i değişmedi.
--
-- DOKUNULMAYAN ŞEYLER
--   • duel_messages tablosunun RLS / policy / GRANT durumu (M-Chat-B lockdown).
--   • Frontend hata gösterimi: LobbyChat şu an alttaki hata kodlarını generic
--     toast olarak işliyor; rate_limited / duplicate_message ayrı UX için bu
--     migration'da DEĞİŞİKLİK yok — yalnız sunucu tarafı baraj.
--   • Diğer RPC'lerin (room create/join/start/finish/...) gövdesi.
--   • Diğer modların authorize helper'ları.
--
-- IDEMPOTENT
--   • create or replace function — tekrar koşulursa son tanım yerleşir.
--   • create index if not exists — tekrar koşulursa no-op.
--
-- PERFORMANS NOTU
--   • Antispam helper aynı pencerede 3 küçük COUNT sorgusu atar:
--       (room_code, player_name, created_at > now() - interval)
--     Bu erişim örüntüsü için partial-uyumlu B-tree index ekleniyor:
--       ix_duel_messages_room_player_created_at (room_code, player_name,
--                                                created_at desc)
--     Tabloda zaten created_at için generic bir index olabilir (Studio); bu
--     index daha spesifik olduğundan planner anti-spam pencerelerinde bunu
--     tercih eder. Tabloya ek bir yük getirmediği için risksiz.
--
-- ROLLBACK
-- --------
-- Acil revert: aşağıdaki SQL bloğu anti-spam helper'ı düşürür ve 6 RPC'yi
-- M-Chat-A / M2 hâline (anti-spam çağrısı YOK) geri kurar. DEFAULT olarak
-- ÇALIŞTIRILMAZ; manuel kopyala-yapıştır ile.
--
--   -- ROLLBACK ───────────────────────────────────────────────────────────
--   -- Bu migration'ı oluşturmadan önceki canlı durumda aşağıdaki dosyalar
--   -- 6 RPC'nin gövdesini tutuyordu — Studio'da o dosyaların ilgili
--   -- create or replace function bloklarını aynen tekrar çalıştırın:
--   --   • duel_send_message →
--   --       supabase/migrations/20260604120000_duel_rls_hardening_m2.sql:1061
--   --   • diğer 5 send_message →
--   --       supabase/migrations/20260614120000_global_chat_send_message_rpcs.sql:69
--   -- Sonra:
--   drop function if exists public._duel_messages_antispam_check(text, text, text);
--   -- Index'i bırakmak güvenli (yalnız read-side); istenirse:
--   -- drop index if exists public.ix_duel_messages_room_player_created_at;
--   -- ROLLBACK SONU ──────────────────────────────────────────────────────
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0) Anti-spam destekli index — küçük pencereli count sorguları için
-- ----------------------------------------------------------------------------
-- (room_code, player_name) eşitliği + (created_at) range filtresi → composite
-- B-tree. created_at DESC tercih: yeni mesajlar pencere içinde ardışık ve
-- planner range scan'i hızlandırır.
-- ────────────────────────────────────────────────────────────────────────────

create index if not exists ix_duel_messages_room_player_created_at
  on public.duel_messages (room_code, player_name, created_at desc);


-- ────────────────────────────────────────────────────────────────────────────
-- 1) _duel_messages_antispam_check helper
-- ----------------------------------------------------------------------------
-- Tüm send_message RPC'leri tarafından çağrılır. SECURITY DEFINER ile çalışır
-- (definer = postgres) → RLS / GRANT'tan bağımsız okur.
--
-- Parametre adlandırması ile RPC'lerdeki v_* değişkenleri ile çakışma yok.
--
-- Sıralama (defansif yararı):
--   • duplicate_message en yüksek hassasiyet — önce kontrol edilir.
--   • 3sn pencere — burst flood'a karşı.
--   • 10sn pencere — yavaş ama sürekli flood'a karşı.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public._duel_messages_antispam_check(
  p_room_code   text,
  p_player_name text,
  p_trim        text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- (a) Aynı trimlenmiş mesaj son 5 sn'de var mı? → duplicate_message
  select count(*) into v_count
    from public.duel_messages
   where room_code   = p_room_code
     and player_name = p_player_name
     and message     = p_trim
     and created_at  > now() - interval '5 seconds';
  if v_count >= 1 then
    raise exception 'duplicate_message' using errcode = '42501';
  end if;

  -- (b) Son 3 sn'de mesaj sayısı ≥ 3 ise → rate_limited (burst guard)
  select count(*) into v_count
    from public.duel_messages
   where room_code   = p_room_code
     and player_name = p_player_name
     and created_at  > now() - interval '3 seconds';
  if v_count >= 3 then
    raise exception 'rate_limited' using errcode = '42501';
  end if;

  -- (c) Son 10 sn'de mesaj sayısı ≥ 8 ise → rate_limited (sustained guard)
  select count(*) into v_count
    from public.duel_messages
   where room_code   = p_room_code
     and player_name = p_player_name
     and created_at  > now() - interval '10 seconds';
  if v_count >= 8 then
    raise exception 'rate_limited' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public._duel_messages_antispam_check(text, text, text) from public;
-- anon/authenticated direkt çağıramasın; yalnız diğer SECURITY DEFINER
-- fonksiyonlardan (definer=postgres) çağrılır.


-- ────────────────────────────────────────────────────────────────────────────
-- 2) duel_send_message — anti-spam ile yeniden tanımla
-- ----------------------------------------------------------------------------
-- Mevcut M2 (20260604120000_duel_rls_hardening_m2.sql:1061) gövdesi ile IDENTIC;
-- tek fark room_code_mismatch guard'ından sonra, INSERT'ten önce helper call.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_send_message(
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
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
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

  -- Anti-spam: rate_limited / duplicate_message (M-Chat-C)
  perform public._duel_messages_antispam_check(p_room_code, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) flag_duel_send_message
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

  perform public._duel_messages_antispam_check(p_room_code, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.flag_duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.flag_duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) wheel_duel_send_message
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

  perform public._duel_messages_antispam_check(p_room_code, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.wheel_duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) wheel_group_send_message
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

  perform public._duel_messages_antispam_check(p_room_code, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.wheel_group_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) duel_group_send_message
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

  perform public._duel_messages_antispam_check(p_room_code, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.duel_group_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.duel_group_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) conquest_send_message
-- ----------------------------------------------------------------------------
-- DİKKAT: Conquest'te conquest_rooms.room_code (text) — diğer modlarda code.
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

  perform public._duel_messages_antispam_check(p_room_code, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message)
  values (p_room_code, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.conquest_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.conquest_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ============================================================================
-- DOĞRULAMA SORGULARI (manuel)
-- ----------------------------------------------------------------------------
--
--   -- 6 RPC + helper hepsi SECURITY DEFINER?
--   select proname, prosecdef
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in (
--        'duel_send_message',
--        'flag_duel_send_message',
--        'wheel_duel_send_message',
--        'wheel_group_send_message',
--        'duel_group_send_message',
--        'conquest_send_message',
--        '_duel_messages_antispam_check'
--      )
--    order by proname;
--   -- Beklenen: 7 satır, prosecdef = true.
--
--   -- Index var mı?
--   select indexname
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename  = 'duel_messages'
--      and indexname  = 'ix_duel_messages_room_player_created_at';
--
-- Smoke (manuel — frontend):
--   • Lobby chat'te 3 mesajı hızlıca üst üste at (1sn aralık) → ilk 3 geçer,
--     4. mesaj 3sn pencere içinde → 'rate_limited' hatası.
--   • Aynı mesajı 2 kez gönder (<5sn) → ikincisi 'duplicate_message'.
--   • Normal kullanım (her 1-2 sn'de bir farklı mesaj) → sorunsuz akmalı.
--   • 10sn pencerede 8 farklı mesajı yavaş yav yav at → 9. mesaj 'rate_limited'.
-- ============================================================================
