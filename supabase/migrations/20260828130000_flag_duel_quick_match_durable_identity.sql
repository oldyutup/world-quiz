-- ════════════════════════════════════════════════════════════════════════════
-- 20260828130000_flag_duel_quick_match_durable_identity.sql
--
-- BAYRAK DÜELLO HIZLI EŞLEŞ — KALICI KİMLİK
-- Kuyruk MATCHMAKING durumudur; KİMLİK KANITI DEĞİLDİR.
-- ════════════════════════════════════════════════════════════════════════════
--
-- CANLIDA DOĞRULANMIŞ SORUN (Build 11 postcheck temizliğinde ortaya çıktı)
-- ───────────────────────────────────────────────────────────────────────
--   `flag_duel_quick_match` oyuncu satırlarını KİMLİKSİZ yaratır:
--       insert into duel_players (id, room_id, name, score)   -- profile_id YOK
--   → satırda `profile_id IS NULL` VE `guest_id IS NULL`.
--
--   20260814180000 sonrası `duel_authorize_player`ın iki dalı da bu satırda ÖLÜ:
--     1) kayıtlı dal : `p.profile_id = auth.uid()` → NULL, asla tutmaz
--     2) misafir dal : `p.guest_id is not null` şartı → NULL, yapısal olarak ölü
--   Geriye TEK yetki kaynağı olarak `flag_duel_authorize_player`ın kuyruk
--   köprüsü kalır:
--       exists (select 1 from flag_duel_queue q
--                where q.player_id = p_player_id and q.profile_id = auth.uid())
--
--   `flag_duel_reset_quick_match` kuyruk satırını KOŞULSUZ siler (bu davranış
--   DOĞRUDUR: "Hızlı Eşleş eski maçı açmasın" kuralı, build 9). İstemci de
--   her yeni aramadan önce onu çağırır. Sonuç: oyuncu, HÂLÂ AKTİF olan önceki
--   Bayrak QM odasındaki KENDİ slotu için tek yetki kanıtını kaybeder.
--
--   CANLI GÖZLEM (Build 11 postcheck, üç tek kullanımlık oda):
--     flag_duel_leave_room → 42501 unauthorized  (her iki hesap, dört satır)
--     oyuncu kendi aktif odasından ÇIKAMIYOR / forfeit EDEMİYOR
--     oda 'playing' durumunda yetim kalıyor
--
--   Bu 20260828120000'in (rövanş) yarattığı bir regresyon DEĞİLDİR; ondan
--   ÖNCE de vardı. Rövanş işi bu dosyada AÇILMAZ.
--
--   İKİNCİ KUSUR (aynı köprü, güvenlik): `flag_duel_queue.player_id` UNIQUE
--   DEĞİLDİR ve `flag_duel_quick_match` `p_player_id`yi ÇAĞIRANDAN alır.
--   Saldırgan kendi kuyruk satırına KURBANIN player_id'sini yazarak köprüyü
--   kendi adına kurbanın slotuna bağlayabilirdi. Çark'ta bu P0 20260827140000
--   ile kapatıldı; Bayrak'ta AÇIK kalmıştı. Bu dosya köprüyü tamamen kaldırır.
--
-- ════════════════════════════════════════════════════════════════════════════
-- SEÇİLEN TASARIM: `duel_players.profile_id`i DOĞRUDAN YAZ  (Çark'ın owners
-- tablosu deseni Bayrak'a KOPYALANMAZ) — gerekçeler kanıta dayalıdır:
-- ────────────────────────────────────────────────────────────────────────────
--   1) Bayrak QM RPC'sinin GÖVDESİ REPODADIR (20260801120000). Çark'ta owners
--      tablosu seçilmesinin BİRİNCİ sebebi `wheel_duel_quick_match` gövdesinin
--      repoda OLMAMASIYDI (20260827140000 bunu açıkça yazar). Burada kimliği
--      en dar otoriter noktada — sunucunun oyuncuyu YARATTIĞI satırda —
--      bağlayabiliyoruz. Yeni tablo/trigger/ACL yüzeyi GEREKMEZ.
--
--   2) `duel_players.profile_id` ZATEN VAR ve Bayrak'ın DİĞER TÜM yollarında
--      ZATEN DOLU: `flag_duel_create_room`, `duel_join_room`,
--      `duel_accept_rematch`, `duel_join_rematch_room`, ayrıca Ülke Yaz QM
--      (`country_duel_quick_match`) da doldurur. Kimliksiz doğan TEK yol
--      Bayrak QM'dir. Bu düzeltme bir istisnayı KALDIRIR, yeni bir mekanizma
--      EKLEMEZ.
--
--   3) Çark'ın "profile_id doldurmayalım, ödül dağıtımı sessizce değişir"
--      itirazı BAYRAK İÇİN GEÇERLİ DEĞİLDİR — ölçülerek doğrulandı:
--      `award_xp_event` (20260819130000) katılımı
--      `_xp_is_room_participant('flag_duel', p_room_id, uid)` ile doğrular ve
--      `duel_players.room_id = p_room_id` arar. Bayrak istemcisi ise XP'ye
--      `roomId` olarak SENTETİK bir `matchId` (crypto.randomUUID) geçirir
--      (FlagDuelGame: `roomId: matchId`). Yani kontrol ODA KİMLİĞİNDEN ötürü
--      ZATEN başarısızdır ve `profile_id`den BAĞIMSIZDIR: bu migration ödül
--      davranışını NE AÇAR NE KAPATIR. (Bayrak XP'sinin sentetik room_id
--      yüzünden hiç yazılmaması AYRI ve ESKİ bir konudur; burada AÇILMAZ.)
--
--   4) UI değişmez: `duel_players.profile_id`i okuyan tek Bayrak render'ı
--      (avatar + GuestTag + PlayerProfileTrigger) `phase === "waiting"`
--      LOBİSİNDEDİR; Hızlı Eşleş odası lobiye HİÇ uğramaz (doğrudan
--      'playing'). Manuel odalarda o satırlar zaten dolu → görünüm aynı.
--
--   5) Sunucuda hiçbir dal `duel_players.profile_id IS NULL` üzerine
--      kurulmamıştır (tarandı: eşleşme yok). duel_players üzerinde
--      profile_id'ye bakan bir RLS politikası da yoktur.
--
-- ════════════════════════════════════════════════════════════════════════════
-- KİMLİK NEREDEN GELİR (istemciye ASLA güvenilmez)
-- ────────────────────────────────────────────────
--   ÇAĞIRAN  → `p_profile_id`, fonksiyonun İLK satırlarında
--               `auth.uid() = p_profile_id` ile doğrulanmıştır.
--   BEKLEYEN → `v_candidate.profile_id`, KİLİTLENMİŞ kuyruk satırından
--               SUNUCU tarafından okunur (`for update skip locked`). O satırın
--               `profile_id`si PK'dır ve yalnız kendi sahibinin
--               `auth.uid()` doğrulamasından geçmiş çağrısıyla yazılır.
--
--   Kimlik ASLA sonradan gelen bir istemci iddiasıyla ("bu player_id benim")
--   kurulmaz: yazım, sunucunun oyuncuyu YARATTIĞI aynı transaction'dadır.
--
-- ARIZADA-KAPANIR: `p_player_id` veya kuyruktaki `player_id` MEVCUT bir
--   `duel_players` satırına denk geliyorsa `player_id_taken` (42501) fırlatılır
--   ve TÜM Hızlı Eşleş transaction'ı geri alınır — oda yok, oyuncu yok, kuyruk
--   yazımı yok. Başka birinin kimliği ASLA üzerine yazılmaz/devralınmaz.
--   (`duel_players.id` PRIMARY KEY'dir — `duel_player_claims.player_id`
--    ona FK ile bağlıdır — yani çakışma zaten geri alırdı; açık kontrol niyeti
--    belgeler ve anlaşılır hata kodu verir.)
--
-- ════════════════════════════════════════════════════════════════════════════
-- DEĞİŞTİRİLENLER (yalnız iki fonksiyon)
--   1) public.flag_duel_quick_match(uuid,uuid,text,int,text,int,text,text)
--      Gövde 20260801120000'den BAYT SADIK; TEK fark: iki oyuncu INSERT'ü
--      `profile_id` yazar + arızada-kapanır ön kontrol. Eşleştirme mantığı,
--      bracket, self-heal, kuyruk semantiği, dönüş JSON'u: DOKUNULMADI.
--   2) public.flag_duel_authorize_player(uuid,uuid)
--      KUYRUK KÖPRÜSÜ KALDIRILDI. Yetki artık yalnız `duel_authorize_player`
--      (kayıtlı: profile_id = auth.uid(); GERÇEK misafir: guest_id + claim
--      token). Kuyruk bir daha ASLA yetki kanıtı olmaz.
--
-- DOKUNULMAYANLAR
--   • 20260828120000 (rövanş) ve Build 10 Çark dosyaları: HİÇ DEĞİŞMEZ.
--   • flag_duel_reset_quick_match / cancel_quick_match: DEĞİŞMEZ (kuyruğu
--     silmeleri DOĞRUDUR; artık zararsızdır).
--   • flag_duel_leave_room / submit_claim / advance_if_due / accept_rematch /
--     finalize_game / set_next_round / start_game / send_message: gövde
--     DEĞİŞMEZ — hepsi aynı helper'dan geçtiği için düzelmeyi otomatik alır.
--   • Manuel/oda-kodu/davet akışı, misafir kimliği, Bayrak Grup
--     (flag_group_*), Ülke Yaz, Çark, Rota, Kuşatma: DOKUNULMAZ.
--   • Şema DEĞİŞMEZ: yeni tablo/kolon/kısıt/trigger/politika YOK.
--   • ACL: her iki fonksiyon canlı grant'iyle BİREBİR yeniden kurulur
--     (quick_match → yalnız `authenticated`; authorize_player → anon +
--      authenticated). PUBLIC'e hiçbir şey açılmaz.
--
-- ════════════════════════════════════════════════════════════════════════════
-- UYGULAMA MALİYETİ (bilinçli kabul)
-- ──────────────────────────────────
--   Kuyruk köprüsü kalktığı için, DEPLOY ANINDA hâlâ oynanan ESKİ Bayrak QM
--   odaları (satırları kimliksiz) yetkisiz kalır: o maçlar sürdürülemez.
--   Pencere dardır (kuyruk satırı 45 sn'de dolar; istemci her aramada siler)
--   ve bugünkü davranış zaten "kuyruk silinince maç kilitleniyor"dur. Eski
--   satırlara profile_id BACKFILL EDİLMEZ: tek kanıt kaynağı kuyruğun kendisi
--   olurdu ve o kanıt (yukarıdaki ikinci kusur) SAHTELENEBİLİR. Sahtelenebilir
--   bir eşlemeyi kalıcı kimliğe terfi ettirmek, kapatılan açığı kalıcılaştırmak
--   olurdu. Yeni odalar ilk saniyeden itibaren doğru doğar.
--
-- IDEMPOTENT: yalnız `create or replace` + `revoke`/`grant`.
-- DEPLOY: PRODUCTION'A UYGULANMADI.
-- ════════════════════════════════════════════════════════════════════════════


-- ── ÖN KOŞULLAR ─────────────────────────────────────────────────────────────
do $pre$
begin
  if to_regclass('public.flag_duel_queue') is null then
    raise exception 'ÖN KOŞUL: flag_duel_queue yok';
  end if;
  if to_regclass('public.duel_players') is null then
    raise exception 'ÖN KOŞUL: duel_players yok';
  end if;
  -- profile_id kolonu olmadan kalıcı kimlik yazılamaz.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'duel_players'
       and column_name = 'profile_id'
  ) then
    raise exception 'ÖN KOŞUL: duel_players.profile_id yok (20260603120000 uygulanmamış)';
  end if;
  -- ACL ÖNCE-DURUMU: doğrulama bloğu "değişmedi mi" diye SORACAK, sabit bir
  -- değere göre DEĞİL. (Gerekçe: repo bu iki fonksiyona hiç `to anon` grant'i
  -- yazmadı, ama CANLIDA anon EXECUTE = true — Supabase'in ALTER DEFAULT
  -- PRIVILEGES tuzağı, bkz. 20260809130000. Sabit bir beklentiye göre
  -- doğrulamak, ACL'e DOKUNMAYAN bu migration'ı haksız yere abort ettirirdi.)
  create temp table if not exists _flag_qm_acl_before (
    fn text primary key, pub boolean, anon_x boolean, auth_x boolean
  ) on commit drop;
  delete from _flag_qm_acl_before;
  insert into _flag_qm_acl_before
  select f,
         exists (select 1 from pg_proc p,
                      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where p.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
         has_function_privilege('anon', f, 'EXECUTE'),
         has_function_privilege('authenticated', f, 'EXECUTE')
    from unnest(array[
      'public.flag_duel_quick_match(uuid,uuid,text,int,text,int,text,text)',
      'public.flag_duel_authorize_player(uuid,uuid)'
    ]) as f;

  -- ARIZADA-KAPANIR davranışın dayanağı: id benzersiz olmalı.
  if not exists (
    select 1
      from pg_constraint c
     where c.conrelid = 'public.duel_players'::regclass
       and c.contype in ('p','u')
       and (select array_agg(a.attname::text order by a.attname::text)
              from unnest(c.conkey) k join pg_attribute a
                on a.attrelid = c.conrelid and a.attnum = k) = array['id']::text[]
  ) then
    raise exception 'ÖN KOŞUL: duel_players.id üzerinde PRIMARY KEY/UNIQUE yok';
  end if;
end $pre$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) flag_duel_quick_match — oyuncu satırlarına KALICI kimlik yaz
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
  if auth.uid() is null then
    raise exception 'flag_duel_quick_match: not authenticated';
  end if;
  if auth.uid() <> p_profile_id then
    raise exception 'flag_duel_quick_match: auth.uid() does not match p_profile_id';
  end if;

  if p_total_rounds not in (5, 10, 15, 20) then
    raise exception 'flag_duel_quick_match: invalid total_rounds %', p_total_rounds;
  end if;
  if p_max_level_diff < 0 then
    raise exception 'flag_duel_quick_match: invalid max_level_diff %', p_max_level_diff;
  end if;
  if coalesce(p_room_code, '') = '' or coalesce(p_first_flag, '') = '' then
    raise exception 'flag_duel_quick_match: empty room_code or first_flag';
  end if;

  v_my_level := public.flag_duel_mode_level(p_profile_id);

  -- Stale-row self-heal (preserved from 20260521130000)
  update public.flag_duel_queue q
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
     and not public.is_blocked_between(p_profile_id, q.profile_id)
   order by q.created_at asc
   limit 1
   for update skip locked;

  if found then
    -- ── EŞLEŞME — odayı atomik kur ──────────────────────────────────────
    -- host_player_id = candidate (waiter). Hem flag_duel_authorize_host
    -- manuel branch'i hem client-side isHost kontrolü bu kolon üzerinden
    -- DETERMINISTIK çalışır; joined_at tie-break belirsizliği biter.
    -- (room_kind sunucu-otoriter: bu RPC yalnız Bayrak 1v1 odası kurar)
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
      room_source,
      host_player_id,
      room_kind
    ) values (
      p_room_code,
      'playing',
      60,
      p_region,
      v_started_at,
      p_total_rounds,
      1,
      false,
      p_first_flag,
      v_started_at,
      'quick_match',
      v_candidate.player_id,
      'flag'
    )
    returning id into v_room_id;

    -- ══ ARIZADA-KAPANIR KİMLİK KONTROLÜ (yeni) ═══════════════════════════
    -- `p_player_id` ÇAĞIRANDAN, `v_candidate.player_id` ise kuyruktan gelir;
    -- ikisi de istemcinin seçtiği değerlerdir. Bunlardan biri BAŞKA BİRİNİN
    -- var olan oyuncu satırına denk geliyorsa maç KURULMAZ: aksi hâlde o
    -- satıra kimlik yazma denemesi olurdu. (`duel_players.id` PRIMARY KEY
    -- olduğu için INSERT zaten çakışırdı; bu kontrol niyeti AÇIK yapar ve
    -- anlaşılır bir hata kodu verir. Tüm gövde tek transaction: RAISE →
    -- oda, oyuncular ve kuyruk yazımları dâhil HER ŞEY geri alınır.)
    if exists (select 1 from public.duel_players where id = v_candidate.player_id) then
      raise exception 'player_id_taken' using errcode = '42501';
    end if;
    if exists (select 1 from public.duel_players where id = p_player_id) then
      raise exception 'player_id_taken' using errcode = '42501';
    end if;

    -- ══ KALICI KİMLİK (yeni) ═════════════════════════════════════════════
    -- Bekleyen tarafın profili KUYRUK SATIRINDAN (sunucu okuması) alınır —
    -- istemciden DEĞİL. Çağıranın profili ise fonksiyonun başında
    -- `auth.uid() = p_profile_id` ile zaten doğrulanmıştır.
    insert into public.duel_players (id, room_id, name, score, profile_id)
      values (v_candidate.player_id, v_room_id, v_candidate.player_name, 0,
              v_candidate.profile_id);

    insert into public.duel_players (id, room_id, name, score, profile_id)
      values (p_player_id, v_room_id, p_player_name, 0, p_profile_id);

    update public.flag_duel_queue
       set matched_room_id = v_room_id,
           updated_at      = v_now
     where profile_id = v_candidate.profile_id;

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
    where q.matched_room_id is null;

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
revoke all on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) from public;
grant  execute on function public.flag_duel_quick_match(uuid, uuid, text, int, text, int, text, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) flag_duel_authorize_player — KUYRUK KÖPRÜSÜ KALDIRILDI
-- ----------------------------------------------------------------------------
-- ÖNCE (20260612120000):
--     duel_authorize_player(...)
--   OR exists (select 1 from flag_duel_queue q
--               where q.player_id = p_player_id and q.profile_id = auth.uid())
--
-- SONRA: yalnız `duel_authorize_player`.
--   • KAYITLI  → duel_players.profile_id = auth.uid()  (bu migration'la Bayrak
--                QM satırlarında da dolu; manuel odalarda zaten doluydu)
--   • MİSAFİR  → guest_id IS NOT NULL + duel_player_claims.claim_token
--   Kuyruk artık yetki kanıtı DEĞİLDİR: silinmesi, üzerine yazılması, süresinin
--   dolması ya da yeni bir arama başlatılması oyuncunun KENDİ aktif odasındaki
--   yetkisini ETKİLEMEZ.
--
-- Helper KORUNUR (DROP edilmez): Bayrak'ın on'dan fazla RPC'si onu çağırıyor;
-- imza, dönüş tipi, SECURITY DEFINER, search_path ve ACL aynen kalır.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.flag_duel_authorize_player(
  p_player_id   uuid,
  p_claim_token uuid
) returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  -- Manuel oda, oda-kodu/davet, misafir VE Hızlı Eşleş: hepsi tek yoldan.
  -- Kimlik oyuncu satırının KENDİSİNDEDİR; hiçbir geçici matchmaking satırı
  -- yetki üretemez.
  select public.duel_authorize_player(p_player_id, p_claim_token);
$$;

revoke all     on function public.flag_duel_authorize_player(uuid, uuid) from public;
grant  execute on function public.flag_duel_authorize_player(uuid, uuid) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) DOĞRULAMA — migration kendi iddialarını uygular
-- ════════════════════════════════════════════════════════════════════════════
do $ver$
declare
  v_fail text := '';
  v_src  text;
  v_pub  boolean;
  v_anon boolean;
  v_auth boolean;
begin
  -- 3a) İki fonksiyon da SECURITY DEFINER + search_path pinli + istemci ACL'i.
  for v_src in
    select unnest(array[
      'public.flag_duel_quick_match(uuid,uuid,text,int,text,int,text,text)',
      'public.flag_duel_authorize_player(uuid,uuid)'
    ])
  loop
    if not exists (
      select 1 from pg_proc p
       where p.oid = v_src::regprocedure
         and p.prosecdef
         and p.proconfig is not null
         and exists (select 1 from unnest(p.proconfig) as cfg(v) where cfg.v like 'search_path=%')
    ) then
      v_fail := v_fail || ' [' || v_src || ' SECURITY DEFINER/search_path değil]';
    end if;
  end loop;

  -- 3b) ACL DEĞİŞMEMİŞ olmalı — ne genişleme ne daralma.
  --     Karşılaştırma ÖNCE-DURUMUNA karşıdır (yukarıdaki temp snapshot),
  --     sabit bir beklentiye karşı DEĞİL: bu migration ACL'e dokunmaz,
  --     `revoke all … from public` + mevcut grant'ı yeniden yazmak
  --     no-op'tur. PUBLIC ayrıca MUTLAK olarak false olmalıdır.
  for v_src, v_pub, v_anon, v_auth in
    select b.fn,
           exists (select 1 from pg_proc p,
                        lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where p.oid = b.fn::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
           has_function_privilege('anon', b.fn, 'EXECUTE'),
           has_function_privilege('authenticated', b.fn, 'EXECUTE')
      from _flag_qm_acl_before b
  loop
    if v_pub then
      v_fail := v_fail || ' [' || v_src || ': PUBLIC EXECUTE açık kalmış]';
    end if;
    if (v_anon, v_auth) is distinct from
       (select (b.anon_x, b.auth_x) from _flag_qm_acl_before b where b.fn = v_src) then
      v_fail := v_fail || ' [' || v_src || ': istemci ACL''i DEĞİŞTİ]';
    end if;
    if not v_auth then
      v_fail := v_fail || ' [' || v_src || ': authenticated EXECUTE kaybı]';
    end if;
  end loop;

  -- 3c) Kuyruk köprüsü GERÇEKTEN gitti mi?
  select prosrc into v_src from pg_proc
   where oid = 'public.flag_duel_authorize_player(uuid,uuid)'::regprocedure;
  if v_src like '%flag_duel_queue%' then
    v_fail := v_fail || ' [flag_duel_authorize_player HÂLÂ kuyruğa bakıyor]';
  end if;
  if v_src not like '%duel_authorize_player%' then
    v_fail := v_fail || ' [flag_duel_authorize_player: kayıtlı/misafir yolu kayıp]';
  end if;

  -- 3d) QM gövdesi kalıcı kimliği ve arızada-kapanır kontrolü içeriyor mu?
  select prosrc into v_src from pg_proc
   where oid = 'public.flag_duel_quick_match(uuid,uuid,text,int,text,int,text,text)'::regprocedure;
  if v_src not like '%v_candidate.profile_id%' then
    v_fail := v_fail || ' [flag QM: BEKLEYEN tarafın profili yazılmıyor]';
  end if;
  if v_src not like '%score, profile_id%' then
    v_fail := v_fail || ' [flag QM: duel_players INSERT''ü profile_id taşımıyor]';
  end if;
  if v_src not like '%player_id_taken%' then
    v_fail := v_fail || ' [flag QM: arızada-kapanır player_id kontrolü yok]';
  end if;
  -- Eşleştirme çekirdeği korunmuş olmalı (sessiz sürüklenme kalkanı).
  if v_src not like '%for update skip locked%'
     or v_src not like '%max_level_diff%'
     or v_src not like '%is_blocked_between%'
     or v_src not like '%room_kind%' then
    v_fail := v_fail || ' [flag QM: eşleştirme gövdesi sürüklenmiş]';
  end if;

  -- 3e) İlgisiz yüzeylere dokunulmadığının kanıtı: bu migration hiçbir
  --     tabloyu/kolonu/politikayı değiştirmez; yalnız iki fonksiyon.
  if to_regclass('public.flag_duel_queue') is null then
    v_fail := v_fail || ' [flag_duel_queue kaybolmuş]';
  end if;

  if v_fail <> '' then
    raise exception 'flag_duel_quick_match_durable_identity doğrulaması BAŞARISIZ:%', v_fail;
  end if;
  raise notice 'flag_duel_quick_match_durable_identity: tüm doğrulamalar geçti.';
end $ver$;

-- ════════════════════════════════════════════════════════════════════════════
-- CANLI SONRASI KONTROL (elle, salt-okunur)
-- ─────────────────────────────────────────
--   -- YENİ Bayrak QM odalarının satırları kimlikli doğmalı:
--   select p.id, p.profile_id is not null as has_identity
--     from duel_players p join duel_rooms r on r.id = p.room_id
--    where r.room_kind = 'flag' and r.room_source = 'quick_match'
--    order by p.joined_at desc limit 10;      -- hepsi true beklenir
--
--   -- ESKİ (bu migration'dan önceki) satırlar kimliksiz KALIR — backfill YOK:
--   select count(*) from duel_players p join duel_rooms r on r.id = p.room_id
--    where r.room_kind = 'flag' and r.room_source = 'quick_match'
--      and p.profile_id is null;
-- ════════════════════════════════════════════════════════════════════════════
