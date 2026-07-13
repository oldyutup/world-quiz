-- ============================================================================
-- Flag Group — Bayrak Bilmece Çok Oyunculu (2–10 kişi) — izole tablo + RPC seti
-- ============================================================================
-- AMAÇ
-- ----
-- Bayrak Bilmece'nin mevcut 1v1 (flag_duel_* / duel_rooms) motoruna DOKUNMADAN
-- oda koduyla oynanan 2–10 kişilik çok oyunculu sürümünü ekler. Yeni bir oyun
-- türü ("tur bazlı bayrak yarışı + grup oda yaşam döngüsü") olduğu için —
-- board-claim yapılı duel_group_* ile de, 1v1-yapılı flag_duel_* ile de aynı
-- işi yapmadığından — kendi izole tablo/RPC setini alır. Bu, projedeki mevcut
-- kanona uygundur (duel_group_*, wheel_group_*, conquest_* hepsi izole set).
--
-- TASARIM KARARLARI
-- -----------------
--   • Oda yaşam döngüsü (create/join/kick/leave/return/kapasite) duel_group_*
--     M1+M2+M3 pattern'inden birebir uyarlandı — beş kez sahada doğrulanmış
--     yaklaşım.
--   • Tur bazlı bayrak modeli flag_duel_* pattern'inden uyarlandı:
--       - rooms.current_flag / current_flag_at (sunucu now()) → senkron tur.
--       - rooms.game_seq her start_game'de monoton artar → oyun oturumu kimliği.
--       - claims tablosu UNIQUE(room_id, game_seq, round) → ATOMİK ilk-doğru:
--         tur kimliği DEĞİŞMEZ (game_seq+round), ülke koduna bağlı DEĞİL. İki
--         oyuncu aynı turu çok yakın anda doğru bilse yalnız BİRİNİN insert'i
--         başarılı olur; diğeri unique_violation → 'dup'. submit_claim odayı
--         FOR UPDATE ile kilitler (set_next_round ile aynı sıra) → doğrula+insert
--         atomik; ilerlemiş turun eski cevabı ASLA yazılmaz. N oyuncuya ölçeklenir.
--   • Kazanan/skor SERVER-otoriter türetilir: her başarılı claim = 1 tur = 1 puan.
--       Tur kimliği (game_seq, round) olduğu için AYNI ülke başka turda ya da
--       yeni oyunda (yeni game_seq) tekrar gelebilir — eski oyunun claim'i (farklı
--       game_seq) yeni oyunu ETKİLEMEZ; claim temizliğine bağlı DEĞİL.
--   • "Lobiye Dön" per-player (Kuşatma modeli): finalize TÜM oyuncuları
--     status='finished' yapar; her oyuncu KENDİ return_to_lobby'sini çağırır →
--     kendi status'u 'waiting' olur. Dönmeyen oyuncu 'finished' kalır →
--     client "Sonuç ekranında" (dimmed) gösterir. Host start_game YALNIZ tüm
--     oyuncular 'waiting' iken çalışır (players_not_ready guard).
--
-- GÜVENLİK (hardened-from-birth)
-- ------------------------------
--   • rooms/players/claims: SELECT herkese açık (realtime + oda kodu lookup +
--     leaderboard için ZORUNLU). INSERT/UPDATE/DELETE policy YOK → tüm yazımlar
--     yalnız SECURITY DEFINER RPC'leri üzerinden (duel_group M3 son-durumuyla
--     aynı). players INSERT için defense-in-depth self-policy var.
--   • flag_group_player_claims: özel token deposu; INSERT-only, SELECT/UPDATE/
--     DELETE grant YOK, realtime publication DIŞI (token asla broadcast edilmez).
--   • Her RPC: SECURITY DEFINER + set search_path=public,auth; authorize_player/
--     authorize_host ile claim_token veya auth.uid() kanıtı ZORUNLU.
--   • auth.uid() ↔ profile_id XOR guest_id tutarlılığı zorunlu.
--   • Odaya ait olmayan oyuncu: cevap gönderemez (player_room_mismatch), oyun
--     başlatamaz / round değiştiremez / oyuncu atamaz (authorize_host), skor
--     yazamaz (submit_claim status + current_flag guard).
--
-- BAĞIMLILIK
-- ----------
--   • public.assert_display_name_allowed(text, uuid, text)
--     (20260704120000_display_name_registry_guard_helper.sql)
--
-- DOKUNULMAYAN
-- -----------
--   • duel_*, duel_group_*, wheel_*, flag_duel_*, conquest_*, kornokta_*,
--     duel_messages, profiles, xp_events — hiçbirine dokunulmaz.
--
-- IDEMPOTENT
-- ----------
--   • create table if not exists / create or replace function / drop policy if
--     exists + create policy / publication guard → tekrar koşulabilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Tablolar
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.flag_group_rooms (
  id               uuid        primary key default gen_random_uuid(),
  code             text        not null unique,
  status           text        not null default 'waiting'
                               check (status in ('waiting','playing','finished')),
  region           text        not null default 'world',
  total_rounds     int         not null default 10
                               check (total_rounds in (5, 10, 15, 20)),
  max_players      int         not null default 10
                               check (max_players between 2 and 10),
  current_round    int         not null default 0,
  current_flag     text        null,   -- lowercase ISO alpha-2 (flag SVG key)
  current_flag_at  timestamptz null,   -- tur başlangıcı (per-flag timer)
  -- game_seq: her start_game'de monoton artar → aynı odada peş peşe oyunlar
  -- (current_round tekrar 1'den başlasa da) farklı oturum kimliği alır. Claim
  -- tekilliği (room_id, game_seq, round) ile bu değere bağlanır (ülke koduna
  -- DEĞİL) → aynı ülke yeni oyunda/başka turda serbestçe tekrar gelebilir.
  game_seq         int         not null default 0,
  started_at       timestamptz null,
  finished_at      timestamptz null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists flag_group_rooms_status_idx
  on public.flag_group_rooms (status);
create index if not exists flag_group_rooms_created_at_idx
  on public.flag_group_rooms (created_at desc);

alter table public.flag_group_rooms replica identity full;


create table if not exists public.flag_group_players (
  id           uuid        primary key default gen_random_uuid(),
  room_id      uuid        not null
                             references public.flag_group_rooms(id) on delete cascade,
  name         text        not null,
  is_host      boolean     not null default false,
  status       text        not null default 'waiting'
                             check (status in ('waiting','playing','finished')),
  profile_id   uuid        null,
  guest_id     text        null,
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists flag_group_players_room_id_idx
  on public.flag_group_players (room_id);
create index if not exists flag_group_players_joined_at_idx
  on public.flag_group_players (room_id, joined_at);

alter table public.flag_group_players replica identity full;


create table if not exists public.flag_group_claims (
  id           bigint      generated always as identity primary key,
  room_id      uuid        not null
                             references public.flag_group_rooms(id) on delete cascade,
  player_id    uuid        not null
                             references public.flag_group_players(id) on delete cascade,
  -- game_seq + round: kazananın bağlandığı DEĞİŞMEZ tur kimliği. Ülke koduna
  -- bağlı DEĞİL → aynı ülke başka turda/yeni oyunda tekrar gelebilir; eski
  -- oyunun claim'i (farklı game_seq) yeni oyunu ETKİLEMEZ.
  game_seq     int         not null,
  round        int         not null,
  country_code text        not null,   -- o turda claim edilen doğru cevap (audit/ekran)
  created_at   timestamptz not null default now(),
  -- ATOMİK TEK-KAZANAN: (oda, oyun oturumu, tur) başına yalnız BİR claim.
  -- İki oyuncu aynı turu aynı anda doğru bilse yalnız BİRİ insert eder
  -- (diğeri unique_violation → 'dup'). N oyuncuya ölçeklenir.
  unique (room_id, game_seq, round)
);

create index if not exists flag_group_claims_room_id_idx
  on public.flag_group_claims (room_id);

alter table public.flag_group_claims replica identity full;


-- Özel claim-token deposu (realtime DIŞI, SELECT grant YOK).
create table if not exists public.flag_group_player_claims (
  player_id   uuid        primary key
                          references public.flag_group_players(id) on delete cascade,
  claim_token uuid        not null,
  created_at  timestamptz not null default now()
);


-- ────────────────────────────────────────────────────────────────────────────
-- 2) updated_at trigger + boş oda cleanup trigger
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists flag_group_rooms_set_updated_at on public.flag_group_rooms;
create trigger flag_group_rooms_set_updated_at
  before update on public.flag_group_rooms
  for each row
  execute function public.flag_group_set_updated_at();


-- Son oyuncu çıkınca odayı sil (duel_group_room_cleanup pattern'i).
create or replace function public.flag_group_rooms_cleanup_after_player_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
begin
  select count(*) into remaining
    from public.flag_group_players
   where room_id = old.room_id;

  if remaining = 0 then
    delete from public.flag_group_rooms where id = old.room_id;
  end if;

  return old;
end;
$$;

drop trigger if exists flag_group_players_cleanup_after_delete
  on public.flag_group_players;
create trigger flag_group_players_cleanup_after_delete
  after delete on public.flag_group_players
  for each row
  execute function public.flag_group_rooms_cleanup_after_player_delete();


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Row Level Security (hardened-from-birth: yalnız SELECT + defansif INSERT)
-- ----------------------------------------------------------------------------
-- PUBLIC SELECT NEDEN? (duel_group_* / wheel_group_* / conquest_* ile AYNI kanon)
--   Supabase Realtime (postgres_changes) RLS'i abonelik anında SELECT policy'si
--   üzerinden uygular; misafir (anon) oyuncunun kimliği claim_token'dır ve bu
--   token RLS'e AÇIK DEĞİLDİR (RPC argümanı; JWT/connection auth'ta yok). Bu
--   yüzden üyeliğe-bağlı SELECT policy'si MİSAFİR realtime'ını tamamen kırardı
--   (anon'da auth.uid()=null). Oda kodu ile katılma da lookup'ı client SELECT'te
--   DEĞİL flag_group_join_room SECURITY DEFINER RPC'sinde yapar → enumeration
--   ile bile katılım kapasite + status + isim guard'larından geçmek zorunda.
--
-- DIŞARI AÇILAN ve NEDEN GÜVENLİ:
--   • rooms: code / status / region / current_flag / current_round vb. current_flag
--     zaten O AN gösterilen bayrağın koduysa (görsel olarak herkese açık) —
--     yeni bilgi sızdırmaz; GELECEK bayraklar DB'de HİÇBİR YERDE tutulmaz (yalnız
--     host'un client-side belleğinde) → önden cevap sızıntısı YOK. Bu, mevcut
--     Bayrak 1v1 (duel_rooms.current_flag) ile birebir aynı maruz kalma.
--   • players: name/status. İsimler zaten public profil/leaderboard'da görünür.
--   • claims: bir satır YALNIZ bir tur DOĞRU bilindikten SONRA oluşur (country_code
--     = o turun cevabı). Yani cevabı ANSWER'DAN ÖNCE sızdırmaz; gelecek turların
--     cevabı claims'te YOKTUR. Round-içi canlı skor/kazanan bu akıştan türetilir.
--   • player_claims (token): SELECT grant YOK + realtime DIŞI → token asla okunmaz.
--   Enumeration riski (kod tahmini): mevcut tüm modlarla aynı; katılım RPC-gated,
--   host kick + kapasite ile sınırlı. Özel arkadaş odası modeli için kabul edilir.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.flag_group_rooms         enable row level security;
alter table public.flag_group_players       enable row level security;
alter table public.flag_group_claims        enable row level security;
alter table public.flag_group_player_claims enable row level security;

-- rooms: SELECT herkese; INSERT/UPDATE/DELETE policy YOK → RPC-only.
drop policy if exists "flag_group_rooms_select_public" on public.flag_group_rooms;
create policy "flag_group_rooms_select_public"
  on public.flag_group_rooms for select to anon, authenticated using (true);

-- players: SELECT herkese; INSERT defansif self; UPDATE/DELETE policy YOK.
drop policy if exists "flag_group_players_select_public" on public.flag_group_players;
create policy "flag_group_players_select_public"
  on public.flag_group_players for select to anon, authenticated using (true);

drop policy if exists "flag_group_players_insert_self" on public.flag_group_players;
create policy "flag_group_players_insert_self"
  on public.flag_group_players for insert to anon, authenticated
  with check (
       (profile_id is not null and profile_id = auth.uid())
    or (profile_id is null and guest_id is not null and length(btrim(guest_id)) > 0)
  );

-- claims: SELECT herkese; INSERT/UPDATE/DELETE policy YOK → RPC-only.
drop policy if exists "flag_group_claims_select_public" on public.flag_group_claims;
create policy "flag_group_claims_select_public"
  on public.flag_group_claims for select to anon, authenticated using (true);

-- player_claims: INSERT-only; SELECT/UPDATE/DELETE grant geri alınır.
drop policy if exists "flag_group_player_claims_insert" on public.flag_group_player_claims;
create policy "flag_group_player_claims_insert"
  on public.flag_group_player_claims for insert to anon, authenticated
  with check (true);

revoke select, update, delete on public.flag_group_player_claims from anon, authenticated;
grant  insert                   on public.flag_group_player_claims to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Realtime publication (player_claims KASTEN dahil değil — token gizli)
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='flag_group_rooms') then
    execute 'alter publication supabase_realtime add table public.flag_group_rooms';
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='flag_group_players') then
    execute 'alter publication supabase_realtime add table public.flag_group_players';
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='flag_group_claims') then
    execute 'alter publication supabase_realtime add table public.flag_group_claims';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) Yetki yardımcıları
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1
      from public.flag_group_players p
      left join public.flag_group_player_claims c on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
         or (p_claim_token is not null and c.claim_token = p_claim_token)
       )
  );
$$;
revoke all     on function public.flag_group_authorize_player(uuid, uuid) from public;
grant  execute on function public.flag_group_authorize_player(uuid, uuid) to anon, authenticated;


create or replace function public.flag_group_authorize_host(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1
      from public.flag_group_players p
     where p.id      = p_player_id
       and p.room_id = p_room_id
       and p.is_host = true
       and public.flag_group_authorize_player(p_player_id, p_claim_token)
  );
$$;
revoke all     on function public.flag_group_authorize_host(uuid, uuid, uuid) from public;
grant  execute on function public.flag_group_authorize_host(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) flag_group_create_room
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_create_room(
  p_player_id    uuid,
  p_profile_id   uuid,
  p_guest_id     text,
  p_name         text,
  p_code         text,
  p_region       text,
  p_total_rounds int,
  p_max_players  int,
  p_claim_token  uuid
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room         public.flag_group_rooms;
  v_uid          uuid := auth.uid();
  v_display_name text;
begin
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

  -- Display name: registry guard (name_invalid / display_name_forbidden /
  -- registered_username_taken helper içinde raise).
  v_display_name := public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id);

  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;
  if p_region is null or length(btrim(p_region)) = 0 then
    raise exception 'region_required' using errcode = '22023';
  end if;
  if p_total_rounds is null or p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'total_rounds_invalid' using errcode = '22023';
  end if;
  if p_max_players is null or p_max_players < 2 or p_max_players > 10 then
    raise exception 'max_players_invalid' using errcode = '22023';
  end if;

  begin
    insert into public.flag_group_rooms (
      code, status, region, total_rounds, max_players, current_round, current_flag
    ) values (
      p_code, 'waiting', p_region, p_total_rounds, p_max_players, 0, null
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  insert into public.flag_group_players (
    id, room_id, name, is_host, status, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, v_display_name, true, 'waiting', p_profile_id, p_guest_id, now()
  );

  insert into public.flag_group_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;
revoke all     on function public.flag_group_create_room(uuid, uuid, text, text, text, text, int, int, uuid) from public;
grant  execute on function public.flag_group_create_room(uuid, uuid, text, text, text, text, int, int, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) flag_group_join_room
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_join_room(
  p_code        text,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_claim_token uuid
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room         public.flag_group_rooms;
  v_uid          uuid := auth.uid();
  v_count        int;
  v_display_name text;
begin
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

  v_display_name := public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id);

  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;

  select * into v_room from public.flag_group_rooms where code = p_code for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    raise exception 'room_finished' using errcode = 'P0001';
  end if;
  if v_room.status = 'playing' then
    raise exception 'room_in_progress' using errcode = 'P0001';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_unavailable' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.flag_group_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(v_display_name)
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  -- Kapasite (lock altındayız → race-free). Gerçek aktif üyelik sayısı.
  select count(*) into v_count
    from public.flag_group_players where room_id = v_room.id;
  if v_count >= coalesce(v_room.max_players, 10) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  insert into public.flag_group_players (
    id, room_id, name, is_host, status, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, v_display_name, false, 'waiting', p_profile_id, p_guest_id, now()
  );

  insert into public.flag_group_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  update public.flag_group_rooms set updated_at = now() where id = v_room.id;

  select * into v_room from public.flag_group_rooms where id = v_room.id;
  return v_room;
end;
$$;
revoke all     on function public.flag_group_join_room(text, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.flag_group_join_room(text, uuid, uuid, text, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) flag_group_update_settings (host-only, lobby-only)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_update_settings(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_total_rounds   int,
  p_region         text,
  p_max_players    int
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room  public.flag_group_rooms;
  v_count int;
begin
  if not public.flag_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_total_rounds is null and p_region is null and p_max_players is null then
    raise exception 'no_fields_to_update' using errcode = '22023';
  end if;
  if p_total_rounds is not null and p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'total_rounds_invalid' using errcode = '22023';
  end if;
  if p_region is not null and length(btrim(p_region)) = 0 then
    raise exception 'region_invalid' using errcode = '22023';
  end if;
  if p_max_players is not null and (p_max_players < 2 or p_max_players > 10) then
    raise exception 'max_players_invalid' using errcode = '22023';
  end if;

  if p_max_players is not null then
    select count(*) into v_count from public.flag_group_players where room_id = p_room_id;
    if p_max_players < v_count then
      raise exception 'max_players_too_low' using errcode = 'P0001';
    end if;
  end if;

  update public.flag_group_rooms
     set total_rounds = coalesce(p_total_rounds, total_rounds),
         region       = coalesce(p_region,       region),
         max_players  = coalesce(p_max_players,  max_players),
         updated_at   = now()
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  return v_room;
end;
$$;
revoke all     on function public.flag_group_update_settings(uuid, uuid, uuid, int, text, int) from public;
grant  execute on function public.flag_group_update_settings(uuid, uuid, uuid, int, text, int) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) flag_group_start_game (host-only)
-- ----------------------------------------------------------------------------
-- waiting → playing. Kapasite >= 2. TÜM oyuncular 'waiting' olmalı (sonuç
-- ekranında kalan oyuncu varsa players_not_ready). İlk bayrağı host çeker.
-- Eski maçın claim'leri temizlenir; herkes status='playing'.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_first_flag     text
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room       public.flag_group_rooms;
  v_count      int;
  v_not_ready  int;
begin
  if not public.flag_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_first_flag is null or length(btrim(p_first_flag)) = 0 then
    raise exception 'first_flag_required' using errcode = '22023';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.flag_group_players where room_id = p_room_id;
  if v_count < 2 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;

  -- Sonuç ekranından dönmemiş oyuncu var mı?
  select count(*) into v_not_ready
    from public.flag_group_players
   where room_id = p_room_id and status <> 'waiting';
  if v_not_ready > 0 then
    raise exception 'players_not_ready' using errcode = 'P0001';
  end if;

  delete from public.flag_group_claims where room_id = p_room_id;

  update public.flag_group_players
     set status = 'playing', last_seen_at = now()
   where room_id = p_room_id;

  update public.flag_group_rooms
     set status          = 'playing',
         started_at      = now(),
         finished_at     = null,
         current_round   = 1,
         current_flag    = p_first_flag,
         current_flag_at = now(),
         game_seq        = game_seq + 1,   -- yeni oyun oturumu → claim kimliği ayrışır
         updated_at      = now()
   where id = p_room_id
     and status = 'waiting'
   returning * into v_room;

  return v_room;
end;
$$;
revoke all     on function public.flag_group_start_game(uuid, uuid, uuid, text) from public;
grant  execute on function public.flag_group_start_game(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 10) flag_group_set_next_round (host-only)
-- ----------------------------------------------------------------------------
-- Sonraki bayrağa geç. current_flag_at server now() → senkron per-flag timer.
-- Yalnız host çağırır (tek otoriter ilerletici); tüm client'lar realtime
-- room UPDATE ile yeni bayrağı aynı anda görür.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_set_next_round(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_next_round     int,
  p_next_flag      text
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room public.flag_group_rooms;
begin
  if not public.flag_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_next_round is null or p_next_round < 1 then
    raise exception 'next_round_invalid' using errcode = '22023';
  end if;
  if p_next_flag is null or length(btrim(p_next_flag)) = 0 then
    raise exception 'next_flag_required' using errcode = '22023';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  update public.flag_group_rooms
     set current_round   = p_next_round,
         current_flag    = p_next_flag,
         current_flag_at = now(),
         updated_at      = now()
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  return v_room;
end;
$$;
revoke all     on function public.flag_group_set_next_round(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.flag_group_set_next_round(uuid, uuid, uuid, int, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 11) flag_group_submit_claim (player-only) — ATOMİK İLK-DOĞRU
-- ----------------------------------------------------------------------------
-- YARIŞ KOŞULU KAPAĞI:
--   Oda satırı `SELECT ... FOR UPDATE` ile kilitlenir — set_next_round /
--   start_game / finalize / return_to_lobby ile AYNI kilit sırası (tek satır,
--   deadlock imkânsız). Böylece "cevabı doğrula → insert" arası ATOMİK olur:
--   submit ile set_next_round yarışırsa biri kilidi alır, diğeri bekler.
--     • submit önce: turu doğrular, insert eder, commit.
--     • set_next_round önce: current_flag değişir; submit kilidi alınca
--       p_country_code <> current_flag → 'stale' (ESKİ tur cevabı ASLA yazılmaz).
--   Kilit OLMASAYDI (READ COMMITTED) submit, current_flag'i eski okuyup
--   set_next_round commit ettikten SONRA insert edebilir → süresi dolmuş turu
--   yanlışlıkla puanlardı. FOR UPDATE bunu kapatır. Client timestamp'ına
--   GÜVENİLMEZ; kapak tamamen server-side.
--
-- TEK-KAZANAN KİMLİĞİ:
--   Claim (game_seq, current_round) DEĞİŞMEZ tur kimliğine yazılır; UNIQUE(
--   room_id, game_seq, round) tur başına tek kazananı garanti eder — ülke
--   koduna bağlı DEĞİL. İki oyuncu aynı turu aynı anda bilse yalnız BİRİ insert
--   eder (diğeri unique_violation → 'dup'). Aynı ülke başka turda/yeni oyunda
--   (yeni game_seq) serbestçe tekrar gelebilir; eski oyunun claim'i çakışmaz.
--
--   • Yalnız MEVCUT turun doğru cevabı sayılır (p_country_code = current_flag)
--     → yanlış cevap / eski-tur cevabı 'stale' (skor üretmez).
--   • Aynı oyuncu tekrar aynı turu gönderse ikinci insert 'dup'.
-- Dönüş: jsonb { claimed: bool, reason?: 'dup' | 'stale' }
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_submit_claim(
  p_room_id      uuid,
  p_player_id    uuid,
  p_claim_token  uuid,
  p_country_code text
) returns jsonb
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room public.flag_group_rooms;
begin
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_country_code is null or length(btrim(p_country_code)) = 0 then
    raise exception 'country_code_required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.flag_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Oda satırını KİLİTLE (set_next_round ile aynı kilit → doğrula+insert atomik).
  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Yalnız mevcut turun bayrağı sayılır (server-otoriter round kapağı).
  -- Kilit altında okunduğu için set_next_round bu noktada round'u ilerletmiş
  -- olamaz (ya bekliyor ya da bizden önce commit etti → current_flag değişti).
  if p_country_code <> v_room.current_flag then
    return jsonb_build_object('claimed', false, 'reason', 'stale');
  end if;

  begin
    insert into public.flag_group_claims (room_id, player_id, game_seq, round, country_code)
    values (p_room_id, p_player_id, v_room.game_seq, v_room.current_round, p_country_code);
  exception
    when unique_violation then
      return jsonb_build_object('claimed', false, 'reason', 'dup');
  end;

  return jsonb_build_object('claimed', true);
end;
$$;
revoke all     on function public.flag_group_submit_claim(uuid, uuid, uuid, text) from public;
grant  execute on function public.flag_group_submit_claim(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 12) flag_group_finalize_game (player-in-room, idempotent)
-- ----------------------------------------------------------------------------
-- playing → finished. TÜM oyuncular status='finished' (sonuç ekranı). Herhangi
-- bir oyuncu tetikleyebilir (host normalde son turdan sonra çağırır; host son
-- anda kopsa bile herhangi bir client güvenlik ağı olarak tetikleyebilir).
-- Skor/sıralama client tarafında flag_group_claims COUNT'undan türetilir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_finalize_game(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room public.flag_group_rooms;
begin
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.flag_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  update public.flag_group_rooms
     set status      = 'finished',
         finished_at = now(),
         updated_at  = now()
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.flag_group_rooms where id = p_room_id;
  end if;

  -- Tüm oyuncuları sonuç ekranına al (per-player return_to_lobby'nin baseline'ı).
  update public.flag_group_players
     set status = 'finished', last_seen_at = now()
   where room_id = p_room_id;

  return v_room;
end;
$$;
revoke all     on function public.flag_group_finalize_game(uuid, uuid, uuid) from public;
grant  execute on function public.flag_group_finalize_game(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 13) flag_group_return_to_lobby (PER-PLAYER — Kuşatma modeli)
-- ----------------------------------------------------------------------------
-- Her oyuncu KENDİ "Lobiye Dön"ünü çağırır. Yalnız kendi status'unu 'waiting'
-- yapar. İlk dönen oyuncu room.status'u 'finished' → 'waiting' çevirir (lobi
-- yeniden açılır); diğer dönmeyenler 'finished' kalır → client "Sonuç
-- ekranında". Host start_game YALNIZ herkes 'waiting' iken çalışır.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_return_to_lobby(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room public.flag_group_rooms;
begin
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.flag_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- İlk dönen oyuncu odayı yeniden lobiye açar (finished → waiting).
  if v_room.status = 'finished' then
    update public.flag_group_rooms
       set status          = 'waiting',
           started_at      = null,
           current_round   = 0,
           current_flag    = null,
           current_flag_at = null,
           updated_at      = now()
     where id = p_room_id
       and status = 'finished'
     returning * into v_room;
  end if;

  -- Yalnız çağıranın kendi satırı 'waiting'.
  update public.flag_group_players
     set status = 'waiting', last_seen_at = now()
   where id = p_player_id and room_id = p_room_id;

  select * into v_room from public.flag_group_rooms where id = p_room_id;
  return v_room;
end;
$$;
revoke all     on function public.flag_group_return_to_lobby(uuid, uuid, uuid) from public;
grant  execute on function public.flag_group_return_to_lobby(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 14) flag_group_kick_player (host-only; lobby VEYA sonuç fazında)
-- ----------------------------------------------------------------------------
-- Aktif oyun (playing) sırasında kick YAPILMAZ (state bozulmasını önler).
-- Lobby (waiting) ve sonuç (finished) fazında host, dönmeyen/kopmuş oyuncuyu
-- atıp odanın devam etmesini sağlayabilir. Self-kick reddedilir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_kick_player(
  p_room_id          uuid,
  p_host_player_id   uuid,
  p_host_claim_token uuid,
  p_target_player_id uuid
) returns void
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room public.flag_group_rooms;
begin
  if not public.flag_group_authorize_host(p_room_id, p_host_player_id, p_host_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target_player_id is null then
    raise exception 'target_player_required' using errcode = '22023';
  end if;
  if p_target_player_id = p_host_player_id then
    raise exception 'cannot_kick_self' using errcode = 'P0001';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'playing' then
    raise exception 'room_in_progress' using errcode = 'P0001';
  end if;

  delete from public.flag_group_players
   where id = p_target_player_id and room_id = p_room_id;
end;
$$;
revoke all     on function public.flag_group_kick_player(uuid, uuid, uuid, uuid) from public;
grant  execute on function public.flag_group_kick_player(uuid, uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 15) flag_group_leave_room (caller-only)
-- ----------------------------------------------------------------------------
--   • Host ayrılırsa → oda tamamen silinir (FK cascade). Diğer client'lar
--     rooms DELETE realtime event'iyle "Oda sahibi ayrıldı" görür.
--   • Non-host ayrılırsa → kendi satırı silinir; trigger oda boşalırsa temizler.
--     Oyun sürerken de güvenli: skor tablosu/round kilitlenmez (kalanlar devam).
-- Host kavramı flag_group_players.is_host ile; host devri YOK — host ayrılınca
-- oda kapanır (task: "host bilinçli ayrılırsa oda kapansın").
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room      public.flag_group_rooms;
  v_is_host   boolean;
  v_remaining int;
begin
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    return;  -- oda yok → no-op
  end if;

  select is_host into v_is_host
    from public.flag_group_players
   where id = p_player_id and room_id = p_room_id;
  if v_is_host is null then
    return;  -- bu odada değil → no-op
  end if;

  if v_is_host then
    delete from public.flag_group_rooms where id = p_room_id;  -- cascade
    return;
  end if;

  delete from public.flag_group_players
   where id = p_player_id and room_id = p_room_id;

  select count(*) into v_remaining
    from public.flag_group_players where room_id = p_room_id;
  if v_remaining = 0 then
    delete from public.flag_group_rooms where id = p_room_id;
  end if;
end;
$$;
revoke all     on function public.flag_group_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.flag_group_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 16) flag_group_heartbeat (player-only, kendi last_seen_at)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_heartbeat(
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql security definer set search_path = public, auth
as $$
begin
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  update public.flag_group_players
     set last_seen_at = now()
   where id = p_player_id;
end;
$$;
revoke all     on function public.flag_group_heartbeat(uuid, uuid) from public;
grant  execute on function public.flag_group_heartbeat(uuid, uuid) to anon, authenticated;


-- ============================================================================
-- DONE — doğrulama (Studio SQL editor):
--   select proname, prosecdef from pg_proc
--    where pronamespace='public'::regnamespace and proname like 'flag_group_%'
--    order by proname;
--   -- Beklenen: 13 fonksiyon (authorize_player/host + 11 aksiyon), hepsi
--   --           prosecdef=true.
--   select tablename, policyname, cmd from pg_policies
--    where schemaname='public' and tablename like 'flag_group_%' order by 1,2;
--   -- rooms/players/claims: yalnız SELECT (+ players INSERT self); player_claims: INSERT.
--
-- Smoke (3 oturum):
--   select * from flag_group_create_room(gen_random_uuid(), null, 'gA','Alice','FG0001','world',10,10,gen_random_uuid());
--   select * from flag_group_join_room('FG0001', gen_random_uuid(), null,'gB','Bob',   gen_random_uuid());
--   select * from flag_group_join_room('FG0001', gen_random_uuid(), null,'gC','Carol', gen_random_uuid());
--   select * from flag_group_start_game('<room>','<A>','<A tok>','tr');   -- game_seq=1, round=1
--   select flag_group_submit_claim('<room>','<B>','<B tok>','tr');  -- {claimed:true}   → (room,1,1)
--   select flag_group_submit_claim('<room>','<C>','<C tok>','tr');  -- {claimed:false,'dup'} (aynı tur)
--   select * from flag_group_set_next_round('<room>','<A>','<A tok>',2,'us');
--   select flag_group_submit_claim('<room>','<B>','<B tok>','tr');  -- {claimed:false,'stale'} (eski bayrak)
--   select * from flag_group_finalize_game('<room>','<A>','<A tok>');
--   select * from flag_group_return_to_lobby('<room>','<B>','<B tok>');
--
-- Aynı ülke YENİ oyunda tekrar (game_seq izolasyonu):
--   select * from flag_group_start_game('<room>','<A>','<A tok>','tr');   -- game_seq=2, round=1
--   select flag_group_submit_claim('<room>','<B>','<B tok>','tr');  -- {claimed:true} → (room,2,1)
--     -- ÇAKIŞMA YOK: eski (room,1,1)'tr claim'i (game_seq=1) ile aynı UNIQUE bucket'ta değil.
--
-- Round-race negatif kanıtı (iki eşzamanlı session, T1/T2):
--   T1: begin; select flag_group_submit_claim(...,'tr');           -- room satırını FOR UPDATE tutar
--   T2: begin; select flag_group_set_next_round(...,2,'us');       -- FOR UPDATE'te BLOKE (T1 commit'i bekler)
--   T1: commit;   -- 'tr' round=1'e yazıldı
--   T2: (devam) current_flag='us' olur; sonraki 'tr' submit → 'stale'.
-- ============================================================================
