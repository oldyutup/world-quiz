-- ============================================================================
-- Flag Duel — Hızlı Eşleş (Quick Match)
-- ============================================================================
-- Bu migration mevcut tablolara/policy'lere DOKUNMAZ:
--   • duel_rooms tablosunun mevcut kolonları, indeksleri, RLS policy'leri,
--     publication üyeliği, replica identity
--   • duel_players, duel_claims, duel_messages
--   • duel_group_*
--   • wheel_duel_* (tablolar, RPC'ler, queue, publication)
--   • xp_events, profiles
--   • Mevcut DuelGame (country) quick-match akışı (kendi client-side
--     eşleşmesini kullanmaya devam eder)
--   • FlagDuelGame manuel akışı:
--       - createRoom (status='waiting' + lobby)
--       - joinRoom (kod ile)
--       - startGame (host UPDATE 'playing')
--       - pas sistemi (claims tablosu)
--       - golden round (is_golden_round)
--       - rematch (aynı room.id reset)
--       - XP (xp_events, client-side matchIdRef)
--
-- Bu migration YALNIZCA aşağıdaki YENİ nesneleri/değişiklikleri ekler:
--   • duel_rooms.room_source kolonu (default 'manual')
--     + CHECK constraint (manual | quick_match)
--   • public.flag_duel_queue tablosu (per-profile tek aktif arama)
--     + arama indeksi, expires indeksi, replica identity full
--   • RLS: yalnız kendi satırını SELECT (realtime listener için)
--     INSERT/UPDATE/DELETE RPC dışından kapalı (SECURITY DEFINER ile yazılır)
--   • supabase_realtime publication üyeliği (flag_duel_queue)
--   • public.flag_duel_mode_level(uuid) helper (flag_duel mod level hesabı)
--   • public.flag_duel_quick_match(...) RPC
--   • public.flag_duel_cancel_quick_match(...) RPC
--   • GRANT'ler (authenticated only)
--
-- Tüm CREATE'ler "IF NOT EXISTS" / "OR REPLACE" / idempotent guard ile
-- yazılmıştır → migration tekrar çalıştırılırsa hata vermez.
--
-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║  ⚠️ DOĞRULANMASI GEREKEN VARSAYIM                                       ║
-- ╠════════════════════════════════════════════════════════════════════════╣
-- ║  Canlı şemayı okuyamadığım için aşağıdaki varsayımı yapıyorum:          ║
-- ║                                                                          ║
-- ║    xp_events tablosunda şu kolonlar bu isimlerle bulunur:               ║
-- ║      • profile_id  uuid                                                  ║
-- ║      • mode_key    text                                                  ║
-- ║      • xp_earned   integer                                               ║
-- ║                                                                          ║
-- ║  Kolon adı farklıysa (örn. xp / xp_amount) yalnız flag_duel_mode_level  ║
-- ║  fonksiyonundaki SUM(xp_earned) düzeltilmelidir. Tablonun varlığını ve  ║
-- ║  kolonlarını doğrulamak için (Studio SQL editor'de) çalıştır:           ║
-- ║                                                                          ║
-- ║    select column_name, data_type                                        ║
-- ║      from information_schema.columns                                    ║
-- ║     where table_schema = 'public' and table_name = 'xp_events';         ║
-- ║                                                                          ║
-- ║  Bu kontrol GEÇMEDEN migration uygulanmamalı.                            ║
-- ╚════════════════════════════════════════════════════════════════════════╝
--
-- Matchmaking algoritması (özet):
--   1) Caller RPC'yi çağırır (her tick'te, bracket genişleyerek).
--   2) RPC önce kendi satırını "FOR UPDATE SKIP LOCKED" ile aday arar:
--        - aynı region, aynı total_rounds
--        - matched_room_id NULL
--        - expires_at > now()
--        - |caller.level - candidate.level| <= LEAST(caller.bracket,
--                                                    candidate.bracket)
--          (simetri: iki tarafın da kabul ettiği level farkı)
--   3) Eşleşme bulunursa:
--        - duel_rooms INSERT (status='playing', started_at=now()+3s,
--          current_round=1, current_flag=p_first_flag, room_source='quick_match')
--        - iki duel_players INSERT
--        - candidate'ın queue satırını matched_room_id ile günceller (realtime
--          listener bunu yakalar → "SELECT-first fallback" katmanı)
--        - caller'ın queue satırını da matched_room_id ile UPSERT eder
--          (caller'ın bir sonraki tick'inde SELECT-first fallback)
--   4) Eşleşme yoksa caller'ın queue satırını UPSERT eder, ama
--      matched_room_id'yi NULL'a YAZMAZ (paralel RPC çağrıları durumunda
--      eşleşmiş bekleyenin matched_room_id'sini sıfırlamamak için bilinçli
--      defansif yan etki — bu, wheel'deki "SELECT-first fallback" ihtiyacının
--      kaynağıdır).
--   5) Cancel RPC: caller'ın yalnız eşleşmemiş satırını siler.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) duel_rooms.room_source kolonu
-- ----------------------------------------------------------------------------
-- Manuel akışı (default 'manual') ve quick-match odasını ('quick_match')
-- ayırt etmek için. Default değer sayesinde mevcut tüm satırlar 'manual'
-- olur ve mevcut DuelGame/FlagDuelGame manuel akışı bozulmaz.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.duel_rooms
  add column if not exists room_source text not null default 'manual';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname  = 'duel_rooms_room_source_check'
      and conrelid = 'public.duel_rooms'::regclass
  ) then
    execute
      'alter table public.duel_rooms
         add constraint duel_rooms_room_source_check
         check (room_source in (''manual'', ''quick_match''))';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) flag_duel_queue tablosu
-- ----------------------------------------------------------------------------
-- profile_id PRIMARY KEY → kullanıcı başına tek aktif arama. Aynı kullanıcı
-- ikinci sekmede arama başlatırsa UPSERT ile eski satır güncellenir.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.flag_duel_queue (
  profile_id       uuid        primary key,
  player_id        uuid        not null,
  player_name      text        not null,
  total_rounds     int         not null check (total_rounds in (5, 10, 15, 20)),
  region           text        not null,
  mode_level       int         not null default 1 check (mode_level >= 1),
  max_level_diff   int         not null default 0 check (max_level_diff >= 0),
  matched_room_id  uuid        null references public.duel_rooms(id) on delete set null,
  expires_at       timestamptz not null default (now() + interval '45 seconds'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Matchmaking SELECT için kısmi indeks (yalnız bekleyen satırlar):
create index if not exists flag_duel_queue_search_idx
  on public.flag_duel_queue (region, total_rounds, mode_level)
  where matched_room_id is null;

-- TTL/cleanup taramaları için:
create index if not exists flag_duel_queue_expires_idx
  on public.flag_duel_queue (expires_at);

-- Realtime UPDATE event'leri tam satırı taşısın (yalnız değişen kolon değil)
-- → bekleyen tarafın listener'ı matched_room_id alanını her zaman görür.
alter table public.flag_duel_queue replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Row Level Security
-- ----------------------------------------------------------------------------
-- queue tablosuna doğrudan DML erişimini KAPATIYORUZ — tüm yazımlar
-- SECURITY DEFINER RPC üzerinden yapılır (manipülasyon engeli: level/region/
-- matched_room_id taklit edilemesin).
--
-- SELECT yalnız kullanıcının kendi satırına açık → realtime listener
-- filter: profile_id=eq.{me} ile yalnız kendi UPDATE'ini görür.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.flag_duel_queue enable row level security;

-- ── flag_duel_queue policies ───────────────────────────────────────────────
drop policy if exists "flag_duel_queue_select_own"    on public.flag_duel_queue;
drop policy if exists "flag_duel_queue_insert_none"   on public.flag_duel_queue;
drop policy if exists "flag_duel_queue_update_none"   on public.flag_duel_queue;
drop policy if exists "flag_duel_queue_delete_none"   on public.flag_duel_queue;

-- SELECT: yalnız kendi satırı (realtime için gerekli)
create policy "flag_duel_queue_select_own"
  on public.flag_duel_queue
  for select
  to authenticated
  using (profile_id = auth.uid());

-- INSERT/UPDATE/DELETE: anon ve authenticated için KAPALI.
-- SECURITY DEFINER RPC'ler RLS'i bypass eder, doğrudan yazım gerek yok.
-- (Policy yazmıyoruz → RLS aktif tabloda ilgili komut hiç kimseye verilmez.)


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Realtime publication
-- ----------------------------------------------------------------------------
-- "alter publication ... add table" idempotent değil, iki kere çağrıda
-- "relation is already member of publication" hatası verir. Idempotent guard:
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'flag_duel_queue'
  ) then
    execute 'alter publication supabase_realtime add table public.flag_duel_queue';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) Helper: flag_duel mode level hesabı
-- ----------------------------------------------------------------------------
-- Formül progression.ts'deki getLevelFromXp ile birebir aynı:
--   level = floor(sqrt(xp / 100)) + 1
--
-- xp_events'tan flag_duel mod XP toplamı okunur. Eğer kayıt yoksa 0 → level 1.
--
-- ⚠️ VARSAYIM: xp_events.xp_earned kolonu mevcut. Farklıysa düzeltilmeli
--    (bu dosyanın başındaki uyarı kutusuna bakın).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_mode_level(p_profile_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select floor(sqrt(coalesce(sum(xp_earned), 0)::float / 100.0))::int + 1
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = 'flag_duel';
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) RPC: flag_duel_quick_match
-- ----------------------------------------------------------------------------
-- Client tarafı her tick'te (3 sn) bu RPC'yi çağırır.
--   p_profile_id      → auth.uid() ile eşleşmeli (manipülasyon koruması)
--   p_player_id       → bu arama için fresh player UUID (eşleşince
--                       duel_players.id olur)
--   p_player_name     → display name
--   p_total_rounds    → match parametresi (5/10/15/20)
--   p_region          → match parametresi (DB formatı: world / europe /
--                       north_america / ...)
--   p_max_level_diff  → bekleme süresine bağlı bracket (client hesaplar:
--                       <10sn=0, <20sn=2, <30sn=5, <60sn=15, sonra 9999)
--   p_room_code       → eşleşme olursa duel_rooms.code (UNIQUE). Çakışma
--                       riskini düşürmek için client "F"+5char gibi bir
--                       prefix kullansa iyi olur (W country/flag/wheel ortak
--                       chat alanı duel_messages.room_code'ta karışmasın diye)
--   p_first_flag      → eşleşme olursa duel_rooms.current_flag (ülke kodu)
--
-- Dönüş (jsonb):
--   { matched: false, search_age_seconds: int }
--   { matched: true, room_id: uuid, my_player_id: uuid,
--     opponent_name: text | null, search_age_seconds: int }
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_quick_match(
  p_profile_id      uuid,
  p_player_id       uuid,
  p_player_name     text,
  p_total_rounds    int,
  p_region          text,
  p_max_level_diff  int,
  p_room_code       text,
  p_first_flag      text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_level     int;
  v_candidate    record;
  v_room_id      uuid;
  v_now          timestamptz := now();
  v_started_at   timestamptz := v_now + interval '3 seconds';
  v_expires_at   timestamptz := v_now + interval '45 seconds';
  v_existing     record;
begin
  -- ── Auth check ─────────────────────────────────────────────────────────
  if auth.uid() is null then
    raise exception 'flag_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'flag_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  -- ── Parametre kontrolleri ──────────────────────────────────────────────
  if p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'flag_duel_quick_match: invalid total_rounds %', p_total_rounds;
  end if;
  if p_max_level_diff < 0 then
    raise exception 'flag_duel_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if coalesce(p_room_code, '') = '' or coalesce(p_first_flag, '') = '' then
    raise exception 'flag_duel_quick_match: empty room_code or first_flag';
  end if;

  -- ── Caller'ın level'ı ──────────────────────────────────────────────────
  v_my_level := public.flag_duel_mode_level(p_profile_id);

  -- ── Caller'ın mevcut queue satırı (varsa) ──────────────────────────────
  -- Eğer paralel bir RPC bizi zaten eşleştirdiyse direkt o satırı dön.
  -- (SELECT-first fallback'in DB tarafı eşleniği — defensive layer.)
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.flag_duel_queue
   where profile_id = p_profile_id;

  if found and v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  -- ── Uygun aday ara (FOR UPDATE SKIP LOCKED ile race-safe) ──────────────
  select q.profile_id, q.player_id, q.player_name, q.mode_level,
         q.max_level_diff, q.created_at
    into v_candidate
    from public.flag_duel_queue q
   where q.profile_id      <> p_profile_id
     and q.region            = p_region
     and q.total_rounds      = p_total_rounds
     and q.matched_room_id  is null
     and q.expires_at        > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı atomik kur ──────────────────────────────────────
    -- duel_rooms manuel akıştaki alanların hepsini doldurur ama
    -- status='playing' + started_at gelecekte (countdown buffer için)
    -- olduğundan kimse "rakip aranıyor" ekranında takılmaz: iki client da
    -- aynı satırı görür, room_source='quick_match' iken countdown overlay'i
    -- gösterir, started_at vaktinde gameplay açılır.
    insert into public.duel_rooms (
      code,
      status,
      duration_seconds,
      region,
      started_at,
      total_rounds,
      current_round,
      is_golden_round,
      current_flag,
      current_flag_at,
      room_source
    ) values (
      p_room_code,
      'playing',
      60,                 -- FlagDuel manuel akışı da 60 yazıyor; gerçek timer
                          -- current_flag_at + FLAG_TIMEOUT_SEC client-side.
      p_region,
      v_started_at,
      p_total_rounds,
      1,
      false,
      p_first_flag,
      v_started_at,       -- bayrak timer'ı started_at ile başlasın
      'quick_match'
    )
    returning id into v_room_id;

    -- Önce candidate (bekleyen) → host = players[0] olur (FlagDuelGame'in
    -- isHost = players[0]?.id mantığıyla simetrik kalmak için bekleyen host).
    -- Not: FlagDuelGame'de host = players[0] referansı yalnız "👑" rozeti ve
    -- start butonu içindi; quick-match'te oda zaten 'playing'de başlıyor,
    -- yani host kavramı sadece advanceRoundAsHost rolü için gerekli.
    -- isHostRef.current iki client'ta da kendi tarafından set ediliyor;
    -- DB tarafında host_player_id kolonu YOK (duel_rooms şeması).
    insert into public.duel_players (id, room_id, name, score)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, 0);

    insert into public.duel_players (id, room_id, name, score)
      values (p_player_id, v_room_id, p_player_name, 0);

    -- Candidate'ın queue satırını matched_room_id ile işaretle
    -- → bekleyen tarafın realtime listener'ı UPDATE'i yakalar.
    update public.flag_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    -- Caller'ın queue satırını da işaretle (caller'ın SELECT-first
    -- fallback'i bir sonraki tick'te bunu görür → ekstra güvenlik ağı).
    insert into public.flag_duel_queue as q (
      profile_id, player_id, player_name,
      total_rounds, region, mode_level, max_level_diff,
      matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, p_player_name,
      p_total_rounds, p_region, v_my_level, p_max_level_diff,
      v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id       = excluded.player_id,
          player_name     = excluded.player_name,
          total_rounds    = excluded.total_rounds,
          region          = excluded.region,
          mode_level      = excluded.mode_level,
          max_level_diff  = excluded.max_level_diff,
          matched_room_id = excluded.matched_room_id,
          expires_at      = excluded.expires_at,
          updated_at      = excluded.updated_at;

    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_room_id,
      'my_player_id',       p_player_id,
      'opponent_name',      v_candidate.player_name,
      'search_age_seconds', 0
    );
  end if;

  -- ── EŞLEŞME YOK — caller'ın queue satırını UPSERT ──────────────────────
  -- DİKKAT: matched_room_id'yi yalnız NULL ise güncelliyoruz. Paralel bir
  -- RPC bizi az önce eşleştirip matched_room_id'yi set ettiyse,
  -- aşağıdaki UPDATE onu NULL'a sıfırlamamalı (yarış koruması).
  insert into public.flag_duel_queue as q (
    profile_id, player_id, player_name,
    total_rounds, region, mode_level, max_level_diff,
    matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, p_player_name,
    p_total_rounds, p_region, v_my_level, p_max_level_diff,
    null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id      = excluded.player_id,
        player_name    = excluded.player_name,
        total_rounds   = excluded.total_rounds,
        region         = excluded.region,
        mode_level     = excluded.mode_level,
        max_level_diff = excluded.max_level_diff,
        expires_at     = excluded.expires_at,
        updated_at     = excluded.updated_at
        -- matched_room_id BİLİNÇLİ olarak güncellenmiyor.
    where q.matched_room_id is null;

  -- UPSERT sonrası tekrar oku → arada matched olduysa direkt dön
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.flag_duel_queue
   where profile_id = p_profile_id;

  if v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  return jsonb_build_object(
    'matched',            false,
    'search_age_seconds', greatest(0, extract(epoch from (v_now - coalesce(v_existing.created_at, v_now)))::int)
  );
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) RPC: flag_duel_cancel_quick_match
-- ----------------------------------------------------------------------------
-- Yalnız eşleşmemiş satırı siler. Eşleşmiş satırı silmiyoruz çünkü client
-- zaten joinQuickMatchRoom akışına geçti; satır TTL ile temizlenecek (veya
-- ileride periyodik cleanup eklenebilir).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_duel_cancel_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'flag_duel_cancel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'flag_duel_cancel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  delete from public.flag_duel_queue
   where profile_id      = p_profile_id
     and matched_room_id is null;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) GRANT'ler
-- ----------------------------------------------------------------------------
-- RPC'lere yalnız authenticated execute hakkı. Anon hızlı eşleş kullanamaz.
-- Queue tablosu için yalnız SELECT (realtime için), INSERT/UPDATE/DELETE
-- RPC dışından yapılamaz (RLS politikası da yok).
-- ────────────────────────────────────────────────────────────────────────────

revoke all on function public.flag_duel_mode_level(uuid) from public;
revoke all on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) from public;
revoke all on function public.flag_duel_cancel_quick_match(uuid) from public;

grant execute on function public.flag_duel_mode_level(uuid)                                              to authenticated;
grant execute on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text)     to authenticated;
grant execute on function public.flag_duel_cancel_quick_match(uuid)                                      to authenticated;

grant select on public.flag_duel_queue to authenticated;
-- INSERT/UPDATE/DELETE bilinçli olarak verilmedi.


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (manuel çalıştırılabilir):
--
--   -- xp_events kolonu kontrolü (migration öncesi şart):
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'xp_events';
--
--   -- yeni kolon
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'duel_rooms'
--      and column_name = 'room_source';
--
--   -- yeni tablo
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'flag_duel_queue'
--    order by ordinal_position;
--
--   -- politikalar
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'flag_duel_queue';
--
--   -- publication
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename = 'flag_duel_queue';
--
--   -- RPC'ler
--   select proname, pg_get_function_arguments(oid) as args
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('flag_duel_mode_level',
--                      'flag_duel_quick_match',
--                      'flag_duel_cancel_quick_match');
--
-- Smoke testi (Studio'da iki authenticated user ile, "set role" yapamayız;
-- önce A user'ın JWT'siyle, sonra B user'ın JWT'siyle yapılmalı):
--
--   -- A user (matched=false bekleniyor):
--   select flag_duel_quick_match(
--     '<A profile uuid>'::uuid, gen_random_uuid(), 'A',
--     10, 'world', 0, 'FQTST1', 'tr'
--   );
--
--   -- B user (matched=true bekleniyor; aynı total_rounds + aynı region):
--   select flag_duel_quick_match(
--     '<B profile uuid>'::uuid, gen_random_uuid(), 'B',
--     10, 'world', 0, 'FQTST2', 'tr'
--   );
--
--   -- A user'ın queue satırı şimdi matched_room_id dolu olmalı:
--   select profile_id, matched_room_id
--     from flag_duel_queue
--    where profile_id = '<A profile uuid>'::uuid;
--
--   -- Oluşan oda:
--   select id, code, status, room_source, started_at, current_flag,
--          current_round, total_rounds, is_golden_round, region
--     from duel_rooms
--    where room_source = 'quick_match'
--    order by created_at desc
--    limit 5;
--
-- Temizlik (test sonrası):
--   delete from duel_players where room_id in (select id from duel_rooms where room_source = 'quick_match');
--   delete from duel_rooms   where room_source = 'quick_match';
--   delete from flag_duel_queue where profile_id in ('<A>','<B>');
-- ============================================================================
