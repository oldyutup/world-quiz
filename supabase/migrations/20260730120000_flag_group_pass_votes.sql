-- ============================================================================
-- Flag Group — Pas Geç (salt çoğunluk oylaması)
-- ============================================================================
-- AMAÇ
-- ----
-- Bayrak Bilmece Çok Oyunculu (flag_group_*) oyununa server-otoriter bir
-- "Pas Geç" oylaması ekler. Aktif oyuncuların salt çoğunluğu (floor(N/2)+1)
-- mevcut turu pas geçmek isterse tur KİMSEYE PUAN YAZMADAN kapanır, doğru
-- cevap gösterilir ve normal sonraki-tur akışı çalışır.
--
-- Bu migration mevcut tablolara/RPC'lere DOKUNMAZ (20260728120000_flag_group_
-- init.sql ve 20260729120000_flag_group_send_message.sql değişmez). Yalnızca
-- EKLER:
--   • public.flag_group_pass_votes              (yeni tablo)
--   • RLS (SELECT açık, INSERT/UPDATE/DELETE kapalı → yalnız RPC yazar)
--   • realtime publication (canlı X/N göstergesi)
--   • public.flag_group_toggle_pass_vote(...)   (yeni RPC — vote/unvote toggle)
--
-- REFERANS: Çark Grup pas-vote modeli (20260703120000_wheel_group_pass_votes)
-- ----------------------------------------------------------------------------
-- Çark modeli oy tablosu + SECURITY DEFINER vote RPC + kilit-altında-quorum
-- desenini kanıtladı. FARK: Çark'ın tur kimliği `current_target_topoid` (bir
-- ülke topoid'i) idi ve yeni maçta TEKRAR gelebildiği için bayat oylar eşiği
-- yanlış tetikleyebiliyordu → start_game DELETE gerekti. Bayrak Grup'un tur
-- kimliği (game_seq, round) MONOTON'dur (game_seq her start_game'de artar),
-- bu yüzden eski oylar ASLA yeni turu etkilemez → start_game'e DOKUNULMAZ.
-- Bayat oylar bu RPC içinde (game_seq < current) opportunistik silinir.
--
-- ATOMİKLİK — PAS ↔ DOĞRU CLAIM ↔ ROUND İLERLETME (paylaşımlı oda kilidi)
-- ----------------------------------------------------------------------------
-- Bu RPC, submit_claim / set_next_round / finalize ile AYNI `flag_group_rooms`
-- satırını `FOR UPDATE` ile kilitler (tek satır → deadlock imkânsız, aynı sıra).
-- Turun ÇÖZÜMÜ (kazanan claim VEYA pas) tek bir yerde tutulur: flag_group_claims
-- tablosundaki UNIQUE(room_id, game_seq, round) bucket'ı. Çoğunluk oluşunca RPC
-- bu bucket'a `pass:<flag>` SENTİNEL claim'i yazar:
--   • Doğru claim ÖNCE yazıldıysa → bu RPC kilit altında onu görür (adım 5) →
--     pas turu TEKRAR kapatamaz (round_closed → no-op). Sentinel yazılmaz.
--   • Pas ÖNCE yazıldıysa → sonraki submit_claim aynı bucket'ta unique_violation
--     alır → 'dup' → hiç kimse puan almaz.
--   • İki eşzamanlı vote çoğunluğu → kilit seri hale getirir; ilki sentinel'i
--     yazar, ikincisi adım 5'te round_closed görür → tur BİR KEZ kapanır.
-- Sentinel `country_code = pass:<flag>` olduğundan isScoringClaim() onu skor
-- saymaz (client), ama `<flag>` reconnect'te host'un tekrar-gösterim önlemesi
-- için paslanan bayrağı çıkarmasına izin verir.
--
-- SENTİNEL SAHİPLİĞİ = HOST (FK cascade güvenliği — flag_group_claims DDL):
--   flag_group_claims.player_id NOT NULL + `references flag_group_players(id)
--   ON DELETE CASCADE`. Sentinel'in player_id'si o oyuncu silinince cascade ile
--   sentinel'i de SİLER. Deciding-voter kullanılsaydı, o oyuncu reveal
--   penceresinde (veya oyun boyunca) ayrılınca sentinel silinir → paslanmış tur
--   "çözülmemiş"e döner (host advance iptal olur; yalnız 10sn timeout kurtarır).
--   ÇÖZÜM: sentinel'i HOST'a bağla. Host kick edilemez (self-kick yasak, host
--   yalnız başkasını atar) ve host AYRILIRSA oda tamamen silinir (leave_room
--   host→room DELETE) → sentinel'in cascade'i zaten anlamsız. Ayrıca leave_room
--   odayı `FOR UPDATE` ile kilitler → biz kilidi tutarken host ayrılamaz; host
--   satırı işlem boyunca STABİL. Böylece sentinel canlı odada ASLA yetim-silinmez.
--   NOT: sentinel country_code `pass:*` olduğundan host'a PUAN da yazılmaz
--   (skor country_code filtreli; player_id'ye bağlı değil).
--
-- QUORUM — server hesaplar, client'a GÜVENMEZ
-- ----------------------------------------------------------------------------
--   required = floor(active/2) + 1   (SQL int bölme = floor)
--   active   = odada üyeliği olan + status='playing' oyuncular (kilit altında
--              sayılır). Atılan/ayrılan oyuncunun player satırı silinir → FK
--              on delete cascade oylarını düşürür → quorum kalan aktif sayıya
--              göre kendiliğinden yeniden hesaplanır (bir sonraki toggle'da).
--
-- OY KİMLİĞİ / TEKİLLEŞTİRME
-- ----------------------------------------------------------------------------
--   UNIQUE(room_id, game_seq, round, player_id) → aynı oyuncu aynı turda tek oy.
--   Reload/reconnect duplicate oy üretmez (aynı player_id + tur → çakışır).
--   Toggle: oyuncu tekrar tıklarsa KENDİ oyu silinir (başka oyuncu adına asla).
--
-- IDEMPOTENT: create table if not exists / or replace function / drop+create
--             policy / publication guard → tekrar koşulabilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) flag_group_pass_votes tablosu
-- ----------------------------------------------------------------------------
-- FK on delete cascade:
--   • room_id   → oda silinince (host ayrılır / boşalır) oyları temizler.
--   • player_id → oyuncu atılınca/ayrılınca (player row silinir) oylarını düşürür
--                 → "ayrılan oyuncunun oyu eşiği aşağı çekmeye devam etmesin".
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.flag_group_pass_votes (
  id          uuid        primary key default gen_random_uuid(),
  room_id     uuid        not null
                          references public.flag_group_rooms(id)   on delete cascade,
  -- Tur kimliği: (game_seq, round) — MONOTON. Eski oyun oturumunun (küçük
  -- game_seq) oyları yeni turu ASLA etkilemez (sorgular game_seq+round filtreli).
  game_seq    int         not null,
  round       int         not null,
  player_id   uuid        not null
                          references public.flag_group_players(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (room_id, game_seq, round, player_id)
);

create index if not exists flag_group_pass_votes_round_idx
  on public.flag_group_pass_votes (room_id, game_seq, round);

alter table public.flag_group_pass_votes replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) RLS — SELECT açık, yazma kanalları KAPALI (wheel_group_pass_votes kanonu)
-- ----------------------------------------------------------------------------
-- votes gameplay-kritiktir (eşik oylaması). Doğrudan anon/authenticated yazma
-- KAPALI; tek yazma yolu SECURITY DEFINER flag_group_toggle_pass_vote'tur
-- (function owner = tablo owner → RLS bypass). FK on-delete-cascade temizliği
-- de owner-cascade ile RLS'i bypass eder (FORCE RLS aktif değil).
-- SELECT açık: realtime + initial fetch (misafir claim_token RLS'e açık değil,
-- bu yüzden üyeliğe-bağlı SELECT misafir realtime'ını kırardı — init ile aynı
-- gerekçe). Sızan tek bilgi "kaç oyuncu pas istiyor" → zararsız.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.flag_group_pass_votes enable row level security;

drop policy if exists "flag_group_pass_votes_select_all"   on public.flag_group_pass_votes;
drop policy if exists "flag_group_pass_votes_insert_block" on public.flag_group_pass_votes;
drop policy if exists "flag_group_pass_votes_update_block" on public.flag_group_pass_votes;
drop policy if exists "flag_group_pass_votes_delete_block" on public.flag_group_pass_votes;

create policy "flag_group_pass_votes_select_all"
  on public.flag_group_pass_votes for select to anon, authenticated using (true);

create policy "flag_group_pass_votes_insert_block"
  on public.flag_group_pass_votes for insert to anon, authenticated with check (false);

create policy "flag_group_pass_votes_update_block"
  on public.flag_group_pass_votes for update to anon, authenticated using (false) with check (false);

create policy "flag_group_pass_votes_delete_block"
  on public.flag_group_pass_votes for delete to anon, authenticated using (false);


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Realtime publication (canlı X/N oy göstergesi)
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'flag_group_pass_votes'
  ) then
    execute 'alter publication supabase_realtime add table public.flag_group_pass_votes';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) flag_group_toggle_pass_vote RPC (vote/unvote toggle, çoğunlukta pas)
-- ----------------------------------------------------------------------------
-- Dönüş: jsonb {
--   voted:      bool,   -- bu çağrı sonucunda oyuncunun oyu var mı (toggle sonucu)
--   vote_count: int,    -- mevcut tur için toplam oy
--   required:   int,    -- gereken oy (floor(active/2)+1)
--   active:     int,    -- aktif ('playing') oyuncu sayısı
--   resolved:   bool,   -- tur bu noktada kapalı mı (claim veya pas)
--   passed:     bool,   -- tur PAS ile mi kapandı (bu çağrıda)
--   stale:      bool    -- (opsiyonel) client'ın game_seq/round'u bayat mıydı
-- }
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.flag_group_toggle_pass_vote(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_game_seq    int,
  p_round       int
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
  -- 1) Yetki: claim_token veya auth.uid() kanıtı (başka oyuncu adına oy YOK).
  if not public.flag_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- 2) Oyuncu bu odada VE aktif ('playing') mi? Atılan/ayrılan oyuncunun player
  --    satırı silinmiştir → player_room_mismatch. Sonuç ekranındaki oyuncu
  --    status<>'playing' → oy veremez.
  if not exists (
    select 1 from public.flag_group_players
     where id = p_player_id and room_id = p_room_id and status = 'playing'
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- 3) Oda satırını KİLİTLE — submit_claim / set_next_round / finalize ile AYNI
  --    kilit sırası (tek satır). Pas ↔ claim ↔ round-ilerletme yarışını seri
  --    hale getirir. Client'ın gönderdiği game_seq/round KİLİTLİ satırla
  --    doğrulanır (client'a güvenilmez).
  select * into v_room from public.flag_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Aktif oyuncu sayısı + gereken oy (SALT ÇOĞUNLUK) — SERVER hesaplar.
  select count(*) into v_active
    from public.flag_group_players
   where room_id = p_room_id and status = 'playing';
  v_required := (v_active / 2) + 1;   -- SQL int bölme = floor → floor(N/2)+1

  -- Hijyen: bu odanın ESKİ oyun oturumlarına (küçük game_seq) ait bayat oyları
  -- sil. game_seq monoton arttığı için bunlar zaten mevcut turu etkilemez;
  -- yalnız tablo şişmesini önler. start_game'e DOKUNULMAZ (init değişmez).
  delete from public.flag_group_pass_votes
   where room_id = p_room_id and game_seq < v_room.game_seq;

  -- 4) Bayat/kapalı tur guard'ı: oda oyunda değil, ya da client'ın turu güncel
  --    değil → YAZMA YOK, yalnız güncel durumu döndür (client sessizce yutar).
  if v_room.status <> 'playing'
     or p_game_seq <> v_room.game_seq
     or p_round    <> v_room.current_round then
    select count(*) into v_vote_count
      from public.flag_group_pass_votes
     where room_id  = p_room_id
       and game_seq = v_room.game_seq
       and round    = v_room.current_round;
    return jsonb_build_object(
      'voted', false, 'vote_count', v_vote_count, 'required', v_required,
      'active', v_active, 'resolved', false, 'passed', false, 'stale', true
    );
  end if;

  -- 5) Tur zaten kapandı mı? (bu tur için herhangi bir claim = gerçek kazanan
  --    VEYA pas sentinel'i var mı?) submit_claim ile AYNI kilit altında
  --    okuduğumuz için: doğru claim önce yazıldıysa burada görünür → pas turu
  --    TEKRAR kapatamaz (idempotent no-op). İki eşzamanlı vote'un ikincisi de
  --    burada durur → tur bir kez kapanır.
  if exists (
    select 1 from public.flag_group_claims
     where room_id  = p_room_id
       and game_seq = v_room.game_seq
       and round    = v_room.current_round
  ) then
    select count(*) into v_vote_count
      from public.flag_group_pass_votes
     where room_id  = p_room_id
       and game_seq = v_room.game_seq
       and round    = v_room.current_round;
    return jsonb_build_object(
      'voted', false, 'vote_count', v_vote_count, 'required', v_required,
      'active', v_active, 'resolved', true, 'passed', false
    );
  end if;

  -- 6) TOGGLE — oyuncunun bu tur için oyu var mı? Varsa geri çek (unvote),
  --    yoksa ekle (vote). Yalnız çağıranın KENDİ satırı etkilenir.
  select exists (
    select 1 from public.flag_group_pass_votes
     where room_id  = p_room_id and game_seq = v_room.game_seq
       and round    = v_room.current_round and player_id = p_player_id
  ) into v_had_vote;

  if v_had_vote then
    delete from public.flag_group_pass_votes
     where room_id  = p_room_id and game_seq = v_room.game_seq
       and round    = v_room.current_round and player_id = p_player_id;
    v_voted := false;
  else
    insert into public.flag_group_pass_votes (room_id, game_seq, round, player_id)
    values (p_room_id, v_room.game_seq, v_room.current_round, p_player_id)
    on conflict (room_id, game_seq, round, player_id) do nothing;   -- reconnect-safe
    v_voted := true;
  end if;

  -- 7) Güncel oy sayısı (kilit altında).
  select count(*) into v_vote_count
    from public.flag_group_pass_votes
   where room_id  = p_room_id
     and game_seq = v_room.game_seq
     and round    = v_room.current_round;

  -- 8) Çoğunluk oluştuysa turu PAS ile kapat: flag_group_claims'e sentinel yaz.
  --    UNIQUE(room_id, game_seq, round) → doğru claim aynı anda araya girdiyse
  --    unique_violation → tur ZATEN kapandı (pas etmez, kimse ikinci kez
  --    çözmez). (Adım 5'i geçtik → normalde bucket boş; sentinel tek çözüm olur.)
  if v_vote_count >= v_required then
    -- Sentinel sahibi = HOST (FK ON DELETE CASCADE yetim-silme güvenliği; üstteki
    -- başlık notu). Kilit altında okunur → işlem boyunca stabil; host ayrılamaz
    -- (leave_room aynı oda kilidinde bekler) ve kick edilemez.
    select id into v_host_id
      from public.flag_group_players
     where room_id = p_room_id and is_host = true
     limit 1;

    v_sentinel := 'pass:' || coalesce(v_room.current_flag, '');
    begin
      insert into public.flag_group_claims (room_id, player_id, game_seq, round, country_code)
      values (p_room_id, coalesce(v_host_id, p_player_id), v_room.game_seq, v_room.current_round, v_sentinel);
      v_resolved := true;
      v_passed   := true;
    exception
      when unique_violation then
        v_resolved := true;   -- doğru claim araya girdi → tur kapandı ama pas DEĞİL
        v_passed   := false;
    end;
  end if;

  return jsonb_build_object(
    'voted', v_voted, 'vote_count', v_vote_count, 'required', v_required,
    'active', v_active, 'resolved', v_resolved, 'passed', v_passed
  );
end;
$$;
revoke all     on function public.flag_group_toggle_pass_vote(uuid, uuid, uuid, int, int) from public;
grant  execute on function public.flag_group_toggle_pass_vote(uuid, uuid, uuid, int, int) to anon, authenticated;


-- ============================================================================
-- DONE — doğrulama (Studio SQL editor):
--   select table_name from information_schema.tables
--    where table_schema='public' and table_name='flag_group_pass_votes';
--
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='flag_group_pass_votes';
--
--   select proname, prosecdef from pg_proc
--    where pronamespace='public'::regnamespace and proname='flag_group_toggle_pass_vote';
--   -- Beklenen: 1 satır, prosecdef=true.
--
--   select tablename, policyname, cmd from pg_policies
--    where schemaname='public' and tablename='flag_group_pass_votes' order by 2;
--   -- Beklenen: SELECT açık; INSERT/UPDATE/DELETE bloklu.
--
-- Smoke (3 oturum — init'teki create/join/start üzerine):
--   -- 3 aktif oyuncu (A host, B, C); required = floor(3/2)+1 = 2.
--   select flag_group_toggle_pass_vote('<room>','<B>','<B tok>', <game_seq>, <round>);
--     -- {voted:true, vote_count:1, required:2, active:3, resolved:false, passed:false}
--   select flag_group_toggle_pass_vote('<room>','<C>','<C tok>', <game_seq>, <round>);
--     -- {voted:true, vote_count:2, required:2, ..., resolved:true, passed:true}
--     -- → flag_group_claims'e (room,game_seq,round,'pass:<flag>') yazıldı.
--   select flag_group_submit_claim('<room>','<A>','<A tok>','<flag>');
--     -- {claimed:false, reason:'dup'}  (pas sentinel bucket'ı aldı → skor YOK)
--
-- Toggle (unvote):
--   select flag_group_toggle_pass_vote('<room>','<B>','<B tok>', <gs>, <r>); -- voted:true (1/2)
--   select flag_group_toggle_pass_vote('<room>','<B>','<B tok>', <gs>, <r>); -- voted:false (0/2)
--
-- Claim-önce (pas reclose edemez):
--   select flag_group_submit_claim('<room>','<B>','<B tok>','<flag>');       -- claimed:true
--   select flag_group_toggle_pass_vote('<room>','<C>','<C tok>', <gs>, <r>); -- resolved:true, passed:false
-- ============================================================================
