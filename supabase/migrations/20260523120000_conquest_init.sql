-- ============================================================================
-- Kuşatma (Conquest) — Phase 5: Supabase-backed room & player infrastructure
-- ============================================================================
-- Bu migration mevcut tablolara DOKUNMAZ:
--   • duel_rooms / duel_players / duel_claims / duel_messages
--   • duel_group_rooms / duel_group_players / duel_group_claims
--   • wheel_duel_rooms / wheel_duel_players
--   • wheel_group_rooms / wheel_group_players
--   • flag_duel_queue / wheel_duel_queue
--   • xp_events, profiles
--
-- Yalnızca aşağıdaki YENİ nesneleri oluşturur:
--   • public.conquest_rooms         (Kuşatma oda kayıtları)
--   • public.conquest_players       (her odanın oyuncuları, max 4 kişi)
--   • public.conquest_set_updated_at()  (trigger fonksiyonu)
--   • conquest_rooms_set_updated_at     (BEFORE UPDATE trigger)
--   • RLS politikaları (guest-friendly, mevcut multiplayer pattern'iyle aynı)
--   • supabase_realtime publication'a ekleme
--
-- Tüm CREATE'ler "IF NOT EXISTS" / "OR REPLACE" / idempotent guard ile
-- yazılmıştır → migration tekrar çalıştırılırsa hata vermez.
--
-- Çakışma stratejisi:
--   • room_code "K" ile başlatılır (Kuşatma). Diğer modlardan kod çakışması
--     yaşanmaz çünkü conquest_rooms.room_code UNIQUE ayrı tabloda.
--   • Kuşatma max 4 oyuncu. Wheel/Duel'lerden tamamen izole tablolar.
--
-- RLS YAKLAŞIMI:
--   Mevcut multiplayer tablolarıyla (wheel_group, duel_group) aynı strateji:
--   tüm CRUD operasyonları anon+authenticated için açık, kullanıcı kısıtlamaları
--   frontend katmanında uygulanır:
--     - Misafirler oda kuramaz   → ConquestSetup guard
--     - Misafirler public listeyi göremez → ConquestRoomList guard
--     - Misafirler chat'e yazamaz → LobbyChat guard
--   Bu strateji tutarlılık ve guest-link-join flow için seçilmiştir.
--   DB-level fine-grained RLS sonraki fazda eklenebilir; idempotent migration
--   sayesinde policy override etmek güvenli.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Tablolar
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.conquest_rooms (
  id                uuid        primary key default gen_random_uuid(),
  room_code         text        not null unique,

  -- Kim kurdu (host_profile_id auth.users.id, host_player_id ise oda içi
  -- oyuncu satırının id'si). Guest host şu an desteklenmiyor (frontend
  -- guard); ama gelecekte kapı açık tutuluyor → nullable.
  host_profile_id   uuid        null,
  host_player_id    uuid        null,
  host_name         text        not null,

  status            text        not null default 'waiting'
                                  check (status in ('waiting','playing','finished','closed')),

  -- Kuşatma harita kimliği (frontend ConquestMapId ile eşleşir).
  -- "turkey" | "europe" | "middle-east" — string olarak saklanır, yeni
  -- haritalar eklendikçe migration gerekmez.
  map_id            text        not null,

  max_players       int         not null default 4
                                  check (max_players between 2 and 4),

  round_count       int         not null default 6
                                  check (round_count in (4, 6, 8)),

  visibility        text        not null default 'private'
                                  check (visibility in ('public','private')),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  started_at        timestamptz null,
  finished_at       timestamptz null
);

-- Public room list filtre/sort kolonları için indeksler.
create index if not exists conquest_rooms_status_idx
  on public.conquest_rooms (status);

create index if not exists conquest_rooms_visibility_idx
  on public.conquest_rooms (visibility);

create index if not exists conquest_rooms_updated_at_idx
  on public.conquest_rooms (updated_at desc);

-- "Public lobby aç" listesi en yaygın sorgu: WHERE status='waiting' AND
-- visibility='public' ORDER BY updated_at DESC. Composite indeks bu yolu
-- optimize eder.
create index if not exists conquest_rooms_public_listing_idx
  on public.conquest_rooms (status, visibility, updated_at desc);

-- Realtime UPDATE event'leri tam satırı taşısın (eski/yeni karşılaştırma için).
alter table public.conquest_rooms replica identity full;


create table if not exists public.conquest_players (
  id            uuid        primary key default gen_random_uuid(),
  room_id       uuid        not null
                              references public.conquest_rooms(id) on delete cascade,

  -- profile_id: auth.users.id. Guest oyuncularda null.
  -- guest_id  : misafir oyuncu için frontend'in ürettiği lokal id.
  -- En az birinin dolu olması beklenir (yeni satır insert ederken frontend
  -- garanti eder).
  profile_id    uuid        null,
  guest_id      text        null,

  name          text        not null,
  is_host       boolean     not null default false,

  -- ConquestPlayerColor: "red" | "blue" | "green" | "yellow" | "purple" | "orange".
  -- Frontend renk atar; DB string olarak saklar.
  color         text        null,

  joined_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists conquest_players_room_id_idx
  on public.conquest_players (room_id);

create index if not exists conquest_players_room_joined_idx
  on public.conquest_players (room_id, joined_at);

-- Aynı login'li oyuncu aynı odaya iki kere giremez (profile_id NULL ise
-- partial unique → guest çiftlemeyi engellemez; uniqueness yalnız login'li
-- kullanıcı için).
create unique index if not exists conquest_players_room_profile_unique_idx
  on public.conquest_players (room_id, profile_id)
  where profile_id is not null;

alter table public.conquest_players replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) updated_at trigger (yalnız conquest_rooms)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists conquest_rooms_set_updated_at
  on public.conquest_rooms;

create trigger conquest_rooms_set_updated_at
  before update on public.conquest_rooms
  for each row
  execute function public.conquest_set_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Row Level Security
-- ----------------------------------------------------------------------------
-- Mevcut wheel_group/duel_group pattern'iyle aynı yaklaşım: guest joinable
-- olduğu için anon istemcilere geniş CRUD izni verilir; kullanıcı bazlı
-- kısıtlamalar frontend tarafında uygulanır (oda kurma yalnız login'li,
-- public liste yalnız login'li, vb.).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.conquest_rooms   enable row level security;
alter table public.conquest_players enable row level security;

-- ── conquest_rooms policies ────────────────────────────────────────────────
drop policy if exists "conquest_rooms_select_all"   on public.conquest_rooms;
drop policy if exists "conquest_rooms_insert_anon"  on public.conquest_rooms;
drop policy if exists "conquest_rooms_update_anon"  on public.conquest_rooms;
drop policy if exists "conquest_rooms_delete_anon"  on public.conquest_rooms;

create policy "conquest_rooms_select_all"
  on public.conquest_rooms
  for select
  to anon, authenticated
  using (true);

create policy "conquest_rooms_insert_anon"
  on public.conquest_rooms
  for insert
  to anon, authenticated
  with check (true);

create policy "conquest_rooms_update_anon"
  on public.conquest_rooms
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "conquest_rooms_delete_anon"
  on public.conquest_rooms
  for delete
  to anon, authenticated
  using (true);

-- ── conquest_players policies ──────────────────────────────────────────────
drop policy if exists "conquest_players_select_all"   on public.conquest_players;
drop policy if exists "conquest_players_insert_anon"  on public.conquest_players;
drop policy if exists "conquest_players_update_anon"  on public.conquest_players;
drop policy if exists "conquest_players_delete_anon"  on public.conquest_players;

create policy "conquest_players_select_all"
  on public.conquest_players
  for select
  to anon, authenticated
  using (true);

create policy "conquest_players_insert_anon"
  on public.conquest_players
  for insert
  to anon, authenticated
  with check (true);

create policy "conquest_players_update_anon"
  on public.conquest_players
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "conquest_players_delete_anon"
  on public.conquest_players
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
      and tablename  = 'conquest_rooms'
  ) then
    execute 'alter publication supabase_realtime add table public.conquest_rooms';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'conquest_players'
  ) then
    execute 'alter publication supabase_realtime add table public.conquest_players';
  end if;
end$$;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel çalıştırıp kontrol edilebilir):
--
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name like 'conquest_%';
--
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename like 'conquest_%';
--
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename like 'conquest_%';
--
--   select indexname, indexdef from pg_indexes
--    where schemaname = 'public' and tablename like 'conquest_%';
-- ============================================================================
