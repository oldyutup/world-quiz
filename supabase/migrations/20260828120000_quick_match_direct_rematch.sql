-- ════════════════════════════════════════════════════════════════════════════
-- 20260828120000_quick_match_direct_rematch.sql
--
-- HIZLI EŞLEŞ RÖVANŞI: LOBİ YOK — SUNUCU-OTORİTER 3-2-1 İLE DOĞRUDAN YENİ MAÇ
-- ════════════════════════════════════════════════════════════════════════════
--
-- SORUN (gerçek cihazda görüldü)
-- ──────────────────────────────
--   Hızlı Eşleş ile başlayan bir maç bitip iki oyuncu da rövanşı kabul
--   ettiğinde, oyuncular NORMAL ODA LOBİSİNE düşüyordu: oda kodu kartı, oda
--   ayarları, "host başlatacak" beklemesi. Lobi MANUEL odanın (oda kodu /
--   davet linki / elle kurulan oda) ürünüdür; Hızlı Eşleş'in değil.
--
--   Kök neden mod bazında SUNUCUDAKİ rövanş RPC'sidir:
--
--     ÇARK      `wheel_duel_process_rematch`  → status = 'waiting'
--                 (istemci 'waiting' görünce lobby fazına döner; host'un
--                  "Başlat"ına kadar maç başlamaz)
--     ÜLKE YAZ  `duel_accept_rematch`         → YENİ oda + room_source='manual'
--                 (yeni oda manuel doğduğu için karşı taraf "Rakip
--                  Bekleniyor… + 6 haneli kod" ekranını görür ve geri sayım
--                  hiç kurulmaz)
--     BAYRAK    `flag_duel_accept_rematch`    → status='playing', started_at=now()
--                 (lobi YOK ama geri sayım da yok: maç aynı anda başlar)
--     ROTA      `route_duel_request_rematch`  → status='playing' +
--                 `_route_duel_begin_round` → round_started_at = now()+3s
--                 → ZATEN DOĞRU; bu dosyada ROTA'YA DOKUNULMAZ.
--
-- ÜRÜN SÖZLEŞMESİ (bu migration'ın uyguladığı)
-- ────────────────────────────────────────────
--   room_source = 'quick_match' olan bir odada rövanş mutabakatı sağlandığında:
--     • lobi YOK, "Başlat" YOK, kuyruk/arama YOK,
--     • AYNI iki oyuncu, AYNI ayarlar (süre / tur / bölge / rota uzunluğu),
--     • maça özgü TÜM durum sıfırlanır (skor, tur, hedef/soru, sıra, deadline,
--       kazanan/bitiş nedeni, kopuş izleme, rövanş oyları),
--     • oda `status='playing'` + `started_at = now() + interval '3 seconds'`
--       ile açılır → iki istemci de AYNI mutlak ana göre 3-2-1 sayar.
--
--   room_source = 'manual' olan odada DAVRANIŞ BİREBİR ESKİSİ GİBİDİR.
--   Aşağıdaki her fonksiyonda manuel dal, canlı gövdeyle aynı değerleri yazar.
--
-- NEDEN SUNUCU DEĞİŞİKLİĞİ ŞART
-- ─────────────────────────────
--   "Lobiye gitme, 3 saniye say, sonra başla" kararı İSTEMCİDE alınamaz:
--     1) Odanın durumunu (`status`, `started_at`) yalnız bu SECURITY DEFINER
--        RPC'ler yazabilir; istemcinin doğrudan UPDATE yetkisi yoktur (RLS).
--     2) Geri sayımın İKİ istemcide de aynı ana bağlanması için başlangıç anı
--        SUNUCU saatinden gelmelidir. İstemci `setTimeout`'u otorite yapmak,
--        Rota'da düzeltilen client-clock desync hatasının aynısını üretirdi.
--     3) "Bu maç hızlı eşleşmeden mi geldi?" sorusunun otoritesi sunucudaki
--        `room_source` kolonudur; istemci UI state'i değil.
--
-- DOKUNULMAYANLAR (açıkça)
-- ────────────────────────
--   • 20260827120000 / 130000 / 140000 / 150000 (build 10 kimlik+güvenlik):
--     HİÇBİRİ değiştirilmez. `wheel_duel_authorize_player`,
--     `wheel_duel_quick_match_owners`, kuyruk trigger'ı, `wheel_duel_quick_match`
--     sarmalayıcısı ve `_wheel_duel_quick_match_core` bu dosyada geçmez.
--   • Rövanş MUTABAKAT protokolü: oy/broadcast mantığı, kaç onay gerektiği,
--     kimin tetiklediği DEĞİŞMEZ. Bu dosya yalnız "mutabakat sağlandıktan
--     SONRA oda hangi duruma gider" sorusunu değiştirir. Tek taraflı istek,
--     ret, ayrılma ve zaman aşımı davranışları AYNEN korunur.
--   • Rota Düello, Kuşatma, gruplar (flag_group / wheel_group / duel_group),
--     Kör Nokta, XP/altın RPC'leri, kuyruk/eşleştirme RPC'leri: DOKUNULMAZ.
--   • Hiçbir tablo/kolon/fonksiyon DROP edilmez. Hiçbir ACL genişletilmez;
--     her fonksiyon canlı grant'iyle (anon, authenticated) yeniden kurulur.
--
-- ════════════════════════════════════════════════════════════════════════════
-- BÖLÜM LİSTESİ
--   0) Şema boşluğu kapatma (İDEMPOTENT, CANLIDA NO-OP)
--   1) Çark    — wheel_duel_process_rematch
--   2) Çark    — wheel_duel_process_rematch_if_ready
--   3) Bayrak  — flag_duel_accept_rematch
--   4) Ülke Yaz— duel_accept_rematch          (room_source devri)
--   5) Ülke Yaz— duel_join_rematch_room       (QM odada +3 sn)
--   6) BAŞLANGIÇ OTORİTESİ — claim RPC'leri started_at'ten önce yazmaz
--   7) Doğrulama bloğu
-- ════════════════════════════════════════════════════════════════════════════



-- ════════════════════════════════════════════════════════════════════════════
-- 0) ŞEMA BOŞLUĞU KAPATMA — `wheel_duel_rooms` üç kolonu (İDEMPOTENT)
-- ════════════════════════════════════════════════════════════════════════════
-- DURUM: `wheel_duel_rooms.room_source`, `match_seq` ve `current_match_id`
-- ÜRETİMDE VARDIR — canlı `wheel_duel_process_rematch` (20260529120000)
-- ikisini de YAZAR ve istemci `room.room_source`u OKUR (WheelDuelGame'in Hızlı
-- Eşleş geri sayımı bugün buna bağlı çalışıyor). Ancak bu kolonların DDL'i
-- repo'daki hiçbir migration'da YOKTUR: Çark Hızlı Eşleş'i doğrudan canlı
-- veritabanına uygulanmıştır (aynı boşluk `wheel_duel_quick_match`in gövdesi
-- için 20260814150000'de de not düşülmüştür).
--
-- NEDEN ŞİMDİ: bu migration `room_source` üzerinde DAL AÇIYOR. Kolonun repo
-- geçmişinde hiç görünmemesi, migration'ların temiz bir veritabanına baştan
-- uygulanmasını (clean-room / yeni ortam) imkânsız kılar.
--
-- NEDEN GÜVENLİ: üçü de `add column if not exists`. Kolon zaten varsa ifade
-- HİÇBİR ŞEY YAPMAZ — mevcut tipi, NULL'luğu, varsayılanı ve verisi
-- DEĞİŞMEZ. Yani canlıda tam anlamıyla NO-OP'tur; yalnız boş bir veritabanında
-- gerçekten kolon yaratır. Hiçbir kolon düşürülmez/yeniden yazılmaz ve CHECK
-- constraint EKLENMEZ (mevcut satırların doğrulanmasını gerektirecek hiçbir
-- kısıt getirilmez).
-- ────────────────────────────────────────────────────────────────────────────
alter table public.wheel_duel_rooms
  add column if not exists room_source text not null default 'manual';

alter table public.wheel_duel_rooms
  add column if not exists match_seq int not null default 1;

alter table public.wheel_duel_rooms
  add column if not exists current_match_id uuid not null default gen_random_uuid();


-- ────────────────────────────────────────────────────────────────────────────
-- 1) wheel_duel_process_rematch — host-only rövanş reset'i
-- ----------------------------------------------------------------------------
-- Gövde 20260529120000_wheel_duel_rls_hardening_m2.sql'den alınmıştır.
-- İKİ DEĞİŞİKLİK:
--   (a) `wheel_duel_room_sequences` satırı SİLİNİR → yeni maç YENİ hedef
--       sırası alır. (Eskiden sıra kalıyor, `used_target_topoids` ise
--       sıfırlanıyordu; yani rövanş AYNI hedefleri AYNI sırayla tekrarlardı —
--       "taze maç" sözleşmesinin ihlali. `wheel_duel_ensure_sequence` satır
--       yoksa yenisini üretir, `..._if_ready` ikizi bunu zaten yapıyordu.)
--   (b) HIZLI EŞLEŞ dalı: status='playing' + started_at=now()+3sn.
--       MANUEL dal eskisiyle birebir: status='waiting', started_at=null.
--
-- Yetki: `wheel_duel_authorize_host` — DEĞİŞMEDİ.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.wheel_duel_process_rematch(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.wheel_duel_rooms;
  v_is_qm    boolean;
  v_status   text;
  v_start_at timestamptz;
begin
  if not public.wheel_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status <> 'finished' then
    raise exception 'room_not_finished' using errcode = 'P0001';
  end if;
  if coalesce(array_length(v_room.rematch_requested_by, 1), 0) < 2 then
    raise exception 'not_enough_votes' using errcode = 'P0001';
  end if;

  -- HIZLI EŞLEŞ Mİ? Tek otorite sunucudaki kolon; istemci parametresi YOK.
  v_is_qm    := (v_room.room_source = 'quick_match');
  v_status   := case when v_is_qm then 'playing' else 'waiting' end;
  v_start_at := case when v_is_qm then now() + interval '3 seconds' else null end;

  -- 1) Skorları sıfırla
  update public.wheel_duel_players
     set score = 0
   where room_id = p_room_id;

  -- 2) Yeni maç → YENİ hedef sırası (sunucu bir sonraki advance_if_due'da üretir)
  delete from public.wheel_duel_room_sequences where room_id = p_room_id;

  -- 3) Room reset (atomik guard yine status='finished')
  update public.wheel_duel_rooms
     set status                = v_status,
         started_at            = v_start_at,
         finished_at           = null,
         finished_reason       = null,
         winner_player_id      = null,
         current_target_topoid = null,
         used_target_topoids   = '{}',
         pass_requested_by     = '{}',
         pass_target_topoid    = null,
         rematch_requested_by  = '{}',
         match_seq             = coalesce(match_seq, 1) + 1,
         current_match_id      = gen_random_uuid()
   where id = p_room_id
     and status = 'finished'
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.wheel_duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_process_rematch(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_process_rematch(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 2) wheel_duel_process_rematch_if_ready — host-SPOF'suz ikiz
-- ----------------------------------------------------------------------------
-- Gövde 20260814150000_wheel_server_generated_sequence.sql'den alınmıştır.
-- TEK DEĞİŞİKLİK: aynı HIZLI EŞLEŞ dalı (playing + now()+3sn). Üyelik/yetki
-- kontrolleri, "hazır değilse mevcut satırı döndür" davranışı ve sıra silme
-- AYNEN korunur. İki ikizin AYNI sonucu üretmesi şarttır: aksi hâlde rövanşın
-- hangi yoldan tetiklendiği oyuncuya farklı bir ürün gösterirdi.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.wheel_duel_process_rematch_if_ready(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid
) returns public.wheel_duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.wheel_duel_rooms;
  v_is_qm    boolean;
  v_status   text;
  v_start_at timestamptz;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  select * into v_room from public.wheel_duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;

  if v_room.status <> 'finished'
     or coalesce(array_length(v_room.rematch_requested_by, 1), 0) < 2 then
    return v_room;
  end if;

  v_is_qm    := (v_room.room_source = 'quick_match');
  v_status   := case when v_is_qm then 'playing' else 'waiting' end;
  v_start_at := case when v_is_qm then now() + interval '3 seconds' else null end;

  update public.wheel_duel_players set score = 0 where room_id = p_room_id;

  -- Yeni maç → yeni sıra (sunucu bir sonraki advance_if_due'da üretir).
  delete from public.wheel_duel_room_sequences where room_id = p_room_id;

  update public.wheel_duel_rooms
     set status                = v_status,
         started_at            = v_start_at,
         finished_at           = null,
         finished_reason       = null,
         winner_player_id      = null,
         current_target_topoid = null,
         used_target_topoids   = '{}',
         pass_requested_by     = '{}',
         pass_target_topoid    = null,
         rematch_requested_by  = '{}',
         -- XP IDEMPOTENCY: process_rematch ile BİREBİR aynı rotasyon.
         match_seq             = coalesce(match_seq, 1) + 1,
         current_match_id      = gen_random_uuid()
   where id = p_room_id
     and status = 'finished'
   returning * into v_room;
  if v_room.id is null then
    select * into v_room from public.wheel_duel_rooms where id = p_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.wheel_duel_process_rematch_if_ready(uuid, uuid, uuid) from public;
grant  execute on function public.wheel_duel_process_rematch_if_ready(uuid, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 3) flag_duel_accept_rematch — Bayrak rövanşı
-- ----------------------------------------------------------------------------
-- Gövde 20260613120000_flag_duel_patch_finished_at.sql'den alınmıştır.
-- TEK DEĞİŞİKLİK: HIZLI EŞLEŞ odasında `started_at` VE `current_flag_at`
-- now()+3 sn olur (manuel odada ikisi de now(), yani eskisi gibi).
--
-- `current_flag_at` de kaydırılmalıdır: tur süresi bu damgadan sayılır
-- (`flag_duel_advance_if_due` deadline'ı current_flag_at + round_seconds).
-- Yalnız `started_at` kaydırılsaydı ilk turun süresi geri sayım boyunca
-- akmaya başlar, oyuncular 3 saniyesini kaybederdi. Hızlı Eşleş odasını KURAN
-- RPC (`flag_duel_quick_match`) da tam olarak bu ikiliyi aynı değere yazar —
-- rövanş ilk maçla birebir aynı şekli alır.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.flag_duel_accept_rematch(
  p_room_id        uuid,
  p_host_player_id uuid,
  p_claim_token    uuid,
  p_first_flag     text
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room     public.duel_rooms;
  v_start_at timestamptz;
begin
  if not public.flag_duel_authorize_host(p_room_id, p_host_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_first_flag is null or length(btrim(p_first_flag)) = 0 then
    raise exception 'first_flag_required' using errcode = '22023';
  end if;

  select * into v_room from public.duel_rooms where id = p_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status not in ('finished', 'playing') then
    raise exception 'room_not_rematchable' using errcode = 'P0001';
  end if;

  v_start_at := case
                  when v_room.room_source = 'quick_match'
                    then now() + interval '3 seconds'
                  else now()
                end;

  delete from public.duel_claims where room_id = p_room_id;

  update public.duel_players
     set score        = 0,
         last_seen_at = now()
   where room_id = p_room_id;

  update public.duel_rooms
     set status                 = 'playing',
         started_at             = v_start_at,
         current_round          = 1,
         current_flag           = p_first_flag,
         current_flag_at        = v_start_at,
         is_golden_round        = false,
         finished_reason        = null,
         winner_player_id       = null,
         forfeited_player_id    = null,
         disconnected_player_id = null,
         disconnect_at          = null
   where id = p_room_id
   returning * into v_room;

  return v_room;
end;
$$;

revoke all     on function public.flag_duel_accept_rematch(uuid, uuid, uuid, text) from public;
grant  execute on function public.flag_duel_accept_rematch(uuid, uuid, uuid, text) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) duel_accept_rematch — Ülke Yaz rövanş odası
-- ----------------------------------------------------------------------------
-- Gövde 20260801120000_room_code_resolver.sql'den alınmıştır.
-- TEK DEĞİŞİKLİK: yeni odanın `room_source`u ESKİ ODADAN DEVRALINIR
-- (eskiden sabit 'manual' yazılıyordu).
--
-- NEDEN: Ülke Yaz rövanşı — Bayrak/Çark'ın aksine — YENİ bir oda satırı açar
-- (XP idempotency anahtarı oda id'sidir; `duel_rooms`ta `current_match_id`
-- YOKTUR, aynı satırda ikinci maç XP yazamazdı). Yeni oda 'manual' doğduğu
-- sürece Hızlı Eşleş rövanşı ürün olarak MANUEL bir odaya dönüşüyordu: karşı
-- taraf oda kodu ekranını görüyor, geri sayım hiç kurulmuyordu.
--
-- Kaynağı devretmek "bu maç hızlı eşleşmeden geldi" gerçeğini korur; ayarlar
-- (duration_seconds, region) zaten eski odadan kopyalanıyordu.
-- `room_source` CHECK'i ('manual','quick_match') iki değeri de kabul eder.
-- room_kind yine 'country' (bu RPC yalnız Ülke Yaz rövanşında kullanılır).
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.duel_accept_rematch(
  p_old_room_id        uuid,
  p_old_player_id      uuid,
  p_old_claim_token    uuid,
  p_new_room_code      text,
  p_new_player_id      uuid,
  p_new_claim_token    uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_old_room   public.duel_rooms;
  v_new_room   public.duel_rooms;
  v_old_player public.duel_players;
begin
  if not public.duel_authorize_player(p_old_player_id, p_old_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_new_room_code is null or length(btrim(p_new_room_code)) = 0 then
    raise exception 'new_code_required' using errcode = '22023';
  end if;
  if p_new_player_id is null or p_new_claim_token is null then
    raise exception 'new_identity_required' using errcode = '22023';
  end if;

  -- Eski oda & player'ı çek (config kopyala)
  select * into v_old_room from public.duel_rooms where id = p_old_room_id;
  if v_old_room.id is null then
    raise exception 'old_room_not_found' using errcode = '02000';
  end if;
  if v_old_room.status <> 'finished' then
    raise exception 'old_room_not_finished' using errcode = 'P0001';
  end if;

  select * into v_old_player
    from public.duel_players
   where id = p_old_player_id and room_id = p_old_room_id;
  if v_old_player.id is null then
    raise exception 'old_player_not_found' using errcode = '02000';
  end if;

  -- 1) Yeni oda (room_kind sunucu-otoriter: Ülke Yaz rövanş odası)
  begin
    insert into public.duel_rooms (
      code, status, duration_seconds, region, room_source, host_player_id,
      room_kind
    ) values (
      p_new_room_code,
      'waiting_rematch',
      v_old_room.duration_seconds,
      v_old_room.region,
      case when v_old_room.room_source = 'quick_match' then 'quick_match' else 'manual' end,
      p_new_player_id,
      'country'
    )
    returning * into v_new_room;
  exception
    when unique_violation then
      raise exception 'code_taken' using errcode = 'P0001';
  end;

  -- 2) Yeni player (eski isim + profile_id / guest_id korunur)
  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_new_player_id,
    v_new_room.id,
    v_old_player.name,
    0,
    v_old_player.profile_id,
    v_old_player.guest_id,
    now()
  );

  -- 3) Yeni claim
  insert into public.duel_player_claims (player_id, claim_token)
  values (p_new_player_id, p_new_claim_token);

  -- 4) Eski odanın pointer'ını yaz (requester realtime ile yakalar)
  update public.duel_rooms
     set rematch_room_id = v_new_room.id
   where id = p_old_room_id;

  return v_new_room;
end;
$$;

revoke all     on function public.duel_accept_rematch(uuid, uuid, uuid, text, uuid, uuid) from public;
grant  execute on function public.duel_accept_rematch(uuid, uuid, uuid, text, uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 5) duel_join_rematch_room — rövanş odasına katılış + atomik başlatma
-- ----------------------------------------------------------------------------
-- Gövde 20260708120000_duel_display_name_guard.sql'den alınmıştır.
-- TEK DEĞİŞİKLİK: oda `room_source='quick_match'` ise `started_at` now()+3 sn
-- (manuel odada now(), yani eskisi gibi).
--
-- Böylece Hızlı Eşleş rövanşı, ilk Hızlı Eşleş maçının kurulumuyla BİREBİR
-- aynı şekli alır: status='playing' + gelecekte bir started_at → iki istemci
-- de aynı mutlak ana göre 3-2-1 sayar, hiçbiri erken başlayamaz.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.duel_join_rematch_room(
  p_new_room_id uuid,
  p_player_id   uuid,
  p_profile_id  uuid,
  p_guest_id    text,
  p_name        text,
  p_claim_token uuid
) returns public.duel_rooms
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room         public.duel_rooms;
  v_uid          uuid := auth.uid();
  v_count        int;
  v_display_name text;
  v_start_at     timestamptz;
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

  -- ── Display name: helper ile validate + registry guard. ──
  v_display_name := public.assert_display_name_allowed(
    p_name, p_profile_id, p_guest_id
  );

  select * into v_room from public.duel_rooms where id = p_new_room_id for update;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room.status = 'finished' then
    raise exception 'room_finished' using errcode = 'P0001';
  end if;
  if v_room.status not in ('waiting_rematch', 'waiting') then
    raise exception 'room_not_waiting_rematch' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from public.duel_players where room_id = p_new_room_id;
  if v_count >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  v_start_at := case
                  when v_room.room_source = 'quick_match'
                    then now() + interval '3 seconds'
                  else now()
                end;

  insert into public.duel_players (
    id, room_id, name, score, profile_id, guest_id, last_seen_at
  ) values (
    p_player_id, v_room.id, v_display_name, 0, p_profile_id, p_guest_id, now()
  );

  insert into public.duel_player_claims (player_id, claim_token)
  values (p_player_id, p_claim_token);

  update public.duel_players
     set last_seen_at = now()
   where room_id = p_new_room_id;

  update public.duel_rooms
     set status                 = 'playing',
         started_at             = v_start_at,
         finished_reason        = null,
         winner_player_id       = null,
         forfeited_player_id    = null,
         disconnected_player_id = null,
         disconnect_at          = null
   where id = p_new_room_id
     and status in ('waiting_rematch', 'waiting')
   returning * into v_room;

  if v_room.id is null then
    select * into v_room from public.duel_rooms where id = p_new_room_id;
  end if;

  return v_room;
end;
$$;

revoke all     on function public.duel_join_rematch_room(uuid, uuid, uuid, text, text, uuid) from public;
grant  execute on function public.duel_join_rematch_room(uuid, uuid, uuid, text, text, uuid) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 6) BAŞLANGIÇ OTORİTESİ — geri sayım bitmeden gameplay yazımı KABUL EDİLMEZ
-- ════════════════════════════════════════════════════════════════════════════
-- Bugüne kadar 3 saniyelik Hızlı Eşleş tamponu YALNIZCA istemcide korunuyordu
-- (DuelGame.tsx'te bu açıkça not düşülmüş: "Server-side claim RPC'si
-- started_at kontrolü yapmadığından, client guard koymazsak iki oyuncudan biri
-- buffer'da yazıp puan kaydedebilir"). Rövanşta da AYNI tamponu kullandığımız
-- için bu boşluğu KAPATIYORUZ: adil başlangıcın otoritesi sunucudur.
--
-- Biçim: hata FIRLATILMAZ, sessiz `claimed=false` döner. Nedeni, mevcut
-- "yarışı kaybettin / bayat hedef" dönüşüyle aynı sözleşmeyi korumaktır —
-- istemcide yeni bir hata bandı belirmez ve eski istemciler de kırılmaz.
-- Manuel odalarda started_at zaten now() olduğu için bu koşul HİÇ tetiklenmez.
-- ────────────────────────────────────────────────────────────────────────────

-- 6a) Çark — wheel_duel_claim_target
--     Gövde 20260529120000'den; TEK DEĞİŞİKLİK atomik UPDATE guard'ına
--     `now() >= started_at` koşulu. Guard tutmazsa fonksiyon zaten
--     {claimed:false} döndürüyor → yeni dal, yeni dönüş tipi yok.
create or replace function public.wheel_duel_claim_target(
  p_room_id     uuid,
  p_player_id   uuid,
  p_claim_token uuid,
  p_target      text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_claimed_id uuid;
  v_new_score  int;
begin
  if not public.wheel_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_target is null or length(btrim(p_target)) = 0 then
    raise exception 'target_required' using errcode = '22023';
  end if;

  -- Oyuncu gerçekten bu odada mı? (cross-room sömürüyü kapatır)
  if not exists (
    select 1 from public.wheel_duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Atomik claim: yalnız beklenen hedef hâlâ aktifse VE maç gerçekten
  -- başladıysa yaz.
  update public.wheel_duel_rooms
     set current_target_topoid = null,
         used_target_topoids   = array_append(coalesce(used_target_topoids, '{}'), p_target),
         pass_requested_by     = '{}',
         pass_target_topoid    = null
   where id = p_room_id
     and status = 'playing'
     and (started_at is null or now() >= started_at)
     and current_target_topoid = p_target
   returning id into v_claimed_id;

  if v_claimed_id is null then
    -- Yarışı kaybettin, bayat hedef, status değişmiş veya geri sayım hâlâ
    -- sürüyor → sessiz no-op
    return jsonb_build_object('claimed', false, 'new_score', null);
  end if;

  -- Aynı transaction: skor +1
  update public.wheel_duel_players
     set score = score + 1
   where id = p_player_id
   returning score into v_new_score;

  return jsonb_build_object('claimed', true, 'new_score', v_new_score);
end;
$$;

revoke all     on function public.wheel_duel_claim_target(uuid, uuid, uuid, text) from public;
grant  execute on function public.wheel_duel_claim_target(uuid, uuid, uuid, text) to anon, authenticated;


-- 6b) Ülke Yaz — duel_submit_claim
--     Gövde 20260604120000'den; TEK DEĞİŞİKLİK started_at guard'ı
--     ({claimed:false, reason:'not_started'}). Mevcut istemci bilinmeyen
--     reason'ı zaten "yanlış" geri bildirimi olarak ele alıyor.
create or replace function public.duel_submit_claim(
  p_room_id      uuid,
  p_player_id    uuid,
  p_claim_token  uuid,
  p_country_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room_status text;
  v_started_at  timestamptz;
begin
  if not public.duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_country_code is null or length(btrim(p_country_code)) = 0 then
    raise exception 'country_code_required' using errcode = '22023';
  end if;

  -- Oyuncu bu odada mı?
  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  -- Oda hâlâ playing'de mi? (yarış: aynı anda finish_game/forfeit/disconnect
  -- atılırsa claim no-op kalsın; UNIQUE violation'a düşmeden net hata dön)
  select status, started_at into v_room_status, v_started_at
    from public.duel_rooms
   where id = p_room_id;

  if v_room_status is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room_status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Hızlı Eşleş 3 sn tamponu: maç henüz BAŞLAMADIYSA yazma.
  if v_started_at is not null and now() < v_started_at then
    return jsonb_build_object('claimed', false, 'reason', 'not_started');
  end if;

  -- Atomik claim insert
  begin
    insert into public.duel_claims (room_id, player_id, country_code)
    values (p_room_id, p_player_id, p_country_code);
  exception
    when unique_violation then
      -- Frontend dup feedback'i için sessiz dönüş (raise yerine flag)
      return jsonb_build_object('claimed', false, 'reason', 'dup');
  end;

  return jsonb_build_object('claimed', true);
end;
$$;

revoke all     on function public.duel_submit_claim(uuid, uuid, uuid, text) from public;
grant  execute on function public.duel_submit_claim(uuid, uuid, uuid, text) to anon, authenticated;


-- 6c) Bayrak — flag_duel_submit_claim
--     Gövde 20260612120000'den; TEK DEĞİŞİKLİK aynı started_at guard'ı.
create or replace function public.flag_duel_submit_claim(
  p_room_id      uuid,
  p_player_id    uuid,
  p_claim_token  uuid,
  p_country_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room_status text;
  v_started_at  timestamptz;
begin
  if not public.flag_duel_authorize_player(p_player_id, p_claim_token) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_country_code is null or length(btrim(p_country_code)) = 0 then
    raise exception 'country_code_required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.duel_players
     where id = p_player_id and room_id = p_room_id
  ) then
    raise exception 'player_room_mismatch' using errcode = '42501';
  end if;

  select status, started_at into v_room_status, v_started_at
    from public.duel_rooms
   where id = p_room_id;

  if v_room_status is null then
    raise exception 'room_not_found' using errcode = '02000';
  end if;
  if v_room_status <> 'playing' then
    raise exception 'room_not_playing' using errcode = 'P0001';
  end if;

  -- Hızlı Eşleş 3 sn tamponu: maç henüz BAŞLAMADIYSA yazma.
  if v_started_at is not null and now() < v_started_at then
    return jsonb_build_object('claimed', false, 'reason', 'not_started');
  end if;

  begin
    insert into public.duel_claims (room_id, player_id, country_code)
    values (p_room_id, p_player_id, p_country_code);
  exception
    when unique_violation then
      return jsonb_build_object('claimed', false, 'reason', 'dup');
  end;

  return jsonb_build_object('claimed', true);
end;
$$;

revoke all     on function public.flag_duel_submit_claim(uuid, uuid, uuid, text) from public;
grant  execute on function public.flag_duel_submit_claim(uuid, uuid, uuid, text) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 7) DOĞRULAMA — migration kendi iddialarını uygular
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_fail text := '';
  v_src  text;
  v_col  text;
begin
  -- 7z) Dal açtığımız kolonlar gerçekten var mı (bölüm 0'ın sonucu).
  foreach v_col in array array['room_source', 'match_seq', 'current_match_id'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'wheel_duel_rooms'
         and column_name = v_col
    ) then
      v_fail := v_fail || ' [wheel_duel_rooms.' || v_col || ' kolonu yok]';
    end if;
  end loop;

  -- 7a) Sekiz fonksiyon da mevcut, SECURITY DEFINER ve search_path pinli.
  for v_src in
    select unnest(array[
      'public.wheel_duel_process_rematch(uuid,uuid,uuid)',
      'public.wheel_duel_process_rematch_if_ready(uuid,uuid,uuid)',
      'public.flag_duel_accept_rematch(uuid,uuid,uuid,text)',
      'public.duel_accept_rematch(uuid,uuid,uuid,text,uuid,uuid)',
      'public.duel_join_rematch_room(uuid,uuid,uuid,text,text,uuid)',
      'public.wheel_duel_claim_target(uuid,uuid,uuid,text)',
      'public.duel_submit_claim(uuid,uuid,uuid,text)',
      'public.flag_duel_submit_claim(uuid,uuid,uuid,text)'
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
    -- İstemci yolu korunmalı: anon + authenticated EXECUTE.
    if not has_function_privilege('anon', v_src, 'EXECUTE')
       or not has_function_privilege('authenticated', v_src, 'EXECUTE') then
      v_fail := v_fail || ' [' || v_src || ' istemci EXECUTE kaybı]';
    end if;
  end loop;

  -- 7b) Hızlı Eşleş dalı gerçekten +3 sn yazıyor mu (gövde iddiası).
  select prosrc into v_src from pg_proc
   where oid = 'public.wheel_duel_process_rematch(uuid,uuid,uuid)'::regprocedure;
  if v_src not like '%quick_match%' or v_src not like '%3 seconds%' then
    v_fail := v_fail || ' [wheel_duel_process_rematch: QM +3sn dalı yok]';
  end if;
  if v_src not like '%wheel_duel_room_sequences%' then
    v_fail := v_fail || ' [wheel_duel_process_rematch: sıra sıfırlama yok]';
  end if;

  select prosrc into v_src from pg_proc
   where oid = 'public.wheel_duel_process_rematch_if_ready(uuid,uuid,uuid)'::regprocedure;
  if v_src not like '%quick_match%' or v_src not like '%3 seconds%' then
    v_fail := v_fail || ' [wheel_duel_process_rematch_if_ready: QM +3sn dalı yok]';
  end if;

  select prosrc into v_src from pg_proc
   where oid = 'public.flag_duel_accept_rematch(uuid,uuid,uuid,text)'::regprocedure;
  if v_src not like '%quick_match%' or v_src not like '%3 seconds%' then
    v_fail := v_fail || ' [flag_duel_accept_rematch: QM +3sn dalı yok]';
  end if;

  select prosrc into v_src from pg_proc
   where oid = 'public.duel_accept_rematch(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure;
  if v_src not like '%v_old_room.room_source%' then
    v_fail := v_fail || ' [duel_accept_rematch: room_source devri yok]';
  end if;

  select prosrc into v_src from pg_proc
   where oid = 'public.duel_join_rematch_room(uuid,uuid,uuid,text,text,uuid)'::regprocedure;
  if v_src not like '%quick_match%' or v_src not like '%3 seconds%' then
    v_fail := v_fail || ' [duel_join_rematch_room: QM +3sn dalı yok]';
  end if;

  -- 7c) Başlangıç otoritesi claim yolunda gerçekten var mı.
  select prosrc into v_src from pg_proc
   where oid = 'public.wheel_duel_claim_target(uuid,uuid,uuid,text)'::regprocedure;
  if v_src not like '%now() >= started_at%' then
    v_fail := v_fail || ' [wheel_duel_claim_target: started_at guard yok]';
  end if;
  select prosrc into v_src from pg_proc
   where oid = 'public.duel_submit_claim(uuid,uuid,uuid,text)'::regprocedure;
  if v_src not like '%not_started%' then
    v_fail := v_fail || ' [duel_submit_claim: started_at guard yok]';
  end if;
  select prosrc into v_src from pg_proc
   where oid = 'public.flag_duel_submit_claim(uuid,uuid,uuid,text)'::regprocedure;
  if v_src not like '%not_started%' then
    v_fail := v_fail || ' [flag_duel_submit_claim: started_at guard yok]';
  end if;

  -- 7d) Build 10 kimlik/güvenlik yüzeyi bu migration'da DEĞİŞMEMİŞ olmalı:
  --     Çark Hızlı Eşleş sarmalayıcısı hâlâ çekirdeği çağırıyor mu?
  if exists (select 1 from pg_proc
              where proname = '_wheel_duel_quick_match_core'
                and pronamespace = 'public'::regnamespace) then
    select prosrc into v_src from pg_proc
     where proname = 'wheel_duel_quick_match' and pronamespace = 'public'::regnamespace
     limit 1;
    if v_src is null or v_src not like '%_wheel_duel_quick_match_core%' then
      v_fail := v_fail || ' [wheel_duel_quick_match sarmalayıcısı kaybolmuş]';
    end if;
  end if;

  if v_fail <> '' then
    raise exception 'quick_match_direct_rematch doğrulaması BAŞARISIZ:%', v_fail;
  end if;
  raise notice 'quick_match_direct_rematch: tüm doğrulamalar geçti.';
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- CANLI SONRASI KONTROL (elle)
-- ────────────────────────────
--   -- Hızlı Eşleş rövanşı lobiye düşmemeli:
--   select id, room_source, status, started_at, started_at - now() as buffer
--     from wheel_duel_rooms where room_source = 'quick_match'
--    order by updated_at desc limit 5;
--   -- 'playing' + buffer ≈ +3 sn bekleriz (rövanştan hemen sonra).
--
--   -- Manuel oda davranışı DEĞİŞMEMELİ:
--   select status, started_at from wheel_duel_rooms
--    where room_source = 'manual' and status = 'waiting' limit 5;   -- started_at null
-- ════════════════════════════════════════════════════════════════════════════
