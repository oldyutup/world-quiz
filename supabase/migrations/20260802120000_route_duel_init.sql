-- ============================================================================
-- Route Duel — Rota Modu Online 1v1 (izole tablo + RPC seti) + resolver ekleme
-- ============================================================================
-- AMAÇ
-- ----
-- Offline Rota Modu'na (RouteGame.tsx, DB'siz) DOKUNMADAN, sunucu-otoriter
-- "Rota Modu — Online 1v1" ekler: iki oyuncu aynı başlangıç→hedef rotasında
-- yarışır; hedefe İLK geçerli biçimde ulaşan turu kazanır. Tur sayısı
-- (3/5/10/15) ve rota uzunluğu (5 / 7 / 7+ ara ülke) host ayarıdır.
--
-- TASARIM KARARLARI
-- -----------------
--   • İzole tablo seti (route_duel_*) — projedeki kanon (wheel_duel_*,
--     flag_group_*, conquest_* hepsi izole). Şema/RPC iskeleti
--     flag_group_init (hardened-from-birth) + wheel_duel 1v1 desenlerinden.
--   • ROTA ÜRETİMİ TAMAMEN SUNUCUDA: route_duel_pool tablosu, canonical
--     client grafından (src/data/countries.ts NEIGHBOR_GRAPH) codegen ile
--     üretilen TAM-mesafe sırasız çift havuzudur
--     (scripts/routeDuel/build-route-duel-data.ts). "Ara ülke" = en kısa
--     yolun sınır-geçişi sayısı − 1:
--         '5'     → intermediates = 5   (en kısa yol 6 geçiş)
--         '7'     → intermediates = 7   (en kısa yol 8 geçiş)
--         '7plus' → intermediates ∈ {8, 9}  (10+ ASLA; 7'ye düşülmez)
--     Client rota SEÇEMEZ; her turda sunucu havuzdan kullanılmamış bir çift
--     çeker (A→B ile B→A aynı pair_key = least|greatest → aynı maç + rövanşta
--     tekrar gelmez; used_pair_keys oda satırında sunucu-otoriter tutulur).
--   • HAMLE DOĞRULAMA SUNUCUDA: route_duel_graph (aynı codegen'den seed'li
--     simetrik komşuluk grafı). Client'ın "komşu" iddiasına güvenilmez;
--     submit_move mevcut konumu route_duel_players.current_key'den okur
--     (client current_country GÖNDEREMEZ) ve komşuluğu grafa karşı doğrular.
--   • ATOMİK İLK-BİTİREN: route_duel_claims UNIQUE(room_id, game_seq, round)
--     + tüm mutasyonlar oda satırını FOR UPDATE kilitler (flag_group modeli)
--     → iki tamamlama yarışırsa yalnız İLK sunucu işlemi turu kazanır; skor
--     (players.score) yalnız sunucu artırır.
--   • TUR SÜRESİ SUNUCU-OTORİTER: offline modda süre sınırı YOK → online
--     için sabit 60 sn (round_deadline = round_started_at + 60s; started_at
--     = now() + 3s ortak geri sayım). Süre bitince kimse puan almaz, tur
--     ilerler. advance_round yalnız tur GERÇEKTEN bittiyse (kazanan var VEYA
--     deadline geçti) çalışır → erken tur atlama imkânsız.
--   • BERABERLİK → UZATMA: son tur sonunda skorlar eşitse yeni, daha önce
--     kullanılmamış rotayla sudden-death turu; ilk uzatma turunu kazanan
--     maçı alır (advance_round genel kuralı: current_round >= total_rounds
--     VE skor farklıysa finalize, aksi hâlde yeni tur).
--   • RÖVANŞ: TEK sunucu-otoriter RPC (route_duel_request_rematch) — oy kaydı
--     ve İKİNCİ ONAYDA yeni maç başlatma AYNI çağrının AYNI transaction'ında
--     (FOR UPDATE + status='finished' guard). Host client'ının ayrıca bir
--     process adımı tetiklemesi GEREKMEZ: host sekmesi arka planda ya da
--     bağlantısız olsa bile guest'in ikinci onayı maçı sunucuda başlatır.
--     Skorlar sıfır, ayarlar korunur, game_seq/match_seq/current_match_id
--     yenilenir, used_pair_keys KORUNUR → önceki maçın rotaları rövanşta
--     gelmez. Ayrı bir process_rematch RPC'si YOK (authenticated'a açık
--     ikinci bir "maç başlat" yüzeyi bilinçli olarak bırakılmaz).
--   • LEAVE/DISCONNECT: wheel_duel_leave_finishes_active_match +
--     duel_handle_disconnect modeli — playing'de leave=forfeit (kalan
--     kazanır), lobby'de host leave = oda DELETE (cascade); kopuş sunucuda
--     last_seen_at eşiğiyle doğrulanır (client iddiasına güvenilmez).
--   • HIZLI EŞLEŞ: flag_duel/country_duel queue deseni (FOR UPDATE SKIP
--     LOCKED, LEAST bracket, blok dışlama, stale self-heal). Eşleşme AYNI
--     total_rounds + AYNI route_length ister. claim_token'lar queue
--     satırında taşınır → wheel'deki client-side token enjeksiyonu yok;
--     route_duel_player_claims tablosuna client hiç YAZAMAZ.
--
-- GÜVENLİK (hardened-from-birth)
-- ------------------------------
--   • rooms/players/claims: SELECT herkese açık (realtime + oda kodu lookup
--     için zorunlu; rota görevi iki oyuncuya da zaten görünür — gizli bilgi
--     yok). INSERT/UPDATE/DELETE policy YOK → tüm yazımlar SECURITY DEFINER
--     RPC'leri üzerinden.
--   • route_duel_player_claims: policy YOK + grant YOK + realtime DIŞI
--     (token asla client'a/publikasyona çıkmaz; yazan tek yol RPC'ler).
--   • route_duel_graph / route_duel_pool: policy YOK + grant YOK (yalnız
--     sunucu okur; client aynı veriyi kendi countries.ts'inden bilir).
--   • route_duel_queue: SELECT yalnız kendi satırı (authenticated); DML
--     grant'leri temiz — yazımlar yalnız queue RPC'leri.
--   • Her RPC: SECURITY DEFINER + sabit search_path; authorize_player /
--     authorize_host (claim_token VEYA auth.uid() kanıtı); profile_id ↔
--     auth.uid() tutarlılığı; oda üyeliği her mutasyonda doğrulanır.
--   • Client player_id/winner/score/elapsed/current_round BELİRLEYEMEZ:
--     kazanan claim insert'i + skor artışı + tur ilerletme + süre hep sunucu.
--   • Kapasite KESİN 2; aynı kullanıcı (profile_id) aynı odaya ikinci kez
--     giremez; playing odaya join reddedilir.
--
-- BAĞIMLILIKLAR
-- -------------
--   • public.assert_display_name_allowed(text, uuid, text)  (20260704120000)
--   • public._duel_messages_antispam_check(text, text, text) (20260616120000)
--   • public.is_blocked_between(uuid, uuid)                  (20260716160000)
--   • public.duel_messages (paylaşımlı chat; 'route_duel:<code>' namespaced
--     anahtar — flag_group_send_message izolasyon modeli)
--
-- DOKUNULMAYAN
-- ------------
--   • duel_*, duel_group_*, wheel_*, flag_*, conquest_*, tevatur_*, profiles,
--     xp_events, gold_transactions — hiçbirine dokunulmaz. Gold/XP YOK.
--   • 20260801120000_room_code_resolver.sql DEĞİŞTİRİLMEZ; resolver bu
--     dosyada CREATE OR REPLACE ile route_duel_rooms'u da tarayacak şekilde
--     YENİDEN tanımlanır (forward-only).
--
-- IDEMPOTENT: create table if not exists / create or replace / drop policy
--   if exists + create / publication guard / seed upsert.
-- DEPLOY: migration + client BİRLİKTE deploy edilmeli. DEPLOY EDİLMEDİ.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Sunucu-otoriter statik veri tabloları (codegen seed'li)
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.route_duel_graph (
  country_key text   primary key,
  neighbors   text[] not null
);

create table if not exists public.route_duel_pool (
  -- pair_key = least(a,b) || '|' || greatest(a,b)  (codegen a<b garanti eder)
  -- → A→B ile B→A AYNI havuz kaydıdır; used_pair_keys bu anahtarla tutulur.
  pair_key      text primary key,
  a_key         text not null,
  b_key         text not null,
  intermediates int  not null check (intermediates in (5, 7, 8, 9))
);

create index if not exists route_duel_pool_intermediates_idx
  on public.route_duel_pool (intermediates);


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Oda / oyuncu / claim / token / queue tabloları
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.route_duel_rooms (
  id                     uuid        primary key default gen_random_uuid(),
  code                   text        not null unique,
  status                 text        not null default 'waiting'
                                     check (status in ('waiting','playing','finished')),
  total_rounds           int         not null default 5
                                     check (total_rounds in (3, 5, 10, 15)),
  route_length           text        not null default '7'
                                     check (route_length in ('5','7','7plus')),
  host_player_id         uuid        null,
  -- game_seq: her maç başlangıcında (start_game / request_rematch'in ikinci
  -- onayı / quick_match) monoton artar → claim tekilliği (room, game_seq,
  -- round) maç oturumuna bağlanır.
  game_seq               int         not null default 0,
  current_round          int         not null default 0,
  -- Aktif turun sunucu-otoriter rota görevi (iki oyuncuya da AYNI):
  round_start_key        text        null,
  round_target_key       text        null,
  round_pair_key         text        null,
  -- Ortak geri sayım + sunucu-otoriter tur süresi:
  --   round_started_at = now() + 3s (geri sayım), round_deadline = +60s oyun.
  round_started_at       timestamptz null,
  round_deadline         timestamptz null,
  -- Turun kazananı (claim insert'iyle AYNI transaction'da yazılır; timeout
  -- turunda NULL kalır). begin_round yeni turda sıfırlar.
  round_winner_player_id uuid        null,
  round_decided_at       timestamptz null,
  -- Bu ODADA şimdiye kadar kullanılan rotalar (maçlar + rövanşlar boyunca
  -- birikir; rövanş başlangıcı SIFIRLAMAZ → önceki maçın rotaları dışlanır).
  used_pair_keys         text[]      not null default '{}',
  rematch_requested_by   uuid[]      not null default '{}',
  match_seq              int         not null default 1,
  current_match_id       uuid        not null default gen_random_uuid(),
  room_source            text        not null default 'manual'
                                     check (room_source in ('manual','quick_match')),
  winner_player_id       uuid        null,
  finished_reason        text        null,
  started_at             timestamptz null,
  finished_at            timestamptz null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists route_duel_rooms_status_idx
  on public.route_duel_rooms (status);
create index if not exists route_duel_rooms_created_at_idx
  on public.route_duel_rooms (created_at desc);

alter table public.route_duel_rooms replica identity full;


create table if not exists public.route_duel_players (
  id           uuid        primary key,
  room_id      uuid        not null
                             references public.route_duel_rooms(id) on delete cascade,
  name         text        not null,
  is_host      boolean     not null default false,
  score        int         not null default 0 check (score >= 0),
  -- Sunucu-otoriter konum: submit_move yalnız BU değerin grafa göre komşusuna
  -- geçiş kabul eder. begin_round her turda start_key'e sıfırlar.
  current_key  text        null,
  path         text[]      not null default '{}',
  profile_id   uuid        null,
  guest_id     text        null,
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists route_duel_players_room_id_idx
  on public.route_duel_players (room_id);
create index if not exists route_duel_players_joined_at_idx
  on public.route_duel_players (room_id, joined_at);

alter table public.route_duel_players replica identity full;


create table if not exists public.route_duel_claims (
  id         bigint      generated always as identity primary key,
  room_id    uuid        not null
                           references public.route_duel_rooms(id) on delete cascade,
  player_id  uuid        not null
                           references public.route_duel_players(id) on delete cascade,
  game_seq   int         not null,
  round      int         not null,
  -- Kazananın attığı sınır-geçişi sayısı (audit/ekran).
  steps      int         not null,
  created_at timestamptz not null default now(),
  -- ATOMİK TEK-KAZANAN: (oda, maç oturumu, tur) başına yalnız BİR claim.
  unique (room_id, game_seq, round)
);

create index if not exists route_duel_claims_room_id_idx
  on public.route_duel_claims (room_id);

alter table public.route_duel_claims replica identity full;


-- Özel claim-token deposu (realtime DIŞI, HİÇBİR client grant'i YOK; yazan
-- tek yol SECURITY DEFINER RPC'leri — wheel'deki client token enjeksiyonu
-- deseni bilinçli olarak KULLANILMAZ).
create table if not exists public.route_duel_player_claims (
  player_id   uuid        primary key
                          references public.route_duel_players(id) on delete cascade,
  claim_token uuid        not null,
  created_at  timestamptz not null default now()
);


-- Hızlı Eşleş kuyruğu (flag_duel_queue deseni + claim_token taşır).
create table if not exists public.route_duel_queue (
  profile_id      uuid        primary key,
  player_id       uuid        not null,
  player_name     text        not null,
  claim_token     uuid        not null,
  total_rounds    int         not null check (total_rounds in (3, 5, 10, 15)),
  route_length    text        not null check (route_length in ('5','7','7plus')),
  mode_level      int         not null default 1 check (mode_level >= 1),
  max_level_diff  int         not null default 0 check (max_level_diff >= 0),
  matched_room_id uuid        null references public.route_duel_rooms(id) on delete set null,
  expires_at      timestamptz not null default (now() + interval '45 seconds'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists route_duel_queue_search_idx
  on public.route_duel_queue (total_rounds, route_length, mode_level)
  where matched_room_id is null;
create index if not exists route_duel_queue_expires_idx
  on public.route_duel_queue (expires_at);

alter table public.route_duel_queue replica identity full;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) updated_at trigger + boş oda cleanup trigger
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists route_duel_rooms_set_updated_at on public.route_duel_rooms;
create trigger route_duel_rooms_set_updated_at
  before update on public.route_duel_rooms
  for each row
  execute function public.route_duel_set_updated_at();


-- Son oyuncu çıkınca odayı sil (duel_group_room_cleanup / flag_group deseni).
create or replace function public.route_duel_rooms_cleanup_after_player_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
begin
  select count(*) into remaining
    from public.route_duel_players
   where room_id = old.room_id;

  if remaining = 0 then
    delete from public.route_duel_rooms where id = old.room_id;
  end if;

  return old;
end;
$$;

drop trigger if exists route_duel_players_cleanup_after_delete
  on public.route_duel_players;
create trigger route_duel_players_cleanup_after_delete
  after delete on public.route_duel_players
  for each row
  execute function public.route_duel_rooms_cleanup_after_player_delete();


-- ────────────────────────────────────────────────────────────────────────────
-- 4) Row Level Security + GRANT lockdown
-- ----------------------------------------------------------------------------
-- rooms/players/claims SELECT'i herkese açık (flag_group_init'teki gerekçe:
-- misafir realtime'ı claim_token'ı RLS'e taşıyamaz; rota görevi zaten iki
-- oyuncuya da görünür — önden sızacak gizli bilgi YOK: gelecek turların
-- rotası begin_round anına kadar DB'de tutulmaz, havuz tablosu kilitli).
-- graph/pool/player_claims: policy + grant YOK → yalnız sunucu.
-- queue: SELECT yalnız kendi satırı (flag_duel_queue lockdown deseni).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.route_duel_graph         enable row level security;
alter table public.route_duel_pool          enable row level security;
alter table public.route_duel_rooms         enable row level security;
alter table public.route_duel_players       enable row level security;
alter table public.route_duel_claims        enable row level security;
alter table public.route_duel_player_claims enable row level security;
alter table public.route_duel_queue         enable row level security;

-- graph / pool / player_claims: hiçbir policy yok + tüm grant'ler temiz.
revoke all on table public.route_duel_graph         from anon, authenticated, public;
revoke all on table public.route_duel_pool          from anon, authenticated, public;
revoke all on table public.route_duel_player_claims from anon, authenticated, public;

-- rooms: SELECT herkese; yazma policy YOK → RPC-only.
drop policy if exists "route_duel_rooms_select_public" on public.route_duel_rooms;
create policy "route_duel_rooms_select_public"
  on public.route_duel_rooms for select to anon, authenticated using (true);
revoke insert, update, delete on table public.route_duel_rooms from anon, authenticated;

-- players: SELECT herkese; yazma policy YOK → RPC-only.
drop policy if exists "route_duel_players_select_public" on public.route_duel_players;
create policy "route_duel_players_select_public"
  on public.route_duel_players for select to anon, authenticated using (true);
revoke insert, update, delete on table public.route_duel_players from anon, authenticated;

-- claims: SELECT herkese; yazma policy YOK → RPC-only.
drop policy if exists "route_duel_claims_select_public" on public.route_duel_claims;
create policy "route_duel_claims_select_public"
  on public.route_duel_claims for select to anon, authenticated using (true);
revoke insert, update, delete on table public.route_duel_claims from anon, authenticated;

-- queue: SELECT yalnız kendi satırı; DML grant'leri temiz (RPC-only yazım).
drop policy if exists "route_duel_queue_select_own" on public.route_duel_queue;
create policy "route_duel_queue_select_own"
  on public.route_duel_queue for select to authenticated
  using (profile_id = auth.uid());
revoke all on table public.route_duel_queue from anon, public;
revoke all on table public.route_duel_queue from authenticated;
grant  select on table public.route_duel_queue to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) Realtime publication (player_claims + graph + pool KASTEN dahil değil)
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='route_duel_rooms') then
    execute 'alter publication supabase_realtime add table public.route_duel_rooms';
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='route_duel_players') then
    execute 'alter publication supabase_realtime add table public.route_duel_players';
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='route_duel_claims') then
    execute 'alter publication supabase_realtime add table public.route_duel_claims';
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='route_duel_queue') then
    execute 'alter publication supabase_realtime add table public.route_duel_queue';
  end if;
end$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) SEED — codegen çıktısı (scripts/routeDuel/build-route-duel-data.ts)
-- ----------------------------------------------------------------------------
-- Aşağıdaki blok scripts/routeDuel/route-duel-seed.generated.sql dosyasının
-- AYNEN gömülmüş hâlidir (elle düzenleme; canonical kaynak countries.ts).
-- ────────────────────────────────────────────────────────────────────────────

-- route-duel-seed.generated.sql — OTOMATİK ÜRETİM (elle düzenleme).
-- Kaynak: src/data/countries.ts NEIGHBOR_GRAPH.
-- Yeniden üret: npx tsx scripts/routeDuel/build-route-duel-data.ts
-- Graf: 142 düğüm. Havuz: 2660 sırasız çift (mid=5:805, mid=7:722, mid=8:656, mid=9:477).

insert into public.route_duel_graph (country_key, neighbors) values
  ('Afghanistan', array['China','Iran','Pakistan','Tajikistan','Turkmenistan','Uzbekistan']),
  ('Albania', array['Greece','Kosovo','Montenegro','North Macedonia','Serbia']),
  ('Algeria', array['Chad','Libya','Mali','Mauritania','Morocco','Niger','Tunisia']),
  ('Angola', array['Democratic Republic of Congo','Namibia','Republic of Congo','Zambia']),
  ('Argentina', array['Bolivia','Brazil','Chile','Paraguay','Uruguay']),
  ('Armenia', array['Azerbaijan','Georgia','Iran','Turkey']),
  ('Austria', array['Czech Republic','Germany','Hungary','Italy','Slovakia','Slovenia','Switzerland']),
  ('Azerbaijan', array['Armenia','Georgia','Iran','Russia','Turkey']),
  ('Bangladesh', array['India','Myanmar']),
  ('Belarus', array['Latvia','Lithuania','Poland','Russia','Ukraine']),
  ('Belgium', array['France','Germany','Luxembourg','Netherlands']),
  ('Belize', array['Guatemala','Mexico']),
  ('Benin', array['Burkina Faso','Niger','Nigeria','Togo']),
  ('Bhutan', array['China','India']),
  ('Bolivia', array['Argentina','Brazil','Chile','Paraguay','Peru']),
  ('Bosnia and Herzegovina', array['Croatia','Montenegro','Serbia']),
  ('Botswana', array['Namibia','South Africa','Zambia','Zimbabwe']),
  ('Brazil', array['Argentina','Bolivia','Colombia','Guyana','Paraguay','Peru','Suriname','Uruguay','Venezuela']),
  ('Bulgaria', array['Greece','North Macedonia','Romania','Serbia','Turkey']),
  ('Burkina Faso', array['Benin','Ghana','Ivory Coast','Mali','Niger','Togo']),
  ('Burundi', array['Democratic Republic of Congo','Rwanda','Tanzania']),
  ('Cambodia', array['Laos','Thailand','Vietnam']),
  ('Cameroon', array['Central African Republic','Chad','Equatorial Guinea','Gabon','Nigeria','Republic of Congo']),
  ('Canada', array['USA']),
  ('Central African Republic', array['Cameroon','Chad','Democratic Republic of Congo','Republic of Congo','South Sudan','Sudan']),
  ('Chad', array['Algeria','Cameroon','Central African Republic','Libya','Niger','Nigeria','Sudan']),
  ('Chile', array['Argentina','Bolivia','Peru']),
  ('China', array['Afghanistan','Bhutan','India','Kazakhstan','Kyrgyzstan','Laos','Mongolia','Myanmar','Nepal','North Korea','Pakistan','Russia','Tajikistan','Vietnam']),
  ('Colombia', array['Brazil','Ecuador','Panama','Peru','Venezuela']),
  ('Costa Rica', array['Nicaragua','Panama']),
  ('Croatia', array['Bosnia and Herzegovina','Hungary','Montenegro','Serbia','Slovenia']),
  ('Czech Republic', array['Austria','Germany','Poland','Slovakia']),
  ('Democratic Republic of Congo', array['Angola','Burundi','Central African Republic','Republic of Congo','Rwanda','South Sudan','Tanzania','Uganda','Zambia']),
  ('Denmark', array['Germany']),
  ('Djibouti', array['Eritrea','Ethiopia','Somalia']),
  ('Ecuador', array['Colombia','Peru']),
  ('Egypt', array['Israel','Libya','Sudan']),
  ('El Salvador', array['Guatemala','Honduras']),
  ('Equatorial Guinea', array['Cameroon','Gabon']),
  ('Eritrea', array['Djibouti','Ethiopia','Sudan']),
  ('Estonia', array['Latvia','Russia']),
  ('Eswatini', array['Mozambique','South Africa']),
  ('Ethiopia', array['Djibouti','Eritrea','Kenya','Somalia','South Sudan','Sudan']),
  ('Finland', array['Norway','Russia','Sweden']),
  ('France', array['Belgium','Germany','Italy','Luxembourg','Spain','Switzerland']),
  ('Gabon', array['Cameroon','Equatorial Guinea','Republic of Congo']),
  ('Georgia', array['Armenia','Azerbaijan','Russia','Turkey']),
  ('Germany', array['Austria','Belgium','Czech Republic','Denmark','France','Luxembourg','Netherlands','Poland','Switzerland']),
  ('Ghana', array['Burkina Faso','Ivory Coast','Togo']),
  ('Greece', array['Albania','Bulgaria','North Macedonia','Turkey']),
  ('Guatemala', array['Belize','El Salvador','Honduras','Mexico']),
  ('Guinea', array['Guinea-Bissau','Ivory Coast','Liberia','Mali','Senegal','Sierra Leone']),
  ('Guinea-Bissau', array['Guinea','Senegal']),
  ('Guyana', array['Brazil','Suriname','Venezuela']),
  ('Honduras', array['El Salvador','Guatemala','Nicaragua']),
  ('Hungary', array['Austria','Croatia','Romania','Serbia','Slovakia','Slovenia','Ukraine']),
  ('India', array['Bangladesh','Bhutan','China','Myanmar','Nepal','Pakistan']),
  ('Iran', array['Afghanistan','Armenia','Azerbaijan','Iraq','Pakistan','Turkey','Turkmenistan']),
  ('Iraq', array['Iran','Jordan','Kuwait','Saudi Arabia','Syria','Turkey']),
  ('Israel', array['Egypt','Jordan','Lebanon','Syria']),
  ('Italy', array['Austria','France','Slovenia','Switzerland']),
  ('Ivory Coast', array['Burkina Faso','Ghana','Guinea','Liberia','Mali']),
  ('Jordan', array['Iraq','Israel','Saudi Arabia','Syria']),
  ('Kazakhstan', array['China','Kyrgyzstan','Russia','Tajikistan','Turkmenistan','Uzbekistan']),
  ('Kenya', array['Ethiopia','Somalia','South Sudan','Tanzania','Uganda']),
  ('Kosovo', array['Albania','Montenegro','North Macedonia','Serbia']),
  ('Kuwait', array['Iraq','Saudi Arabia']),
  ('Kyrgyzstan', array['China','Kazakhstan','Tajikistan','Uzbekistan']),
  ('Laos', array['Cambodia','China','Myanmar','Thailand','Vietnam']),
  ('Latvia', array['Belarus','Estonia','Lithuania','Russia']),
  ('Lebanon', array['Israel','Syria']),
  ('Lesotho', array['South Africa']),
  ('Liberia', array['Guinea','Ivory Coast','Sierra Leone']),
  ('Libya', array['Algeria','Chad','Egypt','Niger','Sudan','Tunisia']),
  ('Lithuania', array['Belarus','Latvia','Poland','Russia']),
  ('Luxembourg', array['Belgium','France','Germany']),
  ('Malawi', array['Mozambique','Tanzania','Zambia']),
  ('Malaysia', array['Thailand']),
  ('Mali', array['Algeria','Burkina Faso','Guinea','Ivory Coast','Mauritania','Niger','Senegal']),
  ('Mauritania', array['Algeria','Mali','Morocco','Senegal']),
  ('Mexico', array['Belize','Guatemala','USA']),
  ('Moldova', array['Romania','Ukraine']),
  ('Mongolia', array['China','Russia']),
  ('Montenegro', array['Albania','Bosnia and Herzegovina','Croatia','Kosovo','North Macedonia','Serbia']),
  ('Morocco', array['Algeria','Mauritania','Spain']),
  ('Mozambique', array['Eswatini','Malawi','South Africa','Tanzania','Zambia','Zimbabwe']),
  ('Myanmar', array['Bangladesh','China','India','Laos','Thailand']),
  ('Namibia', array['Angola','Botswana','South Africa','Zambia']),
  ('Nepal', array['China','India']),
  ('Netherlands', array['Belgium','Germany']),
  ('Nicaragua', array['Costa Rica','Honduras']),
  ('Niger', array['Algeria','Benin','Burkina Faso','Chad','Libya','Mali','Nigeria']),
  ('Nigeria', array['Benin','Cameroon','Chad','Niger']),
  ('North Korea', array['China','Russia','South Korea']),
  ('North Macedonia', array['Albania','Bulgaria','Greece','Kosovo','Montenegro','Serbia']),
  ('Norway', array['Finland','Russia','Sweden']),
  ('Oman', array['Saudi Arabia','UAE','Yemen']),
  ('Pakistan', array['Afghanistan','China','India','Iran']),
  ('Panama', array['Colombia','Costa Rica']),
  ('Paraguay', array['Argentina','Bolivia','Brazil']),
  ('Peru', array['Bolivia','Brazil','Chile','Colombia','Ecuador']),
  ('Poland', array['Belarus','Czech Republic','Germany','Lithuania','Russia','Slovakia','Ukraine']),
  ('Portugal', array['Spain']),
  ('Qatar', array['Saudi Arabia','UAE']),
  ('Republic of Congo', array['Angola','Cameroon','Central African Republic','Democratic Republic of Congo','Gabon']),
  ('Romania', array['Bulgaria','Hungary','Moldova','Serbia','Ukraine']),
  ('Russia', array['Azerbaijan','Belarus','China','Estonia','Finland','Georgia','Kazakhstan','Latvia','Lithuania','Mongolia','North Korea','Norway','Poland','Ukraine']),
  ('Rwanda', array['Burundi','Democratic Republic of Congo','Tanzania','Uganda']),
  ('Saudi Arabia', array['Iraq','Jordan','Kuwait','Oman','Qatar','UAE','Yemen']),
  ('Senegal', array['Guinea','Guinea-Bissau','Mali','Mauritania']),
  ('Serbia', array['Albania','Bosnia and Herzegovina','Bulgaria','Croatia','Hungary','Kosovo','Montenegro','North Macedonia','Romania']),
  ('Sierra Leone', array['Guinea','Liberia']),
  ('Slovakia', array['Austria','Czech Republic','Hungary','Poland','Ukraine']),
  ('Slovenia', array['Austria','Croatia','Hungary','Italy']),
  ('Somalia', array['Djibouti','Ethiopia','Kenya']),
  ('South Africa', array['Botswana','Eswatini','Lesotho','Mozambique','Namibia','Zimbabwe']),
  ('South Korea', array['North Korea']),
  ('South Sudan', array['Central African Republic','Democratic Republic of Congo','Ethiopia','Kenya','Sudan','Uganda']),
  ('Spain', array['France','Morocco','Portugal']),
  ('Sudan', array['Central African Republic','Chad','Egypt','Eritrea','Ethiopia','Libya','South Sudan']),
  ('Suriname', array['Brazil','Guyana']),
  ('Sweden', array['Finland','Norway']),
  ('Switzerland', array['Austria','France','Germany','Italy']),
  ('Syria', array['Iraq','Israel','Jordan','Lebanon','Turkey']),
  ('Tajikistan', array['Afghanistan','China','Kazakhstan','Kyrgyzstan','Uzbekistan']),
  ('Tanzania', array['Burundi','Democratic Republic of Congo','Kenya','Malawi','Mozambique','Rwanda','Uganda','Zambia']),
  ('Thailand', array['Cambodia','Laos','Malaysia','Myanmar']),
  ('Togo', array['Benin','Burkina Faso','Ghana']),
  ('Tunisia', array['Algeria','Libya']),
  ('Turkey', array['Armenia','Azerbaijan','Bulgaria','Georgia','Greece','Iran','Iraq','Syria']),
  ('Turkmenistan', array['Afghanistan','Iran','Kazakhstan','Uzbekistan']),
  ('UAE', array['Oman','Qatar','Saudi Arabia']),
  ('USA', array['Canada','Mexico']),
  ('Uganda', array['Democratic Republic of Congo','Kenya','Rwanda','South Sudan','Tanzania']),
  ('Ukraine', array['Belarus','Hungary','Moldova','Poland','Romania','Russia','Slovakia']),
  ('Uruguay', array['Argentina','Brazil']),
  ('Uzbekistan', array['Afghanistan','Kazakhstan','Kyrgyzstan','Tajikistan','Turkmenistan']),
  ('Venezuela', array['Brazil','Colombia','Guyana']),
  ('Vietnam', array['Cambodia','China','Laos']),
  ('Yemen', array['Oman','Saudi Arabia']),
  ('Zambia', array['Angola','Botswana','Democratic Republic of Congo','Malawi','Mozambique','Namibia','Tanzania','Zimbabwe']),
  ('Zimbabwe', array['Botswana','Mozambique','South Africa','Zambia'])
on conflict (country_key) do update set neighbors = excluded.neighbors;

insert into public.route_duel_pool (pair_key, a_key, b_key, intermediates) values
  ('Afghanistan|Angola', 'Afghanistan', 'Angola', 8),
  ('Afghanistan|Benin', 'Afghanistan', 'Benin', 7),
  ('Afghanistan|Botswana', 'Afghanistan', 'Botswana', 9),
  ('Afghanistan|Burkina Faso', 'Afghanistan', 'Burkina Faso', 7),
  ('Afghanistan|Burundi', 'Afghanistan', 'Burundi', 8),
  ('Afghanistan|Cameroon', 'Afghanistan', 'Cameroon', 7),
  ('Afghanistan|Democratic Republic of Congo', 'Afghanistan', 'Democratic Republic of Congo', 7),
  ('Afghanistan|Djibouti', 'Afghanistan', 'Djibouti', 7),
  ('Afghanistan|Equatorial Guinea', 'Afghanistan', 'Equatorial Guinea', 8),
  ('Afghanistan|Gabon', 'Afghanistan', 'Gabon', 8),
  ('Afghanistan|Ghana', 'Afghanistan', 'Ghana', 8),
  ('Afghanistan|Guinea', 'Afghanistan', 'Guinea', 8),
  ('Afghanistan|Guinea-Bissau', 'Afghanistan', 'Guinea-Bissau', 9),
  ('Afghanistan|Italy', 'Afghanistan', 'Italy', 5),
  ('Afghanistan|Ivory Coast', 'Afghanistan', 'Ivory Coast', 8),
  ('Afghanistan|Kenya', 'Afghanistan', 'Kenya', 7),
  ('Afghanistan|Liberia', 'Afghanistan', 'Liberia', 9),
  ('Afghanistan|Libya', 'Afghanistan', 'Libya', 5),
  ('Afghanistan|Malawi', 'Afghanistan', 'Malawi', 9),
  ('Afghanistan|Mali', 'Afghanistan', 'Mali', 7),
  ('Afghanistan|Mauritania', 'Afghanistan', 'Mauritania', 7),
  ('Afghanistan|Mozambique', 'Afghanistan', 'Mozambique', 9),
  ('Afghanistan|Namibia', 'Afghanistan', 'Namibia', 9),
  ('Afghanistan|Nigeria', 'Afghanistan', 'Nigeria', 7),
  ('Afghanistan|Republic of Congo', 'Afghanistan', 'Republic of Congo', 7),
  ('Afghanistan|Rwanda', 'Afghanistan', 'Rwanda', 8),
  ('Afghanistan|Senegal', 'Afghanistan', 'Senegal', 8),
  ('Afghanistan|Sierra Leone', 'Afghanistan', 'Sierra Leone', 9),
  ('Afghanistan|Somalia', 'Afghanistan', 'Somalia', 7),
  ('Afghanistan|Spain', 'Afghanistan', 'Spain', 5),
  ('Afghanistan|Sudan', 'Afghanistan', 'Sudan', 5),
  ('Afghanistan|Tanzania', 'Afghanistan', 'Tanzania', 8),
  ('Afghanistan|Togo', 'Afghanistan', 'Togo', 8),
  ('Afghanistan|Uganda', 'Afghanistan', 'Uganda', 7),
  ('Afghanistan|Zambia', 'Afghanistan', 'Zambia', 8),
  ('Afghanistan|Zimbabwe', 'Afghanistan', 'Zimbabwe', 9),
  ('Albania|Angola', 'Albania', 'Angola', 8),
  ('Albania|Bangladesh', 'Albania', 'Bangladesh', 5),
  ('Albania|Benin', 'Albania', 'Benin', 7),
  ('Albania|Bhutan', 'Albania', 'Bhutan', 5),
  ('Albania|Botswana', 'Albania', 'Botswana', 9),
  ('Albania|Burkina Faso', 'Albania', 'Burkina Faso', 7),
  ('Albania|Burundi', 'Albania', 'Burundi', 8),
  ('Albania|Cameroon', 'Albania', 'Cameroon', 7),
  ('Albania|Democratic Republic of Congo', 'Albania', 'Democratic Republic of Congo', 7),
  ('Albania|Djibouti', 'Albania', 'Djibouti', 7),
  ('Albania|Equatorial Guinea', 'Albania', 'Equatorial Guinea', 8),
  ('Albania|Gabon', 'Albania', 'Gabon', 8),
  ('Albania|Ghana', 'Albania', 'Ghana', 8),
  ('Albania|Guinea', 'Albania', 'Guinea', 8),
  ('Albania|Guinea-Bissau', 'Albania', 'Guinea-Bissau', 9),
  ('Albania|Ivory Coast', 'Albania', 'Ivory Coast', 8),
  ('Albania|Kenya', 'Albania', 'Kenya', 7),
  ('Albania|Kyrgyzstan', 'Albania', 'Kyrgyzstan', 5),
  ('Albania|Laos', 'Albania', 'Laos', 5),
  ('Albania|Liberia', 'Albania', 'Liberia', 9),
  ('Albania|Libya', 'Albania', 'Libya', 5),
  ('Albania|Malawi', 'Albania', 'Malawi', 9),
  ('Albania|Malaysia', 'Albania', 'Malaysia', 7),
  ('Albania|Mali', 'Albania', 'Mali', 7),
  ('Albania|Mauritania', 'Albania', 'Mauritania', 7),
  ('Albania|Mozambique', 'Albania', 'Mozambique', 9),
  ('Albania|Myanmar', 'Albania', 'Myanmar', 5),
  ('Albania|Namibia', 'Albania', 'Namibia', 9),
  ('Albania|Nepal', 'Albania', 'Nepal', 5),
  ('Albania|Nigeria', 'Albania', 'Nigeria', 7),
  ('Albania|Republic of Congo', 'Albania', 'Republic of Congo', 7),
  ('Albania|Rwanda', 'Albania', 'Rwanda', 8),
  ('Albania|Senegal', 'Albania', 'Senegal', 8),
  ('Albania|Sierra Leone', 'Albania', 'Sierra Leone', 9),
  ('Albania|Somalia', 'Albania', 'Somalia', 7),
  ('Albania|South Korea', 'Albania', 'South Korea', 5),
  ('Albania|Spain', 'Albania', 'Spain', 5),
  ('Albania|Sudan', 'Albania', 'Sudan', 5),
  ('Albania|Sweden', 'Albania', 'Sweden', 5),
  ('Albania|Tanzania', 'Albania', 'Tanzania', 8),
  ('Albania|Togo', 'Albania', 'Togo', 8),
  ('Albania|Uganda', 'Albania', 'Uganda', 7),
  ('Albania|Vietnam', 'Albania', 'Vietnam', 5),
  ('Albania|Zambia', 'Albania', 'Zambia', 8),
  ('Albania|Zimbabwe', 'Albania', 'Zimbabwe', 9),
  ('Algeria|Armenia', 'Algeria', 'Armenia', 5),
  ('Algeria|Azerbaijan', 'Algeria', 'Azerbaijan', 5),
  ('Algeria|Bangladesh', 'Algeria', 'Bangladesh', 8),
  ('Algeria|Belarus', 'Algeria', 'Belarus', 5),
  ('Algeria|Bhutan', 'Algeria', 'Bhutan', 7),
  ('Algeria|Bulgaria', 'Algeria', 'Bulgaria', 5),
  ('Algeria|Cambodia', 'Algeria', 'Cambodia', 8),
  ('Algeria|Croatia', 'Algeria', 'Croatia', 5),
  ('Algeria|Eswatini', 'Algeria', 'Eswatini', 5),
  ('Algeria|Georgia', 'Algeria', 'Georgia', 5),
  ('Algeria|Greece', 'Algeria', 'Greece', 5),
  ('Algeria|Hungary', 'Algeria', 'Hungary', 5),
  ('Algeria|India', 'Algeria', 'India', 7),
  ('Algeria|Iran', 'Algeria', 'Iran', 5),
  ('Algeria|Kosovo', 'Algeria', 'Kosovo', 7),
  ('Algeria|Kuwait', 'Algeria', 'Kuwait', 5),
  ('Algeria|Kyrgyzstan', 'Algeria', 'Kyrgyzstan', 7),
  ('Algeria|Laos', 'Algeria', 'Laos', 7),
  ('Algeria|Lithuania', 'Algeria', 'Lithuania', 5),
  ('Algeria|Malaysia', 'Algeria', 'Malaysia', 9),
  ('Algeria|Myanmar', 'Algeria', 'Myanmar', 7),
  ('Algeria|Nepal', 'Algeria', 'Nepal', 7),
  ('Algeria|Oman', 'Algeria', 'Oman', 5),
  ('Algeria|Qatar', 'Algeria', 'Qatar', 5),
  ('Algeria|Russia', 'Algeria', 'Russia', 5),
  ('Algeria|Slovakia', 'Algeria', 'Slovakia', 5),
  ('Algeria|South Africa', 'Algeria', 'South Africa', 5),
  ('Algeria|South Korea', 'Algeria', 'South Korea', 7),
  ('Algeria|Sweden', 'Algeria', 'Sweden', 7),
  ('Algeria|Tajikistan', 'Algeria', 'Tajikistan', 7),
  ('Algeria|Thailand', 'Algeria', 'Thailand', 8),
  ('Algeria|UAE', 'Algeria', 'UAE', 5),
  ('Algeria|Ukraine', 'Algeria', 'Ukraine', 5),
  ('Algeria|Uzbekistan', 'Algeria', 'Uzbekistan', 7),
  ('Algeria|Vietnam', 'Algeria', 'Vietnam', 7),
  ('Algeria|Yemen', 'Algeria', 'Yemen', 5),
  ('Angola|Armenia', 'Angola', 'Armenia', 7),
  ('Angola|Austria', 'Angola', 'Austria', 8),
  ('Angola|Azerbaijan', 'Angola', 'Azerbaijan', 7),
  ('Angola|Belarus', 'Angola', 'Belarus', 9),
  ('Angola|Belgium', 'Angola', 'Belgium', 7),
  ('Angola|Bosnia and Herzegovina', 'Angola', 'Bosnia and Herzegovina', 9),
  ('Angola|Bulgaria', 'Angola', 'Bulgaria', 7),
  ('Angola|China', 'Angola', 'China', 9),
  ('Angola|Croatia', 'Angola', 'Croatia', 9),
  ('Angola|Czech Republic', 'Angola', 'Czech Republic', 8),
  ('Angola|Denmark', 'Angola', 'Denmark', 8),
  ('Angola|Estonia', 'Angola', 'Estonia', 9),
  ('Angola|Finland', 'Angola', 'Finland', 9),
  ('Angola|Georgia', 'Angola', 'Georgia', 7),
  ('Angola|Germany', 'Angola', 'Germany', 7),
  ('Angola|Ghana', 'Angola', 'Ghana', 5),
  ('Angola|Greece', 'Angola', 'Greece', 7),
  ('Angola|Guinea', 'Angola', 'Guinea', 5),
  ('Angola|Hungary', 'Angola', 'Hungary', 9),
  ('Angola|India', 'Angola', 'India', 9),
  ('Angola|Iran', 'Angola', 'Iran', 7),
  ('Angola|Italy', 'Angola', 'Italy', 7),
  ('Angola|Ivory Coast', 'Angola', 'Ivory Coast', 5),
  ('Angola|Jordan', 'Angola', 'Jordan', 5),
  ('Angola|Kazakhstan', 'Angola', 'Kazakhstan', 9),
  ('Angola|Kosovo', 'Angola', 'Kosovo', 9),
  ('Angola|Kuwait', 'Angola', 'Kuwait', 7),
  ('Angola|Latvia', 'Angola', 'Latvia', 9),
  ('Angola|Lebanon', 'Angola', 'Lebanon', 5),
  ('Angola|Lithuania', 'Angola', 'Lithuania', 9),
  ('Angola|Luxembourg', 'Angola', 'Luxembourg', 7),
  ('Angola|Moldova', 'Angola', 'Moldova', 9),
  ('Angola|Mongolia', 'Angola', 'Mongolia', 9),
  ('Angola|Montenegro', 'Angola', 'Montenegro', 9),
  ('Angola|Netherlands', 'Angola', 'Netherlands', 8),
  ('Angola|North Korea', 'Angola', 'North Korea', 9),
  ('Angola|North Macedonia', 'Angola', 'North Macedonia', 8),
  ('Angola|Norway', 'Angola', 'Norway', 9),
  ('Angola|Oman', 'Angola', 'Oman', 7),
  ('Angola|Pakistan', 'Angola', 'Pakistan', 8),
  ('Angola|Poland', 'Angola', 'Poland', 8),
  ('Angola|Qatar', 'Angola', 'Qatar', 7),
  ('Angola|Romania', 'Angola', 'Romania', 8),
  ('Angola|Russia', 'Angola', 'Russia', 8),
  ('Angola|Senegal', 'Angola', 'Senegal', 5),
  ('Angola|Serbia', 'Angola', 'Serbia', 8),
  ('Angola|Slovakia', 'Angola', 'Slovakia', 9),
  ('Angola|Slovenia', 'Angola', 'Slovenia', 8),
  ('Angola|Spain', 'Angola', 'Spain', 5),
  ('Angola|Switzerland', 'Angola', 'Switzerland', 7),
  ('Angola|Syria', 'Angola', 'Syria', 5),
  ('Angola|Tajikistan', 'Angola', 'Tajikistan', 9),
  ('Angola|Turkmenistan', 'Angola', 'Turkmenistan', 8),
  ('Angola|UAE', 'Angola', 'UAE', 7),
  ('Angola|Ukraine', 'Angola', 'Ukraine', 9),
  ('Angola|Uzbekistan', 'Angola', 'Uzbekistan', 9),
  ('Angola|Yemen', 'Angola', 'Yemen', 7),
  ('Argentina|Belize', 'Argentina', 'Belize', 7),
  ('Argentina|Canada', 'Argentina', 'Canada', 9),
  ('Argentina|Honduras', 'Argentina', 'Honduras', 5),
  ('Argentina|Mexico', 'Argentina', 'Mexico', 7),
  ('Argentina|USA', 'Argentina', 'USA', 8),
  ('Armenia|Botswana', 'Armenia', 'Botswana', 8),
  ('Armenia|Burundi', 'Armenia', 'Burundi', 7),
  ('Armenia|Central African Republic', 'Armenia', 'Central African Republic', 5),
  ('Armenia|Chad', 'Armenia', 'Chad', 5),
  ('Armenia|Equatorial Guinea', 'Armenia', 'Equatorial Guinea', 7),
  ('Armenia|Eritrea', 'Armenia', 'Eritrea', 5),
  ('Armenia|Eswatini', 'Armenia', 'Eswatini', 9),
  ('Armenia|Ethiopia', 'Armenia', 'Ethiopia', 5),
  ('Armenia|Gabon', 'Armenia', 'Gabon', 7),
  ('Armenia|Ghana', 'Armenia', 'Ghana', 7),
  ('Armenia|Guinea', 'Armenia', 'Guinea', 7),
  ('Armenia|Guinea-Bissau', 'Armenia', 'Guinea-Bissau', 8),
  ('Armenia|Italy', 'Armenia', 'Italy', 5),
  ('Armenia|Ivory Coast', 'Armenia', 'Ivory Coast', 7),
  ('Armenia|Liberia', 'Armenia', 'Liberia', 8),
  ('Armenia|Malawi', 'Armenia', 'Malawi', 8),
  ('Armenia|Malaysia', 'Armenia', 'Malaysia', 5),
  ('Armenia|Mozambique', 'Armenia', 'Mozambique', 8),
  ('Armenia|Namibia', 'Armenia', 'Namibia', 8),
  ('Armenia|Niger', 'Armenia', 'Niger', 5),
  ('Armenia|Rwanda', 'Armenia', 'Rwanda', 7),
  ('Armenia|Senegal', 'Armenia', 'Senegal', 7),
  ('Armenia|Sierra Leone', 'Armenia', 'Sierra Leone', 8),
  ('Armenia|South Africa', 'Armenia', 'South Africa', 9),
  ('Armenia|South Sudan', 'Armenia', 'South Sudan', 5),
  ('Armenia|Spain', 'Armenia', 'Spain', 5),
  ('Armenia|Tanzania', 'Armenia', 'Tanzania', 7),
  ('Armenia|Togo', 'Armenia', 'Togo', 7),
  ('Armenia|Tunisia', 'Armenia', 'Tunisia', 5),
  ('Armenia|Zambia', 'Armenia', 'Zambia', 7),
  ('Armenia|Zimbabwe', 'Armenia', 'Zimbabwe', 8),
  ('Austria|Bangladesh', 'Austria', 'Bangladesh', 5),
  ('Austria|Botswana', 'Austria', 'Botswana', 9),
  ('Austria|Burundi', 'Austria', 'Burundi', 8),
  ('Austria|Cambodia', 'Austria', 'Cambodia', 5),
  ('Austria|Chad', 'Austria', 'Chad', 5),
  ('Austria|Democratic Republic of Congo', 'Austria', 'Democratic Republic of Congo', 7),
  ('Austria|Djibouti', 'Austria', 'Djibouti', 8),
  ('Austria|Equatorial Guinea', 'Austria', 'Equatorial Guinea', 7),
  ('Austria|Eritrea', 'Austria', 'Eritrea', 7),
  ('Austria|Ethiopia', 'Austria', 'Ethiopia', 7),
  ('Austria|Gabon', 'Austria', 'Gabon', 7),
  ('Austria|Ghana', 'Austria', 'Ghana', 7),
  ('Austria|Israel', 'Austria', 'Israel', 5),
  ('Austria|Jordan', 'Austria', 'Jordan', 5),
  ('Austria|Kenya', 'Austria', 'Kenya', 8),
  ('Austria|Kuwait', 'Austria', 'Kuwait', 5),
  ('Austria|Lebanon', 'Austria', 'Lebanon', 5),
  ('Austria|Liberia', 'Austria', 'Liberia', 7),
  ('Austria|Libya', 'Austria', 'Libya', 5),
  ('Austria|Malawi', 'Austria', 'Malawi', 9),
  ('Austria|Mali', 'Austria', 'Mali', 5),
  ('Austria|Mozambique', 'Austria', 'Mozambique', 9),
  ('Austria|Namibia', 'Austria', 'Namibia', 9),
  ('Austria|Niger', 'Austria', 'Niger', 5),
  ('Austria|Republic of Congo', 'Austria', 'Republic of Congo', 7),
  ('Austria|Rwanda', 'Austria', 'Rwanda', 8),
  ('Austria|Saudi Arabia', 'Austria', 'Saudi Arabia', 5),
  ('Austria|Senegal', 'Austria', 'Senegal', 5),
  ('Austria|Sierra Leone', 'Austria', 'Sierra Leone', 7),
  ('Austria|Somalia', 'Austria', 'Somalia', 8),
  ('Austria|South Sudan', 'Austria', 'South Sudan', 7),
  ('Austria|Tanzania', 'Austria', 'Tanzania', 8),
  ('Austria|Thailand', 'Austria', 'Thailand', 5),
  ('Austria|Togo', 'Austria', 'Togo', 7),
  ('Austria|Tunisia', 'Austria', 'Tunisia', 5),
  ('Austria|Uganda', 'Austria', 'Uganda', 8),
  ('Austria|Zambia', 'Austria', 'Zambia', 8),
  ('Austria|Zimbabwe', 'Austria', 'Zimbabwe', 9),
  ('Azerbaijan|Botswana', 'Azerbaijan', 'Botswana', 8),
  ('Azerbaijan|Burundi', 'Azerbaijan', 'Burundi', 7),
  ('Azerbaijan|Central African Republic', 'Azerbaijan', 'Central African Republic', 5),
  ('Azerbaijan|Chad', 'Azerbaijan', 'Chad', 5),
  ('Azerbaijan|Equatorial Guinea', 'Azerbaijan', 'Equatorial Guinea', 7),
  ('Azerbaijan|Eritrea', 'Azerbaijan', 'Eritrea', 5),
  ('Azerbaijan|Eswatini', 'Azerbaijan', 'Eswatini', 9),
  ('Azerbaijan|Ethiopia', 'Azerbaijan', 'Ethiopia', 5),
  ('Azerbaijan|Gabon', 'Azerbaijan', 'Gabon', 7),
  ('Azerbaijan|Ghana', 'Azerbaijan', 'Ghana', 7),
  ('Azerbaijan|Guinea', 'Azerbaijan', 'Guinea', 7),
  ('Azerbaijan|Guinea-Bissau', 'Azerbaijan', 'Guinea-Bissau', 8),
  ('Azerbaijan|Ivory Coast', 'Azerbaijan', 'Ivory Coast', 7),
  ('Azerbaijan|Liberia', 'Azerbaijan', 'Liberia', 8),
  ('Azerbaijan|Malawi', 'Azerbaijan', 'Malawi', 8),
  ('Azerbaijan|Morocco', 'Azerbaijan', 'Morocco', 5),
  ('Azerbaijan|Mozambique', 'Azerbaijan', 'Mozambique', 8),
  ('Azerbaijan|Namibia', 'Azerbaijan', 'Namibia', 8),
  ('Azerbaijan|Niger', 'Azerbaijan', 'Niger', 5),
  ('Azerbaijan|Portugal', 'Azerbaijan', 'Portugal', 5),
  ('Azerbaijan|Rwanda', 'Azerbaijan', 'Rwanda', 7),
  ('Azerbaijan|Senegal', 'Azerbaijan', 'Senegal', 7),
  ('Azerbaijan|Sierra Leone', 'Azerbaijan', 'Sierra Leone', 8),
  ('Azerbaijan|South Africa', 'Azerbaijan', 'South Africa', 9),
  ('Azerbaijan|South Sudan', 'Azerbaijan', 'South Sudan', 5),
  ('Azerbaijan|Tanzania', 'Azerbaijan', 'Tanzania', 7),
  ('Azerbaijan|Togo', 'Azerbaijan', 'Togo', 7),
  ('Azerbaijan|Tunisia', 'Azerbaijan', 'Tunisia', 5),
  ('Azerbaijan|Zambia', 'Azerbaijan', 'Zambia', 7),
  ('Azerbaijan|Zimbabwe', 'Azerbaijan', 'Zimbabwe', 8),
  ('Bangladesh|Belgium', 'Bangladesh', 'Belgium', 5),
  ('Bangladesh|Benin', 'Bangladesh', 'Benin', 9),
  ('Bangladesh|Burkina Faso', 'Bangladesh', 'Burkina Faso', 9),
  ('Bangladesh|Cameroon', 'Bangladesh', 'Cameroon', 9),
  ('Bangladesh|Central African Republic', 'Bangladesh', 'Central African Republic', 8),
  ('Bangladesh|Chad', 'Bangladesh', 'Chad', 8),
  ('Bangladesh|Croatia', 'Bangladesh', 'Croatia', 5),
  ('Bangladesh|Democratic Republic of Congo', 'Bangladesh', 'Democratic Republic of Congo', 9),
  ('Bangladesh|Denmark', 'Bangladesh', 'Denmark', 5),
  ('Bangladesh|Djibouti', 'Bangladesh', 'Djibouti', 9),
  ('Bangladesh|Eritrea', 'Bangladesh', 'Eritrea', 8),
  ('Bangladesh|Ethiopia', 'Bangladesh', 'Ethiopia', 8),
  ('Bangladesh|France', 'Bangladesh', 'France', 5),
  ('Bangladesh|Israel', 'Bangladesh', 'Israel', 5),
  ('Bangladesh|Kenya', 'Bangladesh', 'Kenya', 9),
  ('Bangladesh|Lebanon', 'Bangladesh', 'Lebanon', 5),
  ('Bangladesh|Libya', 'Bangladesh', 'Libya', 7),
  ('Bangladesh|Luxembourg', 'Bangladesh', 'Luxembourg', 5),
  ('Bangladesh|Mali', 'Bangladesh', 'Mali', 9),
  ('Bangladesh|Mauritania', 'Bangladesh', 'Mauritania', 8),
  ('Bangladesh|Morocco', 'Bangladesh', 'Morocco', 7),
  ('Bangladesh|Netherlands', 'Bangladesh', 'Netherlands', 5),
  ('Bangladesh|Niger', 'Bangladesh', 'Niger', 8),
  ('Bangladesh|Nigeria', 'Bangladesh', 'Nigeria', 9),
  ('Bangladesh|North Macedonia', 'Bangladesh', 'North Macedonia', 5),
  ('Bangladesh|Oman', 'Bangladesh', 'Oman', 5),
  ('Bangladesh|Portugal', 'Bangladesh', 'Portugal', 7),
  ('Bangladesh|Qatar', 'Bangladesh', 'Qatar', 5),
  ('Bangladesh|Republic of Congo', 'Bangladesh', 'Republic of Congo', 9),
  ('Bangladesh|Senegal', 'Bangladesh', 'Senegal', 9),
  ('Bangladesh|Serbia', 'Bangladesh', 'Serbia', 5),
  ('Bangladesh|Slovenia', 'Bangladesh', 'Slovenia', 5),
  ('Bangladesh|Somalia', 'Bangladesh', 'Somalia', 9),
  ('Bangladesh|South Sudan', 'Bangladesh', 'South Sudan', 8),
  ('Bangladesh|Sudan', 'Bangladesh', 'Sudan', 7),
  ('Bangladesh|Switzerland', 'Bangladesh', 'Switzerland', 5),
  ('Bangladesh|Tunisia', 'Bangladesh', 'Tunisia', 8),
  ('Bangladesh|UAE', 'Bangladesh', 'UAE', 5),
  ('Bangladesh|Uganda', 'Bangladesh', 'Uganda', 9),
  ('Bangladesh|Yemen', 'Bangladesh', 'Yemen', 5),
  ('Belarus|Benin', 'Belarus', 'Benin', 7),
  ('Belarus|Burkina Faso', 'Belarus', 'Burkina Faso', 7),
  ('Belarus|Burundi', 'Belarus', 'Burundi', 9),
  ('Belarus|Cameroon', 'Belarus', 'Cameroon', 7),
  ('Belarus|Central African Republic', 'Belarus', 'Central African Republic', 7),
  ('Belarus|Democratic Republic of Congo', 'Belarus', 'Democratic Republic of Congo', 8),
  ('Belarus|Djibouti', 'Belarus', 'Djibouti', 8),
  ('Belarus|Egypt', 'Belarus', 'Egypt', 5),
  ('Belarus|Equatorial Guinea', 'Belarus', 'Equatorial Guinea', 8),
  ('Belarus|Eritrea', 'Belarus', 'Eritrea', 7),
  ('Belarus|Ethiopia', 'Belarus', 'Ethiopia', 7),
  ('Belarus|Gabon', 'Belarus', 'Gabon', 8),
  ('Belarus|Ghana', 'Belarus', 'Ghana', 8),
  ('Belarus|Guinea', 'Belarus', 'Guinea', 7),
  ('Belarus|Guinea-Bissau', 'Belarus', 'Guinea-Bissau', 7),
  ('Belarus|Ivory Coast', 'Belarus', 'Ivory Coast', 7),
  ('Belarus|Kenya', 'Belarus', 'Kenya', 8),
  ('Belarus|Liberia', 'Belarus', 'Liberia', 8),
  ('Belarus|Mauritania', 'Belarus', 'Mauritania', 5),
  ('Belarus|Nigeria', 'Belarus', 'Nigeria', 7),
  ('Belarus|Oman', 'Belarus', 'Oman', 5),
  ('Belarus|Qatar', 'Belarus', 'Qatar', 5),
  ('Belarus|Republic of Congo', 'Belarus', 'Republic of Congo', 8),
  ('Belarus|Rwanda', 'Belarus', 'Rwanda', 9),
  ('Belarus|Sierra Leone', 'Belarus', 'Sierra Leone', 8),
  ('Belarus|Somalia', 'Belarus', 'Somalia', 8),
  ('Belarus|South Sudan', 'Belarus', 'South Sudan', 7),
  ('Belarus|Tanzania', 'Belarus', 'Tanzania', 9),
  ('Belarus|Togo', 'Belarus', 'Togo', 8),
  ('Belarus|UAE', 'Belarus', 'UAE', 5),
  ('Belarus|Uganda', 'Belarus', 'Uganda', 8),
  ('Belarus|Yemen', 'Belarus', 'Yemen', 5),
  ('Belarus|Zambia', 'Belarus', 'Zambia', 9),
  ('Belgium|Benin', 'Belgium', 'Benin', 5),
  ('Belgium|Botswana', 'Belgium', 'Botswana', 8),
  ('Belgium|Burkina Faso', 'Belgium', 'Burkina Faso', 5),
  ('Belgium|Burundi', 'Belgium', 'Burundi', 7),
  ('Belgium|Cambodia', 'Belgium', 'Cambodia', 5),
  ('Belgium|Cameroon', 'Belgium', 'Cameroon', 5),
  ('Belgium|Central African Republic', 'Belgium', 'Central African Republic', 5),
  ('Belgium|Djibouti', 'Belgium', 'Djibouti', 7),
  ('Belgium|Egypt', 'Belgium', 'Egypt', 5),
  ('Belgium|Eswatini', 'Belgium', 'Eswatini', 9),
  ('Belgium|Greece', 'Belgium', 'Greece', 5),
  ('Belgium|Guinea', 'Belgium', 'Guinea', 5),
  ('Belgium|Guinea-Bissau', 'Belgium', 'Guinea-Bissau', 5),
  ('Belgium|Iraq', 'Belgium', 'Iraq', 5),
  ('Belgium|Ivory Coast', 'Belgium', 'Ivory Coast', 5),
  ('Belgium|Kenya', 'Belgium', 'Kenya', 7),
  ('Belgium|Malawi', 'Belgium', 'Malawi', 8),
  ('Belgium|Mozambique', 'Belgium', 'Mozambique', 8),
  ('Belgium|Namibia', 'Belgium', 'Namibia', 8),
  ('Belgium|Nigeria', 'Belgium', 'Nigeria', 5),
  ('Belgium|Oman', 'Belgium', 'Oman', 7),
  ('Belgium|Qatar', 'Belgium', 'Qatar', 7),
  ('Belgium|Rwanda', 'Belgium', 'Rwanda', 7),
  ('Belgium|Somalia', 'Belgium', 'Somalia', 7),
  ('Belgium|South Africa', 'Belgium', 'South Africa', 9),
  ('Belgium|Sudan', 'Belgium', 'Sudan', 5),
  ('Belgium|Syria', 'Belgium', 'Syria', 5),
  ('Belgium|Tanzania', 'Belgium', 'Tanzania', 7),
  ('Belgium|Thailand', 'Belgium', 'Thailand', 5),
  ('Belgium|UAE', 'Belgium', 'UAE', 7),
  ('Belgium|Uganda', 'Belgium', 'Uganda', 7),
  ('Belgium|Yemen', 'Belgium', 'Yemen', 7),
  ('Belgium|Zambia', 'Belgium', 'Zambia', 7),
  ('Belgium|Zimbabwe', 'Belgium', 'Zimbabwe', 8),
  ('Belize|Bolivia', 'Belize', 'Bolivia', 7),
  ('Belize|Chile', 'Belize', 'Chile', 7),
  ('Belize|Colombia', 'Belize', 'Colombia', 5),
  ('Belize|Guyana', 'Belize', 'Guyana', 7),
  ('Belize|Paraguay', 'Belize', 'Paraguay', 7),
  ('Belize|Suriname', 'Belize', 'Suriname', 7),
  ('Belize|Uruguay', 'Belize', 'Uruguay', 7),
  ('Benin|Bhutan', 'Benin', 'Bhutan', 9),
  ('Benin|Bosnia and Herzegovina', 'Benin', 'Bosnia and Herzegovina', 8),
  ('Benin|Botswana', 'Benin', 'Botswana', 5),
  ('Benin|China', 'Benin', 'China', 8),
  ('Benin|Croatia', 'Benin', 'Croatia', 7),
  ('Benin|Estonia', 'Benin', 'Estonia', 8),
  ('Benin|Finland', 'Benin', 'Finland', 8),
  ('Benin|Germany', 'Benin', 'Germany', 5),
  ('Benin|Hungary', 'Benin', 'Hungary', 7),
  ('Benin|India', 'Benin', 'India', 8),
  ('Benin|Iraq', 'Benin', 'Iraq', 5),
  ('Benin|Italy', 'Benin', 'Italy', 5),
  ('Benin|Kazakhstan', 'Benin', 'Kazakhstan', 8),
  ('Benin|Kosovo', 'Benin', 'Kosovo', 8),
  ('Benin|Kyrgyzstan', 'Benin', 'Kyrgyzstan', 9),
  ('Benin|Laos', 'Benin', 'Laos', 9),
  ('Benin|Latvia', 'Benin', 'Latvia', 8),
  ('Benin|Lithuania', 'Benin', 'Lithuania', 7),
  ('Benin|Luxembourg', 'Benin', 'Luxembourg', 5),
  ('Benin|Malawi', 'Benin', 'Malawi', 5),
  ('Benin|Moldova', 'Benin', 'Moldova', 8),
  ('Benin|Mongolia', 'Benin', 'Mongolia', 8),
  ('Benin|Montenegro', 'Benin', 'Montenegro', 8),
  ('Benin|Mozambique', 'Benin', 'Mozambique', 5),
  ('Benin|Myanmar', 'Benin', 'Myanmar', 9),
  ('Benin|Nepal', 'Benin', 'Nepal', 9),
  ('Benin|North Korea', 'Benin', 'North Korea', 8),
  ('Benin|North Macedonia', 'Benin', 'North Macedonia', 7),
  ('Benin|Norway', 'Benin', 'Norway', 8),
  ('Benin|Pakistan', 'Benin', 'Pakistan', 7),
  ('Benin|Romania', 'Benin', 'Romania', 7),
  ('Benin|Russia', 'Benin', 'Russia', 7),
  ('Benin|Saudi Arabia', 'Benin', 'Saudi Arabia', 5),
  ('Benin|Serbia', 'Benin', 'Serbia', 7),
  ('Benin|Slovakia', 'Benin', 'Slovakia', 7),
  ('Benin|South Africa', 'Benin', 'South Africa', 5),
  ('Benin|South Korea', 'Benin', 'South Korea', 9),
  ('Benin|Sweden', 'Benin', 'Sweden', 9),
  ('Benin|Switzerland', 'Benin', 'Switzerland', 5),
  ('Benin|Tajikistan', 'Benin', 'Tajikistan', 8),
  ('Benin|Turkey', 'Benin', 'Turkey', 5),
  ('Benin|Turkmenistan', 'Benin', 'Turkmenistan', 7),
  ('Benin|Ukraine', 'Benin', 'Ukraine', 7),
  ('Benin|Uzbekistan', 'Benin', 'Uzbekistan', 8),
  ('Benin|Vietnam', 'Benin', 'Vietnam', 9),
  ('Benin|Zimbabwe', 'Benin', 'Zimbabwe', 5),
  ('Bhutan|Bosnia and Herzegovina', 'Bhutan', 'Bosnia and Herzegovina', 5),
  ('Bhutan|Burkina Faso', 'Bhutan', 'Burkina Faso', 9),
  ('Bhutan|Cameroon', 'Bhutan', 'Cameroon', 9),
  ('Bhutan|Central African Republic', 'Bhutan', 'Central African Republic', 8),
  ('Bhutan|Chad', 'Bhutan', 'Chad', 8),
  ('Bhutan|Democratic Republic of Congo', 'Bhutan', 'Democratic Republic of Congo', 9),
  ('Bhutan|Djibouti', 'Bhutan', 'Djibouti', 9),
  ('Bhutan|Eritrea', 'Bhutan', 'Eritrea', 8),
  ('Bhutan|Ethiopia', 'Bhutan', 'Ethiopia', 8),
  ('Bhutan|Guinea', 'Bhutan', 'Guinea', 9),
  ('Bhutan|Guinea-Bissau', 'Bhutan', 'Guinea-Bissau', 9),
  ('Bhutan|Israel', 'Bhutan', 'Israel', 5),
  ('Bhutan|Italy', 'Bhutan', 'Italy', 5),
  ('Bhutan|Ivory Coast', 'Bhutan', 'Ivory Coast', 9),
  ('Bhutan|Kenya', 'Bhutan', 'Kenya', 9),
  ('Bhutan|Kosovo', 'Bhutan', 'Kosovo', 5),
  ('Bhutan|Lebanon', 'Bhutan', 'Lebanon', 5),
  ('Bhutan|Libya', 'Bhutan', 'Libya', 7),
  ('Bhutan|Mali', 'Bhutan', 'Mali', 8),
  ('Bhutan|Mauritania', 'Bhutan', 'Mauritania', 7),
  ('Bhutan|Montenegro', 'Bhutan', 'Montenegro', 5),
  ('Bhutan|Niger', 'Bhutan', 'Niger', 8),
  ('Bhutan|Nigeria', 'Bhutan', 'Nigeria', 9),
  ('Bhutan|North Macedonia', 'Bhutan', 'North Macedonia', 5),
  ('Bhutan|Oman', 'Bhutan', 'Oman', 5),
  ('Bhutan|Qatar', 'Bhutan', 'Qatar', 5),
  ('Bhutan|Republic of Congo', 'Bhutan', 'Republic of Congo', 9),
  ('Bhutan|Senegal', 'Bhutan', 'Senegal', 8),
  ('Bhutan|Somalia', 'Bhutan', 'Somalia', 9),
  ('Bhutan|South Sudan', 'Bhutan', 'South Sudan', 8),
  ('Bhutan|Spain', 'Bhutan', 'Spain', 5),
  ('Bhutan|Sudan', 'Bhutan', 'Sudan', 7),
  ('Bhutan|Tunisia', 'Bhutan', 'Tunisia', 8),
  ('Bhutan|UAE', 'Bhutan', 'UAE', 5),
  ('Bhutan|Uganda', 'Bhutan', 'Uganda', 9),
  ('Bhutan|Yemen', 'Bhutan', 'Yemen', 5),
  ('Bolivia|Canada', 'Bolivia', 'Canada', 9),
  ('Bolivia|Honduras', 'Bolivia', 'Honduras', 5),
  ('Bolivia|Mexico', 'Bolivia', 'Mexico', 7),
  ('Bolivia|USA', 'Bolivia', 'USA', 8),
  ('Bosnia and Herzegovina|Burkina Faso', 'Bosnia and Herzegovina', 'Burkina Faso', 8),
  ('Bosnia and Herzegovina|Burundi', 'Bosnia and Herzegovina', 'Burundi', 9),
  ('Bosnia and Herzegovina|Cameroon', 'Bosnia and Herzegovina', 'Cameroon', 8),
  ('Bosnia and Herzegovina|Central African Republic', 'Bosnia and Herzegovina', 'Central African Republic', 7),
  ('Bosnia and Herzegovina|Chad', 'Bosnia and Herzegovina', 'Chad', 7),
  ('Bosnia and Herzegovina|Democratic Republic of Congo', 'Bosnia and Herzegovina', 'Democratic Republic of Congo', 8),
  ('Bosnia and Herzegovina|Djibouti', 'Bosnia and Herzegovina', 'Djibouti', 8),
  ('Bosnia and Herzegovina|Egypt', 'Bosnia and Herzegovina', 'Egypt', 5),
  ('Bosnia and Herzegovina|Equatorial Guinea', 'Bosnia and Herzegovina', 'Equatorial Guinea', 9),
  ('Bosnia and Herzegovina|Eritrea', 'Bosnia and Herzegovina', 'Eritrea', 7),
  ('Bosnia and Herzegovina|Ethiopia', 'Bosnia and Herzegovina', 'Ethiopia', 7),
  ('Bosnia and Herzegovina|Gabon', 'Bosnia and Herzegovina', 'Gabon', 9),
  ('Bosnia and Herzegovina|Ghana', 'Bosnia and Herzegovina', 'Ghana', 9),
  ('Bosnia and Herzegovina|Guinea', 'Bosnia and Herzegovina', 'Guinea', 8),
  ('Bosnia and Herzegovina|Guinea-Bissau', 'Bosnia and Herzegovina', 'Guinea-Bissau', 8),
  ('Bosnia and Herzegovina|India', 'Bosnia and Herzegovina', 'India', 5),
  ('Bosnia and Herzegovina|Ivory Coast', 'Bosnia and Herzegovina', 'Ivory Coast', 8),
  ('Bosnia and Herzegovina|Kenya', 'Bosnia and Herzegovina', 'Kenya', 8),
  ('Bosnia and Herzegovina|Kyrgyzstan', 'Bosnia and Herzegovina', 'Kyrgyzstan', 5),
  ('Bosnia and Herzegovina|Laos', 'Bosnia and Herzegovina', 'Laos', 5),
  ('Bosnia and Herzegovina|Liberia', 'Bosnia and Herzegovina', 'Liberia', 9),
  ('Bosnia and Herzegovina|Malaysia', 'Bosnia and Herzegovina', 'Malaysia', 7),
  ('Bosnia and Herzegovina|Mali', 'Bosnia and Herzegovina', 'Mali', 7),
  ('Bosnia and Herzegovina|Morocco', 'Bosnia and Herzegovina', 'Morocco', 5),
  ('Bosnia and Herzegovina|Myanmar', 'Bosnia and Herzegovina', 'Myanmar', 5),
  ('Bosnia and Herzegovina|Nepal', 'Bosnia and Herzegovina', 'Nepal', 5),
  ('Bosnia and Herzegovina|Niger', 'Bosnia and Herzegovina', 'Niger', 7),
  ('Bosnia and Herzegovina|Nigeria', 'Bosnia and Herzegovina', 'Nigeria', 8),
  ('Bosnia and Herzegovina|Oman', 'Bosnia and Herzegovina', 'Oman', 5),
  ('Bosnia and Herzegovina|Portugal', 'Bosnia and Herzegovina', 'Portugal', 5),
  ('Bosnia and Herzegovina|Qatar', 'Bosnia and Herzegovina', 'Qatar', 5),
  ('Bosnia and Herzegovina|Republic of Congo', 'Bosnia and Herzegovina', 'Republic of Congo', 8),
  ('Bosnia and Herzegovina|Rwanda', 'Bosnia and Herzegovina', 'Rwanda', 9),
  ('Bosnia and Herzegovina|Senegal', 'Bosnia and Herzegovina', 'Senegal', 7),
  ('Bosnia and Herzegovina|Sierra Leone', 'Bosnia and Herzegovina', 'Sierra Leone', 9),
  ('Bosnia and Herzegovina|Somalia', 'Bosnia and Herzegovina', 'Somalia', 8),
  ('Bosnia and Herzegovina|South Korea', 'Bosnia and Herzegovina', 'South Korea', 5),
  ('Bosnia and Herzegovina|South Sudan', 'Bosnia and Herzegovina', 'South Sudan', 7),
  ('Bosnia and Herzegovina|Sweden', 'Bosnia and Herzegovina', 'Sweden', 5),
  ('Bosnia and Herzegovina|Tajikistan', 'Bosnia and Herzegovina', 'Tajikistan', 5),
  ('Bosnia and Herzegovina|Tanzania', 'Bosnia and Herzegovina', 'Tanzania', 9),
  ('Bosnia and Herzegovina|Togo', 'Bosnia and Herzegovina', 'Togo', 9),
  ('Bosnia and Herzegovina|Tunisia', 'Bosnia and Herzegovina', 'Tunisia', 7),
  ('Bosnia and Herzegovina|UAE', 'Bosnia and Herzegovina', 'UAE', 5),
  ('Bosnia and Herzegovina|Uganda', 'Bosnia and Herzegovina', 'Uganda', 8),
  ('Bosnia and Herzegovina|Uzbekistan', 'Bosnia and Herzegovina', 'Uzbekistan', 5),
  ('Bosnia and Herzegovina|Vietnam', 'Bosnia and Herzegovina', 'Vietnam', 5),
  ('Bosnia and Herzegovina|Yemen', 'Bosnia and Herzegovina', 'Yemen', 5),
  ('Bosnia and Herzegovina|Zambia', 'Bosnia and Herzegovina', 'Zambia', 9),
  ('Botswana|Bulgaria', 'Botswana', 'Bulgaria', 8),
  ('Botswana|Burkina Faso', 'Botswana', 'Burkina Faso', 5),
  ('Botswana|Czech Republic', 'Botswana', 'Czech Republic', 9),
  ('Botswana|Denmark', 'Botswana', 'Denmark', 9),
  ('Botswana|France', 'Botswana', 'France', 7),
  ('Botswana|Georgia', 'Botswana', 'Georgia', 8),
  ('Botswana|Germany', 'Botswana', 'Germany', 8),
  ('Botswana|Greece', 'Botswana', 'Greece', 8),
  ('Botswana|Guinea-Bissau', 'Botswana', 'Guinea-Bissau', 7),
  ('Botswana|Iran', 'Botswana', 'Iran', 8),
  ('Botswana|Iraq', 'Botswana', 'Iraq', 7),
  ('Botswana|Israel', 'Botswana', 'Israel', 5),
  ('Botswana|Italy', 'Botswana', 'Italy', 8),
  ('Botswana|Kuwait', 'Botswana', 'Kuwait', 8),
  ('Botswana|Liberia', 'Botswana', 'Liberia', 7),
  ('Botswana|Luxembourg', 'Botswana', 'Luxembourg', 8),
  ('Botswana|Mali', 'Botswana', 'Mali', 5),
  ('Botswana|Mauritania', 'Botswana', 'Mauritania', 5),
  ('Botswana|Morocco', 'Botswana', 'Morocco', 5),
  ('Botswana|Netherlands', 'Botswana', 'Netherlands', 9),
  ('Botswana|North Macedonia', 'Botswana', 'North Macedonia', 9),
  ('Botswana|Oman', 'Botswana', 'Oman', 8),
  ('Botswana|Pakistan', 'Botswana', 'Pakistan', 9),
  ('Botswana|Poland', 'Botswana', 'Poland', 9),
  ('Botswana|Portugal', 'Botswana', 'Portugal', 7),
  ('Botswana|Qatar', 'Botswana', 'Qatar', 8),
  ('Botswana|Romania', 'Botswana', 'Romania', 9),
  ('Botswana|Russia', 'Botswana', 'Russia', 9),
  ('Botswana|Saudi Arabia', 'Botswana', 'Saudi Arabia', 7),
  ('Botswana|Serbia', 'Botswana', 'Serbia', 9),
  ('Botswana|Sierra Leone', 'Botswana', 'Sierra Leone', 7),
  ('Botswana|Slovenia', 'Botswana', 'Slovenia', 9),
  ('Botswana|Switzerland', 'Botswana', 'Switzerland', 8),
  ('Botswana|Tunisia', 'Botswana', 'Tunisia', 5),
  ('Botswana|Turkey', 'Botswana', 'Turkey', 7),
  ('Botswana|Turkmenistan', 'Botswana', 'Turkmenistan', 9),
  ('Botswana|UAE', 'Botswana', 'UAE', 8),
  ('Botswana|Yemen', 'Botswana', 'Yemen', 8),
  ('Brazil|Canada', 'Brazil', 'Canada', 8),
  ('Brazil|El Salvador', 'Brazil', 'El Salvador', 5),
  ('Brazil|Guatemala', 'Brazil', 'Guatemala', 5),
  ('Brazil|USA', 'Brazil', 'USA', 7),
  ('Bulgaria|Burundi', 'Bulgaria', 'Burundi', 7),
  ('Bulgaria|Cambodia', 'Bulgaria', 'Cambodia', 5),
  ('Bulgaria|Central African Republic', 'Bulgaria', 'Central African Republic', 5),
  ('Bulgaria|Chad', 'Bulgaria', 'Chad', 5),
  ('Bulgaria|Equatorial Guinea', 'Bulgaria', 'Equatorial Guinea', 7),
  ('Bulgaria|Eritrea', 'Bulgaria', 'Eritrea', 5),
  ('Bulgaria|Eswatini', 'Bulgaria', 'Eswatini', 9),
  ('Bulgaria|Ethiopia', 'Bulgaria', 'Ethiopia', 5),
  ('Bulgaria|Gabon', 'Bulgaria', 'Gabon', 7),
  ('Bulgaria|Ghana', 'Bulgaria', 'Ghana', 7),
  ('Bulgaria|Guinea', 'Bulgaria', 'Guinea', 7),
  ('Bulgaria|Guinea-Bissau', 'Bulgaria', 'Guinea-Bissau', 8),
  ('Bulgaria|Ivory Coast', 'Bulgaria', 'Ivory Coast', 7),
  ('Bulgaria|Liberia', 'Bulgaria', 'Liberia', 8),
  ('Bulgaria|Malawi', 'Bulgaria', 'Malawi', 8),
  ('Bulgaria|Mozambique', 'Bulgaria', 'Mozambique', 8),
  ('Bulgaria|Namibia', 'Bulgaria', 'Namibia', 8),
  ('Bulgaria|Niger', 'Bulgaria', 'Niger', 5),
  ('Bulgaria|Rwanda', 'Bulgaria', 'Rwanda', 7),
  ('Bulgaria|Senegal', 'Bulgaria', 'Senegal', 7),
  ('Bulgaria|Sierra Leone', 'Bulgaria', 'Sierra Leone', 8),
  ('Bulgaria|South Africa', 'Bulgaria', 'South Africa', 9),
  ('Bulgaria|South Sudan', 'Bulgaria', 'South Sudan', 5),
  ('Bulgaria|Spain', 'Bulgaria', 'Spain', 5),
  ('Bulgaria|Tanzania', 'Bulgaria', 'Tanzania', 7),
  ('Bulgaria|Thailand', 'Bulgaria', 'Thailand', 5),
  ('Bulgaria|Togo', 'Bulgaria', 'Togo', 7),
  ('Bulgaria|Tunisia', 'Bulgaria', 'Tunisia', 5),
  ('Bulgaria|Zambia', 'Bulgaria', 'Zambia', 7),
  ('Bulgaria|Zimbabwe', 'Bulgaria', 'Zimbabwe', 8),
  ('Burkina Faso|China', 'Burkina Faso', 'China', 8),
  ('Burkina Faso|Croatia', 'Burkina Faso', 'Croatia', 7),
  ('Burkina Faso|Estonia', 'Burkina Faso', 'Estonia', 8),
  ('Burkina Faso|Finland', 'Burkina Faso', 'Finland', 8),
  ('Burkina Faso|Germany', 'Burkina Faso', 'Germany', 5),
  ('Burkina Faso|Hungary', 'Burkina Faso', 'Hungary', 7),
  ('Burkina Faso|India', 'Burkina Faso', 'India', 8),
  ('Burkina Faso|Iraq', 'Burkina Faso', 'Iraq', 5),
  ('Burkina Faso|Italy', 'Burkina Faso', 'Italy', 5),
  ('Burkina Faso|Kazakhstan', 'Burkina Faso', 'Kazakhstan', 8),
  ('Burkina Faso|Kosovo', 'Burkina Faso', 'Kosovo', 8),
  ('Burkina Faso|Kyrgyzstan', 'Burkina Faso', 'Kyrgyzstan', 9),
  ('Burkina Faso|Laos', 'Burkina Faso', 'Laos', 9),
  ('Burkina Faso|Latvia', 'Burkina Faso', 'Latvia', 8),
  ('Burkina Faso|Lesotho', 'Burkina Faso', 'Lesotho', 7),
  ('Burkina Faso|Lithuania', 'Burkina Faso', 'Lithuania', 7),
  ('Burkina Faso|Luxembourg', 'Burkina Faso', 'Luxembourg', 5),
  ('Burkina Faso|Malawi', 'Burkina Faso', 'Malawi', 5),
  ('Burkina Faso|Moldova', 'Burkina Faso', 'Moldova', 8),
  ('Burkina Faso|Mongolia', 'Burkina Faso', 'Mongolia', 8),
  ('Burkina Faso|Montenegro', 'Burkina Faso', 'Montenegro', 8),
  ('Burkina Faso|Mozambique', 'Burkina Faso', 'Mozambique', 5),
  ('Burkina Faso|Myanmar', 'Burkina Faso', 'Myanmar', 9),
  ('Burkina Faso|Namibia', 'Burkina Faso', 'Namibia', 5),
  ('Burkina Faso|Nepal', 'Burkina Faso', 'Nepal', 9),
  ('Burkina Faso|North Korea', 'Burkina Faso', 'North Korea', 8),
  ('Burkina Faso|North Macedonia', 'Burkina Faso', 'North Macedonia', 7),
  ('Burkina Faso|Norway', 'Burkina Faso', 'Norway', 8),
  ('Burkina Faso|Pakistan', 'Burkina Faso', 'Pakistan', 7),
  ('Burkina Faso|Romania', 'Burkina Faso', 'Romania', 7),
  ('Burkina Faso|Russia', 'Burkina Faso', 'Russia', 7),
  ('Burkina Faso|Saudi Arabia', 'Burkina Faso', 'Saudi Arabia', 5),
  ('Burkina Faso|Serbia', 'Burkina Faso', 'Serbia', 7),
  ('Burkina Faso|Slovakia', 'Burkina Faso', 'Slovakia', 7),
  ('Burkina Faso|South Korea', 'Burkina Faso', 'South Korea', 9),
  ('Burkina Faso|Sweden', 'Burkina Faso', 'Sweden', 9),
  ('Burkina Faso|Switzerland', 'Burkina Faso', 'Switzerland', 5),
  ('Burkina Faso|Tajikistan', 'Burkina Faso', 'Tajikistan', 8),
  ('Burkina Faso|Turkey', 'Burkina Faso', 'Turkey', 5),
  ('Burkina Faso|Turkmenistan', 'Burkina Faso', 'Turkmenistan', 7),
  ('Burkina Faso|Ukraine', 'Burkina Faso', 'Ukraine', 7),
  ('Burkina Faso|Uzbekistan', 'Burkina Faso', 'Uzbekistan', 8),
  ('Burkina Faso|Vietnam', 'Burkina Faso', 'Vietnam', 9),
  ('Burkina Faso|Zimbabwe', 'Burkina Faso', 'Zimbabwe', 5),
  ('Burundi|China', 'Burundi', 'China', 9),
  ('Burundi|Croatia', 'Burundi', 'Croatia', 9),
  ('Burundi|Czech Republic', 'Burundi', 'Czech Republic', 8),
  ('Burundi|Denmark', 'Burundi', 'Denmark', 8),
  ('Burundi|Estonia', 'Burundi', 'Estonia', 9),
  ('Burundi|Finland', 'Burundi', 'Finland', 9),
  ('Burundi|Georgia', 'Burundi', 'Georgia', 7),
  ('Burundi|Germany', 'Burundi', 'Germany', 7),
  ('Burundi|Ghana', 'Burundi', 'Ghana', 5),
  ('Burundi|Greece', 'Burundi', 'Greece', 7),
  ('Burundi|Guinea', 'Burundi', 'Guinea', 5),
  ('Burundi|Hungary', 'Burundi', 'Hungary', 9),
  ('Burundi|India', 'Burundi', 'India', 9),
  ('Burundi|Iran', 'Burundi', 'Iran', 7),
  ('Burundi|Italy', 'Burundi', 'Italy', 7),
  ('Burundi|Ivory Coast', 'Burundi', 'Ivory Coast', 5),
  ('Burundi|Jordan', 'Burundi', 'Jordan', 5),
  ('Burundi|Kazakhstan', 'Burundi', 'Kazakhstan', 9),
  ('Burundi|Kosovo', 'Burundi', 'Kosovo', 9),
  ('Burundi|Kuwait', 'Burundi', 'Kuwait', 7),
  ('Burundi|Latvia', 'Burundi', 'Latvia', 9),
  ('Burundi|Lebanon', 'Burundi', 'Lebanon', 5),
  ('Burundi|Lithuania', 'Burundi', 'Lithuania', 9),
  ('Burundi|Luxembourg', 'Burundi', 'Luxembourg', 7),
  ('Burundi|Moldova', 'Burundi', 'Moldova', 9),
  ('Burundi|Mongolia', 'Burundi', 'Mongolia', 9),
  ('Burundi|Montenegro', 'Burundi', 'Montenegro', 9),
  ('Burundi|Netherlands', 'Burundi', 'Netherlands', 8),
  ('Burundi|North Korea', 'Burundi', 'North Korea', 9),
  ('Burundi|North Macedonia', 'Burundi', 'North Macedonia', 8),
  ('Burundi|Norway', 'Burundi', 'Norway', 9),
  ('Burundi|Oman', 'Burundi', 'Oman', 7),
  ('Burundi|Pakistan', 'Burundi', 'Pakistan', 8),
  ('Burundi|Poland', 'Burundi', 'Poland', 8),
  ('Burundi|Qatar', 'Burundi', 'Qatar', 7),
  ('Burundi|Romania', 'Burundi', 'Romania', 8),
  ('Burundi|Russia', 'Burundi', 'Russia', 8),
  ('Burundi|Senegal', 'Burundi', 'Senegal', 5),
  ('Burundi|Serbia', 'Burundi', 'Serbia', 8),
  ('Burundi|Slovakia', 'Burundi', 'Slovakia', 9),
  ('Burundi|Slovenia', 'Burundi', 'Slovenia', 8),
  ('Burundi|Spain', 'Burundi', 'Spain', 5),
  ('Burundi|Switzerland', 'Burundi', 'Switzerland', 7),
  ('Burundi|Syria', 'Burundi', 'Syria', 5),
  ('Burundi|Tajikistan', 'Burundi', 'Tajikistan', 9),
  ('Burundi|Togo', 'Burundi', 'Togo', 5),
  ('Burundi|Turkmenistan', 'Burundi', 'Turkmenistan', 8),
  ('Burundi|UAE', 'Burundi', 'UAE', 7),
  ('Burundi|Ukraine', 'Burundi', 'Ukraine', 9),
  ('Burundi|Uzbekistan', 'Burundi', 'Uzbekistan', 9),
  ('Burundi|Yemen', 'Burundi', 'Yemen', 7),
  ('Cambodia|Central African Republic', 'Cambodia', 'Central African Republic', 9),
  ('Cambodia|Chad', 'Cambodia', 'Chad', 9),
  ('Cambodia|Croatia', 'Cambodia', 'Croatia', 5),
  ('Cambodia|Denmark', 'Cambodia', 'Denmark', 5),
  ('Cambodia|Egypt', 'Cambodia', 'Egypt', 7),
  ('Cambodia|Eritrea', 'Cambodia', 'Eritrea', 9),
  ('Cambodia|Ethiopia', 'Cambodia', 'Ethiopia', 9),
  ('Cambodia|France', 'Cambodia', 'France', 5),
  ('Cambodia|Greece', 'Cambodia', 'Greece', 5),
  ('Cambodia|Jordan', 'Cambodia', 'Jordan', 5),
  ('Cambodia|Kuwait', 'Cambodia', 'Kuwait', 5),
  ('Cambodia|Libya', 'Cambodia', 'Libya', 8),
  ('Cambodia|Luxembourg', 'Cambodia', 'Luxembourg', 5),
  ('Cambodia|Mali', 'Cambodia', 'Mali', 9),
  ('Cambodia|Mauritania', 'Cambodia', 'Mauritania', 8),
  ('Cambodia|Morocco', 'Cambodia', 'Morocco', 7),
  ('Cambodia|Netherlands', 'Cambodia', 'Netherlands', 5),
  ('Cambodia|Niger', 'Cambodia', 'Niger', 9),
  ('Cambodia|Portugal', 'Cambodia', 'Portugal', 7),
  ('Cambodia|Saudi Arabia', 'Cambodia', 'Saudi Arabia', 5),
  ('Cambodia|Senegal', 'Cambodia', 'Senegal', 9),
  ('Cambodia|Serbia', 'Cambodia', 'Serbia', 5),
  ('Cambodia|Slovenia', 'Cambodia', 'Slovenia', 5),
  ('Cambodia|South Sudan', 'Cambodia', 'South Sudan', 9),
  ('Cambodia|Sudan', 'Cambodia', 'Sudan', 8),
  ('Cambodia|Switzerland', 'Cambodia', 'Switzerland', 5),
  ('Cambodia|Syria', 'Cambodia', 'Syria', 5),
  ('Cambodia|Tunisia', 'Cambodia', 'Tunisia', 9),
  ('Cameroon|China', 'Cameroon', 'China', 8),
  ('Cameroon|Croatia', 'Cameroon', 'Croatia', 7),
  ('Cameroon|Estonia', 'Cameroon', 'Estonia', 8),
  ('Cameroon|Finland', 'Cameroon', 'Finland', 8),
  ('Cameroon|Germany', 'Cameroon', 'Germany', 5),
  ('Cameroon|Hungary', 'Cameroon', 'Hungary', 7),
  ('Cameroon|India', 'Cameroon', 'India', 8),
  ('Cameroon|Iraq', 'Cameroon', 'Iraq', 5),
  ('Cameroon|Italy', 'Cameroon', 'Italy', 5),
  ('Cameroon|Kazakhstan', 'Cameroon', 'Kazakhstan', 8),
  ('Cameroon|Kosovo', 'Cameroon', 'Kosovo', 8),
  ('Cameroon|Kyrgyzstan', 'Cameroon', 'Kyrgyzstan', 9),
  ('Cameroon|Laos', 'Cameroon', 'Laos', 9),
  ('Cameroon|Latvia', 'Cameroon', 'Latvia', 8),
  ('Cameroon|Lithuania', 'Cameroon', 'Lithuania', 7),
  ('Cameroon|Luxembourg', 'Cameroon', 'Luxembourg', 5),
  ('Cameroon|Moldova', 'Cameroon', 'Moldova', 8),
  ('Cameroon|Mongolia', 'Cameroon', 'Mongolia', 8),
  ('Cameroon|Montenegro', 'Cameroon', 'Montenegro', 8),
  ('Cameroon|Myanmar', 'Cameroon', 'Myanmar', 9),
  ('Cameroon|Nepal', 'Cameroon', 'Nepal', 9),
  ('Cameroon|North Korea', 'Cameroon', 'North Korea', 8),
  ('Cameroon|North Macedonia', 'Cameroon', 'North Macedonia', 7),
  ('Cameroon|Norway', 'Cameroon', 'Norway', 8),
  ('Cameroon|Pakistan', 'Cameroon', 'Pakistan', 7),
  ('Cameroon|Romania', 'Cameroon', 'Romania', 7),
  ('Cameroon|Russia', 'Cameroon', 'Russia', 7),
  ('Cameroon|Saudi Arabia', 'Cameroon', 'Saudi Arabia', 5),
  ('Cameroon|Serbia', 'Cameroon', 'Serbia', 7),
  ('Cameroon|Slovakia', 'Cameroon', 'Slovakia', 7),
  ('Cameroon|South Korea', 'Cameroon', 'South Korea', 9),
  ('Cameroon|Sweden', 'Cameroon', 'Sweden', 9),
  ('Cameroon|Switzerland', 'Cameroon', 'Switzerland', 5),
  ('Cameroon|Tajikistan', 'Cameroon', 'Tajikistan', 8),
  ('Cameroon|Turkey', 'Cameroon', 'Turkey', 5),
  ('Cameroon|Turkmenistan', 'Cameroon', 'Turkmenistan', 7),
  ('Cameroon|Ukraine', 'Cameroon', 'Ukraine', 7),
  ('Cameroon|Uzbekistan', 'Cameroon', 'Uzbekistan', 8),
  ('Cameroon|Vietnam', 'Cameroon', 'Vietnam', 9),
  ('Canada|Chile', 'Canada', 'Chile', 9),
  ('Canada|Colombia', 'Canada', 'Colombia', 7),
  ('Canada|Costa Rica', 'Canada', 'Costa Rica', 5),
  ('Canada|Ecuador', 'Canada', 'Ecuador', 8),
  ('Canada|Guyana', 'Canada', 'Guyana', 9),
  ('Canada|Paraguay', 'Canada', 'Paraguay', 9),
  ('Canada|Peru', 'Canada', 'Peru', 8),
  ('Canada|Suriname', 'Canada', 'Suriname', 9),
  ('Canada|Uruguay', 'Canada', 'Uruguay', 9),
  ('Canada|Venezuela', 'Canada', 'Venezuela', 8),
  ('Central African Republic|China', 'Central African Republic', 'China', 7),
  ('Central African Republic|Croatia', 'Central African Republic', 'Croatia', 7),
  ('Central African Republic|Estonia', 'Central African Republic', 'Estonia', 7),
  ('Central African Republic|Finland', 'Central African Republic', 'Finland', 7),
  ('Central African Republic|Georgia', 'Central African Republic', 'Georgia', 5),
  ('Central African Republic|Germany', 'Central African Republic', 'Germany', 5),
  ('Central African Republic|Greece', 'Central African Republic', 'Greece', 5),
  ('Central African Republic|Hungary', 'Central African Republic', 'Hungary', 7),
  ('Central African Republic|India', 'Central African Republic', 'India', 7),
  ('Central African Republic|Iran', 'Central African Republic', 'Iran', 5),
  ('Central African Republic|Italy', 'Central African Republic', 'Italy', 5),
  ('Central African Republic|Kazakhstan', 'Central African Republic', 'Kazakhstan', 7),
  ('Central African Republic|Kosovo', 'Central African Republic', 'Kosovo', 7),
  ('Central African Republic|Kuwait', 'Central African Republic', 'Kuwait', 5),
  ('Central African Republic|Kyrgyzstan', 'Central African Republic', 'Kyrgyzstan', 8),
  ('Central African Republic|Laos', 'Central African Republic', 'Laos', 8),
  ('Central African Republic|Latvia', 'Central African Republic', 'Latvia', 7),
  ('Central African Republic|Lithuania', 'Central African Republic', 'Lithuania', 7),
  ('Central African Republic|Luxembourg', 'Central African Republic', 'Luxembourg', 5),
  ('Central African Republic|Moldova', 'Central African Republic', 'Moldova', 7),
  ('Central African Republic|Mongolia', 'Central African Republic', 'Mongolia', 7),
  ('Central African Republic|Montenegro', 'Central African Republic', 'Montenegro', 7),
  ('Central African Republic|Myanmar', 'Central African Republic', 'Myanmar', 8),
  ('Central African Republic|Nepal', 'Central African Republic', 'Nepal', 8),
  ('Central African Republic|North Korea', 'Central African Republic', 'North Korea', 7),
  ('Central African Republic|Norway', 'Central African Republic', 'Norway', 7),
  ('Central African Republic|Oman', 'Central African Republic', 'Oman', 5),
  ('Central African Republic|Qatar', 'Central African Republic', 'Qatar', 5),
  ('Central African Republic|Slovakia', 'Central African Republic', 'Slovakia', 7),
  ('Central African Republic|South Korea', 'Central African Republic', 'South Korea', 8),
  ('Central African Republic|Sweden', 'Central African Republic', 'Sweden', 8),
  ('Central African Republic|Switzerland', 'Central African Republic', 'Switzerland', 5),
  ('Central African Republic|Tajikistan', 'Central African Republic', 'Tajikistan', 7),
  ('Central African Republic|Thailand', 'Central African Republic', 'Thailand', 9),
  ('Central African Republic|UAE', 'Central African Republic', 'UAE', 5),
  ('Central African Republic|Ukraine', 'Central African Republic', 'Ukraine', 7),
  ('Central African Republic|Uzbekistan', 'Central African Republic', 'Uzbekistan', 7),
  ('Central African Republic|Vietnam', 'Central African Republic', 'Vietnam', 8),
  ('Central African Republic|Yemen', 'Central African Republic', 'Yemen', 5),
  ('Chad|China', 'Chad', 'China', 7),
  ('Chad|Czech Republic', 'Chad', 'Czech Republic', 5),
  ('Chad|Denmark', 'Chad', 'Denmark', 5),
  ('Chad|Estonia', 'Chad', 'Estonia', 7),
  ('Chad|Finland', 'Chad', 'Finland', 7),
  ('Chad|Georgia', 'Chad', 'Georgia', 5),
  ('Chad|Greece', 'Chad', 'Greece', 5),
  ('Chad|India', 'Chad', 'India', 7),
  ('Chad|Iran', 'Chad', 'Iran', 5),
  ('Chad|Kazakhstan', 'Chad', 'Kazakhstan', 7),
  ('Chad|Kosovo', 'Chad', 'Kosovo', 7),
  ('Chad|Kuwait', 'Chad', 'Kuwait', 5),
  ('Chad|Kyrgyzstan', 'Chad', 'Kyrgyzstan', 8),
  ('Chad|Laos', 'Chad', 'Laos', 8),
  ('Chad|Latvia', 'Chad', 'Latvia', 7),
  ('Chad|Lesotho', 'Chad', 'Lesotho', 5),
  ('Chad|Moldova', 'Chad', 'Moldova', 7),
  ('Chad|Mongolia', 'Chad', 'Mongolia', 7),
  ('Chad|Montenegro', 'Chad', 'Montenegro', 7),
  ('Chad|Myanmar', 'Chad', 'Myanmar', 8),
  ('Chad|Nepal', 'Chad', 'Nepal', 8),
  ('Chad|Netherlands', 'Chad', 'Netherlands', 5),
  ('Chad|North Korea', 'Chad', 'North Korea', 7),
  ('Chad|Norway', 'Chad', 'Norway', 7),
  ('Chad|Oman', 'Chad', 'Oman', 5),
  ('Chad|Poland', 'Chad', 'Poland', 5),
  ('Chad|Qatar', 'Chad', 'Qatar', 5),
  ('Chad|Slovenia', 'Chad', 'Slovenia', 5),
  ('Chad|South Korea', 'Chad', 'South Korea', 8),
  ('Chad|Sweden', 'Chad', 'Sweden', 8),
  ('Chad|Tajikistan', 'Chad', 'Tajikistan', 7),
  ('Chad|Thailand', 'Chad', 'Thailand', 9),
  ('Chad|UAE', 'Chad', 'UAE', 5),
  ('Chad|Uzbekistan', 'Chad', 'Uzbekistan', 7),
  ('Chad|Vietnam', 'Chad', 'Vietnam', 8),
  ('Chad|Yemen', 'Chad', 'Yemen', 5),
  ('Chile|Honduras', 'Chile', 'Honduras', 5),
  ('Chile|Mexico', 'Chile', 'Mexico', 7),
  ('Chile|USA', 'Chile', 'USA', 8),
  ('China|Democratic Republic of Congo', 'China', 'Democratic Republic of Congo', 8),
  ('China|Djibouti', 'China', 'Djibouti', 8),
  ('China|Egypt', 'China', 'Egypt', 5),
  ('China|Equatorial Guinea', 'China', 'Equatorial Guinea', 9),
  ('China|Eritrea', 'China', 'Eritrea', 7),
  ('China|Ethiopia', 'China', 'Ethiopia', 7),
  ('China|Gabon', 'China', 'Gabon', 9),
  ('China|Ghana', 'China', 'Ghana', 9),
  ('China|Guinea', 'China', 'Guinea', 8),
  ('China|Guinea-Bissau', 'China', 'Guinea-Bissau', 8),
  ('China|Ivory Coast', 'China', 'Ivory Coast', 8),
  ('China|Kenya', 'China', 'Kenya', 8),
  ('China|Liberia', 'China', 'Liberia', 9),
  ('China|Mali', 'China', 'Mali', 7),
  ('China|Morocco', 'China', 'Morocco', 5),
  ('China|Niger', 'China', 'Niger', 7),
  ('China|Nigeria', 'China', 'Nigeria', 8),
  ('China|Portugal', 'China', 'Portugal', 5),
  ('China|Republic of Congo', 'China', 'Republic of Congo', 8),
  ('China|Rwanda', 'China', 'Rwanda', 9),
  ('China|Senegal', 'China', 'Senegal', 7),
  ('China|Sierra Leone', 'China', 'Sierra Leone', 9),
  ('China|Somalia', 'China', 'Somalia', 8),
  ('China|South Sudan', 'China', 'South Sudan', 7),
  ('China|Tanzania', 'China', 'Tanzania', 9),
  ('China|Togo', 'China', 'Togo', 9),
  ('China|Tunisia', 'China', 'Tunisia', 7),
  ('China|Uganda', 'China', 'Uganda', 8),
  ('China|Zambia', 'China', 'Zambia', 9),
  ('Colombia|Mexico', 'Colombia', 'Mexico', 5),
  ('Croatia|Democratic Republic of Congo', 'Croatia', 'Democratic Republic of Congo', 8),
  ('Croatia|Djibouti', 'Croatia', 'Djibouti', 8),
  ('Croatia|Egypt', 'Croatia', 'Egypt', 5),
  ('Croatia|Equatorial Guinea', 'Croatia', 'Equatorial Guinea', 8),
  ('Croatia|Eritrea', 'Croatia', 'Eritrea', 7),
  ('Croatia|Ethiopia', 'Croatia', 'Ethiopia', 7),
  ('Croatia|Gabon', 'Croatia', 'Gabon', 8),
  ('Croatia|Ghana', 'Croatia', 'Ghana', 8),
  ('Croatia|Guinea', 'Croatia', 'Guinea', 7),
  ('Croatia|Guinea-Bissau', 'Croatia', 'Guinea-Bissau', 7),
  ('Croatia|Ivory Coast', 'Croatia', 'Ivory Coast', 7),
  ('Croatia|Kenya', 'Croatia', 'Kenya', 8),
  ('Croatia|Liberia', 'Croatia', 'Liberia', 8),
  ('Croatia|Mauritania', 'Croatia', 'Mauritania', 5),
  ('Croatia|Nigeria', 'Croatia', 'Nigeria', 7),
  ('Croatia|Oman', 'Croatia', 'Oman', 5),
  ('Croatia|Qatar', 'Croatia', 'Qatar', 5),
  ('Croatia|Republic of Congo', 'Croatia', 'Republic of Congo', 8),
  ('Croatia|Rwanda', 'Croatia', 'Rwanda', 9),
  ('Croatia|Sierra Leone', 'Croatia', 'Sierra Leone', 8),
  ('Croatia|Somalia', 'Croatia', 'Somalia', 8),
  ('Croatia|South Sudan', 'Croatia', 'South Sudan', 7),
  ('Croatia|Tanzania', 'Croatia', 'Tanzania', 9),
  ('Croatia|Thailand', 'Croatia', 'Thailand', 5),
  ('Croatia|Togo', 'Croatia', 'Togo', 8),
  ('Croatia|UAE', 'Croatia', 'UAE', 5),
  ('Croatia|Uganda', 'Croatia', 'Uganda', 8),
  ('Croatia|Yemen', 'Croatia', 'Yemen', 5),
  ('Croatia|Zambia', 'Croatia', 'Zambia', 9),
  ('Czech Republic|Democratic Republic of Congo', 'Czech Republic', 'Democratic Republic of Congo', 7),
  ('Czech Republic|Djibouti', 'Czech Republic', 'Djibouti', 8),
  ('Czech Republic|Equatorial Guinea', 'Czech Republic', 'Equatorial Guinea', 7),
  ('Czech Republic|Eritrea', 'Czech Republic', 'Eritrea', 7),
  ('Czech Republic|Ethiopia', 'Czech Republic', 'Ethiopia', 7),
  ('Czech Republic|Gabon', 'Czech Republic', 'Gabon', 7),
  ('Czech Republic|Ghana', 'Czech Republic', 'Ghana', 7),
  ('Czech Republic|Israel', 'Czech Republic', 'Israel', 5),
  ('Czech Republic|Jordan', 'Czech Republic', 'Jordan', 5),
  ('Czech Republic|Kenya', 'Czech Republic', 'Kenya', 8),
  ('Czech Republic|Kuwait', 'Czech Republic', 'Kuwait', 5),
  ('Czech Republic|Lebanon', 'Czech Republic', 'Lebanon', 5),
  ('Czech Republic|Liberia', 'Czech Republic', 'Liberia', 7),
  ('Czech Republic|Libya', 'Czech Republic', 'Libya', 5),
  ('Czech Republic|Malawi', 'Czech Republic', 'Malawi', 9),
  ('Czech Republic|Malaysia', 'Czech Republic', 'Malaysia', 5),
  ('Czech Republic|Mali', 'Czech Republic', 'Mali', 5),
  ('Czech Republic|Mozambique', 'Czech Republic', 'Mozambique', 9),
  ('Czech Republic|Namibia', 'Czech Republic', 'Namibia', 9),
  ('Czech Republic|Niger', 'Czech Republic', 'Niger', 5),
  ('Czech Republic|Republic of Congo', 'Czech Republic', 'Republic of Congo', 7),
  ('Czech Republic|Rwanda', 'Czech Republic', 'Rwanda', 8),
  ('Czech Republic|Saudi Arabia', 'Czech Republic', 'Saudi Arabia', 5),
  ('Czech Republic|Senegal', 'Czech Republic', 'Senegal', 5),
  ('Czech Republic|Sierra Leone', 'Czech Republic', 'Sierra Leone', 7),
  ('Czech Republic|Somalia', 'Czech Republic', 'Somalia', 8),
  ('Czech Republic|South Sudan', 'Czech Republic', 'South Sudan', 7),
  ('Czech Republic|Tanzania', 'Czech Republic', 'Tanzania', 8),
  ('Czech Republic|Togo', 'Czech Republic', 'Togo', 7),
  ('Czech Republic|Tunisia', 'Czech Republic', 'Tunisia', 5),
  ('Czech Republic|Uganda', 'Czech Republic', 'Uganda', 8),
  ('Czech Republic|Zambia', 'Czech Republic', 'Zambia', 8),
  ('Czech Republic|Zimbabwe', 'Czech Republic', 'Zimbabwe', 9),
  ('Democratic Republic of Congo|Denmark', 'Democratic Republic of Congo', 'Denmark', 7),
  ('Democratic Republic of Congo|Estonia', 'Democratic Republic of Congo', 'Estonia', 8),
  ('Democratic Republic of Congo|Finland', 'Democratic Republic of Congo', 'Finland', 8),
  ('Democratic Republic of Congo|France', 'Democratic Republic of Congo', 'France', 5),
  ('Democratic Republic of Congo|Guinea-Bissau', 'Democratic Republic of Congo', 'Guinea-Bissau', 5),
  ('Democratic Republic of Congo|Hungary', 'Democratic Republic of Congo', 'Hungary', 8),
  ('Democratic Republic of Congo|India', 'Democratic Republic of Congo', 'India', 8),
  ('Democratic Republic of Congo|Iraq', 'Democratic Republic of Congo', 'Iraq', 5),
  ('Democratic Republic of Congo|Kazakhstan', 'Democratic Republic of Congo', 'Kazakhstan', 8),
  ('Democratic Republic of Congo|Kosovo', 'Democratic Republic of Congo', 'Kosovo', 8),
  ('Democratic Republic of Congo|Kyrgyzstan', 'Democratic Republic of Congo', 'Kyrgyzstan', 9),
  ('Democratic Republic of Congo|Laos', 'Democratic Republic of Congo', 'Laos', 9),
  ('Democratic Republic of Congo|Latvia', 'Democratic Republic of Congo', 'Latvia', 8),
  ('Democratic Republic of Congo|Liberia', 'Democratic Republic of Congo', 'Liberia', 5),
  ('Democratic Republic of Congo|Lithuania', 'Democratic Republic of Congo', 'Lithuania', 8),
  ('Democratic Republic of Congo|Moldova', 'Democratic Republic of Congo', 'Moldova', 8),
  ('Democratic Republic of Congo|Mongolia', 'Democratic Republic of Congo', 'Mongolia', 8),
  ('Democratic Republic of Congo|Montenegro', 'Democratic Republic of Congo', 'Montenegro', 8),
  ('Democratic Republic of Congo|Myanmar', 'Democratic Republic of Congo', 'Myanmar', 9),
  ('Democratic Republic of Congo|Nepal', 'Democratic Republic of Congo', 'Nepal', 9),
  ('Democratic Republic of Congo|Netherlands', 'Democratic Republic of Congo', 'Netherlands', 7),
  ('Democratic Republic of Congo|North Korea', 'Democratic Republic of Congo', 'North Korea', 8),
  ('Democratic Republic of Congo|North Macedonia', 'Democratic Republic of Congo', 'North Macedonia', 7),
  ('Democratic Republic of Congo|Norway', 'Democratic Republic of Congo', 'Norway', 8),
  ('Democratic Republic of Congo|Pakistan', 'Democratic Republic of Congo', 'Pakistan', 7),
  ('Democratic Republic of Congo|Poland', 'Democratic Republic of Congo', 'Poland', 7),
  ('Democratic Republic of Congo|Portugal', 'Democratic Republic of Congo', 'Portugal', 5),
  ('Democratic Republic of Congo|Romania', 'Democratic Republic of Congo', 'Romania', 7),
  ('Democratic Republic of Congo|Russia', 'Democratic Republic of Congo', 'Russia', 7),
  ('Democratic Republic of Congo|Saudi Arabia', 'Democratic Republic of Congo', 'Saudi Arabia', 5),
  ('Democratic Republic of Congo|Serbia', 'Democratic Republic of Congo', 'Serbia', 7),
  ('Democratic Republic of Congo|Sierra Leone', 'Democratic Republic of Congo', 'Sierra Leone', 5),
  ('Democratic Republic of Congo|Slovakia', 'Democratic Republic of Congo', 'Slovakia', 8),
  ('Democratic Republic of Congo|Slovenia', 'Democratic Republic of Congo', 'Slovenia', 7),
  ('Democratic Republic of Congo|South Korea', 'Democratic Republic of Congo', 'South Korea', 9),
  ('Democratic Republic of Congo|Sweden', 'Democratic Republic of Congo', 'Sweden', 9),
  ('Democratic Republic of Congo|Tajikistan', 'Democratic Republic of Congo', 'Tajikistan', 8),
  ('Democratic Republic of Congo|Turkey', 'Democratic Republic of Congo', 'Turkey', 5),
  ('Democratic Republic of Congo|Turkmenistan', 'Democratic Republic of Congo', 'Turkmenistan', 7),
  ('Democratic Republic of Congo|Ukraine', 'Democratic Republic of Congo', 'Ukraine', 8),
  ('Democratic Republic of Congo|Uzbekistan', 'Democratic Republic of Congo', 'Uzbekistan', 8),
  ('Democratic Republic of Congo|Vietnam', 'Democratic Republic of Congo', 'Vietnam', 9),
  ('Denmark|Djibouti', 'Denmark', 'Djibouti', 8),
  ('Denmark|Equatorial Guinea', 'Denmark', 'Equatorial Guinea', 7),
  ('Denmark|Eritrea', 'Denmark', 'Eritrea', 7),
  ('Denmark|Ethiopia', 'Denmark', 'Ethiopia', 7),
  ('Denmark|Gabon', 'Denmark', 'Gabon', 7),
  ('Denmark|Ghana', 'Denmark', 'Ghana', 7),
  ('Denmark|Greece', 'Denmark', 'Greece', 5),
  ('Denmark|Iraq', 'Denmark', 'Iraq', 5),
  ('Denmark|Kenya', 'Denmark', 'Kenya', 8),
  ('Denmark|Liberia', 'Denmark', 'Liberia', 7),
  ('Denmark|Libya', 'Denmark', 'Libya', 5),
  ('Denmark|Malawi', 'Denmark', 'Malawi', 9),
  ('Denmark|Mali', 'Denmark', 'Mali', 5),
  ('Denmark|Mozambique', 'Denmark', 'Mozambique', 9),
  ('Denmark|Namibia', 'Denmark', 'Namibia', 9),
  ('Denmark|Niger', 'Denmark', 'Niger', 5),
  ('Denmark|Oman', 'Denmark', 'Oman', 7),
  ('Denmark|Qatar', 'Denmark', 'Qatar', 7),
  ('Denmark|Republic of Congo', 'Denmark', 'Republic of Congo', 7),
  ('Denmark|Rwanda', 'Denmark', 'Rwanda', 8),
  ('Denmark|Senegal', 'Denmark', 'Senegal', 5),
  ('Denmark|Sierra Leone', 'Denmark', 'Sierra Leone', 7),
  ('Denmark|Somalia', 'Denmark', 'Somalia', 8),
  ('Denmark|South Sudan', 'Denmark', 'South Sudan', 7),
  ('Denmark|Syria', 'Denmark', 'Syria', 5),
  ('Denmark|Tanzania', 'Denmark', 'Tanzania', 8),
  ('Denmark|Thailand', 'Denmark', 'Thailand', 5),
  ('Denmark|Togo', 'Denmark', 'Togo', 7),
  ('Denmark|Tunisia', 'Denmark', 'Tunisia', 5),
  ('Denmark|UAE', 'Denmark', 'UAE', 7),
  ('Denmark|Uganda', 'Denmark', 'Uganda', 8),
  ('Denmark|Yemen', 'Denmark', 'Yemen', 7),
  ('Denmark|Zambia', 'Denmark', 'Zambia', 8),
  ('Denmark|Zimbabwe', 'Denmark', 'Zimbabwe', 9),
  ('Djibouti|Estonia', 'Djibouti', 'Estonia', 8),
  ('Djibouti|Finland', 'Djibouti', 'Finland', 8),
  ('Djibouti|Germany', 'Djibouti', 'Germany', 7),
  ('Djibouti|Ghana', 'Djibouti', 'Ghana', 5),
  ('Djibouti|Guinea', 'Djibouti', 'Guinea', 5),
  ('Djibouti|Hungary', 'Djibouti', 'Hungary', 8),
  ('Djibouti|India', 'Djibouti', 'India', 8),
  ('Djibouti|Iraq', 'Djibouti', 'Iraq', 5),
  ('Djibouti|Italy', 'Djibouti', 'Italy', 7),
  ('Djibouti|Ivory Coast', 'Djibouti', 'Ivory Coast', 5),
  ('Djibouti|Kazakhstan', 'Djibouti', 'Kazakhstan', 8),
  ('Djibouti|Kosovo', 'Djibouti', 'Kosovo', 8),
  ('Djibouti|Kyrgyzstan', 'Djibouti', 'Kyrgyzstan', 9),
  ('Djibouti|Laos', 'Djibouti', 'Laos', 9),
  ('Djibouti|Latvia', 'Djibouti', 'Latvia', 8),
  ('Djibouti|Lesotho', 'Djibouti', 'Lesotho', 5),
  ('Djibouti|Lithuania', 'Djibouti', 'Lithuania', 8),
  ('Djibouti|Luxembourg', 'Djibouti', 'Luxembourg', 7),
  ('Djibouti|Moldova', 'Djibouti', 'Moldova', 8),
  ('Djibouti|Mongolia', 'Djibouti', 'Mongolia', 8),
  ('Djibouti|Montenegro', 'Djibouti', 'Montenegro', 8),
  ('Djibouti|Myanmar', 'Djibouti', 'Myanmar', 9),
  ('Djibouti|Nepal', 'Djibouti', 'Nepal', 9),
  ('Djibouti|Netherlands', 'Djibouti', 'Netherlands', 8),
  ('Djibouti|North Korea', 'Djibouti', 'North Korea', 8),
  ('Djibouti|North Macedonia', 'Djibouti', 'North Macedonia', 7),
  ('Djibouti|Norway', 'Djibouti', 'Norway', 8),
  ('Djibouti|Pakistan', 'Djibouti', 'Pakistan', 7),
  ('Djibouti|Poland', 'Djibouti', 'Poland', 8),
  ('Djibouti|Romania', 'Djibouti', 'Romania', 7),
  ('Djibouti|Russia', 'Djibouti', 'Russia', 7),
  ('Djibouti|Saudi Arabia', 'Djibouti', 'Saudi Arabia', 5),
  ('Djibouti|Senegal', 'Djibouti', 'Senegal', 5),
  ('Djibouti|Serbia', 'Djibouti', 'Serbia', 7),
  ('Djibouti|Slovakia', 'Djibouti', 'Slovakia', 9),
  ('Djibouti|Slovenia', 'Djibouti', 'Slovenia', 8),
  ('Djibouti|South Korea', 'Djibouti', 'South Korea', 9),
  ('Djibouti|Spain', 'Djibouti', 'Spain', 5),
  ('Djibouti|Sweden', 'Djibouti', 'Sweden', 9),
  ('Djibouti|Switzerland', 'Djibouti', 'Switzerland', 7),
  ('Djibouti|Tajikistan', 'Djibouti', 'Tajikistan', 8),
  ('Djibouti|Togo', 'Djibouti', 'Togo', 5),
  ('Djibouti|Turkey', 'Djibouti', 'Turkey', 5),
  ('Djibouti|Turkmenistan', 'Djibouti', 'Turkmenistan', 7),
  ('Djibouti|Ukraine', 'Djibouti', 'Ukraine', 8),
  ('Djibouti|Uzbekistan', 'Djibouti', 'Uzbekistan', 8),
  ('Djibouti|Vietnam', 'Djibouti', 'Vietnam', 9),
  ('Ecuador|El Salvador', 'Ecuador', 'El Salvador', 5),
  ('Ecuador|Guatemala', 'Ecuador', 'Guatemala', 5),
  ('Ecuador|USA', 'Ecuador', 'USA', 7),
  ('Egypt|Estonia', 'Egypt', 'Estonia', 5),
  ('Egypt|Eswatini', 'Egypt', 'Eswatini', 5),
  ('Egypt|Finland', 'Egypt', 'Finland', 5),
  ('Egypt|Germany', 'Egypt', 'Germany', 5),
  ('Egypt|Hungary', 'Egypt', 'Hungary', 5),
  ('Egypt|India', 'Egypt', 'India', 5),
  ('Egypt|Italy', 'Egypt', 'Italy', 5),
  ('Egypt|Kazakhstan', 'Egypt', 'Kazakhstan', 5),
  ('Egypt|Kosovo', 'Egypt', 'Kosovo', 5),
  ('Egypt|Latvia', 'Egypt', 'Latvia', 5),
  ('Egypt|Lithuania', 'Egypt', 'Lithuania', 5),
  ('Egypt|Luxembourg', 'Egypt', 'Luxembourg', 5),
  ('Egypt|Malaysia', 'Egypt', 'Malaysia', 8),
  ('Egypt|Moldova', 'Egypt', 'Moldova', 5),
  ('Egypt|Mongolia', 'Egypt', 'Mongolia', 5),
  ('Egypt|Montenegro', 'Egypt', 'Montenegro', 5),
  ('Egypt|North Korea', 'Egypt', 'North Korea', 5),
  ('Egypt|Norway', 'Egypt', 'Norway', 5),
  ('Egypt|Poland', 'Egypt', 'Poland', 5),
  ('Egypt|South Africa', 'Egypt', 'South Africa', 5),
  ('Egypt|Switzerland', 'Egypt', 'Switzerland', 5),
  ('Egypt|Tajikistan', 'Egypt', 'Tajikistan', 5),
  ('Egypt|Thailand', 'Egypt', 'Thailand', 7),
  ('Egypt|Ukraine', 'Egypt', 'Ukraine', 5),
  ('Egypt|Uzbekistan', 'Egypt', 'Uzbekistan', 5),
  ('El Salvador|Peru', 'El Salvador', 'Peru', 5),
  ('El Salvador|Venezuela', 'El Salvador', 'Venezuela', 5),
  ('Equatorial Guinea|Estonia', 'Equatorial Guinea', 'Estonia', 9),
  ('Equatorial Guinea|Eswatini', 'Equatorial Guinea', 'Eswatini', 5),
  ('Equatorial Guinea|Finland', 'Equatorial Guinea', 'Finland', 9),
  ('Equatorial Guinea|France', 'Equatorial Guinea', 'France', 5),
  ('Equatorial Guinea|Georgia', 'Equatorial Guinea', 'Georgia', 7),
  ('Equatorial Guinea|Greece', 'Equatorial Guinea', 'Greece', 7),
  ('Equatorial Guinea|Guinea-Bissau', 'Equatorial Guinea', 'Guinea-Bissau', 5),
  ('Equatorial Guinea|Hungary', 'Equatorial Guinea', 'Hungary', 8),
  ('Equatorial Guinea|India', 'Equatorial Guinea', 'India', 9),
  ('Equatorial Guinea|Iran', 'Equatorial Guinea', 'Iran', 7),
  ('Equatorial Guinea|Jordan', 'Equatorial Guinea', 'Jordan', 5),
  ('Equatorial Guinea|Kazakhstan', 'Equatorial Guinea', 'Kazakhstan', 9),
  ('Equatorial Guinea|Kosovo', 'Equatorial Guinea', 'Kosovo', 9),
  ('Equatorial Guinea|Kuwait', 'Equatorial Guinea', 'Kuwait', 7),
  ('Equatorial Guinea|Latvia', 'Equatorial Guinea', 'Latvia', 9),
  ('Equatorial Guinea|Lebanon', 'Equatorial Guinea', 'Lebanon', 5),
  ('Equatorial Guinea|Lesotho', 'Equatorial Guinea', 'Lesotho', 5),
  ('Equatorial Guinea|Liberia', 'Equatorial Guinea', 'Liberia', 5),
  ('Equatorial Guinea|Lithuania', 'Equatorial Guinea', 'Lithuania', 8),
  ('Equatorial Guinea|Moldova', 'Equatorial Guinea', 'Moldova', 9),
  ('Equatorial Guinea|Mongolia', 'Equatorial Guinea', 'Mongolia', 9),
  ('Equatorial Guinea|Montenegro', 'Equatorial Guinea', 'Montenegro', 9),
  ('Equatorial Guinea|Netherlands', 'Equatorial Guinea', 'Netherlands', 7),
  ('Equatorial Guinea|North Korea', 'Equatorial Guinea', 'North Korea', 9),
  ('Equatorial Guinea|North Macedonia', 'Equatorial Guinea', 'North Macedonia', 8),
  ('Equatorial Guinea|Norway', 'Equatorial Guinea', 'Norway', 9),
  ('Equatorial Guinea|Oman', 'Equatorial Guinea', 'Oman', 7),
  ('Equatorial Guinea|Pakistan', 'Equatorial Guinea', 'Pakistan', 8),
  ('Equatorial Guinea|Poland', 'Equatorial Guinea', 'Poland', 7),
  ('Equatorial Guinea|Portugal', 'Equatorial Guinea', 'Portugal', 5),
  ('Equatorial Guinea|Qatar', 'Equatorial Guinea', 'Qatar', 7),
  ('Equatorial Guinea|Romania', 'Equatorial Guinea', 'Romania', 8),
  ('Equatorial Guinea|Russia', 'Equatorial Guinea', 'Russia', 8),
  ('Equatorial Guinea|Serbia', 'Equatorial Guinea', 'Serbia', 8),
  ('Equatorial Guinea|Sierra Leone', 'Equatorial Guinea', 'Sierra Leone', 5),
  ('Equatorial Guinea|Slovakia', 'Equatorial Guinea', 'Slovakia', 8),
  ('Equatorial Guinea|Slovenia', 'Equatorial Guinea', 'Slovenia', 7),
  ('Equatorial Guinea|Syria', 'Equatorial Guinea', 'Syria', 5),
  ('Equatorial Guinea|Tajikistan', 'Equatorial Guinea', 'Tajikistan', 9),
  ('Equatorial Guinea|Turkmenistan', 'Equatorial Guinea', 'Turkmenistan', 8),
  ('Equatorial Guinea|UAE', 'Equatorial Guinea', 'UAE', 7),
  ('Equatorial Guinea|Ukraine', 'Equatorial Guinea', 'Ukraine', 8),
  ('Equatorial Guinea|Uzbekistan', 'Equatorial Guinea', 'Uzbekistan', 9),
  ('Equatorial Guinea|Yemen', 'Equatorial Guinea', 'Yemen', 7),
  ('Eritrea|Estonia', 'Eritrea', 'Estonia', 7),
  ('Eritrea|Finland', 'Eritrea', 'Finland', 7),
  ('Eritrea|France', 'Eritrea', 'France', 5),
  ('Eritrea|Georgia', 'Eritrea', 'Georgia', 5),
  ('Eritrea|Greece', 'Eritrea', 'Greece', 5),
  ('Eritrea|Guinea-Bissau', 'Eritrea', 'Guinea-Bissau', 5),
  ('Eritrea|Hungary', 'Eritrea', 'Hungary', 7),
  ('Eritrea|India', 'Eritrea', 'India', 7),
  ('Eritrea|Iran', 'Eritrea', 'Iran', 5),
  ('Eritrea|Kazakhstan', 'Eritrea', 'Kazakhstan', 7),
  ('Eritrea|Kosovo', 'Eritrea', 'Kosovo', 7),
  ('Eritrea|Kuwait', 'Eritrea', 'Kuwait', 5),
  ('Eritrea|Kyrgyzstan', 'Eritrea', 'Kyrgyzstan', 8),
  ('Eritrea|Laos', 'Eritrea', 'Laos', 8),
  ('Eritrea|Latvia', 'Eritrea', 'Latvia', 7),
  ('Eritrea|Lesotho', 'Eritrea', 'Lesotho', 5),
  ('Eritrea|Liberia', 'Eritrea', 'Liberia', 5),
  ('Eritrea|Lithuania', 'Eritrea', 'Lithuania', 7),
  ('Eritrea|Moldova', 'Eritrea', 'Moldova', 7),
  ('Eritrea|Mongolia', 'Eritrea', 'Mongolia', 7),
  ('Eritrea|Montenegro', 'Eritrea', 'Montenegro', 7),
  ('Eritrea|Myanmar', 'Eritrea', 'Myanmar', 8),
  ('Eritrea|Nepal', 'Eritrea', 'Nepal', 8),
  ('Eritrea|Netherlands', 'Eritrea', 'Netherlands', 7),
  ('Eritrea|North Korea', 'Eritrea', 'North Korea', 7),
  ('Eritrea|Norway', 'Eritrea', 'Norway', 7),
  ('Eritrea|Oman', 'Eritrea', 'Oman', 5),
  ('Eritrea|Poland', 'Eritrea', 'Poland', 7),
  ('Eritrea|Portugal', 'Eritrea', 'Portugal', 5),
  ('Eritrea|Qatar', 'Eritrea', 'Qatar', 5),
  ('Eritrea|Sierra Leone', 'Eritrea', 'Sierra Leone', 5),
  ('Eritrea|Slovakia', 'Eritrea', 'Slovakia', 8),
  ('Eritrea|Slovenia', 'Eritrea', 'Slovenia', 7),
  ('Eritrea|South Korea', 'Eritrea', 'South Korea', 8),
  ('Eritrea|Sweden', 'Eritrea', 'Sweden', 8),
  ('Eritrea|Tajikistan', 'Eritrea', 'Tajikistan', 7),
  ('Eritrea|Thailand', 'Eritrea', 'Thailand', 9),
  ('Eritrea|UAE', 'Eritrea', 'UAE', 5),
  ('Eritrea|Ukraine', 'Eritrea', 'Ukraine', 7),
  ('Eritrea|Uzbekistan', 'Eritrea', 'Uzbekistan', 7),
  ('Eritrea|Vietnam', 'Eritrea', 'Vietnam', 8),
  ('Eritrea|Yemen', 'Eritrea', 'Yemen', 5),
  ('Estonia|Ethiopia', 'Estonia', 'Ethiopia', 7),
  ('Estonia|Gabon', 'Estonia', 'Gabon', 9),
  ('Estonia|Ghana', 'Estonia', 'Ghana', 9),
  ('Estonia|Guinea', 'Estonia', 'Guinea', 8),
  ('Estonia|Guinea-Bissau', 'Estonia', 'Guinea-Bissau', 8),
  ('Estonia|Ivory Coast', 'Estonia', 'Ivory Coast', 8),
  ('Estonia|Kenya', 'Estonia', 'Kenya', 8),
  ('Estonia|Liberia', 'Estonia', 'Liberia', 9),
  ('Estonia|Mali', 'Estonia', 'Mali', 7),
  ('Estonia|Morocco', 'Estonia', 'Morocco', 5),
  ('Estonia|Niger', 'Estonia', 'Niger', 7),
  ('Estonia|Nigeria', 'Estonia', 'Nigeria', 8),
  ('Estonia|Oman', 'Estonia', 'Oman', 5),
  ('Estonia|Portugal', 'Estonia', 'Portugal', 5),
  ('Estonia|Qatar', 'Estonia', 'Qatar', 5),
  ('Estonia|Republic of Congo', 'Estonia', 'Republic of Congo', 8),
  ('Estonia|Rwanda', 'Estonia', 'Rwanda', 9),
  ('Estonia|Senegal', 'Estonia', 'Senegal', 7),
  ('Estonia|Sierra Leone', 'Estonia', 'Sierra Leone', 9),
  ('Estonia|Somalia', 'Estonia', 'Somalia', 8),
  ('Estonia|South Sudan', 'Estonia', 'South Sudan', 7),
  ('Estonia|Tanzania', 'Estonia', 'Tanzania', 9),
  ('Estonia|Togo', 'Estonia', 'Togo', 9),
  ('Estonia|Tunisia', 'Estonia', 'Tunisia', 7),
  ('Estonia|UAE', 'Estonia', 'UAE', 5),
  ('Estonia|Uganda', 'Estonia', 'Uganda', 8),
  ('Estonia|Yemen', 'Estonia', 'Yemen', 5),
  ('Estonia|Zambia', 'Estonia', 'Zambia', 9),
  ('Eswatini|France', 'Eswatini', 'France', 8),
  ('Eswatini|Georgia', 'Eswatini', 'Georgia', 9),
  ('Eswatini|Germany', 'Eswatini', 'Germany', 9),
  ('Eswatini|Ghana', 'Eswatini', 'Ghana', 7),
  ('Eswatini|Greece', 'Eswatini', 'Greece', 9),
  ('Eswatini|Guinea', 'Eswatini', 'Guinea', 7),
  ('Eswatini|Guinea-Bissau', 'Eswatini', 'Guinea-Bissau', 8),
  ('Eswatini|Iran', 'Eswatini', 'Iran', 9),
  ('Eswatini|Iraq', 'Eswatini', 'Iraq', 8),
  ('Eswatini|Italy', 'Eswatini', 'Italy', 9),
  ('Eswatini|Ivory Coast', 'Eswatini', 'Ivory Coast', 7),
  ('Eswatini|Jordan', 'Eswatini', 'Jordan', 7),
  ('Eswatini|Kuwait', 'Eswatini', 'Kuwait', 9),
  ('Eswatini|Lebanon', 'Eswatini', 'Lebanon', 7),
  ('Eswatini|Liberia', 'Eswatini', 'Liberia', 8),
  ('Eswatini|Libya', 'Eswatini', 'Libya', 5),
  ('Eswatini|Luxembourg', 'Eswatini', 'Luxembourg', 9),
  ('Eswatini|Niger', 'Eswatini', 'Niger', 5),
  ('Eswatini|Nigeria', 'Eswatini', 'Nigeria', 5),
  ('Eswatini|Oman', 'Eswatini', 'Oman', 9),
  ('Eswatini|Portugal', 'Eswatini', 'Portugal', 8),
  ('Eswatini|Qatar', 'Eswatini', 'Qatar', 9),
  ('Eswatini|Saudi Arabia', 'Eswatini', 'Saudi Arabia', 8),
  ('Eswatini|Senegal', 'Eswatini', 'Senegal', 7),
  ('Eswatini|Sierra Leone', 'Eswatini', 'Sierra Leone', 8),
  ('Eswatini|Spain', 'Eswatini', 'Spain', 7),
  ('Eswatini|Switzerland', 'Eswatini', 'Switzerland', 9),
  ('Eswatini|Syria', 'Eswatini', 'Syria', 7),
  ('Eswatini|Togo', 'Eswatini', 'Togo', 7),
  ('Eswatini|Turkey', 'Eswatini', 'Turkey', 8),
  ('Eswatini|UAE', 'Eswatini', 'UAE', 9),
  ('Eswatini|Yemen', 'Eswatini', 'Yemen', 9),
  ('Ethiopia|Finland', 'Ethiopia', 'Finland', 7),
  ('Ethiopia|France', 'Ethiopia', 'France', 5),
  ('Ethiopia|Georgia', 'Ethiopia', 'Georgia', 5),
  ('Ethiopia|Greece', 'Ethiopia', 'Greece', 5),
  ('Ethiopia|Guinea-Bissau', 'Ethiopia', 'Guinea-Bissau', 5),
  ('Ethiopia|Hungary', 'Ethiopia', 'Hungary', 7),
  ('Ethiopia|India', 'Ethiopia', 'India', 7),
  ('Ethiopia|Iran', 'Ethiopia', 'Iran', 5),
  ('Ethiopia|Kazakhstan', 'Ethiopia', 'Kazakhstan', 7),
  ('Ethiopia|Kosovo', 'Ethiopia', 'Kosovo', 7),
  ('Ethiopia|Kuwait', 'Ethiopia', 'Kuwait', 5),
  ('Ethiopia|Kyrgyzstan', 'Ethiopia', 'Kyrgyzstan', 8),
  ('Ethiopia|Laos', 'Ethiopia', 'Laos', 8),
  ('Ethiopia|Latvia', 'Ethiopia', 'Latvia', 7),
  ('Ethiopia|Liberia', 'Ethiopia', 'Liberia', 5),
  ('Ethiopia|Lithuania', 'Ethiopia', 'Lithuania', 7),
  ('Ethiopia|Moldova', 'Ethiopia', 'Moldova', 7),
  ('Ethiopia|Mongolia', 'Ethiopia', 'Mongolia', 7),
  ('Ethiopia|Montenegro', 'Ethiopia', 'Montenegro', 7),
  ('Ethiopia|Myanmar', 'Ethiopia', 'Myanmar', 8),
  ('Ethiopia|Nepal', 'Ethiopia', 'Nepal', 8),
  ('Ethiopia|Netherlands', 'Ethiopia', 'Netherlands', 7),
  ('Ethiopia|North Korea', 'Ethiopia', 'North Korea', 7),
  ('Ethiopia|Norway', 'Ethiopia', 'Norway', 7),
  ('Ethiopia|Oman', 'Ethiopia', 'Oman', 5),
  ('Ethiopia|Poland', 'Ethiopia', 'Poland', 7),
  ('Ethiopia|Portugal', 'Ethiopia', 'Portugal', 5),
  ('Ethiopia|Qatar', 'Ethiopia', 'Qatar', 5),
  ('Ethiopia|Sierra Leone', 'Ethiopia', 'Sierra Leone', 5),
  ('Ethiopia|Slovakia', 'Ethiopia', 'Slovakia', 8),
  ('Ethiopia|Slovenia', 'Ethiopia', 'Slovenia', 7),
  ('Ethiopia|South Korea', 'Ethiopia', 'South Korea', 8),
  ('Ethiopia|Sweden', 'Ethiopia', 'Sweden', 8),
  ('Ethiopia|Tajikistan', 'Ethiopia', 'Tajikistan', 7),
  ('Ethiopia|Thailand', 'Ethiopia', 'Thailand', 9),
  ('Ethiopia|UAE', 'Ethiopia', 'UAE', 5),
  ('Ethiopia|Ukraine', 'Ethiopia', 'Ukraine', 7),
  ('Ethiopia|Uzbekistan', 'Ethiopia', 'Uzbekistan', 7),
  ('Ethiopia|Vietnam', 'Ethiopia', 'Vietnam', 8),
  ('Ethiopia|Yemen', 'Ethiopia', 'Yemen', 5),
  ('Finland|Gabon', 'Finland', 'Gabon', 9),
  ('Finland|Ghana', 'Finland', 'Ghana', 9),
  ('Finland|Guinea', 'Finland', 'Guinea', 8),
  ('Finland|Guinea-Bissau', 'Finland', 'Guinea-Bissau', 8),
  ('Finland|Ivory Coast', 'Finland', 'Ivory Coast', 8),
  ('Finland|Kenya', 'Finland', 'Kenya', 8),
  ('Finland|Liberia', 'Finland', 'Liberia', 9),
  ('Finland|Mali', 'Finland', 'Mali', 7),
  ('Finland|Morocco', 'Finland', 'Morocco', 5),
  ('Finland|Niger', 'Finland', 'Niger', 7),
  ('Finland|Nigeria', 'Finland', 'Nigeria', 8),
  ('Finland|Oman', 'Finland', 'Oman', 5),
  ('Finland|Portugal', 'Finland', 'Portugal', 5),
  ('Finland|Qatar', 'Finland', 'Qatar', 5),
  ('Finland|Republic of Congo', 'Finland', 'Republic of Congo', 8),
  ('Finland|Rwanda', 'Finland', 'Rwanda', 9),
  ('Finland|Senegal', 'Finland', 'Senegal', 7),
  ('Finland|Sierra Leone', 'Finland', 'Sierra Leone', 9),
  ('Finland|Somalia', 'Finland', 'Somalia', 8),
  ('Finland|South Sudan', 'Finland', 'South Sudan', 7),
  ('Finland|Tanzania', 'Finland', 'Tanzania', 9),
  ('Finland|Togo', 'Finland', 'Togo', 9),
  ('Finland|Tunisia', 'Finland', 'Tunisia', 7),
  ('Finland|UAE', 'Finland', 'UAE', 5),
  ('Finland|Uganda', 'Finland', 'Uganda', 8),
  ('Finland|Yemen', 'Finland', 'Yemen', 5),
  ('Finland|Zambia', 'Finland', 'Zambia', 9),
  ('France|Gabon', 'France', 'Gabon', 5),
  ('France|Ghana', 'France', 'Ghana', 5),
  ('France|Greece', 'France', 'Greece', 5),
  ('France|Iraq', 'France', 'Iraq', 5),
  ('France|Israel', 'France', 'Israel', 5),
  ('France|Lesotho', 'France', 'Lesotho', 9),
  ('France|Liberia', 'France', 'Liberia', 5),
  ('France|Malawi', 'France', 'Malawi', 7),
  ('France|Mozambique', 'France', 'Mozambique', 7),
  ('France|Namibia', 'France', 'Namibia', 7),
  ('France|Oman', 'France', 'Oman', 7),
  ('France|Qatar', 'France', 'Qatar', 7),
  ('France|Republic of Congo', 'France', 'Republic of Congo', 5),
  ('France|Sierra Leone', 'France', 'Sierra Leone', 5),
  ('France|South Africa', 'France', 'South Africa', 8),
  ('France|South Sudan', 'France', 'South Sudan', 5),
  ('France|Syria', 'France', 'Syria', 5),
  ('France|Thailand', 'France', 'Thailand', 5),
  ('France|Togo', 'France', 'Togo', 5),
  ('France|UAE', 'France', 'UAE', 7),
  ('France|Yemen', 'France', 'Yemen', 7),
  ('France|Zimbabwe', 'France', 'Zimbabwe', 7),
  ('Gabon|Georgia', 'Gabon', 'Georgia', 7),
  ('Gabon|Greece', 'Gabon', 'Greece', 7),
  ('Gabon|Guinea-Bissau', 'Gabon', 'Guinea-Bissau', 5),
  ('Gabon|Hungary', 'Gabon', 'Hungary', 8),
  ('Gabon|India', 'Gabon', 'India', 9),
  ('Gabon|Iran', 'Gabon', 'Iran', 7),
  ('Gabon|Jordan', 'Gabon', 'Jordan', 5),
  ('Gabon|Kazakhstan', 'Gabon', 'Kazakhstan', 9),
  ('Gabon|Kosovo', 'Gabon', 'Kosovo', 9),
  ('Gabon|Kuwait', 'Gabon', 'Kuwait', 7),
  ('Gabon|Latvia', 'Gabon', 'Latvia', 9),
  ('Gabon|Lebanon', 'Gabon', 'Lebanon', 5),
  ('Gabon|Liberia', 'Gabon', 'Liberia', 5),
  ('Gabon|Lithuania', 'Gabon', 'Lithuania', 8),
  ('Gabon|Moldova', 'Gabon', 'Moldova', 9),
  ('Gabon|Mongolia', 'Gabon', 'Mongolia', 9),
  ('Gabon|Montenegro', 'Gabon', 'Montenegro', 9),
  ('Gabon|Netherlands', 'Gabon', 'Netherlands', 7),
  ('Gabon|North Korea', 'Gabon', 'North Korea', 9),
  ('Gabon|North Macedonia', 'Gabon', 'North Macedonia', 8),
  ('Gabon|Norway', 'Gabon', 'Norway', 9),
  ('Gabon|Oman', 'Gabon', 'Oman', 7),
  ('Gabon|Pakistan', 'Gabon', 'Pakistan', 8),
  ('Gabon|Poland', 'Gabon', 'Poland', 7),
  ('Gabon|Portugal', 'Gabon', 'Portugal', 5),
  ('Gabon|Qatar', 'Gabon', 'Qatar', 7),
  ('Gabon|Romania', 'Gabon', 'Romania', 8),
  ('Gabon|Russia', 'Gabon', 'Russia', 8),
  ('Gabon|Serbia', 'Gabon', 'Serbia', 8),
  ('Gabon|Sierra Leone', 'Gabon', 'Sierra Leone', 5),
  ('Gabon|Slovakia', 'Gabon', 'Slovakia', 8),
  ('Gabon|Slovenia', 'Gabon', 'Slovenia', 7),
  ('Gabon|Syria', 'Gabon', 'Syria', 5),
  ('Gabon|Tajikistan', 'Gabon', 'Tajikistan', 9),
  ('Gabon|Turkmenistan', 'Gabon', 'Turkmenistan', 8),
  ('Gabon|UAE', 'Gabon', 'UAE', 7),
  ('Gabon|Ukraine', 'Gabon', 'Ukraine', 8),
  ('Gabon|Uzbekistan', 'Gabon', 'Uzbekistan', 9),
  ('Gabon|Yemen', 'Gabon', 'Yemen', 7),
  ('Georgia|Ghana', 'Georgia', 'Ghana', 7),
  ('Georgia|Guinea', 'Georgia', 'Guinea', 7),
  ('Georgia|Guinea-Bissau', 'Georgia', 'Guinea-Bissau', 8),
  ('Georgia|Ivory Coast', 'Georgia', 'Ivory Coast', 7),
  ('Georgia|Liberia', 'Georgia', 'Liberia', 8),
  ('Georgia|Malawi', 'Georgia', 'Malawi', 8),
  ('Georgia|Morocco', 'Georgia', 'Morocco', 5),
  ('Georgia|Mozambique', 'Georgia', 'Mozambique', 8),
  ('Georgia|Namibia', 'Georgia', 'Namibia', 8),
  ('Georgia|Niger', 'Georgia', 'Niger', 5),
  ('Georgia|Portugal', 'Georgia', 'Portugal', 5),
  ('Georgia|Rwanda', 'Georgia', 'Rwanda', 7),
  ('Georgia|Senegal', 'Georgia', 'Senegal', 7),
  ('Georgia|Sierra Leone', 'Georgia', 'Sierra Leone', 8),
  ('Georgia|South Africa', 'Georgia', 'South Africa', 9),
  ('Georgia|South Sudan', 'Georgia', 'South Sudan', 5),
  ('Georgia|Tanzania', 'Georgia', 'Tanzania', 7),
  ('Georgia|Togo', 'Georgia', 'Togo', 7),
  ('Georgia|Tunisia', 'Georgia', 'Tunisia', 5),
  ('Georgia|Zambia', 'Georgia', 'Zambia', 7),
  ('Georgia|Zimbabwe', 'Georgia', 'Zimbabwe', 8),
  ('Germany|Guinea', 'Germany', 'Guinea', 5),
  ('Germany|Guinea-Bissau', 'Germany', 'Guinea-Bissau', 5),
  ('Germany|Israel', 'Germany', 'Israel', 5),
  ('Germany|Ivory Coast', 'Germany', 'Ivory Coast', 5),
  ('Germany|Jordan', 'Germany', 'Jordan', 5),
  ('Germany|Kenya', 'Germany', 'Kenya', 7),
  ('Germany|Kuwait', 'Germany', 'Kuwait', 5),
  ('Germany|Lebanon', 'Germany', 'Lebanon', 5),
  ('Germany|Malawi', 'Germany', 'Malawi', 8),
  ('Germany|Malaysia', 'Germany', 'Malaysia', 5),
  ('Germany|Mozambique', 'Germany', 'Mozambique', 8),
  ('Germany|Namibia', 'Germany', 'Namibia', 8),
  ('Germany|Nigeria', 'Germany', 'Nigeria', 5),
  ('Germany|Rwanda', 'Germany', 'Rwanda', 7),
  ('Germany|Saudi Arabia', 'Germany', 'Saudi Arabia', 5),
  ('Germany|Somalia', 'Germany', 'Somalia', 7),
  ('Germany|South Africa', 'Germany', 'South Africa', 9),
  ('Germany|Sudan', 'Germany', 'Sudan', 5),
  ('Germany|Tanzania', 'Germany', 'Tanzania', 7),
  ('Germany|Uganda', 'Germany', 'Uganda', 7),
  ('Germany|Zambia', 'Germany', 'Zambia', 7),
  ('Germany|Zimbabwe', 'Germany', 'Zimbabwe', 8),
  ('Ghana|Greece', 'Ghana', 'Greece', 7),
  ('Ghana|Hungary', 'Ghana', 'Hungary', 8),
  ('Ghana|India', 'Ghana', 'India', 9),
  ('Ghana|Iran', 'Ghana', 'Iran', 7),
  ('Ghana|Jordan', 'Ghana', 'Jordan', 5),
  ('Ghana|Kazakhstan', 'Ghana', 'Kazakhstan', 9),
  ('Ghana|Kenya', 'Ghana', 'Kenya', 5),
  ('Ghana|Kosovo', 'Ghana', 'Kosovo', 9),
  ('Ghana|Kuwait', 'Ghana', 'Kuwait', 7),
  ('Ghana|Latvia', 'Ghana', 'Latvia', 9),
  ('Ghana|Lebanon', 'Ghana', 'Lebanon', 5),
  ('Ghana|Lesotho', 'Ghana', 'Lesotho', 8),
  ('Ghana|Lithuania', 'Ghana', 'Lithuania', 8),
  ('Ghana|Moldova', 'Ghana', 'Moldova', 9),
  ('Ghana|Mongolia', 'Ghana', 'Mongolia', 9),
  ('Ghana|Montenegro', 'Ghana', 'Montenegro', 9),
  ('Ghana|Netherlands', 'Ghana', 'Netherlands', 7),
  ('Ghana|North Korea', 'Ghana', 'North Korea', 9),
  ('Ghana|North Macedonia', 'Ghana', 'North Macedonia', 8),
  ('Ghana|Norway', 'Ghana', 'Norway', 9),
  ('Ghana|Oman', 'Ghana', 'Oman', 7),
  ('Ghana|Pakistan', 'Ghana', 'Pakistan', 8),
  ('Ghana|Poland', 'Ghana', 'Poland', 7),
  ('Ghana|Portugal', 'Ghana', 'Portugal', 5),
  ('Ghana|Qatar', 'Ghana', 'Qatar', 7),
  ('Ghana|Romania', 'Ghana', 'Romania', 8),
  ('Ghana|Russia', 'Ghana', 'Russia', 8),
  ('Ghana|Rwanda', 'Ghana', 'Rwanda', 5),
  ('Ghana|Serbia', 'Ghana', 'Serbia', 8),
  ('Ghana|Slovakia', 'Ghana', 'Slovakia', 8),
  ('Ghana|Slovenia', 'Ghana', 'Slovenia', 7),
  ('Ghana|Somalia', 'Ghana', 'Somalia', 5),
  ('Ghana|South Africa', 'Ghana', 'South Africa', 7),
  ('Ghana|Syria', 'Ghana', 'Syria', 5),
  ('Ghana|Tajikistan', 'Ghana', 'Tajikistan', 9),
  ('Ghana|Tanzania', 'Ghana', 'Tanzania', 5),
  ('Ghana|Turkmenistan', 'Ghana', 'Turkmenistan', 8),
  ('Ghana|UAE', 'Ghana', 'UAE', 7),
  ('Ghana|Uganda', 'Ghana', 'Uganda', 5),
  ('Ghana|Ukraine', 'Ghana', 'Ukraine', 8),
  ('Ghana|Uzbekistan', 'Ghana', 'Uzbekistan', 9),
  ('Ghana|Yemen', 'Ghana', 'Yemen', 7),
  ('Ghana|Zambia', 'Ghana', 'Zambia', 5),
  ('Greece|Guinea', 'Greece', 'Guinea', 7),
  ('Greece|Guinea-Bissau', 'Greece', 'Guinea-Bissau', 8),
  ('Greece|Ivory Coast', 'Greece', 'Ivory Coast', 7),
  ('Greece|Liberia', 'Greece', 'Liberia', 8),
  ('Greece|Luxembourg', 'Greece', 'Luxembourg', 5),
  ('Greece|Malawi', 'Greece', 'Malawi', 8),
  ('Greece|Mozambique', 'Greece', 'Mozambique', 8),
  ('Greece|Namibia', 'Greece', 'Namibia', 8),
  ('Greece|Netherlands', 'Greece', 'Netherlands', 5),
  ('Greece|Niger', 'Greece', 'Niger', 5),
  ('Greece|Portugal', 'Greece', 'Portugal', 7),
  ('Greece|Rwanda', 'Greece', 'Rwanda', 7),
  ('Greece|Senegal', 'Greece', 'Senegal', 7),
  ('Greece|Sierra Leone', 'Greece', 'Sierra Leone', 8),
  ('Greece|South Africa', 'Greece', 'South Africa', 9),
  ('Greece|South Sudan', 'Greece', 'South Sudan', 5),
  ('Greece|Tanzania', 'Greece', 'Tanzania', 7),
  ('Greece|Thailand', 'Greece', 'Thailand', 5),
  ('Greece|Togo', 'Greece', 'Togo', 7),
  ('Greece|Tunisia', 'Greece', 'Tunisia', 5),
  ('Greece|Zambia', 'Greece', 'Zambia', 7),
  ('Greece|Zimbabwe', 'Greece', 'Zimbabwe', 8),
  ('Guatemala|Peru', 'Guatemala', 'Peru', 5),
  ('Guatemala|Venezuela', 'Guatemala', 'Venezuela', 5),
  ('Guinea|Hungary', 'Guinea', 'Hungary', 7),
  ('Guinea|India', 'Guinea', 'India', 9),
  ('Guinea|Iran', 'Guinea', 'Iran', 7),
  ('Guinea|Italy', 'Guinea', 'Italy', 5),
  ('Guinea|Jordan', 'Guinea', 'Jordan', 5),
  ('Guinea|Kazakhstan', 'Guinea', 'Kazakhstan', 8),
  ('Guinea|Kenya', 'Guinea', 'Kenya', 5),
  ('Guinea|Kosovo', 'Guinea', 'Kosovo', 9),
  ('Guinea|Kuwait', 'Guinea', 'Kuwait', 7),
  ('Guinea|Kyrgyzstan', 'Guinea', 'Kyrgyzstan', 9),
  ('Guinea|Laos', 'Guinea', 'Laos', 9),
  ('Guinea|Latvia', 'Guinea', 'Latvia', 8),
  ('Guinea|Lebanon', 'Guinea', 'Lebanon', 5),
  ('Guinea|Lesotho', 'Guinea', 'Lesotho', 8),
  ('Guinea|Lithuania', 'Guinea', 'Lithuania', 7),
  ('Guinea|Luxembourg', 'Guinea', 'Luxembourg', 5),
  ('Guinea|Moldova', 'Guinea', 'Moldova', 8),
  ('Guinea|Mongolia', 'Guinea', 'Mongolia', 8),
  ('Guinea|Montenegro', 'Guinea', 'Montenegro', 8),
  ('Guinea|Myanmar', 'Guinea', 'Myanmar', 9),
  ('Guinea|Nepal', 'Guinea', 'Nepal', 9),
  ('Guinea|North Korea', 'Guinea', 'North Korea', 8),
  ('Guinea|North Macedonia', 'Guinea', 'North Macedonia', 8),
  ('Guinea|Norway', 'Guinea', 'Norway', 8),
  ('Guinea|Oman', 'Guinea', 'Oman', 7),
  ('Guinea|Pakistan', 'Guinea', 'Pakistan', 8),
  ('Guinea|Qatar', 'Guinea', 'Qatar', 7),
  ('Guinea|Romania', 'Guinea', 'Romania', 8),
  ('Guinea|Russia', 'Guinea', 'Russia', 7),
  ('Guinea|Rwanda', 'Guinea', 'Rwanda', 5),
  ('Guinea|Serbia', 'Guinea', 'Serbia', 8),
  ('Guinea|Slovakia', 'Guinea', 'Slovakia', 7),
  ('Guinea|Somalia', 'Guinea', 'Somalia', 5),
  ('Guinea|South Africa', 'Guinea', 'South Africa', 7),
  ('Guinea|South Korea', 'Guinea', 'South Korea', 9),
  ('Guinea|Sweden', 'Guinea', 'Sweden', 9),
  ('Guinea|Switzerland', 'Guinea', 'Switzerland', 5),
  ('Guinea|Syria', 'Guinea', 'Syria', 5),
  ('Guinea|Tajikistan', 'Guinea', 'Tajikistan', 9),
  ('Guinea|Tanzania', 'Guinea', 'Tanzania', 5),
  ('Guinea|Turkmenistan', 'Guinea', 'Turkmenistan', 8),
  ('Guinea|UAE', 'Guinea', 'UAE', 7),
  ('Guinea|Uganda', 'Guinea', 'Uganda', 5),
  ('Guinea|Ukraine', 'Guinea', 'Ukraine', 7),
  ('Guinea|Uzbekistan', 'Guinea', 'Uzbekistan', 9),
  ('Guinea|Vietnam', 'Guinea', 'Vietnam', 9),
  ('Guinea|Yemen', 'Guinea', 'Yemen', 7),
  ('Guinea|Zambia', 'Guinea', 'Zambia', 5),
  ('Guinea-Bissau|Hungary', 'Guinea-Bissau', 'Hungary', 7),
  ('Guinea-Bissau|India', 'Guinea-Bissau', 'India', 9),
  ('Guinea-Bissau|Iran', 'Guinea-Bissau', 'Iran', 8),
  ('Guinea-Bissau|Iraq', 'Guinea-Bissau', 'Iraq', 7),
  ('Guinea-Bissau|Israel', 'Guinea-Bissau', 'Israel', 5),
  ('Guinea-Bissau|Italy', 'Guinea-Bissau', 'Italy', 5),
  ('Guinea-Bissau|Kazakhstan', 'Guinea-Bissau', 'Kazakhstan', 8),
  ('Guinea-Bissau|Kosovo', 'Guinea-Bissau', 'Kosovo', 9),
  ('Guinea-Bissau|Kuwait', 'Guinea-Bissau', 'Kuwait', 8),
  ('Guinea-Bissau|Kyrgyzstan', 'Guinea-Bissau', 'Kyrgyzstan', 9),
  ('Guinea-Bissau|Laos', 'Guinea-Bissau', 'Laos', 9),
  ('Guinea-Bissau|Latvia', 'Guinea-Bissau', 'Latvia', 8),
  ('Guinea-Bissau|Lesotho', 'Guinea-Bissau', 'Lesotho', 9),
  ('Guinea-Bissau|Lithuania', 'Guinea-Bissau', 'Lithuania', 7),
  ('Guinea-Bissau|Luxembourg', 'Guinea-Bissau', 'Luxembourg', 5),
  ('Guinea-Bissau|Malawi', 'Guinea-Bissau', 'Malawi', 7),
  ('Guinea-Bissau|Moldova', 'Guinea-Bissau', 'Moldova', 8),
  ('Guinea-Bissau|Mongolia', 'Guinea-Bissau', 'Mongolia', 8),
  ('Guinea-Bissau|Montenegro', 'Guinea-Bissau', 'Montenegro', 8),
  ('Guinea-Bissau|Mozambique', 'Guinea-Bissau', 'Mozambique', 7),
  ('Guinea-Bissau|Myanmar', 'Guinea-Bissau', 'Myanmar', 9),
  ('Guinea-Bissau|Namibia', 'Guinea-Bissau', 'Namibia', 7),
  ('Guinea-Bissau|Nepal', 'Guinea-Bissau', 'Nepal', 9),
  ('Guinea-Bissau|North Korea', 'Guinea-Bissau', 'North Korea', 8),
  ('Guinea-Bissau|North Macedonia', 'Guinea-Bissau', 'North Macedonia', 9),
  ('Guinea-Bissau|Norway', 'Guinea-Bissau', 'Norway', 8),
  ('Guinea-Bissau|Oman', 'Guinea-Bissau', 'Oman', 8),
  ('Guinea-Bissau|Pakistan', 'Guinea-Bissau', 'Pakistan', 9),
  ('Guinea-Bissau|Qatar', 'Guinea-Bissau', 'Qatar', 8),
  ('Guinea-Bissau|Republic of Congo', 'Guinea-Bissau', 'Republic of Congo', 5),
  ('Guinea-Bissau|Romania', 'Guinea-Bissau', 'Romania', 8),
  ('Guinea-Bissau|Russia', 'Guinea-Bissau', 'Russia', 7),
  ('Guinea-Bissau|Saudi Arabia', 'Guinea-Bissau', 'Saudi Arabia', 7),
  ('Guinea-Bissau|Serbia', 'Guinea-Bissau', 'Serbia', 8),
  ('Guinea-Bissau|Slovakia', 'Guinea-Bissau', 'Slovakia', 7),
  ('Guinea-Bissau|South Africa', 'Guinea-Bissau', 'South Africa', 8),
  ('Guinea-Bissau|South Korea', 'Guinea-Bissau', 'South Korea', 9),
  ('Guinea-Bissau|South Sudan', 'Guinea-Bissau', 'South Sudan', 5),
  ('Guinea-Bissau|Sweden', 'Guinea-Bissau', 'Sweden', 9),
  ('Guinea-Bissau|Switzerland', 'Guinea-Bissau', 'Switzerland', 5),
  ('Guinea-Bissau|Tajikistan', 'Guinea-Bissau', 'Tajikistan', 9),
  ('Guinea-Bissau|Turkey', 'Guinea-Bissau', 'Turkey', 7),
  ('Guinea-Bissau|Turkmenistan', 'Guinea-Bissau', 'Turkmenistan', 9),
  ('Guinea-Bissau|UAE', 'Guinea-Bissau', 'UAE', 8),
  ('Guinea-Bissau|Ukraine', 'Guinea-Bissau', 'Ukraine', 7),
  ('Guinea-Bissau|Uzbekistan', 'Guinea-Bissau', 'Uzbekistan', 9),
  ('Guinea-Bissau|Vietnam', 'Guinea-Bissau', 'Vietnam', 9),
  ('Guinea-Bissau|Yemen', 'Guinea-Bissau', 'Yemen', 8),
  ('Guinea-Bissau|Zimbabwe', 'Guinea-Bissau', 'Zimbabwe', 7),
  ('Guyana|Honduras', 'Guyana', 'Honduras', 5),
  ('Guyana|Mexico', 'Guyana', 'Mexico', 7),
  ('Guyana|USA', 'Guyana', 'USA', 8),
  ('Honduras|Paraguay', 'Honduras', 'Paraguay', 5),
  ('Honduras|Suriname', 'Honduras', 'Suriname', 5),
  ('Honduras|Uruguay', 'Honduras', 'Uruguay', 5),
  ('Hungary|Ivory Coast', 'Hungary', 'Ivory Coast', 7),
  ('Hungary|Kenya', 'Hungary', 'Kenya', 8),
  ('Hungary|Liberia', 'Hungary', 'Liberia', 8),
  ('Hungary|Malaysia', 'Hungary', 'Malaysia', 5),
  ('Hungary|Mauritania', 'Hungary', 'Mauritania', 5),
  ('Hungary|Nigeria', 'Hungary', 'Nigeria', 7),
  ('Hungary|Oman', 'Hungary', 'Oman', 5),
  ('Hungary|Qatar', 'Hungary', 'Qatar', 5),
  ('Hungary|Republic of Congo', 'Hungary', 'Republic of Congo', 8),
  ('Hungary|Rwanda', 'Hungary', 'Rwanda', 9),
  ('Hungary|Sierra Leone', 'Hungary', 'Sierra Leone', 8),
  ('Hungary|Somalia', 'Hungary', 'Somalia', 8),
  ('Hungary|South Sudan', 'Hungary', 'South Sudan', 7),
  ('Hungary|Tanzania', 'Hungary', 'Tanzania', 9),
  ('Hungary|Togo', 'Hungary', 'Togo', 8),
  ('Hungary|UAE', 'Hungary', 'UAE', 5),
  ('Hungary|Uganda', 'Hungary', 'Uganda', 8),
  ('Hungary|Yemen', 'Hungary', 'Yemen', 5),
  ('Hungary|Zambia', 'Hungary', 'Zambia', 9),
  ('India|Italy', 'India', 'Italy', 5),
  ('India|Ivory Coast', 'India', 'Ivory Coast', 9),
  ('India|Kenya', 'India', 'Kenya', 8),
  ('India|Kosovo', 'India', 'Kosovo', 5),
  ('India|Mali', 'India', 'Mali', 8),
  ('India|Mauritania', 'India', 'Mauritania', 7),
  ('India|Montenegro', 'India', 'Montenegro', 5),
  ('India|Niger', 'India', 'Niger', 7),
  ('India|Nigeria', 'India', 'Nigeria', 8),
  ('India|Republic of Congo', 'India', 'Republic of Congo', 8),
  ('India|Rwanda', 'India', 'Rwanda', 9),
  ('India|Senegal', 'India', 'Senegal', 8),
  ('India|Somalia', 'India', 'Somalia', 8),
  ('India|South Sudan', 'India', 'South Sudan', 7),
  ('India|Spain', 'India', 'Spain', 5),
  ('India|Tanzania', 'India', 'Tanzania', 9),
  ('India|Togo', 'India', 'Togo', 9),
  ('India|Tunisia', 'India', 'Tunisia', 7),
  ('India|Uganda', 'India', 'Uganda', 8),
  ('India|Zambia', 'India', 'Zambia', 9),
  ('Iran|Italy', 'Iran', 'Italy', 5),
  ('Iran|Ivory Coast', 'Iran', 'Ivory Coast', 7),
  ('Iran|Liberia', 'Iran', 'Liberia', 8),
  ('Iran|Malawi', 'Iran', 'Malawi', 8),
  ('Iran|Mozambique', 'Iran', 'Mozambique', 8),
  ('Iran|Namibia', 'Iran', 'Namibia', 8),
  ('Iran|Niger', 'Iran', 'Niger', 5),
  ('Iran|Rwanda', 'Iran', 'Rwanda', 7),
  ('Iran|Senegal', 'Iran', 'Senegal', 7),
  ('Iran|Sierra Leone', 'Iran', 'Sierra Leone', 8),
  ('Iran|South Africa', 'Iran', 'South Africa', 9),
  ('Iran|South Sudan', 'Iran', 'South Sudan', 5),
  ('Iran|Spain', 'Iran', 'Spain', 5),
  ('Iran|Tanzania', 'Iran', 'Tanzania', 7),
  ('Iran|Togo', 'Iran', 'Togo', 7),
  ('Iran|Tunisia', 'Iran', 'Tunisia', 5),
  ('Iran|Zambia', 'Iran', 'Zambia', 7),
  ('Iran|Zimbabwe', 'Iran', 'Zimbabwe', 8),
  ('Iraq|Italy', 'Iraq', 'Italy', 5),
  ('Iraq|Kenya', 'Iraq', 'Kenya', 5),
  ('Iraq|Lesotho', 'Iraq', 'Lesotho', 9),
  ('Iraq|Liberia', 'Iraq', 'Liberia', 7),
  ('Iraq|Luxembourg', 'Iraq', 'Luxembourg', 5),
  ('Iraq|Malawi', 'Iraq', 'Malawi', 7),
  ('Iraq|Malaysia', 'Iraq', 'Malaysia', 5),
  ('Iraq|Mali', 'Iraq', 'Mali', 5),
  ('Iraq|Mauritania', 'Iraq', 'Mauritania', 5),
  ('Iraq|Morocco', 'Iraq', 'Morocco', 5),
  ('Iraq|Mozambique', 'Iraq', 'Mozambique', 7),
  ('Iraq|Namibia', 'Iraq', 'Namibia', 7),
  ('Iraq|Netherlands', 'Iraq', 'Netherlands', 5),
  ('Iraq|Nigeria', 'Iraq', 'Nigeria', 5),
  ('Iraq|Portugal', 'Iraq', 'Portugal', 7),
  ('Iraq|Republic of Congo', 'Iraq', 'Republic of Congo', 5),
  ('Iraq|Sierra Leone', 'Iraq', 'Sierra Leone', 7),
  ('Iraq|Somalia', 'Iraq', 'Somalia', 5),
  ('Iraq|South Africa', 'Iraq', 'South Africa', 8),
  ('Iraq|Switzerland', 'Iraq', 'Switzerland', 5),
  ('Iraq|Uganda', 'Iraq', 'Uganda', 5),
  ('Iraq|Zimbabwe', 'Iraq', 'Zimbabwe', 7),
  ('Israel|Kyrgyzstan', 'Israel', 'Kyrgyzstan', 5),
  ('Israel|Laos', 'Israel', 'Laos', 5),
  ('Israel|Lesotho', 'Israel', 'Lesotho', 7),
  ('Israel|Liberia', 'Israel', 'Liberia', 5),
  ('Israel|Malawi', 'Israel', 'Malawi', 5),
  ('Israel|Malaysia', 'Israel', 'Malaysia', 7),
  ('Israel|Mozambique', 'Israel', 'Mozambique', 5),
  ('Israel|Myanmar', 'Israel', 'Myanmar', 5),
  ('Israel|Namibia', 'Israel', 'Namibia', 5),
  ('Israel|Nepal', 'Israel', 'Nepal', 5),
  ('Israel|Portugal', 'Israel', 'Portugal', 5),
  ('Israel|Sierra Leone', 'Israel', 'Sierra Leone', 5),
  ('Israel|Slovakia', 'Israel', 'Slovakia', 5),
  ('Israel|Slovenia', 'Israel', 'Slovenia', 5),
  ('Israel|South Korea', 'Israel', 'South Korea', 5),
  ('Israel|Sweden', 'Israel', 'Sweden', 5),
  ('Israel|Vietnam', 'Israel', 'Vietnam', 5),
  ('Israel|Zimbabwe', 'Israel', 'Zimbabwe', 5),
  ('Italy|Ivory Coast', 'Italy', 'Ivory Coast', 5),
  ('Italy|Kenya', 'Italy', 'Kenya', 7),
  ('Italy|Kyrgyzstan', 'Italy', 'Kyrgyzstan', 5),
  ('Italy|Laos', 'Italy', 'Laos', 5),
  ('Italy|Malawi', 'Italy', 'Malawi', 8),
  ('Italy|Malaysia', 'Italy', 'Malaysia', 7),
  ('Italy|Mozambique', 'Italy', 'Mozambique', 8),
  ('Italy|Myanmar', 'Italy', 'Myanmar', 5),
  ('Italy|Namibia', 'Italy', 'Namibia', 8),
  ('Italy|Nepal', 'Italy', 'Nepal', 5),
  ('Italy|Nigeria', 'Italy', 'Nigeria', 5),
  ('Italy|Oman', 'Italy', 'Oman', 7),
  ('Italy|Pakistan', 'Italy', 'Pakistan', 5),
  ('Italy|Qatar', 'Italy', 'Qatar', 7),
  ('Italy|Rwanda', 'Italy', 'Rwanda', 7),
  ('Italy|Somalia', 'Italy', 'Somalia', 7),
  ('Italy|South Africa', 'Italy', 'South Africa', 9),
  ('Italy|South Korea', 'Italy', 'South Korea', 5),
  ('Italy|Sudan', 'Italy', 'Sudan', 5),
  ('Italy|Sweden', 'Italy', 'Sweden', 5),
  ('Italy|Syria', 'Italy', 'Syria', 5),
  ('Italy|Tajikistan', 'Italy', 'Tajikistan', 5),
  ('Italy|Tanzania', 'Italy', 'Tanzania', 7),
  ('Italy|Turkmenistan', 'Italy', 'Turkmenistan', 5),
  ('Italy|UAE', 'Italy', 'UAE', 7),
  ('Italy|Uganda', 'Italy', 'Uganda', 7),
  ('Italy|Uzbekistan', 'Italy', 'Uzbekistan', 5),
  ('Italy|Vietnam', 'Italy', 'Vietnam', 5),
  ('Italy|Yemen', 'Italy', 'Yemen', 7),
  ('Italy|Zambia', 'Italy', 'Zambia', 7),
  ('Italy|Zimbabwe', 'Italy', 'Zimbabwe', 8),
  ('Ivory Coast|Jordan', 'Ivory Coast', 'Jordan', 5),
  ('Ivory Coast|Kazakhstan', 'Ivory Coast', 'Kazakhstan', 8),
  ('Ivory Coast|Kenya', 'Ivory Coast', 'Kenya', 5),
  ('Ivory Coast|Kosovo', 'Ivory Coast', 'Kosovo', 9),
  ('Ivory Coast|Kuwait', 'Ivory Coast', 'Kuwait', 7),
  ('Ivory Coast|Kyrgyzstan', 'Ivory Coast', 'Kyrgyzstan', 9),
  ('Ivory Coast|Laos', 'Ivory Coast', 'Laos', 9),
  ('Ivory Coast|Latvia', 'Ivory Coast', 'Latvia', 8),
  ('Ivory Coast|Lebanon', 'Ivory Coast', 'Lebanon', 5),
  ('Ivory Coast|Lesotho', 'Ivory Coast', 'Lesotho', 8),
  ('Ivory Coast|Lithuania', 'Ivory Coast', 'Lithuania', 7),
  ('Ivory Coast|Luxembourg', 'Ivory Coast', 'Luxembourg', 5),
  ('Ivory Coast|Moldova', 'Ivory Coast', 'Moldova', 8),
  ('Ivory Coast|Mongolia', 'Ivory Coast', 'Mongolia', 8),
  ('Ivory Coast|Montenegro', 'Ivory Coast', 'Montenegro', 8),
  ('Ivory Coast|Myanmar', 'Ivory Coast', 'Myanmar', 9),
  ('Ivory Coast|Nepal', 'Ivory Coast', 'Nepal', 9),
  ('Ivory Coast|North Korea', 'Ivory Coast', 'North Korea', 8),
  ('Ivory Coast|North Macedonia', 'Ivory Coast', 'North Macedonia', 8),
  ('Ivory Coast|Norway', 'Ivory Coast', 'Norway', 8),
  ('Ivory Coast|Oman', 'Ivory Coast', 'Oman', 7),
  ('Ivory Coast|Pakistan', 'Ivory Coast', 'Pakistan', 8),
  ('Ivory Coast|Qatar', 'Ivory Coast', 'Qatar', 7),
  ('Ivory Coast|Romania', 'Ivory Coast', 'Romania', 8),
  ('Ivory Coast|Russia', 'Ivory Coast', 'Russia', 7),
  ('Ivory Coast|Rwanda', 'Ivory Coast', 'Rwanda', 5),
  ('Ivory Coast|Serbia', 'Ivory Coast', 'Serbia', 8),
  ('Ivory Coast|Slovakia', 'Ivory Coast', 'Slovakia', 7),
  ('Ivory Coast|Somalia', 'Ivory Coast', 'Somalia', 5),
  ('Ivory Coast|South Africa', 'Ivory Coast', 'South Africa', 7),
  ('Ivory Coast|South Korea', 'Ivory Coast', 'South Korea', 9),
  ('Ivory Coast|Sweden', 'Ivory Coast', 'Sweden', 9),
  ('Ivory Coast|Switzerland', 'Ivory Coast', 'Switzerland', 5),
  ('Ivory Coast|Syria', 'Ivory Coast', 'Syria', 5),
  ('Ivory Coast|Tajikistan', 'Ivory Coast', 'Tajikistan', 9),
  ('Ivory Coast|Tanzania', 'Ivory Coast', 'Tanzania', 5),
  ('Ivory Coast|Turkmenistan', 'Ivory Coast', 'Turkmenistan', 8),
  ('Ivory Coast|UAE', 'Ivory Coast', 'UAE', 7),
  ('Ivory Coast|Uganda', 'Ivory Coast', 'Uganda', 5),
  ('Ivory Coast|Ukraine', 'Ivory Coast', 'Ukraine', 7),
  ('Ivory Coast|Uzbekistan', 'Ivory Coast', 'Uzbekistan', 9),
  ('Ivory Coast|Vietnam', 'Ivory Coast', 'Vietnam', 9),
  ('Ivory Coast|Yemen', 'Ivory Coast', 'Yemen', 7),
  ('Ivory Coast|Zambia', 'Ivory Coast', 'Zambia', 5),
  ('Jordan|Lesotho', 'Jordan', 'Lesotho', 8),
  ('Jordan|Rwanda', 'Jordan', 'Rwanda', 5),
  ('Jordan|Senegal', 'Jordan', 'Senegal', 5),
  ('Jordan|Slovakia', 'Jordan', 'Slovakia', 5),
  ('Jordan|Slovenia', 'Jordan', 'Slovenia', 5),
  ('Jordan|South Africa', 'Jordan', 'South Africa', 7),
  ('Jordan|South Korea', 'Jordan', 'South Korea', 5),
  ('Jordan|Spain', 'Jordan', 'Spain', 5),
  ('Jordan|Sweden', 'Jordan', 'Sweden', 5),
  ('Jordan|Tanzania', 'Jordan', 'Tanzania', 5),
  ('Jordan|Thailand', 'Jordan', 'Thailand', 5),
  ('Jordan|Togo', 'Jordan', 'Togo', 5),
  ('Jordan|Zambia', 'Jordan', 'Zambia', 5),
  ('Kazakhstan|Kenya', 'Kazakhstan', 'Kenya', 8),
  ('Kazakhstan|Liberia', 'Kazakhstan', 'Liberia', 9),
  ('Kazakhstan|Mali', 'Kazakhstan', 'Mali', 7),
  ('Kazakhstan|Morocco', 'Kazakhstan', 'Morocco', 5),
  ('Kazakhstan|Niger', 'Kazakhstan', 'Niger', 7),
  ('Kazakhstan|Nigeria', 'Kazakhstan', 'Nigeria', 8),
  ('Kazakhstan|Portugal', 'Kazakhstan', 'Portugal', 5),
  ('Kazakhstan|Republic of Congo', 'Kazakhstan', 'Republic of Congo', 8),
  ('Kazakhstan|Rwanda', 'Kazakhstan', 'Rwanda', 9),
  ('Kazakhstan|Senegal', 'Kazakhstan', 'Senegal', 7),
  ('Kazakhstan|Sierra Leone', 'Kazakhstan', 'Sierra Leone', 9),
  ('Kazakhstan|Somalia', 'Kazakhstan', 'Somalia', 8),
  ('Kazakhstan|South Sudan', 'Kazakhstan', 'South Sudan', 7),
  ('Kazakhstan|Tanzania', 'Kazakhstan', 'Tanzania', 9),
  ('Kazakhstan|Togo', 'Kazakhstan', 'Togo', 9),
  ('Kazakhstan|Tunisia', 'Kazakhstan', 'Tunisia', 7),
  ('Kazakhstan|Uganda', 'Kazakhstan', 'Uganda', 8),
  ('Kazakhstan|Zambia', 'Kazakhstan', 'Zambia', 9),
  ('Kenya|Kosovo', 'Kenya', 'Kosovo', 8),
  ('Kenya|Kyrgyzstan', 'Kenya', 'Kyrgyzstan', 9),
  ('Kenya|Laos', 'Kenya', 'Laos', 9),
  ('Kenya|Latvia', 'Kenya', 'Latvia', 8),
  ('Kenya|Lithuania', 'Kenya', 'Lithuania', 8),
  ('Kenya|Luxembourg', 'Kenya', 'Luxembourg', 7),
  ('Kenya|Moldova', 'Kenya', 'Moldova', 8),
  ('Kenya|Mongolia', 'Kenya', 'Mongolia', 8),
  ('Kenya|Montenegro', 'Kenya', 'Montenegro', 8),
  ('Kenya|Myanmar', 'Kenya', 'Myanmar', 9),
  ('Kenya|Nepal', 'Kenya', 'Nepal', 9),
  ('Kenya|Netherlands', 'Kenya', 'Netherlands', 8),
  ('Kenya|North Korea', 'Kenya', 'North Korea', 8),
  ('Kenya|North Macedonia', 'Kenya', 'North Macedonia', 7),
  ('Kenya|Norway', 'Kenya', 'Norway', 8),
  ('Kenya|Pakistan', 'Kenya', 'Pakistan', 7),
  ('Kenya|Poland', 'Kenya', 'Poland', 8),
  ('Kenya|Romania', 'Kenya', 'Romania', 7),
  ('Kenya|Russia', 'Kenya', 'Russia', 7),
  ('Kenya|Saudi Arabia', 'Kenya', 'Saudi Arabia', 5),
  ('Kenya|Senegal', 'Kenya', 'Senegal', 5),
  ('Kenya|Serbia', 'Kenya', 'Serbia', 7),
  ('Kenya|Slovakia', 'Kenya', 'Slovakia', 9),
  ('Kenya|Slovenia', 'Kenya', 'Slovenia', 8),
  ('Kenya|South Korea', 'Kenya', 'South Korea', 9),
  ('Kenya|Spain', 'Kenya', 'Spain', 5),
  ('Kenya|Sweden', 'Kenya', 'Sweden', 9),
  ('Kenya|Switzerland', 'Kenya', 'Switzerland', 7),
  ('Kenya|Tajikistan', 'Kenya', 'Tajikistan', 8),
  ('Kenya|Togo', 'Kenya', 'Togo', 5),
  ('Kenya|Turkey', 'Kenya', 'Turkey', 5),
  ('Kenya|Turkmenistan', 'Kenya', 'Turkmenistan', 7),
  ('Kenya|Ukraine', 'Kenya', 'Ukraine', 8),
  ('Kenya|Uzbekistan', 'Kenya', 'Uzbekistan', 8),
  ('Kenya|Vietnam', 'Kenya', 'Vietnam', 9),
  ('Kosovo|Kyrgyzstan', 'Kosovo', 'Kyrgyzstan', 5),
  ('Kosovo|Laos', 'Kosovo', 'Laos', 5),
  ('Kosovo|Malaysia', 'Kosovo', 'Malaysia', 7),
  ('Kosovo|Mali', 'Kosovo', 'Mali', 8),
  ('Kosovo|Mauritania', 'Kosovo', 'Mauritania', 7),
  ('Kosovo|Myanmar', 'Kosovo', 'Myanmar', 5),
  ('Kosovo|Nepal', 'Kosovo', 'Nepal', 5),
  ('Kosovo|Niger', 'Kosovo', 'Niger', 7),
  ('Kosovo|Nigeria', 'Kosovo', 'Nigeria', 8),
  ('Kosovo|Oman', 'Kosovo', 'Oman', 5),
  ('Kosovo|Qatar', 'Kosovo', 'Qatar', 5),
  ('Kosovo|Republic of Congo', 'Kosovo', 'Republic of Congo', 8),
  ('Kosovo|Rwanda', 'Kosovo', 'Rwanda', 9),
  ('Kosovo|Senegal', 'Kosovo', 'Senegal', 8),
  ('Kosovo|Somalia', 'Kosovo', 'Somalia', 8),
  ('Kosovo|South Korea', 'Kosovo', 'South Korea', 5),
  ('Kosovo|South Sudan', 'Kosovo', 'South Sudan', 7),
  ('Kosovo|Spain', 'Kosovo', 'Spain', 5),
  ('Kosovo|Sweden', 'Kosovo', 'Sweden', 5),
  ('Kosovo|Tajikistan', 'Kosovo', 'Tajikistan', 5),
  ('Kosovo|Tanzania', 'Kosovo', 'Tanzania', 9),
  ('Kosovo|Togo', 'Kosovo', 'Togo', 9),
  ('Kosovo|Tunisia', 'Kosovo', 'Tunisia', 7),
  ('Kosovo|UAE', 'Kosovo', 'UAE', 5),
  ('Kosovo|Uganda', 'Kosovo', 'Uganda', 8),
  ('Kosovo|Uzbekistan', 'Kosovo', 'Uzbekistan', 5),
  ('Kosovo|Vietnam', 'Kosovo', 'Vietnam', 5),
  ('Kosovo|Yemen', 'Kosovo', 'Yemen', 5),
  ('Kosovo|Zambia', 'Kosovo', 'Zambia', 9),
  ('Kuwait|Liberia', 'Kuwait', 'Liberia', 8),
  ('Kuwait|Malawi', 'Kuwait', 'Malawi', 8),
  ('Kuwait|Mozambique', 'Kuwait', 'Mozambique', 8),
  ('Kuwait|Namibia', 'Kuwait', 'Namibia', 8),
  ('Kuwait|Niger', 'Kuwait', 'Niger', 5),
  ('Kuwait|Portugal', 'Kuwait', 'Portugal', 8),
  ('Kuwait|Rwanda', 'Kuwait', 'Rwanda', 7),
  ('Kuwait|Senegal', 'Kuwait', 'Senegal', 7),
  ('Kuwait|Sierra Leone', 'Kuwait', 'Sierra Leone', 8),
  ('Kuwait|Slovakia', 'Kuwait', 'Slovakia', 5),
  ('Kuwait|Slovenia', 'Kuwait', 'Slovenia', 5),
  ('Kuwait|South Africa', 'Kuwait', 'South Africa', 9),
  ('Kuwait|South Korea', 'Kuwait', 'South Korea', 5),
  ('Kuwait|South Sudan', 'Kuwait', 'South Sudan', 5),
  ('Kuwait|Spain', 'Kuwait', 'Spain', 7),
  ('Kuwait|Sweden', 'Kuwait', 'Sweden', 5),
  ('Kuwait|Tanzania', 'Kuwait', 'Tanzania', 7),
  ('Kuwait|Thailand', 'Kuwait', 'Thailand', 5),
  ('Kuwait|Togo', 'Kuwait', 'Togo', 7),
  ('Kuwait|Tunisia', 'Kuwait', 'Tunisia', 5),
  ('Kuwait|Zambia', 'Kuwait', 'Zambia', 7),
  ('Kuwait|Zimbabwe', 'Kuwait', 'Zimbabwe', 8),
  ('Kyrgyzstan|Lebanon', 'Kyrgyzstan', 'Lebanon', 5),
  ('Kyrgyzstan|Libya', 'Kyrgyzstan', 'Libya', 7),
  ('Kyrgyzstan|Mali', 'Kyrgyzstan', 'Mali', 8),
  ('Kyrgyzstan|Mauritania', 'Kyrgyzstan', 'Mauritania', 7),
  ('Kyrgyzstan|Montenegro', 'Kyrgyzstan', 'Montenegro', 5),
  ('Kyrgyzstan|Niger', 'Kyrgyzstan', 'Niger', 8),
  ('Kyrgyzstan|Nigeria', 'Kyrgyzstan', 'Nigeria', 9),
  ('Kyrgyzstan|North Macedonia', 'Kyrgyzstan', 'North Macedonia', 5),
  ('Kyrgyzstan|Oman', 'Kyrgyzstan', 'Oman', 5),
  ('Kyrgyzstan|Qatar', 'Kyrgyzstan', 'Qatar', 5),
  ('Kyrgyzstan|Republic of Congo', 'Kyrgyzstan', 'Republic of Congo', 9),
  ('Kyrgyzstan|Senegal', 'Kyrgyzstan', 'Senegal', 8),
  ('Kyrgyzstan|Somalia', 'Kyrgyzstan', 'Somalia', 9),
  ('Kyrgyzstan|South Sudan', 'Kyrgyzstan', 'South Sudan', 8),
  ('Kyrgyzstan|Spain', 'Kyrgyzstan', 'Spain', 5),
  ('Kyrgyzstan|Sudan', 'Kyrgyzstan', 'Sudan', 7),
  ('Kyrgyzstan|Tunisia', 'Kyrgyzstan', 'Tunisia', 8),
  ('Kyrgyzstan|UAE', 'Kyrgyzstan', 'UAE', 5),
  ('Kyrgyzstan|Uganda', 'Kyrgyzstan', 'Uganda', 9),
  ('Kyrgyzstan|Yemen', 'Kyrgyzstan', 'Yemen', 5),
  ('Laos|Lebanon', 'Laos', 'Lebanon', 5),
  ('Laos|Libya', 'Laos', 'Libya', 7),
  ('Laos|Mali', 'Laos', 'Mali', 8),
  ('Laos|Mauritania', 'Laos', 'Mauritania', 7),
  ('Laos|Montenegro', 'Laos', 'Montenegro', 5),
  ('Laos|Niger', 'Laos', 'Niger', 8),
  ('Laos|Nigeria', 'Laos', 'Nigeria', 9),
  ('Laos|North Macedonia', 'Laos', 'North Macedonia', 5),
  ('Laos|Oman', 'Laos', 'Oman', 5),
  ('Laos|Qatar', 'Laos', 'Qatar', 5),
  ('Laos|Republic of Congo', 'Laos', 'Republic of Congo', 9),
  ('Laos|Senegal', 'Laos', 'Senegal', 8),
  ('Laos|Somalia', 'Laos', 'Somalia', 9),
  ('Laos|South Sudan', 'Laos', 'South Sudan', 8),
  ('Laos|Spain', 'Laos', 'Spain', 5),
  ('Laos|Sudan', 'Laos', 'Sudan', 7),
  ('Laos|Tunisia', 'Laos', 'Tunisia', 8),
  ('Laos|UAE', 'Laos', 'UAE', 5),
  ('Laos|Uganda', 'Laos', 'Uganda', 9),
  ('Laos|Yemen', 'Laos', 'Yemen', 5),
  ('Latvia|Liberia', 'Latvia', 'Liberia', 9),
  ('Latvia|Mali', 'Latvia', 'Mali', 7),
  ('Latvia|Morocco', 'Latvia', 'Morocco', 5),
  ('Latvia|Niger', 'Latvia', 'Niger', 7),
  ('Latvia|Nigeria', 'Latvia', 'Nigeria', 8),
  ('Latvia|Oman', 'Latvia', 'Oman', 5),
  ('Latvia|Portugal', 'Latvia', 'Portugal', 5),
  ('Latvia|Qatar', 'Latvia', 'Qatar', 5),
  ('Latvia|Republic of Congo', 'Latvia', 'Republic of Congo', 8),
  ('Latvia|Rwanda', 'Latvia', 'Rwanda', 9),
  ('Latvia|Senegal', 'Latvia', 'Senegal', 7),
  ('Latvia|Sierra Leone', 'Latvia', 'Sierra Leone', 9),
  ('Latvia|Somalia', 'Latvia', 'Somalia', 8),
  ('Latvia|South Sudan', 'Latvia', 'South Sudan', 7),
  ('Latvia|Tanzania', 'Latvia', 'Tanzania', 9),
  ('Latvia|Togo', 'Latvia', 'Togo', 9),
  ('Latvia|Tunisia', 'Latvia', 'Tunisia', 7),
  ('Latvia|UAE', 'Latvia', 'UAE', 5),
  ('Latvia|Uganda', 'Latvia', 'Uganda', 8),
  ('Latvia|Yemen', 'Latvia', 'Yemen', 5),
  ('Latvia|Zambia', 'Latvia', 'Zambia', 9),
  ('Lebanon|Lesotho', 'Lebanon', 'Lesotho', 8),
  ('Lebanon|Malaysia', 'Lebanon', 'Malaysia', 7),
  ('Lebanon|Myanmar', 'Lebanon', 'Myanmar', 5),
  ('Lebanon|Nepal', 'Lebanon', 'Nepal', 5),
  ('Lebanon|Rwanda', 'Lebanon', 'Rwanda', 5),
  ('Lebanon|Senegal', 'Lebanon', 'Senegal', 5),
  ('Lebanon|Slovakia', 'Lebanon', 'Slovakia', 5),
  ('Lebanon|Slovenia', 'Lebanon', 'Slovenia', 5),
  ('Lebanon|South Africa', 'Lebanon', 'South Africa', 7),
  ('Lebanon|South Korea', 'Lebanon', 'South Korea', 5),
  ('Lebanon|Spain', 'Lebanon', 'Spain', 5),
  ('Lebanon|Sweden', 'Lebanon', 'Sweden', 5),
  ('Lebanon|Tanzania', 'Lebanon', 'Tanzania', 5),
  ('Lebanon|Togo', 'Lebanon', 'Togo', 5),
  ('Lebanon|Vietnam', 'Lebanon', 'Vietnam', 5),
  ('Lebanon|Zambia', 'Lebanon', 'Zambia', 5),
  ('Lesotho|Liberia', 'Lesotho', 'Liberia', 9),
  ('Lesotho|Mali', 'Lesotho', 'Mali', 7),
  ('Lesotho|Mauritania', 'Lesotho', 'Mauritania', 7),
  ('Lesotho|Morocco', 'Lesotho', 'Morocco', 7),
  ('Lesotho|Nigeria', 'Lesotho', 'Nigeria', 5),
  ('Lesotho|Portugal', 'Lesotho', 'Portugal', 9),
  ('Lesotho|Saudi Arabia', 'Lesotho', 'Saudi Arabia', 9),
  ('Lesotho|Senegal', 'Lesotho', 'Senegal', 8),
  ('Lesotho|Sierra Leone', 'Lesotho', 'Sierra Leone', 9),
  ('Lesotho|Spain', 'Lesotho', 'Spain', 8),
  ('Lesotho|Sudan', 'Lesotho', 'Sudan', 5),
  ('Lesotho|Syria', 'Lesotho', 'Syria', 8),
  ('Lesotho|Togo', 'Lesotho', 'Togo', 7),
  ('Lesotho|Tunisia', 'Lesotho', 'Tunisia', 7),
  ('Lesotho|Turkey', 'Lesotho', 'Turkey', 9),
  ('Liberia|Lithuania', 'Liberia', 'Lithuania', 8),
  ('Liberia|Malawi', 'Liberia', 'Malawi', 7),
  ('Liberia|Moldova', 'Liberia', 'Moldova', 9),
  ('Liberia|Mongolia', 'Liberia', 'Mongolia', 9),
  ('Liberia|Montenegro', 'Liberia', 'Montenegro', 9),
  ('Liberia|Mozambique', 'Liberia', 'Mozambique', 7),
  ('Liberia|Namibia', 'Liberia', 'Namibia', 7),
  ('Liberia|Netherlands', 'Liberia', 'Netherlands', 7),
  ('Liberia|North Korea', 'Liberia', 'North Korea', 9),
  ('Liberia|North Macedonia', 'Liberia', 'North Macedonia', 9),
  ('Liberia|Norway', 'Liberia', 'Norway', 9),
  ('Liberia|Oman', 'Liberia', 'Oman', 8),
  ('Liberia|Pakistan', 'Liberia', 'Pakistan', 9),
  ('Liberia|Poland', 'Liberia', 'Poland', 7),
  ('Liberia|Portugal', 'Liberia', 'Portugal', 5),
  ('Liberia|Qatar', 'Liberia', 'Qatar', 8),
  ('Liberia|Republic of Congo', 'Liberia', 'Republic of Congo', 5),
  ('Liberia|Romania', 'Liberia', 'Romania', 9),
  ('Liberia|Russia', 'Liberia', 'Russia', 8),
  ('Liberia|Saudi Arabia', 'Liberia', 'Saudi Arabia', 7),
  ('Liberia|Serbia', 'Liberia', 'Serbia', 9),
  ('Liberia|Slovakia', 'Liberia', 'Slovakia', 8),
  ('Liberia|Slovenia', 'Liberia', 'Slovenia', 7),
  ('Liberia|South Africa', 'Liberia', 'South Africa', 8),
  ('Liberia|South Sudan', 'Liberia', 'South Sudan', 5),
  ('Liberia|Turkey', 'Liberia', 'Turkey', 7),
  ('Liberia|Turkmenistan', 'Liberia', 'Turkmenistan', 9),
  ('Liberia|UAE', 'Liberia', 'UAE', 8),
  ('Liberia|Ukraine', 'Liberia', 'Ukraine', 8),
  ('Liberia|Yemen', 'Liberia', 'Yemen', 8),
  ('Liberia|Zimbabwe', 'Liberia', 'Zimbabwe', 7),
  ('Libya|Malaysia', 'Libya', 'Malaysia', 9),
  ('Libya|Myanmar', 'Libya', 'Myanmar', 7),
  ('Libya|Nepal', 'Libya', 'Nepal', 7),
  ('Libya|Netherlands', 'Libya', 'Netherlands', 5),
  ('Libya|North Macedonia', 'Libya', 'North Macedonia', 5),
  ('Libya|Pakistan', 'Libya', 'Pakistan', 5),
  ('Libya|Poland', 'Libya', 'Poland', 5),
  ('Libya|Romania', 'Libya', 'Romania', 5),
  ('Libya|Russia', 'Libya', 'Russia', 5),
  ('Libya|Serbia', 'Libya', 'Serbia', 5),
  ('Libya|Slovenia', 'Libya', 'Slovenia', 5),
  ('Libya|South Africa', 'Libya', 'South Africa', 5),
  ('Libya|South Korea', 'Libya', 'South Korea', 7),
  ('Libya|Sweden', 'Libya', 'Sweden', 7),
  ('Libya|Thailand', 'Libya', 'Thailand', 8),
  ('Libya|Turkmenistan', 'Libya', 'Turkmenistan', 5),
  ('Libya|Vietnam', 'Libya', 'Vietnam', 7),
  ('Lithuania|Mauritania', 'Lithuania', 'Mauritania', 5),
  ('Lithuania|Nigeria', 'Lithuania', 'Nigeria', 7),
  ('Lithuania|Oman', 'Lithuania', 'Oman', 5),
  ('Lithuania|Qatar', 'Lithuania', 'Qatar', 5),
  ('Lithuania|Republic of Congo', 'Lithuania', 'Republic of Congo', 8),
  ('Lithuania|Rwanda', 'Lithuania', 'Rwanda', 9),
  ('Lithuania|Sierra Leone', 'Lithuania', 'Sierra Leone', 8),
  ('Lithuania|Somalia', 'Lithuania', 'Somalia', 8),
  ('Lithuania|South Sudan', 'Lithuania', 'South Sudan', 7),
  ('Lithuania|Tanzania', 'Lithuania', 'Tanzania', 9),
  ('Lithuania|Togo', 'Lithuania', 'Togo', 8),
  ('Lithuania|UAE', 'Lithuania', 'UAE', 5),
  ('Lithuania|Uganda', 'Lithuania', 'Uganda', 8),
  ('Lithuania|Yemen', 'Lithuania', 'Yemen', 5),
  ('Lithuania|Zambia', 'Lithuania', 'Zambia', 9),
  ('Luxembourg|Malawi', 'Luxembourg', 'Malawi', 8),
  ('Luxembourg|Mozambique', 'Luxembourg', 'Mozambique', 8),
  ('Luxembourg|Namibia', 'Luxembourg', 'Namibia', 8),
  ('Luxembourg|Nigeria', 'Luxembourg', 'Nigeria', 5),
  ('Luxembourg|Oman', 'Luxembourg', 'Oman', 7),
  ('Luxembourg|Qatar', 'Luxembourg', 'Qatar', 7),
  ('Luxembourg|Rwanda', 'Luxembourg', 'Rwanda', 7),
  ('Luxembourg|Somalia', 'Luxembourg', 'Somalia', 7),
  ('Luxembourg|South Africa', 'Luxembourg', 'South Africa', 9),
  ('Luxembourg|Sudan', 'Luxembourg', 'Sudan', 5),
  ('Luxembourg|Syria', 'Luxembourg', 'Syria', 5),
  ('Luxembourg|Tanzania', 'Luxembourg', 'Tanzania', 7),
  ('Luxembourg|Thailand', 'Luxembourg', 'Thailand', 5),
  ('Luxembourg|UAE', 'Luxembourg', 'UAE', 7),
  ('Luxembourg|Uganda', 'Luxembourg', 'Uganda', 7),
  ('Luxembourg|Yemen', 'Luxembourg', 'Yemen', 7),
  ('Luxembourg|Zambia', 'Luxembourg', 'Zambia', 7),
  ('Luxembourg|Zimbabwe', 'Luxembourg', 'Zimbabwe', 8),
  ('Malawi|Mali', 'Malawi', 'Mali', 5),
  ('Malawi|Mauritania', 'Malawi', 'Mauritania', 5),
  ('Malawi|Morocco', 'Malawi', 'Morocco', 5),
  ('Malawi|Netherlands', 'Malawi', 'Netherlands', 9),
  ('Malawi|North Macedonia', 'Malawi', 'North Macedonia', 9),
  ('Malawi|Oman', 'Malawi', 'Oman', 8),
  ('Malawi|Pakistan', 'Malawi', 'Pakistan', 9),
  ('Malawi|Poland', 'Malawi', 'Poland', 9),
  ('Malawi|Portugal', 'Malawi', 'Portugal', 7),
  ('Malawi|Qatar', 'Malawi', 'Qatar', 8),
  ('Malawi|Romania', 'Malawi', 'Romania', 9),
  ('Malawi|Russia', 'Malawi', 'Russia', 9),
  ('Malawi|Saudi Arabia', 'Malawi', 'Saudi Arabia', 7),
  ('Malawi|Serbia', 'Malawi', 'Serbia', 9),
  ('Malawi|Sierra Leone', 'Malawi', 'Sierra Leone', 7),
  ('Malawi|Slovenia', 'Malawi', 'Slovenia', 9),
  ('Malawi|Switzerland', 'Malawi', 'Switzerland', 8),
  ('Malawi|Tunisia', 'Malawi', 'Tunisia', 5),
  ('Malawi|Turkey', 'Malawi', 'Turkey', 7),
  ('Malawi|Turkmenistan', 'Malawi', 'Turkmenistan', 9),
  ('Malawi|UAE', 'Malawi', 'UAE', 8),
  ('Malawi|Yemen', 'Malawi', 'Yemen', 8),
  ('Malaysia|Mauritania', 'Malaysia', 'Mauritania', 9),
  ('Malaysia|Moldova', 'Malaysia', 'Moldova', 5),
  ('Malaysia|Montenegro', 'Malaysia', 'Montenegro', 7),
  ('Malaysia|Morocco', 'Malaysia', 'Morocco', 8),
  ('Malaysia|North Macedonia', 'Malaysia', 'North Macedonia', 7),
  ('Malaysia|Oman', 'Malaysia', 'Oman', 7),
  ('Malaysia|Portugal', 'Malaysia', 'Portugal', 8),
  ('Malaysia|Qatar', 'Malaysia', 'Qatar', 7),
  ('Malaysia|Romania', 'Malaysia', 'Romania', 5),
  ('Malaysia|Slovakia', 'Malaysia', 'Slovakia', 5),
  ('Malaysia|Spain', 'Malaysia', 'Spain', 7),
  ('Malaysia|Sudan', 'Malaysia', 'Sudan', 9),
  ('Malaysia|Sweden', 'Malaysia', 'Sweden', 5),
  ('Malaysia|Turkey', 'Malaysia', 'Turkey', 5),
  ('Malaysia|UAE', 'Malaysia', 'UAE', 7),
  ('Malaysia|Yemen', 'Malaysia', 'Yemen', 7),
  ('Mali|Moldova', 'Mali', 'Moldova', 7),
  ('Mali|Mongolia', 'Mali', 'Mongolia', 7),
  ('Mali|Montenegro', 'Mali', 'Montenegro', 7),
  ('Mali|Mozambique', 'Mali', 'Mozambique', 5),
  ('Mali|Myanmar', 'Mali', 'Myanmar', 8),
  ('Mali|Namibia', 'Mali', 'Namibia', 5),
  ('Mali|Nepal', 'Mali', 'Nepal', 8),
  ('Mali|Netherlands', 'Mali', 'Netherlands', 5),
  ('Mali|North Korea', 'Mali', 'North Korea', 7),
  ('Mali|North Macedonia', 'Mali', 'North Macedonia', 7),
  ('Mali|Norway', 'Mali', 'Norway', 7),
  ('Mali|Pakistan', 'Mali', 'Pakistan', 7),
  ('Mali|Poland', 'Mali', 'Poland', 5),
  ('Mali|Romania', 'Mali', 'Romania', 7),
  ('Mali|Saudi Arabia', 'Mali', 'Saudi Arabia', 5),
  ('Mali|Serbia', 'Mali', 'Serbia', 7),
  ('Mali|Slovenia', 'Mali', 'Slovenia', 5),
  ('Mali|South Korea', 'Mali', 'South Korea', 8),
  ('Mali|Sweden', 'Mali', 'Sweden', 8),
  ('Mali|Tajikistan', 'Mali', 'Tajikistan', 8),
  ('Mali|Thailand', 'Mali', 'Thailand', 9),
  ('Mali|Turkey', 'Mali', 'Turkey', 5),
  ('Mali|Turkmenistan', 'Mali', 'Turkmenistan', 7),
  ('Mali|Uzbekistan', 'Mali', 'Uzbekistan', 8),
  ('Mali|Vietnam', 'Mali', 'Vietnam', 8),
  ('Mali|Zimbabwe', 'Mali', 'Zimbabwe', 5),
  ('Mauritania|Mozambique', 'Mauritania', 'Mozambique', 5),
  ('Mauritania|Myanmar', 'Mauritania', 'Myanmar', 7),
  ('Mauritania|Namibia', 'Mauritania', 'Namibia', 5),
  ('Mauritania|Nepal', 'Mauritania', 'Nepal', 7),
  ('Mauritania|North Macedonia', 'Mauritania', 'North Macedonia', 7),
  ('Mauritania|Pakistan', 'Mauritania', 'Pakistan', 7),
  ('Mauritania|Russia', 'Mauritania', 'Russia', 5),
  ('Mauritania|Saudi Arabia', 'Mauritania', 'Saudi Arabia', 5),
  ('Mauritania|Slovakia', 'Mauritania', 'Slovakia', 5),
  ('Mauritania|South Korea', 'Mauritania', 'South Korea', 7),
  ('Mauritania|Sweden', 'Mauritania', 'Sweden', 7),
  ('Mauritania|Tajikistan', 'Mauritania', 'Tajikistan', 7),
  ('Mauritania|Thailand', 'Mauritania', 'Thailand', 8),
  ('Mauritania|Turkey', 'Mauritania', 'Turkey', 5),
  ('Mauritania|Turkmenistan', 'Mauritania', 'Turkmenistan', 7),
  ('Mauritania|Ukraine', 'Mauritania', 'Ukraine', 5),
  ('Mauritania|Uzbekistan', 'Mauritania', 'Uzbekistan', 7),
  ('Mauritania|Vietnam', 'Mauritania', 'Vietnam', 7),
  ('Mauritania|Zimbabwe', 'Mauritania', 'Zimbabwe', 5),
  ('Mexico|Paraguay', 'Mexico', 'Paraguay', 7),
  ('Mexico|Suriname', 'Mexico', 'Suriname', 7),
  ('Mexico|Uruguay', 'Mexico', 'Uruguay', 7),
  ('Moldova|Morocco', 'Moldova', 'Morocco', 5),
  ('Moldova|Niger', 'Moldova', 'Niger', 7),
  ('Moldova|Nigeria', 'Moldova', 'Nigeria', 8),
  ('Moldova|Oman', 'Moldova', 'Oman', 5),
  ('Moldova|Portugal', 'Moldova', 'Portugal', 5),
  ('Moldova|Qatar', 'Moldova', 'Qatar', 5),
  ('Moldova|Republic of Congo', 'Moldova', 'Republic of Congo', 8),
  ('Moldova|Rwanda', 'Moldova', 'Rwanda', 9),
  ('Moldova|Senegal', 'Moldova', 'Senegal', 7),
  ('Moldova|Sierra Leone', 'Moldova', 'Sierra Leone', 9),
  ('Moldova|Somalia', 'Moldova', 'Somalia', 8),
  ('Moldova|South Sudan', 'Moldova', 'South Sudan', 7),
  ('Moldova|Tanzania', 'Moldova', 'Tanzania', 9),
  ('Moldova|Togo', 'Moldova', 'Togo', 9),
  ('Moldova|Tunisia', 'Moldova', 'Tunisia', 7),
  ('Moldova|UAE', 'Moldova', 'UAE', 5),
  ('Moldova|Uganda', 'Moldova', 'Uganda', 8),
  ('Moldova|Yemen', 'Moldova', 'Yemen', 5),
  ('Moldova|Zambia', 'Moldova', 'Zambia', 9),
  ('Mongolia|Morocco', 'Mongolia', 'Morocco', 5),
  ('Mongolia|Niger', 'Mongolia', 'Niger', 7),
  ('Mongolia|Nigeria', 'Mongolia', 'Nigeria', 8),
  ('Mongolia|Oman', 'Mongolia', 'Oman', 5),
  ('Mongolia|Portugal', 'Mongolia', 'Portugal', 5),
  ('Mongolia|Qatar', 'Mongolia', 'Qatar', 5),
  ('Mongolia|Republic of Congo', 'Mongolia', 'Republic of Congo', 8),
  ('Mongolia|Rwanda', 'Mongolia', 'Rwanda', 9),
  ('Mongolia|Senegal', 'Mongolia', 'Senegal', 7),
  ('Mongolia|Sierra Leone', 'Mongolia', 'Sierra Leone', 9),
  ('Mongolia|Somalia', 'Mongolia', 'Somalia', 8),
  ('Mongolia|South Sudan', 'Mongolia', 'South Sudan', 7),
  ('Mongolia|Tanzania', 'Mongolia', 'Tanzania', 9),
  ('Mongolia|Togo', 'Mongolia', 'Togo', 9),
  ('Mongolia|Tunisia', 'Mongolia', 'Tunisia', 7),
  ('Mongolia|UAE', 'Mongolia', 'UAE', 5),
  ('Mongolia|Uganda', 'Mongolia', 'Uganda', 8),
  ('Mongolia|Yemen', 'Mongolia', 'Yemen', 5),
  ('Mongolia|Zambia', 'Mongolia', 'Zambia', 9),
  ('Montenegro|Morocco', 'Montenegro', 'Morocco', 5),
  ('Montenegro|Myanmar', 'Montenegro', 'Myanmar', 5),
  ('Montenegro|Nepal', 'Montenegro', 'Nepal', 5),
  ('Montenegro|Niger', 'Montenegro', 'Niger', 7),
  ('Montenegro|Nigeria', 'Montenegro', 'Nigeria', 8),
  ('Montenegro|Oman', 'Montenegro', 'Oman', 5),
  ('Montenegro|Portugal', 'Montenegro', 'Portugal', 5),
  ('Montenegro|Qatar', 'Montenegro', 'Qatar', 5),
  ('Montenegro|Republic of Congo', 'Montenegro', 'Republic of Congo', 8),
  ('Montenegro|Rwanda', 'Montenegro', 'Rwanda', 9),
  ('Montenegro|Senegal', 'Montenegro', 'Senegal', 7),
  ('Montenegro|Sierra Leone', 'Montenegro', 'Sierra Leone', 9),
  ('Montenegro|Somalia', 'Montenegro', 'Somalia', 8),
  ('Montenegro|South Korea', 'Montenegro', 'South Korea', 5),
  ('Montenegro|South Sudan', 'Montenegro', 'South Sudan', 7),
  ('Montenegro|Sweden', 'Montenegro', 'Sweden', 5),
  ('Montenegro|Tajikistan', 'Montenegro', 'Tajikistan', 5),
  ('Montenegro|Tanzania', 'Montenegro', 'Tanzania', 9),
  ('Montenegro|Togo', 'Montenegro', 'Togo', 9),
  ('Montenegro|Tunisia', 'Montenegro', 'Tunisia', 7),
  ('Montenegro|UAE', 'Montenegro', 'UAE', 5),
  ('Montenegro|Uganda', 'Montenegro', 'Uganda', 8),
  ('Montenegro|Uzbekistan', 'Montenegro', 'Uzbekistan', 5),
  ('Montenegro|Vietnam', 'Montenegro', 'Vietnam', 5),
  ('Montenegro|Yemen', 'Montenegro', 'Yemen', 5),
  ('Montenegro|Zambia', 'Montenegro', 'Zambia', 9),
  ('Morocco|Mozambique', 'Morocco', 'Mozambique', 5),
  ('Morocco|Namibia', 'Morocco', 'Namibia', 5),
  ('Morocco|North Korea', 'Morocco', 'North Korea', 5),
  ('Morocco|Norway', 'Morocco', 'Norway', 5),
  ('Morocco|Romania', 'Morocco', 'Romania', 5),
  ('Morocco|Saudi Arabia', 'Morocco', 'Saudi Arabia', 5),
  ('Morocco|Serbia', 'Morocco', 'Serbia', 5),
  ('Morocco|Thailand', 'Morocco', 'Thailand', 7),
  ('Morocco|Turkey', 'Morocco', 'Turkey', 5),
  ('Morocco|Zimbabwe', 'Morocco', 'Zimbabwe', 5),
  ('Mozambique|Netherlands', 'Mozambique', 'Netherlands', 9),
  ('Mozambique|North Macedonia', 'Mozambique', 'North Macedonia', 9),
  ('Mozambique|Oman', 'Mozambique', 'Oman', 8),
  ('Mozambique|Pakistan', 'Mozambique', 'Pakistan', 9),
  ('Mozambique|Poland', 'Mozambique', 'Poland', 9),
  ('Mozambique|Portugal', 'Mozambique', 'Portugal', 7),
  ('Mozambique|Qatar', 'Mozambique', 'Qatar', 8),
  ('Mozambique|Romania', 'Mozambique', 'Romania', 9),
  ('Mozambique|Russia', 'Mozambique', 'Russia', 9),
  ('Mozambique|Saudi Arabia', 'Mozambique', 'Saudi Arabia', 7),
  ('Mozambique|Serbia', 'Mozambique', 'Serbia', 9),
  ('Mozambique|Sierra Leone', 'Mozambique', 'Sierra Leone', 7),
  ('Mozambique|Slovenia', 'Mozambique', 'Slovenia', 9),
  ('Mozambique|Switzerland', 'Mozambique', 'Switzerland', 8),
  ('Mozambique|Tunisia', 'Mozambique', 'Tunisia', 5),
  ('Mozambique|Turkey', 'Mozambique', 'Turkey', 7),
  ('Mozambique|Turkmenistan', 'Mozambique', 'Turkmenistan', 9),
  ('Mozambique|UAE', 'Mozambique', 'UAE', 8),
  ('Mozambique|Yemen', 'Mozambique', 'Yemen', 8),
  ('Myanmar|Niger', 'Myanmar', 'Niger', 8),
  ('Myanmar|Nigeria', 'Myanmar', 'Nigeria', 9),
  ('Myanmar|North Macedonia', 'Myanmar', 'North Macedonia', 5),
  ('Myanmar|Oman', 'Myanmar', 'Oman', 5),
  ('Myanmar|Qatar', 'Myanmar', 'Qatar', 5),
  ('Myanmar|Republic of Congo', 'Myanmar', 'Republic of Congo', 9),
  ('Myanmar|Senegal', 'Myanmar', 'Senegal', 8),
  ('Myanmar|Somalia', 'Myanmar', 'Somalia', 9),
  ('Myanmar|South Sudan', 'Myanmar', 'South Sudan', 8),
  ('Myanmar|Spain', 'Myanmar', 'Spain', 5),
  ('Myanmar|Sudan', 'Myanmar', 'Sudan', 7),
  ('Myanmar|Tunisia', 'Myanmar', 'Tunisia', 8),
  ('Myanmar|UAE', 'Myanmar', 'UAE', 5),
  ('Myanmar|Uganda', 'Myanmar', 'Uganda', 9),
  ('Myanmar|Yemen', 'Myanmar', 'Yemen', 5),
  ('Namibia|Netherlands', 'Namibia', 'Netherlands', 9),
  ('Namibia|North Macedonia', 'Namibia', 'North Macedonia', 9),
  ('Namibia|Oman', 'Namibia', 'Oman', 8),
  ('Namibia|Pakistan', 'Namibia', 'Pakistan', 9),
  ('Namibia|Poland', 'Namibia', 'Poland', 9),
  ('Namibia|Portugal', 'Namibia', 'Portugal', 7),
  ('Namibia|Qatar', 'Namibia', 'Qatar', 8),
  ('Namibia|Romania', 'Namibia', 'Romania', 9),
  ('Namibia|Russia', 'Namibia', 'Russia', 9),
  ('Namibia|Saudi Arabia', 'Namibia', 'Saudi Arabia', 7),
  ('Namibia|Serbia', 'Namibia', 'Serbia', 9),
  ('Namibia|Sierra Leone', 'Namibia', 'Sierra Leone', 7),
  ('Namibia|Slovenia', 'Namibia', 'Slovenia', 9),
  ('Namibia|Switzerland', 'Namibia', 'Switzerland', 8),
  ('Namibia|Togo', 'Namibia', 'Togo', 5),
  ('Namibia|Tunisia', 'Namibia', 'Tunisia', 5),
  ('Namibia|Turkey', 'Namibia', 'Turkey', 7),
  ('Namibia|Turkmenistan', 'Namibia', 'Turkmenistan', 9),
  ('Namibia|UAE', 'Namibia', 'UAE', 8),
  ('Namibia|Yemen', 'Namibia', 'Yemen', 8),
  ('Nepal|Niger', 'Nepal', 'Niger', 8),
  ('Nepal|Nigeria', 'Nepal', 'Nigeria', 9),
  ('Nepal|North Macedonia', 'Nepal', 'North Macedonia', 5),
  ('Nepal|Oman', 'Nepal', 'Oman', 5),
  ('Nepal|Qatar', 'Nepal', 'Qatar', 5),
  ('Nepal|Republic of Congo', 'Nepal', 'Republic of Congo', 9),
  ('Nepal|Senegal', 'Nepal', 'Senegal', 8),
  ('Nepal|Somalia', 'Nepal', 'Somalia', 9),
  ('Nepal|South Sudan', 'Nepal', 'South Sudan', 8),
  ('Nepal|Spain', 'Nepal', 'Spain', 5),
  ('Nepal|Sudan', 'Nepal', 'Sudan', 7),
  ('Nepal|Tunisia', 'Nepal', 'Tunisia', 8),
  ('Nepal|UAE', 'Nepal', 'UAE', 5),
  ('Nepal|Uganda', 'Nepal', 'Uganda', 9),
  ('Nepal|Yemen', 'Nepal', 'Yemen', 5),
  ('Netherlands|Niger', 'Netherlands', 'Niger', 5),
  ('Netherlands|Oman', 'Netherlands', 'Oman', 7),
  ('Netherlands|Qatar', 'Netherlands', 'Qatar', 7),
  ('Netherlands|Republic of Congo', 'Netherlands', 'Republic of Congo', 7),
  ('Netherlands|Rwanda', 'Netherlands', 'Rwanda', 8),
  ('Netherlands|Senegal', 'Netherlands', 'Senegal', 5),
  ('Netherlands|Sierra Leone', 'Netherlands', 'Sierra Leone', 7),
  ('Netherlands|Somalia', 'Netherlands', 'Somalia', 8),
  ('Netherlands|South Sudan', 'Netherlands', 'South Sudan', 7),
  ('Netherlands|Syria', 'Netherlands', 'Syria', 5),
  ('Netherlands|Tanzania', 'Netherlands', 'Tanzania', 8),
  ('Netherlands|Thailand', 'Netherlands', 'Thailand', 5),
  ('Netherlands|Togo', 'Netherlands', 'Togo', 7),
  ('Netherlands|Tunisia', 'Netherlands', 'Tunisia', 5),
  ('Netherlands|UAE', 'Netherlands', 'UAE', 7),
  ('Netherlands|Uganda', 'Netherlands', 'Uganda', 8),
  ('Netherlands|Yemen', 'Netherlands', 'Yemen', 7),
  ('Netherlands|Zambia', 'Netherlands', 'Zambia', 8),
  ('Netherlands|Zimbabwe', 'Netherlands', 'Zimbabwe', 9),
  ('Niger|North Korea', 'Niger', 'North Korea', 7),
  ('Niger|Norway', 'Niger', 'Norway', 7),
  ('Niger|Oman', 'Niger', 'Oman', 5),
  ('Niger|Poland', 'Niger', 'Poland', 5),
  ('Niger|Qatar', 'Niger', 'Qatar', 5),
  ('Niger|Slovenia', 'Niger', 'Slovenia', 5),
  ('Niger|South Africa', 'Niger', 'South Africa', 5),
  ('Niger|South Korea', 'Niger', 'South Korea', 8),
  ('Niger|Sweden', 'Niger', 'Sweden', 8),
  ('Niger|Tajikistan', 'Niger', 'Tajikistan', 7),
  ('Niger|Thailand', 'Niger', 'Thailand', 9),
  ('Niger|UAE', 'Niger', 'UAE', 5),
  ('Niger|Uzbekistan', 'Niger', 'Uzbekistan', 7),
  ('Niger|Vietnam', 'Niger', 'Vietnam', 8),
  ('Niger|Yemen', 'Niger', 'Yemen', 5),
  ('Nigeria|North Korea', 'Nigeria', 'North Korea', 8),
  ('Nigeria|North Macedonia', 'Nigeria', 'North Macedonia', 7),
  ('Nigeria|Norway', 'Nigeria', 'Norway', 8),
  ('Nigeria|Pakistan', 'Nigeria', 'Pakistan', 7),
  ('Nigeria|Romania', 'Nigeria', 'Romania', 7),
  ('Nigeria|Russia', 'Nigeria', 'Russia', 7),
  ('Nigeria|Saudi Arabia', 'Nigeria', 'Saudi Arabia', 5),
  ('Nigeria|Serbia', 'Nigeria', 'Serbia', 7),
  ('Nigeria|Slovakia', 'Nigeria', 'Slovakia', 7),
  ('Nigeria|South Korea', 'Nigeria', 'South Korea', 9),
  ('Nigeria|Sweden', 'Nigeria', 'Sweden', 9),
  ('Nigeria|Switzerland', 'Nigeria', 'Switzerland', 5),
  ('Nigeria|Tajikistan', 'Nigeria', 'Tajikistan', 8),
  ('Nigeria|Turkey', 'Nigeria', 'Turkey', 5),
  ('Nigeria|Turkmenistan', 'Nigeria', 'Turkmenistan', 7),
  ('Nigeria|Ukraine', 'Nigeria', 'Ukraine', 7),
  ('Nigeria|Uzbekistan', 'Nigeria', 'Uzbekistan', 8),
  ('Nigeria|Vietnam', 'Nigeria', 'Vietnam', 9),
  ('North Korea|Oman', 'North Korea', 'Oman', 5),
  ('North Korea|Portugal', 'North Korea', 'Portugal', 5),
  ('North Korea|Qatar', 'North Korea', 'Qatar', 5),
  ('North Korea|Republic of Congo', 'North Korea', 'Republic of Congo', 8),
  ('North Korea|Rwanda', 'North Korea', 'Rwanda', 9),
  ('North Korea|Senegal', 'North Korea', 'Senegal', 7),
  ('North Korea|Sierra Leone', 'North Korea', 'Sierra Leone', 9),
  ('North Korea|Somalia', 'North Korea', 'Somalia', 8),
  ('North Korea|South Sudan', 'North Korea', 'South Sudan', 7),
  ('North Korea|Tanzania', 'North Korea', 'Tanzania', 9),
  ('North Korea|Togo', 'North Korea', 'Togo', 9),
  ('North Korea|Tunisia', 'North Korea', 'Tunisia', 7),
  ('North Korea|UAE', 'North Korea', 'UAE', 5),
  ('North Korea|Uganda', 'North Korea', 'Uganda', 8),
  ('North Korea|Yemen', 'North Korea', 'Yemen', 5),
  ('North Korea|Zambia', 'North Korea', 'Zambia', 9),
  ('North Macedonia|Republic of Congo', 'North Macedonia', 'Republic of Congo', 7),
  ('North Macedonia|Rwanda', 'North Macedonia', 'Rwanda', 8),
  ('North Macedonia|Senegal', 'North Macedonia', 'Senegal', 8),
  ('North Macedonia|Sierra Leone', 'North Macedonia', 'Sierra Leone', 9),
  ('North Macedonia|Somalia', 'North Macedonia', 'Somalia', 7),
  ('North Macedonia|South Korea', 'North Macedonia', 'South Korea', 5),
  ('North Macedonia|Spain', 'North Macedonia', 'Spain', 5),
  ('North Macedonia|Sudan', 'North Macedonia', 'Sudan', 5),
  ('North Macedonia|Sweden', 'North Macedonia', 'Sweden', 5),
  ('North Macedonia|Tanzania', 'North Macedonia', 'Tanzania', 8),
  ('North Macedonia|Togo', 'North Macedonia', 'Togo', 8),
  ('North Macedonia|Uganda', 'North Macedonia', 'Uganda', 7),
  ('North Macedonia|Vietnam', 'North Macedonia', 'Vietnam', 5),
  ('North Macedonia|Zambia', 'North Macedonia', 'Zambia', 8),
  ('North Macedonia|Zimbabwe', 'North Macedonia', 'Zimbabwe', 9),
  ('Norway|Oman', 'Norway', 'Oman', 5),
  ('Norway|Portugal', 'Norway', 'Portugal', 5),
  ('Norway|Qatar', 'Norway', 'Qatar', 5),
  ('Norway|Republic of Congo', 'Norway', 'Republic of Congo', 8),
  ('Norway|Rwanda', 'Norway', 'Rwanda', 9),
  ('Norway|Senegal', 'Norway', 'Senegal', 7),
  ('Norway|Sierra Leone', 'Norway', 'Sierra Leone', 9),
  ('Norway|Somalia', 'Norway', 'Somalia', 8),
  ('Norway|South Sudan', 'Norway', 'South Sudan', 7),
  ('Norway|Tanzania', 'Norway', 'Tanzania', 9),
  ('Norway|Togo', 'Norway', 'Togo', 9),
  ('Norway|Tunisia', 'Norway', 'Tunisia', 7),
  ('Norway|UAE', 'Norway', 'UAE', 5),
  ('Norway|Uganda', 'Norway', 'Uganda', 8),
  ('Norway|Yemen', 'Norway', 'Yemen', 5),
  ('Norway|Zambia', 'Norway', 'Zambia', 9),
  ('Oman|Poland', 'Oman', 'Poland', 5),
  ('Oman|Portugal', 'Oman', 'Portugal', 8),
  ('Oman|Rwanda', 'Oman', 'Rwanda', 7),
  ('Oman|Senegal', 'Oman', 'Senegal', 7),
  ('Oman|Sierra Leone', 'Oman', 'Sierra Leone', 8),
  ('Oman|South Africa', 'Oman', 'South Africa', 9),
  ('Oman|South Sudan', 'Oman', 'South Sudan', 5),
  ('Oman|Spain', 'Oman', 'Spain', 7),
  ('Oman|Switzerland', 'Oman', 'Switzerland', 7),
  ('Oman|Tanzania', 'Oman', 'Tanzania', 7),
  ('Oman|Togo', 'Oman', 'Togo', 7),
  ('Oman|Tunisia', 'Oman', 'Tunisia', 5),
  ('Oman|Ukraine', 'Oman', 'Ukraine', 5),
  ('Oman|Vietnam', 'Oman', 'Vietnam', 5),
  ('Oman|Zambia', 'Oman', 'Zambia', 7),
  ('Oman|Zimbabwe', 'Oman', 'Zimbabwe', 8),
  ('Pakistan|Republic of Congo', 'Pakistan', 'Republic of Congo', 7),
  ('Pakistan|Rwanda', 'Pakistan', 'Rwanda', 8),
  ('Pakistan|Senegal', 'Pakistan', 'Senegal', 8),
  ('Pakistan|Sierra Leone', 'Pakistan', 'Sierra Leone', 9),
  ('Pakistan|Somalia', 'Pakistan', 'Somalia', 7),
  ('Pakistan|Spain', 'Pakistan', 'Spain', 5),
  ('Pakistan|Sudan', 'Pakistan', 'Sudan', 5),
  ('Pakistan|Tanzania', 'Pakistan', 'Tanzania', 8),
  ('Pakistan|Togo', 'Pakistan', 'Togo', 8),
  ('Pakistan|Uganda', 'Pakistan', 'Uganda', 7),
  ('Pakistan|Zambia', 'Pakistan', 'Zambia', 8),
  ('Pakistan|Zimbabwe', 'Pakistan', 'Zimbabwe', 9),
  ('Panama|USA', 'Panama', 'USA', 5),
  ('Paraguay|USA', 'Paraguay', 'USA', 8),
  ('Peru|USA', 'Peru', 'USA', 7),
  ('Poland|Qatar', 'Poland', 'Qatar', 5),
  ('Poland|Republic of Congo', 'Poland', 'Republic of Congo', 7),
  ('Poland|Rwanda', 'Poland', 'Rwanda', 8),
  ('Poland|Senegal', 'Poland', 'Senegal', 5),
  ('Poland|Sierra Leone', 'Poland', 'Sierra Leone', 7),
  ('Poland|Somalia', 'Poland', 'Somalia', 8),
  ('Poland|South Sudan', 'Poland', 'South Sudan', 7),
  ('Poland|Tanzania', 'Poland', 'Tanzania', 8),
  ('Poland|Togo', 'Poland', 'Togo', 7),
  ('Poland|Tunisia', 'Poland', 'Tunisia', 5),
  ('Poland|UAE', 'Poland', 'UAE', 5),
  ('Poland|Uganda', 'Poland', 'Uganda', 8),
  ('Poland|Yemen', 'Poland', 'Yemen', 5),
  ('Poland|Zambia', 'Poland', 'Zambia', 8),
  ('Poland|Zimbabwe', 'Poland', 'Zimbabwe', 9),
  ('Portugal|Qatar', 'Portugal', 'Qatar', 8),
  ('Portugal|Republic of Congo', 'Portugal', 'Republic of Congo', 5),
  ('Portugal|Romania', 'Portugal', 'Romania', 5),
  ('Portugal|Saudi Arabia', 'Portugal', 'Saudi Arabia', 7),
  ('Portugal|Serbia', 'Portugal', 'Serbia', 5),
  ('Portugal|Sierra Leone', 'Portugal', 'Sierra Leone', 5),
  ('Portugal|South Africa', 'Portugal', 'South Africa', 8),
  ('Portugal|South Sudan', 'Portugal', 'South Sudan', 5),
  ('Portugal|Thailand', 'Portugal', 'Thailand', 7),
  ('Portugal|Togo', 'Portugal', 'Togo', 5),
  ('Portugal|UAE', 'Portugal', 'UAE', 8),
  ('Portugal|Yemen', 'Portugal', 'Yemen', 8),
  ('Portugal|Zimbabwe', 'Portugal', 'Zimbabwe', 7),
  ('Qatar|Rwanda', 'Qatar', 'Rwanda', 7),
  ('Qatar|Senegal', 'Qatar', 'Senegal', 7),
  ('Qatar|Sierra Leone', 'Qatar', 'Sierra Leone', 8),
  ('Qatar|South Africa', 'Qatar', 'South Africa', 9),
  ('Qatar|South Sudan', 'Qatar', 'South Sudan', 5),
  ('Qatar|Spain', 'Qatar', 'Spain', 7),
  ('Qatar|Switzerland', 'Qatar', 'Switzerland', 7),
  ('Qatar|Tanzania', 'Qatar', 'Tanzania', 7),
  ('Qatar|Togo', 'Qatar', 'Togo', 7),
  ('Qatar|Tunisia', 'Qatar', 'Tunisia', 5),
  ('Qatar|Ukraine', 'Qatar', 'Ukraine', 5),
  ('Qatar|Vietnam', 'Qatar', 'Vietnam', 5),
  ('Qatar|Zambia', 'Qatar', 'Zambia', 7),
  ('Qatar|Zimbabwe', 'Qatar', 'Zimbabwe', 8),
  ('Republic of Congo|Romania', 'Republic of Congo', 'Romania', 7),
  ('Republic of Congo|Russia', 'Republic of Congo', 'Russia', 7),
  ('Republic of Congo|Saudi Arabia', 'Republic of Congo', 'Saudi Arabia', 5),
  ('Republic of Congo|Serbia', 'Republic of Congo', 'Serbia', 7),
  ('Republic of Congo|Sierra Leone', 'Republic of Congo', 'Sierra Leone', 5),
  ('Republic of Congo|Slovakia', 'Republic of Congo', 'Slovakia', 8),
  ('Republic of Congo|Slovenia', 'Republic of Congo', 'Slovenia', 7),
  ('Republic of Congo|South Korea', 'Republic of Congo', 'South Korea', 9),
  ('Republic of Congo|Sweden', 'Republic of Congo', 'Sweden', 9),
  ('Republic of Congo|Tajikistan', 'Republic of Congo', 'Tajikistan', 8),
  ('Republic of Congo|Turkey', 'Republic of Congo', 'Turkey', 5),
  ('Republic of Congo|Turkmenistan', 'Republic of Congo', 'Turkmenistan', 7),
  ('Republic of Congo|Ukraine', 'Republic of Congo', 'Ukraine', 8),
  ('Republic of Congo|Uzbekistan', 'Republic of Congo', 'Uzbekistan', 8),
  ('Republic of Congo|Vietnam', 'Republic of Congo', 'Vietnam', 9),
  ('Romania|Rwanda', 'Romania', 'Rwanda', 8),
  ('Romania|Senegal', 'Romania', 'Senegal', 7),
  ('Romania|Sierra Leone', 'Romania', 'Sierra Leone', 9),
  ('Romania|Somalia', 'Romania', 'Somalia', 7),
  ('Romania|Sudan', 'Romania', 'Sudan', 5),
  ('Romania|Tanzania', 'Romania', 'Tanzania', 8),
  ('Romania|Togo', 'Romania', 'Togo', 8),
  ('Romania|Uganda', 'Romania', 'Uganda', 7),
  ('Romania|Zambia', 'Romania', 'Zambia', 8),
  ('Romania|Zimbabwe', 'Romania', 'Zimbabwe', 9),
  ('Russia|Rwanda', 'Russia', 'Rwanda', 8),
  ('Russia|Sierra Leone', 'Russia', 'Sierra Leone', 8),
  ('Russia|Somalia', 'Russia', 'Somalia', 7),
  ('Russia|Sudan', 'Russia', 'Sudan', 5),
  ('Russia|Tanzania', 'Russia', 'Tanzania', 8),
  ('Russia|Togo', 'Russia', 'Togo', 8),
  ('Russia|Uganda', 'Russia', 'Uganda', 7),
  ('Russia|Zambia', 'Russia', 'Zambia', 8),
  ('Russia|Zimbabwe', 'Russia', 'Zimbabwe', 9),
  ('Rwanda|Senegal', 'Rwanda', 'Senegal', 5),
  ('Rwanda|Serbia', 'Rwanda', 'Serbia', 8),
  ('Rwanda|Slovakia', 'Rwanda', 'Slovakia', 9),
  ('Rwanda|Slovenia', 'Rwanda', 'Slovenia', 8),
  ('Rwanda|Spain', 'Rwanda', 'Spain', 5),
  ('Rwanda|Switzerland', 'Rwanda', 'Switzerland', 7),
  ('Rwanda|Syria', 'Rwanda', 'Syria', 5),
  ('Rwanda|Tajikistan', 'Rwanda', 'Tajikistan', 9),
  ('Rwanda|Togo', 'Rwanda', 'Togo', 5),
  ('Rwanda|Turkmenistan', 'Rwanda', 'Turkmenistan', 8),
  ('Rwanda|UAE', 'Rwanda', 'UAE', 7),
  ('Rwanda|Ukraine', 'Rwanda', 'Ukraine', 9),
  ('Rwanda|Uzbekistan', 'Rwanda', 'Uzbekistan', 9),
  ('Rwanda|Yemen', 'Rwanda', 'Yemen', 7),
  ('Saudi Arabia|Sierra Leone', 'Saudi Arabia', 'Sierra Leone', 7),
  ('Saudi Arabia|Slovakia', 'Saudi Arabia', 'Slovakia', 5),
  ('Saudi Arabia|Slovenia', 'Saudi Arabia', 'Slovenia', 5),
  ('Saudi Arabia|Somalia', 'Saudi Arabia', 'Somalia', 5),
  ('Saudi Arabia|South Africa', 'Saudi Arabia', 'South Africa', 8),
  ('Saudi Arabia|South Korea', 'Saudi Arabia', 'South Korea', 5),
  ('Saudi Arabia|Sweden', 'Saudi Arabia', 'Sweden', 5),
  ('Saudi Arabia|Thailand', 'Saudi Arabia', 'Thailand', 5),
  ('Saudi Arabia|Uganda', 'Saudi Arabia', 'Uganda', 5),
  ('Saudi Arabia|Zimbabwe', 'Saudi Arabia', 'Zimbabwe', 7),
  ('Senegal|Serbia', 'Senegal', 'Serbia', 7),
  ('Senegal|Slovenia', 'Senegal', 'Slovenia', 5),
  ('Senegal|Somalia', 'Senegal', 'Somalia', 5),
  ('Senegal|South Africa', 'Senegal', 'South Africa', 7),
  ('Senegal|South Korea', 'Senegal', 'South Korea', 8),
  ('Senegal|Sweden', 'Senegal', 'Sweden', 8),
  ('Senegal|Syria', 'Senegal', 'Syria', 5),
  ('Senegal|Tajikistan', 'Senegal', 'Tajikistan', 8),
  ('Senegal|Tanzania', 'Senegal', 'Tanzania', 5),
  ('Senegal|Thailand', 'Senegal', 'Thailand', 9),
  ('Senegal|Turkmenistan', 'Senegal', 'Turkmenistan', 8),
  ('Senegal|UAE', 'Senegal', 'UAE', 7),
  ('Senegal|Uganda', 'Senegal', 'Uganda', 5),
  ('Senegal|Uzbekistan', 'Senegal', 'Uzbekistan', 8),
  ('Senegal|Vietnam', 'Senegal', 'Vietnam', 8),
  ('Senegal|Yemen', 'Senegal', 'Yemen', 7),
  ('Senegal|Zambia', 'Senegal', 'Zambia', 5),
  ('Serbia|Sierra Leone', 'Serbia', 'Sierra Leone', 9),
  ('Serbia|Somalia', 'Serbia', 'Somalia', 7),
  ('Serbia|Sudan', 'Serbia', 'Sudan', 5),
  ('Serbia|Tanzania', 'Serbia', 'Tanzania', 8),
  ('Serbia|Thailand', 'Serbia', 'Thailand', 5),
  ('Serbia|Togo', 'Serbia', 'Togo', 8),
  ('Serbia|Uganda', 'Serbia', 'Uganda', 7),
  ('Serbia|Zambia', 'Serbia', 'Zambia', 8),
  ('Serbia|Zimbabwe', 'Serbia', 'Zimbabwe', 9),
  ('Sierra Leone|Slovakia', 'Sierra Leone', 'Slovakia', 8),
  ('Sierra Leone|Slovenia', 'Sierra Leone', 'Slovenia', 7),
  ('Sierra Leone|South Africa', 'Sierra Leone', 'South Africa', 8),
  ('Sierra Leone|South Sudan', 'Sierra Leone', 'South Sudan', 5),
  ('Sierra Leone|Turkey', 'Sierra Leone', 'Turkey', 7),
  ('Sierra Leone|Turkmenistan', 'Sierra Leone', 'Turkmenistan', 9),
  ('Sierra Leone|UAE', 'Sierra Leone', 'UAE', 8),
  ('Sierra Leone|Ukraine', 'Sierra Leone', 'Ukraine', 8),
  ('Sierra Leone|Yemen', 'Sierra Leone', 'Yemen', 8),
  ('Sierra Leone|Zimbabwe', 'Sierra Leone', 'Zimbabwe', 7),
  ('Slovakia|Somalia', 'Slovakia', 'Somalia', 9),
  ('Slovakia|South Sudan', 'Slovakia', 'South Sudan', 8),
  ('Slovakia|Sudan', 'Slovakia', 'Sudan', 7),
  ('Slovakia|Tanzania', 'Slovakia', 'Tanzania', 9),
  ('Slovakia|Togo', 'Slovakia', 'Togo', 8),
  ('Slovakia|Uganda', 'Slovakia', 'Uganda', 9),
  ('Slovakia|Zambia', 'Slovakia', 'Zambia', 9),
  ('Slovenia|Somalia', 'Slovenia', 'Somalia', 8),
  ('Slovenia|South Sudan', 'Slovenia', 'South Sudan', 7),
  ('Slovenia|Tanzania', 'Slovenia', 'Tanzania', 8),
  ('Slovenia|Thailand', 'Slovenia', 'Thailand', 5),
  ('Slovenia|Togo', 'Slovenia', 'Togo', 7),
  ('Slovenia|Tunisia', 'Slovenia', 'Tunisia', 5),
  ('Slovenia|Uganda', 'Slovenia', 'Uganda', 8),
  ('Slovenia|Zambia', 'Slovenia', 'Zambia', 8),
  ('Slovenia|Zimbabwe', 'Slovenia', 'Zimbabwe', 9),
  ('Somalia|South Korea', 'Somalia', 'South Korea', 9),
  ('Somalia|Spain', 'Somalia', 'Spain', 5),
  ('Somalia|Sweden', 'Somalia', 'Sweden', 9),
  ('Somalia|Switzerland', 'Somalia', 'Switzerland', 7),
  ('Somalia|Tajikistan', 'Somalia', 'Tajikistan', 8),
  ('Somalia|Togo', 'Somalia', 'Togo', 5),
  ('Somalia|Turkey', 'Somalia', 'Turkey', 5),
  ('Somalia|Turkmenistan', 'Somalia', 'Turkmenistan', 7),
  ('Somalia|Ukraine', 'Somalia', 'Ukraine', 8),
  ('Somalia|Uzbekistan', 'Somalia', 'Uzbekistan', 8),
  ('Somalia|Vietnam', 'Somalia', 'Vietnam', 9),
  ('South Africa|Spain', 'South Africa', 'Spain', 7),
  ('South Africa|Switzerland', 'South Africa', 'Switzerland', 9),
  ('South Africa|Syria', 'South Africa', 'Syria', 7),
  ('South Africa|Turkey', 'South Africa', 'Turkey', 8),
  ('South Africa|UAE', 'South Africa', 'UAE', 9),
  ('South Africa|Yemen', 'South Africa', 'Yemen', 9),
  ('South Korea|South Sudan', 'South Korea', 'South Sudan', 8),
  ('South Korea|Spain', 'South Korea', 'Spain', 5),
  ('South Korea|Sudan', 'South Korea', 'Sudan', 7),
  ('South Korea|Tunisia', 'South Korea', 'Tunisia', 8),
  ('South Korea|Uganda', 'South Korea', 'Uganda', 9),
  ('South Sudan|Sweden', 'South Sudan', 'Sweden', 8),
  ('South Sudan|Tajikistan', 'South Sudan', 'Tajikistan', 7),
  ('South Sudan|Thailand', 'South Sudan', 'Thailand', 9),
  ('South Sudan|UAE', 'South Sudan', 'UAE', 5),
  ('South Sudan|Ukraine', 'South Sudan', 'Ukraine', 7),
  ('South Sudan|Uzbekistan', 'South Sudan', 'Uzbekistan', 7),
  ('South Sudan|Vietnam', 'South Sudan', 'Vietnam', 8),
  ('South Sudan|Yemen', 'South Sudan', 'Yemen', 5),
  ('Spain|Sweden', 'Spain', 'Sweden', 5),
  ('Spain|Syria', 'Spain', 'Syria', 5),
  ('Spain|Tajikistan', 'Spain', 'Tajikistan', 5),
  ('Spain|Tanzania', 'Spain', 'Tanzania', 5),
  ('Spain|Turkey', 'Spain', 'Turkey', 5),
  ('Spain|Turkmenistan', 'Spain', 'Turkmenistan', 5),
  ('Spain|UAE', 'Spain', 'UAE', 7),
  ('Spain|Uganda', 'Spain', 'Uganda', 5),
  ('Spain|Uzbekistan', 'Spain', 'Uzbekistan', 5),
  ('Spain|Vietnam', 'Spain', 'Vietnam', 5),
  ('Spain|Yemen', 'Spain', 'Yemen', 7),
  ('Spain|Zambia', 'Spain', 'Zambia', 5),
  ('Sudan|Sweden', 'Sudan', 'Sweden', 7),
  ('Sudan|Switzerland', 'Sudan', 'Switzerland', 5),
  ('Sudan|Thailand', 'Sudan', 'Thailand', 8),
  ('Sudan|Turkmenistan', 'Sudan', 'Turkmenistan', 5),
  ('Sudan|Vietnam', 'Sudan', 'Vietnam', 7),
  ('Suriname|USA', 'Suriname', 'USA', 8),
  ('Sweden|Tunisia', 'Sweden', 'Tunisia', 8),
  ('Sweden|Uganda', 'Sweden', 'Uganda', 9),
  ('Switzerland|Syria', 'Switzerland', 'Syria', 5),
  ('Switzerland|Tanzania', 'Switzerland', 'Tanzania', 7),
  ('Switzerland|Thailand', 'Switzerland', 'Thailand', 5),
  ('Switzerland|UAE', 'Switzerland', 'UAE', 7),
  ('Switzerland|Uganda', 'Switzerland', 'Uganda', 7),
  ('Switzerland|Yemen', 'Switzerland', 'Yemen', 7),
  ('Switzerland|Zambia', 'Switzerland', 'Zambia', 7),
  ('Switzerland|Zimbabwe', 'Switzerland', 'Zimbabwe', 8),
  ('Syria|Tanzania', 'Syria', 'Tanzania', 5),
  ('Syria|Thailand', 'Syria', 'Thailand', 5),
  ('Syria|Togo', 'Syria', 'Togo', 5),
  ('Syria|Zambia', 'Syria', 'Zambia', 5),
  ('Tajikistan|Tanzania', 'Tajikistan', 'Tanzania', 9),
  ('Tajikistan|Togo', 'Tajikistan', 'Togo', 9),
  ('Tajikistan|Tunisia', 'Tajikistan', 'Tunisia', 7),
  ('Tajikistan|Uganda', 'Tajikistan', 'Uganda', 8),
  ('Tajikistan|Zambia', 'Tajikistan', 'Zambia', 9),
  ('Tanzania|Togo', 'Tanzania', 'Togo', 5),
  ('Tanzania|Turkmenistan', 'Tanzania', 'Turkmenistan', 8),
  ('Tanzania|UAE', 'Tanzania', 'UAE', 7),
  ('Tanzania|Ukraine', 'Tanzania', 'Ukraine', 9),
  ('Tanzania|Uzbekistan', 'Tanzania', 'Uzbekistan', 9),
  ('Tanzania|Yemen', 'Tanzania', 'Yemen', 7),
  ('Thailand|Tunisia', 'Thailand', 'Tunisia', 9),
  ('Togo|Turkmenistan', 'Togo', 'Turkmenistan', 8),
  ('Togo|UAE', 'Togo', 'UAE', 7),
  ('Togo|Uganda', 'Togo', 'Uganda', 5),
  ('Togo|Ukraine', 'Togo', 'Ukraine', 8),
  ('Togo|Uzbekistan', 'Togo', 'Uzbekistan', 9),
  ('Togo|Yemen', 'Togo', 'Yemen', 7),
  ('Togo|Zambia', 'Togo', 'Zambia', 5),
  ('Tunisia|UAE', 'Tunisia', 'UAE', 5),
  ('Tunisia|Uzbekistan', 'Tunisia', 'Uzbekistan', 7),
  ('Tunisia|Vietnam', 'Tunisia', 'Vietnam', 8),
  ('Tunisia|Yemen', 'Tunisia', 'Yemen', 5),
  ('Tunisia|Zimbabwe', 'Tunisia', 'Zimbabwe', 5),
  ('Turkey|Uganda', 'Turkey', 'Uganda', 5),
  ('Turkey|Zimbabwe', 'Turkey', 'Zimbabwe', 7),
  ('Turkmenistan|Uganda', 'Turkmenistan', 'Uganda', 7),
  ('Turkmenistan|Zambia', 'Turkmenistan', 'Zambia', 8),
  ('Turkmenistan|Zimbabwe', 'Turkmenistan', 'Zimbabwe', 9),
  ('UAE|Ukraine', 'UAE', 'Ukraine', 5),
  ('UAE|Vietnam', 'UAE', 'Vietnam', 5),
  ('UAE|Zambia', 'UAE', 'Zambia', 7),
  ('UAE|Zimbabwe', 'UAE', 'Zimbabwe', 8),
  ('Uganda|Ukraine', 'Uganda', 'Ukraine', 8),
  ('Uganda|Uzbekistan', 'Uganda', 'Uzbekistan', 8),
  ('Uganda|Vietnam', 'Uganda', 'Vietnam', 9),
  ('Ukraine|Yemen', 'Ukraine', 'Yemen', 5),
  ('Ukraine|Zambia', 'Ukraine', 'Zambia', 9),
  ('USA|Uruguay', 'USA', 'Uruguay', 8),
  ('USA|Venezuela', 'USA', 'Venezuela', 7),
  ('Uzbekistan|Zambia', 'Uzbekistan', 'Zambia', 9),
  ('Vietnam|Yemen', 'Vietnam', 'Yemen', 5),
  ('Yemen|Zambia', 'Yemen', 'Zambia', 7),
  ('Yemen|Zimbabwe', 'Yemen', 'Zimbabwe', 8)
on conflict (pair_key) do update set
  a_key = excluded.a_key,
  b_key = excluded.b_key,
  intermediates = excluded.intermediates;


-- ────────────────────────────────────────────────────────────────────────────
-- 7) Yetki yardımcıları (flag_group deseni)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1
      from public.route_duel_players p
      left join public.route_duel_player_claims c on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
         or (p_claim_token is not null and c.claim_token = p_claim_token)
       )
  );
$$;
revoke all     on function public.route_duel_authorize_player(uuid, uuid) from public;
grant  execute on function public.route_duel_authorize_player(uuid, uuid) to anon, authenticated;


create or replace function public.route_duel_authorize_host(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1
      from public.route_duel_players p
      join public.route_duel_rooms r on r.id = p.room_id
     where p.id      = p_player_id
       and p.room_id = p_room_id
       and r.host_player_id = p.id
       and public.route_duel_authorize_player(p_player_id, p_claim_token)
  );
$$;
revoke all     on function public.route_duel_authorize_host(uuid, uuid, uuid) from public;
grant  execute on function public.route_duel_authorize_host(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 8) İÇ yardımcılar — rota seçimi + tur başlatma (client'a GRANT YOK)
-- ────────────────────────────────────────────────────────────────────────────

-- Havuzdan kullanılmamış rastgele rota çeker; yönü rastgele çevirir.
--   '5' → {5} ara ülke, '7' → {7}, '7plus' → {8,9} (biri tükenirse diğeri
--   doğal olarak kullanılır; 7'ye SESSİZCE DÜŞÜLMEZ — bant dışına çıkılmaz).
-- Havuz tamamen tükenirse (2.660 çiftlik havuzda pratikte erişilmez) used
-- filtresi bırakılarak tekrar denenir; o da boşsa route_pool_empty.
create or replace function public._route_duel_pick_route(
  p_used         text[],
  p_route_length text,
  out o_pair_key   text,
  out o_start_key  text,
  out o_target_key text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bands int[];
  v_row   public.route_duel_pool;
begin
  v_bands := case p_route_length
    when '5'     then array[5]
    when '7'     then array[7]
    when '7plus' then array[8, 9]
    else null
  end;
  if v_bands is null then
    raise exception 'route_length_invalid' using errcode = '22023';
  end if;

  select * into v_row
    from public.route_duel_pool
   where intermediates = any(v_bands)
     and not (pair_key = any(coalesce(p_used, '{}'::text[])))
   order by random()
   limit 1;

  if v_row.pair_key is null then
    -- Fallback: havuz bandı tükendi → tekrarı kabul et (oyun kilitlenmesin).
    select * into v_row
      from public.route_duel_pool
     where intermediates = any(v_bands)
     order by random()
     limit 1;
  end if;

  if v_row.pair_key is null then
    raise exception 'route_pool_empty' using errcode = 'P0001';
  end if;

  o_pair_key := v_row.pair_key;
  if random() < 0.5 then
    o_start_key  := v_row.a_key;
    o_target_key := v_row.b_key;
  else
    o_start_key  := v_row.b_key;
    o_target_key := v_row.a_key;
  end if;
end;
$$;
revoke all on function public._route_duel_pick_route(text[], text) from public, anon, authenticated;


-- Yeni turu başlatır: rota seç, used'a ekle, tur alanlarını yaz, iki oyuncunun
-- konumunu start'a sıfırla. ÇAĞIRAN oda satırını FOR UPDATE ile kilitlemiş
-- olmalıdır (start_game / advance_round / request_rematch / quick_match).
create or replace function public._route_duel_begin_round(
  p_room_id    uuid,
  p_next_round int
) returns public.route_duel_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room   public.route_duel_rooms;
  v_pair   text;
  v_start  text;
  v_target text;
begin
  select * into v_room from public.route_duel_rooms where id = p_room_id;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  select o_pair_key, o_start_key, o_target_key
    into v_pair, v_start, v_target
    from public._route_duel_pick_route(v_room.used_pair_keys, v_room.route_length);

  update public.route_duel_rooms
     set current_round          = p_next_round,
         round_start_key        = v_start,
         round_target_key       = v_target,
         round_pair_key         = v_pair,
         -- 3 sn ortak geri sayım + 60 sn sunucu-otoriter tur süresi.
         round_started_at       = now() + interval '3 seconds',
         round_deadline         = now() + interval '3 seconds' + interval '60 seconds',
         round_winner_player_id = null,
         round_decided_at       = null,
         used_pair_keys         = array_append(used_pair_keys, v_pair),
         updated_at             = now()
   where id = p_room_id
   returning * into v_room;

  update public.route_duel_players
     set current_key = v_start,
         path        = array[v_start]
   where room_id = p_room_id;

  return v_room;
end;
$$;
revoke all on function public._route_duel_begin_round(uuid, int) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 9) route_duel_create_room
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_create_room(
  p_player_id    uuid,
  p_profile_id   uuid,
  p_guest_id     text,
  p_name         text,
  p_code         text,
  p_total_rounds int,
  p_route_length text,
  p_claim_token  uuid
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room         public.route_duel_rooms;
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

  v_display_name := public.assert_display_name_allowed(p_name, p_profile_id, p_guest_id);

  if p_code is null or length(btrim(p_code)) = 0 then
    raise exception 'code_required' using errcode = '22023';
  end if;
  if p_total_rounds is null or p_total_rounds not in (3, 5, 10, 15) then
    raise exception 'total_rounds_invalid' using errcode = '22023';
  end if;
  if p_route_length is null or p_route_length not in ('5','7','7plus') then
    raise exception 'route_length_invalid' using errcode = '22023';
  end if;

  begin
    insert into public.route_duel_rooms (
      code, status, total_rounds, route_length, host_player_id, room_source
    ) values (
      p_code, 'waiting', p_total_rounds, p_route_length, p_player_id, 'manual'
    )
    returning * into v_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  insert into public.route_duel_players (
    id, room_id, name, is_host, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, v_display_name, true, p_profile_id, p_guest_id, now()
  );

  insert into public.route_duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  return v_room;
end;
$$;
revoke all     on function public.route_duel_create_room(uuid, uuid, text, text, text, int, text, uuid) from public;
grant  execute on function public.route_duel_create_room(uuid, uuid, text, text, text, int, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 10) route_duel_join_room — kapasite KESİN 2, playing odaya giriş YOK,
--     aynı kullanıcı ikinci slot ALAMAZ.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_join_room(
  p_code        text,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_claim_token uuid
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room         public.route_duel_rooms;
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

  select * into v_room from public.route_duel_rooms where code = p_code for update;
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

  -- Aynı kullanıcı iki slot alamaz (logged-in kimlik üzerinden kesin engel).
  if p_profile_id is not null and exists (
    select 1 from public.route_duel_players
     where room_id = v_room.id and profile_id = p_profile_id
  ) then
    raise exception 'already_in_room' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.route_duel_players
     where room_id = v_room.id
       and lower(btrim(name)) = lower(v_display_name)
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  -- Kapasite KESİN 2 (kilit altındayız → race-free).
  select count(*) into v_count
    from public.route_duel_players where room_id = v_room.id;
  if v_count >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  insert into public.route_duel_players (
    id, room_id, name, is_host, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, v_display_name, false, p_profile_id, p_guest_id, now()
  );

  insert into public.route_duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  update public.route_duel_rooms set updated_at = now() where id = v_room.id;

  select * into v_room from public.route_duel_rooms where id = v_room.id;
  return v_room;
end;
$$;
revoke all     on function public.route_duel_join_room(text, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.route_duel_join_room(text, uuid, uuid, text, text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 11) route_duel_update_settings (host-only, lobby-only)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_update_settings(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_total_rounds   int,
  p_route_length   text
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room public.route_duel_rooms;
begin
  if not public.route_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_total_rounds is null and p_route_length is null then
    raise exception 'no_fields_to_update' using errcode = '22023';
  end if;
  if p_total_rounds is not null and p_total_rounds not in (3, 5, 10, 15) then
    raise exception 'total_rounds_invalid' using errcode = '22023';
  end if;
  if p_route_length is not null and p_route_length not in ('5','7','7plus') then
    raise exception 'route_length_invalid' using errcode = '22023';
  end if;

  update public.route_duel_rooms
     set total_rounds = coalesce(p_total_rounds, total_rounds),
         route_length = coalesce(p_route_length, route_length),
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
revoke all     on function public.route_duel_update_settings(uuid, uuid, uuid, int, text) from public;
grant  execute on function public.route_duel_update_settings(uuid, uuid, uuid, int, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 12) route_duel_start_game (host-only) — İLK ROTAYI SUNUCU SEÇER
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_start_game(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room  public.route_duel_rooms;
  v_count int;
begin
  if not public.route_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.route_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_not_waiting' using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.route_duel_players where room_id = p_room_id;
  if v_count < 2 then
    raise exception 'not_enough_players' using errcode = 'P0001';
  end if;

  delete from public.route_duel_claims where room_id = p_room_id;

  update public.route_duel_players
     set score = 0, current_key = null, path = '{}', last_seen_at = now()
   where room_id = p_room_id;

  update public.route_duel_rooms
     set status               = 'playing',
         started_at           = now(),
         finished_at          = null,
         finished_reason      = null,
         winner_player_id     = null,
         rematch_requested_by = '{}',
         game_seq             = game_seq + 1,
         updated_at           = now()
   where id = p_room_id
     and status = 'waiting';

  -- İlk tur: rota SUNUCUDA seçilir (client'tan rota parametresi YOK).
  v_room := public._route_duel_begin_round(p_room_id, 1);
  return v_room;
end;
$$;
revoke all     on function public.route_duel_start_game(uuid, uuid, uuid) from public;
grant  execute on function public.route_duel_start_game(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 13) route_duel_submit_move — SUNUCU-OTORİTER HAMLE + ATOMİK İLK-BİTİREN
-- ----------------------------------------------------------------------------
-- Oda satırı FOR UPDATE kilitlenir → doğrula + konum yaz + claim insert
-- ATOMİKtir; advance_round / ikinci oyuncunun submit'i ile yarışta tek sıra.
--   • Konum route_duel_players.current_key'den okunur (client current_country
--     GÖNDEREMEZ / sahteleyemez).
--   • Komşuluk route_duel_graph'a karşı doğrulanır (client iddiası değil).
--   • Hedefe ulaşan İLK oyuncu claim satırını yazar (UNIQUE guard) + skor+1 +
--     round_winner_player_id — hepsi aynı transaction. İkinci tamamlama
--     'round_over'/'dup' alır, skor DEĞİŞMEZ.
--   • Süre: now() >= round_deadline → 'expired' (client kronometresi değil,
--     sunucu saati). Geri sayım: now() < round_started_at → 'not_started'.
-- Dönüş jsonb:
--   { accepted: bool, finished: bool, won: bool, reason?: text,
--     current_key?: text, steps?: int }
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_submit_move(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_country_key text
) returns jsonb
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room      public.route_duel_rooms;
  v_player    public.route_duel_players;
  v_neighbors text[];
  v_new_path  text[];
  v_steps     int;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_country_key is null or length(btrim(p_country_key)) = 0 then
    raise exception 'country_key_required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.route_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Oda satırını KİLİTLE (advance_round / diğer submit ile tek sıra).
  select * into v_room from public.route_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Tur zaten karara bağlandıysa (rakip bitirdi) hamle işlenmez.
  if v_room.round_winner_player_id is not null then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'round_over');
  end if;
  -- Ortak geri sayım bitmeden hamle yok (sunucu saati).
  if v_room.round_started_at is null or now() < v_room.round_started_at then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'not_started');
  end if;
  -- Sunucu-otoriter tur süresi.
  if v_room.round_deadline is not null and now() >= v_room.round_deadline then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'expired');
  end if;

  select * into v_player from public.route_duel_players
   where id = p_player_id and room_id = p_room_id;

  if v_player.current_key is null then
    raise exception 'round_not_initialized' using errcode = 'P0001';
  end if;
  if p_country_key = v_player.current_key then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'same_country');
  end if;

  -- Komşuluk SUNUCUDA doğrulanır (codegen'li route_duel_graph).
  select neighbors into v_neighbors
    from public.route_duel_graph
   where country_key = v_player.current_key;

  if v_neighbors is null or not (p_country_key = any(v_neighbors)) then
    return jsonb_build_object('accepted', false, 'finished', false, 'won', false, 'reason', 'not_neighbor');
  end if;

  -- Geçerli hamle → sunucu-otoriter konum güncelle.
  v_new_path := array_append(v_player.path, p_country_key);
  v_steps    := coalesce(array_length(v_new_path, 1), 1) - 1;

  update public.route_duel_players
     set current_key  = p_country_key,
         path         = v_new_path,
         last_seen_at = now()
   where id = p_player_id;

  if p_country_key <> v_room.round_target_key then
    return jsonb_build_object(
      'accepted', true, 'finished', false, 'won', false,
      'current_key', p_country_key, 'steps', v_steps
    );
  end if;

  -- HEDEFE ULAŞTI → atomik ilk-bitiren claim'i (kilit + UNIQUE çifte kapak).
  begin
    insert into public.route_duel_claims (room_id, player_id, game_seq, round, steps)
    values (p_room_id, p_player_id, v_room.game_seq, v_room.current_round, v_steps);
  exception
    when unique_violation then
      return jsonb_build_object('accepted', true, 'finished', true, 'won', false, 'reason', 'dup');
  end;

  update public.route_duel_players
     set score = score + 1
   where id = p_player_id;

  update public.route_duel_rooms
     set round_winner_player_id = p_player_id,
         round_decided_at       = now(),
         updated_at             = now()
   where id = p_room_id;

  return jsonb_build_object(
    'accepted', true, 'finished', true, 'won', true,
    'current_key', p_country_key, 'steps', v_steps
  );
end;
$$;
revoke all     on function public.route_duel_submit_move(uuid, uuid, uuid, text) from public;
grant  execute on function public.route_duel_submit_move(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 14) route_duel_advance_round — tur ilerletme + finalize + UZATMA
-- ----------------------------------------------------------------------------
-- Odadaki HERHANGİ bir oyuncu çağırabilir (host çökerse güvenlik ağı;
-- flag_group_finalize modeli). Erken atlama İMKÂNSIZ: tur ancak kazanan
-- yazıldıysa VEYA sunucu deadline'ı geçtiyse ilerler. Çift çağrı zararsız:
-- ikinci çağrı yeni turda 'round_not_over' alır.
--   • current_round >= total_rounds VE skorlar FARKLI → finalize (kazanan =
--     yüksek skor; beraberlik sonuç ekranına TAŞINMAZ).
--   • aksi hâlde → yeni tur (skor eşitse son turdan sonra bile devam =
--     UZATMA; ilk uzatma turunu kazanan maçı bitirir — genel kural bunu
--     otomatik sağlar: uzatma galibiyeti skoru farklılaştırır).
--   • Timeout turu (kazanan yok): kimse puan almaz, sadece ilerler.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_advance_round(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room      public.route_duel_rooms;
  v_hi        int;
  v_lo        int;
  v_winner_id uuid;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.route_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.route_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Tur GERÇEKTEN bitti mi? (kazanan yazıldı VEYA sunucu deadline'ı geçti)
  if v_room.round_winner_player_id is null
     and (v_room.round_deadline is null or now() < v_room.round_deadline) then
    raise exception 'round_not_over' using errcode = 'P0001';
  end if;

  select max(score), min(score) into v_hi, v_lo
    from public.route_duel_players
   where room_id = p_room_id;

  if v_room.current_round >= v_room.total_rounds and v_hi <> v_lo then
    -- FINALIZE — kazanan sunucuda hesaplanır (client winner GÖNDEREMEZ).
    select id into v_winner_id
      from public.route_duel_players
     where room_id = p_room_id
     order by score desc, joined_at asc
     limit 1;

    update public.route_duel_rooms
       set status           = 'finished',
           finished_at      = now(),
           finished_reason  = 'completed',
           winner_player_id = v_winner_id,
           updated_at       = now()
     where id = p_room_id
       and status = 'playing'
     returning * into v_room;

    return v_room;
  end if;

  -- Yeni tur (normal ilerleme ya da eşitlikte UZATMA).
  v_room := public._route_duel_begin_round(p_room_id, v_room.current_round + 1);
  return v_room;
end;
$$;
revoke all     on function public.route_duel_advance_round(uuid, uuid, uuid) from public;
grant  execute on function public.route_duel_advance_round(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 15) Rövanş — TEK sunucu-otoriter RPC (oy + İKİNCİ ONAYDA atomik yeni maç)
-- ----------------------------------------------------------------------------
-- "Rövanş İste" ve "Kabul Et" AYNI çağrıdır; client başka hiçbir rövanş
-- RPC'si çağırmaz. Host client'ının açık/foreground/bağlı olmasına ve
-- Realtime olayını almış olmasına BAĞIMLILIK YOK: ikinci onay hangi
-- oyuncudan gelirse gelsin yeni maçı bu çağrının transaction'ı başlatır.
--   • Kimlik: authorize_player (profilli oyuncu → auth.uid(), misafir →
--     claim_token kanıtı) + oda üyeliği kontrolü.
--   • Oda satırı FOR UPDATE → eşzamanlı ikinci-onaylar, çift tıklama ve ağ
--     retry'ları SERİ işlenir; maçı yalnız İLK ikinci-onay başlatır (kilidi
--     sonra alan çağrı status='playing' görür ve oy kaydetmeden mevcut satırı
--     döndürür → duplicate game_seq artışı İMKÂNSIZ).
--   • Oy YALNIZ status='finished' odada kaydedilir; aynı oyuncunun tekrar oyu
--     idempotent (ikinci oyuncu SAYILMAZ) ve oylar MEVCUT oda üyeleriyle
--     sınırlanır (ayrılan oyuncunun bayat oyu rövanş başlatamaz).
--   • Tek onay → yalnız güncellenmiş oda satırı döner (bekleme durumu).
--   • İKİ FARKLI oyuncu onayladıysa AYNI transaction içinde: claim'ler
--     silinir, skorlar + current_key/path bir kez sıfırlanır, oylar
--     temizlenir, game_seq güvenle artar, match_seq/current_match_id
--     yenilenir, total_rounds/route_length ve used_pair_keys KORUNUR,
--     _route_duel_begin_round daha önce kullanılmamış yeni rotayı seçip
--     ortak countdown/start/deadline state'ini kurar, oda 'playing' olur.
-- Dönüş: güncel route_duel_rooms satırı (client + realtime aynı state'i görür).
-- ────────────────────────────────────────────────────────────────────────────

-- Eski taslakta dönüş tipi void idi; tip değişimi için idempotent drop.
drop function if exists public.route_duel_request_rematch(uuid, uuid, uuid);

create function public.route_duel_request_rematch(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room  public.route_duel_rooms;
  v_votes uuid[];
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.route_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- KİLİT: submit/advance/leave ve diğer rövanş çağrılarıyla tek sıra.
  select * into v_room from public.route_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Rövanş zaten başladıysa (status='playing') ya da oda başka fazdaysa oy
  -- KAYDEDİLMEZ; mevcut satır döner → çift tık / ağ retry'ı / eski state
  -- gören istemci ikinci bir maç AÇAMAZ, skorlar ikinci kez SIFIRLANMAZ.
  if v_room.status <> 'finished' then
    return v_room;
  end if;

  -- Idempotent oy (aynı oyuncu en fazla bir kez) + bayat oy temizliği
  -- (yalnız hâlâ odada olan oyuncuların oyları sayılır).
  v_votes := (
    select coalesce(array_agg(distinct v), '{}'::uuid[])
      from unnest(
             case when p_player_id = any(coalesce(v_room.rematch_requested_by, '{}'::uuid[]))
                  then v_room.rematch_requested_by
                  else array_append(coalesce(v_room.rematch_requested_by, '{}'::uuid[]), p_player_id)
             end
           ) as v
     where exists (
       select 1 from public.route_duel_players p
        where p.id = v and p.room_id = p_room_id
     )
  );

  update public.route_duel_rooms
     set rematch_requested_by = v_votes,
         updated_at           = now()
   where id = p_room_id
   returning * into v_room;

  -- Tek onay → yalnız bekleme durumu (oy kaydedildi, maç BAŞLAMAZ).
  if coalesce(array_length(v_votes, 1), 0) < 2 then
    return v_room;
  end if;

  -- İKİNCİ ONAY → AYNI transaction'da yeni maç (skorlar sıfır, ayarlar +
  -- used_pair_keys korunur; rota/zamanlama _route_duel_begin_round'da).
  delete from public.route_duel_claims where room_id = p_room_id;

  update public.route_duel_players
     set score = 0, current_key = null, path = '{}', last_seen_at = now()
   where room_id = p_room_id;

  update public.route_duel_rooms
     set status               = 'playing',
         started_at           = now(),
         finished_at          = null,
         finished_reason      = null,
         winner_player_id     = null,
         rematch_requested_by = '{}',
         game_seq             = game_seq + 1,
         match_seq            = coalesce(match_seq, 1) + 1,
         current_match_id     = gen_random_uuid(),
         updated_at           = now()
   where id = p_room_id
     and status = 'finished';

  v_room := public._route_duel_begin_round(p_room_id, 1);
  return v_room;
end;
$$;
revoke all     on function public.route_duel_request_rematch(uuid, uuid, uuid) from public;
grant  execute on function public.route_duel_request_rematch(uuid, uuid, uuid) to anon, authenticated;


-- Eski iki-adımlı koordinasyonun host-tetiklemeli process RPC'si KALDIRILDI:
-- ikinci onay maçı yukarıdaki çağrının içinde başlattığı için gereksiz ve
-- authenticated'a açık ayrı bir "maç başlat" bypass'ı bırakılmaz. (Bu
-- migration hiç deploy edilmediği için canlıda yoktur; drop yalnız eski
-- taslağın uygulandığı olası yerel ortamlar için idempotent temizlik.)
drop function if exists public.route_duel_process_rematch(uuid, uuid, uuid);


-- ────────────────────────────────────────────────────────────────────────────
-- 16) route_duel_leave_room — playing'de forfeit; aksi hâlde cleanup
--     (wheel_duel_leave_finishes_active_match modeli)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_is_host  boolean;
  v_status   text;
  v_other_id uuid;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select (host_player_id = p_player_id), status
    into v_is_host, v_status
    from public.route_duel_rooms
   where id = p_room_id;

  if v_is_host is null then
    return;  -- oda yok → idempotent no-op
  end if;

  if not exists (
    select 1 from public.route_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    return;  -- bu odada değil → no-op
  end if;

  -- PLAYING fazında çıkış = forfeit; kalan oyuncu kazanır, oda korunur.
  if v_status = 'playing' then
    select id into v_other_id
      from public.route_duel_players
     where room_id = p_room_id
       and id <> p_player_id
     order by joined_at asc
     limit 1;

    if v_other_id is not null then
      update public.route_duel_rooms
         set status           = 'finished',
             finished_at      = now(),
             finished_reason  = 'opponent_left',
             winner_player_id = v_other_id,
             updated_at       = now()
       where id = p_room_id
         and status = 'playing';
      return;
    end if;
    -- Kalan oyuncu yoksa (anormal) → fallback cleanup'a düş.
  end if;

  -- Diğer fazlar: host → oda DELETE (cascade; guest realtime DELETE ile
  -- "oda kapatıldı" görür); değilse kendi satırı silinir (boş oda trigger'ı
  -- temizler).
  if v_is_host then
    delete from public.route_duel_rooms where id = p_room_id;
  else
    delete from public.route_duel_players
     where id = p_player_id and room_id = p_room_id;
  end if;
end;
$$;
revoke all     on function public.route_duel_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.route_duel_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 17) route_duel_heartbeat + route_duel_handle_disconnect
-- ----------------------------------------------------------------------------
-- Presence tek başına oyun otoritesi DEĞİLDİR: kopuş kararını client değil,
-- SUNUCU verir (rakibin last_seen_at'i eşikten eskiyse). Client yalnız
-- "kontrol et" der; erken çağrı sessiz no-op.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_heartbeat(
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql security definer set search_path = public, auth
as $$
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  update public.route_duel_players
     set last_seen_at = now()
   where id = p_player_id;
end;
$$;
revoke all     on function public.route_duel_heartbeat(uuid, uuid) from public;
grant  execute on function public.route_duel_heartbeat(uuid, uuid) to anon, authenticated;


-- Sunucu-doğrulamalı kopuş eşiği. Client 3 sn'de bir heartbeat atar; rakip
-- last_seen_at'i 20 sn'den eskiyse (VEYA hiç heartbeat yoksa maç başlangıcına
-- göre) maç kalan oyuncu lehine biter. Erken çağrı → mevcut satır döner (no-op).
create or replace function public.route_duel_handle_disconnect(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room     public.route_duel_rooms;
  v_opp_id   uuid;
  v_opp_seen timestamptz;
  v_baseline timestamptz;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.route_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select * into v_room from public.route_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    return v_room;  -- idempotent
  end if;
  if v_room.status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  select id, last_seen_at into v_opp_id, v_opp_seen
    from public.route_duel_players
   where room_id = p_room_id and id <> p_player_id
   limit 1;

  if v_opp_id is null then
    return v_room;
  end if;

  v_baseline := coalesce(v_opp_seen, v_room.started_at, now());

  -- 20 sn sunucu grace: eşik dolmadıysa sessiz no-op (client tekrar dener).
  if v_baseline > (now() - interval '20 seconds') then
    return v_room;
  end if;

  update public.route_duel_rooms
     set status           = 'finished',
         finished_at      = now(),
         finished_reason  = 'disconnect',
         winner_player_id = p_player_id,
         updated_at       = now()
   where id = p_room_id
     and status = 'playing'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.route_duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;
revoke all     on function public.route_duel_handle_disconnect(uuid, uuid, uuid) from public;
grant  execute on function public.route_duel_handle_disconnect(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 18) route_duel_send_message — MOD-İZOLE lobi sohbeti
--     (flag_group_send_message ile birebir aynı izolasyon modeli:
--      duel_messages 'route_duel:<code>' namespaced anahtarıyla yazılır;
--      GERÇEK kod üyelikten çözülür, client string'ine güvenilmez.)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_send_message(
  p_room_code   text,
  p_player_id   uuid,
  p_claim_token uuid,
  p_message     text
) returns public.duel_messages
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_player    public.route_duel_players;
  v_real_code text;
  v_room_key  text;
  v_msg       public.duel_messages;
  v_trim      text;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_room_code is null or length(btrim(p_room_code)) = 0 then
    raise exception 'room_code_required' using errcode = '22023';
  end if;
  if p_message is null then
    raise exception 'message_required' using errcode = '22023';
  end if;

  v_trim := btrim(p_message);
  if length(v_trim) = 0 then
    raise exception 'message_empty' using errcode = '22023';
  end if;
  if length(v_trim) > 200 then
    raise exception 'message_too_long' using errcode = '22023';
  end if;

  select * into v_player from public.route_duel_players where id = p_player_id;
  if v_player.id is null then
    raise exception 'player_not_found' using errcode = '02000';
  end if;

  select code into v_real_code
    from public.route_duel_rooms
   where id = v_player.room_id;

  if v_real_code is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  v_room_key := 'route_duel:' || v_real_code;
  if p_room_code <> v_room_key then
    raise exception 'room_code_mismatch' using errcode = '42501';
  end if;

  perform public._duel_messages_antispam_check(v_room_key, v_player.name, v_trim);

  insert into public.duel_messages (room_code, player_name, message)
  values (v_room_key, v_player.name, v_trim)
  returning * into v_msg;

  return v_msg;
end;
$$;
revoke all     on function public.route_duel_send_message(text, uuid, uuid, text) from public;
grant  execute on function public.route_duel_send_message(text, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 19) Hızlı Eşleş — mode level + quick_match + cancel + reset
--     (country_duel/flag_duel queue deseni; eşleşme AYNI total_rounds +
--      AYNI route_length ister; blok dışlama; LEAST bracket; self-heal.)
-- ────────────────────────────────────────────────────────────────────────────

-- Formül progression.ts getLevelFromXp ile aynı: floor(sqrt(xp/100)) + 1.
-- route_duel için xp_events yazımı ŞU AN YOK → herkes level 1 (bracket
-- trivially geçer); ileride progression eklenirse otomatik çalışır.
create or replace function public.route_duel_mode_level(p_profile_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select floor(sqrt(coalesce(sum(xp_earned), 0)::float / 100.0))::int + 1
    from public.xp_events
   where profile_id = p_profile_id
     and mode_key   = 'route_duel';
$$;
revoke all     on function public.route_duel_mode_level(uuid) from public;
grant  execute on function public.route_duel_mode_level(uuid) to authenticated;


create or replace function public.route_duel_quick_match(
  p_profile_id     uuid,
  p_player_id      uuid,
  p_player_name    text,
  p_claim_token    uuid,
  p_total_rounds   int,
  p_route_length   text,
  p_max_level_diff int,
  p_room_code      text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_level   int;
  v_candidate  record;
  v_room_id    uuid;
  v_now        timestamptz := now();
  v_expires_at timestamptz := v_now + interval '45 seconds';
  v_existing   record;
begin
  if auth.uid() is null then
    raise exception 'route_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'route_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  if p_total_rounds is null or p_total_rounds not in (3, 5, 10, 15) then
    raise exception 'route_duel_quick_match: invalid total_rounds %', p_total_rounds;
  end if;
  if p_route_length is null or p_route_length not in ('5','7','7plus') then
    raise exception 'route_duel_quick_match: invalid route_length %', p_route_length;
  end if;
  if p_max_level_diff is null or p_max_level_diff < 0 then
    raise exception 'route_duel_quick_match: invalid max_level_diff';
  end if;
  if coalesce(p_room_code, '') = '' then
    raise exception 'route_duel_quick_match: empty room_code';
  end if;
  if coalesce(btrim(p_player_name), '') = '' then
    raise exception 'route_duel_quick_match: empty player_name';
  end if;
  if p_player_id is null or p_claim_token is null then
    raise exception 'route_duel_quick_match: identity_required';
  end if;

  v_my_level := public.route_duel_mode_level(p_profile_id);

  -- Stale-row self-heal (country/flag deseni): matched göründüğü hâlde oda
  -- gerçekte yoksa/eskiyse satırı araması sürecek hâle getir.
  update public.route_duel_queue q
     set matched_room_id = null,
         updated_at      = v_now
   where q.profile_id      = p_profile_id
     and q.matched_room_id is not null
     and not exists (
       select 1
         from public.route_duel_rooms r
        where r.id = q.matched_room_id
          and r.status = 'playing'
          and r.created_at > v_now - interval '60 seconds'
     );

  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.route_duel_queue
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

  -- Uygun aday: AYNI tur sayısı + AYNI rota uzunluğu + level bracket + blok yok.
  select q.profile_id, q.player_id, q.player_name, q.claim_token,
         q.mode_level, q.max_level_diff, q.created_at
    into v_candidate
    from public.route_duel_queue q
   where q.profile_id      <> p_profile_id
     and q.total_rounds     = p_total_rounds
     and q.route_length     = p_route_length
     and q.matched_room_id is null
     and q.expires_at       > v_now
     and abs(q.mode_level - v_my_level)
           <= least(coalesce(q.max_level_diff, 0), coalesce(p_max_level_diff, 0))
     and not public.is_blocked_between(p_profile_id, q.profile_id)
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- EŞLEŞME — oda + iki oyuncu + iki claim token + İLK TUR atomik kurulur.
    -- host = bekleyen aday (flag_duel deterministik host modeli).
    insert into public.route_duel_rooms (
      code, status, total_rounds, route_length, host_player_id,
      room_source, started_at, game_seq
    ) values (
      p_room_code, 'playing', p_total_rounds, p_route_length, v_candidate.player_id,
      'quick_match', v_now + interval '3 seconds', 1
    )
    returning id into v_room_id;

    insert into public.route_duel_players (id, room_id, name, is_host, profile_id, last_seen_at)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, true,
              v_candidate.profile_id, v_now);

    insert into public.route_duel_players (id, room_id, name, is_host, profile_id, last_seen_at)
      values (p_player_id, v_room_id, btrim(p_player_name), false,
              p_profile_id, v_now);

    -- Token'lar queue satırından / parametreden SUNUCUDA yazılır (client'ın
    -- player_claims'e doğrudan yazma yolu YOK).
    insert into public.route_duel_player_claims (player_id, claim_token)
      values (v_candidate.player_id, v_candidate.claim_token);
    insert into public.route_duel_player_claims (player_id, claim_token)
      values (p_player_id, p_claim_token);

    -- İlk turun rotasını sunucu seçer.
    perform public._route_duel_begin_round(v_room_id, 1);

    update public.route_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

    insert into public.route_duel_queue as q (
      profile_id, player_id, player_name, claim_token,
      total_rounds, route_length, mode_level, max_level_diff,
      matched_room_id, expires_at, created_at, updated_at
    ) values (
      p_profile_id, p_player_id, btrim(p_player_name), p_claim_token,
      p_total_rounds, p_route_length, v_my_level, p_max_level_diff,
      v_room_id, v_expires_at, v_now, v_now
    )
    on conflict (profile_id) do update
      set player_id       = excluded.player_id,
          player_name     = excluded.player_name,
          claim_token     = excluded.claim_token,
          total_rounds    = excluded.total_rounds,
          route_length    = excluded.route_length,
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

  -- EŞLEŞME YOK — caller'ın queue satırını UPSERT et.
  insert into public.route_duel_queue as q (
    profile_id, player_id, player_name, claim_token,
    total_rounds, route_length, mode_level, max_level_diff,
    matched_room_id, expires_at, created_at, updated_at
  ) values (
    p_profile_id, p_player_id, btrim(p_player_name), p_claim_token,
    p_total_rounds, p_route_length, v_my_level, p_max_level_diff,
    null, v_expires_at, v_now, v_now
  )
  on conflict (profile_id) do update
    set player_id      = excluded.player_id,
        player_name    = excluded.player_name,
        claim_token    = excluded.claim_token,
        total_rounds   = excluded.total_rounds,
        route_length   = excluded.route_length,
        mode_level     = excluded.mode_level,
        max_level_diff = excluded.max_level_diff,
        expires_at     = excluded.expires_at,
        updated_at     = excluded.updated_at
    where q.matched_room_id is null;

  select profile_id, player_id, matched_room_id, created_at
    into v_existing
    from public.route_duel_queue
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
revoke all     on function public.route_duel_quick_match(uuid, uuid, text, uuid, int, text, int, text) from public;
grant  execute on function public.route_duel_quick_match(uuid, uuid, text, uuid, int, text, int, text) to authenticated;


create or replace function public.route_duel_cancel_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'route_duel_cancel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'route_duel_cancel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  delete from public.route_duel_queue
   where profile_id      = p_profile_id
     and matched_room_id is null;
end;
$$;
revoke all     on function public.route_duel_cancel_quick_match(uuid) from public;
grant  execute on function public.route_duel_cancel_quick_match(uuid) to authenticated;


create or replace function public.route_duel_reset_quick_match(
  p_profile_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'route_duel_reset_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'route_duel_reset_quick_match: auth.uid() does not match p_profile_id';
  end if;

  delete from public.route_duel_queue where profile_id = p_profile_id;
end;
$$;
revoke all     on function public.route_duel_reset_quick_match(uuid) from public;
grant  execute on function public.route_duel_reset_quick_match(uuid) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 20) resolve_torble_room_code — routeDuel eklenmiş YENİDEN tanım
-- ----------------------------------------------------------------------------
-- 20260801120000_room_code_resolver.sql (canlı) DEĞİŞTİRİLMEDİ; fonksiyon
-- burada CREATE OR REPLACE ile aynen + route_duel_rooms branch'i (ord 9)
-- olarak yeniden tanımlanır. Kod başka modla çakışırsa mevcut 'ambiguous'
-- davranışı aynen sürer. SÖZLEŞME: src/lib/roomCodeShared.ts +
-- scripts/check-room-code-resolver.ts ile senkron tutulmalı.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.resolve_torble_room_code(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_norm    text;
  v_matches jsonb;
  v_count   int;
begin
  if p_code is null then
    return jsonb_build_object('result', 'invalid');
  end if;

  v_norm := upper(regexp_replace(btrim(p_code), '[^A-Za-z0-9]', '', 'g'));

  if length(v_norm) <> 6 then
    return jsonb_build_object('result', 'invalid');
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_object('mode', mode, 'label', label) order by ord), '[]'::jsonb),
    count(*)
  into v_matches, v_count
  from (
    select 'duel' as mode, 'Ülke Yaz 1v1' as label, 1 as ord
      from public.duel_rooms dr
     where dr.code = v_norm
       and dr.status <> 'finished'
       and (dr.room_kind = 'country' or dr.room_kind is null)

    union all
    select 'flagDuel', 'Bayrak 1v1', 2
      from public.duel_rooms dr
     where dr.code = v_norm
       and dr.status <> 'finished'
       and (dr.room_kind = 'flag' or dr.room_kind is null)

    union all
    select 'wheelDuel', 'Çark 1v1', 3
      from public.wheel_duel_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'duelGroup', 'Ülke Yaz Grup', 4
      from public.duel_group_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'wheelGroup', 'Çark Grup', 5
      from public.wheel_group_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'flagGroup', 'Bayrak Bilmece', 6
      from public.flag_group_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'korNokta', 'Kör Nokta', 7
      from public.tevatur_rooms
     where code = v_norm and status <> 'finished'

    union all
    select 'conquest', 'Kuşatma', 8
      from public.conquest_rooms
     where room_code = v_norm and status not in ('finished', 'closed')

    union all
    select 'routeDuel', 'Rota 1v1', 9
      from public.route_duel_rooms
     where code = v_norm and status <> 'finished'
  ) t;

  if v_count = 0 then
    return jsonb_build_object('result', 'not_found', 'code', v_norm);
  elsif v_count = 1 then
    return jsonb_build_object(
      'result', 'found',
      'code',   v_norm,
      'mode',   v_matches->0->>'mode',
      'label',  v_matches->0->>'label'
    );
  else
    return jsonb_build_object(
      'result',  'ambiguous',
      'code',    v_norm,
      'matches', v_matches
    );
  end if;
end
$fn$;

revoke all     on function public.resolve_torble_room_code(text) from public;
grant  execute on function public.resolve_torble_room_code(text) to authenticated;


-- ============================================================================
-- DONE — doğrulama (Studio SQL editor):
--   select proname, prosecdef from pg_proc
--    where pronamespace='public'::regnamespace and proname like 'route_duel_%'
--    order by proname;                       -- hepsi prosecdef=true
--   select count(*) from public.route_duel_graph;   -- 142
--   select intermediates, count(*) from public.route_duel_pool group by 1;
--     -- 5:805, 7:722, 8:656, 9:477
--   select tablename, policyname, cmd from pg_policies
--    where schemaname='public' and tablename like 'route_duel_%' order by 1,2;
--     -- rooms/players/claims: yalnız SELECT; queue: SELECT own;
--     -- graph/pool/player_claims: policy YOK.
--
-- Smoke (SQL, 2 oturum):
--   select * from route_duel_create_room(gen_random_uuid(), null, 'gA','Alice','RTEST1',5,'5',gen_random_uuid());
--   select * from route_duel_join_room('RTEST1', gen_random_uuid(), null,'gB','Bob', gen_random_uuid());
--   select * from route_duel_start_game('<room>','<A>','<Atok>');
--     -- rooms.round_start_key/round_target_key dolu, players.current_key=start
--   select route_duel_submit_move('<room>','<B>','<Btok>','<startın komşusu>');
--     -- {accepted:true,...}; komşu olmayan → {accepted:false,reason:'not_neighbor'}
--   -- İlk hedefe ulaşan → {won:true}; ikinci → 'round_over'/'dup', skor değişmez.
--   select * from route_duel_advance_round('<room>','<A>','<Atok>');
--     -- kazanan yoksa ve süre dolmadıysa 'round_not_over'
--   select * from route_duel_request_rematch('<room>','<A>','<Atok>');
--     -- 1. çağrı (finished odada): yalnız oy — status 'finished' kalır.
--   select * from route_duel_request_rematch('<room>','<B>','<Btok>');
--     -- İKİNCİ ONAY: AYNI transaction'da yeni maç — status 'playing',
--     -- game_seq+1, skorlar 0, yeni rota; host'tan ek RPC GEREKMEZ.
--     -- Tekrarı (retry/çift tık) oy kaydetmeden mevcut satırı döndürür.
-- ============================================================================
