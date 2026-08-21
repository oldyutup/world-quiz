-- ============================================================================
-- Kör Nokta — tur sayısı seçenekleri: 3 EKLENİYOR (geriye dönük uyumlu)
-- ============================================================================
-- ÜRÜN KARARI
-- ───────────
-- Yeni istemcide seçilebilir tur sayıları 3 / 5 / 10 olur; 15 ve 20 SEÇİCİDEN
-- kaldırılır. Sunucu tarafında ise HİÇBİR değer yasaklanmaz.
--
-- NEDEN 15/20 SUNUCUDA KALIYOR
-- ────────────────────────────
-- App Store / TestFlight'taki ESKİ istemciler hâlâ 15 ve 20 gönderiyor. Bu
-- değerleri şimdi reddetmek, güncellemeyi almamış oyuncuların oda kurmasını
-- ANINDA kırardı — üstelik sunucu hatasıyla, yani onlar için açıklanamaz bir
-- şekilde. Bu migration izin verilen kümeyi DARALTMAZ, yalnız GENİŞLETİR:
--
--     (5, 7, 10, 15, 20)  →  (3, 5, 7, 10, 15, 20)
--
-- Yani değişiklik tam anlamıyla toplamsaldır: bugün çalışan her istek yarın da
-- çalışır, üstüne 3 kabul edilir hâle gelir. Eski odaların 15/20 değerleri
-- okunmaya devam eder; VERİ MİGRASYONU YOKTUR.
--
-- ÜÇ ENGEL VARDI (hepsi burada kalkıyor)
-- ──────────────────────────────────────
--   1. tevatur_rooms_round_count_check  (20260712120000) → 3 CHECK'i geçemezdi
--   2. tevatur_create_room  gövdesi     (20260714120000) → round_count_invalid
--   3. tevatur_update_settings gövdesi  (20260712120000) → round_count_invalid
--
-- Gameplay'de 3 tur için AYRICA bir engel YOKTUR (denetlendi):
--   • tamamlanma koşulu `v_idx + 1 >= (game_state->>'roundCount')::int` —
--     hem advance_phase (20260723120000) hem advance_if_due (20260813120000)
--     tamamen jeneriktir, sabit 5/10 varsayımı yoktur.
--   • start_game `jsonb_array_length(p_scenes) = round_count` ister; istemci
--     planı buildKnScenePlan(roundCount) ile üretir → 3 sahne gönderir.
--   • sahne havuzu 3 turu fazlasıyla karşılar (tekrar koruması korunur).
--
-- GRANT'LARA DOKUNULMUYOR — BİLEREK
-- ─────────────────────────────────
-- Bu migration hiçbir GRANT/REVOKE İÇERMEZ. `create or replace function`
-- mevcut ACL'i KORUR; oysa iki fonksiyonun ACL'i ilk tanımlarından bu yana
-- DEĞİŞTİ:
--   • tevatur_create_room     → 20260815130000 anon + public'ten revoke etti
--                               (oda kurma login-only).
--   • tevatur_update_settings → 20260809120000 anon'a execute verdi.
-- Orijinal migration'lardaki grant satırlarını burada tekrarlamak bu iki
-- kararı da GERİ ALIRDI. Gövde değişir, yetki modeli olduğu gibi kalır.
--
-- ŞEMA: yalnız tek bir CHECK constraint genişletilir. Tablo/kolon/RLS/policy/
-- trigger/index eklenmez, kaldırılmaz.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) CHECK constraint — 3 eklenir, mevcut değerlerin hiçbiri düşmez
-- ────────────────────────────────────────────────────────────────────────────
alter table public.tevatur_rooms
  drop constraint if exists tevatur_rooms_round_count_check;

alter table public.tevatur_rooms
  add constraint tevatur_rooms_round_count_check
  check (round_count in (3, 5, 7, 10, 15, 20));


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_create_room — gövde 20260714120000 ile BİREBİR AYNI;
--    tek fark izin verilen tur sayısı listesi. (Grant satırı YOK: bkz. başlık.)
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
  if p_round_count is null or p_round_count not in (3, 5, 7, 10, 15, 20) then
    raise exception 'round_count_invalid' using errcode = '22023';
  end if;
  if p_photo_seconds is null or p_photo_seconds not in (5, 10, 15) then
    raise exception 'photo_seconds_invalid' using errcode = '22023';
  end if;

  -- 1) Oda satırı (UNIQUE(code) çakışırsa kullanıcı dostu hata).
  --    Kör Nokta takım modu: max_players = 10.
  begin
    insert into public.tevatur_rooms (
      code, status, round_count, photo_seconds, max_players, host_player_id
    ) values (
      btrim(p_code), 'waiting', p_round_count, p_photo_seconds, 10, p_player_id
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Host player satırı (host varsayılan Mavi takım)
  insert into public.tevatur_players (id, room_id, profile_id, name, score, team)
  values (p_player_id, v_room.id, v_uid, btrim(v_username), 0, 'blue');

  -- 3) Claim token (private depo, realtime DIŞI)
  insert into public.tevatur_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) tevatur_update_settings — gövde 20260712120000 ile BİREBİR AYNI;
--    tek fark izin verilen tur sayısı listesi. (Grant satırı YOK.)
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

  if p_round_count is not null and p_round_count not in (3, 5, 7, 10, 15, 20) then
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

-- ============================================================================
-- DOĞRULAMA (Supabase Studio → SQL Editor)
-- ============================================================================
--
-- A) CHECK constraint genişledi mi:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.tevatur_rooms'::regclass
--      and conname = 'tevatur_rooms_round_count_check';
--   -- Beklenen: CHECK (round_count = ANY (ARRAY[3, 5, 7, 10, 15, 20]))
--
-- B) ACL DEĞİŞMEDİ mi (create_room login-only, update_settings anon dâhil):
--   select p.proname,
--          has_function_privilege('anon',          p.oid, 'execute') as anon,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('tevatur_create_room','tevatur_update_settings');
--   -- Beklenen: create_room → f / t     update_settings → t / t
--
-- C) Eski 15/20 odalar hâlâ okunabiliyor:
--   select round_count, count(*) from public.tevatur_rooms group by 1 order by 1;
-- ============================================================================
