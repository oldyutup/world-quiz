-- ============================================================================
-- Wheel Duel — Online 1v1 Çark Modu için izole tablo seti
-- ============================================================================
-- Bu migration mevcut tablolara DOKUNMAZ:
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_rooms / duel_group_players / duel_group_claims
--
-- Yalnızca aşağıdaki YENİ nesneleri oluşturur:
--   • public.wheel_duel_rooms     (oda kayıtları)
--   • public.wheel_duel_players   (her odanın oyuncuları)
--   • public.wheel_duel_set_updated_at()  (trigger fonksiyonu)
--   • wheel_duel_rooms_set_updated_at     (BEFORE UPDATE trigger)
--   • RLS politikaları (guest-friendly, mevcut duel pattern'i ile aynı izinler)
--   • supabase_realtime publication'a ekleme
--
-- Tüm CREATE'ler "IF NOT EXISTS" / "OR REPLACE" / idempotent guard ile
-- yazılmıştır → migration tekrar çalıştırılırsa hata vermez.
--
-- Çakışma stratejisi:
--   • Mevcut duel_rooms.code ile aynı koda denk gelmemek için Wheel Duel
--     uygulaması code'u "W" ile başlatacak (örn. WABC12). Bu kural app-side;
--     DB'de zorlanmıyor ama wheel_duel_rooms.code UNIQUE olduğundan kendi
--     tablosunda çakışma garantili engelleniyor.
--   • Chat için mevcut duel_messages tablosu reuse edilebilir
--     (LobbyChat.tsx room_code üzerinden çalışıyor). W-prefix sayesinde
--     country/flag/wheel kodları aynı text alanında karışmadan oturur.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Tablolar
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.wheel_duel_rooms (
  id                     uuid        primary key default gen_random_uuid(),
  code                   text        not null unique,
  status                 text        not null default 'waiting'
                                     check (status in ('waiting','playing','finished')),
  duration_seconds       int         not null default 60
                                     check (duration_seconds > 0),
  region                 text        not null default 'world',
  host_player_id         uuid        null,
  started_at             timestamptz null,
  finished_at            timestamptz null,
  finished_reason        text        null,
  winner_player_id       uuid        null,
  current_target_topoid  text        null,
  used_target_topoids    text[]      not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists wheel_duel_rooms_status_idx
  on public.wheel_duel_rooms (status);

create index if not exists wheel_duel_rooms_created_at_idx
  on public.wheel_duel_rooms (created_at desc);

-- Realtime UPDATE event'leri tam satırı taşısın (yalnız değişen kolon değil).
alter table public.wheel_duel_rooms replica identity full;


create table if not exists public.wheel_duel_players (
  id            uuid        primary key default gen_random_uuid(),
  room_id       uuid        not null
                              references public.wheel_duel_rooms(id) on delete cascade,
  name          text        not null,
  score         int         not null default 0 check (score >= 0),
  joined_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists wheel_duel_players_room_id_idx
  on public.wheel_duel_players (room_id);

alter table public.wheel_duel_players replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) updated_at trigger (yalnız wheel_duel_rooms; players'da updated_at yok)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists wheel_duel_rooms_set_updated_at
  on public.wheel_duel_rooms;

create trigger wheel_duel_rooms_set_updated_at
  before update on public.wheel_duel_rooms
  for each row
  execute function public.wheel_duel_set_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Row Level Security
-- ----------------------------------------------------------------------------
-- Mevcut country/flag duel pattern'iyle aynı yaklaşım: misafir oyuncu
-- desteklendiği için anon istemcilere geniş izin verilir. Üretim güvenliği
-- ileride server-authoritative aksiyonlara taşındığında bu policy'ler
-- daraltılabilir.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.wheel_duel_rooms   enable row level security;
alter table public.wheel_duel_players enable row level security;

-- ── wheel_duel_rooms policies ──────────────────────────────────────────────
drop policy if exists "wheel_rooms_select_all"   on public.wheel_duel_rooms;
drop policy if exists "wheel_rooms_insert_anon"  on public.wheel_duel_rooms;
drop policy if exists "wheel_rooms_update_anon"  on public.wheel_duel_rooms;
drop policy if exists "wheel_rooms_delete_anon"  on public.wheel_duel_rooms;

create policy "wheel_rooms_select_all"
  on public.wheel_duel_rooms
  for select
  to anon, authenticated
  using (true);

create policy "wheel_rooms_insert_anon"
  on public.wheel_duel_rooms
  for insert
  to anon, authenticated
  with check (true);

create policy "wheel_rooms_update_anon"
  on public.wheel_duel_rooms
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "wheel_rooms_delete_anon"
  on public.wheel_duel_rooms
  for delete
  to anon, authenticated
  using (true);

-- ── wheel_duel_players policies ────────────────────────────────────────────
drop policy if exists "wheel_players_select_all"   on public.wheel_duel_players;
drop policy if exists "wheel_players_insert_anon"  on public.wheel_duel_players;
drop policy if exists "wheel_players_update_anon"  on public.wheel_duel_players;
drop policy if exists "wheel_players_delete_anon"  on public.wheel_duel_players;

create policy "wheel_players_select_all"
  on public.wheel_duel_players
  for select
  to anon, authenticated
  using (true);

create policy "wheel_players_insert_anon"
  on public.wheel_duel_players
  for insert
  to anon, authenticated
  with check (true);

create policy "wheel_players_update_anon"
  on public.wheel_duel_players
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "wheel_players_delete_anon"
  on public.wheel_duel_players
  for delete
  to anon, authenticated
  using (true);


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Realtime publication
-- ----------------------------------------------------------------------------
-- supabase_realtime publication'a tabloları ekle ki istemciler
-- postgres_changes event'lerini dinleyebilsin.
--
-- "alter publication ... add table" idempotent değil; iki kere çağrıda
-- "relation is already member of publication" hatası verir.
-- Bu yüzden pg_publication_tables tablosunu kontrol eden idempotent guard:
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'wheel_duel_rooms'
  ) then
    execute 'alter publication supabase_realtime add table public.wheel_duel_rooms';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'wheel_duel_players'
  ) then
    execute 'alter publication supabase_realtime add table public.wheel_duel_players';
  end if;
end$$;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel çalıştırıp kontrol edilebilir):
--
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name like 'wheel_duel_%';
--
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename like 'wheel_duel_%';
--
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename like 'wheel_duel_%';
-- ============================================================================
