-- ════════════════════════════════════════════════════════════════════════════
-- 20260827140000_wheel_duel_quick_match_durable_identity.sql
--
-- P0 — ÇARK HIZLI EŞLEŞ KİMLİK ZİNCİRİ: KALICI SAHİPLİK + KİMLİĞE BÜRÜNME
--      KAPATMA  (TEK PARÇA / ATOMİK)
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ BU DOSYA BÖLÜNMEMELİDİR.
--   Kalıcı sahiplik (owners tablosu) ile kimlik bağlama korumaları AYNI
--   migration'da uygulanır. Sadece "kalıcı sahiplik" kısmı canlıya çıkarsa,
--   aşağıdaki açık KAPANMAK yerine KALICILAŞIR: saldırganın kurban üzerine
--   yazdığı sahiplik satırı silinmez hâle gelir. Bu yüzden iki taraf tek
--   transaction'da, tek dosyada uygulanır.
--   Uygulama: `supabase db push` (her dosyayı transaction içinde çalıştırır)
--   veya `psql -1 -v ON_ERROR_STOP=1 -f <bu dosya>`. Dosyanın sonundaki
--   doğrulama bloğu eksik/yarım durumda RAISE eder → transaction geri alınır.
--
-- ════════════════════════════════════════════════════════════════════════════
-- KAPATILAN İKİ AYRI KUSUR
-- ════════════════════════════════════════════════════════════════════════════
--
-- KUSUR A — "doğru ülkeye dokunulamıyor" (kullanılabilirlik)
-- ─────────────────────────────────────────────────────────
--   Çark Hızlı Eşleş oyuncu satırları KİMLİKSİZ doğuyor. CANLI VERİYLE
--   DOĞRULANDI (salt-okunur): son QM odalarındaki 11 oyuncu satırının
--   11'inde `profile_id IS NULL` VE `guest_id IS NULL` (oda-kodu odalarında
--   kolonlar normal şekilde dolu).
--
--   20260814180000'den sonra `wheel_duel_authorize_player`ın dalları QM'de:
--     1) profile_id = auth.uid()      → ASLA tutmaz (NULL)
--     2) claim_token (misafir dalı)   → YAPISAL OLARAK ÖLÜ
--        (`guest_id is not null` şartı eklendi; QM satırında guest_id NULL).
--        İstemcinin QM sonrası `wheel_duel_player_claims`e yazdığı token bu
--        yüzden ARTIK HİÇBİR ŞEYE YARAMAZ.
--     3) `wheel_duel_queue` köprüsü   → TEK yetki kaynağı
--
--   Yani yetki, MUTABLE bir kuyruk satırının hayatta kalmasına bağlıydı. O
--   satır silinince/üzerine yazılınca (yeni arama, cancel, reset) oyuncu KENDİ
--   AKTİF MAÇINDA yetkisiz kalıyor: doğru ülke "tıklanmıyor", yanlış ülkeler
--   çalışmaya devam ediyor (yanlış cevap tamamen lokal olduğu için).
--
-- KUSUR B — `player_id` KİMLİĞİNE BÜRÜNME (güvenlik, P0)
-- ──────────────────────────────────────────────────────
--   Aynı köprü:
--       exists (select 1 from wheel_duel_queue q
--                where q.player_id = p_player_id and q.profile_id = auth.uid())
--   `wheel_duel_quick_match` `p_player_id`yi ÇAĞIRANDAN alır ve
--   `wheel_duel_players` SELECT'i herkese açıktır (M1) → saldırgan kurbanın
--   player_id'sini OKUYABİLİR. Kendi hesabıyla Hızlı Eşleş'i KURBANIN
--   player_id'siyle çağırınca kuyruk satırı {profile_id: saldırgan,
--   player_id: kurban} olur ve köprü onu KURBAN ADINA yetkilendirir.
--
--   CLEAN-ROOM'DA (gerçek Postgres) KANITLANDI:
--       attack_code = authorize:true | claim_target:true
--       attack_qm   = authorize:true | claim_target:true
--   Saldırgan yalnız yetki almıyor; kurbanın odasında hedefi FİİLEN kapıyor
--   ve aynı yetkiyle `wheel_duel_leave_room` çağırıp kurbanın maçını
--   düşürebiliyor.
--
-- ════════════════════════════════════════════════════════════════════════════
-- NEDEN `wheel_duel_quick_match` DÜZELTİLMİYOR
-- ────────────────────────────────────────────
--   Gövdesi REPODA YOK (Studio döneminde yazıldı; 20260530120000 bunu açıkça
--   not eder). Görmediğimiz bir gövdeyi `create or replace` ile değiştirmek
--   Hızlı Eşleş'i tümden bozabilir. Bu yüzden güvenlik, o gövdenin
--   DAVRANIŞINDAN BAĞIMSIZ kurulur:
--     • Kuyruk satırı yazımına DOKUNULMAZ (trigger'da RAISE YOK) → RPC ne
--       yaparsa yapsın Hızlı Eşleş çalışmaya devam eder.
--     • Kuyruk satırı artık YETKİ KANITI DEĞİLDİR.
--     • Yetki, DEĞİŞTİRİLEMEZ ve İLK-GELEN kalıcı sahiplik kaydına bağlanır.
--   Clean-room testi bunu QM'in HEM "p_player_id'yi doğrulayan" HEM
--   "doğrulamayan" modelinde sürer: saldırı İKİSİNDE DE düşer.
--
-- ════════════════════════════════════════════════════════════════════════════
-- KURULAN INVARIANT
-- ─────────────────
--   • `wheel_duel_quick_match_owners` SUNUCU-ÖZELDİR (policy yok + grant yok).
--   • Sahiplik DEĞİŞTİRİLEMEZ: ilk meşru sahip kalıcıdır.
--   • Sahiplik YALNIZ, o an var OLMAYAN bir player_id için doğar → kurbanın
--     MEVCUT oyuncu satırı ele geçirilemez.
--   • Oyuncu satırının KENDİ kimliği (profile_id / guest_id) her zaman sahiplik
--     kaydından ÜSTÜNDÜR.
--   • `wheel_duel_authorize_player` içinde MUTABLE kuyruk dalı YOKTUR.
--   • Çelişkili/ekilmiş sahiplik kayıtları temizlenir.
--   • Kayıtlı Hızlı Eşleş ÇALIŞMAYA DEVAM EDER; oda-kodu akışı DEĞİŞMEZ;
--     misafir Hızlı Eşleş DESTEKLENMEZ (zaten desteklenmiyordu — QM login
--     gerektirir).
--
-- NEDEN `wheel_duel_players.profile_id` DOLDURULMUYOR
-- ───────────────────────────────────────────────────
--   Daha "temiz" görünürdü ama DAVRANIŞ DEĞİŞTİRİRDİ: profile_id'yi okuyan
--   XP/gold/istatistik yolları bugün QM satırlarını kimliksiz görüyor. Onları
--   bir blocker düzeltmesinin içinde açmak kapsam dışıdır ve ödül dağıtımını
--   sessizce değiştirirdi. Ayrı tablo YALNIZ yetkilendirme için okunur.
--
-- BU MIGRATION'IN YAPMADIKLARI
-- ────────────────────────────
--   • `wheel_duel_quick_match` / `cancel_quick_match` gövdelerine DOKUNMAZ.
--   • Hiçbir fonksiyon/tablo DROP edilmez; imza / dönüş tipi / SECURITY
--     DEFINER / search_path / EXECUTE grant'ları DEĞİŞMEZ.
--   • `wheel_duel_players` şeması/satırları DEĞİŞMEZ; XP/gold yolu değişmez.
--   • `wheel_duel_queue` üzerindeki istemci YAZMA kilidi (20260814180000)
--     KORUNUR ve GEVŞETİLMEZ. Kuyruk SELECT'i (istemcinin kendi satırı +
--     realtime) DEĞİŞMEZ.
--   • Başka hiçbir moda (duel_*, flag_*, conquest_*, route_duel_*, tevatur_*)
--     dokunulmaz.
--
-- IDEMPOTENT: create table/trigger if not exists · create or replace ·
--             insert … on conflict do nothing · koşullu delete.
-- ÖN KOŞUL: 20260814180000 uygulanmış olmalı.
-- DEPLOY: PRODUCTION'A UYGULANMADI.
-- ════════════════════════════════════════════════════════════════════════════


-- ── ÖN KOŞUL ────────────────────────────────────────────────────────────────
do $$
declare v_col text;
begin
  if to_regclass('public.wheel_duel_queue') is null then
    raise exception 'wheel_duel_queue yok';
  end if;
  if to_regclass('public.wheel_duel_players') is null then
    raise exception 'wheel_duel_players yok';
  end if;
  if to_regprocedure('public.wheel_duel_authorize_player(uuid,uuid)') is null then
    raise exception 'wheel_duel_authorize_player yok — 20260814180000 uygulanmamış';
  end if;

  -- KOLON ÖN KOŞULU (20260814180000'in deseni). Bu migration'ın ilk canlı
  -- denemesi VARSAYILAN bir zaman kolonu yüzünden 42703 ile düştü: o kolon
  -- CANLIDA YOKTU ve şemanın gerçek hâli repoda yazılı değildi. Artık YALNIZ
  -- aşağıdaki kolonlar kullanılıyor ve varlıkları migration BAŞLAMADAN
  -- doğrulanıyor — eksikse temiz bir ön koşul hatası alınır, yarım uygulama
  -- olmaz.
  foreach v_col in array array['profile_id','player_id','matched_room_id'] loop
    if not exists (
      select 1 from pg_attribute
       where attrelid = to_regclass('public.wheel_duel_queue')
         and attname = v_col and attnum > 0 and not attisdropped
    ) then
      raise exception 'ÖN KOŞUL EKSİK: wheel_duel_queue.% kolonu yok', v_col;
    end if;
  end loop;
  foreach v_col in array array['id','room_id','profile_id','guest_id','joined_at'] loop
    if not exists (
      select 1 from pg_attribute
       where attrelid = to_regclass('public.wheel_duel_players')
         and attname = v_col and attnum > 0 and not attisdropped
    ) then
      raise exception 'ÖN KOŞUL EKSİK: wheel_duel_players.% kolonu yok', v_col;
    end if;
  end loop;
end $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Kalıcı sahiplik kaydı (SUNUCU-ÖZEL: policy YOK, grant YOK)
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.wheel_duel_quick_match_owners (
  player_id  uuid        primary key,
  profile_id uuid        not null,
  created_at timestamptz not null default now()
);

create index if not exists wheel_duel_qm_owners_profile_idx
  on public.wheel_duel_quick_match_owners (profile_id);

alter table public.wheel_duel_quick_match_owners enable row level security;
-- Politika bilerek TANIMLANMAZ → RLS altında istemci hiçbir satır göremez.
-- Grant'lar üç rolden de açıkça geri alınır (20260808 dersi: `from public`
-- tek başına, Supabase'in ALTER DEFAULT PRIVILEGES ile doğan DOĞRUDAN
-- anon/authenticated grant'ını KALDIRMAZ).
revoke all on table public.wheel_duel_quick_match_owners from public;
revoke all on table public.wheel_duel_quick_match_owners from anon;
revoke all on table public.wheel_duel_quick_match_owners from authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) Sahiplik trigger'ı — yalnız BAĞLANMAMIŞ, YENİ bir player_id'ye bağlanır
-- ----------------------------------------------------------------------------
-- Saldırı, VAR OLAN bir oyuncu satırının id'sine bağlanmayı gerektirir. Meşru
-- akış tam tersidir: istemci taze bir UUID üretir, kuyruğa girer, oyuncu satırı
-- ancak EŞLEŞME OLUŞUNCA doğar.
--
-- `p.joined_at < now()` ayrımı (SIRA-BAĞIMSIZ):
--   • now() = transaction_timestamp() → AYNI transaction'da kurulan satırlar
--     için joined_at = now()'dır ve karşılaştırma FALSE olur (izin verilir).
--     Böylece eşleşme anında oyuncu satırını ÖNCE yazan bir RPC de meşru
--     sahiplik üretebilir.
--   • ÖNCEKİ bir transaction'da kurulmuş satırlar için TRUE'dur (reddedilir).
-- → Görülmeyen `wheel_duel_quick_match` gövdesinin yazım SIRASINI bilmek
--   zorunda DEĞİLİZ. (Clean-room'da "önce oyuncu, sonra kuyruk" modeliyle de
--   doğrulandı.)
--
-- RAISE YOK: kuyruk yazımı asla başarısız olmaz → görülmeyen RPC gövdesi
-- kırılmaz. Reddedilen tek şey SAHİPLİK KANITININ DOĞMASIDIR.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public._wheel_duel_record_qm_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.player_id is null or new.profile_id is null then
    return new;
  end if;

  -- Zaten VAR OLAN (önceki transaction'da kurulmuş) bir oyuncu satırının
  -- id'sine sahiplik ASLA yazılmaz — kimliğe bürünmenin kalıcılaşma yolu.
  --
  -- TEK İSTİSNA (güvenli): satır, BU KUYRUK SATIRININ eşleştiği odanın
  -- üyesiyse ve kimlik olarak çelişmiyorsa. Bu, "RPC oyuncu satırını ayrı bir
  -- transaction'da yazıyorsa" ihtimaline karşı meşru QM'i korur.
  -- Neden sömürülemez: `matched_room_id`yi YALNIZ SECURITY DEFINER RPC yazar
  -- ve KENDİ kurduğu odayı gösterir; saldırgan onu kurbanın odasına
  -- çeviremez. `wheel_duel_leave_room` bu kolonu yalnız NULL'a çeker.
  if exists (
    select 1 from public.wheel_duel_players p
     where p.id = new.player_id
       and p.joined_at < now()
       and not (
            new.matched_room_id is not null
        and p.room_id = new.matched_room_id
        and p.guest_id is null
        and (p.profile_id is null or p.profile_id = new.profile_id)
       )
  ) then
    return new;
  end if;

  insert into public.wheel_duel_quick_match_owners (player_id, profile_id)
  values (new.player_id, new.profile_id)
  on conflict (player_id) do nothing;   -- İLK sahip kalıcıdır (devir yok)

  return new;
end;
$$;

drop trigger if exists wheel_duel_queue_record_owner on public.wheel_duel_queue;
create trigger wheel_duel_queue_record_owner
  after insert or update on public.wheel_duel_queue
  for each row execute function public._wheel_duel_record_qm_owner();


-- ────────────────────────────────────────────────────────────────────────────
-- 3) BACKFILL — deploy anındaki CANLI Hızlı Eşleş maçları kopmasın
-- ----------------------------------------------------------------------------
-- Kuyruk artık yetki kanıtı olmayacağı için (bkz. 5), deploy anında OYNANAN
-- maçların sahipliği bir kereliğine kuyruktan taşınmalıdır.
--
-- ⚠ "EN ESKİ KUYRUK SATIRI KAZANIR" FİKRİ TERK EDİLDİ — GÜVENLİ DEĞİLDİ.
--   İlk sürüm çekişmeyi zaman damgasına göre sıralayarak çözüyordu. İki
--   sorunu vardı:
--     a) Sıralamada kullanılan ikinci zaman kolonu CANLIDA YOKTU; üretim
--        denemesi 42703 (undefined column) ile düştü. Kuyruk tablosunun
--        gerçek şeması repoda yazılı olmadığı için o kolon VARSAYILMIŞTI.
--     b) Daha önemlisi: kuyruk satırının yaşı, satırın KENDİSİNİN
--        (profile_id anahtarlı) yaşıdır — PLAYER_ID BAĞININ yaşı değil.
--        `wheel_duel_quick_match` gövdesi repoda YOK; ON CONFLICT dalının o
--        damgayı tazeleyip tazelemediği BİLİNMİYOR. Tazelemiyorsa, önceden
--        kuyruğa girmiş bir saldırgan satırını sonradan kurbanın
--        player_id'sine çevirdiğinde ESKİ damgasını korur ve sıralamayı
--        KAZANIR. Yani sıralama, saldırganı SEÇEBİLİRDİ.
--
-- YENİ KURAL — SIRALAMAYA HİÇ DAYANMAZ. Bir kuyruk satırı ancak KENDİ İÇİNDE
-- TUTARLIYSA kanıt sayılır:
--   (1) player_id + profile_id dolu,
--   (2) matched_room_id dolu VE o oda hâlâ 'playing'  → yalnız CANLI maçlar,
--   (3) adı geçen oyuncu GERÇEKTEN o odanın üyesi (p.room_id = q.matched_room_id)
--       → ekilmiş satır burada düşer: saldırganın satırı ya matched_room_id
--         NULL'dur ya da KENDİ odasını gösterir; kurbanın oyuncusu o odanın
--         üyesi değildir. `matched_room_id`yi yalnız SECURITY DEFINER RPC
--         yazar, saldırgan onu kurbanın odasına çeviremez,
--   (4) oyuncu satırının KENDİ kimliği çelişmiyor (misafir değil; kayıtlıysa
--       aynı profil) → oyuncu kimliği kuyruk kanıtından ÜSTÜNDÜR,
--   (5) AYNI player_id'yi iddia eden BAŞKA kuyruk satırı YOK.
--
-- (5) ARIZADA-KAPANIR (fail-closed): çekişme zaten kurcalama işaretidir, çünkü
-- meşru akışta bir player_id'yi yalnız onu üreten istemci bilir. Çekişmeli
-- durumda hiçbir sahiplik yazılmaz; bedeli, o tek canlı maçın kalıcı yetkisini
-- alamamasıdır (oyuncu yeni Hızlı Eşleş'e girince trigger taze sahiplik üretir).
-- Karşılığında: SIRA/TIE-BREAK belirsizliği güvenliği HİÇ ETKİLEMEZ.
--
-- KULLANILAN KUYRUK KOLONLARI yalnızca: profile_id, player_id, matched_room_id
-- (üçü de yukarıdaki ön koşulda doğrulanır ve üçü de repoda zaten okunuyor/
--  yazılıyor). HİÇBİR zaman damgası kolonu KULLANILMIYOR.
-- ────────────────────────────────────────────────────────────────────────────

insert into public.wheel_duel_quick_match_owners (player_id, profile_id)
select q.player_id, q.profile_id
  from public.wheel_duel_queue   q
  join public.wheel_duel_players p on p.id = q.player_id
  join public.wheel_duel_rooms   r on r.id = q.matched_room_id
 where q.player_id       is not null
   and q.profile_id      is not null
   and q.matched_room_id is not null
   and r.status   = 'playing'                    -- (2) yalnız canlı maç
   and p.room_id  = q.matched_room_id            -- (3) iç tutarlılık
   and p.guest_id is null                        -- (4) kimlik çelişkisi yok
   and (p.profile_id is null or p.profile_id = q.profile_id)
   and not exists (                              -- (5) çekişme → hiçbir şey
     select 1 from public.wheel_duel_queue q2
      where q2.player_id  = q.player_id
        and q2.profile_id is distinct from q.profile_id
   )
on conflict (player_id) do nothing;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) TEMİZLİK — kendi kimliğiyle ÇELİŞEN sahiplik kayıtlarını sil
-- ----------------------------------------------------------------------------
-- Savunma derinliği + idempotentlik: bu migration'ın yarım kalmış bir önceki
-- denemesinden ya da (varsa) ekilmiş bir kuyruk satırından gelen kayıtlar
-- burada elenir. Bir oyuncu satırı KENDİ kimliğini taşıyorsa (kayıtlı ya da
-- gerçek misafir), onun üzerine yazılmış her sahiplik kaydı GEÇERSİZDİR.
--
-- Meşru QM satırları KİMLİKSİZDİR → bu temizlikten ETKİLENMEZLER.
-- ────────────────────────────────────────────────────────────────────────────

delete from public.wheel_duel_quick_match_owners o
 using public.wheel_duel_players p
 where p.id = o.player_id
   and (
        (p.profile_id is not null and p.profile_id <> o.profile_id)
     or (p.guest_id  is not null)
   );


-- ────────────────────────────────────────────────────────────────────────────
-- 5) wheel_duel_authorize_player — KUYRUK ARTIK YETKİ KANITI DEĞİL
-- ----------------------------------------------------------------------------
-- 20260814180000'in 3. dalı (canlı, MUTABLE kuyruk satırı) KALDIRILIR; yerine
-- yalnız DEĞİŞTİRİLEMEZ sahiplik kaydı geçer. Sahiplik dalı ayrıca oyuncu
-- satırının KENDİ kimliğini asla ezemez.
--
-- İlk iki dal 20260814180000'deki hâliyle BİREBİR korunur.
-- İmza / dönüş tipi / SECURITY DEFINER / search_path / grant'lar DEĞİŞMEZ
-- (`create or replace` grant'ları KORUR).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.wheel_duel_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    -- 1) KAYITLI oyuncu — kendi profili
    select 1
      from public.wheel_duel_players p
      left join public.wheel_duel_player_claims c
        on c.player_id = p.id
     where p.id = p_player_id
       and (
            (p.profile_id is not null and p.profile_id = auth.uid())
            -- 2) GERÇEK MİSAFİR — claim token
         or (p.profile_id is null
             and p.guest_id  is not null
             and p_claim_token is not null
             and c.claim_token = p_claim_token)
       )
  )
  or exists (
    -- 3) HIZLI EŞLEŞ — KALICI, DEVREDİLEMEZ sahiplik kaydı.
    --    20260814180000'in canlı kuyruk köprüsünün YERİNE geçer: o köprü,
    --    çağıranın verdiği p_player_id ile yazılan MUTABLE bir satıra
    --    güveniyordu ve kimliğe bürünmeye açıktı.
    --    Sahiplik, oyuncu satırının KENDİ kimliğini asla EZEMEZ.
    select 1
      from public.wheel_duel_quick_match_owners o
      join public.wheel_duel_players p on p.id = o.player_id
     where o.player_id  = p_player_id
       and o.profile_id = auth.uid()
       and p.guest_id is null
       and (p.profile_id is null or p.profile_id = auth.uid())
  );
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 6) DOĞRULAMA — yarım/eksik durum COMMIT EDİLEMEZ
-- ----------------------------------------------------------------------------
-- Bu blok transaction'ın içinde çalışır: herhangi bir koruma eksikse RAISE
-- eder ve migration TÜMÜYLE geri alınır. "140000 var ama bağlama yok"
-- penceresi bu sayede oluşamaz.
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_bad  int;
  v_def  text;
begin
  -- 6a) Sunucu-özel tablo: istemci rollerinde HİÇBİR yetki olmamalı.
  if has_table_privilege('anon',          'public.wheel_duel_quick_match_owners', 'SELECT')
  or has_table_privilege('anon',          'public.wheel_duel_quick_match_owners', 'INSERT')
  or has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners', 'SELECT')
  or has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners', 'INSERT')
  or has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners', 'UPDATE')
  or has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners', 'DELETE')
  then
    raise exception 'owners tablosu istemciye AÇIK kaldı';
  end if;

  -- 6b) Trigger yerinde mi?
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.wheel_duel_queue'::regclass
       and tgname  = 'wheel_duel_queue_record_owner'
       and not tgisinternal
  ) then
    raise exception 'sahiplik trigger''ı kurulmadı';
  end if;

  -- 6c) Çelişkili sahiplik kalmamalı.
  select count(*) into v_bad
    from public.wheel_duel_quick_match_owners o
    join public.wheel_duel_players p on p.id = o.player_id
   where (p.profile_id is not null and p.profile_id <> o.profile_id)
      or p.guest_id is not null;
  if v_bad > 0 then
    raise exception 'çelişkili sahiplik kaydı kaldı: %', v_bad;
  end if;

  -- 6d) authorize artık kuyruğu SORGULAMAMALI. Yorum satırları elenerek
  --     bakılır ki gövdedeki açıklama metni yanlış alarm vermesin.
  v_def := regexp_replace(
    pg_get_functiondef(to_regprocedure('public.wheel_duel_authorize_player(uuid,uuid)')),
    '--[^\n]*', '', 'g');
  if position('wheel_duel_queue' in v_def) > 0 then
    raise exception 'authorize hâlâ wheel_duel_queue köprüsünü SORGULUYOR';
  end if;
  if position('wheel_duel_quick_match_owners' in v_def) = 0 then
    raise exception 'authorize kalıcı sahiplik dalını İÇERMİYOR';
  end if;

  -- 6e) Kuyruk yazma kilidi (20260814180000) GEVŞEMEMELİ.
  if has_table_privilege('anon',          'public.wheel_duel_queue', 'INSERT')
  or has_table_privilege('authenticated', 'public.wheel_duel_queue', 'INSERT')
  or has_table_privilege('authenticated', 'public.wheel_duel_queue', 'UPDATE')
  or has_table_privilege('authenticated', 'public.wheel_duel_queue', 'DELETE')
  then
    raise exception 'wheel_duel_queue yazma kilidi gevşedi';
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA (Studio SQL editor — uygulandıktan SONRA)
-- ════════════════════════════════════════════════════════════════════════════
--   -- Tablo sunucu-özel mi? (beklenen: false, false)
--   select has_table_privilege('anon',          'public.wheel_duel_quick_match_owners','SELECT'),
--          has_table_privilege('authenticated', 'public.wheel_duel_quick_match_owners','SELECT');
--
--   -- Köprü gitti mi? (beklenen: false)
--   select pg_get_functiondef(to_regprocedure(
--            'public.wheel_duel_authorize_player(uuid,uuid)')) ilike '%from public.wheel_duel_queue%';
--
--   -- Grant'lar korundu mu? (beklenen: true, true — 20260528120000'den beri)
--   select has_function_privilege('anon',
--            'public.wheel_duel_authorize_player(uuid,uuid)','EXECUTE'),
--          has_function_privilege('authenticated',
--            'public.wheel_duel_authorize_player(uuid,uuid)','EXECUTE');
--
--   -- Canlı QM maçlarının sahipliği taşındı mı? (beklenen: 0)
--   select count(*) from public.wheel_duel_queue q
--    where q.player_id is not null and q.profile_id is not null
--      and not exists (select 1 from public.wheel_duel_quick_match_owners o
--                       where o.player_id = q.player_id);
-- ════════════════════════════════════════════════════════════════════════════
