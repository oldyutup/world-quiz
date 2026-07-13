-- ============================================================================
-- Flag Group — flag_seq (gösterilen-bayrak kimliği) + PAS TUR TÜKETMEZ
-- ============================================================================
-- AMAÇ
-- ----
-- Bayrak Bilmece Çok Oyunculu (flag_group_*) modunda Pas Geç davranışını 1v1
-- ile hizalar: PAS turu TÜKETMEZ. Çoğunluk pas derse mevcut bayrak değişir,
-- doğru cevap kısa süre gösterilir, AYNI tur numarası altında YENİ bir bayrak
-- gelir. Skor/tur ilerlemesi yalnız gerçek claim VEYA timeout ile olur.
--
-- KÖK PROBLEM (bu migration'ın çözdüğü)
-- ------------------------------------
-- Eski atomik çözüm anahtarı UNIQUE(room_id, game_seq, round) idi. Aynı `round`
-- içinde ikinci bayrak gösterilince, ilk (paslanan) bayrağın sentinel'i
-- `pass:<flag>` o bucket'ı zaten doldurmuş oluyordu → ikinci bayrağın doğru
-- claim'i unique_violation ('dup') alıyor, KİMSE puan alamıyordu. Yani "aynı
-- turda yeni bayrak" mümkün değildi.
--
-- ÇÖZÜM: flag_seq
-- ---------------
--   • game_seq       : oyun oturumu (start_game'de monoton artar) — DEĞİŞMEZ.
--   • current_round  : oyuncuya gösterilen skor/tur ilerlemesi (pas onu ARTIRMAZ).
--   • flag_seq       : o oyun içinde gösterilen HER yeni bayrağın değişmez,
--                      monoton kimliği. Atomik çözüm anahtarı artık BUNA bağlı.
--
--   Örnek:
--     game_seq 3, round 4, flag_seq 6 → paslandı (sentinel)
--     game_seq 3, round 4, flag_seq 7 → yeni bayrak, AYNI tur
--     game_seq 3, round 5, flag_seq 8 → normal tur ilerlemesi
--
--   Yeni anahtarlar:
--     claim atomik anahtarı  : UNIQUE(room_id, game_seq, flag_seq)
--     pass vote tekilliği     : UNIQUE(room_id, game_seq, flag_seq, player_id)
--   `round` kolonu audit/UI için tutulur ama TEK BAŞINA atomik anahtar DEĞİL.
--
-- SERVER-OTORİTER TUR İLERLETME
-- ----------------------------
-- Yeni flag_group_advance_flag RPC'si, host'un client-side "paslandı, round'u
-- artırma" kararına GÜVENMEZ. Mevcut çözüm satırını (game_seq, flag_seq) KİLİT
-- altında okur:
--   • Çözüm `pass:*` sentinel ise → current_round AYNI kalır, flag_seq++, yeni
--     current_flag yazılır, current_flag_at sıfırlanır (son turda bile oyun
--     BİTMEZ — yeni bayrak aynı final tur altında gelir).
--   • Çözüm gerçek claim VEYA çözüm yok (timeout) ise → round normal ilerler
--     (current_round+1); son turu geçince oyun finalize edilir; flag_seq++.
-- submit_claim / toggle_pass_vote / advance_flag AYNI flag_group_rooms satırını
-- `FOR UPDATE` ile kilitler → tek sıra, deadlock imkânsız, claim↔pas↔ilerletme
-- SERİdir.
--
-- BU MIGRATION SADECE İLERİ (forward-only) — CANLIYA UYGULANMIŞ eski dosyalar
-- (20260728120000 / 20260729120000 / 20260730120000) DEĞİŞTİRİLMEZ. Yeni
-- kolon/anahtar/RPC EKLER, mevcut satırlar için GÜVENLİ backfill yapar
-- (destructive reset YOK).
--
-- IDEMPOTENT: add column if not exists / dinamik constraint drop / DO-guard'lı
--             constraint add / create or replace / drop+create function.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) flag_group_rooms.flag_seq
-- ----------------------------------------------------------------------------
-- Odanın O AN gösterdiği bayrağın monoton kimliği. start_game → 1; her yeni
-- bayrak (advance_flag) → +1. Backfill: mevcut satırlarda tarihsel olarak her
-- turda tek bayrak vardı (flag_seq == round) → flag_seq = current_round.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.flag_group_rooms
  add column if not exists flag_seq int not null default 0;

update public.flag_group_rooms
   set flag_seq = current_round
 where flag_seq = 0 and current_round > 0;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) flag_group_claims.flag_seq + atomik anahtar takası
-- ----------------------------------------------------------------------------
-- Backfill: eski satırlarda bir tur = bir bayrak → flag_seq = round (bu değer
-- (room, game_seq) içinde ZATEN benzersizdi, yeni UNIQUE çakışmaz). Ardından
-- eski UNIQUE(room_id, game_seq, round) DÜŞÜRÜLÜR (aksi hâlde aynı round'da
-- ikinci bayrak hâlâ çakışırdı) ve UNIQUE(room_id, game_seq, flag_seq) eklenir.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.flag_group_claims
  add column if not exists flag_seq int;

update public.flag_group_claims set flag_seq = round where flag_seq is null;

alter table public.flag_group_claims
  alter column flag_seq set not null;

-- Eski UNIQUE(room_id, game_seq, round)'u kolon-kümesinden dinamik bul & düşür
-- (auto-name'e bağlı kalmadan; idempotent).
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'flag_group_claims'
     and con.contype = 'u'
     and (
       -- att.attname `name` tipindedir → array_agg sonucu `name[]` olur ve `text[]`
       -- ile karşılaştırılamaz (operator does not exist: name[] = text[]). İki tarafı
       -- da `text[]`'e getirmek için elemanları aggregate ÖNCESİ ::text'e çeviriyoruz.
       select array_agg(att.attname::text order by att.attname::text)
         from unnest(con.conkey) as k(attnum)
         join pg_attribute att
           on att.attrelid = con.conrelid and att.attnum = k.attnum
     ) = array['game_seq','room_id','round']::text[]
   limit 1;
  if v_conname is not null then
    execute format('alter table public.flag_group_claims drop constraint %I', v_conname);
  end if;
end$$;

-- Yeni atomik anahtar: tur başına DEĞİL, gösterilen-bayrak başına tek çözüm.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'flag_group_claims_room_game_flag_key'
       and conrelid = 'public.flag_group_claims'::regclass
  ) then
    alter table public.flag_group_claims
      add constraint flag_group_claims_room_game_flag_key
      unique (room_id, game_seq, flag_seq);
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) flag_group_pass_votes.flag_seq + oy-tekilliği anahtarı takası
-- ----------------------------------------------------------------------------
-- Oylar artık (game_seq, flag_seq) turuna bağlı. Yeni bayrak (flag_seq++) →
-- oylar 0/N'den başlar; eski flag_seq oyları anahtar farkı nedeniyle inert.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.flag_group_pass_votes
  add column if not exists flag_seq int;

update public.flag_group_pass_votes set flag_seq = round where flag_seq is null;

alter table public.flag_group_pass_votes
  alter column flag_seq set not null;

-- Eski UNIQUE(room_id, game_seq, round, player_id)'u dinamik bul & düşür.
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'flag_group_pass_votes'
     and con.contype = 'u'
     and (
       -- att.attname `name` tipindedir → array_agg sonucu `name[]`; `text[]` ile
       -- karşılaştırmak için elemanları aggregate ÖNCESİ ::text'e çeviriyoruz.
       select array_agg(att.attname::text order by att.attname::text)
         from unnest(con.conkey) as k(attnum)
         join pg_attribute att
           on att.attrelid = con.conrelid and att.attnum = k.attnum
     ) = array['game_seq','player_id','room_id','round']::text[]
   limit 1;
  if v_conname is not null then
    execute format('alter table public.flag_group_pass_votes drop constraint %I', v_conname);
  end if;
end$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'flag_group_pass_votes_room_game_flag_player_key'
       and conrelid = 'public.flag_group_pass_votes'::regclass
  ) then
    alter table public.flag_group_pass_votes
      add constraint flag_group_pass_votes_room_game_flag_player_key
      unique (room_id, game_seq, flag_seq, player_id);
  end if;
end$$;

create index if not exists flag_group_pass_votes_flag_idx
  on public.flag_group_pass_votes (room_id, game_seq, flag_seq);


-- ────────────────────────────────────────────────────────────────────────────
-- 3.5) ESKİ flag_group_set_next_round'u DEVRE DIŞI BIRAK (execute revoke)
-- ----------------------------------------------------------------------------
-- Yeni client artık flag_group_advance_flag kullanıyor. Eski set_next_round
-- (init 20260728120000) host-yetkiliydi ANCAK flag_seq'i ARTIRMADAN current_round/
-- current_flag'i yazıyordu → yeni atomik modeli (UNIQUE(room,game_seq,flag_seq))
-- ATLAR: host bu eski RPC'yi doğrudan çağırıp yeni bayrağı ESKİ flag_seq altında
-- gösterebilir (claim/pass bucket çakışması, pas-turu-tüketmez semantiğini bozma,
-- server-timeout guard'ını atlatma, aynı turu tekrar ilerletme). Kullanılmadığı
-- için en güvenlisi genel EXECUTE'u tamamen geri almaktır (wrapper'a gerek yok).
-- Eski migration dosyasına DOKUNULMAZ; yetki yalnız burada, ileri migration'da
-- kaldırılır. Owner (definer/migration) hâlâ çalıştırabilir; anon/authenticated
-- ARTIK çağıramaz → yeni flag_seq modelini atlayacak yol kalmaz.
-- ────────────────────────────────────────────────────────────────────────────

revoke execute on function public.flag_group_set_next_round(uuid, uuid, uuid, int, text)
  from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) flag_group_start_game — flag_seq = 1 (ilk bayrak)
-- ----------------------------------------------------------------------------
-- init sürümüyle AYNI; yalnız update'e `flag_seq = 1` eklendi. game_seq artışı
-- + flag_seq=1 + claim silme → yeni oturum eski satırlarla çakışmaz.
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
         flag_seq        = 1,              -- ilk gösterilen bayrak
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
-- 5) flag_group_submit_claim — atomik anahtar (game_seq, flag_seq)
-- ----------------------------------------------------------------------------
-- init sürümüyle AYNI mantık; yalnız insert artık flag_seq'i de yazar ve
-- benzersizlik (room_id, game_seq, flag_seq) üzerinden çalışır → aynı round'da
-- ikinci bayrağın claim'i eski bayrağın sentinel'iyle ÇAKIŞMAZ.
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

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Yalnız MEVCUT gösterilen bayrağın doğru cevabı sayılır (server-otoriter tur
  -- kapağı). Bayrak değiştiyse (pas/ilerletme sonrası) eski cevap 'stale'.
  if p_country_code <> v_room.current_flag then
    return jsonb_build_object('claimed', false, 'reason', 'stale');
  end if;

  begin
    insert into public.flag_group_claims (room_id, player_id, game_seq, round, flag_seq, country_code)
    values (p_room_id, p_player_id, v_room.game_seq, v_room.current_round, v_room.flag_seq, p_country_code);
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
-- 6) flag_group_toggle_pass_vote — flag_seq turuna bağlı (imza +p_flag_seq)
-- ----------------------------------------------------------------------------
-- 20260730120000 sürümüyle AYNI mantık; TEK fark: tur kimliği artık
-- (game_seq, flag_seq). Eski 5-arg imza DÜŞÜRÜLÜR; yeni 6-arg (p_flag_seq
-- eklendi) gelir. Client oy verirken gerçek gösterilen bayrağın flag_seq'ini
-- gönderir; server KİLİTLİ oda satırıyla doğrular (client'a güvenmez).
-- ────────────────────────────────────────────────────────────────────────────

drop function if exists public.flag_group_toggle_pass_vote(uuid, uuid, uuid, int, int);

create or replace function public.flag_group_toggle_pass_vote(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_game_seq    int,
  p_round       int,
  p_flag_seq    int
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room       public.flag_group_rooms;
  v_active     int;
  v_required   int;
  v_vote_count int;
  v_had_vote   boolean;
  v_voted      boolean := false;
  v_resolved   boolean := false;
  v_passed     boolean := false;
  v_sentinel   text;
  v_host_id    uuid;
begin
  -- 1) Yetki.
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- 2) Oyuncu bu odada VE aktif ('playing') mi?
  if not exists (
    select 1 from public.flag_group_players
     where id = p_player_id and room_id = p_room_id and status = 'playing'
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- 3) Oda satırını KİLİTLE — submit_claim / advance_flag ile AYNI kilit sırası.
  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  select count(*) into v_active
    from public.flag_group_players
   where room_id = p_room_id and status = 'playing';
  v_required := (v_active / 2) + 1;   -- floor(N/2)+1

  -- Hijyen: eski oturum (game_seq<) VE aynı oturumda eski bayrak (flag_seq<)
  -- oylarını sil → bayat oy birikmez, realtime DELETE ile client'lar temizler.
  delete from public.flag_group_pass_votes
   where room_id = p_room_id
     and (game_seq < v_room.game_seq
          or (game_seq = v_room.game_seq and flag_seq < v_room.flag_seq));

  -- 4) Bayat/kapalı guard: oda oyunda değil ya da client'ın gösterilen bayrağı
  --    (game_seq, flag_seq) güncel değil → YAZMA YOK.
  if v_room.status <> 'playing'
     or p_game_seq <> v_room.game_seq
     or p_flag_seq <> v_room.flag_seq then
    select count(*) into v_vote_count
      from public.flag_group_pass_votes
     where room_id  = p_room_id
       and game_seq = v_room.game_seq
       and flag_seq = v_room.flag_seq;
    return jsonb_build_object(
      'voted', false, 'vote_count', v_vote_count, 'required', v_required,
      'active', v_active, 'resolved', false, 'passed', false, 'stale', true
    );
  end if;

  -- 5) Bu gösterilen bayrak zaten çözüldü mü? (claim VEYA pas sentinel)
  if exists (
    select 1 from public.flag_group_claims
     where room_id  = p_room_id
       and game_seq = v_room.game_seq
       and flag_seq = v_room.flag_seq
  ) then
    select count(*) into v_vote_count
      from public.flag_group_pass_votes
     where room_id  = p_room_id
       and game_seq = v_room.game_seq
       and flag_seq = v_room.flag_seq;
    return jsonb_build_object(
      'voted', false, 'vote_count', v_vote_count, 'required', v_required,
      'active', v_active, 'resolved', true, 'passed', false
    );
  end if;

  -- 6) TOGGLE (yalnız çağıranın kendi satırı).
  select exists (
    select 1 from public.flag_group_pass_votes
     where room_id  = p_room_id and game_seq = v_room.game_seq
       and flag_seq = v_room.flag_seq and player_id = p_player_id
  ) into v_had_vote;

  if v_had_vote then
    delete from public.flag_group_pass_votes
     where room_id  = p_room_id and game_seq = v_room.game_seq
       and flag_seq = v_room.flag_seq and player_id = p_player_id;
    v_voted := false;
  else
    insert into public.flag_group_pass_votes (room_id, game_seq, round, flag_seq, player_id)
    values (p_room_id, v_room.game_seq, v_room.current_round, v_room.flag_seq, p_player_id)
    on conflict (room_id, game_seq, flag_seq, player_id) do nothing;   -- reconnect-safe
    v_voted := true;
  end if;

  -- 7) Güncel oy sayısı (kilit altında).
  select count(*) into v_vote_count
    from public.flag_group_pass_votes
   where room_id  = p_room_id
     and game_seq = v_room.game_seq
     and flag_seq = v_room.flag_seq;

  -- 8) Çoğunluk → bu bayrağı PAS ile çöz: flag_group_claims'e sentinel yaz.
  --    UNIQUE(room_id, game_seq, flag_seq) → doğru claim araya girdiyse
  --    unique_violation → bayrak ZATEN çözüldü (pas etmez).
  if v_vote_count >= v_required then
    select id into v_host_id
      from public.flag_group_players
     where room_id = p_room_id and is_host = true
     limit 1;

    v_sentinel := 'pass:' || coalesce(v_room.current_flag, '');
    begin
      insert into public.flag_group_claims (room_id, player_id, game_seq, round, flag_seq, country_code)
      values (p_room_id, coalesce(v_host_id, p_player_id), v_room.game_seq, v_room.current_round, v_room.flag_seq, v_sentinel);
      v_resolved := true;
      v_passed   := true;
    exception
      when unique_violation then
        v_resolved := true;   -- doğru claim araya girdi → çözüldü ama pas DEĞİL
        v_passed   := false;
    end;
  end if;

  return jsonb_build_object(
    'voted', v_voted, 'vote_count', v_vote_count, 'required', v_required,
    'active', v_active, 'resolved', v_resolved, 'passed', v_passed
  );
end;
$$;
revoke all     on function public.flag_group_toggle_pass_vote(uuid, uuid, uuid, int, int, int) from public;
grant  execute on function public.flag_group_toggle_pass_vote(uuid, uuid, uuid, int, int, int) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) flag_group_advance_flag — SERVER-OTORİTER sonraki bayrak / finalize
-- ----------------------------------------------------------------------------
-- Host, mevcut bayrak çözüldükten (claim / pas / timeout) sonra bunu çağırır ve
-- YALNIZ bir aday sonraki bayrak (p_next_flag) verir. Server, mevcut çözüm
-- kaydını KİLİT altında okuyup kararı KENDİ verir (client'ın "round'u artır/
-- artırma" boolean'ına GÜVENMEZ):
--   • Çözüm `pass:*`      → current_round DEĞİŞMEZ, flag_seq++, yeni bayrak
--                           (final turda bile oyun BİTMEZ). Havuz bittiyse finalize.
--   • Çözüm GERÇEK claim  → current_round+1; son turu geçtiyse (veya aday bayrak
--                           yoksa) finalize; değilse yeni bayrak (flag_seq++).
--   • Çözüm YOK           → YALNIZ gerçek server-side timeout dolduysa (yukarıdaki
--                           claim/finalize kuralı) ilerler; DOLMADIYSA reddedilir.
--
-- ERKEN-ADVANCE / GRIEFING GUARD'ı (çözüm yok + timeout dolmamış):
--   Host, hiç claim/pas yokken timer dolmadan bu RPC'yi doğrudan çağırıp turu
--   erken atlayabilirdi. Timeout SERVER-SIDE doğrulanır: room.current_flag_at
--   (server now()) + 10sn (client FLAG_TIMEOUT_SEC ile birebir). Süre dolmadıysa
--   `round_active` raise → HİÇBİR mutation yok. Client timestamp'ına GÜVENİLMEZ.
--
-- p_next_flag DOĞRULAMASI (client'a körü körüne güvenilmez):
--   YALNIZ yeni bayrak yazılacaksa (havuz-tükendi/finalize DEĞİL): boş/null olamaz,
--   biçim ^[a-z]{2}$ (tüm flag SVG anahtarları lowercase ISO 3166-1 alpha-2),
--   mevcut current_flag ile AYNI olamaz. Yazım normalize (lower/btrim) değerle.
--   (Ayrı ülke tablosu KURULMAZ — biçim + boş + aynı-bayrak reddi yeterli guard.)
--
-- STALENESS: p_flag_seq güncel flag_seq değilse (başka advance zaten ilerletmiş)
-- → no-op, HİÇBİR mutation yok (çift-ilerletme guard'ı). submit_claim /
-- toggle_pass_vote ile AYNI oda kilidi (FOR UPDATE, tek satır) → seri.
-- Dönüş: güncel flag_group_rooms satırı (yeni bayrak veya finished).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_advance_flag(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_flag_seq       int,
  p_next_flag      text
) returns public.flag_group_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room       public.flag_group_rooms;
  v_res        text;
  v_passed     boolean;
  v_has_claim  boolean;
  v_has_next   boolean;
  v_next_flag  text;
  v_next_round int;
begin
  if not public.flag_group_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Oda artık oyunda değil (başka client finalize etti vb.) → idempotent no-op.
  if v_room.status <> 'playing' then
    return v_room;
  end if;

  -- Çift-ilerletme guard'ı: bu bayrak zaten ilerletildiyse (flag_seq değişti) →
  -- HİÇBİR mutation yapılmadan no-op (stale advance).
  if p_flag_seq is distinct from v_room.flag_seq then
    return v_room;
  end if;

  -- p_next_flag doğrulaması (mutation ÖNCESİ raise):
  --   • SQL NULL     → havuz-tükendi finalize sinyali (MEŞRU; reddedilmez).
  --                    Bölge havuzu total_rounds'tan küçük olabilir (örn. Güney
  --                    Amerika ~12) → host'un pickNextFlagCode'u null döner.
  --   • NULL DEĞİL    → client bir değer gönderdi → GEÇERLİ olmalı: boş/whitespace/
  --                    bozuk biçim (next_flag_invalid) veya current_flag ile AYNI
  --                    (next_flag_unchanged) REDDEDİLİR. Biçim ^[a-z]{2}$ = tüm
  --                    flag SVG anahtarları (lowercase ISO 3166-1 alpha-2).
  if p_next_flag is null then
    v_has_next := false;
  else
    v_next_flag := lower(btrim(p_next_flag));
    if v_next_flag !~ '^[a-z]{2}$' then
      raise exception 'next_flag_invalid' using errcode = '22023';
    end if;
    if v_next_flag = lower(coalesce(v_room.current_flag, '')) then
      raise exception 'next_flag_unchanged' using errcode = 'P0001';
    end if;
    v_has_next := true;
  end if;

  -- Mevcut gösterilen bayrağın (game_seq, flag_seq) çözümünü KİLİT altında oku.
  select country_code into v_res
    from public.flag_group_claims
   where room_id  = p_room_id
     and game_seq = v_room.game_seq
     and flag_seq = v_room.flag_seq
   limit 1;

  v_passed    := (v_res is not null and v_res like 'pass:%');
  v_has_claim := (v_res is not null and not v_passed);   -- gerçek (skorlanan) claim

  -- ── PAS: tur numarası DEĞİŞMEZ, yeni bayrak aynı tur altında ──
  if v_passed then
    if not v_has_next then
      update public.flag_group_rooms
         set status = 'finished', finished_at = now(), updated_at = now()
       where id = p_room_id and status = 'playing'
       returning * into v_room;
      update public.flag_group_players
         set status = 'finished', last_seen_at = now()
       where room_id = p_room_id;
      return v_room;
    end if;

    update public.flag_group_rooms
       set current_flag    = v_next_flag,
           current_flag_at = now(),
           flag_seq        = flag_seq + 1,
           updated_at      = now()
     where id = p_room_id and status = 'playing' and flag_seq = p_flag_seq
     returning * into v_room;
    return v_room;
  end if;

  -- ── ÇÖZÜM YOK → yalnız GERÇEK server-side timeout dolduysa ilerle ──
  -- (Gerçek claim varsa bu kontrol atlanır; claim anında çözer.)
  if not v_has_claim then
    if v_room.current_flag_at is null
       or now() < v_room.current_flag_at + interval '10 seconds' then
      raise exception 'round_active' using errcode = 'P0001';   -- erken advance reddi
    end if;
  end if;

  -- ── GERÇEK CLAIM veya DOĞRULANMIŞ TIMEOUT → normal tur ilerlemesi ──
  v_next_round := v_room.current_round + 1;
  if v_next_round > v_room.total_rounds or not v_has_next then
    update public.flag_group_rooms
       set status = 'finished', finished_at = now(), updated_at = now()
     where id = p_room_id and status = 'playing'
     returning * into v_room;
    update public.flag_group_players
       set status = 'finished', last_seen_at = now()
     where room_id = p_room_id;
    return v_room;
  end if;

  update public.flag_group_rooms
     set current_round   = v_next_round,
         current_flag    = v_next_flag,
         current_flag_at = now(),
         flag_seq        = flag_seq + 1,
         updated_at      = now()
   where id = p_room_id and status = 'playing' and flag_seq = p_flag_seq
   returning * into v_room;
  return v_room;
end;
$$;
revoke all     on function public.flag_group_advance_flag(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.flag_group_advance_flag(uuid, uuid, uuid, int, text) to anon, authenticated;


-- ============================================================================
-- DONE — doğrulama (Studio SQL editor):
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='flag_group_rooms' and column_name='flag_seq';
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.flag_group_claims'::regclass and contype='u';
--   -- Beklenen: UNIQUE(room_id, game_seq, flag_seq); (room_id,game_seq,round) YOK.
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.flag_group_pass_votes'::regclass and contype='u';
--   -- Beklenen: UNIQUE(room_id, game_seq, flag_seq, player_id).
--
--   select proname, pg_get_function_identity_arguments(oid) from pg_proc
--    where pronamespace='public'::regnamespace and proname in
--      ('flag_group_toggle_pass_vote','flag_group_advance_flag','flag_group_submit_claim','flag_group_start_game')
--    order by 1;
--   -- toggle_pass_vote artık 6-arg (…, p_flag_seq int); advance_flag mevcut.
--
-- GÜVENLİK doğrulaması:
--   -- Eski set_next_round anon/authenticated tarafından ÇAĞRILAMAZ:
--   select has_function_privilege('anon',
--     'public.flag_group_set_next_round(uuid,uuid,uuid,int,text)', 'execute') as anon_can,
--          has_function_privilege('authenticated',
--     'public.flag_group_set_next_round(uuid,uuid,uuid,int,text)', 'execute') as auth_can;
--   -- Beklenen: her ikisi de FALSE.
--
--   -- Erken advance (çözüm yok + timer dolmamış) reddi:
--   select * from flag_group_advance_flag('<room>','<A>','<A tok>', <flag_seq>, 'xx');
--     -- current_flag'e claim/pas yoksa VE now() < current_flag_at + 10sn → ERROR: round_active
--   -- Geçersiz p_next_flag:
--   select * from flag_group_advance_flag('<room>','<A>','<A tok>', <flag_seq>, '');   -- ERROR: next_flag_invalid
--   select * from flag_group_advance_flag('<room>','<A>','<A tok>', <flag_seq>, 'ZZ9'); -- ERROR: next_flag_invalid
--   select * from flag_group_advance_flag('<room>','<A>','<A tok>', <flag_seq>, <current_flag>); -- ERROR: next_flag_unchanged
--   select * from flag_group_advance_flag('<room>','<A>','<A tok>', <ESKİ_flag_seq>, 'us'); -- no-op (stale → oda değişmeden döner)
--
-- Smoke (3 oturum — A host, B, C; required=floor(3/2)+1=2):
--   select * from flag_group_start_game('<room>','<A>','<A tok>','tr'); -- round=1, flag_seq=1
--   -- TUR 1'i pasla (B+C):
--   select flag_group_toggle_pass_vote('<room>','<B>','<B tok>',<gs>,1,1); -- 1/2
--   select flag_group_toggle_pass_vote('<room>','<C>','<C tok>',<gs>,1,1); -- 2/2 passed → sentinel (gs,1,flag_seq=1)
--   -- Host aynı tur altında yeni bayrak getir:
--   select * from flag_group_advance_flag('<room>','<A>','<A tok>',1,'us'); -- round HÂLÂ 1, flag_seq=2, current_flag='us'
--   -- Yeni bayrağın doğru claim'i KABUL (eski sentinel bloklamaz):
--   select flag_group_submit_claim('<room>','<B>','<B tok>','us'); -- {claimed:true} → (gs,round=1,flag_seq=2)
--   -- Eski flag_seq=1 oyu artık 'stale':
--   select flag_group_toggle_pass_vote('<room>','<C>','<C tok>',<gs>,1,1); -- stale:true
--   -- Host normal ilerlet (claim çözümü → round+1):
--   select * from flag_group_advance_flag('<room>','<A>','<A tok>',2,'de'); -- round=2, flag_seq=3
-- ============================================================================
