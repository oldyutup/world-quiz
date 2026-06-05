-- ============================================================================
-- Wheel Group — Pas Geç (çoğunluk oylaması)
-- ============================================================================
-- Bu migration mevcut tablolara/policy'lere DOKUNMAZ. Yalnızca:
--   • public.wheel_group_pass_votes              (yeni tablo)
--   • public.wheel_group_vote_pass(...)          (yeni RPC)
--   • public.wheel_group_start_game(...)         (RE-CREATE; tek değişiklik:
--                                                 yeni maça başlarken oda için
--                                                 birikmiş pas oylarını siler)
--
-- Bütün CREATE'ler idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) wheel_group_pass_votes tablosu
-- ----------------------------------------------------------------------------
-- Bir (room_id, target_topoid, player_id) tuple'ı tekildir → aynı oyuncu
-- aynı hedef için en fazla bir kez oy verir (idempotency).
--
-- FK on delete cascade:
--   • room_id   → oda silinince oyları temizler
--   • player_id → oyuncu odadan ayrılınca (wheel_group_leave_room player row'u
--                 siler) ilgili oyları otomatik düşürür → "ayrılan oyuncunun
--                 oyu eşiği aşağı çekmeye devam etmesin" davranışı kendiliğinden
--                 doğru. (Yeni eşik = ceil(0.6 * kalan oyuncu).)
--
-- Eski hedeflere ait oylar tabloda kalır; sorgular her zaman
-- (room_id, current_target_topoid) ile filtrelendiği için bayat oylar
-- inerttir. wheel_group_start_game tekrar başlatmada hepsini siler
-- (used_target_topoids reset edildiğinden aynı topoid yeni maçta yeniden
-- gelebilir; bayat oy kalırsa eşik hatalı tetiklenir).
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.wheel_group_pass_votes (
  id             uuid        primary key default gen_random_uuid(),
  room_id        uuid        not null
                             references public.wheel_group_rooms(id)   on delete cascade,
  target_topoid  text        not null,
  player_id      uuid        not null
                             references public.wheel_group_players(id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (room_id, target_topoid, player_id)
);

create index if not exists wheel_group_pass_votes_room_target_idx
  on public.wheel_group_pass_votes (room_id, target_topoid);

alter table public.wheel_group_pass_votes replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) RLS — SELECT anon-açık, yazma kanalları KAPALI
-- ----------------------------------------------------------------------------
-- Diğer wheel_group_* tablolarından sapma: votes gameplay-kritik
-- (eşik oylaması), bu yüzden anon/authenticated DOĞRUDAN yazma KAPALI.
-- Tek yazma yolu SECURITY DEFINER public.wheel_group_vote_pass RPC'sidir.
-- start_game'in DELETE'i ve FK on-delete-cascade temizliği de aynı yol
-- üzerinden (function owner = tablo owner) RLS'i bypass eder; tablo
-- üzerinde FORCE ROW LEVEL SECURITY aktif değil.
--
-- SELECT açık kalır: client realtime + initial fetch için gerekli.
--
-- Saldırı modelini kapatır:
--   • Kötü niyetli anon client doğrudan INSERT atıp başka oyuncu adına
--     pas oyu yazamaz → eşiği erken doldurup pas tetikleyemez.
--   • DELETE/UPDATE de kapalı → oy silme / yeniden yazma imkânsız.
--
-- Eski (anon-açık) policy adları DROP IF EXISTS ile düşürülür ki migration
-- tekrar çalıştırıldığında veya zaten anon-açık halinden geçilse de
-- kalıntı policy kalmasın.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.wheel_group_pass_votes enable row level security;

-- Eski adlar (varsa düşür)
drop policy if exists "wheel_group_pass_votes_select_all"   on public.wheel_group_pass_votes;
drop policy if exists "wheel_group_pass_votes_insert_anon"  on public.wheel_group_pass_votes;
drop policy if exists "wheel_group_pass_votes_delete_anon"  on public.wheel_group_pass_votes;
-- Bu migration'ın kendi adlandırması (yeniden çalışma için)
drop policy if exists "wheel_group_pass_votes_insert_block" on public.wheel_group_pass_votes;
drop policy if exists "wheel_group_pass_votes_update_block" on public.wheel_group_pass_votes;
drop policy if exists "wheel_group_pass_votes_delete_block" on public.wheel_group_pass_votes;

-- SELECT: anon + authenticated için açık (realtime + initial fetch).
create policy "wheel_group_pass_votes_select_all"
  on public.wheel_group_pass_votes
  for select
  to anon, authenticated
  using (true);

-- INSERT: anon + authenticated için KAPALI. WITH CHECK (false) hiçbir satırı
-- onaylamaz; tek yazma yolu wheel_group_vote_pass RPC (SECURITY DEFINER,
-- function owner = tablo owner → RLS bypass).
create policy "wheel_group_pass_votes_insert_block"
  on public.wheel_group_pass_votes
  for insert
  to anon, authenticated
  with check (false);

-- UPDATE: KAPALI. RPC sadece INSERT yapar; UPDATE iş akışı yok.
create policy "wheel_group_pass_votes_update_block"
  on public.wheel_group_pass_votes
  for update
  to anon, authenticated
  using (false)
  with check (false);

-- DELETE: KAPALI. Temizlik yolları:
--   • start_game RPC (SECURITY DEFINER) → maç başında bayat oyları siler
--   • FK ON DELETE CASCADE (room/player satırı düşünce) → owner-cascade
--     RLS'i bypass eder
create policy "wheel_group_pass_votes_delete_block"
  on public.wheel_group_pass_votes
  for delete
  to anon, authenticated
  using (false);


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Realtime publication
-- ----------------------------------------------------------------------------
-- Diğer client'lar X/Y göstergesini canlı görsün diye INSERT event'leri
-- supabase_realtime üzerinden yayılır. add table idempotent değil → guard.
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'wheel_group_pass_votes'
  ) then
    execute 'alter publication supabase_realtime add table public.wheel_group_pass_votes';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) wheel_group_vote_pass RPC
-- ----------------------------------------------------------------------------
-- Davranış:
--   1) Oyuncu yetkisi + claim_token doğrulanır (player_room_mismatch guard).
--   2) Oda lock'lanır; status='playing' ve current_target_topoid=p_target
--      değilse "voted=false" döner (bayat hedef → no-op).
--   3) Oy atomik insert (unique conflict → no-op, idempotent).
--   4) Aktif oyuncu sayısı sayılır → required = greatest(2, ceil(0.6 * N)).
--      Alt sınır 2 defansif (1 kişiyle oyun zaten finishGame("alone") ile
--      bitiyor, fakat double-guard).
--   5) Oy sayısı >= required ise atomik skip:
--        used_target_topoids += current_target
--        current_target_topoid = null
--      → host'un mevcut pickNextTarget effect'i yeni hedefi seçer
--      (server'da ülke verisi olmadığı için ülke seçimi client-side kalır).
--   6) Eski hedeflere ait oylar tabloda kalır ama
--      WHERE target_topoid = current_target_topoid filtreleri sayesinde
--      yeni hedefte "fiilen sıfır" olur — bu, ayrı bir delete adımı
--      gerektirmez (Lobiye Dön + tekrar başlat senaryosu için
--      wheel_group_start_game'de delete eklendi).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_vote_pass(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_target      text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.wheel_group_rooms;
  v_active     int;
  v_required   int;
  v_vote_count int;
  v_skipped    boolean := false;
begin
  if not public.wheel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target is null or length(btrim(p_target)) = 0 then
    raise exception 'target_required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.wheel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Oda lock — status/target guard ile yarış kapatma
  select * into v_room from public.wheel_group_rooms
   where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Defansif aktif sayım (eşik döneceğimiz JSON'a girer)
  select count(*) into v_active
    from public.wheel_group_players where room_id = p_room_id;
  v_required := greatest(2, ceil(v_active * 0.6)::int);

  if v_room.status <> 'playing'
     or v_room.current_target_topoid is null
     or v_room.current_target_topoid <> p_target then
    -- Bayat istek: ne yaz ne skip et. Mevcut hedef varsa onun oyunu döndür,
    -- yoksa 0 döndür → client UI bayat çağrıyı sessizce yutar.
    select count(*) into v_vote_count
      from public.wheel_group_pass_votes
     where room_id       = p_room_id
       and target_topoid = coalesce(v_room.current_target_topoid, '');
    return jsonb_build_object(
      'voted',      false,
      'vote_count', v_vote_count,
      'required',   v_required,
      'skipped',    false
    );
  end if;

  -- Idempotent insert: aynı oyuncu ikinci kez oy verirse no-op.
  insert into public.wheel_group_pass_votes (room_id, target_topoid, player_id)
  values (p_room_id, p_target, p_player_id)
  on conflict (room_id, target_topoid, player_id) do nothing;

  select count(*) into v_vote_count
    from public.wheel_group_pass_votes
   where room_id       = p_room_id
     and target_topoid = p_target;

  -- Eşik dolduysa atomik skip. current_target_topoid guard'ı sayesinde
  -- aynı çağrıda iki kez tetiklenemez (ilk başarıdan sonra null'a düşer).
  if v_vote_count >= v_required then
    update public.wheel_group_rooms
       set used_target_topoids   = array_append(
                                     coalesce(used_target_topoids, '{}'::text[]),
                                     p_target
                                   ),
           current_target_topoid = null
     where id     = p_room_id
       and status = 'playing'
       and current_target_topoid = p_target;
    if found then
      v_skipped := true;
    end if;
  end if;

  return jsonb_build_object(
    'voted',      true,
    'vote_count', v_vote_count,
    'required',   v_required,
    'skipped',    v_skipped
  );
end;
$$;

revoke all     on function public.wheel_group_vote_pass(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_vote_pass(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) wheel_group_start_game — PATCH
-- ----------------------------------------------------------------------------
-- Tek davranış değişikliği: yeni maça başlarken oda için birikmiş
-- pas oylarını siler. used_target_topoids='{}' ile aynı topoid yeniden
-- gelebildiği için bayat oy kalırsa eşik hatalı tetiklenirdi.
--
-- Geri kalan her satır 20260601120000_wheel_group_rls_hardening_m2.sql'deki
-- fonksiyonla AYNIDIR (host yetki, MIN_PLAYERS=3, match_seq rotation,
-- skor reset, status guard). Karşılaştırma: tek fark "1.5" numaralı
-- DELETE adımı.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_first_target   text
) returns public.wheel_group_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room           public.wheel_group_rooms;
  v_count          int;
  v_new_match_seq  int;
  v_new_match_id   uuid;
begin
  if not public.wheel_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_first_target is null or length(btrim(p_first_target)) = 0 then
    raise exception 'first_target_required' using errcode = '22023';
  end if;

  select * into v_room from public.wheel_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status not in ('waiting', 'finished') then
    raise exception 'room_not_startable' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from public.wheel_group_players where room_id = p_room_id;
  if v_count < 3 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;

  if v_room.status = 'finished' then
    v_new_match_seq := coalesce(v_room.match_seq, 1) + 1;
    v_new_match_id  := gen_random_uuid();
  else
    v_new_match_seq := coalesce(v_room.match_seq, 1);
    v_new_match_id  := v_room.current_match_id;
  end if;

  -- 1) Skor reset
  update public.wheel_group_players
     set score = 0
   where room_id = p_room_id;

  -- 1.5) PAS OYLARI RESET (yeni)
  -- used_target_topoids='{}' ile aynı topoid yeni maçta yeniden gelebilir;
  -- önceki maçtan kalan oylar eşiği hatalı tetiklemesin.
  delete from public.wheel_group_pass_votes
   where room_id = p_room_id;

  -- 2) Oda satırını güncelle
  update public.wheel_group_rooms
     set status                = 'playing',
         started_at            = now(),
         finished_at           = null,
         finished_reason       = null,
         current_target_topoid = p_first_target,
         used_target_topoids   = '{}',
         match_seq             = v_new_match_seq,
         current_match_id      = v_new_match_id
   where id = p_room_id
     and status in ('waiting', 'finished')
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.wheel_group_start_game(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_group_start_game(uuid, uuid, uuid, text) to anon, authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama:
--   select table_name from information_schema.tables
--    where table_schema='public' and table_name='wheel_group_pass_votes';
--
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='wheel_group_pass_votes';
--
--   select proname from pg_proc
--    where proname in ('wheel_group_vote_pass','wheel_group_start_game');
-- ============================================================================
