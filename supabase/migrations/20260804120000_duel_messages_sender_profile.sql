-- ============================================================================
-- duel_messages — nullable sender_profile_id (ileriye dönük mesaj kimliği)
-- ============================================================================
-- AMAÇ
--   duel_messages bugüne kadar kullanıcıya YALNIZ (room_code, player_name)
--   metniyle bağlıydı. Hesap silme (20260805120000) oda-kapsamlı isim
--   eşleşmesiyle anonimleştirme yapabiliyor; ancak odası silinmiş (cleanup
--   trigger'ları) YETİM mesajlara güvenli atıf imkânsız. Bu migration yeni
--   mesajlara değişmez bir gönderen kimliği ekler:
--
--     • duel_messages.sender_profile_id uuid NULL — FK YOK (bilinçli):
--       profiles satırı silinirken hesap-silme trigger'ı bu kolonu AYNI
--       transaction içinde okuyup anonimleştirir; FK ON DELETE SET NULL
--       teknik olarak AFTER-RI sırasında çalıştığı için sorun çıkarmazdı,
--       ama FK'sız tutmak sıralama varsayımını tamamen ortadan kaldırır ve
--       duel_* çekirdek tablolarının mevcut FK'sız deseniyle tutarlıdır.
--     • Değer 9 send-message RPC'sinin TAMAMINDA sunucu tarafında yetkili
--       player satırından (v_player.profile_id) çözülür; misafirde NULL.
--       İstemciden sender_profile_id ASLA kabul edilmez (RPC imzaları
--       değişmedi; tablo INSERT grant'ları zaten 20260615'te revoke edildi).
--     • Eski mesajlar BACKFILL EDİLMEZ — güvenilir kanıt yok (isim metni
--       yeterli kanıt değildir).
--
-- DOKUNULMAYANLAR
--   • RPC imzaları, guard'ları, hata sözleşmeleri, antispam çağrıları,
--     GRANT/REVOKE durumları — birebir korunur (gövdeler 20260616 /
--     20260714 / 20260729 / 20260802 son sürümlerinden kopyalandı; tek fark
--     INSERT kolon listesine sender_profile_id eklenmesi).
--   • duel_messages RLS/policy/publication durumu.
--   • Frontend: returning * fazladan kolonu sorunsuz taşır; hiçbir client
--     değişikliği gerekmez.
--
-- IDEMPOTENT: add column if not exists + create or replace + create index
-- if not exists. Tekrar koşulabilir.
-- ============================================================================

alter table public.duel_messages
  add column if not exists sender_profile_id uuid null;

comment on column public.duel_messages.sender_profile_id is
  'Gönderen profiles.id — YALNIZ send-message RPC''leri server tarafında '
  'doldurur (misafirde NULL). FK yok; hesap silme trigger''ı '
  '(trg_account_deletion_cleanup) bu kolon üzerinden anonimleştirir.';

-- Hesap silme süpürmesinin tarama yolu (yalnız dolu satırlar):
create index if not exists duel_messages_sender_profile_idx
  on public.duel_messages (sender_profile_id)
  where sender_profile_id is not null;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_send_message (Ülke Yazmaca 1v1)
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

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (p_room_code, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) flag_duel_send_message (Bayrak 1v1 — duel_* tablolarını paylaşır)
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

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (p_room_code, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.flag_duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.flag_duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) wheel_duel_send_message
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

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (p_room_code, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.wheel_duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) wheel_group_send_message
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

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (p_room_code, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.wheel_group_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) duel_group_send_message
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

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (p_room_code, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.duel_group_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.duel_group_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) conquest_send_message
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

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (p_room_code, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.conquest_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.conquest_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) tevatur_send_message (Kör Nokta — login-only; "<code>#takım" kanalı var)
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

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (p_room_code, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.tevatur_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.tevatur_send_message(text, uuid, uuid, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) flag_group_send_message ('flag_group:<code>' namespaced anahtar)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_send_message(
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
  v_player    public.flag_group_players;
  v_real_code text;
  v_room_key  text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
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

  select * into v_player from public.flag_group_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  -- GERÇEK oda kodunu üyelikten çöz (client'ın string'ine güvenme).
  select code into v_real_code
    from public.flag_group_rooms
   where id = v_player.room_id;

  if v_real_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- MOD-İZOLE namespaced anahtar SERVER'da kurulur; p_room_code buna eşit
  -- değilse spoof/yanlış-kombinasyon → reddet.
  v_room_key := 'flag_group:' || v_real_code;
  if p_room_code <> v_room_key then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  -- Anti-spam: rate_limited / duplicate_message (M-Chat-C helper reuse),
  -- namespaced anahtar üzerinden.
  perform public._duel_messages_antispam_check(v_room_key, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (v_room_key, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.flag_group_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.flag_group_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) route_duel_send_message ('route_duel:<code>' namespaced anahtar)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_send_message(
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
  v_player    public.route_duel_players;
  v_real_code text;
  v_room_key  text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
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

  select * into v_player from public.route_duel_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select code into v_real_code
    from public.route_duel_rooms
   where id = v_player.room_id;

  if v_real_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  v_room_key := 'route_duel:' || v_real_code;
  if p_room_code <> v_room_key then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  perform public._duel_messages_antispam_check(v_room_key, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message, sender_profile_id)
  values (v_room_key, v_player.name, v_trim, v_player.profile_id)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.route_duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.route_duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ============================================================================
-- DOĞRULAMA (manuel — Studio SQL editor)
-- ----------------------------------------------------------------------------
--   select column_name, is_nullable from information_schema.columns
--    where table_schema='public' and table_name='duel_messages'
--      and column_name='sender_profile_id';          -- 1 satır, YES
--
--   -- Yeni mesajlar dolduruyor mu (bir chat mesajı attıktan sonra):
--   select room_code, player_name, sender_profile_id
--     from public.duel_messages order by created_at desc limit 5;
-- ============================================================================
