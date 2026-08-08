-- ============================================================================
-- Misafir kuralının SUNUCU tarafında tamamlanması
--   A) Kuşatma: ham tablo okuma yolunun kapatılması (enumerasyon)
--   B) Host devri: MİSAFİR HİÇBİR MODDA HOST OLAMAZ
-- ============================================================================
-- ÜRÜN KURALI (20260808120000 + 20260809120000'in devamı)
-- -------------------------------------------------------------------------
--   KAYITLI oyuncu : oda kurar, AÇIK ODA LİSTESİNİ GÖRÜR, Hızlı Eşleş
--                    kullanır, XP/altın/görev kazanır, HOST olabilir.
--   MİSAFİR oyuncu : YALNIZ bildiği oda koduyla BELİRLİ bir odaya katılır.
--                    Açık oda listesini HİÇBİR YOLDAN göremez (istemci, RPC,
--                    REST, doğrudan tablo sorgusu). Oda kuramaz, HOST OLAMAZ,
--                    kalıcı ilerleme yazamaz.
--
--
-- BÖLÜM A — NEDEN GEREKLİ
-- -----------------------
-- 20260809120000 açık oda listesini `conquest_list_public_rooms()` RPC'sine
-- taşıdı ve o RPC'yi `authenticated`a kilitledi. Ancak `conquest_rooms` ve
-- `conquest_players` tablolarındaki SELECT policy'si HÂLÂ
--
--     for select to anon, authenticated using (true)
--
-- idi. Yani teknik bilgisi olan biri RPC'ye hiç dokunmadan, doğrudan
--
--     GET /rest/v1/conquest_rooms?visibility=eq.public&status=eq.waiting
--     GET /rest/v1/conquest_players?select=room_id
--
-- diyerek tüm açık odaları ve oyuncu sayılarını listeleyebiliyordu. RPC'yi
-- kapatmak enumerasyonu DURDURMAZ; base table'ın kendisi kapatılmalıdır.
-- Bu bölüm o kapıyı kapatır.
--
-- SEÇİLEN YAKLAŞIM: claim-token'lı RPC + sinyal yayını (broadcast).
-- Supabase Anonymous Auth ALTERNATİFİ KASTEN SEÇİLMEDİ; gerekçe:
--   Anonymous Auth kullanıcısı PostgreSQL'de `authenticated` rolünde çalışır.
--   Bu projede "misafir yapamaz" kuralının TAMAMI bugün `to authenticated`
--   grant'i ile ifade edilmiştir (oda kurma, Hızlı Eşleş, XP, altın, günlük
--   görev, profil yazma, DM, arkadaşlık, liderlik tablosu, moderasyon…).
--   Anonymous Auth açıldığı anda bu kuralların HEPSİ tek seferde misafire
--   açılır ve her biri `is_anonymous = false` şartıyla tek tek yeniden
--   yazılmak zorunda kalır — otuzdan fazla migration'a yayılmış bir yüzey.
--   Tek bir gözden kaçan grant sessiz bir yetki yükseltmesidir. Bu yüzden
--   misafir `anon` rolünde BIRAKILIR ve kanıtı claim_token olarak kalır.
--
-- MİSAFİR ARTIK KENDİ ODASINI NASIL OKUR:
--   `conquest_get_room_state(room_id, player_id, claim_token)` — üyeliği
--   kanıtlanmış TEK bir odanın satırını + oyuncularını döndürür. Filtre,
--   limit, order kabul etmez; başka room_id verilirse `not_a_member` döner.
--
-- CANLI GÜNCELLEME:
--   `postgres_changes` RLS'e bağlıdır; anon SELECT kapanınca misafir için
--   çalışmaz. Yerine odaya özel private broadcast kanalı (`conquest:<uuid>`)
--   kullanılır. Kanal VERİ TAŞIMAZ — yalnız "bu odada bir şey değişti"
--   sinyali gönderir; istemci veriyi her zaman yetkili RPC'den okur. Böylece
--   kanal politikası yanlış yapılandırılsa bile oda verisi sızmaz.
--
--
-- BÖLÜM B — NEDEN GEREKLİ
-- -----------------------
-- Host devri yapan dört mod (Kuşatma, Çark Grup, Düello Grup, Kör Nokta)
-- yeni host'u `order by joined_at asc limit 1` ile seçiyordu. Bu sorgu
-- misafir/kayıtlı ayrımı YAPMIYORDU → kayıtlı host ayrıldığında oda yönetimi
-- (ayarlar, başlatma, oyuncu atma) bir misafire geçebiliyordu.
--
--
-- BAĞIMLILIK — SIRA ÖNEMLİ
-- ------------------------
--   20260527120000_conquest_rls_hardening.sql   (conquest_authorize_player)
--   20260601120000_wheel_group_rls_hardening_m2.sql (wheel_group_leave_room)
--   20260608120000_duel_group_rls_hardening_m2.sql  (duel_group_leave_room)
--   20260627120000_conquest_host_transfer.sql   (conquest_leave_room son hâli)
--   20260711120000_tevatur_init.sql             (tevatur_leave_room)
--   20260808120000_guest_room_join.sql
--   20260809120000_guest_browse_gate_and_kornokta.sql  (tevatur_players.guest_id)
--
-- Bu dosya 20260809120000'DEN SONRA çalıştırılmalıdır.
--
-- IDEMPOTENT: create or replace / if not exists / drop … if exists →
-- tekrar çalıştırılabilir.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0) ÖN KOŞUL DENETİMİ
-- ----------------------------------------------------------------------------
-- Eksik bağımlılıkta CREATE komutları sessizce başarılı olur ama fonksiyon
-- ÇAĞRILDIĞINDA patlar (PL/pgSQL geç bağlama). Bu blok o sessiz felaketi
-- baştan durdurur.
-- ────────────────────────────────────────────────────────────────────────────

do $pre$
declare
  v_missing text[] := '{}';
begin
  if to_regprocedure('public.conquest_authorize_player(uuid,uuid)') is null then
    v_missing := v_missing || 'public.conquest_authorize_player(uuid,uuid)  [20260527120000]';
  end if;
  if to_regprocedure('public.conquest_leave_room(uuid,uuid,uuid)') is null then
    v_missing := v_missing || 'public.conquest_leave_room(uuid,uuid,uuid)  [20260627120000]';
  end if;
  if to_regprocedure('public.wheel_group_leave_room(uuid,uuid,uuid)') is null then
    v_missing := v_missing || 'public.wheel_group_leave_room(uuid,uuid,uuid)  [20260601120000]';
  end if;
  if to_regprocedure('public.duel_group_leave_room(uuid,uuid,uuid)') is null then
    v_missing := v_missing || 'public.duel_group_leave_room(uuid,uuid,uuid)  [20260608120000]';
  end if;
  if to_regprocedure('public.tevatur_leave_room(uuid,uuid,uuid)') is null then
    v_missing := v_missing || 'public.tevatur_leave_room(uuid,uuid,uuid)  [20260711120000]';
  end if;

  -- Misafir/kayıtlı ayrımı bu kolona dayanır; yoksa Bölüm B ANLAMSIZ olur.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'tevatur_players'
       and column_name  = 'guest_id'
  ) then
    v_missing := v_missing || 'public.tevatur_players.guest_id  [20260809120000]';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception
      'ÖN KOŞUL EKSİK — bu migration çalıştırılamaz. Eksik nesneler: %. Önce ilgili migration(lar)ı uygula.',
      array_to_string(v_missing, ' | ');
  end if;
end
$pre$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ BÖLÜM A — KUŞATMA: ham anon tablo okumasının kapatılması                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ────────────────────────────────────────────────────────────────────────────
-- A1) conquest_rooms — SELECT yalnız `authenticated`
-- ----------------------------------------------------------------------------
-- ÖNCESİ: `to anon, authenticated using (true)` → anon anahtarı olan herkes
--         tüm oda tablosunu filtreleyip sıralayabiliyordu.
-- SONRASI: policy YALNIZ `authenticated` rolüne verilir. anon için POLICY
--          YOKTUR → RLS varsayılanı reddetmektir.
--
-- İKİ KATMAN (kasıtlı):
--   (1) Policy — anon'a policy tanımlanmaz.
--   (2) GRANT  — tablo SELECT yetkisi anon'dan geri alınır. Supabase yeni
--       tablolara varsayılan olarak anon+authenticated grant'i verir; policy
--       ileride yanlışlıkla genişletilse bile grant ayakta kalır (ve tersi).
--
-- Kayıtlı kullanıcının DAVRANIŞI DEĞİŞMEZ: policy'si hâlâ `using (true)`,
-- yani hem açık oda listesi hem `postgres_changes` realtime aynen çalışır.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.conquest_rooms   enable row level security;
alter table public.conquest_players enable row level security;

drop policy if exists "conquest_rooms_select_all"  on public.conquest_rooms;
drop policy if exists "conquest_rooms_select_auth" on public.conquest_rooms;

create policy "conquest_rooms_select_auth"
  on public.conquest_rooms
  for select
  to authenticated
  using (true);

revoke select on table public.conquest_rooms from anon;


-- ────────────────────────────────────────────────────────────────────────────
-- A2) conquest_players — SELECT yalnız `authenticated`
-- ----------------------------------------------------------------------------
-- Oda listesini kapatıp oyuncu tablosunu açık bırakmak işe yaramaz: oyuncu
-- tablosu room_id'leri ve oyuncu adlarını olduğu gibi verir, oradan oda
-- kümesi türetilebilir. İkisi birlikte kapatılır.
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "conquest_players_select_all"  on public.conquest_players;
drop policy if exists "conquest_players_select_auth" on public.conquest_players;

create policy "conquest_players_select_auth"
  on public.conquest_players
  for select
  to authenticated
  using (true);

revoke select on table public.conquest_players from anon;

-- Süpürücü: bu iki tabloda `anon`a açık BAŞKA bir policy kalmasın (Studio'dan
-- elle eklenmiş ya da eski migration'lardan artakalmış olabilir).
do $sweep$
declare
  pol record;
begin
  for pol in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('conquest_rooms', 'conquest_players')
       and 'anon' = any(roles)
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
    raise notice 'anon policy kaldırıldı: %.%', pol.tablename, pol.policyname;
  end loop;
end
$sweep$;


-- ────────────────────────────────────────────────────────────────────────────
-- A3) conquest_get_room_state — misafirin TEK okuma yolu
-- ----------------------------------------------------------------------------
-- Misafir kendi odasının lobi + oyun durumunu YALNIZ buradan okur.
--
-- NEDEN ENUMERASYONA KAPALI:
--   • p_room_id ZORUNLU ve tektir — filtre/limit/order parametresi yoktur.
--   • Dönmeden önce çağıranın O ODADAKİ bir oyuncu satırının sahibi olduğu
--     kanıtlanır (`conquest_authorize_player` + `room_id` eşleşmesi).
--   • Başka bir room_id verilirse `not_a_member` döner — odanın var olup
--     olmadığı bilgisi bile SIZMAZ (var olmayan oda ile üye olunmayan oda
--     aynı cevabı verir).
--   • Oda kodunu BİLMEK tek başına yetmez: kod ile oyuncu listesi okunamaz,
--     önce `conquest_register_player` ile gerçekten katılmak gerekir.
--
-- Kayıtlı kullanıcı da bu RPC'yi çağırabilir (aynı kontroller geçerlidir);
-- istemci ortak kod yolunu kullanabilsin diye grant her iki role verilir.
--
-- claim_token DÖNMEZ: `conquest_player_claims` bu sorguya hiç girmez.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_get_room_state(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_member  boolean;
  v_room    public.conquest_rooms;
  v_players jsonb;
begin
  if p_room_id is null or p_player_id is null then
    raise exception 'room_and_player_required' using errcode = '22023';
  end if;

  -- Üyelik iki şart ister: (a) satırın sahibi olduğunu kanıtla,
  --                        (b) o satır İSTENEN odada olsun.
  -- (b) olmadan, herhangi bir odadaki geçerli bir claim_token BÜTÜN odaları
  -- okumaya yeterdi.
  select exists (
    select 1
      from public.conquest_players p
     where p.id      = p_player_id
       and p.room_id = p_room_id
       and public.conquest_authorize_player(p_player_id, p_claim_token)
  ) into v_member;

  if not coalesce(v_member, false) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;

  select * into v_room from public.conquest_rooms where id = p_room_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'room_gone');
  end if;

  select coalesce(jsonb_agg(to_jsonb(p) order by p.joined_at asc), '[]'::jsonb)
    into v_players
    from public.conquest_players p
   where p.room_id = p_room_id;

  return jsonb_build_object(
    'ok',      true,
    'room',    to_jsonb(v_room),
    'players', v_players
  );
end
$$;

revoke all     on function public.conquest_get_room_state(uuid, uuid, uuid) from public;
grant  execute on function public.conquest_get_room_state(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- A4) Canlı güncelleme — odaya özel SİNYAL yayını
-- ----------------------------------------------------------------------------
-- `postgres_changes` aboneliği RLS'e bağlıdır: Realtime her aboneye satırı
-- görme yetkisi olup olmadığını sorar. A1/A2 ile anon SELECT kapandığı için
-- misafirin postgres_changes aboneliği ARTIK OLAY ALMAZ. (Kayıtlı kullanıcı
-- etkilenmez — onun policy'si duruyor.)
--
-- Yerine: her yazma `conquest:<room_id>` private broadcast konusuna bir
-- SİNYAL gönderir. İstemci sinyali alınca veriyi A3'teki yetkili RPC'den
-- okur.
--
-- NEDEN SATIR VERİSİ TAŞIMIYORUZ:
--   Broadcast'in yetkisi KONU (topic) düzeyindedir, satır düzeyinde değil.
--   Yükün içine oda satırını koysaydık, kanal politikasındaki herhangi bir
--   gevşeklik doğrudan veri sızıntısı olurdu. Sinyalin içinde çağıranın
--   abone olmak için ZATEN bilmek zorunda olduğu room_id'den başka bir şey
--   yoktur; gerçek veri her zaman üyelik kanıtı isteyen RPC'den gelir.
--
-- İKİ SAVUNMA:
--   • Yayın çağrısı `exception when others then null` ile sarılıdır — yayın
--     altyapısı yoksa/bozuksa OYUN YAZMALARI BOZULMAZ, yalnız sinyal düşer.
--   • İstemci tarafında ayrıca yoklama (polling) yedeği vardır; sinyal hiç
--     gelmese bile misafirin ekranı donmaz (bkz. conquestRealtime.ts).
--
-- HEARTBEAT GÜRÜLTÜSÜ: `conquest_heartbeat_player` her 20 saniyede bir
-- last_seen_at / updated_at yazar. Bunlar oyun durumu değiştirmez; yalnız bu
-- kolonlar değiştiyse sinyal GÖNDERİLMEZ (yoksa her misafir 20 saniyede bir
-- gereksiz tam durum çekerdi).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_broadcast_room_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
begin
  if TG_OP = 'DELETE' then
    v_room_id := old.id;
  else
    v_room_id := new.id;
  end if;

  -- Yalnız heartbeat (updated_at) değiştiyse sinyal gönderme.
  --
  -- İÇ İÇE IF ZORUNLU (tek satırda `TG_OP = 'UPDATE' and new.x …` YAZILAMAZ):
  -- PL/pgSQL bir IF koşulunu tek bir SQL ifadesi olarak çalıştırır ve `new`i
  -- parametre olarak bağlar. DELETE'te `new` atanmamıştır; kısa devre olsa
  -- bile bağlama aşamasında "record new is not assigned yet" hatası alınır.
  -- İç blok yalnız TG_OP='UPDATE' iken çalıştığı için `new` orada hep doludur.
  --
  -- Anlamlı kolonlar TEK TEK sayılır; `to_jsonb(new) - 'updated_at'`
  -- karşılaştırması KASTEN kullanılmaz — gameplay_state büyük bir JSONB'dir ve
  -- her yazmada iki kopya üretmek pahalıdır. `or` ilk TRUE'da kısa devre yapar,
  -- oyun sırasında zaten ilk şart tutar.
  if TG_OP = 'UPDATE' then
    if not (
         new.gameplay_state is distinct from old.gameplay_state
      or new.status         is distinct from old.status
      or new.host_player_id is distinct from old.host_player_id
      or new.host_name      is distinct from old.host_name
      or new.map_id         is distinct from old.map_id
      or new.max_players    is distinct from old.max_players
      or new.round_count    is distinct from old.round_count
      or new.visibility     is distinct from old.visibility
      or new.team_mode      is distinct from old.team_mode
      or new.started_at     is distinct from old.started_at
      or new.finished_at    is distinct from old.finished_at
    ) then
      return null;
    end if;
  end if;

  begin
    perform realtime.send(
      jsonb_build_object('room_id', v_room_id, 'op', TG_OP, 'src', 'rooms'),
      'conquest_change',
      'conquest:' || v_room_id::text,
      true            -- private kanal
    );
  exception when others then
    null;  -- Yayın hattı OYUNU ASLA BOZAMAZ.
  end;

  return null;   -- AFTER trigger → dönüş değeri yok sayılır
end
$$;

create or replace function public.conquest_broadcast_player_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
begin
  if TG_OP = 'DELETE' then
    v_room_id := old.room_id;
  else
    v_room_id := new.room_id;
  end if;

  if v_room_id is null then
    return null;
  end if;

  -- Yalnız heartbeat (last_seen_at) değiştiyse sinyal gönderme.
  -- İç içe IF gerekçesi için conquest_broadcast_room_signal'daki nota bakın
  -- (DELETE'te `new` atanmamıştır). Oyuncu satırı küçük olduğu için burada
  -- jsonb farkı almak ucuzdur ve kolon listesi tutmaktan daha az kırılgandır.
  if TG_OP = 'UPDATE' then
    if to_jsonb(new) - 'last_seen_at' = to_jsonb(old) - 'last_seen_at' then
      return null;
    end if;
  end if;

  begin
    perform realtime.send(
      jsonb_build_object('room_id', v_room_id, 'op', TG_OP, 'src', 'players'),
      'conquest_change',
      'conquest:' || v_room_id::text,
      true
    );
  exception when others then
    null;
  end;

  return null;
end
$$;

drop trigger if exists conquest_rooms_broadcast_signal   on public.conquest_rooms;
drop trigger if exists conquest_players_broadcast_signal on public.conquest_players;

create trigger conquest_rooms_broadcast_signal
  after insert or update or delete on public.conquest_rooms
  for each row execute function public.conquest_broadcast_room_signal();

create trigger conquest_players_broadcast_signal
  after insert or update or delete on public.conquest_players
  for each row execute function public.conquest_broadcast_player_signal();


-- ────────────────────────────────────────────────────────────────────────────
-- A5) conquest_register_player — kapasite + renk SUNUCUDA
-- ----------------------------------------------------------------------------
-- NEDEN BU FONKSİYON DA DEĞİŞMEK ZORUNDA
-- --------------------------------------
-- Katılma akışı, katılmadan ÖNCE `conquest_players` tablosunu ham okuyordu:
--   (a) kapasite dolu mu?         → `evaluateJoinable(room, players.length)`
--   (b) hangi renkler alınmış?    → `pickNextConquestColor(...)`
-- A2 ile o okuma misafire kapandığı için bu iki karar SUNUCUYA taşınmak
-- zorundadır. Aksi hâlde ya misafir katılamaz ya da tabloyu yeniden açmak
-- gerekirdi — ikisi de kabul edilemez.
--
-- Bu, aynı zamanda GERÇEK bir açığı kapatır: kapasite bugüne kadar YALNIZ
-- istemcide kontrol ediliyordu. RPC'yi doğrudan çağıran biri `max_players`
-- sınırını aşarak odaya oyuncu ekleyebilirdi. Artık oda satırı `for update`
-- ile kilitliyken sayılır → yarış durumunda da doğrudur.
--
-- RENK: p_color boş ya da odada alınmışsa sunucu paletten ilk boş rengi
-- verir. Palet istemcideki CONQUEST_COLOR_PALETTE ile BİREBİR aynı sıradadır
-- (conquestState.ts) — iki tarafın aynı rengi seçmesi UI tutarlılığı içindir,
-- otorite buradadır.
--
-- Gövdenin geri kalanı (kimlik tutarlılığı, claim_token, ad kontrolü, oda
-- tazeleme) 20260527120000'deki hâliyle AYNIDIR.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_register_player(
  p_room_id     uuid,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_color       text,
  p_is_host     boolean,
  p_claim_token uuid
) returns public.conquest_players
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_player  public.conquest_players;
  v_uid     uuid := auth.uid();
  v_id      uuid := coalesce(p_player_id, gen_random_uuid());
  v_room    public.conquest_rooms;
  v_count   int;
  v_color   text;
  v_palette text[] := array['red','blue','green','yellow','purple','orange','pink','cyan'];
begin
  -- Kimlik tutarlılığı
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

  -- Ad zorunlu (frontend zaten validate ediyor; defansif)
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'name_invalid' using errcode = '22023';
  end if;

  -- Oda kilidi: kapasite sayımı ile INSERT arasındaki yarışı serileştirir.
  select * into v_room
    from public.conquest_rooms
   where id = p_room_id
   for update;

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  -- Yeniden katılma (aynı hesap, başka sekme, kopan bağlantı): YENİ satır
  -- açmayız, mevcut satırı döndürürüz. Kapasite kontrolünden ÖNCE gelir —
  -- 4/4 dolu bir odada ZATEN oyuncu olan biri "oda dolu" hatası almamalıdır.
  if p_profile_id is not null then
    select * into v_player
      from public.conquest_players
     where room_id = p_room_id
       and profile_id = p_profile_id;

    if found then
      -- Bu dala YALNIZ satırın sahibi girebilir (yukarıda p_profile_id =
      -- auth.uid() zorunlu kılındı), bu yüzden claim_token'ı tazelemek
      -- güvenlidir: istemcinin bu çağrı için ürettiği yeni token çalışır.
      insert into public.conquest_player_claims (player_id, claim_token)
      values (v_player.id, p_claim_token)
      on conflict (player_id) do update set claim_token = excluded.claim_token;
      return v_player;
    end if;
  else
    -- MİSAFİR: kimlik kanıtı YALNIZ claim_token'dır; guest_id GİZLİ DEĞİLDİR
    -- (kayıtlı kullanıcılar oyuncu satırlarını okuyabilir). Bu yüzden bu dalda
    -- token TAZELENMEZ — tazelenseydi başkasının guest_id'sini yazan biri o
    -- misafirin satırını ele geçirebilirdi. İstemci her katılmada yeni bir
    -- guest_id ürettiği için bu dal normal akışta zaten tetiklenmez.
    if exists (
      select 1 from public.conquest_players
       where room_id = p_room_id
         and guest_id = btrim(p_guest_id)
    ) then
      raise exception 'already_in_room' using errcode = 'P0001';
    end if;
  end if;

  -- Host kendi odasını kurarken satır 'waiting' olarak yeni yazılmıştır; bu
  -- dal onu da doğal olarak kapsar.
  if v_room.status = 'playing' then
    raise exception 'room_in_progress' using errcode = 'P0001';
  end if;
  if v_room.status <> 'waiting' then
    raise exception 'room_unavailable' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from public.conquest_players
   where room_id = p_room_id;

  if v_count >= coalesce(v_room.max_players, 4) then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  -- Renk: istenen renk boş/alınmışsa paletten ilk boş renk.
  v_color := p_color;
  if v_color is null
     or v_color <> all(v_palette)
     or exists (
          select 1 from public.conquest_players
           where room_id = p_room_id and color = v_color
        )
  then
    -- `with ordinality` + `order by` KASITLI: filtresiz bir unnest'in satır
    -- sırası SQL'de garanti DEĞİLDİR. Paletteki sıra istemcideki
    -- CONQUEST_COLOR_PALETTE ile aynı olmalı ki iki taraf aynı rengi beklesin.
    select p.c into v_color
      from unnest(v_palette) with ordinality as p(c, ord)
     where not exists (
             select 1 from public.conquest_players
              where room_id = p_room_id and color = p.c
           )
     order by p.ord
     limit 1;
    v_color := coalesce(v_color, v_palette[1]);
  end if;

  insert into public.conquest_players (
    id, room_id, profile_id, guest_id, name, is_host, color
  ) values (
    v_id, p_room_id, p_profile_id, p_guest_id, p_name, p_is_host, v_color
  )
  returning * into v_player;

  insert into public.conquest_player_claims (player_id, claim_token)
  values (v_player.id, p_claim_token);

  -- Public liste için tazelik sinyali. Trigger updated_at'i now()'a çekecek.
  update public.conquest_rooms set updated_at = now() where id = p_room_id;

  return v_player;
end;
$$;

revoke all     on function public.conquest_register_player(uuid, uuid, uuid, text, text, text, boolean, uuid) from public;
grant  execute on function public.conquest_register_player(uuid, uuid, uuid, text, text, text, boolean, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- A6) realtime.messages — kanal dinleme politikası
-- ----------------------------------------------------------------------------
-- Private broadcast kanalına abone olabilmek için `realtime.messages` üstünde
-- SELECT policy'si gerekir. Konu adı `conquest:<uuid>` olduğu için abone
-- olmak room_id'yi BİLMEYİ gerektirir; UUID tahmin edilemez, dolayısıyla bu
-- politika enumerasyon yolu AÇMAZ. Kaldı ki kanal veri değil sinyal taşır.
--
-- Bu blok hata verirse migration DURMAZ: `realtime` şeması Supabase tarafından
-- yönetilir ve sürüme göre yetki farkı olabilir. Politika kurulamazsa misafir
-- yoklama (polling) yedeğiyle çalışmaya devam eder; operatöre UYARI bırakılır.
-- ────────────────────────────────────────────────────────────────────────────

do $rls$
begin
  if to_regclass('realtime.messages') is null then
    raise warning
      'realtime.messages bulunamadı — Kuşatma misafir kanalı kurulamadı. Misafir yoklama yedeğiyle çalışır.';
    return;
  end if;

  begin
    execute 'drop policy if exists "conquest_broadcast_listen" on realtime.messages';
    execute $p$
      create policy "conquest_broadcast_listen"
        on realtime.messages
        for select
        to anon, authenticated
        using (
          extension = 'broadcast'
          and realtime.topic() like 'conquest:%'
        )
    $p$;
  exception when others then
    raise warning
      'realtime.messages policy oluşturulamadı (%). Kuşatma misafiri yoklama yedeğiyle çalışır; politikayı Studio''dan elle ekleyebilirsiniz.',
      sqlerrm;
  end;
end
$rls$;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ BÖLÜM B — HOST DEVRİ: misafir host olamaz                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ORTAK KURAL (dört modda birebir aynı):
--   Host adayı sorgusuna `profile_id is not null` eklenir. Misafir satırları
--   (profile_id NULL + guest_id dolu) aday havuzuna GİRMEZ. Kayıtlı aday
--   yoksa oda GÜVENLİ ŞEKİLDE KAPATILIR — hostsuz/hayalet oda kalmaz.
--
-- BAĞLANTI KOPMASI ETKİLENMEZ: bu fonksiyonlar YALNIZ kullanıcı bilinçli
-- olarak "Odadan Ayrıl" dediğinde çağrılır. Geçici kopma yolu ayrıdır
-- (heartbeat / last_seen_at temizliği) ve bu migration ona DOKUNMAZ.


-- ────────────────────────────────────────────────────────────────────────────
-- B1) conquest_leave_room
-- ----------------------------------------------------------------------------
-- 20260627120000'deki gövdenin aynısı; TEK fark host adayı filtresi ve
-- kayıtlı aday bulunamadığında odanın kapatılması.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.conquest_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_is_host         boolean;
  v_remaining_count int;
  v_new_host        record;
begin
  if not public.conquest_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select is_host into v_is_host
    from public.conquest_players
   where id = p_player_id and room_id = p_room_id;

  if v_is_host is null then
    return; -- zaten yok / yanlış oda → no-op
  end if;

  delete from public.conquest_players where id = p_player_id;

  select count(*) into v_remaining_count
    from public.conquest_players
   where room_id = p_room_id;

  if v_remaining_count = 0 then
    -- Son oyuncu da çıktı → oda kapanır.
    update public.conquest_rooms
       set status      = 'closed',
           finished_at = now()
     where id = p_room_id;
    return;
  end if;

  if v_is_host then
    -- Host devri: en eski joined_at sahibi KAYITLI oyuncu yeni host olur.
    -- MİSAFİR ADAY DEĞİLDİR (profile_id is not null) — misafir oda ayarlarını
    -- yönetemez, oyunu başlatamaz, oyuncu atamaz.
    select id, name
      into v_new_host
      from public.conquest_players
     where room_id = p_room_id
       and profile_id is not null
     order by joined_at asc
     limit 1;

    if v_new_host.id is not null then
      update public.conquest_players
         set is_host = true
       where id = v_new_host.id;

      update public.conquest_rooms
         set host_player_id = v_new_host.id,
             host_name      = v_new_host.name
       where id = p_room_id;
    else
      -- Odada yalnız misafir kaldı → host'luk misafire VERİLMEZ, oda kapanır.
      -- Kalan misafirler realtime ile status='closed' görür ve
      -- "Oda sahibi ayrıldığı için oda kapatıldı." mesajıyla menüye döner.
      update public.conquest_rooms
         set status      = 'closed',
             finished_at = now()
       where id = p_room_id;
    end if;
  end if;
end;
$$;

revoke all     on function public.conquest_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.conquest_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- B2) wheel_group_leave_room
-- ----------------------------------------------------------------------------
-- 20260601120000'deki gövdenin aynısı; TEK fark host adayı filtresi.
-- Kayıtlı aday yoksa oda tamamen silinir (cascade players + claims) — kalan
-- misafirler rooms DELETE realtime olayıyla "oda kapatıldı" görür.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_group_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room        public.wheel_group_rooms;
  v_is_host     boolean;
  v_new_host_id uuid;
begin
  if not public.wheel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.wheel_group_rooms where id = p_room_id for update;

  if v_room.id is null then
    return;  -- oda yok → idempotent no-op
  end if;

  if not exists (
    select 1 from public.wheel_group_players
     where id = p_player_id and room_id = p_room_id
  ) then
    return;  -- bu odada değil → idempotent no-op
  end if;

  v_is_host := (v_room.host_player_id = p_player_id);

  if v_is_host then
    -- En eski joined_at'e sahip BAŞKA KAYITLI oyuncu (misafir aday değildir).
    select id into v_new_host_id
      from public.wheel_group_players
     where room_id = p_room_id
       and id <> p_player_id
       and profile_id is not null
     order by joined_at asc
     limit 1;

    if v_new_host_id is not null then
      update public.wheel_group_rooms
         set host_player_id = v_new_host_id
       where id = p_room_id;

      delete from public.wheel_group_players
       where id = p_player_id
         and room_id = p_room_id;
    else
      -- Yalnız host, VEYA yalnız misafirler kaldı → oda tamamen silinir.
      delete from public.wheel_group_rooms where id = p_room_id;
    end if;
  else
    delete from public.wheel_group_players
     where id = p_player_id
       and room_id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.wheel_group_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_group_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- B3) duel_group_leave_room
-- ----------------------------------------------------------------------------
-- 20260608120000'deki gövdenin aynısı; TEK fark host adayı filtresi.
-- (Bu modda host kavramı duel_group_players.is_host kolonundadır.)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.duel_group_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room        public.duel_group_rooms;
  v_is_host     boolean;
  v_new_host_id uuid;
begin
  if not public.duel_group_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.duel_group_rooms where id = p_room_id for update;
  if v_room.id is null then
    return;  -- oda yok → idempotent no-op
  end if;

  select is_host into v_is_host
    from public.duel_group_players
   where id = p_player_id and room_id = p_room_id;

  if v_is_host is null then
    return;  -- bu odada değil → idempotent no-op
  end if;

  if v_is_host then
    -- En eski joined_at'e sahip BAŞKA KAYITLI oyuncu (misafir aday değildir).
    select id into v_new_host_id
      from public.duel_group_players
     where room_id = p_room_id
       and id <> p_player_id
       and profile_id is not null
     order by joined_at asc
     limit 1;

    if v_new_host_id is not null then
      update public.duel_group_players
         set is_host      = true,
             last_seen_at = now()
       where id = v_new_host_id
         and room_id = p_room_id;

      delete from public.duel_group_players
       where id = p_player_id
         and room_id = p_room_id;
    else
      -- Yalnız host, VEYA yalnız misafirler kaldı → oda tamamen silinir.
      delete from public.duel_group_rooms where id = p_room_id;
    end if;
  else
    delete from public.duel_group_players
     where id = p_player_id
       and room_id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.duel_group_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.duel_group_leave_room(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- B4) tevatur_leave_room (Kör Nokta)
-- ----------------------------------------------------------------------------
-- 20260711120000'deki gövdenin aynısı; TEK fark host adayı filtresi.
--
-- Bu mod misafire 20260809120000 ile AÇILDI; o migration `tevatur_players`a
-- guest_id ekleyip profile_id'yi nullable yaptı. Host devri sorgusu o
-- değişiklikten SONRA misafiri aday olarak görmeye başladı — bu blok o
-- boşluğu kapatır.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_leave_room(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room        public.tevatur_rooms;
  v_is_host     boolean;
  v_new_host_id uuid;
begin
  if not public.tevatur_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.tevatur_rooms where id = p_room_id for update;

  if v_room.id is null then
    return;  -- oda yok → idempotent no-op
  end if;

  if not exists (
    select 1 from public.tevatur_players
     where id = p_player_id and room_id = p_room_id
  ) then
    return;  -- bu odada değil → idempotent no-op
  end if;

  v_is_host := (v_room.host_player_id = p_player_id);

  if v_is_host then
    -- En eski joined_at'e sahip BAŞKA KAYITLI oyuncu (misafir aday değildir).
    select id into v_new_host_id
      from public.tevatur_players
     where room_id = p_room_id
       and id <> p_player_id
       and profile_id is not null
     order by joined_at asc
     limit 1;

    if v_new_host_id is not null then
      update public.tevatur_rooms
         set host_player_id = v_new_host_id
       where id = p_room_id;

      delete from public.tevatur_players
       where id = p_player_id
         and room_id = p_room_id;
    else
      -- Yalnız host, VEYA yalnız misafirler kaldı → oda tamamen silinir
      -- (cascade players + claims). Kalan misafirler rooms DELETE realtime
      -- olayıyla "Oda sahibi ayrıldığı için oda kapatıldı." görür.
      delete from public.tevatur_rooms where id = p_room_id;
    end if;
  else
    delete from public.tevatur_players
     where id = p_player_id
       and room_id = p_room_id;
  end if;
end;
$$;

revoke all     on function public.tevatur_leave_room(uuid, uuid, uuid) from public;
grant  execute on function public.tevatur_leave_room(uuid, uuid, uuid) to anon;
grant  execute on function public.tevatur_leave_room(uuid, uuid, uuid) to authenticated;


-- ============================================================================
-- DOĞRULAMA (Supabase Studio → SQL Editor)
-- ============================================================================
--
-- A) Kuşatma tablolarında anon policy KALMAMALI:
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('conquest_rooms','conquest_players')
--    order by tablename, cmd;
--   -- Beklenen: SELECT policy'lerinin roles sütunu {authenticated}.
--   --           Hiçbir satırda 'anon' GEÇMEMELİ.
--
-- B) anon tablo GRANT'i KALMAMALI:
--   select table_name, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('conquest_rooms','conquest_players')
--      and grantee = 'anon';
--   -- Beklenen: 0 satır.
--
-- C) anon anahtarıyla (curl / istemci — Studio DEĞİL):
--   GET /rest/v1/conquest_rooms?select=*                      → boş / 401-403
--   GET /rest/v1/conquest_rooms?visibility=eq.public          → boş / 401-403
--   GET /rest/v1/conquest_players?select=room_id              → boş / 401-403
--   POST /rest/v1/rpc/conquest_list_public_rooms              → 42501 auth_required
--   POST /rest/v1/rpc/conquest_find_room_by_code {"p_code":"<KOD>"}  → TEK satır
--
-- D) Misafir kendi odasını okuyabiliyor, BAŞKASINI okuyamıyor:
--   select public.conquest_get_room_state('<KENDI_ODA>', '<PLAYER>', '<TOKEN>');
--   -- Beklenen: {"ok": true, "room": {...}, "players": [...]}
--   select public.conquest_get_room_state('<BASKA_ODA>', '<PLAYER>', '<TOKEN>');
--   -- Beklenen: {"ok": false, "reason": "not_a_member"}
--   select public.conquest_get_room_state('<KENDI_ODA>', '<PLAYER>', gen_random_uuid());
--   -- Beklenen: {"ok": false, "reason": "not_a_member"}  (yanlış token)
--
-- E) Yayın tetikleyicileri kurulu:
--   select tgname, tgrelid::regclass
--     from pg_trigger
--    where tgname in ('conquest_rooms_broadcast_signal','conquest_players_broadcast_signal');
--   -- Beklenen: 2 satır.
--
--   select policyname from pg_policies
--    where schemaname = 'realtime' and tablename = 'messages';
--   -- Beklenen: "conquest_broadcast_listen" listede. YOKSA migration
--   -- çıktısındaki WARNING'e bakın — misafir yoklama yedeğiyle çalışır.
--
-- F) Misafir HİÇBİR modda host adayı DEĞİL (statik kanıt):
--   select p.proname
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('conquest_leave_room','wheel_group_leave_room',
--                        'duel_group_leave_room','tevatur_leave_room')
--      and p.prosrc not like '%profile_id is not null%';
--   -- Beklenen: 0 satır (dördünde de filtre var).
--
-- G) Canlı senaryo — kayıtlı host ayrılır, odada yalnız misafir kalır:
--   -- 1. Kayıtlı kullanıcı oda kursun, misafir oda koduyla katılsın.
--   -- 2. select public.conquest_leave_room('<ODA>', '<HOST_PLAYER>', '<HOST_TOKEN>');
--   -- 3. select status, host_player_id from public.conquest_rooms where id = '<ODA>';
--   --    Beklenen: status = 'closed'.
--   -- 4. Misafirin host olmadığını doğrula:
--   --    select id, is_host, profile_id, guest_id from public.conquest_players
--   --     where room_id = '<ODA>';
--   --    Beklenen: is_host = false olan yalnız misafir satırı.
-- ============================================================================
