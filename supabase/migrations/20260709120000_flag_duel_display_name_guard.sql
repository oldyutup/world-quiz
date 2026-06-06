-- ============================================================================
-- Flag Duel (Bayrak Düellosu 1v1) — Display Name Registry Guard
-- ============================================================================
-- Bu migration yalnızca tek RPC'yi CREATE OR REPLACE ile yeniden tanımlar:
--
--   1) public.flag_duel_create_room
--
-- Tek davranış değişikliği:
--   p_name doğrudan btrim(p_name) ile duel_players.name'e yazılmıyor; önce
--     public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id)
--   helper'ından geçiyor. Helper:
--     • Boş / çok kısa / çok uzun (<2 veya >16) → 'name_invalid'                (22023)
--     • Yasaklı / rezerv / küfürlü kelime listesinde → 'display_name_forbidden' (P0001)
--     • Kayıtlı bir profile.username taklit ediyorsa
--       → 'registered_username_taken'                                          (P0001)
--     • Aksi halde temizlenmiş adı döner; players satırına bu yazılır.
--
-- BAYRAK JOIN AKIŞI:
--   FlagDuelGame.tsx joinRoom (L1823) Country Duel ile aynı public.duel_join_room
--   RPC'sini kullanıyor (Duel 1v1 M2 reuse). duel_join_room PR-5
--   (20260708120000_duel_display_name_guard.sql) ile zaten helper'a bağlandı —
--   bu migration join tarafına dokunmuyor. Ayrı bir flag_duel_join_room RPC'si
--   tanımlı değil.
--
-- DOKUNULMAYAN davranışlar (mevcut sözleşme aynen korunur):
--   • profile_mismatch (auth.uid() ≠ p_profile_id)                             → 42501
--   • guest_id_required, claim_token_required, player_id_required,
--     code_required, region_required, total_rounds_invalid                    → 22023
--   • code_taken (race)                                                       → P0001
--   • room_source='manual', host_player_id=p_player_id, duration_seconds=60,
--     total_rounds=p_total_rounds, current_round=0, is_golden_round=false,
--     current_flag=null                                                       → korundu
--   • RPC imzaları, GRANT/REVOKE, SECURITY DEFINER, search_path               → değişmedi
--   • Diğer flag_duel_* RPC'leri (update_settings, start_game, submit_claim,
--     set_next_round, finalize_game, accept_rematch, leave_room) bu PR'da
--     PATCHLENMEZ — yalnızca create_room'a dokunuluyor.
--   • flag_duel_quick_match / flag_duel_cancel_quick_match /
--     flag_duel_reset_quick_match (quick match akışı) — DOKUNULMAZ.
--
-- KAPSAM:
--   • Yalnızca Flag Duel / Bayrak Düellosu 1v1 manuel oda kurma.
--   • Bayrak manuel join helper'ı zaten PR-5 üzerinden duel_join_room ile
--     korunuyor.
--   • DOKUNULMAYAN modlar: Country Duel (PR-5), DuelGroup, WheelGroup,
--     WheelDuel (her biri kendi PR'ında helper'ı çağırıyor), Conquest /
--     Kuşatma ve tüm quick-match RPC'leri.
--
-- BAĞIMLILIK:
--   • 20260704120000_display_name_registry_guard_helper.sql
--   • 20260705130000_display_name_forbidden_words.sql
--     (public.assert_display_name_allowed kayıtlı ve forbidden-words listesi
--     etkin olmalı.)
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) flag_duel_create_room  — helper entegrasyonu
-- ----------------------------------------------------------------------------
-- Body'de tek anlamlı değişiklik:
--   • Eski "name_invalid (<2)" inline check'i çıkarıldı; helper içeride
--     hem boş/kısa hem uzun (>16) hem display_name_forbidden hem
--     registered_username_taken senaryolarını tek seferde işliyor.
--   • players.name'e yazılan değer artık helper'ın döndürdüğü v_display_name.
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
  v_room         public.duel_rooms;
  v_uid          uuid := auth.uid();
  v_display_name text;
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

  -- ── Display name: helper ile validate + registry guard. ──
  -- Helper hata fırlatırsa ('name_invalid' / 'display_name_forbidden' /
  -- 'registered_username_taken') aynen yukarıya yayılır; client
  -- describeFlagDuelRpcError ile yakalar.
  v_display_name := public.assert_display_name_allowed(
    p_name, p_profile_id, p_guest_id
  );

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

  -- 2) Host player satırı.
  --    Eski: btrim(p_name).  Yeni: v_display_name (helper temizledi).
  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, v_display_name, 0, p_profile_id, p_guest_id, now()
  );

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_create_room(uuid, uuid, text, text, text, text, int, uuid) from public;
grant  execute on function public.flag_duel_create_room(uuid, uuid, text, text, text, text, int, uuid) to anon, authenticated;


-- ============================================================================
-- Doğrulama (Studio SQL editor)
-- ============================================================================
--   -- İmza aynı mı?
--   select proname, pg_get_function_arguments(oid)
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'flag_duel_create_room';
--
--   -- Helper referansı body içinde geçiyor mu?
--   select proname
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'flag_duel_create_room'
--      and pg_get_functiondef(oid) ilike '%assert_display_name_allowed%';
--   -- Beklenen: 1 satır.
--
-- Smoke:
--   1) Misafir + kayıtlı bir nick ile flag_duel_create_room
--      → SQLSTATE P0001, message LIKE '%registered_username_taken%'
--   2) Misafir + 'admin' / 'torble' / 'official' / 'guest' / küfür
--      → SQLSTATE P0001, message LIKE '%display_name_forbidden%'
--   3) Misafir + serbest nick                                   → başarı
--   4) Authenticated + kendi nick'i                             → başarı
--   5) Authenticated + başkasının kayıtlı nick'i                → registered_username_taken
--   6) duel_join_room (Bayrak join akışı, PR-5'te zaten korundu) ile aynı 5
--      senaryo                                                  → korunuyor
--   7) İki misafir aynı serbest nick (create + join) → 2. çağrıda 'name_taken'
--      (oda içi case-insensitive check duel_join_room içinde aynen kaldı)
-- ============================================================================
