-- ============================================================================
-- Flag Group (Bayrak Bilmece · Çok Oyunculu) — send_message RPC
-- ============================================================================
-- AMAÇ
--   flag_group_* odalarına oda-izole, güvenli sohbet mesajı yazma yolu.
--   Diğer 6 mod send_message RPC'siyle (M-Chat-A + M-Chat-C anti-spam) aynı
--   iskelet; farklar: authorize helper'ı + player/room tabloları + MOD-İZOLE
--   namespaced room_code anahtarı (aşağıda "MOD İZOLASYONU").
--     • public.flag_group_authorize_player(p_player_id, p_claim_token)
--     • public.flag_group_players (id, room_id, name, …)
--     • public.flag_group_rooms   (id, code, …)
--
--   Chat için paylaşımlı public.duel_messages tablosu reuse edilir. Bu migration
--   YALNIZ yeni bir RPC ekler; duel_messages'in şemasına / RLS / policy / GRANT
--   durumuna DOKUNMAZ (M-Chat-B lockdown korunur). Anti-spam helper
--   (_duel_messages_antispam_check) 20260616120000'da tanımlı; burada çağrılır.
--
-- ── MOD İZOLASYONU (KRİTİK — cross-mode chat sızıntısı önlemi) ──────────────
--   duel_messages TÜM modlarca paylaşılır ve YALNIZ room_code ile ayrılır
--   (mode/room_type ayırıcı kolonu YOK). Oda kodları modlar arası GLOBAL UNIQUE
--   DEĞİL: her <mode>_rooms.code YALNIZ kendi tablosunda unique. Yani
--   flag_group 'ABC123' ile wheel_group 'ABC123' AYNI ANDA var olabilir.
--   Plain 'ABC123' ile anahtarlanırsa bu iki oda birbirinin mesajını görürdü.
--
--   Bu yüzden Bayrak Grup mesajları "flag_group:<code>" mantıksal anahtarıyla
--   saklanır. Anahtar SERVER'da GERÇEK oda kodundan kurulur; client'ın
--   p_room_code'una körü körüne güvenilmez (yalnız eşitlik kapısı için).
--   Hiçbir başka mod ':'-önekli room_code yazmadığından (hepsi plain code yazar)
--   çakışma yapısal olarak imkânsızdır — çift yönlü izolasyon:
--     • flag_group RPC yalnız 'flag_group:'+kendi kodunu yazabilir (mismatch aksi).
--     • diğer modların RPC'si yalnız kendi plain kodunu yazabilir → asla
--       'flag_group:' anahtarına düşemez.
--   Client (LobbyChat) da geçmiş sorgusunu ve Realtime kanalını AYNI anahtarla
--   (roomCode="flag_group:<code>") kurar → okuma + anlık + yazma hepsi izole.
--
-- GÜVENLİK
--   • SECURITY DEFINER + set search_path = public, auth.
--   • flag_group_authorize_player false ise → 'unauthorized' (42501):
--       auth.uid() = profile_id  VEYA  claim_token eşleşmesi (misafir) zorunlu.
--       Atılan/ayrılan oyuncunun flag_group_players satırı silindiğinden hem
--       authorize FAIL eder hem de player_not_found'a düşer → yazamaz.
--   • player_name CLIENT'TAN ALINMAZ → flag_group_players.name server-resolve.
--   • Namespaced anahtar SERVER'da kurulur (v_room_key); client'ın verdiği
--       p_room_code buna eşit değilse → 'room_code_mismatch' (42501). Böylece
--       başka oda / başka mod / plain kod hedefleme spoof'u bloklanır.
--   • Boş/whitespace → 'message_empty'; >200 char → 'message_too_long'.
--   • Anti-spam: burst + sustained rate-limit + duplicate guard (namespaced
--       anahtar üzerinden → pencere doğru odaya izole).
--
-- ŞEMA UYUMU
--   • duel_messages.room_code = text (repodaki tüm <mode>_send_message RPC'leri
--     ve indexleri room_code'u kısıtsız text olarak kullanır; varchar length /
--     CHECK constraint YOK). "flag_group:ABC123" (≈17 char) rahatça sığar.
--   • Anti-spam index (room_code, player_name, created_at) namespaced text
--     değerlerini de kapsar → performans etkisi yok.
--
-- IDEMPOTENT: create or replace function.
-- DEPLOY: 20260728120000_flag_group_init.sql'e DOKUNULMADI. Client (FlagGroupGame
--   roomCode="flag_group:<code>" + LobbyChat sendMode="flag_group") ile BİRLİKTE
--   deploy edilmeli. DEPLOY EDİLMEDİ.
-- ============================================================================

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

  insert into public.duel_messages (room_code, player_name, message)
  values (v_room_key, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;

revoke all     on function public.flag_group_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.flag_group_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ============================================================================
-- DOĞRULAMA (manuel — Studio SQL editor)
-- ----------------------------------------------------------------------------
--   -- RPC SECURITY DEFINER mı?
--   select proname, prosecdef from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'flag_group_send_message';   -- 1 satır, prosecdef=true
--
--   -- İzolasyon: flag_group mesajları namespaced saklanmalı, plain kodla DEĞİL
--   select distinct room_code from public.duel_messages
--    where room_code like 'flag_group:%' limit 5;  -- flag_group anahtarları
--
-- Smoke (frontend):
--   • Flag Group 'ABC123' + Wheel Group 'ABC123' AYNI ANDA aç → Flag'ta atılan
--     mesaj Wheel'de GÖRÜNMEZ; Wheel mesajı Flag'ta GÖRÜNMEZ (geçmiş + anlık).
--   • DB: flag mesajı room_code='flag_group:ABC123', wheel mesajı 'ABC123'.
--   • DevTools spoof: supabase.rpc('flag_group_send_message',
--       { p_room_code:'ABC123', ... }) → 'room_code_mismatch' (plain kod reddedilir).
--       { p_room_code:'flag_group:XYZ', ... }  (başka oda) → 'room_code_mismatch'.
--   • Yanlış claim_token → 'unauthorized'. Atılan oyuncu → player_not_found/unauthorized.
--   • 201 char → 'message_too_long'; whitespace → 'message_empty';
--     aynı mesaj <5sn → 'duplicate_message'.
-- ============================================================================
