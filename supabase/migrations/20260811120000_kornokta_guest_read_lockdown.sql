-- ============================================================================
-- KÖR NOKTA (tevatur_*) — ham anon tablo okumasının kapatılması
-- ============================================================================
-- ÜRÜN KURALI (20260808120000 + 20260809120000 + 20260810120000'in devamı)
-- -------------------------------------------------------------------------
--   KAYITLI oyuncu : Kör Nokta odası kurar, HOST olabilir, XP/altın/görev
--                    kazanır.
--   MİSAFİR oyuncu : YALNIZ bildiği oda koduyla / davet bağlantısıyla BELİRLİ
--                    bir odaya katılır. Oda listesi göremez, başka odaların
--                    varlığını ya da oyuncularını ÖĞRENEMEZ, oda kuramaz,
--                    HOST OLAMAZ, kalıcı ilerleme yazamaz.
--
--
-- NEDEN GEREKLİ
-- -------------
-- 20260809120000 Kör Nokta'yı misafire açtı (şema hizalaması: profile_id XOR
-- guest_id + claim_token). Ancak `tevatur_rooms` / `tevatur_players`
-- tablolarının SELECT policy'si 20260711120000'den beri
--
--     for select to anon, authenticated using (true)
--
-- durumundaydı. Kör Nokta'da KULLANICI ARAYÜZÜNDE oda tarayıcısı yoktur —
-- ama güvenlik arayüzün yokluğuna dayanamaz. anon anahtarıyla doğrudan
--
--     GET /rest/v1/tevatur_rooms?select=code,status&order=created_at.desc
--     GET /rest/v1/tevatur_players?select=room_id,name
--
-- diyen biri BÜTÜN Kör Nokta odalarını, oda kodlarını ve oyuncu adlarını
-- listeleyebiliyordu. Oda kodları listelenebildiği an "yalnız bildiğin odaya
-- katılırsın" kuralı da anlamını yitirir: kod artık sır değildir.
--
-- Bu migration o kapıyı kapatır. Kuşatma için 20260810120000'de kurulan
-- desenin BİREBİR aynısı uygulanır — yeni bir güvenlik modeli icat edilmez.
--
--
-- SEÇİLEN YAKLAŞIM: claim-token'lı RPC + sinyal yayını (broadcast)
-- ---------------------------------------------------------------
-- Supabase Anonymous Auth ALTERNATİFİ YİNE SEÇİLMEDİ; gerekçe 20260810120000
-- başlığında ayrıntılı yazılıdır (özet: Anonymous Auth kullanıcısı Postgres'te
-- `authenticated` rolünde çalışır ve bu projede "misafir yapamaz" kuralının
-- TAMAMI `to authenticated` grant'iyle ifade edilmiştir; tek gözden kaçan
-- grant sessiz yetki yükseltmesidir). Misafir `anon` rolünde BIRAKILIR,
-- kanıtı `tevatur_player_claims.claim_token` olarak kalır.
--
-- MİSAFİR ARTIK KENDİ ODASINI NASIL OKUR:
--   `tevatur_get_room_state(room_id, player_id, claim_token)` — üyeliği
--   kanıtlanmış TEK bir odanın satırını + oyuncularını döndürür. Filtre,
--   limit, order, arama parametresi YOKTUR; başka room_id verilirse
--   `not_a_member` döner.
--
-- CANLI GÜNCELLEME:
--   `postgres_changes` RLS'e bağlıdır; anon SELECT kapanınca misafir için
--   olay akışı durur. Yerine odaya özel private broadcast kanalı
--   (`kornokta:<room_id>`) kullanılır. Kanal VERİ TAŞIMAZ — yalnız "bu odada
--   bir şey değişti" sinyali gider; istemci veriyi HER ZAMAN yetkili RPC'den
--   okur. Oyuncu adı, takım, köstebek/dedektif rolü, rapor, cevap, tahmin ve
--   claim_token sinyal yüküne GİRMEZ. Kanal politikası yanlış kurulsa bile
--   oda verisi sızmaz; en kötü ihtimalle sinyal düşer ve istemci yoklama
--   (polling) yedeğiyle devam eder.
--
--
-- BU MIGRATION NEYİ DEĞİŞTİRMEZ
-- -----------------------------
--   • KAYITLI kullanıcının davranışı: policy'si hâlâ `using (true)`, yani
--     `postgres_changes` aboneliği ve mevcut akış AYNEN çalışır.
--   • Yazma yolları: tüm tevatur_* RPC'leri (join/leave/kick/settings/
--     start_game/advance_phase/submit_*) DOKUNULMADAN kalır.
--   • Host kuralları: 20260810120000'deki "misafir host olamaz" düzeltmesi
--     (tevatur_leave_room) korunur — bu dosya o fonksiyona dokunmaz.
--   • Oda kodu çözümleyici: `resolve_torble_room_code` SECURITY DEFINER'dır,
--     tabloyu tanım sahibi yetkisiyle okur → anon SELECT kapanmasından
--     ETKİLENMEZ. Tek kod alır, tek eşleşme döndürür; liste vermez.
--   • Lobi sohbeti: `duel_messages` ayrı bir tablodur, bu dosyanın kapsamı
--     dışındadır.
--
--
-- BAĞIMLILIK — SIRA ÖNEMLİ
-- ------------------------
--   20260711120000_tevatur_init.sql                    (tevatur_* tabloları)
--   20260713120000_kornokta_gameplay.sql               (tevatur_rooms.game_state)
--   20260714120000_kornokta_teams_schema.sql           (players.team)
--   20260809120000_guest_browse_gate_and_kornokta.sql  (misafir authorize + guest_id)
--   20260810120000_conquest_guest_read_lockdown_and_host_rules.sql
--
-- Bu dosya 20260810120000'DEN SONRA çalıştırılmalıdır.
--
-- IDEMPOTENT: create or replace / if not exists / drop … if exists →
-- tekrar çalıştırılabilir. Veri SİLMEZ, tablo DÜŞÜRMEZ, aktif odalara
-- dokunmaz. Hata hâlinde tek transaction olarak geri alınır.
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
  if to_regclass('public.tevatur_rooms') is null then
    v_missing := v_missing || 'public.tevatur_rooms  [20260711120000]';
  end if;
  if to_regclass('public.tevatur_players') is null then
    v_missing := v_missing || 'public.tevatur_players  [20260711120000]';
  end if;

  -- Üyelik kanıtının TEK kaynağı. Misafir dalını (profile_id IS NULL +
  -- claim_token) tanıyan sürümü 20260809120000 kurar.
  if to_regprocedure('public.tevatur_authorize_player(uuid,uuid)') is null then
    v_missing := v_missing || 'public.tevatur_authorize_player(uuid,uuid)  [20260711120000 + 20260809120000]';
  end if;

  -- Misafir/kayıtlı ayrımı bu kolona dayanır. Yoksa 20260809120000
  -- uygulanmamıştır → misafir Kör Nokta'ya zaten katılamaz, bu kilit de
  -- yanlış varsayımlar üzerine kurulur.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'tevatur_players'
       and column_name  = 'guest_id'
  ) then
    v_missing := v_missing || 'public.tevatur_players.guest_id  [20260809120000]';
  end if;

  -- game_state olmadan oyun durumu okunamaz; RPC anlamsız olurdu.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'tevatur_rooms'
       and column_name  = 'game_state'
  ) then
    v_missing := v_missing || 'public.tevatur_rooms.game_state  [20260713120000]';
  end if;

  -- Kuşatma kilidi bu dosyadan ÖNCE gelmeli: aynı deseni paylaşırlar ve
  -- realtime.messages politikası orada kurulur. Eksikse sıra bozulmuş
  -- demektir.
  if to_regprocedure('public.conquest_get_room_state(uuid,uuid,uuid)') is null then
    v_missing := v_missing || 'public.conquest_get_room_state(uuid,uuid,uuid)  [20260810120000]';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception
      'ÖN KOŞUL EKSİK — bu migration çalıştırılamaz. Eksik nesneler: %. Önce ilgili migration(lar)ı uygula.',
      array_to_string(v_missing, ' | ');
  end if;
end
$pre$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) tevatur_rooms — SELECT yalnız `authenticated`
-- ----------------------------------------------------------------------------
-- ÖNCESİ: `to anon, authenticated using (true)` → anon anahtarı olan herkes
--         tüm Kör Nokta oda tablosunu filtreleyip sıralayabiliyordu.
-- SONRASI: policy YALNIZ `authenticated` rolüne verilir. anon için POLICY
--          YOKTUR → RLS varsayılanı reddetmektir.
--
-- İKİ KATMAN (kasıtlı):
--   (1) Policy — anon'a policy tanımlanmaz.
--   (2) GRANT  — tablo SELECT yetkisi anon'dan geri alınır. Supabase yeni
--       tablolara varsayılan olarak anon+authenticated grant'i verir; policy
--       ileride yanlışlıkla genişletilse bile grant ayakta kalır (ve tersi).
--
-- KAYITLI kullanıcı için "gereksiz genel SELECT" mi kalıyor? Kör Nokta'da
-- kayıtlı kullanıcıya da oda TARAYICISI SUNULMAZ; ancak `using (true)`
-- policy'si KASTEN korunur, çünkü `postgres_changes` aboneliği satır
-- yetkisini RLS'e sorar ve kayıtlı kullanıcının mevcut canlı akışı buna
-- bağlıdır. Bunu daraltmak (örn. "yalnız üye olduğun oda") kayıtlı
-- kullanıcının realtime akışını da kapatır ve bu görevin kapsamı dışındaki
-- bir yeniden yazımı gerektirirdi. Enumerasyon riski `anon` tarafındadır ve
-- bu dosya orayı kapatır; `authenticated` tarafı hesap açmayı ve JWT
-- taşımayı gerektirir (kimliklendirilebilir, oran-sınırlanabilir).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.tevatur_rooms   enable row level security;
alter table public.tevatur_players enable row level security;

drop policy if exists "tevatur_rooms_select_public" on public.tevatur_rooms;
drop policy if exists "tevatur_rooms_select_auth"   on public.tevatur_rooms;

create policy "tevatur_rooms_select_auth"
  on public.tevatur_rooms
  for select
  to authenticated
  using (true);

revoke select on table public.tevatur_rooms from anon;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) tevatur_players — SELECT yalnız `authenticated`
-- ----------------------------------------------------------------------------
-- Oda tablosunu kapatıp oyuncu tablosunu açık bırakmak işe yaramaz: oyuncu
-- tablosu room_id'leri ve oyuncu adlarını olduğu gibi verir, oradan oda
-- kümesi türetilebilir. İkisi birlikte kapatılır.
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists "tevatur_players_select_public" on public.tevatur_players;
drop policy if exists "tevatur_players_select_auth"   on public.tevatur_players;

create policy "tevatur_players_select_auth"
  on public.tevatur_players
  for select
  to authenticated
  using (true);

revoke select on table public.tevatur_players from anon;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) Süpürücü — anon'a açık ARTIK policy kalmasın
-- ----------------------------------------------------------------------------
-- Studio'dan elle eklenmiş ya da eski migration'lardan artakalmış bir policy
-- tek başına kilidi delebilir (policy'ler OR semantiğiyle birleşir). Bu blok
-- iki tabloda `anon` rolüne dokunan HER policy'yi kaldırır.
--
-- NOT: `roles` dizisi boş/`{public}` olan policy'ler de anon'u kapsar — onlar
-- da temizlenir. Yalnız `{authenticated}` olanlar korunur.
-- ────────────────────────────────────────────────────────────────────────────

do $sweep$
declare
  pol record;
begin
  for pol in
    select tablename, policyname, roles
      from pg_policies
     where schemaname = 'public'
       and tablename in ('tevatur_rooms', 'tevatur_players')
       and (
            'anon'   = any(roles)
         or 'public' = any(roles)
         or roles is null
         or cardinality(roles) = 0
       )
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, pol.tablename);
    raise notice 'anon/public policy kaldırıldı: %.% (roles=%)',
      pol.tablename, pol.policyname, pol.roles;
  end loop;
end
$sweep$;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) tevatur_get_room_state — misafirin TEK okuma yolu
-- ----------------------------------------------------------------------------
-- Misafir kendi odasının lobi + oyun durumunu YALNIZ buradan okur.
--
-- NEDEN ENUMERASYONA KAPALI:
--   • p_room_id ZORUNLU ve tektir — filtre/limit/order/arama parametresi
--     yoktur. Bir çağrı = bir oda.
--   • Dönmeden önce çağıranın O ODADAKİ bir oyuncu satırının sahibi olduğu
--     kanıtlanır (`tevatur_authorize_player` + `room_id` eşleşmesi). Yani
--     başka bir odadaki geçerli claim_token bu odayı AÇMAZ.
--   • Başka bir room_id verilirse `not_a_member` döner — odanın var olup
--     olmadığı bilgisi SIZMAZ: var olmayan oda ile üye olunmayan oda AYNI
--     cevabı verir ("room_gone" yalnız üyeliği kanıtlanmış çağırana, odanın
--     yarış durumunda silinmiş olması hâlinde döner).
--   • Oda KODUNU bilmek tek başına yetmez: kodla oyuncu listesi okunamaz,
--     önce `tevatur_join_room` ile gerçekten katılmak gerekir.
--
-- NE DÖNMEZ:
--   • claim_token — `tevatur_player_claims` bu sorguya hiç girmez.
--   • guest_id    — misafir oturum kimliği yalnız sunucunun iç ayrımıdır;
--                   istemcinin hiçbir yerinde kullanılmaz, o yüzden yükte
--                   yeri yoktur. (Kolonlar TEK TEK sayılır; `to_jsonb(p)`
--                   KASTEN kullanılmaz ki ileride eklenecek bir kolon
--                   sessizce dışarı sızmasın.)
--
-- Oda satırı olduğu gibi döner: bugün `postgres_changes` üzerinden zaten her
-- üyeye giden içeriğin aynısıdır (rol/köstebek dağılımı da dahil olmak üzere
-- oyun durumu `game_state` içindedir ve kimin ne göreceğine o blob'u yazan
-- gameplay RPC'leri karar verir — bu dosya o kararı DEĞİŞTİRMEZ).
--
-- Kayıtlı kullanıcı da bu RPC'yi çağırabilir (aynı kontroller geçerlidir);
-- istemci tek okuma yolu kullansın diye grant her iki role verilir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_get_room_state(
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
  v_room    public.tevatur_rooms;
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
      from public.tevatur_players p
     where p.id      = p_player_id
       and p.room_id = p_room_id
       and public.tevatur_authorize_player(p_player_id, p_claim_token)
  ) into v_member;

  if not coalesce(v_member, false) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;

  select * into v_room from public.tevatur_rooms where id = p_room_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'room_gone');
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',           p.id,
               'room_id',      p.room_id,
               'profile_id',   p.profile_id,   -- NULL → "Misafir" etiketi
               'name',         p.name,
               'score',        p.score,
               'team',         p.team,
               'joined_at',    p.joined_at,
               'last_seen_at', p.last_seen_at
             )
             order by p.joined_at asc
           ),
           '[]'::jsonb
         )
    into v_players
    from public.tevatur_players p
   where p.room_id = p_room_id;

  return jsonb_build_object(
    'ok',      true,
    'room',    to_jsonb(v_room),
    'players', v_players
  );
end
$$;

revoke all     on function public.tevatur_get_room_state(uuid, uuid, uuid) from public;
grant  execute on function public.tevatur_get_room_state(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) Canlı güncelleme — odaya özel SİNYAL yayını
-- ----------------------------------------------------------------------------
-- `postgres_changes` aboneliği RLS'e bağlıdır: Realtime her aboneye satırı
-- görme yetkisi olup olmadığını sorar. 1/2 ile anon SELECT kapandığı için
-- misafirin postgres_changes aboneliği ARTIK OLAY ALMAZ. (Kayıtlı kullanıcı
-- etkilenmez — onun policy'si duruyor.)
--
-- Yerine: her yazma `kornokta:<room_id>` private broadcast konusuna bir
-- SİNYAL gönderir. İstemci sinyali alınca veriyi 4'teki yetkili RPC'den okur.
--
-- NEDEN SATIR VERİSİ TAŞIMIYORUZ:
--   Broadcast'in yetkisi KONU (topic) düzeyindedir, satır düzeyinde değil.
--   Yükün içine oda satırını koysaydık, kanal politikasındaki herhangi bir
--   gevşeklik doğrudan veri sızıntısı olurdu. Sinyalde çağıranın abone olmak
--   için ZATEN bilmek zorunda olduğu room_id'den başka bir şey yoktur; gerçek
--   veri her zaman üyelik kanıtı isteyen RPC'den gelir.
--
--   Bu bilinçli olarak bir MALİYET içerir: misafir "odadan atıldım" ile "oda
--   kapandı" durumlarını artık ayırt edemez (ikisi de üyelik kaybıdır).
--   Ayırt etmek için ya oyuncu kimliğini sinyale koymak ya da RPC'nin oda
--   varlığını üye olmayanlara söylemesi gerekirdi — ikincisi doğrudan
--   enumerasyon sızıntısıdır. İstemci bu yüzden misafire ortak bir "oda
--   kapandı" bildirimi gösterir; kayıtlı kullanıcıda ayrım korunur.
--
-- İKİ SAVUNMA:
--   • Yayın çağrısı `exception when others then null` ile sarılıdır — yayın
--     altyapısı yoksa/bozuksa OYUN YAZMALARI BOZULMAZ, yalnız sinyal düşer.
--   • İstemcide yoklama (polling) yedeği vardır; sinyal hiç gelmese bile
--     misafirin ekranı donmaz (bkz. korNoktaRoomState.ts).
--
-- GÜRÜLTÜ KONTROLÜ: Kör Nokta'da istemci heartbeat'i YOKTUR, ama `updated_at`
-- birçok RPC tarafından tek başına dokunulur (örn. katılma sırasında oda
-- satırı tazelenir). Yalnız `updated_at` değiştiyse sinyal GÖNDERİLMEZ —
-- o olayın anlamlı karşılığı zaten oyuncu tablosundaki değişikliktir.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.tevatur_broadcast_room_signal()
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

  -- İÇ İÇE IF ZORUNLU (tek koşulda `TG_OP = 'UPDATE' and new.x …` YAZILAMAZ):
  -- PL/pgSQL bir IF koşulunu tek bir SQL ifadesi olarak çalıştırır ve `new`i
  -- parametre olarak bağlar. DELETE'te `new` atanmamıştır; kısa devre olsa
  -- bile bağlama aşamasında "record new is not assigned yet" hatası alınır.
  -- İç blok yalnız TG_OP='UPDATE' iken çalıştığı için `new` orada hep doludur.
  if TG_OP = 'UPDATE' then
    -- Oyun sırasındaki her yazma game_state'i değiştirir → UCUZ dal, önce o
    -- sınanır. Kolon adı SAYMAK yerine jsonb farkı alınır ki ileride eklenen
    -- bir kolon sessizce "sinyalsiz" kalmasın; game_state ise farktan
    -- ÇIKARILIR, çünkü büyük bir blob'u her satır için iki kez serialize
    -- etmek pahalıdır (bu dala yalnız game_state DEĞİŞMEDİĞİNDE girilir).
    if new.game_state is not distinct from old.game_state then
      if (to_jsonb(new) - 'updated_at' - 'game_state')
       = (to_jsonb(old) - 'updated_at' - 'game_state') then
        return null;   -- yalnız updated_at dokunulmuş → anlamsız
      end if;
    end if;
  end if;

  begin
    perform realtime.send(
      jsonb_build_object('room_id', v_room_id, 'op', TG_OP, 'src', 'rooms'),
      'kornokta_change',
      'kornokta:' || v_room_id::text,
      true            -- private kanal
    );
  exception when others then
    null;  -- Yayın hattı OYUNU ASLA BOZAMAZ.
  end;

  return null;   -- AFTER trigger → dönüş değeri yok sayılır
end
$$;

create or replace function public.tevatur_broadcast_player_signal()
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

  -- Oyuncu satırı küçüktür → jsonb farkı ucuzdur ve kolon listesi tutmaktan
  -- daha az kırılgandır. (`new` bağlama notu için room trigger'ına bakın.)
  if TG_OP = 'UPDATE' then
    if to_jsonb(new) - 'last_seen_at' = to_jsonb(old) - 'last_seen_at' then
      return null;
    end if;
  end if;

  begin
    perform realtime.send(
      jsonb_build_object('room_id', v_room_id, 'op', TG_OP, 'src', 'players'),
      'kornokta_change',
      'kornokta:' || v_room_id::text,
      true
    );
  exception when others then
    null;
  end;

  return null;
end
$$;

drop trigger if exists tevatur_rooms_broadcast_signal   on public.tevatur_rooms;
drop trigger if exists tevatur_players_broadcast_signal on public.tevatur_players;

create trigger tevatur_rooms_broadcast_signal
  after insert or update or delete on public.tevatur_rooms
  for each row execute function public.tevatur_broadcast_room_signal();

create trigger tevatur_players_broadcast_signal
  after insert or update or delete on public.tevatur_players
  for each row execute function public.tevatur_broadcast_player_signal();


-- ────────────────────────────────────────────────────────────────────────────
-- 6) realtime.messages — kanal dinleme politikası
-- ----------------------------------------------------------------------------
-- Private broadcast kanalına abone olabilmek için `realtime.messages` üstünde
-- SELECT policy'si gerekir. Konu adı `kornokta:<uuid>` olduğu için abone
-- olmak room_id'yi BİLMEYİ gerektirir; UUID tahmin edilemez, dolayısıyla bu
-- politika enumerasyon yolu AÇMAZ. Kaldı ki kanal veri değil sinyal taşır.
--
-- 20260810120000'deki `conquest_broadcast_listen` politikasıyla YAN YANA
-- yaşar (policy'ler OR'lanır); o dosyanınkine DOKUNULMAZ.
--
-- Bu blok hata verirse migration DURMAZ: `realtime` şeması Supabase
-- tarafından yönetilir ve sürüme göre yetki farkı olabilir. Politika
-- kurulamazsa misafir yoklama yedeğiyle çalışmaya devam eder; operatöre
-- UYARI bırakılır.
-- ────────────────────────────────────────────────────────────────────────────

do $rls$
begin
  if to_regclass('realtime.messages') is null then
    raise warning
      'realtime.messages bulunamadı — Kör Nokta misafir kanalı kurulamadı. Misafir yoklama yedeğiyle çalışır.';
    return;
  end if;

  begin
    execute 'drop policy if exists "kornokta_broadcast_listen" on realtime.messages';
    execute $p$
      create policy "kornokta_broadcast_listen"
        on realtime.messages
        for select
        to anon, authenticated
        using (
          extension = 'broadcast'
          and realtime.topic() like 'kornokta:%'
        )
    $p$;
  exception when others then
    raise warning
      'realtime.messages policy oluşturulamadı (%). Kör Nokta misafiri yoklama yedeğiyle çalışır; politikayı Studio''dan elle ekleyebilirsiniz.',
      sqlerrm;
  end;
end
$rls$;


-- ============================================================================
-- DOĞRULAMA (elle, Studio SQL Editor'da)
-- ----------------------------------------------------------------------------
--   -- 1) anon'a SELECT grant'i kalmadı mı? (0 satır beklenir)
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name  in ('tevatur_rooms','tevatur_players')
--      and grantee      = 'anon';
--
--   -- 2) anon'a açık policy kaldı mı? (0 satır beklenir)
--   select tablename, policyname, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('tevatur_rooms','tevatur_players')
--      and 'anon' = any(roles);
--
--   -- 3) Trigger'lar kurulu mu? (2 satır beklenir)
--   select tgname from pg_trigger
--    where tgname in ('tevatur_rooms_broadcast_signal','tevatur_players_broadcast_signal');
--
--   -- 4) Yetkisiz okuma reddediliyor mu? ({"ok":false,"reason":"not_a_member"})
--   select public.tevatur_get_room_state(
--            '00000000-0000-0000-0000-000000000000'::uuid,
--            '00000000-0000-0000-0000-000000000000'::uuid,
--            '00000000-0000-0000-0000-000000000000'::uuid);
--
--   -- 5) anon REST yolu (terminalden — 401/empty beklenir, satır DÖNMEMELİ)
--   --   curl "$SUPABASE_URL/rest/v1/tevatur_rooms?select=code" \
--   --        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
-- ============================================================================
