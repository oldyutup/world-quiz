-- ════════════════════════════════════════════════════════════════════════════
-- 20260827120000_route_duel_disconnect_two_phase.sql
--
-- ROTA DÜELLO — SAHTE KOPUŞ / SAHTE GALİBİYET (build 9 gerçek-cihaz blocker'ı)
-- ════════════════════════════════════════════════════════════════════════════
-- SEMPTOM (iPhone + PC, ikisi de bağlı, ikisinin de ekranı açık)
-- ──────────────────────────────────────────────────────────────
--   iPhone ülke göndermeye devam eder, PC hiçbir şey göndermez. Bir süre
--   sonra maç "Rakip bağlantısını kaybetti" ile İPHONE LEHİNE biter.
--   Oysa PC bağlıydı: HAMLE YOKLUĞU KOPUŞ DEĞİLDİR.
--
-- ASIL KÖK NEDEN (İSTEMCİDE — bu migration'ın DIŞINDA düzeltildi)
-- ───────────────────────────────────────────────────────────────
--   `route_duel_heartbeat` HİÇ ÇAĞRILMIYORDU. İstemci
--
--       void supabase.rpc("route_duel_heartbeat", {...});
--
--   yazıyordu; @supabase/postgrest-js'te PostgrestBuilder gerçek bir Promise
--   DEĞİL, `then()` çağrıldığında fetch'i başlatan bir thenable'dır. `void`
--   operatörü `then` çağırmaz → İSTEK HİÇ GİTMEZ (ölçüldü: 0 HTTP request).
--   Sonuç: `route_duel_players.last_seen_at`i tazeleyen TEK yol
--   `route_duel_submit_move` (bu dosyada değişmez) kalmıştı — yani "aktivite"
--   fiilen "gameplay hamlesi" demekti. Hamle göndermeyen oyuncunun damgası
--   maç başlangıcında donuyor, 20 sn sonra rakibi kopuş galibiyeti alıyordu.
--   İstemci düzeltmesi heartbeat'i gerçekten gönderir ve bu asimetriyi bitirir.
--
-- BU MIGRATION NEDEN GEREKLİ (heartbeat düzeltmesi TEK BAŞINA yetmez)
-- ───────────────────────────────────────────────────────────────────
--   Heartbeat aktığında bile karar TEK bir kanıta bakıyordu: "rakibin
--   last_seen_at'i 20 sn'den eski". Bu, ARKA PLANA ALMAYI kopuş sayar:
--   iOS WKWebView arka planda setInterval'i askıya alır, dolayısıyla
--     • bildirim/çağrı için 20 sn uygulamadan çıkan oyuncu maçı KAYBEDER,
--     • iki taraf da arka plandayken önce dönen taraf, biriken bayatlığı
--       ANINDA galibiyete çevirir (rakip geri dönmek üzere olsa bile),
--     • ve karar geri alınamaz (oda 'finished' olur, reconnect imkânsız).
--
--   Çözüm "eşiği büyütmek" DEĞİLDİR (görev bunu açıkça yasaklıyor). Çözüm
--   İKİ BAĞIMSIZ KANIT istemektir ve ikincisinin SÜREKLİ olmasıdır:
--
--     KANIT 1 (anlık)   : rakibin last_seen_at'i ≥ 20 sn bayat.
--     KANIT 2 (sürekli) : bu bayatlık, gözlemci ÇEVRİMİÇİYKEN kesintisiz
--                         ≥ 10 sn boyunca gözlenmiş olmalı.
--
--   Gözlem penceresi oda satırında tutulur (`disconnect_watch_*`). Rakipten
--   GELEN HER HEARTBEAT pencereyi SİLER → grace içinde geri dönen oyuncu
--   maçı kaybetmez ve pencere sıfırdan başlar. Arka plandan yeni dönen bir
--   istemci, biriken bayatlığı anında galibiyete çeviremez; kendi de en az
--   10 sn ayakta kalıp rakibi o süre boyunca sessiz görmelidir.
--
-- ZAMANLAMA SÖZLEŞMESİ (istemciyle birebir; routeDuelConnection.ts)
-- ─────────────────────────────────────────────────────────────────
--   heartbeat cadence            3 sn   (DEĞİŞMEDİ)
--   bayatlık eşiği              20 sn   (DEĞİŞMEDİ — ~6.7 kaçırılmış beat)
--   sürekli gözlem penceresi    10 sn   (YENİ)
--   → gerçek kopuş en erken ~30 sn'de kesinleşir; foreground'da boşta duran
--     oyuncu SÜRESİZ boşta durabilir (heartbeat aktığı sürece).
--
-- BU MIGRATION'IN YAPMADIKLARI
-- ────────────────────────────
--   • Hiçbir fonksiyon DROP edilmez, hiçbir imza değişmez (eski istemci
--     paketleri aynı çağrıları yapmaya devam eder ve DAHA GÜVENLİ davranır:
--     tek çağrı artık maçı bitiremez, pencere açar).
--   • `route_duel_submit_move` DEĞİŞMEZ (hamlenin last_seen_at'i tazelemesi
--     doğrudur — hamle gönderen oyuncu kanıtlanmış şekilde bağlıdır; sorun
--     onun TEK sinyal olmasıydı).
--   • RLS/policy/grant/publication değişmez. Başka mod tablosuna dokunulmaz.
--   • Gold/XP yok.
--
-- IDEMPOTENT: add column if not exists + create or replace.
-- DEPLOY: migration + istemci BİRLİKTE. PRODUCTION'A UYGULANMADI.
-- ════════════════════════════════════════════════════════════════════════════


-- ── ÖN KOŞUL ────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.route_duel_rooms') is null then
    raise exception 'route_duel_rooms yok — 20260802120000 uygulanmamış';
  end if;
  if to_regclass('public.route_duel_players') is null then
    raise exception 'route_duel_players yok — 20260802120000 uygulanmamış';
  end if;
end $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 1) Gözlem penceresi kolonları
-- ----------------------------------------------------------------------------
-- disconnect_watch_player_id : sessiz görülen (izlenen) oyuncu
-- disconnect_watch_since     : bu sessizliğin KESİNTİSİZ gözlenmeye başladığı
--                              sunucu anı. Rakibin ilk heartbeat'i ikisini de
--                              NULL'a çeker.
--
-- Oda satırı `replica identity full` + realtime publication üyesi; iki yeni
-- kolon istemciye payload'da akar. İstemci bunları OKUMAZ (tip genişletmesi
-- gerekmez) — otorite tamamen sunucudadır.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.route_duel_rooms
  add column if not exists disconnect_watch_player_id uuid        null;
alter table public.route_duel_rooms
  add column if not exists disconnect_watch_since     timestamptz null;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) route_duel_heartbeat — beat + gözlem penceresini SİL
-- ----------------------------------------------------------------------------
-- "Grace içinde reconnect güvenle geri döner" garantisi BURADA yaşar: izlenen
-- oyuncudan tek bir beat gelmesi pencereyi kapatır, yani karşı taraf sayacı
-- sıfırdan başlatmak zorunda kalır.
--
-- Yazım İDEMPOTENT ve DAR: pencere zaten bu oyuncuya ait değilse oda satırına
-- HİÇ dokunulmaz (aksi hâlde her 3 sn'de bir gereksiz realtime UPDATE yayını
-- yapılırdı).
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_heartbeat(
  p_player_id   uuid,
  p_claim_token uuid
) returns void
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_room_id uuid;
begin
  if not public.route_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  update public.route_duel_players
     set last_seen_at = now()
   where id = p_player_id
   returning room_id into v_room_id;

  if v_room_id is null then
    return;
  end if;

  -- Hayat belirtisi gösteren oyuncu izleniyorsa pencereyi kapat.
  update public.route_duel_rooms
     set disconnect_watch_player_id = null,
         disconnect_watch_since     = null,
         updated_at                 = now()
   where id = v_room_id
     and disconnect_watch_player_id = p_player_id;
end;
$$;
revoke all     on function public.route_duel_heartbeat(uuid, uuid) from public;
grant  execute on function public.route_duel_heartbeat(uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) route_duel_handle_disconnect — İKİ AŞAMALI onay
-- ----------------------------------------------------------------------------
-- İmza ve dönüş tipi DEĞİŞMEZ: istemci eskisi gibi 3 sn'de bir çağırır ve
-- dönen oda satırına bakar. Değişen tek şey, TEK çağrının artık maçı
-- bitirememesidir.
--
--   a) rakip TAZE            → pencere kapanır, no-op (oda döner)
--   b) rakip BAYAT + pencere yok   → pencere AÇILIR, no-op
--   c) rakip BAYAT + pencere < 10s → no-op (istemci tekrar dener)
--   d) rakip BAYAT + pencere ≥ 10s → maç kalan oyuncu lehine biter
--
-- (b) ve (c) hiçbir gameplay alanına dokunmaz; skor/tur/rota değişmez.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.route_duel_handle_disconnect(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.route_duel_rooms
language plpgsql security definer set search_path = public, auth
as $$
declare
  -- Sunucu-otoriter zamanlama sabitleri (istemci aynasıyla birebir):
  --   STALE   = last_seen_at bu kadar eskiyse "sessiz" sayılır
  --   CONFIRM = sessizliğin KESİNTİSİZ gözlenmesi gereken süre
  c_stale    constant interval := interval '20 seconds';
  c_confirm  constant interval := interval '10 seconds';
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

  -- (a) Rakip TAZE → açık pencere varsa kapat, karar yok.
  if v_baseline > (now() - c_stale) then
    if v_room.disconnect_watch_player_id is not null then
      update public.route_duel_rooms
         set disconnect_watch_player_id = null,
             disconnect_watch_since     = null,
             updated_at                 = now()
       where id = p_room_id
       returning * into v_room;
    end if;
    return v_room;
  end if;

  -- (b) Rakip BAYAT ama bu rakip için açık pencere yok → pencereyi AÇ.
  --     Tek başına hiçbir maçı bitirmez; yalnız sayacı başlatır.
  if v_room.disconnect_watch_player_id is distinct from v_opp_id
     or v_room.disconnect_watch_since is null then
    update public.route_duel_rooms
       set disconnect_watch_player_id = v_opp_id,
           disconnect_watch_since     = now(),
           updated_at                 = now()
     where id = p_room_id
     returning * into v_room;
    return v_room;
  end if;

  -- (c) Pencere açık ama henüz olgunlaşmadı → sessiz no-op.
  if v_room.disconnect_watch_since > (now() - c_confirm) then
    return v_room;
  end if;

  -- (d) İKİ KANIT DA VAR → maçı kalan oyuncu lehine bitir.
  update public.route_duel_rooms
     set status                     = 'finished',
         finished_at                = now(),
         finished_reason            = 'disconnect',
         winner_player_id           = p_player_id,
         disconnect_watch_player_id = null,
         disconnect_watch_since     = null,
         updated_at                 = now()
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


-- ════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA (Studio SQL editor — uygulandıktan SONRA)
-- ════════════════════════════════════════════════════════════════════════════
--   -- Kolonlar geldi mi?
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'route_duel_rooms'
--      and column_name like 'disconnect_watch%';
--   -- beklenen: 2 satır
--
--   -- İmzalar korundu mu? (eski istemci paketleri bunları çağırıyor)
--   select proname, pg_get_function_arguments(oid), pg_get_function_result(oid)
--     from pg_proc where pronamespace = 'public'::regnamespace
--      and proname in ('route_duel_heartbeat','route_duel_handle_disconnect');
--
--   -- Davranış: TEK handle_disconnect çağrısı ASLA maç bitiremez.
--   -- (playing bir odada, rakibin last_seen_at'i 60 sn geriye alınmış olsa
--   --  bile ilk çağrı status='playing' döndürmeli, ikinci çağrı 10 sn sonra
--   --  'finished' döndürmeli.)
-- ════════════════════════════════════════════════════════════════════════════
