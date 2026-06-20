-- ============================================================================
-- Kuşatma (Conquest) — Hızlı Eşleş (Quick Match) — K-A 1v1 backend
-- ============================================================================
-- Bu migration, mevcut düello hızlı-eşleş desenini (country/flag/wheel) Kuşatma
-- 1v1 için tekrarlar. Kuşatma'nın bugüne dek HİÇBİR matchmaking altyapısı yoktu
-- (yalnız oda-kur / kodla-katıl / public liste). Bu dosya server-otoriter,
-- atomik, çift-eşleşmeye kapalı bir 1v1 quick-match girişi ekler.
--
-- TASARIM — mevcut canonical Kuşatma mekanizmasını kullanır, UYDURMAZ:
--   • Oda/oyuncu şeması: conquest_rooms + conquest_players (init migration).
--   • Oyun başlatma + ilk gameplay_state: client-otoriter kalır. RPC ODAYI
--     status='waiting' kurar; eşleşen "host" istemci mevcut
--     createInitialConquestGameState + initializeConquestGameplayState yolunu
--     OTOMATİK çağırır (kullanıcı butona basmadan). Karşı taraf realtime
--     status='playing' güncellemesiyle oyuna geçer. RPC SQL'de oyun durumu
--     HESAPLAMAZ — bu mantık tamamen client'ta, mevcut haliyle yaşar.
--   • Host kimliği: host_profile_id = waiter.profile_id → host istemcinin
--     conquest_rooms UPDATE'i (RLS: host_profile_id = auth.uid()) çalışır.
--   • İki oyuncu da login (giriş zorunlu) → profile_id dolu → in-game
--     conquest_apply_gameplay_state, conquest_authorize_player'ın profile_id
--     dalıyla yetkilenir; claim_token satırı GEREKMEZ (LEFT JOIN).
--
-- DOKUNMAZ:
--   • conquest_rooms / conquest_players satırları, RLS politikaları, trigger,
--     realtime publication üyelikleri (yalnız round_count CHECK gevşetilir —
--     aşağıda).
--   • conquest_register_player / conquest_authorize_* / conquest_leave_room /
--     conquest_apply_gameplay_state / conquest_update_player_color RPC'leri.
--   • Düello/çark/grup/kornokta tabloları + RPC'leri.
--   • xp_events, profiles (yalnız SUM(xp_earned) okunur).
--   • Mevcut oda-kur/kodla-katıl/public liste akışı.
--
-- TEK MEVCUT-NESNE DEĞİŞİKLİĞİ (K-A için gerekli):
--   • conquest_rooms.round_count CHECK'i (4,6,8) → (4,6,8,10) süperküme olarak
--     gevşetilir. Sebep: frontend ConquestRoundCount = 6|8|10 ve quick-match
--     Tur seçenekleri 6/8/10. Eski check 10'u reddediyordu (manuel 10-turlu oda
--     kurma da bu yüzden sessizce kırıktı). Süperküme → mevcut 4/6/8 satırlar
--     geçerli kalır, yalnız 10 eklenir. Gameplay kuralı değişmez.
--
-- YENİ NESNELER:
--   • public.conquest_quick_match_queue tablosu (+ indeksler, replica full)
--   • RLS: yalnız kendi satırını SELECT; INSERT/UPDATE/DELETE RPC dışından kapalı
--   • GRANT lockdown (anon=hiç, authenticated=yalnız SELECT)
--   • supabase_realtime publication üyeliği
--   • public.conquest_quick_match_mode_level(uuid) helper (mode_key='conquest')
--   • public.conquest_quick_match(...) RPC
--   • public.conquest_cancel_quick_match(uuid) RPC
--   • public.conquest_reset_quick_match(uuid) RPC
--
-- Türkiye-only kuralı: RPC p_map_id <> 'turkey' ise hata verir → queue ve oda
-- HER ZAMAN 'turkey' ile kurulur, client ne gönderirse göndersin.
--
-- Tüm CREATE'ler IF NOT EXISTS / OR REPLACE / idempotent guard ile yazılmıştır.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0) Mevcut round_count CHECK'ini gevşet (4,6,8) → (4,6,8,10)
-- ----------------------------------------------------------------------------
-- DAYANIKLI: constraint adının 'conquest_rooms_round_count_check' olduğunu
-- VARSAYMAZ. Inline kolon-check'i bu adla üretilir ama canlıda farklı
-- adlandırılmış olabilir; ada güvenip yanlış drop edersek eski (4,6,8) check
-- kalır ve round_count=10 reddedilmeye devam eder. Bunun yerine round_count'a
-- DEĞEN her CHECK constraint'i ad-bağımsız bulup düşürürüz; round_count dışı
-- check'lere (max_players, team_mode, status, visibility) DOKUNULMAZ. Sonra
-- genişletilmiş check'i kanonik adla ekleriz. Veri silme / tablo rewrite YOK
-- (CHECK eklemek yalnız tarama yapar; mevcut satırlar 4/6/8 → hepsi geçerli).
do $$
declare
  v_con text;
begin
  for v_con in
    select conname
      from pg_constraint
     where conrelid = 'public.conquest_rooms'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ilike '%round_count%'
  loop
    execute format('alter table public.conquest_rooms drop constraint %I', v_con);
  end loop;

  -- Tekrar-çalıştırma güvenliği: kanonik addaki olası eski kalıntıyı da düşür,
  -- sonra genişletilmiş check'i ekle.
  alter table public.conquest_rooms
    drop constraint if exists conquest_rooms_round_count_check;
  alter table public.conquest_rooms
    add  constraint conquest_rooms_round_count_check
         check (round_count in (4, 6, 8, 10));
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) conquest_quick_match_queue tablosu
-- ----------------------------------------------------------------------------
-- profile_id PRIMARY KEY → kullanıcı başına tek aktif arama. Eşleşme boyutu:
-- aynı map_id + aynı round_count. mode_level + max_level_diff seviye-bracket
-- eşleşmesi için (düello deseniyle birebir).
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.conquest_quick_match_queue (
  profile_id       uuid        primary key,
  player_id        uuid        not null,
  player_name      text        not null,
  round_count      int         not null check (round_count in (6, 8, 10)),
  map_id           text        not null,
  mode_level       int         not null default 1 check (mode_level >= 1),
  max_level_diff   int         not null default 0 check (max_level_diff >= 0),
  matched_room_id  uuid        null references public.conquest_rooms(id) on delete set null,
  expires_at       timestamptz not null default (now() + interval '45 seconds'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists conquest_quick_match_queue_search_idx
  on public.conquest_quick_match_queue (map_id, round_count, mode_level)
  where matched_room_id is null;

create index if not exists conquest_quick_match_queue_expires_idx
  on public.conquest_quick_match_queue (expires_at);

alter table public.conquest_quick_match_queue replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Row Level Security — yalnız kendi satırını SELECT, yazımlar definer RPC'den
-- ────────────────────────────────────────────────────────────────────────────

alter table public.conquest_quick_match_queue enable row level security;

drop policy if exists "conquest_quick_match_queue_select_own" on public.conquest_quick_match_queue;

create policy "conquest_quick_match_queue_select_own"
  on public.conquest_quick_match_queue
  for select
  to authenticated
  using (profile_id = auth.uid());


-- ────────────────────────────────────────────────────────────────────────────
-- 3) GRANT lockdown (düello deseni — defense-in-depth)
-- ────────────────────────────────────────────────────────────────────────────

revoke all on table public.conquest_quick_match_queue from anon;
revoke all on table public.conquest_quick_match_queue from authenticated;
grant  select on table public.conquest_quick_match_queue to   authenticated;
revoke all on table public.conquest_quick_match_queue from public;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Realtime publication
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'conquest_quick_match_queue'
  ) then
    execute 'alter publication supabase_realtime add table public.conquest_quick_match_queue';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) Helper: conquest mode level (mode_key='conquest', düello formülüyle aynı)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_quick_match_mode_level(p_profile_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select floor(sqrt(coalesce(sum(xp_earned), 0)::float / 100.0))::int + 1
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = 'conquest';
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) RPC: conquest_quick_match
-- ----------------------------------------------------------------------------
-- Client her tick'te (3 sn) çağırır.
--   p_profile_id     → auth.uid() ile eşleşmeli
--   p_player_id      → bu arama için fresh UUID (eşleşince conquest_players.id)
--   p_player_name    → display name
--   p_round_count    → 6 | 8 | 10
--   p_map_id         → yalnız 'turkey' (aksi hata)
--   p_max_level_diff → bekleme süresine bağlı bracket (client hesaplar)
--
-- Dönüş (jsonb):
--   { matched:false, search_age_seconds }
--   { matched:true, room_id, my_player_id, host_player_id, opponent_name,
--     search_age_seconds }
-- "host" = host_player_id'si bu satıra ait olan istemci (waiter). Client
-- room.host_player_id === myPlayerId ise oyunu otomatik başlatır.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_quick_match(
  p_profile_id     uuid,
  p_player_id      uuid,
  p_player_name    text,
  p_round_count    int,
  p_map_id         text,
  p_max_level_diff int
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_level   int;
  v_candidate  record;
  v_existing   record;
  v_room_id    uuid;
  v_room_code  text;
  v_attempt    int;
  v_now        timestamptz := now();
  v_expires_at timestamptz := now() + interval '45 seconds';
begin
  -- ── Auth ───────────────────────────────────────────────────────────────
  if auth.uid() is null then
    raise exception 'conquest_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'conquest_quick_match: auth.uid() does not match p_profile_id';
  end if;

  -- ── Parametre kontrolleri ──────────────────────────────────────────────
  if p_round_count is null or p_round_count not in (6, 8, 10) then
    raise exception 'conquest_quick_match: invalid round_count %', p_round_count;
  end if;
  -- Türkiye-only kuralı server'da zorlanır: yalnız 'turkey' kabul.
  if coalesce(p_map_id, '') <> 'turkey' then
    raise exception 'conquest_quick_match: unsupported map %', p_map_id;
  end if;
  if p_max_level_diff is null or p_max_level_diff < 0 then
    raise exception 'conquest_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if p_player_id is null then
    raise exception 'conquest_quick_match: player_id_required';
  end if;
  if coalesce(btrim(p_player_name), '') = '' then
    raise exception 'conquest_quick_match: empty player_name';
  end if;

  v_my_level := public.conquest_quick_match_mode_level(p_profile_id);

  -- ── Eşzamanlılık self-lock (double-match guard) ────────────────────────
  -- Aday aramasına geçmeden ÖNCE çağıranın KENDİ queue satırını kilitle.
  -- Neden: paralel bir RPC bu oyuncuyu aday olarak eşleştiriyorsa, candidate
  -- SELECT'i (aşağıda) bu satırı FOR UPDATE ile tutuyordur. Burada o lock
  -- serbest kalana kadar (yani diğer RPC commit edene kadar) blokleniriz; commit
  -- sonrası satırda matched_room_id dolu olur ve hemen aşağıdaki erken-dönüş
  -- mevcut eşleşmeyi döner → ASLA yeniden aday arayıp üçüncü bir oyuncuyla
  -- eşleşmeyiz (double-match kapanır). İlk tick'te satır henüz yok → FOR UPDATE
  -- hiçbir satır bulmaz, kilitlenecek bir şey olmaz (o anda kimseye aday da
  -- değiliz). Candidate SELECT'in FOR UPDATE SKIP LOCKED davranışı değişmez:
  -- bu lock yalnız çağıranın KENDİ satırınadır, başka adayları etkilemez ve
  -- iki çağıran ayrı satırları kilitlediği için deadlock olmaz.
  perform 1
    from public.conquest_quick_match_queue
   where profile_id = p_profile_id
   for update;

  -- ── Stale-row self-heal ────────────────────────────────────────────────
  -- Önceki bitmiş/iptal maçtan kalan matched_room_id'yi temizle: oda artık
  -- waiting/playing değil veya 120sn'den eskiyse NULL'a çek → normal aramaya
  -- dönsün. (Conquest start, düellodan biraz daha uzun sürebilir: host ilk
  -- gameplay_state'i hesaplayıp yazana kadar oda kısa süre 'waiting' kalır.)
  update public.conquest_quick_match_queue q
     set matched_room_id = null,
         updated_at      = v_now
   where q.profile_id      = p_profile_id
     and q.matched_room_id is not null
     and not exists (
       select 1
         from public.conquest_rooms r
        where r.id = q.matched_room_id
          and r.status in ('waiting', 'playing')
          and r.created_at > v_now - interval '120 seconds'
     );

  -- ── Paralel RPC bizi zaten eşleştirmiş mi? ─────────────────────────────
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.conquest_quick_match_queue
   where profile_id = p_profile_id;

  if found and v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'host_player_id',     (select host_player_id from public.conquest_rooms where id = v_existing.matched_room_id),
      'opponent_name',      null,
      'search_age_seconds', greatest(0, extract(epoch from (v_now - v_existing.created_at))::int)
    );
  end if;

  -- ── Uygun aday ara (race-safe) ─────────────────────────────────────────
  select q.profile_id, q.player_id, q.player_name, q.mode_level,
         q.max_level_diff, q.created_at
    into v_candidate
    from public.conquest_quick_match_queue q
   where q.profile_id      <> p_profile_id
     and q.map_id            = p_map_id
     and q.round_count       = p_round_count
     and q.matched_room_id  is null
     and q.expires_at        > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı + iki oyuncuyu atomik kur ───────────────────────
    -- host_profile_id/host_player_id = candidate (waiter) → host istemci
    -- conquest_rooms UPDATE yetkisine sahip olur (RLS host_profile_id=auth.uid).
    -- status='waiting': ilk gameplay_state'i host istemci yazacak (canonical).
    v_room_id := null;
    for v_attempt in 1..6 loop
      v_room_code := 'K' || upper(substr(md5(gen_random_uuid()::text), 1, 5));
      begin
        insert into public.conquest_rooms (
          room_code, host_profile_id, host_player_id, host_name,
          status, map_id, max_players, round_count, visibility, team_mode
        ) values (
          v_room_code, v_candidate.profile_id, v_candidate.player_id, v_candidate.player_name,
          'waiting', p_map_id, 2, p_round_count, 'private', 'individual'
        )
        returning id into v_room_id;
        exit;
      exception when unique_violation then
        v_room_id := null;  -- room_code çakıştı → yeniden dene
      end;
    end loop;

    if v_room_id is null then
      raise exception 'conquest_quick_match: room_code generation failed';
    end if;

    -- İki oyuncu: candidate=host (red), caller=joiner (blue). guest_id null
    -- (giriş zorunlu); claim_token YOK (profile_id auth dalı yeterli).
    insert into public.conquest_players (id, room_id, profile_id, guest_id, name, is_host, color)
      values (v_candidate.player_id, v_room_id, v_candidate.profile_id, null, v_candidate.player_name, true, 'red');

    insert into public.conquest_players (id, room_id, profile_id, guest_id, name, is_host, color)
      values (p_player_id, v_room_id, p_profile_id, null, btrim(p_player_name), false, 'blue');

    -- Candidate'ın queue satırını işaretle → realtime UPDATE waiter'a ulaşır.
    update public.conquest_quick_match_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    -- Caller'ın queue satırını da işaretle (güvenlik ağı).
    insert into public.conquest_quick_match_queue as q (
      profile_id, player_id, player_name, round_count, map_id,
      mode_level, max_level_diff, matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, btrim(p_player_name), p_round_count, p_map_id,
      v_my_level, p_max_level_diff, v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id        = excluded.player_id,
          player_name      = excluded.player_name,
          round_count      = excluded.round_count,
          map_id           = excluded.map_id,
          mode_level       = excluded.mode_level,
          max_level_diff   = excluded.max_level_diff,
          matched_room_id  = excluded.matched_room_id,
          expires_at       = excluded.expires_at,
          updated_at       = excluded.updated_at;

    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_room_id,
      'my_player_id',       p_player_id,
      'host_player_id',     v_candidate.player_id,
      'opponent_name',      v_candidate.player_name,
      'search_age_seconds', 0
    );
  end if;

  -- ── EŞLEŞME YOK — caller'ın queue satırını UPSERT ──────────────────────
  -- matched_room_id'yi yalnız NULL ise güncelle (paralel eşleşme yarışı).
  insert into public.conquest_quick_match_queue as q (
    profile_id, player_id, player_name, round_count, map_id,
    mode_level, max_level_diff, matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, btrim(p_player_name), p_round_count, p_map_id,
    v_my_level, p_max_level_diff, null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id        = excluded.player_id,
        player_name      = excluded.player_name,
        round_count      = excluded.round_count,
        map_id           = excluded.map_id,
        mode_level       = excluded.mode_level,
        max_level_diff   = excluded.max_level_diff,
        expires_at       = excluded.expires_at,
        updated_at       = excluded.updated_at
    where q.matched_room_id is null;

  -- UPSERT sonrası tekrar oku → arada matched olduysa direkt dön.
  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.conquest_quick_match_queue
   where profile_id = p_profile_id;

  if v_existing.matched_room_id is not null then
    return jsonb_build_object(
      'matched',            true,
      'room_id',            v_existing.matched_room_id,
      'my_player_id',       v_existing.player_id,
      'host_player_id',     (select host_player_id from public.conquest_rooms where id = v_existing.matched_room_id),
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
-- 7) RPC: conquest_cancel_quick_match — yalnız eşleşmemiş satırı siler
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_cancel_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'conquest_cancel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'conquest_cancel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  delete from public.conquest_quick_match_queue
   where profile_id      = p_profile_id
     and matched_room_id is null;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) RPC: conquest_reset_quick_match — koşulsuz siler (yeni aramaya temiz başla)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_reset_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'conquest_reset_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'conquest_reset_quick_match: auth.uid() does not match p_profile_id';
  end if;

  delete from public.conquest_quick_match_queue
   where profile_id = p_profile_id;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) GRANT'ler — yalnız authenticated (giriş zorunlu)
-- ────────────────────────────────────────────────────────────────────────────

revoke all on function public.conquest_quick_match_mode_level(uuid)                       from public;
revoke all on function public.conquest_quick_match(uuid, uuid, text, int, text, int)      from public;
revoke all on function public.conquest_cancel_quick_match(uuid)                           from public;
revoke all on function public.conquest_reset_quick_match(uuid)                            from public;

grant execute on function public.conquest_quick_match_mode_level(uuid)                    to authenticated;
grant execute on function public.conquest_quick_match(uuid, uuid, text, int, text, int)   to authenticated;
grant execute on function public.conquest_cancel_quick_match(uuid)                        to authenticated;
grant execute on function public.conquest_reset_quick_match(uuid)                         to authenticated;


-- ============================================================================
-- DONE
-- ============================================================================
-- Smoke testi (Studio'da iki authenticated user JWT'siyle sırayla):
--   -- A (matched=false):
--   select conquest_quick_match('<A>'::uuid, gen_random_uuid(), 'A', 8, 'turkey', 0);
--   -- B (matched=true; aynı round_count + map):
--   select conquest_quick_match('<B>'::uuid, gen_random_uuid(), 'B', 8, 'turkey', 0);
--   -- A'nın satırı artık matched_room_id dolu:
--   select profile_id, matched_room_id from conquest_quick_match_queue where profile_id='<A>'::uuid;
--   -- Oluşan oda + iki oyuncu (host=A waiter, red; B joiner, blue):
--   select id, room_code, status, map_id, round_count, max_players, host_player_id from conquest_rooms order by created_at desc limit 3;
--   select id, room_id, name, is_host, color, profile_id from conquest_players where room_id = '<room_id>'::uuid order by joined_at;
-- Temizlik:
--   delete from conquest_players where room_id in (select id from conquest_rooms where max_players=2 and visibility='private' and round_count in (6,8,10));
--   delete from conquest_quick_match_queue where profile_id in ('<A>','<B>');
-- ============================================================================
