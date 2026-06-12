-- ============================================================================
-- Kör Nokta — lobi ayar güncellemesi (eski Tevatür iskeleti üzerine)
-- ============================================================================
-- Tevatür kartı kullanıcı arayüzünde "Kör Nokta" oldu. DB nesneleri yeniden
-- adlandırılmaz (en düşük riskli yol): tevatur_* tabloları ve RPC'leri aynen
-- kullanılmaya devam eder. Bu migration yalnızca lobi kurallarını günceller:
--
--   • Tur Sayısı seçenekleri: 5/10/15/20  →  5/7/10/15/20 (varsayılan 7)
--   • Oda kapasitesi: yeni odalar max 5 oyuncu (Kör Nokta 3–5 kişilik)
--
-- Dokunulmayanlar:
--   • photo_seconds kolonu ve check'i (UI'dan kaldırıldı, legacy olarak
--     kolonda duruyor; create RPC'sine sabit 10 gönderilir)
--   • max_players tablo check'i (3–10 aralığı kalır — eski 10 kişilik test
--     odaları constraint'i ihlal etmesin; yeni odalar RPC'de 5 ile açılır)
--   • RLS, realtime publication, diğer RPC'ler
--
-- İdempotent: constraint drop+add, create or replace function.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) round_count: 7 seçeneği + varsayılan 7
-- ────────────────────────────────────────────────────────────────────────────

alter table public.tevatur_rooms
  drop constraint if exists tevatur_rooms_round_count_check;

alter table public.tevatur_rooms
  add constraint tevatur_rooms_round_count_check
  check (round_count in (5, 7, 10, 15, 20));

alter table public.tevatur_rooms
  alter column round_count set default 7;

alter table public.tevatur_rooms
  alter column max_players set default 5;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_create_room — round 7 kabul + yeni odalar max_players=5
--    (gövde 20260711120000_tevatur_init.sql ile aynı; yalnız iki satır değişti)
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
  if p_round_count is null or p_round_count not in (5, 7, 10, 15, 20) then
    raise exception 'round_count_invalid' using errcode = '22023';
  end if;
  if p_photo_seconds is null or p_photo_seconds not in (5, 10, 15) then
    raise exception 'photo_seconds_invalid' using errcode = '22023';
  end if;

  -- 1) Oda satırı (UNIQUE(code) çakışırsa kullanıcı dostu hata).
  --    Kör Nokta: max_players = 5.
  begin
    insert into public.tevatur_rooms (
      code, status, round_count, photo_seconds, max_players, host_player_id
    ) values (
      btrim(p_code), 'waiting', p_round_count, p_photo_seconds, 5, p_player_id
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
-- 3) tevatur_update_settings — round 7 kabul
--    (gövde 20260711120000_tevatur_init.sql ile aynı; yalnız validasyon değişti)
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

  if p_round_count is not null and p_round_count not in (5, 7, 10, 15, 20) then
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


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama:
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.tevatur_rooms'::regclass
--      and conname = 'tevatur_rooms_round_count_check';
--   -- Beklenen: round_count in (5, 7, 10, 15, 20)
--
--   select column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'tevatur_rooms'
--      and column_name in ('round_count', 'max_players');
--   -- Beklenen: 7 ve 5
-- ============================================================================
