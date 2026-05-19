-- ============================================================================
-- Wheel Group — Çark Çok Oyunculu (3–10 kişi) için izole tablo seti
-- ============================================================================
-- Bu migration mevcut tablolara DOKUNMAZ:
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_rooms / duel_group_players / duel_group_claims
--   • wheel_duel_rooms / wheel_duel_players (Online 1v1 Çark)
--   • flag_duel_queue / wheel_duel_queue
--   • xp_events, profiles
--
-- Yalnızca aşağıdaki YENİ nesneleri oluşturur:
--   • public.wheel_group_rooms     (oda kayıtları)
--   • public.wheel_group_players   (her odanın oyuncuları)
--   • public.wheel_group_set_updated_at()  (trigger fonksiyonu)
--   • wheel_group_rooms_set_updated_at     (BEFORE UPDATE trigger)
--   • RLS politikaları (guest-friendly, mevcut duel pattern'iyle aynı)
--   • supabase_realtime publication'a ekleme
--
-- Tüm CREATE'ler "IF NOT EXISTS" / "OR REPLACE" / idempotent guard ile
-- yazılmıştır → migration tekrar çalıştırılırsa hata vermez.
--
-- Çakışma stratejisi:
--   • room code "M" ile başlatılır (Multi-Wheel). duel_messages.room_code
--     üzerinden chat reuse edildiği için country/flag/wheel-duel/duel-group
--     kodlarıyla karışmaması adına. M-prefix kuralı app-side; DB'de
--     wheel_group_rooms.code UNIQUE.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Tablolar
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.wheel_group_rooms (
  id                     uuid        primary key default gen_random_uuid(),
  code                   text        not null unique,
  status                 text        not null default 'waiting'
                                     check (status in ('waiting','playing','finished')),
  duration_seconds       int         not null default 60
                                     check (duration_seconds > 0),
  region                 text        not null default 'world',
  penalty_enabled        boolean     not null default false,
  max_players            int         not null default 10
                                     check (max_players between 3 and 10),
  host_player_id         uuid        null,
  started_at             timestamptz null,
  finished_at            timestamptz null,
  finished_reason        text        null,
  current_target_topoid  text        null,
  used_target_topoids    text[]      not null default '{}',
  /** match_seq + current_match_id: XP idempotency için.
   *  Aynı oda satırında "Lobiye Dön + tekrar başlat" senaryosunda her yeni maç
   *  benzersiz UUID alır → xp_events UNIQUE(profile_id, mode_key, room_id)
   *  ihlal edilmez. Host her startGame öncesi yeni UUID üretir, realtime UPDATE
   *  ile tüm client'lara yayar. */
  match_seq              int         not null default 1,
  current_match_id       uuid        not null default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists wheel_group_rooms_status_idx
  on public.wheel_group_rooms (status);

create index if not exists wheel_group_rooms_created_at_idx
  on public.wheel_group_rooms (created_at desc);

-- Realtime UPDATE event'leri tam satırı taşısın.
alter table public.wheel_group_rooms replica identity full;


create table if not exists public.wheel_group_players (
  id            uuid        primary key default gen_random_uuid(),
  room_id       uuid        not null
                              references public.wheel_group_rooms(id) on delete cascade,
  name          text        not null,
  score         int         not null default 0 check (score >= 0),
  joined_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists wheel_group_players_room_id_idx
  on public.wheel_group_players (room_id);

create index if not exists wheel_group_players_joined_at_idx
  on public.wheel_group_players (room_id, joined_at);

alter table public.wheel_group_players replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) updated_at trigger (yalnız wheel_group_rooms)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists wheel_group_rooms_set_updated_at
  on public.wheel_group_rooms;

create trigger wheel_group_rooms_set_updated_at
  before update on public.wheel_group_rooms
  for each row
  execute function public.wheel_group_set_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Row Level Security
-- ----------------------------------------------------------------------------
-- Mevcut country/flag/wheel duel pattern'iyle aynı yaklaşım: misafir oyuncu
-- desteklendiği için anon istemcilere geniş izin verilir.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.wheel_group_rooms   enable row level security;
alter table public.wheel_group_players enable row level security;

-- ── wheel_group_rooms policies ─────────────────────────────────────────────
drop policy if exists "wheel_group_rooms_select_all"   on public.wheel_group_rooms;
drop policy if exists "wheel_group_rooms_insert_anon"  on public.wheel_group_rooms;
drop policy if exists "wheel_group_rooms_update_anon"  on public.wheel_group_rooms;
drop policy if exists "wheel_group_rooms_delete_anon"  on public.wheel_group_rooms;

create policy "wheel_group_rooms_select_all"
  on public.wheel_group_rooms
  for select
  to anon, authenticated
  using (true);

create policy "wheel_group_rooms_insert_anon"
  on public.wheel_group_rooms
  for insert
  to anon, authenticated
  with check (true);

create policy "wheel_group_rooms_update_anon"
  on public.wheel_group_rooms
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "wheel_group_rooms_delete_anon"
  on public.wheel_group_rooms
  for delete
  to anon, authenticated
  using (true);

-- ── wheel_group_players policies ───────────────────────────────────────────
drop policy if exists "wheel_group_players_select_all"   on public.wheel_group_players;
drop policy if exists "wheel_group_players_insert_anon"  on public.wheel_group_players;
drop policy if exists "wheel_group_players_update_anon"  on public.wheel_group_players;
drop policy if exists "wheel_group_players_delete_anon"  on public.wheel_group_players;

create policy "wheel_group_players_select_all"
  on public.wheel_group_players
  for select
  to anon, authenticated
  using (true);

create policy "wheel_group_players_insert_anon"
  on public.wheel_group_players
  for insert
  to anon, authenticated
  with check (true);

create policy "wheel_group_players_update_anon"
  on public.wheel_group_players
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "wheel_group_players_delete_anon"
  on public.wheel_group_players
  for delete
  to anon, authenticated
  using (true);


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Realtime publication
-- ----------------------------------------------------------------------------
-- "alter publication ... add table" idempotent değil; iki kere çağrıda
-- "relation is already member of publication" hatası verir.
-- pg_publication_tables tablosunu kontrol eden idempotent guard kullanıyoruz.
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'wheel_group_rooms'
  ) then
    execute 'alter publication supabase_realtime add table public.wheel_group_rooms';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'wheel_group_players'
  ) then
    execute 'alter publication supabase_realtime add table public.wheel_group_players';
  end if;
end$$;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel çalıştırıp kontrol edilebilir):
--
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name like 'wheel_group_%';
--
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename like 'wheel_group_%';
--
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename like 'wheel_group_%';
-- ============================================================================
