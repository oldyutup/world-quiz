-- ============================================================================
-- Country Duel (Ülke Yazmaca) — Hızlı Eşleş (Quick Match) — PR-1 backend
-- ============================================================================
-- Bu migration Bayrak/Çark hızlı eşleş desenini Ülke Yazmaca 1v1 (DuelGame.tsx)
-- için tekrarlar. Sebep: mevcut DuelGame quickMatch akışı tamamen client-side
-- SELECT polling kullanıyor; seviye-bracket eşleşmesi, bekleme süresi göstergesi,
-- 3 sn countdown buffer ve room_source ayrımı yok. PR-2 frontend bu RPC'lere
-- geçecek.
--
-- DOKUNMAZ:
--   • duel_rooms tablosu kolonları/indeksleri/RLS politikaları/publication
--     üyeliği. room_source kolonu 20260516130000_flag_duel_quick_match.sql
--     tarafından default 'manual' + check ('manual' | 'quick_match') ile
--     eklenmişti — yalnız okur ve 'quick_match' yazar.
--   • duel_players / duel_player_claims / duel_claims / duel_messages
--   • duel_group_*, wheel_duel_*, wheel_group_*, conquest_* tabloları/RPC'leri
--   • flag_duel_queue + flag_duel_quick_match / cancel / reset / mode_level
--   • wheel_duel_queue + wheel_duel_quick_match / cancel
--   • xp_events, profiles, leaderboard RPC'leri (yalnız SUM(xp_earned) okur)
--   • Mevcut DuelGame manuel akışı (duel_create_room, duel_join_room,
--     duel_start_game, duel_leave_room, duel_handle_disconnect) — değişmez.
--   • Mevcut DuelGame client-side quickMatch akışı (PR-2'de değişene kadar
--     çalışmaya devam eder; yeni RPC'lere geçişe kadar paralel yaşar).
--
-- YENİ NESNELER:
--   • public.country_duel_queue tablosu (per-profile tek aktif arama)
--     + arama indeksi, expires indeksi, replica identity full
--   • RLS: yalnız kendi satırını SELECT (realtime listener için)
--     INSERT/UPDATE/DELETE RPC dışından kapalı (SECURITY DEFINER ile yazılır)
--   • GRANT lockdown (anon=hiç, authenticated=yalnız SELECT)
--   • supabase_realtime publication üyeliği (country_duel_queue)
--   • public.country_duel_mode_level(uuid) helper
--   • public.country_duel_quick_match(...) RPC
--   • public.country_duel_cancel_quick_match(uuid) RPC
--   • public.country_duel_reset_quick_match(uuid) RPC
--   • GRANT'ler (authenticated only — giriş zorunlu)
--
-- Matchmaking algoritması (Bayrak ile birebir, total_rounds yerine
-- duration_seconds):
--   1) Caller RPC'yi her tick'te çağırır (3 sn aralık, bracket genişleyerek).
--   2) Stale-row self-heal: kendi queue satırının matched_room_id'si artık
--      'playing' ve 60sn'den taze değilse NULL'a çekilir (önceki tamamlanmış
--      bir maça yapışmasın).
--   3) FOR UPDATE SKIP LOCKED ile aday arar: aynı region + aynı duration_seconds,
--      matched_room_id NULL, expires_at > now(),
--      abs(my_level - cand_level) <= LEAST(my_bracket, cand_bracket).
--   4) Eşleşme bulursa:
--      - duel_rooms INSERT (status='playing', started_at=now()+3s,
--        room_source='quick_match', host_player_id=waiter, duration_seconds,
--        region, code)
--      - iki duel_players INSERT (id, room_id, name, score=0)
--      - bekleyen queue satırını matched_room_id ile UPDATE eder
--      - caller'ın queue satırını matched_room_id ile UPSERT eder
--   5) Eşleşme yoksa caller'ın queue satırını UPSERT eder, matched_room_id'yi
--      yalnız NULL ise dokunur (paralel eşleşmiş satırı sıfırlama yarışı).
--   6) Cancel: yalnız eşleşmemiş satırı siler (in-flight akışı bozmasın).
--   7) Reset: caller'ın satırını koşulsuz siler (yeni aramaya temiz başlama).
--
-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║  ⚠️ VARSAYIM: xp_events tablosu profile_id / mode_key / xp_earned       ║
-- ║  kolonlarına sahip. Bayrak/Çark mode_level helper'ları aynı varsayımla  ║
-- ║  prod'da çalışıyor; uyarı yalnız hatırlatma amaçlı.                     ║
-- ║                                                                          ║
-- ║    select column_name, data_type                                        ║
-- ║      from information_schema.columns                                    ║
-- ║     where table_schema = 'public' and table_name = 'xp_events';         ║
-- ╚════════════════════════════════════════════════════════════════════════╝
--
-- Tüm CREATE'ler IF NOT EXISTS / OR REPLACE / idempotent guard ile yazılmıştır.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) country_duel_queue tablosu
-- ----------------------------------------------------------------------------
-- profile_id PRIMARY KEY → kullanıcı başına tek aktif arama. Aynı kullanıcı
-- ikinci sekmede arama başlatırsa UPSERT ile eski satır güncellenir.
-- duration_seconds DuelGame'in DURATION_OPTS değerlerinden (30/60/120/180/300)
-- biri olmalı; CHECK constraint UI ile simetrik.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.country_duel_queue (
  profile_id       uuid        primary key,
  player_id        uuid        not null,
  player_name      text        not null,
  duration_seconds int         not null check (duration_seconds in (30, 60, 120, 180, 300)),
  region           text        not null,
  mode_level       int         not null default 1 check (mode_level >= 1),
  max_level_diff   int         not null default 0 check (max_level_diff >= 0),
  matched_room_id  uuid        null references public.duel_rooms(id) on delete set null,
  expires_at       timestamptz not null default (now() + interval '45 seconds'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Matchmaking SELECT için kısmi indeks (yalnız bekleyen satırlar):
create index if not exists country_duel_queue_search_idx
  on public.country_duel_queue (region, duration_seconds, mode_level)
  where matched_room_id is null;

-- TTL/cleanup taramaları için:
create index if not exists country_duel_queue_expires_idx
  on public.country_duel_queue (expires_at);

-- Realtime UPDATE event'leri tam satırı taşısın (yalnız değişen kolon değil)
-- → bekleyen tarafın listener'ı matched_room_id alanını her zaman görür.
alter table public.country_duel_queue replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Row Level Security
-- ----------------------------------------------------------------------------
-- Tüm yazımlar SECURITY DEFINER RPC üzerinden. SELECT yalnız kullanıcının
-- kendi satırına açık → realtime listener filter: profile_id=eq.{me}.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.country_duel_queue enable row level security;

drop policy if exists "country_duel_queue_select_own"    on public.country_duel_queue;
drop policy if exists "country_duel_queue_insert_none"   on public.country_duel_queue;
drop policy if exists "country_duel_queue_update_none"   on public.country_duel_queue;
drop policy if exists "country_duel_queue_delete_none"   on public.country_duel_queue;

create policy "country_duel_queue_select_own"
  on public.country_duel_queue
  for select
  to authenticated
  using (profile_id = auth.uid());

-- INSERT/UPDATE/DELETE policy YOK → SECURITY DEFINER RPC'ler RLS bypass eder,
-- doğrudan PostgREST yazımı her role için default-deny ile kapalı.


-- ────────────────────────────────────────────────────────────────────────────
-- 3) GRANT lockdown (Bayrak deseni — defense-in-depth)
-- ----------------------------------------------------------------------------
-- Supabase yeni tablolarda anon+authenticated rolüne otomatik DML grant verir;
-- RLS arkasında zarar vermez ama temiz görünüm + RLS bug toleransı için
-- temizliyoruz. SECURITY DEFINER RPC'ler RPC owner rolüyle çalıştığından
-- queue tablosuna yazmaya devam eder.
-- ────────────────────────────────────────────────────────────────────────────

revoke all on table public.country_duel_queue from anon;

revoke all on table public.country_duel_queue from authenticated;
grant  select on table public.country_duel_queue to   authenticated;

revoke all on table public.country_duel_queue from public;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Realtime publication
-- ----------------------------------------------------------------------------
-- "alter publication ... add table" idempotent değil; guard ile.
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'country_duel_queue'
  ) then
    execute 'alter publication supabase_realtime add table public.country_duel_queue';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) Helper: country_duel mode level hesabı
-- ----------------------------------------------------------------------------
-- Formül progression.ts'deki getLevelFromXp ile birebir aynı:
--   level = floor(sqrt(xp / 100)) + 1
--
-- xp_events.mode_key = 'country_duel' satırlarının xp_earned toplamı.
-- Kayıt yoksa coalesce(sum, 0) → level 1.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.country_duel_mode_level(p_profile_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select floor(sqrt(coalesce(sum(xp_earned), 0)::float / 100.0))::int + 1
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = 'country_duel';
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) RPC: country_duel_quick_match
-- ----------------------------------------------------------------------------
-- Client tarafı her tick'te (3 sn) bu RPC'yi çağırır.
--   p_profile_id      → auth.uid() ile eşleşmeli (manipülasyon koruması)
--   p_player_id       → bu arama için fresh player UUID (eşleşince
--                       duel_players.id olur)
--   p_player_name     → display name (btrim'lenip yazılır)
--   p_duration        → match parametresi (30/60/120/180/300 saniye)
--   p_region          → match parametresi (DB formatı: world / europe /
--                       north_america / south_america / asia / africa / oceania)
--   p_max_level_diff  → bekleme süresine bağlı bracket (client hesaplar:
--                       <10sn=0, <20sn=2, <30sn=5, <60sn=15, sonra 9999)
--   p_room_code       → eşleşme olursa duel_rooms.code (UNIQUE).
--
-- Dönüş (jsonb):
--   { matched: false, search_age_seconds: int }
--   { matched: true, room_id: uuid, my_player_id: uuid,
--     opponent_name: text | null, search_age_seconds: int }
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.country_duel_quick_match(
  p_profile_id      uuid,
  p_player_id       uuid,
  p_player_name     text,
  p_duration        int,
  p_region          text,
  p_max_level_diff  int,
  p_room_code       text
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
    raise exception 'country_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'country_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  -- ── Parametre kontrolleri ──────────────────────────────────────────────
  -- NOT: SQL'de `NULL not in (...)` ve `NULL < 0` ifadeleri NULL döner
  -- (false-ish), yani if bloğuna girmezler. Açık NULL guard'ları olmadan
  -- NULL parametre sessizce geçer ve sonraki insert/check'lerde daha az
  -- okunabilir hata verir → öne NULL kontrolleri eklendi.
  if p_duration is null then
    raise exception 'country_duel_quick_match: duration_required';
  end if;
  if p_duration not in (30, 60, 120, 180, 300) then
    raise exception 'country_duel_quick_match: invalid duration %', p_duration;
  end if;
  if p_max_level_diff is null then
    raise exception 'country_duel_quick_match: max_level_diff_required';
  end if;
  if p_max_level_diff < 0 then
    raise exception 'country_duel_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if coalesce(p_room_code, '') = '' then
    raise exception 'country_duel_quick_match: empty room_code';
  end if;
  if coalesce(btrim(p_player_name), '') = '' then
    raise exception 'country_duel_quick_match: empty player_name';
  end if;
  if p_player_id is null then
    raise exception 'country_duel_quick_match: player_id_required';
  end if;
  if coalesce(btrim(p_region), '') = '' then
    raise exception 'country_duel_quick_match: empty region';
  end if;

  -- ── Caller'ın level'ı ──────────────────────────────────────────────────
  v_my_level := public.country_duel_mode_level(p_profile_id);

  -- ── Stale-row self-heal ────────────────────────────────────────────────
  -- Caller'ın queue satırı önceki tamamlanmış bir maça yapışmış olabilir
  -- (cancel RPC matched_room_id'yi siliyor değil, korumalı tutuyor). Eğer
  -- referans verdiği oda artık 'playing' değil veya 60sn'den eski ise
  -- matched_room_id'yi NULL'a çekiyoruz → bu RPC çağrısı normal aday
  -- aramaya devam edebilsin.
  update public.country_duel_queue q
     set matched_room_id = null,
         updated_at      = v_now
   where q.profile_id      = p_profile_id
     and q.matched_room_id is not null
     and not exists (
       select 1
         from public.duel_rooms r
        where r.id = q.matched_room_id
          and r.status = 'playing'
          and r.created_at > v_now - interval '60 seconds'
     );

  -- ── Mevcut queue satırı: paralel RPC bizi zaten eşleştirmiş mi? ────────
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.country_duel_queue
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
    from public.country_duel_queue q
   where q.profile_id      <> p_profile_id
     and q.region            = p_region
     and q.duration_seconds  = p_duration
     and q.matched_room_id  is null
     and q.expires_at        > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı atomik kur ──────────────────────────────────────
    -- host_player_id = candidate (waiter). duel_authorize_host manuel branch'i
    -- bu kolon üzerinden çalışır → joined_at tie-break belirsizliği olmaz.
    -- Client tarafında isHost = (host_player_id === myId) deterministik.
    insert into public.duel_rooms (
      code,
      status,
      duration_seconds,
      region,
      started_at,
      room_source,
      host_player_id
    ) values (
      p_room_code,
      'playing',
      p_duration,
      p_region,
      v_started_at,
      'quick_match',
      v_candidate.player_id
    )
    returning id into v_room_id;

    -- İki duel_players satırı (host_player_id'si candidate, ikisi de score=0).
    --
    -- profile_id KRİTİK: duel_authorize_player helper'ı
    -- (duel_rls_hardening_m1.sql) iki yoldan auth yapar:
    --   (a) p.profile_id = auth.uid()      → login user
    --   (b) duel_player_claims.claim_token → guest
    -- Bu RPC giriş zorunlu (auth.uid() check yukarıda) ve duel_player_claims
    -- kaydı atmıyor → (a) yolu tek auth kanalı. profile_id bu satıra
    -- yazılmazsa mevcut DuelGame RPC'leri (duel_submit_claim, duel_leave_room,
    -- duel_handle_disconnect, ...) QM odasında yetki reddiyle düşer ve maç
    -- oynanamaz. v_candidate.profile_id queue PK'sından, p_profile_id ise
    -- auth.uid() eşleşmiş parametreden gelir.
    --
    -- guest_id null bırakılır (giriş zorunlu); claim_token (duel_player_claims)
    -- de yazılmaz: profile_id branch'i auth için yeterli.
    -- last_seen_at v_now ile başlar; client heartbeat'i sonraki tick'lerde tazeler.
    insert into public.duel_players (id, room_id, name, score, profile_id, last_seen_at)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, 0,
              v_candidate.profile_id, v_now);

    insert into public.duel_players (id, room_id, name, score, profile_id, last_seen_at)
      values (p_player_id, v_room_id, btrim(p_player_name), 0,
              p_profile_id, v_now);

    -- Candidate'ın queue satırını matched_room_id ile işaretle
    -- → bekleyen tarafın realtime listener'ı UPDATE'i yakalar.
    update public.country_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    -- Caller'ın queue satırını da işaretle (caller'ın SELECT-first
    -- fallback'i bir sonraki tick'te bunu görür → ekstra güvenlik ağı).
    insert into public.country_duel_queue as q (
      profile_id, player_id, player_name,
      duration_seconds, region, mode_level, max_level_diff,
      matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, btrim(p_player_name),
      p_duration, p_region, v_my_level, p_max_level_diff,
      v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id        = excluded.player_id,
          player_name      = excluded.player_name,
          duration_seconds = excluded.duration_seconds,
          region           = excluded.region,
          mode_level       = excluded.mode_level,
          max_level_diff   = excluded.max_level_diff,
          matched_room_id  = excluded.matched_room_id,
          expires_at       = excluded.expires_at,
          updated_at       = excluded.updated_at;

    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_room_id,
      'my_player_id',       p_player_id,
      'opponent_name',      v_candidate.player_name,
      'search_age_seconds', 0
    );
  end if;

  -- ── EŞLEŞME YOK — caller'ın queue satırını UPSERT ──────────────────────
  -- matched_room_id'yi yalnız NULL ise güncelliyoruz. Paralel bir RPC bizi
  -- az önce eşleştirip matched_room_id'yi set ettiyse, aşağıdaki UPDATE
  -- onu NULL'a sıfırlamamalı (yarış koruması).
  insert into public.country_duel_queue as q (
    profile_id, player_id, player_name,
    duration_seconds, region, mode_level, max_level_diff,
    matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, btrim(p_player_name),
    p_duration, p_region, v_my_level, p_max_level_diff,
    null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id        = excluded.player_id,
        player_name      = excluded.player_name,
        duration_seconds = excluded.duration_seconds,
        region           = excluded.region,
        mode_level       = excluded.mode_level,
        max_level_diff   = excluded.max_level_diff,
        expires_at       = excluded.expires_at,
        updated_at       = excluded.updated_at
    where q.matched_room_id is null;

  -- UPSERT sonrası tekrar oku → arada matched olduysa direkt dön
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.country_duel_queue
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
-- 7) RPC: country_duel_cancel_quick_match
-- ----------------------------------------------------------------------------
-- Yalnız eşleşmemiş satırı siler. Eşleşmiş satırı silmiyoruz çünkü client
-- zaten joinQuickMatchRoom akışına geçti; satır TTL ile temizlenecek.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.country_duel_cancel_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'country_duel_cancel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'country_duel_cancel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  delete from public.country_duel_queue
   where profile_id      = p_profile_id
     and matched_room_id is null;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) RPC: country_duel_reset_quick_match
-- ----------------------------------------------------------------------------
-- Bayrak'taki flag_duel_reset_quick_match karşılığı. Client yeni aramaya
-- başlamadan önce çağırır; caller'ın satırını koşulsuz siler. Cancel RPC
-- yalnız unmatched satırları siliyor → önceki bitmiş maçtan kalan matched
-- satırı temizlemek için bu RPC gerekli.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.country_duel_reset_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'country_duel_reset_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'country_duel_reset_quick_match: auth.uid() does not match p_profile_id';
  end if;

  delete from public.country_duel_queue
   where profile_id = p_profile_id;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) GRANT'ler
-- ----------------------------------------------------------------------------
-- RPC'lere yalnız authenticated execute hakkı. Anon hızlı eşleş kullanamaz
-- (giriş zorunlu). Queue tablosunun SELECT'i yukarıda authenticated'e verildi.
-- ────────────────────────────────────────────────────────────────────────────

revoke all on function public.country_duel_mode_level(uuid)                                       from public;
revoke all on function public.country_duel_quick_match(uuid, uuid, text, int, text, int, text)    from public;
revoke all on function public.country_duel_cancel_quick_match(uuid)                               from public;
revoke all on function public.country_duel_reset_quick_match(uuid)                                from public;

grant execute on function public.country_duel_mode_level(uuid)                                    to authenticated;
grant execute on function public.country_duel_quick_match(uuid, uuid, text, int, text, int, text) to authenticated;
grant execute on function public.country_duel_cancel_quick_match(uuid)                            to authenticated;
grant execute on function public.country_duel_reset_quick_match(uuid)                             to authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Doğrulama sorguları (Studio SQL editor):
--
--   -- xp_events kolonları (mode_level helper varsayımı):
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'xp_events';
--
--   -- Yeni tablo şeması:
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'country_duel_queue'
--    order by ordinal_position;
--
--   -- İndeksler:
--   select indexname, indexdef from pg_indexes
--    where schemaname = 'public' and tablename = 'country_duel_queue';
--
--   -- Politikalar:
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'country_duel_queue';
--
--   -- Publication üyeliği:
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename = 'country_duel_queue';
--
--   -- RPC imzaları:
--   select proname, pg_get_function_arguments(oid) as args
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('country_duel_mode_level',
--                      'country_duel_quick_match',
--                      'country_duel_cancel_quick_match',
--                      'country_duel_reset_quick_match');
--
--   -- Tablo grantleri (beklenen: yalnız authenticated, SELECT):
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name   = 'country_duel_queue'
--      and grantee in ('anon', 'authenticated', 'PUBLIC')
--    order by grantee, privilege_type;
--
-- Smoke testi (Studio'da iki authenticated user'ın JWT'si ile sırayla):
--
--   -- A user (matched=false bekleniyor):
--   select country_duel_quick_match(
--     '<A profile uuid>'::uuid, gen_random_uuid(), 'A',
--     60, 'world', 0, 'CQTST1'
--   );
--
--   -- B user (matched=true bekleniyor; aynı duration + aynı region):
--   select country_duel_quick_match(
--     '<B profile uuid>'::uuid, gen_random_uuid(), 'B',
--     60, 'world', 0, 'CQTST2'
--   );
--
--   -- A user'ın queue satırı şimdi matched_room_id dolu olmalı:
--   select profile_id, matched_room_id
--     from country_duel_queue
--    where profile_id = '<A profile uuid>'::uuid;
--
--   -- Oluşan oda:
--   select id, code, status, room_source, started_at, duration_seconds,
--          region, host_player_id, created_at
--     from duel_rooms
--    where room_source = 'quick_match'
--    order by created_at desc
--    limit 5;
--
--   -- Oluşan iki player:
--   select id, room_id, name, score
--     from duel_players
--    where room_id = '<room_id yukarıdan>'::uuid
--    order by joined_at;
--
-- Reset/Cancel testleri:
--
--   -- Reset (her zaman siler):
--   select country_duel_reset_quick_match('<A profile uuid>'::uuid);
--
--   -- Cancel (yalnız unmatched siler):
--   select country_duel_cancel_quick_match('<A profile uuid>'::uuid);
--
-- Temizlik (test sonrası):
--   delete from duel_players where room_id in (select id from duel_rooms where room_source = 'quick_match');
--   delete from duel_rooms   where room_source = 'quick_match';
--   delete from country_duel_queue where profile_id in ('<A>','<B>');
-- ============================================================================
